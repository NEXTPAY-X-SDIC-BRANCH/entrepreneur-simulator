"""한국은행 ECOS에서 기준금리와 예금은행 신규 대출금리(중소기업·기업·전체)를 월별로 받는다.

    python -m pipelines.fetch_ecos [--from 2021-01]

키: ECOS_API_KEY (ecos.bok.or.kr 에서 발급). 키는 출력하지 않는다.
출력: web/public/mock/ecos_rates.json
쓰는 곳: 변동금리 정책자금의 이자 계산, 대출 화면의 "지금 은행 평균 금리" 참고값.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "ecos_rates.json"
URL = "https://ecos.bok.or.kr/api/StatisticSearch/{key}/json/kr/1/{rows}/{table}/M/{start}/{end}/{item}"

# (이름, 통계표, 항목, 설명). 항목 코드는 StatisticItemList 로 확인 (2026-10-20).
SERIES = [
    ("base_rate", "722Y001", "0101000", "한국은행 기준금리 (월말)"),
    ("loan_sme", "121Y006", "BECBLA0202", "예금은행 신규취급액 대출금리: 중소기업대출"),
    ("loan_corp", "121Y006", "BECBLA02", "예금은행 신규취급액 대출금리: 기업대출"),
    ("loan_avg", "121Y006", "BECBLA01", "예금은행 신규취급액 대출금리: 대출평균"),
]


def fetch(api_key: str, table: str, item: str, start: str, end: str) -> dict[str, float]:
    rows = 10 if api_key == "sample" else 1000  # 공개 샘플 키는 10건까지만 준다 (시험용)
    url = URL.format(key=api_key, rows=rows, table=table, item=item, start=start, end=end)
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"ECOS {table}/{item}: {e}")) from None
    if "StatisticSearch" not in data:
        res = data.get("RESULT", {})
        raise RuntimeError(f"ECOS {table}/{item}: {res.get('CODE')} {res.get('MESSAGE')}")
    return {row["TIME"]: float(row["DATA_VALUE"]) for row in data["StatisticSearch"]["row"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2021-01", help="YYYY-MM")
    args = ap.parse_args()
    api_key = key("ECOS_API_KEY", fallback=None)
    start, end = args.start.replace("-", ""), time.strftime("%Y%m")
    series, labels = {}, {}
    for name, table, item, label in SERIES:
        series[name] = fetch(api_key, table, item, start, end)
        labels[name] = f"{label} [{table}/{item}]"
        time.sleep(0.3)
    latest = {name: max(s.items()) if s else None for name, s in series.items()}
    OUT.write_text(json.dumps({
        "_meta": {"source": "한국은행 경제통계시스템(ECOS)", "unit": "연 %", "series": labels,
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
        "latest": {k: {"month": v[0], "rate": v[1]} for k, v in latest.items() if v},
        "series": series,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for k, v in latest.items():
        print(k, v)


if __name__ == "__main__":
    main()
