"""업종 확대 근거: 서울 외식 업종 순위 -> research/industries/rank.json.  (lab:industry)

    python -m pipelines.build_industry_rank [--krei <2025 외식업체 경영실태 조사 원자료.xlsx>]

입력 (모두 무료 공개 자료, 키 없음)
  data/raw/seoul_files/stores_2025.zip  서울시 상권분석서비스 점포-상권 OA-15577 (2025년 4분기치). build_gu_stats.download()가 받는다.
  data/raw/seoul_files/sales_2025.zip   같은 서비스 추정매출-상권 OA-15572.
  data/raw/sbiz/sbiz_*.zip              소상공인시장진흥공단 상가(상권)정보 (data.go.kr 15083033), 서울 전체 점포 수.
  --krei (선택)                          농식품부·농경연 2025 외식업체 경영실태 조사 원자료(엑셀). 2021년 이후 개업 가게의 업종 비중.
출력 research/industries/rank.json: 업종마다 서울 점포 수, 연 개업 수, 개업률·폐업률, 점포당 월매출, 20~30대 매출 비중,
  상가정보 점포 수, 경영실태조사의 최근 개업 비중과 40세 미만 개업 비중.
읽기 전에
  - 상권분석서비스는 1,650개 상권 영역 안의 점포만 센다(서울 전체가 아님). 상가정보는 서울 전체.
  - 개업·폐업 수는 분기 값을 더한 연간 값이다. 매출은 카드 추정치라 배달 앱 결제가 많은 업종(치킨)은 낮게 잡힐 수 있다.
  - 경영실태조사 비중은 가중치(WT)를 쓴 전국 값이다. 표본이 '지금 영업 중인 가게'라 문 닫은 가게는 빠진다.
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

import pandas as pd

from .build_gu_stats import RAW, read_csv

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "research" / "industries" / "rank.json"

# 서울시 상권분석서비스 외식 10개 업종 -> 상가정보 소분류, 경영실태조사 업종(a3, 한식은 a3a 세분류)
SERVICES = {
    "CS100001": {"name": "한식음식점", "sbiz": ["I20101", "I20102", "I20103", "I20104", "I20105", "I20106", "I20107", "I20108",
                                              "I20109", "I20110", "I20111", "I20112", "I20113", "I20199"], "krei": [(1, None)]},
    "CS100002": {"name": "중식음식점", "sbiz": ["I20201", "I20202"], "krei": [(2, None)]},
    "CS100003": {"name": "일식음식점", "sbiz": ["I20301", "I20302", "I20303", "I20399"], "krei": [(3, None)]},
    "CS100004": {"name": "양식음식점", "sbiz": ["I20401", "I20402", "I20403", "I20499"], "krei": [(4, None)]},
    "CS100005": {"name": "제과점", "sbiz": ["I21001"], "krei": [(8, None)]},
    "CS100006": {"name": "패스트푸드점", "sbiz": ["I21003", "I21004", "I21005"], "krei": [(9, None)]},
    "CS100007": {"name": "치킨전문점", "sbiz": ["I21006"], "krei": [(10, None)]},
    "CS100008": {"name": "분식전문점", "sbiz": ["I21007"], "krei": [(11, None)]},
    "CS100009": {"name": "호프-간이주점", "sbiz": ["I21103", "I21104"], "krei": [(15, None), (16, None)]},
    "CS100010": {"name": "커피-음료", "sbiz": ["I21201"], "krei": [(17, None), (18, None)]},
}
# 한식 안의 세분류 (상가정보 소분류, 경영실태조사 a3a). 상권분석서비스는 한식을 나누지 않는다.
HANSIK_SUB = {
    "백반·한식 일반": {"sbiz": ["I20101", "I20102", "I20104", "I20199"], "krei": [(1, 1)]},
    "한식 육류(고깃집)": {"sbiz": ["I20107", "I20108", "I20109", "I20110", "I20103"], "krei": [(1, 3)]},
    "한식 면": {"sbiz": ["I20105", "I20106"], "krei": [(1, 2)]},
    "한식 해산물": {"sbiz": ["I20111", "I20112", "I20113"], "krei": [(1, 4)]},
}


def seoul_service() -> pd.DataFrame:
    st = read_csv(RAW / "stores_2025.zip")
    st = st[st["svc_induty_cd"].isin(SERVICES)].copy()
    for c in ("similr_induty_stor_co", "opbiz_stor_co", "clsbiz_stor_co", "frc_stor_co"):
        st[c] = pd.to_numeric(st[c], errors="coerce").fillna(0)
    nq = st["stdr_yyqu_cd"].nunique()
    g = st.groupby("svc_induty_cd")
    out = pd.DataFrame({"stores": g["similr_induty_stor_co"].sum() / nq, "opened_year": g["opbiz_stor_co"].sum() * 4 / nq,
                        "closed_year": g["clsbiz_stor_co"].sum() * 4 / nq, "franchise": g["frc_stor_co"].sum() / nq})
    sa = read_csv(RAW / "sales_2025.zip")
    sa = sa[sa["서비스_업종_코드"].isin(SERVICES)].copy()
    cols = ["당월_매출_금액", "당월_매출_건수", "연령대_20_매출_금액", "연령대_30_매출_금액"]
    sa[cols] = sa[cols].apply(pd.to_numeric, errors="coerce").fillna(0)
    s = sa.groupby("서비스_업종_코드")[cols].sum()
    out = out.join(s)
    out["sales_per_store_month_man"] = out["당월_매출_금액"] / out["stores"] / (3 * nq) / 1e4
    out["ticket_krw"] = out["당월_매출_금액"] / out["당월_매출_건수"]
    out["age2030_sales_share"] = (out["연령대_20_매출_금액"] + out["연령대_30_매출_금액"]) / out["당월_매출_금액"]
    out["quarters"] = ",".join(sorted(st["stdr_yyqu_cd"].unique()))
    return out


def sbiz_counts() -> tuple[dict[str, int], str]:
    zips = sorted((REPO / "data" / "raw" / "sbiz").glob("sbiz_*.zip"))
    z = zipfile.ZipFile(zips[-1], metadata_encoding="cp949")
    name = next(n for n in z.namelist() if "서울" in n and n.endswith(".csv"))
    df = pd.read_csv(z.open(name), dtype=str, usecols=["상권업종소분류코드"], encoding="utf-8-sig", keep_default_na=False)
    return df["상권업종소분류코드"].value_counts().to_dict(), zips[-1].stem.split("_")[-1]


def krei_shares(xlsx: str) -> dict:
    """2021년 이후 개업한 가게(조사 시점 영업 중)의 업종 비중, 가중치 WT. 40세 미만에 연 가게만 따로."""
    df = pd.read_excel(xlsx, sheet_name="Data", header=1)
    for c in ("a3", "a3a", "a5", "b1a1", "WT"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    rec = df[df["b1a1"] >= 2021].copy()
    rec["age_open"] = rec["a5"] - (2025 - rec["b1a1"])
    young = rec[rec["age_open"] < 40]

    def share(d: pd.DataFrame, keys: list[tuple[int, int | None]]) -> float:
        m = pd.Series(False, index=d.index)
        for a3, a3a in keys:
            m |= (d["a3"] == a3) & ((d["a3a"] == a3a) if a3a else True)
        return float(d.loc[m, "WT"].sum() / d["WT"].sum())

    groups = {**{v["name"]: v["krei"] for v in SERVICES.values()}, **{k: v["krei"] for k, v in HANSIK_SUB.items()}}
    return {"n_recent": int(len(rec)), "n_young": int(len(young)),
            "recent": {k: round(share(rec, v), 4) for k, v in groups.items()},
            "young": {k: round(share(young, v), 4) for k, v in groups.items()}}


def build(krei_xlsx: str | None) -> dict:
    svc = seoul_service()
    counts, snap = sbiz_counts()
    rows = []
    for code, spec in SERVICES.items():
        r = svc.loc[code]
        rows.append({"code": code, "name": spec["name"], "stores_trdar": round(r["stores"]), "opened_year": round(r["opened_year"]),
                     "closed_year": round(r["closed_year"]), "open_rate": round(r["opened_year"] / r["stores"], 3),
                     "close_rate": round(r["closed_year"] / r["stores"], 3), "franchise_share": round(r["franchise"] / r["stores"], 3),
                     "sales_per_store_month_man": round(r["sales_per_store_month_man"]), "ticket_krw": round(r["ticket_krw"]),
                     "age2030_sales_share": round(r["age2030_sales_share"], 3),
                     "stores_sbiz": int(sum(counts.get(c, 0) for c in spec["sbiz"]))})
    sub = [{"name": k, "stores_sbiz": int(sum(counts.get(c, 0) for c in v["sbiz"]))} for k, v in HANSIK_SUB.items()]
    out = {"_meta": {"quarters": svc["quarters"].iloc[0].split(","), "sbiz_snapshot": snap,
                     "sources": {"stores": "서울시 상권분석서비스 점포-상권 OA-15577 (2025)", "sales": "서울시 상권분석서비스 추정매출-상권 OA-15572 (2025)",
                                 "sbiz": "소상공인시장진흥공단 상가(상권)정보 data.go.kr 15083033",
                                 "krei": "농식품부·농경연 2025 외식업체 경영실태 조사 원자료 (n=3,138, 가중치 WT)"},
                     "method": "pipelines/build_industry_rank.py"},
           "services": rows, "hansik_sub": sub}
    if krei_xlsx:
        out["krei"] = krei_shares(krei_xlsx)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--krei", default=None)
    a = ap.parse_args()
    data = build(a.krei)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in sorted(data["services"], key=lambda x: -x["opened_year"]):
        print(f"{r['name']:<10} 점포 {r['stores_trdar']:>6} 개업 {r['opened_year']:>5} 상가정보 {r['stores_sbiz']:>6}")
