"""KOSIS 기업생멸행정통계에서 신생기업 1~5년 생존율을 받는다 (성적표의 '생존' 기준값).

    python -m pipelines.fetch_kosis_survival [--from 2019]

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/survival_kosis.json
표 (통계청, orgId 101):
  DT_6BD1109 시도별 산업대분류별 신생기업 생존율: 전국·서울 x 전체·숙박 및 음식점업
  DT_2BD1104 대표자 성·연령별 신생기업 생존율: 성별 계 x 연령대 (전 업종, 업종별 연령표는 없다)
산업은 대분류까지만 있어 고깃집·카페가 따로 나오지 않는다. 더 좁은 업종은 data/processed/survival_wide.json (인허가 기반)을 쓴다.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "survival_kosis.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
ITEMS = {"T01": 1, "T02": 2, "T03": 3, "T04": 4, "T05": 5}  # n년 생존율 (%)
AGES = {"1": "20대", "2": "30대", "3": "40대", "4": "50대", "5": "60대 이상"}  # 30대 미만은 20대로 본다. 60대 이상은 60대 값


def fetch(api_key: str, tbl: str, start: str, end: str, **objs: str) -> list[dict]:
    q = urllib.parse.urlencode({"method": "getList", "apiKey": api_key, "format": "json", "jsonVD": "Y", "orgId": "101",
                                "tblId": tbl, "itmId": "+".join(ITEMS) + "+", "prdSe": "Y",
                                "startPrdDe": start, "endPrdDe": end, **objs})
    try:
        with urllib.request.urlopen(f"{URL}?{q}", timeout=180) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"KOSIS {tbl}: {e}")) from None
    if not isinstance(data, list):
        raise RuntimeError(f"KOSIS {tbl}: {data.get('errMsg', data)}")
    return data


def put(out: dict, name: str, row: dict) -> None:
    out.setdefault(name, {}).setdefault(row["PRD_DE"], {})[ITEMS[row["ITM_ID"]]] = float(row["DT"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2019")
    args = ap.parse_args()
    api_key = key("KOSIS_API_KEY", fallback=None)
    end = str(int(time.strftime("%Y")) - 1)  # 서버가 없는 해는 그냥 빼고 준다
    region: dict = {}
    for row in fetch(api_key, "DT_6BD1109", args.start, end, objL1="00+11+", objL2="0+I+"):
        place = "seoul" if row["C1"] == "11" else "korea"
        put(region, f"{place}_{'food' if row['C2'] == 'I' else 'all'}", row)
    time.sleep(0.5)
    age: dict = {}
    for row in fetch(api_key, "DT_2BD1104", args.start, end, objL1="0", objL2="+".join(AGES) + "+"):
        put(age, AGES[row["C2"]], row)
    latest = max(region["seoul_food"])
    OUT.write_text(json.dumps({
        "_meta": {"source": "통계청 기업생멸행정통계 (KOSIS DT_6BD1109, DT_2BD1104)", "unit": "n년 생존율 %",
                  "latest": latest, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "note": "산업은 대분류(숙박 및 음식점업)까지. 연령별 값은 전 업종. 해는 기준 연도(그해에 n년째 살아남은 비율)"},
        "region": region, "age": age,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{latest}년 서울 숙박·음식점업:", region["seoul_food"][latest])
    print(f"{latest}년 연령별 3년 생존율:", {k: v[latest].get(3) for k, v in age.items()})


if __name__ == "__main__":
    main()
