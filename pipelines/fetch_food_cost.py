"""식재료 원가 지수: 닭고기·돼지고기·달걀·우유·쌀·식용유·떡·어묵·커피의 달별 흐름과 지금 가격 수준.

    python -m pipelines.fetch_food_cost

키: KOSIS_API_KEY (생활물가지수), KAMIS_API_KEY·KAMIS_CERT_ID (서울 소매가). 키는 출력하지 않는다.
출력: web/public/mock/food_cost.json
자료
  - KOSIS 생활물가지수 품목별 (DT_1J22005, 전국, 2020=100), 2021.01~최신 월. 몇 년치 흐름을 본다.
  - KAMIS 기간별 품목별 가격 (periodProductList, 서울 소매가, 최근 1년 일자료 → 월평균). 지금 가격(원)을 본다.
    KAMIS 기간 조회는 오늘부터 1년 전까지만 준다 (시작일을 더 앞으로 넣으면 1년 전으로 잘린다).
계산 (품목마다)
  - month_index[m]: 그해 평균 = 1로 놓은 m월 값, 2021~2025 완결 연도 평균. 달마다 원가가 얼마나 출렁이는지
  - level_vs_2024: 최근 12개월 평균 ÷ 2024년 평균. 외식업체 경영실태조사(2024년 실적)로 맞춘 식재료비율이 지금 얼마나 올랐는지
  - yoy: 최신 달 ÷ 1년 전 같은 달 − 1
읽기 전에: 소비자 물가(소매)라 가게가 실제로 사는 도매가보다 덜 출렁인다.
"""
from __future__ import annotations

import json
import statistics as st
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import requests

from .keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "food_cost.json"
KOSIS = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
KAMIS = "https://www.kamis.or.kr/service/price/xml.do"
# 생활물가지수 품목 코드 (DT_1J22005 C2)
CPI = {"pork": ("돼지고기", "110A01203"), "chicken": ("닭고기", "110A01204"), "egg": ("달걀", "110A01405"), "milk": ("우유", "110A01401"),
       "rice": ("쌀", "110A01101"), "oil": ("식용유", "110A01502"), "tteok": ("떡", "110A01117"), "fishcake": ("어묵", "110A01316"),
       "coffee": ("커피", "110A02101"), "tteokbokki_out": ("떡볶이(외식)", "110K01128"), "coffee_out": ("커피(외식)", "110K01133")}
# KAMIS 서울 소매가 (부류, 품목, 품종, 등급, 단위)
KAMIS_ITEMS = {"pork": ("500", "4304", "27", "", "삼겹살 100g"), "chicken": ("500", "9901", "99", "", "육계 1kg"),
               "egg": ("500", "9903", "23", "", "특란 30구"), "milk": ("500", "9908", "01", "", "흰우유 1L"),
               "rice": ("100", "111", "01", "", "쌀 20kg")}


def kosis(k: str) -> dict[str, dict[str, float]]:
    p = {"method": "getList", "apiKey": k, "format": "json", "jsonVD": "Y", "orgId": "101", "tblId": "DT_1J22005", "itmId": "ALL",
         "objL1": "T10", "objL2": "+".join(c for _, c in CPI.values()) + "+", "prdSe": "M", "startPrdDe": "202101",
         "endPrdDe": date.today().strftime("%Y%m")}
    with urllib.request.urlopen(f"{KOSIS}?{urllib.parse.urlencode(p)}", timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
    if not isinstance(d, list):
        raise SystemExit(f"KOSIS 오류: {mask(str(d))[:200]}")
    code2key = {c: kk for kk, (_, c) in CPI.items()}
    out: dict[str, dict[str, float]] = {}
    for row in d:
        kk = code2key.get(row.get("C2"))
        if kk:
            out.setdefault(kk, {})[row["PRD_DE"]] = float(row["DT"])
    return out


def kamis(k: str, cid: str, cat: str, item: str, kind: str, rank: str) -> dict[str, float]:
    """최근 1년 서울 소매가 일자료 → 월평균 (원)."""
    end = date.today() - timedelta(days=1)
    p = {"action": "periodProductList", "p_productclscode": "01", "p_startday": (end - timedelta(days=364)).isoformat(), "p_endday": end.isoformat(),
         "p_itemcategorycode": cat, "p_itemcode": item, "p_kindcode": kind, "p_productrankcode": rank, "p_countrycode": "1101",
         "p_convert_kg_yn": "N", "p_cert_key": k, "p_cert_id": cid, "p_returntype": "json"}
    r = requests.get(KAMIS, params=p, timeout=120)
    r.raise_for_status()
    data = r.json().get("data")
    rows = data.get("item") if isinstance(data, dict) else []
    by: dict[str, list[float]] = {}
    for x in rows or []:
        if x.get("countyname") != "서울":
            continue
        s = str(x.get("price", "")).replace(",", "").strip()
        if not s or s == "-" or float(s) <= 0:
            continue
        mm = x["regday"].split("/")[0]
        by.setdefault(f"{x['yyyy']}{mm}", []).append(float(s))
    return {m: round(st.mean(v)) for m, v in sorted(by.items())}


def summarize(s: dict[str, float]) -> dict:
    years = sorted({k[:4] for k in s})
    full = [y for y in years if all(f"{y}{m:02d}" in s for m in range(1, 13)) and y <= "2025"]
    mi = {m: st.mean(s[f"{y}{m:02d}"] / st.mean(s[f"{y}{n:02d}"] for n in range(1, 13)) for y in full) for m in range(1, 13)}
    keys = sorted(s)
    last12 = [s[k] for k in keys[-12:]]
    y2024 = [s[f"2024{m:02d}"] for m in range(1, 13) if f"2024{m:02d}" in s]
    latest = keys[-1]
    prev = f"{int(latest[:4]) - 1}{latest[4:]}"
    return {"latest_month": latest, "years": full,
            "month_index": {str(m): round(v, 3) for m, v in mi.items()},
            "swing": round(max(mi.values()) - min(mi.values()), 3),
            "level_vs_2024": round(st.mean(last12) / st.mean(y2024), 3) if y2024 else None,
            "yoy": round(s[latest] / s[prev] - 1, 3) if prev in s else None}


def main() -> None:
    kk = key("KOSIS_API_KEY", fallback=None)
    series = kosis(kk)
    out: dict = {"_meta": {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "method": "pipelines/fetch_food_cost.py",
                           "cpi_source": "KOSIS 생활물가지수 품목별 (DT_1J22005, 전국, 2020=100)",
                           "kamis_source": "KAMIS 기간별 품목별 소매가격 (서울, 최근 1년 → 월평균)",
                           "note": "month_index: 그해 평균=1, 2021~2025 평균. level_vs_2024: 최근 12개월 평균 ÷ 2024년 평균"},
                 "items": {}}
    for name, (label, _) in CPI.items():
        if name in series:
            out["items"][name] = {"label": label, **summarize(series[name]), "cpi": series[name]}
    try:
        k, cid = key("KAMIS_API_KEY", fallback=None), key("KAMIS_CERT_ID", fallback=None)
        for name, (cat, item, kind, rank, unit) in KAMIS_ITEMS.items():
            m = kamis(k, cid, cat, item, kind, rank)
            if m and name in out["items"]:
                out["items"][name]["kamis"] = {"unit": unit, "monthly_krw": m, "latest_krw": m[max(m)]}
            time.sleep(0.3)
    except SystemExit as e:
        print("KAMIS 건너뜀:", e)
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    for name, v in out["items"].items():
        km = v.get("kamis", {})
        print(f"{v['label']:10s} 변동폭 {v['swing']:.3f} 2024대비 {v['level_vs_2024']} 전년비 {v['yoy']} 최고달 {max(v['month_index'], key=v['month_index'].get)}월"
              + (f" | KAMIS {km['unit']} {km['latest_krw']:,}원" if km else ""))


if __name__ == "__main__":
    main()
