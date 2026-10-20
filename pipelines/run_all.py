"""Single entrypoint.

  python -m pipelines.run_all                 full run -> data/processed/
  python -m pipelines.run_all --selftest      1 quarter × 1 상권 -> data/raw/selftest/, asserts shapes
  python -m pipelines.run_all --refresh       ignore the data/raw caches and re-download

Raw API pages and downloads are cached under data/raw/ (gitignored); a re-run is offline except for
two small page fetches that resolve the current download links.
"""
from __future__ import annotations

import argparse
import json
import time

import pandas as pd

from . import build_district_profile, fetch_license, fetch_sbiz, fetch_seoul
from .common import PROCESSED, RAW, load_config, log, seoul_key


def run(cfg, out_dir, qs=None, trdars=None, refresh=False):
    t0 = time.time()
    log("[1/4] 서울시 상권분석서비스")
    fetch_seoul.run(cfg, out_dir, qs=qs, trdars=trdars, refresh=refresh)
    log("[2/4] 소상공인 상가(상권)정보")
    stores = fetch_sbiz.run(cfg, out_dir, trdars=trdars, refresh=refresh)
    log("[3/4] 일반음식점 인허가")
    fetch_license.run(cfg, out_dir, stores=stores, trdars=trdars, refresh=refresh)
    if cfg.get("survival_scope") == "wide" and trdars is None:
        from . import survival_wide
        log("[3b] wide survival sample")
        survival_wide.run(cfg, out_dir, refresh=refresh)
    log("[4/4] district profile")
    profile = build_district_profile.run(cfg, out_dir, trdars=trdars)
    log(f"done in {time.time() - t0:.0f}s")
    return profile


def assert_no_key(out_dir):
    key = seoul_key()
    for p in out_dir.rglob("*"):
        if p.is_file() and p.suffix in (".csv", ".json", ".geojson", ".md"):
            assert key not in p.read_text(encoding="utf-8", errors="ignore"), f"API key leaked into {p}"


def selftest(cfg, refresh=False):
    q, t = cfg["seoul"]["quarters"]["end"], cfg["trdar"]["primary"][0]
    q = "20254" if q > "20254" else q   # a quarter every service has
    out = RAW / "selftest"
    profile = run(cfg, out, qs=[q], trdars=[t], refresh=refresh)
    rd = lambda n: pd.read_csv(out / f"{n}.csv", dtype={"quarter": str, "trdar_code": str})  # noqa: E731

    sales = rd("seoul_sales")
    assert len(sales) == len(cfg["seoul"]["service_codes"]), f"sales rows {len(sales)}"
    assert set(sales["quarter"]) == {q} and set(sales["trdar_code"]) == {t}
    assert all(c == c.lower() for c in sales.columns), "non-snake_case column"
    for c in ("sales_amt_total", "sales_amt_t17_21", "sales_amt_age20", "sales_amt_female", "sales_cnt_sun"):
        assert c in sales.columns, c
    assert (sales["sales_amt_total"] > 0).all()
    st = rd("seoul_stores")
    assert len(st) == len(cfg["seoul"]["service_codes"])
    assert (st["stores_total"] == st["stores_non_franchise"] + st["stores_franchise"]).all()
    for n in ("seoul_flpop", "seoul_workers", "seoul_residents", "seoul_facilities"):
        d = rd(n)
        assert len(d) <= 1 and set(d["trdar_code"]) <= {t}, n
    assert len(rd("seoul_flpop")) == 1

    sb = pd.read_csv(out / "stores_sbiz.csv", dtype=str)
    assert set(sb["trdar_code"]) == {t}
    assert (sb["role"] == "primary").sum() > 0 and set(sb["franchise_flag"]) <= {"0", "1"}
    lic = rd("licenses")
    assert set(lic["trdar_code"]) == {t} and len(lic) > 0
    assert lic["license_id"].is_unique, "duplicate 관리번호 (unstable LOCALDATA paging not unioned?)"
    assert set(lic["event"]) <= {0, 1} and (lic["months_open"].dropna() >= 0).all()
    a = lic.dropna(subset=["area_m2"])
    assert ((a["area_pyeong"] - a["area_m2"] / 3.3058).abs() < 0.01).all()
    m = pd.read_csv(out / "store_license_match.csv", dtype=str)
    assert len(m) == sb["role"].isin(["primary", "comparison"]).sum()

    p = profile["trdar"][t]["quarters"][q]
    assert p["hansik_sales_krw"] > 0 and p["stores_total"] > 0
    for k in ("dow_share", "timeband_share", "age_share", "sex_share"):
        assert abs(sum(p[k].values()) - 1) < 1e-3, k
    assert 0 < p["evening_share_17_24"] < 1
    assert profile["survival"]["hansik_primary"]["n"] > 0
    json.loads((out / "district_profile.json").read_text())
    assert_no_key(out)
    log(f"SELFTEST PASS ({q}, {t}): sales={p['hansik_sales_krw']:,} stores={p['stores_total']} "
        f"sbiz={len(sb)} licenses={len(lic)} matches={len(m)}")


def spot_check(profile, cfg):
    """Values measured live on 2026-09-30; printed, not asserted, so a data refresh does not break runs."""
    t = cfg["trdar"]["primary"][0]
    d = profile["trdar"][t]
    y25 = d["annual"].get("2025", {})
    q = d["quarters"].get("20254", {})
    log(f"SPOT CHECK {t}: 2025 한식 sales = ₩{(y25.get('hansik_sales_krw') or 0) / 1e8:,.1f}억 "
        f"(expected ~590.9억); 2025Q4 stores = {q.get('stores_independent')} + {q.get('stores_franchise')} franchise "
        f"(expected 160 + 31); sbiz I20107 = {(d['sbiz_stores'].get('I20107') or {}).get('stores')} (expected ~27)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    cfg = load_config(a.industry)
    if a.selftest:
        selftest(cfg, a.refresh)
    else:
        prof = run(cfg, PROCESSED, refresh=a.refresh)
        assert_no_key(PROCESSED)
        spot_check(prof, cfg)
