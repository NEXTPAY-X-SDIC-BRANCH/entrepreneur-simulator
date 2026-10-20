"""동 안 상권별 지표 (한식음식점, 커피-음료) -> dong_trdar.json   python -m pipelines.build_dong_trdar [폴더]

입력 (서울시 상권분석서비스, 원본은 용량이 커서 저장소에 넣지 않는다. 기본 위치 data/raw/seoul_trdar/, 모두 cp949)
  서울시 상권분석서비스(영역-상권).csv      상권 코드 -> 자치구·행정동, 유형(골목/발달/전통시장/관광특구)
  서울시 상권분석서비스(추정매출-상권).csv  분기별 업종별 매출
  서울시 상권분석서비스(점포-상권).csv      분기별 업종별 점포·프랜차이즈·개업·폐업 수
출력 web/public/mock/dong_trdar.json, 행정동 코드(8자리)별 상권 목록. 계산은 docs/design-handoff/scripts/trdar.py를 따른다.
  per_store  점포당 월매출(만원) = 최근 분기 매출 ÷ 3 ÷ 점포 수 ÷ 1만
  yoy        1년 매출 증감(%) = 최근 분기 / 1년 전 같은 분기 − 1 (상권 전체 매출이라 점포 수 변화가 섞여 있다)
  open, close 최근 4분기 개업·폐업 점포 수 합
  weekend, band, age2030, age4050  매출 비중
  _bench     서울 상권(해당 업종 점포 5곳 이상)의 점포당 월매출 25·50·75분위
읽기 전에
  - 상권은 중심이 속한 행정동 하나에만 붙는다(맞닿은 동의 상권은 나오지 않는다).
  - 업종은 한식음식점 전체(CS100001)와 커피-음료(CS100010)다. 상권별 고깃집 수는 없다.
라벨(성장·안정·조심)은 화면에서 규칙으로 붙인다(area.ts trdarPicks). 규칙을 바꿔도 이 파일은 다시 만들 필요가 없다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
RAW = ROOT / "data" / "raw" / "seoul_trdar"
IND = {"CS100001": "bbq", "CS100010": "cafe"}
BAND = {"morning": "06~11", "lunch": "11~14", "afternoon": "14~17", "evening": "17~21", "night": "21~24"}
AGES = ["10", "20", "30", "40", "50", "60_이상"]


def rd(path: Path, **kw) -> pd.DataFrame:
    for enc in ("cp949", "utf-8-sig"):
        try:
            return pd.read_csv(path, encoding=enc, **kw)
        except UnicodeDecodeError:
            pass
    raise SystemExit(f"인코딩을 알 수 없음: {path}")


def r3(x: float) -> float:
    return round(float(x), 3)


def main() -> None:
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else RAW
    area = rd(d / "서울시 상권분석서비스(영역-상권).csv", dtype=str)
    key = {"상권_코드": str, "서비스_업종_코드": str, "기준_년분기_코드": str}
    sales = rd(d / "서울시 상권분석서비스(추정매출-상권).csv", dtype=key)
    stores = rd(d / "서울시 상권분석서비스(점포-상권).csv", dtype=key)
    sales = sales[sales["서비스_업종_코드"].isin(IND)]
    stores = stores[stores["서비스_업종_코드"].isin(IND)]
    qs = sorted(stores["기준_년분기_코드"].unique())
    q, q_prev, last4 = qs[-1], f"{int(qs[-1][:4]) - 1}{qs[-1][4]}", qs[-4:]
    s_now = sales[sales["기준_년분기_코드"] == q].set_index(["상권_코드", "서비스_업종_코드"])
    s_prev = sales[sales["기준_년분기_코드"] == q_prev].set_index(["상권_코드", "서비스_업종_코드"])
    st_now = stores[stores["기준_년분기_코드"] == q].set_index(["상권_코드", "서비스_업종_코드"])
    flow = stores[stores["기준_년분기_코드"].isin(last4)].groupby(["상권_코드", "서비스_업종_코드"])[["개업_점포_수", "폐업_점포_수"]].sum()

    def metrics(c: str, ic: str) -> dict | None:
        k = (c, ic)
        if k not in st_now.index:
            return None
        n = int(st_now.loc[k, "전체_점포_수"])
        out = {"stores": n, "franchise": int(st_now.loc[k, "프랜차이즈_점포_수"]),
               "open": int(flow.loc[k, "개업_점포_수"]) if k in flow.index else 0,
               "close": int(flow.loc[k, "폐업_점포_수"]) if k in flow.index else 0}
        if k in s_now.index and n:
            r = s_now.loc[k]
            amt = float(r["당월_매출_금액"])
            out["per_store"] = round(amt / 3 / n / 1e4, 1)
            if amt:
                out["weekend"] = r3(float(r["주말_매출_금액"]) / amt)
                tot = sum(float(r[f"시간대_{v}_매출_금액"]) for v in BAND.values())
                out["band"] = {b: r3(float(r[f"시간대_{v}_매출_금액"]) / tot) for b, v in BAND.items()} if tot else None
                ages = [float(r[f"연령대_{a}_매출_금액"]) for a in AGES]
                at = sum(ages)
                if at:
                    out["age2030"], out["age4050"] = r3((ages[1] + ages[2]) / at), r3((ages[3] + ages[4]) / at)
            if k in s_prev.index and float(s_prev.loc[k, "당월_매출_금액"]) > 0:
                out["yoy"] = round((amt / float(s_prev.loc[k, "당월_매출_금액"]) - 1) * 100, 1)
        return out

    dong: dict[str, list] = {}
    for a in area.itertuples(index=False):
        c = a.상권_코드
        ind = {name: m for ic, name in IND.items() if (m := metrics(c, ic))}
        dong.setdefault(a.행정동_코드, []).append({"code": c, "name": a.상권_코드_명, "type": a.상권_구분_코드_명, "ind": ind})

    bench = {}
    for ic, name in IND.items():
        m = st_now.xs(ic, level=1)[["전체_점포_수"]].join(s_now.xs(ic, level=1)[["당월_매출_금액"]], how="inner")
        m = m[m["전체_점포_수"] >= 5]
        ps = m["당월_매출_금액"] / 3 / m["전체_점포_수"] / 1e4
        bench[name] = {"n": int(len(m)), "per_store_q": [round(float(ps.quantile(x)), 1) for x in (0.25, 0.5, 0.75)]}

    meta = {"generated": pd.Timestamp.now().strftime("%Y-%m-%d"), "source": "서울시 상권분석서비스 (영역·추정매출·점포-상권)",
            "quarter": q, "quarter_prev": q_prev, "flow_quarters": last4, "bench": bench}
    (MOCK / "dong_trdar.json").write_text(json.dumps({"_meta": meta, "dong": dong}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"dong_trdar.json 동 {len(dong)}곳, 상권 {len(area)}곳, 기준 {q} (1년 전 {q_prev}, 개폐업 {last4[0]}~{last4[-1]})", bench)


if __name__ == "__main__":
    main()
