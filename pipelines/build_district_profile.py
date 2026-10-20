"""data/processed/*.csv -> data/processed/district_profile.json

Per 상권 × quarter: 한식 sales, stores, per-store monthly sales, day-of-week / time-band / age / sex
shares, evening share, 유동인구, 직장인구, 상주인구, 집객시설. Per 상권 × year: rollups. Plus
Kaplan-Meier survival tables from the 인허가 file.
"""
from __future__ import annotations

import argparse
import math

import numpy as np
import pandas as pd

from .common import PROCESSED, load_config, load_polygons, today, write_json

DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
BANDS = ["t00_06", "t06_11", "t11_14", "t14_17", "t17_21", "t21_24"]
AGES = ["age10", "age20", "age30", "age40", "age50", "age60plus"]


def _num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return int(v) if float(v).is_integer() else round(float(v), 4)


def _shares(row: pd.Series, prefix: str, keys: list[str]) -> dict | None:
    vals = {k: float(row.get(f"{prefix}_{k}", np.nan)) for k in keys}
    tot = sum(v for v in vals.values() if not math.isnan(v))
    return {k: round(v / tot, 4) for k, v in vals.items()} if tot > 0 else None


def _read(out_dir, name):
    p = out_dir / f"{name}.csv"
    return pd.read_csv(p, dtype={"quarter": str, "trdar_code": str}) if p.exists() else pd.DataFrame()


def sales_block(r: pd.Series | None, st: pd.Series | None) -> dict:
    d = {}
    if r is not None:
        amt, cnt = r["sales_amt_total"], r["sales_cnt_total"]
        bands = _shares(r, "sales_amt", BANDS)
        d.update({
            "hansik_sales_krw": _num(amt),
            "hansik_sales_count": _num(cnt),
            "avg_ticket_krw": _num(round(amt / cnt)) if cnt else None,
            "weekend_share": round(r["sales_amt_weekend"] / amt, 4) if amt else None,
            "dow_share": _shares(r, "sales_amt", DOW),
            "timeband_share": bands,
            "evening_share_17_24": round(bands["t17_21"] + bands["t21_24"], 4) if bands else None,
            "lunch_share_11_14": bands["t11_14"] if bands else None,
            "age_share": _shares(r, "sales_amt", AGES),
            "sex_share": _shares(r, "sales_amt", ["male", "female"]),
            # age/sex splits exclude corporate cards; this is how much of the total they cover
            "age_split_coverage": round(sum(r[f"sales_amt_{a}"] for a in AGES) / amt, 4) if amt else None,
        })
    if st is not None:
        d.update({
            "stores_total": _num(st["stores_total"]),
            "stores_independent": _num(st["stores_non_franchise"]),
            "stores_franchise": _num(st["stores_franchise"]),
            "stores_opened": _num(st["stores_opened"]),
            "stores_closed": _num(st["stores_closed"]),
        })
    if r is not None and st is not None and st["stores_total"]:
        d["sales_per_store_month_krw"] = _num(round(r["sales_amt_total"] / st["stores_total"] / 3))
    return d


def km_table(df: pd.DataFrame, times: list[int]) -> dict:
    """Kaplan-Meier on months_open / event (lifelines if present, else by hand)."""
    df = df.dropna(subset=["months_open"])
    n, events = len(df), int(df["event"].sum())
    if n == 0:
        return {"n": 0}
    try:
        from lifelines import KaplanMeierFitter
        kmf = KaplanMeierFitter().fit(df["months_open"], df["event"])
        sf, ci = kmf.survival_function_, kmf.confidence_interval_survival_function_
        def at(t):
            i = sf.index.searchsorted(t, side="right") - 1
            return (float(sf.iloc[i, 0]), float(ci.iloc[i, 0]), float(ci.iloc[i, 1])) if i >= 0 else (1.0, 1.0, 1.0)
        median = kmf.median_survival_time_
        engine = "lifelines"
    except ImportError:  # pragma: no cover - hand-rolled product-limit estimator
        s, curve = 1.0, []
        for t in sorted(df.loc[df["event"] == 1, "months_open"].unique()):
            at_risk = (df["months_open"] >= t).sum()
            s *= 1 - ((df["months_open"] == t) & (df["event"] == 1)).sum() / at_risk
            curve.append((t, s))
        def at(t):
            v = [s for tt, s in curve if tt <= t]
            return (v[-1] if v else 1.0, None, None)
        median = next((t for t, s in curve if s <= 0.5), float("inf"))
        engine = "hand"
    table = []
    for t in times:
        s, lo, hi = at(t)
        table.append({"month": t, "survival": round(s, 4),
                      "ci_low": None if lo is None else round(lo, 4), "ci_high": None if hi is None else round(hi, 4),
                      "at_risk": int((df["months_open"] >= t).sum())})
    return {"n": n, "events": events, "censored": n - events, "engine": engine,
            "median_months": None if not np.isfinite(median) else round(float(median), 1), "table": table}


def survival(cfg: dict, lic: pd.DataFrame, match: pd.DataFrame) -> dict:
    s = cfg["survival"]
    h = s["horizon_months"]
    lic = lic.copy()
    lic["open_date"] = pd.to_datetime(lic["open_date"])
    every = lic[lic["open_date"] >= s["cohort_start"]]
    coh = every[every["hansik"] == 1]
    primary = cfg["trdar"]["primary"]
    matched_primary = set()
    if len(match):
        ok = match["match_confidence"].isin(["high", "medium"]) & match["class_code"].isin(cfg["sbiz"]["primary_codes"])
        matched_primary = set(match.loc[ok, "license_id"])
    pork = every[(every["pork_name_hint"] == 1) | every["license_id"].isin(matched_primary)]

    def block(df):
        d = km_table(df, s["km_times_months"])
        col = f"closed_within_{h}m"
        known = df[col].dropna()
        d[f"share_closed_within_{h}m"] = round(float(known.mean()), 4) if len(known) else None
        d[f"n_with_{h}m_outcome"] = int(len(known))
        d["median_area_pyeong"] = _num(df["area_pyeong"].median())
        return d

    return {
        "cohort": f"licenses approved on/after {s['cohort_start']}, right-censored at run date. 한식 = 업태 "
                  f"{cfg['license']['hansik_uptae']}; recent licenses often use 업태 '기타' (cafes, 마라탕, some 한식), "
                  f"so the 한식 cohort undercounts. all_uptae is the broad restaurant baseline.",
        "all_uptae_primary": block(every[every["trdar_code"].isin(primary)]),
        "hansik_primary": block(coh[coh["trdar_code"].isin(primary)]),
        "hansik_primary_plus_fringe": block(coh),
        "pork_like_primary_plus_fringe": {
            "definition": "Licenses of any 업태 whose name contains a pork/grill keyword (config license.name_keywords) "
                          "or that matched an sbiz I20107 store (high/medium). Heuristic; keywords also catch "
                          "소고기 places. Current I20107 matches are survivors, so this group leans optimistic.",
            **block(pork),
        },
    }


def run(cfg: dict, out_dir=PROCESSED, trdars=None) -> dict:
    trdars = trdars or cfg["trdar"]["all"]
    polys = load_polygons(trdars)
    sales, stores = _read(out_dir, "seoul_sales"), _read(out_dir, "seoul_stores")
    flpop, workers = _read(out_dir, "seoul_flpop"), _read(out_dir, "seoul_workers")
    residents, fac = _read(out_dir, "seoul_residents"), _read(out_dir, "seoul_facilities")
    sb = pd.read_csv(out_dir / "stores_sbiz.csv", dtype=str, keep_default_na=False)
    lic = pd.read_csv(out_dir / "licenses.csv", dtype={"trdar_code": str, "license_id": str})
    match = _read(out_dir, "store_license_match")
    svc = cfg["seoul"]["service_codes"][0]

    def one(df, t, q):
        if df.empty:
            return None
        m = (df["trdar_code"] == t) & (df["quarter"] == q)
        if "service_code" in df.columns:
            m &= df["service_code"] == svc
        return df[m].iloc[0] if m.any() else None

    out = {}
    qs = sorted(set(sales.get("quarter", pd.Series(dtype=str))) | set(stores.get("quarter", pd.Series(dtype=str))))
    for t in trdars:
        if t not in polys:
            continue
        p = polys[t]
        qd = {}
        for q in qs:
            d = sales_block(one(sales, t, q), one(stores, t, q))
            f, w, r, fc = one(flpop, t, q), one(workers, t, q), one(residents, t, q), one(fac, t, q)
            if f is not None:
                d["flpop_total"] = _num(f["flpop_total"])
                d["flpop_age_share"] = _shares(f, "flpop", AGES)
                d["flpop_timeband_share"] = _shares(f, "flpop", BANDS)
            if w is not None:
                d["workers_total"] = _num(w["workers_total"])
            if r is not None:
                d["residents_total"] = _num(r["residents_total"])
                d["households_total"] = _num(r["households_total"])
            if fc is not None:
                d["facilities"] = {c: _num(fc[c]) for c in fac.columns
                                   if c not in ("quarter", "trdar_type_code", "trdar_type_name", "trdar_code",
                                                "trdar_name") and fc[c] and fc[c] > 0}
            if d:
                qd[q] = d
        annual = {}
        ts = sales[(sales["trdar_code"] == t) & (sales["service_code"] == svc)] if len(sales) else sales
        for y, g in ts.groupby(ts["quarter"].str[:4]) if len(ts) else []:
            st4 = one(stores, t, f"{y}4")
            annual[y] = {"quarters": len(g), "hansik_sales_krw": _num(g["sales_amt_total"].sum()),
                         "stores_q4_total": _num(st4["stores_total"]) if st4 is not None else None,
                         "stores_q4_independent": _num(st4["stores_non_franchise"]) if st4 is not None else None,
                         "stores_q4_franchise": _num(st4["stores_franchise"]) if st4 is not None else None}
            if len(g) == 4 and st4 is not None and st4["stores_total"]:
                annual[y]["sales_per_store_month_krw_q4_stores"] = _num(round(g["sales_amt_total"].sum() / st4["stores_total"] / 12))
        st = sb[sb["trdar_code"] == t]
        lt = lic[lic["trdar_code"] == t]
        mt = match[match["trdar_code"] == t] if len(match) else match
        out[t] = {
            "trdar_name": p["trdar_name"], "trdar_type": p["trdar_type_name"],
            "role": "primary" if t in cfg["trdar"]["primary"] else "fringe",
            "adstrd_name": p["adstrd_name"], "signgu_name": p["signgu_name"], "area_m2": p["area_m2"],
            "sbiz_stores": {
                "snapshot": st["snapshot"].iloc[0] if len(st) else None,
                **{c: {"stores": int((st["class_code"] == c).sum()),
                       "franchise_flag": int(((st["class_code"] == c) & (st["franchise_flag"] == "1")).sum())}
                   for c in cfg["sbiz"]["primary_codes"] + cfg["sbiz"]["comparison_codes"]},
                f"{cfg['sbiz']['context_prefix']}_all": int(len(st)),
            },
            "licenses": {
                "all_uptae": int(len(lt)), "hansik": int(lt["hansik"].sum()),
                "hansik_open": int(((lt["hansik"] == 1) & (lt["event"] == 0)).sum()),
                "hansik_closed": int(((lt["hansik"] == 1) & (lt["event"] == 1)).sum()),
            },
            "store_license_match": mt["match_confidence"].value_counts().to_dict() if len(mt) else {},
            "annual": annual,
            "quarters": qd,
        }

    profile = {
        "meta": {
            "industry": cfg["industry"], "label_ko": cfg["label_ko"], "run_date": str(today()),
            "seoul_service_code": svc, "sbiz_primary_codes": cfg["sbiz"]["primary_codes"],
            "units": {
                "hansik_sales_krw": "KRW per quarter (source column says 당월 but it is the quarter total)",
                "sales_per_store_month_krw": "quarter sales / stores_total / 3",
                "shares": "fractions of their own column group; age/sex exclude corporate cards",
                "flpop_total": "as served (sum of the 7 weekday columns); compare within dataset only",
            },
            "caveat": "추정매출 has no category finer than 한식 (CS100001); pork-level demand is an allocation.",
        },
        "trdar": out,
        "survival": survival(cfg, lic, match),
        "survival_scope": cfg.get("survival_scope", "narrow"),
    }
    wide = out_dir / "survival_wide.json"
    if cfg.get("survival_scope") == "wide" and wide.exists():
        import json
        profile["survival_wide"] = json.loads(wide.read_text(encoding="utf-8"))
    write_json(profile, out_dir / "district_profile.json")
    return profile


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    a = ap.parse_args()
    run(load_config(a.industry))
