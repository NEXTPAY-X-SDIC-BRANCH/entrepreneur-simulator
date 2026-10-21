"""새 업종의 서울 25개 구 요약 -> web/public/mock/industry_gu.json.  python -m pipelines.build_industry_gu  (lab:industry)

gu_stats.json(pipelines/build_gu_stats.py)과 같은 모양의 블록을 업종 id마다 만든다. 화면(model.ts guStat)이 그대로 읽는다.
입력 (키 없음, 무료 공개 파일. build_gu_stats.download()가 받는 것과 같은 파일)
  data/raw/seoul_files/sales_2025.zip   서울시 상권분석서비스 추정매출-상권 OA-15572
  data/raw/seoul_files/stores_2025.zip  점포-상권 OA-15577
  data/raw/seoul_files/relm.zip         영역-상권 OA-15560 (상권 -> 자치구)
  data/raw/sbiz/sbiz_*.zip              소상공인 상가(상권)정보: 구 전체 점포 수 (상권 밖 포함)
블록마다 더 들어가는 값
  band_share   시간대 매출 비중 (00~06, 06~11, 11~14, 14~17, 17~21, 21~24). 엔진의 영업시간 효과에 쓴다.
  count        구 전체의 그 업종 점포 수 (상가정보 소분류, registry.py sbiz)
  franchise    상권 안 점포 중 프랜차이즈 비중
읽기 전에
  - 상권 영역 안의 점포만 센다. 매출은 카드사 추정치다(배달 앱 결제가 많은 치킨·분식은 실제보다 낮게 잡힌다).
    그래서 엔진은 이 매출을 금액으로 쓰지 않고 구 사이의 상대 크기(demand_index)로만 쓴다.
  - 한식 백반집은 상권분석서비스에 따로 코드가 없어 한식음식점(CS100001, 고깃집 포함) 값이다.
"""
from __future__ import annotations

import json
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd

from sim.generic.registry import INDUSTRIES

from .build_gu_stats import RAW, read_csv, trdar_gu

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "web" / "public" / "mock" / "industry_gu.json"
BANDS = ["00~06", "06~11", "11~14", "14~17", "17~21", "21~24"]


def sbiz_by_gu() -> tuple[pd.DataFrame, str]:
    zips = sorted((REPO / "data" / "raw" / "sbiz").glob("sbiz_*.zip"))
    z = zipfile.ZipFile(zips[-1], metadata_encoding="cp949")
    name = next(n for n in z.namelist() if "서울" in n and n.endswith(".csv"))
    df = pd.read_csv(z.open(name), dtype=str, usecols=["상권업종소분류코드", "시군구명"], encoding="utf-8-sig", keep_default_na=False)
    return df, zips[-1].stem.split("_")[-1]


def build() -> dict:
    sales = read_csv(RAW / "sales_2025.zip")
    stores = read_csv(RAW / "stores_2025.zip")
    gu_of = trdar_gu(RAW / "relm.zip")
    quarters = sorted(sales["기준_년분기_코드"].unique())
    sb, snap = sbiz_by_gu()
    dow = [f"{d}요일_매출_금액" for d in "월화수목금토일"]
    band = [f"시간대_{b}_매출_금액" for b in BANDS]
    scols = ["당월_매출_금액", "당월_매출_건수", "주말_매출_금액", *dow, *band]
    tcols = ["similr_induty_stor_co", "opbiz_stor_co", "clsbiz_stor_co", "frc_stor_co"]
    out: dict = {}
    for ind, spec in INDUSTRIES.items():
        s = sales[sales["서비스_업종_코드"] == spec["service"]].copy()
        t = stores[stores["svc_induty_cd"] == spec["service"]].copy()
        s[scols] = s[scols].apply(pd.to_numeric, errors="coerce").fillna(0)
        t[tcols] = t[tcols].apply(pd.to_numeric, errors="coerce").fillna(0)
        s = s.rename(columns={"기준_년분기_코드": "q", "상권_코드": "trdar"})[["q", "trdar", *scols]]
        t = t.rename(columns={"stdr_yyqu_cd": "q", "trdar_cd": "trdar"})[["q", "trdar", *tcols]]
        m = s.merge(t, on=["q", "trdar"], how="inner")
        m = m[m["similr_induty_stor_co"] > 0]
        m["gu"] = m["trdar"].map(gu_of)
        m = m.dropna(subset=["gu"])
        counts = sb[sb["상권업종소분류코드"].isin(spec["sbiz"])].groupby("시군구명").size().to_dict()

        def summary(g: pd.DataFrame) -> dict:
            n = g.groupby("q")["similr_induty_stor_co"].sum().mean()
            amt, cnt = g["당월_매출_금액"].sum(), g["당월_매출_건수"].sum()
            return {
                "trdar": int(g["trdar"].nunique()), "stores": round(float(n)),
                "sales_per_store_month": round(amt / n / (3 * len(quarters)) / 10000),
                "tx_per_store_day": round(cnt / n / (91.25 * len(quarters)), 1),
                "ticket": round(amt / cnt) if cnt else None,
                "evening_share": round((g["시간대_17~21_매출_금액"].sum() + g["시간대_21~24_매출_금액"].sum()) / amt, 3),
                "weekend_share": round(g["주말_매출_금액"].sum() / amt, 3),
                "dow_share": [round(float(g[c].sum() / g[dow].sum().sum()), 4) for c in dow],
                "band_share": [round(float(g[c].sum() / g[band].sum().sum()), 4) for c in band],
                "quarter_index": [round(float(g.loc[g["q"] == q, "당월_매출_금액"].sum() / (amt / len(quarters))), 3) for q in quarters],
                "closure_rate": round(g["clsbiz_stor_co"].sum() / n * (4 / len(quarters)), 3),
                "opening_rate": round(g["opbiz_stor_co"].sum() / n * (4 / len(quarters)), 3),
                "franchise": round(g["frc_stor_co"].sum() / len(quarters) / n, 3),
            }

        seoul = summary(m)
        seoul["count"] = int(sum(counts.values()))
        gus = {}
        for gu, g in m.groupby("gu"):
            v = summary(g)
            v["demand_index"] = round(v["sales_per_store_month"] / seoul["sales_per_store_month"], 2)
            v["count"] = int(counts.get(gu, 0))
            gus[gu] = v
        out[ind] = {"service_code": spec["service"], "service_name": spec["base"], "sbiz": spec["sbiz"], "seoul": seoul, "gu": gus}
    return {
        "_meta": {"generated": date.today().isoformat(), "year": int(quarters[0][:4]), "quarters": quarters, "sbiz_snapshot": snap,
                  "sources": {"sales": "서울시 상권분석서비스(추정매출-상권) OA-15572", "stores": "서울시 상권분석서비스(점포-상권) OA-15577",
                              "boundary": "서울시 상권분석서비스(영역-상권) OA-15560", "count": "소상공인시장진흥공단 상가(상권)정보 data.go.kr 15083033"},
                  "license": "공공누리 1유형", "method": "pipelines/build_industry_gu.py",
                  "caveats": ["상권 영역 안의 점포만 집계 (count만 구 전체)", "매출은 카드사 추정치라 배달 비중이 큰 업종은 낮게 잡힘, 구 사이 비교에만 씀",
                              "한식 백반집은 한식음식점 전체(CS100001) 기준"]},
        **out,
    }


if __name__ == "__main__":
    data = build()
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for ind in INDUSTRIES:
        s = data[ind]["seoul"]
        print(f"{ind}: 구 {len(data[ind]['gu'])}, 서울 점포 {s['stores']} (상가정보 {s['count']}), 월매출 {s['sales_per_store_month']}만, 폐업 {s['closure_rate']}")
