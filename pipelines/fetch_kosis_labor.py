"""KOSIS 고용노동부 통계에서 음식점 알바의 월 자발적 이직률과 음식점업 임금을 받는다.

    python -m pipelines.fetch_kosis_labor

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/kosis_labor.json
표 (고용노동부, orgId 118):
  DT_118N_MON066 사업체노동력조사 산업/규모별 고용 (월): 음식점 및 주점업(I56) x 30인미만
    자발적 이직률 = 자발적 이직자_임시일용 ÷ 근로자_임시일용. 알바가 스스로 그만두는 비율로 본다.
    이직률_임시일용(약 20%)은 계약 만료와 일용직 교체가 섞여 있어 쓰지 않는다.
  DT_118N_LCE305 고용형태별근로실태조사 산업별 임금 및 근로시간 (연, 6월 기준): 숙박 및 음식점업(I) x 정규·비정규
    산업은 대분류까지만 있어 음식점업만 따로 나오지 않는다.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "kosis_labor.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"

TURNOVER = {"16118MF_3": "workers", "16118MF_22": "voluntary", "16118MF_19": "separations"}  # 임시일용 근로자·자발적·전체 이직자
WAGE = {"13103732814DD_5": "monthly_pay_k", "16118DD_10": "monthly_total_k", "16118DD_11": "hourly_total",
        "13103732814DD_2": "hours"}  # 월급여액(천원), 월임금총액(천원), 시간당임금총액(원), 총근로시간
TYPES = {"13102732818TYPES.00": "all", "13102732818TYPES.02": "regular", "13102732818TYPES.03": "nonregular"}


def fetch(api_key: str, tbl: str, items: dict, prd: str, start: str, end: str, **objs: str) -> list[dict]:
    q = urllib.parse.urlencode({"method": "getList", "apiKey": api_key, "format": "json", "jsonVD": "Y", "orgId": "118",
                                "tblId": tbl, "itmId": "+".join(items) + "+", "prdSe": prd,
                                "startPrdDe": start, "endPrdDe": end, **objs})
    try:
        with urllib.request.urlopen(f"{URL}?{q}", timeout=180) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"KOSIS {tbl}: {e}")) from None
    if not isinstance(data, list):
        raise RuntimeError(f"KOSIS {tbl}: {data.get('errMsg', data)}")
    return data


def main() -> None:
    api_key = key("KOSIS_API_KEY", fallback=None)
    year = int(time.strftime("%Y"))

    months: dict = {}
    for row in fetch(api_key, "DT_118N_MON066", TURNOVER, "M", f"{year - 2}01", f"{year}12",
                     objL1="260225INDUSTRY_11SI56", objL2="191127SIZES.01"):
        months.setdefault(row["PRD_DE"], {})[TURNOVER[row["ITM_ID"]]] = float(row["DT"])
    months = {m: v for m, v in sorted(months.items()) if len(v) == len(TURNOVER)}
    for v in months.values():
        v["voluntary_rate"] = round(v["voluntary"] / v["workers"], 4)
    last12 = list(months)[-12:]
    rates = [months[m]["voluntary_rate"] for m in last12]
    time.sleep(0.5)

    wage: dict = {}
    for row in fetch(api_key, "DT_118N_LCE305", WAGE, "Y", str(year - 4), str(year),
                     objL1="+".join(TYPES) + "+", objL2="190326INDUSTRY_10SI"):  # 이 표는 고용형태가 첫 분류
        wage.setdefault(TYPES[row["C1"]], {}).setdefault(row["PRD_DE"], {})[WAGE[row["ITM_ID"]]] = float(row["DT"])
    wage_latest = max(wage["regular"])

    OUT.write_text(json.dumps({
        "_meta": {"source": "고용노동부 사업체노동력조사 (KOSIS DT_118N_MON066), 고용형태별근로실태조사 (KOSIS DT_118N_LCE305)",
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "note": "이직: 음식점 및 주점업, 30인미만, 임시일용. 자발적 이직률 = 자발적 이직자 ÷ 근로자. "
                          "임금: 숙박 및 음식점업 대분류, 매년 6월 기준, 천원 단위는 _k"},
        "turnover": {"window": [last12[0], last12[-1]], "voluntary_rate_mean": round(sum(rates) / len(rates), 4),
                     "voluntary_rate_min": min(rates), "voluntary_rate_max": max(rates), "months": months},
        "wage": {"latest": wage_latest, "by_type": wage},
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"자발적 이직률 {last12[0]}~{last12[-1]}: 평균 {sum(rates) / len(rates):.4f} (최소 {min(rates)}, 최대 {max(rates)})")
    print(f"{wage_latest} 정규근로자 월급여액: {wage['regular'][wage_latest]['monthly_pay_k']:.0f}천원")


if __name__ == "__main__":
    main()
