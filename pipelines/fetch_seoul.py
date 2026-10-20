"""서울시 상권분석서비스 -> data/processed/seoul_*.csv for the configured 상권 × quarters.

Service filters the API actually honours (checked 2026-09-30):
  VwsmTrdarSelngQq  /{quarter}            (상권 filter ignored -> whole quarter, ~21k rows, filter locally)
  VwsmTrdarStorQq   /{quarter}/{trdar}    (~78 rows per 상권-quarter)
  VwsmTrdarFlpopQq  /{quarter}            (~1.65k rows)
  VwsmTrdarWrcPopltnQq, VwsmTrdarRepopQq, VwsmTrdarFcltyQq: quarter filter ignored -> all ~36k rows
"""
from __future__ import annotations

import argparse
import json

import pandas as pd

from .common import (PROCESSED, RAW, load_config, load_polygons, log, quarters, seoul_all,
                     tidy_seoul, transformer, write_csv)

CACHE = RAW / "seoul"

UNITS = [
    ("seoul_sales.csv", "sales_amt_*", "KRW per QUARTER",
     "Source column is 당월_매출_금액 (THSMON_SELNG_AMT) but the value is the quarter total. Card-company "
     "estimate scaled up. Age/sex splits exclude corporate cards, so they sum to less than sales_amt_total."),
    ("seoul_sales.csv", "sales_cnt_*", "transactions per QUARTER", "Same caveats as sales_amt_*."),
    ("seoul_stores.csv", "stores_*", "stores (count at quarter)",
     "stores_total = stores_non_franchise + stores_franchise (SIMILR_INDUTY_STOR_CO)."),
    ("seoul_stores.csv", "open_rate_pct / close_rate_pct", "percent", "Openings/closures in the quarter."),
    ("seoul_flpop.csv", "flpop_*", "persons (estimated, quarter aggregate as served)",
     "Mobile-signal estimate. flpop_total = sum of the 7 weekday columns; per-day unit not stated by the "
     "source, so compare within the dataset only."),
    ("seoul_workers.csv", "workers_*", "persons", "Refreshed yearly (Q4); Q1-Q3 of the next year repeat it."),
    ("seoul_residents.csv", "residents_* / households_*", "persons / households", "Same yearly refresh."),
    ("seoul_facilities.csv", "all numeric", "count of facilities", "Same yearly refresh."),
]


def _filter(df: pd.DataFrame, trdars, qs=None, services=None) -> pd.DataFrame:
    if df.empty:
        return df
    m = df["TRDAR_CD"].isin(trdars)
    if qs is not None:
        m &= df["STDR_YYQU_CD"].isin(qs)
    if services is not None:
        m &= df["SVC_INDUTY_CD"].isin(services)
    return df[m]


def fetch_sales(qs, trdars, services, refresh=False) -> pd.DataFrame:
    parts = []
    for q in qs:
        log(f"  sales {q}")
        df = seoul_all("VwsmTrdarSelngQq", q, cache=CACHE / "VwsmTrdarSelngQq" / f"{q}.csv.gz", refresh=refresh)
        parts.append(_filter(df, trdars, services=services))
    return tidy_seoul(pd.concat(parts, ignore_index=True))


def fetch_stores(qs, trdars, services, refresh=False) -> pd.DataFrame:
    parts = []
    for q in qs:
        for t in trdars:
            df = seoul_all("VwsmTrdarStorQq", q, t, cache=CACHE / "VwsmTrdarStorQq" / f"{q}_{t}.csv.gz",
                           refresh=refresh)
            parts.append(_filter(df, [t], services=services))
    return tidy_seoul(pd.concat(parts, ignore_index=True))


def fetch_flpop(qs, trdars, refresh=False) -> pd.DataFrame:
    parts = [_filter(seoul_all("VwsmTrdarFlpopQq", q, cache=CACHE / "VwsmTrdarFlpopQq" / f"{q}.csv.gz",
                               refresh=refresh), trdars) for q in qs]
    return tidy_seoul(pd.concat(parts, ignore_index=True))


def fetch_whole(service: str, qs, trdars, refresh=False) -> pd.DataFrame:
    df = seoul_all(service, cache=CACHE / service / "all.csv.gz", refresh=refresh)
    return tidy_seoul(_filter(df, trdars, qs=qs).reset_index(drop=True))


def boundaries(trdars, out_dir):
    """Attribute table + GeoJSON (WGS84) for the configured 상권."""
    polys = load_polygons(trdars)
    to_wgs = transformer("EPSG:5181", "EPSG:4326")
    from shapely.ops import transform
    rows, feats = [], []
    for code, p in polys.items():
        g84 = transform(to_wgs.transform, p["geom"])
        c = g84.centroid
        rows.append({"trdar_code": code, **{k: v for k, v in p.items() if k != "geom"},
                     "polygon_area_m2": round(p["geom"].area, 1), "centroid_lon": c.x, "centroid_lat": c.y})
        feats.append({"type": "Feature", "properties": {"trdar_code": code, "trdar_name": p["trdar_name"]},
                      "geometry": g84.__geo_interface__})
    write_csv(pd.DataFrame(rows), out_dir / "seoul_trdar.csv")
    path = out_dir / "trdar_boundaries.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))
    log(f"  wrote {path.name}")
    return polys


def run(cfg: dict, out_dir=PROCESSED, qs=None, trdars=None, refresh=False) -> dict:
    qs = qs or quarters(cfg)
    polys = boundaries(trdars or cfg["trdar"]["all"], out_dir)
    trdars = [t for t in (trdars or cfg["trdar"]["all"]) if t in polys]
    services = cfg["seoul"]["service_codes"]
    log(f"fetch_seoul: {len(trdars)} 상권 × {len(qs)} quarters ({qs[0]}..{qs[-1]})")
    out = {
        "seoul_sales": fetch_sales(qs, trdars, services, refresh),
        "seoul_stores": fetch_stores(qs, trdars, services, refresh),
        "seoul_flpop": fetch_flpop(qs, trdars, refresh),
        "seoul_workers": fetch_whole("VwsmTrdarWrcPopltnQq", qs, trdars, refresh),
        "seoul_residents": fetch_whole("VwsmTrdarRepopQq", qs, trdars, refresh),
        "seoul_facilities": fetch_whole("VwsmTrdarFcltyQq", qs, trdars, refresh),
    }
    for name, df in out.items():
        df = df.sort_values([c for c in ("trdar_code", "quarter", "service_code") if c in df.columns])
        out[name] = df.reset_index(drop=True)
        write_csv(out[name], out_dir / f"{name}.csv")
    write_csv(pd.DataFrame(UNITS, columns=["file", "columns", "unit", "note"]), out_dir / "units.csv")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    run(load_config(a.industry), refresh=a.refresh)
