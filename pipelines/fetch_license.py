"""서울시 일반음식점 인허가 (OA-16094) -> data/processed/licenses.csv + store_license_match.csv

The Seoul-wide service LOCALDATA_072404 has no 구 filter (only 인허가일자/영업상태/사업장명), so we use
the per-구 service (LOCALDATA_072404_JN = 종로구, ~20.5k rows) and page through all of it.

Coordinates: X/Y are EPSG:5174 and ~27% of rows have none. Missing points are backfilled from the
소상공인 store file by exact address (road, then 지번); coord_source says which one was used.
"""
from __future__ import annotations

import argparse
import re

import numpy as np
import pandas as pd

from .common import (EPSG5174_TOWGS84, PROCESSED, RAW, assign_trdar, load_config, load_polygons, log,
                     seoul_all, today, transformer, write_csv)

PYEONG_M2 = 3.3058
COLS = {
    "MGTNO": "license_id", "BPLCNM": "name", "APVPERMYMD": "open_date", "DCBYMD": "close_date",
    "TRDSTATEGBN": "status_code", "TRDSTATENM": "status", "DTLSTATENM": "status_detail",
    "UPTAENM": "uptae", "SNTUPTAENM": "sanitary_uptae", "SITEAREA": "area_m2", "FACILTOTSCP": "facility_total_scale",
    "MANEIPCNT": "male_staff", "WMEIPCNT": "female_staff", "MULTUSNUPSOYN": "multi_use_flag",
    "RDNWHLADDR": "road_addr", "SITEWHLADDR": "jibun_addr", "SITETEL": "phone", "OPNSFTEAMCODE": "opnsfteam_code",
    "UPDATEDT": "source_updated", "X": "x_5174", "Y": "y_5174",
}


# --- address keys (shared with the sbiz side) ---

def road_key(addr: str) -> str | None:
    """'서울특별시 종로구 대학로 133-6, 1층 (명륜4가)' -> '종로구대학로133-6'"""
    if not isinstance(addr, str) or not addr.strip():
        return None
    a = re.split(r"[,(]", addr)[0]
    m = re.match(r"\s*서울특별시\s+(\S+구)\s+(.+?\d+(?:-\d+)?)", a)
    return re.sub(r"\s+", "", f"{m.group(1)}{m.group(2)}") if m else None


def jibun_key(addr: str) -> str | None:
    """'서울특별시 종로구 명륜4가 12-3 1층' -> '종로구명륜4가12-3' (drops 산 prefixes' ambiguity by keeping it)"""
    if not isinstance(addr, str) or not addr.strip():
        return None
    m = re.match(r"\s*서울특별시\s+(\S+구)\s+(\S+(?:동|가|로))\s+(산\s*)?(\d+(?:-\d+)?)", addr)
    return re.sub(r"\s+", "", "".join(g or "" for g in m.groups())) if m else None


def norm_name(s: str) -> str:
    s = re.sub(r"\(.*?\)|\[.*?\]", "", s or "")
    s = re.sub(r"(주식회사|\(주\)|㈜)", "", s)
    return re.sub(r"[\s\-_.,&·'\"]", "", s).lower()


def name_score(base: str, full: str, lic: str) -> float:
    """0-100. Substring matching only on the store's own name (never name+branch, where a generic
    branch like '대학로점' or '전문점' would match unrelated licenses); short names need containment."""
    from rapidfuzz import fuzz
    if not base or not lic:
        return 0.0
    score = max(fuzz.ratio(base, lic), fuzz.ratio(full, lic))
    short, long_ = sorted((base, lic), key=len)
    if short in long_ and len(short) >= 2:
        score = max(score, 100.0)
    elif len(short) >= 4:
        score = max(score, fuzz.partial_ratio(base, lic))
    return float(score)


def address_lookup(sbiz_zip, sido_token: str) -> pd.DataFrame:
    """Address key -> median EPSG:5181 point of every 소상공인 store at that address (Seoul file)."""
    import zipfile
    cache = sbiz_zip.with_name(sbiz_zip.stem + "_addr_lookup.csv.gz")
    if cache.exists():
        return pd.read_csv(cache, dtype={"key": str})
    z = zipfile.ZipFile(sbiz_zip, metadata_encoding="cp949")
    name = next(n for n in z.namelist() if sido_token in n and n.endswith(".csv"))
    df = pd.read_csv(z.open(name), dtype=str, usecols=["지번주소", "도로명주소", "경도", "위도"],
                     encoding="utf-8-sig", keep_default_na=False)
    x, y = transformer("EPSG:4326").transform(df["경도"].astype(float).values, df["위도"].astype(float).values)
    df = df.assign(x=x, y=y)
    parts = []
    for col, fn in (("도로명주소", road_key), ("지번주소", jibun_key)):
        k = df[col].map(fn)
        parts.append(pd.DataFrame({"key": k, "x": df["x"], "y": df["y"]}).dropna(subset=["key"]))
    out = pd.concat(parts).groupby("key")[["x", "y"]].median().reset_index()
    out.to_csv(cache, index=False)
    return out


def fetch_converged(svc: str, refresh=False, max_pulls: int = 12, quiet_pulls: int = 2) -> pd.DataFrame:
    """LOCALDATA pages have no stable ORDER BY: one full page-through of LOCALDATA_072404_JN returned
    20,555 rows but only ~17k distinct 관리번호 (duplicates in, rows silently missed). No server-side
    filter works on the per-구 service, so we repeat full pulls and union by MGTNO until the union holds
    as many ids as the API's row count, or `quiet_pulls` consecutive pulls add nothing new.
    Observed 2026-10-01: 5 pulls to reach all 20,555."""
    cache = RAW / "license" / f"{svc}_union.csv.gz"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, dtype=str, keep_default_na=False)
    union, quiet, history = None, 0, []
    for i in range(max_pulls):
        df = seoul_all(svc)
        before = 0 if union is None else union["MGTNO"].nunique()
        union = df if union is None else pd.concat([union, df], ignore_index=True)
        union = union.sort_values("UPDATEDT").drop_duplicates("MGTNO", keep="last")
        added = len(union) - before
        history.append(added)
        log(f"    pull {i + 1}: {df['MGTNO'].nunique():,} distinct of {len(df):,} rows; +{added:,} new; "
            f"union {len(union):,}")
        quiet = quiet + 1 if added == 0 else 0
        if len(union) == len(df) or quiet >= quiet_pulls:   # every id the API counts is in hand, or stalled
            break
    else:
        log(f"  WARNING: {svc} did not converge in {max_pulls} pulls; union may be incomplete")
    union = union.reset_index(drop=True)
    union.attrs["pull_history"] = history
    cache.parent.mkdir(parents=True, exist_ok=True)
    union.to_csv(cache, index=False)
    return union


def fetch(cfg: dict, refresh=False) -> pd.DataFrame:
    parts = []
    for svc in cfg["license"]["services"]:
        log(f"  license service {svc}")
        parts.append(fetch_converged(svc, refresh))
    df = pd.concat(parts, ignore_index=True).drop_duplicates("MGTNO", keep="last")
    keep = df["OPNSFTEAMCODE"].isin(cfg["license"]["opnsfteam_codes"])
    if (~keep).any():
        log(f"  WARNING: dropped {(~keep).sum()} rows from other 구")
    return df[keep][list(COLS)].rename(columns=COLS)


def clean(df: pd.DataFrame, cfg: dict, run_date) -> pd.DataFrame:
    df = df.copy()
    for c in ("open_date", "close_date"):
        df[c] = pd.to_datetime(df[c].str.strip().replace("", None), errors="coerce")
    df["area_m2"] = pd.to_numeric(df["area_m2"], errors="coerce")
    df.loc[df["area_m2"] <= 0, "area_m2"] = np.nan   # 0 = not recorded
    df["area_pyeong"] = (df["area_m2"] / PYEONG_M2).round(2)
    df["hansik"] = df["uptae"].isin(cfg["license"]["hansik_uptae"]).astype(int)
    # event: 폐업 (status_code 03) with a close date. The 종로구 service only has 01 영업 and 03 폐업
    # (checked 2026-09-30); anything else (휴업, 취소) would be treated as censored-open.
    df["event"] = ((df["status_code"] == "03") & df["close_date"].notna()).astype(int)
    end = df["close_date"].where(df["event"] == 1, pd.Timestamp(run_date))
    df["months_open"] = ((end - df["open_date"]).dt.days / 30.4375).round(2)
    df.loc[df["months_open"] < 0, "months_open"] = np.nan    # close before open = bad row
    df["censor_date"] = pd.Timestamp(run_date).date()
    h = cfg["survival"]["horizon_months"]
    df[f"closed_within_{h}m"] = np.where(
        (df["event"] == 1) & (df["months_open"] <= h), 1,
        np.where(df["months_open"] >= h, 0, np.nan))           # NaN = still open, younger than h
    kw = cfg["license"]["name_keywords"]
    df["pork_name_hint"] = df["name"].fillna("").str.contains("|".join(map(re.escape, kw))).astype(int)
    return df


def locate(df: pd.DataFrame, lookup: pd.DataFrame, polys: dict) -> tuple[pd.DataFrame, dict]:
    """5174 -> 5181 (two candidate datum shifts, pick the one closer to sbiz points at the same address),
    then address backfill, then point-in-polygon."""
    df = df.copy()
    x0 = pd.to_numeric(df["x_5174"], errors="coerce").values
    y0 = pd.to_numeric(df["y_5174"], errors="coerce").values
    df["road_key"] = df["road_addr"].map(road_key)
    df["jibun_key"] = df["jibun_addr"].map(jibun_key)
    lk = lookup.set_index("key")
    ref = df["road_key"].map(lk["x"]).fillna(df["jibun_key"].map(lk["x"])).values, \
        df["road_key"].map(lk["y"]).fillna(df["jibun_key"].map(lk["y"])).values

    diag, best = {}, None
    for label, src in (("pyproj EPSG:5174", "EPSG:5174"), ("5174 + towgs84 (localdata practice)", EPSG5174_TOWGS84)):
        x, y = transformer(src).transform(x0, y0)
        d = np.hypot(x - ref[0], y - ref[1])
        med = float(np.nanmedian(d))
        diag[label] = {"median_offset_m": round(med, 2), "p90_offset_m": round(float(np.nanpercentile(d, 90)), 2),
                       "pairs": int(np.isfinite(d).sum())}
        if best is None or med < best[0]:
            best = (med, label, x, y)
    _, label, x, y = best
    diag["chosen"] = label
    df["x_5181"], df["y_5181"] = x, y
    df["coord_source"] = np.where(np.isfinite(x), "localdata", None)
    miss = ~np.isfinite(x)
    df.loc[miss, "x_5181"] = ref[0][miss]
    df.loc[miss, "y_5181"] = ref[1][miss]
    df.loc[miss & np.isfinite(ref[0]), "coord_source"] = "sbiz_address_lookup"
    diag["coords"] = df["coord_source"].fillna("none").value_counts().to_dict()
    df["x_5181"], df["y_5181"] = df["x_5181"].round(2), df["y_5181"].round(2)
    ok = df["x_5181"].notna()
    df["trdar_code"] = None
    df.loc[ok, "trdar_code"] = assign_trdar(df.loc[ok, "x_5181"], df.loc[ok, "y_5181"], polys)
    return df, diag


RANK = {"high": 4, "medium": 3, "low": 2, "address_only": 1}


def match(stores: pd.DataFrame, lic: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Best license per sbiz store: address key + fuzzy name + distance. No shared ID exists."""
    max_d, name_min = cfg["match"]["max_dist_m"], cfg["match"]["name_min"]
    lic = lic[lic["x_5181"].notna()].reset_index(drop=True)
    lx, ly = lic["x_5181"].values, lic["y_5181"].values
    lnames = lic["name"].fillna("").map(norm_name).values
    rows = []
    for _, s in stores.iterrows():
        sx, sy = float(s["x_5181"]), float(s["y_5181"])
        d = np.hypot(lx - sx, ly - sy)
        skey = road_key(s["road_addr"])
        addr = (lic["road_key"].values == skey) if skey else np.zeros(len(lic), bool)
        cand = np.where((d <= 60) | addr)[0]
        base, full = norm_name(s["name"]), norm_name(f"{s['name']}{s.get('branch_name') or ''}")
        best = None
        for i in cand:
            sim = name_score(base, full, lnames[i])
            near = d[i] <= max_d
            if sim >= 80 and (addr[i] or near):
                conf = "high"
            elif sim >= name_min and (addr[i] or near):
                conf = "medium"
            elif sim >= name_min and d[i] <= 60:
                conf = "low"
            elif addr[i] and lic.at[i, "event"] == 0:
                conf = "address_only"   # open license at the same road address, different name: check by hand
            else:
                continue
            key = (RANK[conf], lic.at[i, "event"] == 0, sim, -d[i])
            if best is None or key > best[0]:
                best = (key, i, conf, sim)
        base = {"store_id": s["store_id"], "store_name": s["name"], "branch_name": s.get("branch_name"),
                "class_code": s["class_code"], "role": s["role"], "trdar_code": s["trdar_code"],
                "store_road_addr": s["road_addr"]}
        if best is None:
            rows.append({**base, "match_confidence": "none"})
            continue
        _, i, conf, sim = best
        L = lic.iloc[i]
        rows.append({**base, "license_id": L["license_id"], "license_name": L["name"],
                     "license_status": L["status"], "license_open_date": L["open_date"].date() if pd.notna(L["open_date"]) else None,
                     "area_m2": L["area_m2"], "area_pyeong": L["area_pyeong"], "license_uptae": L["uptae"],
                     "name_score": round(sim, 1), "dist_m": round(float(d[i]), 1), "same_road_addr": bool(addr[i]),
                     "license_coord_source": L["coord_source"], "match_confidence": conf})
    out = pd.DataFrame(rows)
    dup = out["license_id"].notna() & out.duplicated("license_id", keep=False)
    out["license_shared_with_other_store"] = dup.astype(int)
    return out


def run(cfg: dict, out_dir=PROCESSED, stores: pd.DataFrame | None = None, trdars=None, refresh=False):
    from .fetch_sbiz import download
    run_date = today()
    polys = load_polygons(trdars or cfg["trdar"]["all"])
    raw = fetch(cfg, refresh)
    sbiz_zip, _ = download(cfg["sbiz"]["dataset_id"])
    lookup = address_lookup(sbiz_zip, cfg["sbiz"]["sido_token"])
    lic, diag = locate(clean(raw, cfg, run_date), lookup, polys)
    log(f"  licenses in 구: {len(lic):,}; CRS check: {diag}")
    inside = lic[lic["trdar_code"].notna()].copy()
    inside["trdar_name"] = inside["trdar_code"].map({k: v["trdar_name"] for k, v in polys.items()})
    for c in ("open_date", "close_date"):
        inside[c] = inside[c].dt.date
    cols = ["license_id", "name", "trdar_code", "trdar_name", "uptae", "hansik", "pork_name_hint", "status",
            "status_detail", "open_date", "close_date", "censor_date", "months_open", "event",
            f"closed_within_{cfg['survival']['horizon_months']}m", "area_m2", "area_pyeong",
            "facility_total_scale", "male_staff", "female_staff", "road_addr", "jibun_addr",
            "x_5181", "y_5181", "coord_source", "source_updated"]
    inside = inside[cols].sort_values(["trdar_code", "open_date"]).reset_index(drop=True)
    write_csv(inside, out_dir / "licenses.csv")

    if stores is None:
        stores = pd.read_csv(out_dir / "stores_sbiz.csv", dtype=str, keep_default_na=False)
    stores = stores[stores["role"].isin(["primary", "comparison"])]
    m = match(stores, lic, cfg)
    write_csv(m, out_dir / "store_license_match.csv")
    return inside, m, diag


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    run(load_config(a.industry), refresh=a.refresh)
