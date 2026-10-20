"""서울 25개 구 요약 -> web/public/mock/gu_stats.json.  python -m pipelines.build_gu_stats [--year 2025] [--refresh]

Aggregates the 서울시 상권분석서비스 yearly file downloads (no API key) from 상권 to 자치구:
  OA-15572 추정매출-상권, OA-15577 점포-상권, OA-15560 영역-상권 (상권 -> 자치구).
Per 구 and 업종: stores, monthly sales per store, card transactions per store per day, average ticket,
evening and weekend sales shares, sales share by day of week, quarter index, yearly closure and opening rates.
With the 소상공인 상가(상권)정보 zip (data.go.kr 15083033, pipelines.fetch_sbiz.download) it also counts, per 구,
the stores classified 돼지고기 구이/찜 (I20107), 소고기 구이/찜 (I20108) and 곱창 전골/구이 (I20109): a store
count for the whole 구, with no sales.

Read before quoting a number:
  - Only stores inside the 1,650 상권 polygons are counted, not every store in the 구.
  - 한식음식점 (CS100001) is every Korean restaurant; there is no finer 고깃집 code.
  - Sales are a card-company estimate scaled up; a transaction is one payment, usually one party, not one guest.
  - A 상권-업종 with sales but no store row (or the reverse) is dropped so the per-store ratio stays consistent.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd
import requests

REPO = Path(__file__).resolve().parents[1]
RAW = REPO / "data" / "raw" / "seoul_files"
OUT = REPO / "web" / "public" / "mock" / "gu_stats.json"
SERVICES = {"bbq": ("CS100001", "한식음식점"), "cafe": ("CS100010", "커피-음료")}
UA = {"User-Agent": "Mozilla/5.0"}


def download(inf_id: str, pick: str, name: str, refresh: bool) -> Path:
    """The files are only offered through the dataset page's download form (posts to datafile.seoul.go.kr)."""
    out = RAW / name
    if out.exists() and not refresh:
        return out
    RAW.mkdir(parents=True, exist_ok=True)
    kind = "F" if inf_id == "OA-15560" else "S"
    page = requests.get(f"https://data.seoul.go.kr/dataList/{inf_id}/{kind}/1/datasetView.do", headers=UA, timeout=60).text
    items = re.findall(r"downloadFile\('(\d+)'\);\">([^<]+)<", page)
    seq = next((s for s, title in items if pick in title), None) or re.search(r"downloadFile\('(\d+)'\)", page).group(1)
    inf_seq = re.search(r'name="frmFile".*?name="infSeq" value="(\d+)"', page, re.S).group(1)
    r = requests.post("https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false", headers=UA, timeout=300,
                      data={"infId": inf_id, "seqNo": "", "seq": seq, "infSeq": inf_seq})
    if r.content[:2] != b"PK":
        raise RuntimeError(f"{inf_id} download did not return a zip")
    out.write_bytes(r.content)
    return out


def read_csv(path: Path) -> pd.DataFrame:
    z = zipfile.ZipFile(path)
    return pd.read_csv(io.BytesIO(z.read(z.infolist()[0])), encoding="cp949", dtype=str)


def trdar_gu(path: Path) -> dict[str, str]:
    import shapefile
    z = zipfile.ZipFile(path)
    part = {i.filename.rsplit(".", 1)[-1]: io.BytesIO(z.read(i)) for i in z.infolist()}
    r = shapefile.Reader(dbf=part["dbf"], shp=part["shp"], shx=part["shx"], encoding="utf-8")
    f = [x[0] for x in r.fields[1:]]
    return {str(rec[f.index("TRDAR_CD")]): rec[f.index("SIGNGU_CD_")] for rec in r.records()}


PORK_CODES = {"I20107": "pork", "I20108": "beef", "I20109": "tripe"}


def pork_counts() -> dict | None:
    """Stores per 구 by 소분류, from the newest sbiz zip already in data/raw/sbiz (None when it is not there)."""
    zips = sorted((REPO / "data" / "raw" / "sbiz").glob("sbiz_*.zip"))
    if not zips:
        return None
    z = zipfile.ZipFile(zips[-1], metadata_encoding="cp949")
    name = next(n for n in z.namelist() if "서울" in n and n.endswith(".csv"))
    df = pd.read_csv(z.open(name), dtype=str, usecols=["상권업종소분류코드", "시군구명"], encoding="utf-8-sig", keep_default_na=False)
    hansik = df[df["상권업종소분류코드"].str.startswith("I201")].groupby("시군구명").size()
    out = {gu: {"hansik": int(n)} for gu, n in hansik.items()}
    for code, key in PORK_CODES.items():
        for gu, n in df[df["상권업종소분류코드"] == code].groupby("시군구명").size().items():
            out[gu][key] = int(n)
    for v in out.values():
        for key in PORK_CODES.values():
            v.setdefault(key, 0)
    return {"snapshot": zips[-1].stem.split("_")[-1], "source": "소상공인시장진흥공단 상가(상권)정보 data.go.kr 15083033",
            "codes": {"pork": "I20107 돼지고기 구이/찜", "beef": "I20108 소고기 구이/찜", "tripe": "I20109 곱창 전골/구이", "hansik": "I201* 한식 전체"},
            "gu": out}


def build(year: int, refresh: bool = False) -> dict:
    sales = read_csv(download("OA-15572", f"{year}년", f"sales_{year}.zip", refresh))
    stores = read_csv(download("OA-15577", f"{year}년", f"stores_{year}.zip", refresh))
    gu_of = trdar_gu(download("OA-15560", "", "relm.zip", refresh))
    quarters = sorted(sales["기준_년분기_코드"].unique())

    out: dict = {}
    for key, (code, label) in SERVICES.items():
        s = sales[sales["서비스_업종_코드"] == code].copy()
        t = stores[stores["svc_induty_cd"] == code].copy()
        num = lambda df, cols: df[cols].apply(pd.to_numeric, errors="coerce").fillna(0)  # noqa: E731
        dow = [f"{d}요일_매출_금액" for d in "월화수목금토일"]
        scols = ["당월_매출_금액", "당월_매출_건수", "주말_매출_금액", "시간대_17~21_매출_금액", "시간대_21~24_매출_금액", *dow]
        s[scols] = num(s, scols)
        tcols = ["similr_induty_stor_co", "opbiz_stor_co", "clsbiz_stor_co"]
        t[tcols] = num(t, tcols)
        s = s.rename(columns={"기준_년분기_코드": "q", "상권_코드": "trdar"})[["q", "trdar", *scols]]
        t = t.rename(columns={"stdr_yyqu_cd": "q", "trdar_cd": "trdar"})[["q", "trdar", *tcols]]
        m = s.merge(t, on=["q", "trdar"], how="inner")
        m = m[m["similr_induty_stor_co"] > 0]
        m["gu"] = m["trdar"].map(gu_of)
        m = m.dropna(subset=["gu"])

        def summary(g: pd.DataFrame) -> dict:
            stores_avg = g.groupby("q")["similr_induty_stor_co"].sum().mean()   # stores present, averaged over quarters
            amt, cnt = g["당월_매출_금액"].sum(), g["당월_매출_건수"].sum()
            return {
                "trdar": int(g["trdar"].nunique()),
                "stores": round(float(stores_avg)),
                "sales_per_store_month": round(amt / stores_avg / (3 * len(quarters)) / 10000),      # 만원
                "tx_per_store_day": round(cnt / stores_avg / (91.25 * len(quarters)), 1),
                "ticket": round(amt / cnt) if cnt else None,                                         # 원 per payment
                "evening_share": round((g["시간대_17~21_매출_금액"].sum() + g["시간대_21~24_매출_금액"].sum()) / amt, 3),
                "weekend_share": round(g["주말_매출_금액"].sum() / amt, 3),
                "dow_share": [round(float(g[c].sum() / g[dow].sum().sum()), 4) for c in dow],          # 월..일
                "quarter_index": [round(float(g.loc[g["q"] == q, "당월_매출_금액"].sum() / (amt / len(quarters))), 3) for q in quarters],
                "closure_rate": round(g["clsbiz_stor_co"].sum() / stores_avg * (4 / len(quarters)), 3),  # per year
                "opening_rate": round(g["opbiz_stor_co"].sum() / stores_avg * (4 / len(quarters)), 3),
            }

        seoul = summary(m)
        gus = {gu: summary(g) for gu, g in m.groupby("gu")}
        for v in gus.values():
            v["demand_index"] = round(v["sales_per_store_month"] / seoul["sales_per_store_month"], 2)
        out[key] = {"service_code": code, "service_name": label, "seoul": seoul, "gu": gus}

    pork = pork_counts()
    return {
        **({"pork": pork} if pork else {}),
        "_meta": {
            "generated": date.today().isoformat(), "year": year, "quarters": quarters,
            "sources": {"sales": "서울시 상권분석서비스(추정매출-상권) OA-15572", "stores": "서울시 상권분석서비스(점포-상권) OA-15577",
                        "boundary": "서울시 상권분석서비스(영역-상권) OA-15560"},
            "license": "공공누리 1유형", "method": "pipelines/build_gu_stats.py",
            "caveats": ["상권 영역 안의 점포만 집계 (구 전체가 아님)", "한식음식점 전체 기준 (고깃집만의 코드는 없음)",
                        "매출은 카드사 추정치, 결제 1건은 손님 1명이 아니라 보통 한 팀"],
        },
        **out,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2025)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    data = build(a.year, a.refresh)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    b = data["bbq"]
    print(f"wrote {OUT.relative_to(REPO)}: {len(b['gu'])} 구, 서울 {b['seoul']}")
