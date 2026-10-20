"""Wide survival sample (config `survival_wide`): pork-grill vs all 한식 licenses beyond the study 상권.

  python -m pipelines.survival_wide

Areas are either a whole 구 (licenses filtered by 개방자치단체코드) or a 상권 polygon (point-in-polygon,
licenses from every 구 the polygon touches). Each per-구 LOCALDATA service is pulled with the same
repeat-and-union fix as fetch_license (its paging is unstable).

Outputs: data/processed/licenses_wide.csv, stores_wide_I20107.csv, store_license_match_wide.csv,
survival_wide.json (Kaplan-Meier tables + log-rank test, pork-like vs other 한식).
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from .common import PROCESSED, RAW, assign_trdar, load_config, load_polygons, log, today, transformer, write_csv, write_json
from .fetch_license import COLS, address_lookup, clean, fetch_converged, locate, match
from .fetch_sbiz import download, read_sido


def stores(cfg, areas, polys) -> pd.DataFrame:
    s = cfg["sbiz"]
    path, snap = download(s["dataset_id"])
    df = read_sido(path, s["sido_token"], s["context_prefix"])
    df = df[df["class_code"].isin(s["primary_codes"])].copy()
    x, y = transformer("EPSG:4326").transform(df["lon"].astype(float).values, df["lat"].astype(float).values)
    df["x_5181"], df["y_5181"] = x.round(2), y.round(2)
    in_trdar = pd.Series(assign_trdar(x, y, polys), index=df.index)
    parts = []
    for a in areas:
        m = (df["sigungu_name"] == a["sigungu_name"]) if a["kind"] == "sigungu" else (in_trdar == a["trdar_code"])
        parts.append(df[m].assign(area=a["label"]))
    out = pd.concat(parts).drop_duplicates("store_id")
    out["role"], out["trdar_code"] = "primary", out["area"]
    out["franchise_flag"] = (out["branch_name"].str.strip() != "").astype(int)
    out["snapshot"] = snap
    return out.reset_index(drop=True)


def licenses(cfg, areas, polys, refresh=False) -> tuple[pd.DataFrame, dict]:
    sbiz_zip, _ = download(cfg["sbiz"]["dataset_id"])
    lookup = address_lookup(sbiz_zip, cfg["sbiz"]["sido_token"])
    parts, diag = [], {}
    for a in areas:
        raw = pd.concat([fetch_converged(svc, refresh) for svc in a["license_services"]], ignore_index=True)
        raw = raw.drop_duplicates("MGTNO", keep="last")[list(COLS)].rename(columns=COLS)
        lic, d = locate(clean(raw, cfg, today()), lookup, polys)
        if a["kind"] == "sigungu":
            keep = lic["opnsfteam_code"] == a["opnsfteam_code"]
        else:
            keep = lic["trdar_code"] == a["trdar_code"]
        part = lic[keep].assign(area=a["label"])
        diag[a["label"]] = {"pulled": int(len(raw)), "in_area": int(len(part)), "coords": d["coords"]}
        parts.append(part)
    out = pd.concat(parts, ignore_index=True).drop_duplicates("license_id")
    return out, diag


def survival(cfg, lic: pd.DataFrame, m: pd.DataFrame) -> dict:
    from .build_district_profile import km_table
    s = cfg["survival"]
    h = s["horizon_months"]
    ok = m["match_confidence"].isin(["high", "medium"])
    matched = set(m.loc[ok, "license_id"].dropna())
    lic = lic.copy()
    lic["matched_I20107"] = lic["license_id"].isin(matched).astype(int)
    lic["pork_like"] = ((lic["pork_name_hint"] == 1) | (lic["matched_I20107"] == 1)).astype(int)
    coh = lic[lic["open_date"] >= pd.Timestamp(s["cohort_start"])]

    def block(df):
        d = km_table(df, s["km_times_months"])
        known = df[f"closed_within_{h}m"].dropna()
        d[f"share_closed_within_{h}m"] = round(float(known.mean()), 4) if len(known) else None
        d["median_area_pyeong"] = None if df["area_pyeong"].dropna().empty else round(float(df["area_pyeong"].median()), 1)
        return d

    pork = coh[coh["pork_like"] == 1]
    name_only = coh[coh["pork_name_hint"] == 1]       # no survivor bias: closed stores carry names too
    hansik = coh[coh["hansik"] == 1]
    other_hansik = hansik[hansik["pork_like"] == 0]
    hansik_not_named = hansik[hansik["pork_name_hint"] == 0]
    out = {
        "scope": "wide",
        "areas": sorted(coh["area"].unique().tolist()),
        "cohort": f"licenses approved on/after {s['cohort_start']}, right-censored at run date",
        "pork_like_definition": "license name contains a pork/grill keyword (config license.name_keywords) or the "
                                "license matched an sbiz I20107 store (high/medium). Name keywords also catch some "
                                "소고기 places; I20107 matches are current survivors.",
        "pork_name_only": block(name_only),
        "pork_name_only_note": "PRIMARY comparison: name keyword only. Unbiased by survival, noisier by name.",
        "pork_like": block(pork),
        "pork_like_note": "name keyword OR matched to a current I20107 store: survivor-biased upward, "
                          "because only open stores can be matched.",
        "hansik_all": block(hansik),
        "hansik_not_pork": block(other_hansik),
        "all_uptae": block(coh),
        "by_area": {a: {"pork_like": block(g[g["pork_like"] == 1]), "hansik_all": block(g[g["hansik"] == 1])}
                    for a, g in coh.groupby("area")},
    }
    try:
        from lifelines.statistics import logrank_test

        def lr(a, b):
            a, b = a.dropna(subset=["months_open"]), b.dropna(subset=["months_open"])
            r = logrank_test(a["months_open"], b["months_open"], a["event"], b["event"])
            return {"p_value": float(f"{r.p_value:.3g}"), "test_statistic": round(float(r.test_statistic), 3),
                    "n": [int(len(a)), int(len(b))]}
        out["logrank"] = {"pork_name_only_vs_other_hansik": lr(name_only, hansik_not_named),
                          "pork_like_vs_other_hansik": lr(pork, other_hansik)}
    except Exception as e:  # noqa: BLE001
        out["logrank"] = {"error": str(e)[:120]}
    return out, lic


def run(cfg: dict, out_dir=PROCESSED, refresh=False) -> dict:
    if cfg.get("survival_scope") != "wide":
        log("survival_scope is not 'wide'; skipping")
        return {}
    areas = cfg["survival_wide"]["areas"]
    polys = load_polygons([a["trdar_code"] for a in areas if a["kind"] == "trdar"])
    st = stores(cfg, areas, polys)
    lic, diag = licenses(cfg, areas, polys, refresh)
    log(f"  wide: {len(st)} I20107 stores, {len(lic):,} licenses; {diag}")
    m = match(st, lic, cfg)
    surv, lic = survival(cfg, lic, m)
    surv["inputs"] = {"stores_I20107": int(len(st)), "licenses": int(len(lic)), "per_area": diag,
                      "matched_high_medium": int(m["match_confidence"].isin(["high", "medium"]).sum())}
    for c in ("open_date", "close_date"):
        lic[c] = lic[c].dt.date
    cols = ["license_id", "name", "area", "trdar_code", "uptae", "hansik", "pork_name_hint", "matched_I20107",
            "pork_like", "status", "open_date", "close_date", "censor_date", "months_open", "event",
            f"closed_within_{cfg['survival']['horizon_months']}m", "area_m2", "area_pyeong", "road_addr",
            "x_5181", "y_5181", "coord_source"]
    write_csv(lic[cols].sort_values(["area", "open_date"]).reset_index(drop=True), out_dir / "licenses_wide.csv")
    write_csv(st[["store_id", "name", "branch_name", "class_code", "area", "franchise_flag", "road_addr", "lon",
                  "lat", "snapshot"]], out_dir / "stores_wide_I20107.csv")
    write_csv(m, out_dir / "store_license_match_wide.csv")
    write_json(surv, out_dir / "survival_wide.json")
    return surv


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    run(load_config(a.industry), refresh=a.refresh)
