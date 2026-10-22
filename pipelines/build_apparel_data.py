"""옷가게(일반의류) 시뮬레이터용 KOSIS 자료: 서울 의복 소매업의 매출 규모별 비용 구조와 서울 도소매업 생존율.

    python -m pipelines.build_apparel_data

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/apparel_kosis.json
표 (통계청, orgId 101):
  DT_3KB9003 도소매업조사 시도/산업/매출액규모별 현황: 서울(11) x 의복 소매업(4741) x 매출액 규모, 2024년
  DT_6BD1109 기업생멸행정통계 시도별 산업대분류별 신생기업 생존율: 서울 x 도매 및 소매업(G)
서울 구별 점포 수·점포당 매출·분기 지수·개폐업률은 pipelines.build_gu_stats 의 apparel 블록(서울시 상권분석서비스 CS300011)에 있다.
KOSIS 연결이 자주 끊겨 요청마다 몇 번 다시 시도한다.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from pipelines.keys import key

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "apparel_kosis.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
ITEMS = {"사업체수": "stores", "종사자수": "workers", "매출액": "sales", "매출원가": "cogs", "인건비": "labor",
         "임차료": "rent", "기타경비": "other", "영업이익": "op"}


def get(api_key: str, tbl: str, **kw) -> list[dict]:
    q = {"method": "getList", "apiKey": api_key, "format": "json", "jsonVD": "Y", "orgId": "101", "tblId": tbl, "prdSe": "Y", **kw}
    for _ in range(8):
        try:
            d = requests.get(URL, params=q, timeout=120).json()
        except (requests.RequestException, ValueError):
            time.sleep(3)
            continue
        if isinstance(d, list):
            return d
        raise RuntimeError(f"KOSIS {tbl}: {d.get('errMsg', d)}")
    raise RuntimeError(f"KOSIS {tbl}: 연결 실패")


def main() -> None:
    k = key("KOSIS_API_KEY", fallback=None)
    rows = get(k, "DT_3KB9003", itmId="ALL", objL1="11", objL2="4741", objL3="ALL", startPrdDe="2024", endPrdDe="2024")
    bands: dict[str, dict] = {}
    for r in rows:
        if r["ITM_NM"] in ITEMS and r["DT"] not in ("-", "", "x", "X"):
            bands.setdefault(r["C3_NM"], {})[ITEMS[r["ITM_NM"]]] = float(r["DT"])  # 백만원, 개, 명
    out_bands = []
    for name, v in bands.items():
        s, n = v.get("sales"), v.get("stores")
        if not s or not n:
            continue
        out_bands.append({"band": name, "stores": int(n), "workers_per_store": round(v["workers"] / n, 2),
                          "sales_per_store_month_man": round(s / n * 100 / 12),
                          **{f"{x}_ratio": round(v[x] / s, 4) for x in ("cogs", "labor", "rent", "other", "op") if x in v}})
    time.sleep(1)
    surv = get(k, "DT_6BD1109", itmId="T01+T02+T03+T05+", objL1="11", objL2="G+", startPrdDe="2023", endPrdDe="2023")
    survival = {r["ITM_NM"]: float(r["DT"]) for r in surv}
    OUT.write_text(json.dumps({
        "_meta": {"source": "통계청 도소매업조사 DT_3KB9003 (서울, 의복 소매업 4741, 2024년) / 기업생멸행정통계 DT_6BD1109 (서울 도매 및 소매업, 2023년)",
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "note": "비율은 매출 대비. 시뮬레이터는 서울 상권분석 점포당 매출(연 1억~5억)에 맞는 '100~500 백만원 미만' 구간을 쓴다"},
        "bands": out_bands, "survival_seoul_retail_2023": survival,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(out_bands), "bands;", survival)


if __name__ == "__main__":
    main()
