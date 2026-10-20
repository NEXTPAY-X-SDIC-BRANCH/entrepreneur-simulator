"""KOSIS 생활물가지수(DT_1J22005)에서 돼지고기·삼겹살(외식) 월별 지수를 받는다.

    KOSIS_API_KEY=... python -m pipelines.fetch_kosis_pork

출력: web/public/mock/kosis_pork.json
KOSIS는 한 번 응답에 40,000셀 이하만 주므로 연도별로 나눠 받는다.
키는 출력하지 않는다.
"""
from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "kosis_pork.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
ITEMS = ("돼지고기", "삼겹살(외식)")
REGIONS = ("전국", "서울특별시", "강원특별자치도")


def fetch_year(key: str, year: int) -> list[dict]:
    params = {
        "method": "getList", "apiKey": key, "format": "json", "jsonVD": "Y",
        "orgId": "101", "tblId": "DT_1J22005", "itmId": "ALL", "objL1": "ALL", "objL2": "ALL",
        "prdSe": "M", "startPrdDe": f"{year}01", "endPrdDe": f"{year}12",
    }
    with urllib.request.urlopen(URL + "?" + urllib.parse.urlencode(params), timeout=180) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not isinstance(data, list):
        raise RuntimeError(f"KOSIS {year}: {data.get('errMsg', 'unknown error')}")
    return data


def main() -> None:
    key = os.environ.get("KOSIS_API_KEY", "")
    if not key:
        raise SystemExit("KOSIS_API_KEY 환경변수가 없습니다.")
    series: dict[str, dict[str, float]] = {}
    for year in range(2021, 2027):
        for row in fetch_year(key, year):
            if row.get("C2_NM") in ITEMS and row.get("C1_NM") in REGIONS:
                series.setdefault(f"{row['C2_NM']}|{row['C1_NM']}", {})[row["PRD_DE"]] = float(row["DT"])
        time.sleep(0.5)
    OUT.write_text(json.dumps({
        "_meta": {"source": "KOSIS 생활물가지수 (DT_1J22005, 2020=100)", "period": "2021.01~최신",
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
        "series": {k: dict(sorted(v.items())) for k, v in series.items()},
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("series:", {k: len(v) for k, v in series.items()})


if __name__ == "__main__":
    main()
