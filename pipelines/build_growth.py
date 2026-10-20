"""구별 한식음식점 성장률 -> web/public/mock/growth.json.   python -m pipelines.build_growth [--year 2025]

build_gu_stats.py와 같은 서울시 상권분석서비스 연도별 파일(추정매출-상권, 점포-상권)을 앞선 해(year-1)와 나란히 놓고 비교한다.
  sales_growth   점포당 월매출의 전년 대비 증감률(%). 양쪽 해에 모두 점포가 있는 상권만 센다(같은 상권끼리 비교).
  store_growth   점포 수(분기 평균)의 전년 대비 증감률(%)
  closure_prev / closure_now, opening_prev / opening_now   연 폐업률·개업률(%)
  net_open       개업률 - 폐업률 (%p). 가게가 늘고 있는지 줄고 있는지
읽기 전에
  - 한식음식점 전체 기준이다(고깃집만의 코드는 없다). 카드사 추정 매출이라 물가 상승분이 섞여 있다(명목 증감률).
  - 두 해 모두 한식음식점 점포 수가 있는 상권만 센다. 새로 생긴 상권과 사라진 상권은 빠진다.
"""
from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

import pandas as pd

from .build_gu_stats import RAW, download, read_csv, trdar_gu

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock" / "growth.json"
CODE = "CS100001"  # 한식음식점


def year_table(year: int, gu_of: dict) -> pd.DataFrame:
    sales = read_csv(download("OA-15572", f"{year}년", f"sales_{year}.zip", False))
    stores = read_csv(download("OA-15577", f"{year}년", f"stores_{year}.zip", False))
    s = sales[sales["서비스_업종_코드"] == CODE][["기준_년분기_코드", "상권_코드", "당월_매출_금액"]].copy()
    # 점포-상권 파일은 해마다 열 이름이 다르다(2024는 한글, 2025는 영문 코드명). 위치는 같다.
    stores = stores.rename(columns={"기준_년분기_코드": "stdr_yyqu_cd", "상권_코드": "trdar_cd", "서비스_업종_코드": "svc_induty_cd",
                                    "유사_업종_점포_수": "similr_induty_stor_co", "개업_점포_수": "opbiz_stor_co", "폐업_점포_수": "clsbiz_stor_co"})
    t = stores[stores["svc_induty_cd"] == CODE][["stdr_yyqu_cd", "trdar_cd", "similr_induty_stor_co", "opbiz_stor_co", "clsbiz_stor_co"]].copy()
    s.columns = ["q", "trdar", "amt"]
    t.columns = ["q", "trdar", "n", "op", "cl"]
    for c in ("amt",):
        s[c] = pd.to_numeric(s[c], errors="coerce").fillna(0)
    for c in ("n", "op", "cl"):
        t[c] = pd.to_numeric(t[c], errors="coerce").fillna(0)
    m = s.merge(t, on=["q", "trdar"], how="inner")
    m = m[m.n > 0]
    m["gu"] = m.trdar.map(gu_of)
    return m.dropna(subset=["gu"])


def agg(m: pd.DataFrame) -> dict:
    nq = m.q.nunique()
    stores_avg = m.groupby("q").n.sum().mean()
    return {"stores": stores_avg, "sales_pm": m.amt.sum() / stores_avg / (3 * nq), "closure": m.cl.sum() / stores_avg * 4 / nq * 100,
            "opening": m.op.sum() / stores_avg * 4 / nq * 100}


def build(year: int) -> dict:
    gu_of = trdar_gu(download("OA-15560", "", "relm.zip", False))
    a, b = year_table(year - 1, gu_of), year_table(year, gu_of)
    both = set(a.trdar) & set(b.trdar)           # 두 해 모두 있는 상권만
    a, b = a[a.trdar.isin(both)], b[b.trdar.isin(both)]

    def one(ga: pd.DataFrame, gb: pd.DataFrame) -> dict:
        x, y = agg(ga), agg(gb)
        return {"sales_growth": round((y["sales_pm"] / x["sales_pm"] - 1) * 100, 1), "store_growth": round((y["stores"] / x["stores"] - 1) * 100, 1),
                "closure_prev": round(x["closure"], 1), "closure_now": round(y["closure"], 1),
                "opening_prev": round(x["opening"], 1), "opening_now": round(y["opening"], 1),
                "net_open": round(y["opening"] - y["closure"], 1)}

    gus = {g: one(a[a.gu == g], b[b.gu == g]) for g in sorted(set(b.gu))}
    return {"_meta": {"generated": date.today().isoformat(), "year": year, "prev": year - 1, "method": "pipelines/build_growth.py",
                      "source": "서울시 상권분석서비스(추정매출-상권 OA-15572, 점포-상권 OA-15577, 영역-상권 OA-15560) 한식음식점 CS100001",
                      "trdar_in_both_years": len(both),
                      "caveats": ["한식음식점 전체 기준이다. 고깃집만의 코드는 없다", "카드사 추정 매출이라 물가 상승분이 섞인 명목 증감률이다",
                                  "두 해 모두 점포가 있는 상권만 센다"]},
            "seoul": one(a, b), "gu": gus}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2025)
    d = build(ap.parse_args().year)
    OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    print("seoul", d["seoul"])
    for g, v in sorted(d["gu"].items(), key=lambda kv: -kv[1]["sales_growth"]):
        print(g, v)
