"""새 업종의 서울 행정동(동네)별 요약 -> web/public/mock/industry_<id>_dong.json.  (lab:industry)

    SEOUL_OPEN_DATA_KEY=... python -m pipelines.build_industry_dong [--year 2025] [--offline]

키: SEOUL_OPEN_DATA_KEY (서울 열린데이터광장, 무료). 키는 출력하지 않는다. 받은 행은 data/raw/seoul_dong/에 캐시하고
--offline이면 캐시만 읽는다(키 없이 다시 만들 수 있다).
입력
  서울시 상권분석서비스 추정매출-행정동 VwsmAdstrdSelngW: 분기별 업종 매출, 요일·시간대·연령 매출
  서울시 상권분석서비스 점포-행정동 VwsmAdstrdStorW: 분기별 업종 점포 수, 개업·폐업 점포 수
  소상공인 상가(상권)정보 zip (data/raw/sbiz): 동 안 업종 점포 수 (registry.py sbiz 소분류)
출력은 dong_stats.json(pipelines/build_dong_stats.py)과 같은 모양이라 화면(model.ts guStat, setDongData)이 그대로 읽는다.
  stores, pork  상가정보의 그 업종 점포 수 (pork 칸은 화면이 '업종 가게 수'로 읽는 자리)
  rel           구 안의 상대 위치: 동의 점포당 매출 ÷ 구 전체 점포당 매출 (상권분석서비스 점포 수로 나눔). 점포 10곳 미만이면 없음
  open_rate, close_rate  연 개업률·폐업률 (상권분석서비스 점포-행정동, 4분기 합)
읽기 전에
  - 매출은 카드사 추정치라 금액이 아니라 구 안의 상대 위치로만 쓴다.
  - 한식 백반집은 한식음식점(CS100001) 전체 매출 기준이고, 점포 수만 백반·찌개 소분류로 센다.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd
import requests

from sim.generic.registry import INDUSTRIES

from .build_dong_stats import AGES, BANDS, CODE_GU, DOW, GU_CODE, classify

REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / "data" / "raw" / "seoul_dong"
MOCK = REPO / "web" / "public" / "mock"
URL = "http://openapi.seoul.go.kr:8088/{k}/json/{api}/{a}/{b}/{q}"
CODES = {spec["service"] for spec in INDUSTRIES.values()}


def _get(k: str, api: str, a: int, b: int, q: str) -> dict:
    last = ""
    for attempt in range(4):
        try:
            r = requests.get(URL.format(k=k, api=api, a=a, b=b, q=q), timeout=90)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError) as e:
            last = type(e).__name__
        time.sleep(2 + attempt * 2)
    raise SystemExit(f"{api} {q} 요청 실패: {last}")


def rows(api: str, q: str, offline: bool) -> list[dict]:
    path = CACHE / f"{api}_{q}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise SystemExit(f"캐시 없음: {path.name} (--offline 없이 키를 넣고 다시 실행)")
    k = os.environ.get("SEOUL_OPEN_DATA_KEY")
    if not k:
        raise SystemExit("SEOUL_OPEN_DATA_KEY가 없습니다")
    out, a = [], 1
    while True:
        d = _get(k, api, a, a + 999, q).get(api)
        if not d:
            break
        out += [r for r in d["row"] if r["SVC_INDUTY_CD"] in CODES]
        if a + 999 >= d["list_total_count"]:
            break
        a += 1000
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def sbiz_dong() -> pd.DataFrame:
    zips = sorted((REPO / "data" / "raw" / "sbiz").glob("sbiz_*.zip"))
    z = zipfile.ZipFile(zips[-1], metadata_encoding="cp949")
    name = next(n for n in z.namelist() if "서울" in n and n.endswith(".csv"))
    return pd.read_csv(z.open(name), dtype=str, usecols=["상권업종소분류코드", "행정동코드"], encoding="utf-8-sig", keep_default_na=False)


def build(year: int, offline: bool) -> dict[str, dict]:
    qs = [f"{year}{i}" for i in (1, 2, 3, 4)]
    sales = {q: rows("VwsmAdstrdSelngW", q, offline) for q in qs}
    stor = {q: rows("VwsmAdstrdStorW", q, offline) for q in qs}
    sb = sbiz_dong()
    docs = {}
    for ind, spec in INDUSTRIES.items():
        code = spec["service"]
        cnt = sb[sb["상권업종소분류코드"].isin(spec["sbiz"])].groupby("행정동코드").size().to_dict()
        dong: dict[str, dict] = {}
        for qi, q in enumerate(qs):
            for r in sales[q]:
                if r["SVC_INDUTY_CD"] != code:
                    continue
                d = dong.setdefault(r["ADSTRD_CD"], {"name": r["ADSTRD_CD_NM"], "q": [0.0] * 4, "dow": [0.0] * 7, "band": [0.0] * 6,
                                                      "age": [0.0] * 6, "n": [0.0] * 4, "open": 0.0, "close": 0.0})
                d["q"][qi] += float(r["THSMON_SELNG_AMT"] or 0)
                for i, x in enumerate(DOW):
                    d["dow"][i] += float(r[f"{x}_SELNG_AMT"] or 0)
                for i, x in enumerate(BANDS):
                    d["band"][i] += float(r[f"TMZON_{x}_SELNG_AMT"] or 0)
                for i, x in enumerate(AGES):
                    d["age"][i] += float(r[f"AGRDE_{x}_SELNG_AMT"] or 0)
            for r in stor[q]:
                if r["SVC_INDUTY_CD"] != code or r["ADSTRD_CD"] not in dong:
                    continue
                d = dong[r["ADSTRD_CD"]]
                d["n"][qi] += float(r["SIMILR_INDUTY_STOR_CO"] or 0)
                d["open"] += float(r["OPBIZ_STOR_CO"] or 0)
                d["close"] += float(r["CLSBIZ_STOR_CO"] or 0)
        out: dict[str, list[dict]] = {g: [] for g in GU_CODE}
        for c, d in dong.items():
            gu = CODE_GU.get(c[:5])
            tot = sum(d["q"])
            if not gu or tot <= 0:
                continue
            n_avg = sum(d["n"]) / 4
            ds, bs, as_ = sum(d["dow"]), sum(d["band"]), sum(d["age"])
            sh = {"weekend": (d["dow"][5] + d["dow"][6]) / ds if ds else 0.0, "lunch": d["band"][2] / bs if bs else 0.0,
                  "evening": (d["band"][4] + d["band"][5]) / bs if bs else 0.0, "age20": d["age"][1] / as_ if as_ else 0.0,
                  "age30": d["age"][2] / as_ if as_ else 0.0}
            month = tot / 12 / 1e4
            out[gu].append({
                "code": c, "name": d["name"], "stores": int(cnt.get(c, 0)), "pork": int(cnt.get(c, 0)), "sales_month": round(month),
                "n_trdar_stores": round(n_avg, 1), "raw_per_store": round(month / n_avg, 1) if n_avg else None,
                "dow": [round(x / ds, 4) for x in d["dow"]] if ds else [round(1 / 7, 4)] * 7,
                "qidx": [round(x / (tot / 4), 3) for x in d["q"]],
                "shares": {k2: round(v, 3) for k2, v in sh.items()}, "type": classify(sh),
                "open_rate": round(d["open"] / n_avg, 3) if n_avg >= 10 else None,
                "close_rate": round(d["close"] / n_avg, 3) if n_avg >= 10 else None,
            })
        for gu, lst in out.items():
            s = sum(x["sales_month"] for x in lst)
            n = sum(x["n_trdar_stores"] for x in lst)
            base = s / n if n else None
            for x in lst:
                x["rel"] = round(x["raw_per_store"] / base, 3) if base and x["raw_per_store"] and x["n_trdar_stores"] >= 10 else None
            lst.sort(key=lambda x: -x["stores"])
        docs[ind] = {"_meta": {"generated": date.today().isoformat(), "year": year, "method": "pipelines/build_industry_dong.py",
                               "industry": ind, "service": f"{spec['base']} {code}",
                               "sources": {"sales": f"서울시 상권분석서비스 추정매출-행정동 (VwsmAdstrdSelngW, {code})",
                                           "stores": f"서울시 상권분석서비스 점포-행정동 (VwsmAdstrdStorW, {code}), 소상공인 상가정보 ({spec['sbiz_label']})"},
                               "caveats": ["매출은 카드사 추정치라 동 사이 상대 위치(rel)로만 쓴다", "rel, 개업률, 폐업률은 상권분석 점포 10곳 미만인 동에는 없다",
                                           "유형은 매출 비중으로 나눈 규칙 분류이며 현장 조사가 아니다"]},
                     "gu": out}
    return docs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2025)
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    for ind, doc in build(a.year, a.offline).items():
        p = MOCK / f"industry_{ind}_dong.json"
        p.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        n = sum(len(v) for v in doc["gu"].values())
        print(f"{p.name}: 행정동 {n}개 ({p.stat().st_size // 1024} KB)")
