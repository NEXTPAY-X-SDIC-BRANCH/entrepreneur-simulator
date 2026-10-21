"""전국인테리어업체표준데이터(공공데이터포털 파일)에서 서울 업체만 골라 구별로 정리한다.

    python -m pipelines.build_interior_firms <전국인테리어업체표준데이터.json>

출력: data/processed/seoul_interior_firms.csv, data/processed/seoul_interior_firms_summary.json
주의: 구청마다 제공 여부가 달라 2025~2026 파일에는 서울 25개 구 중 일부(서초·용산·중랑)만 들어 있다.
빠진 구는 업체가 0곳이라는 뜻이 아니므로, 구끼리 업체 수를 비교하는 데 쓰지 않는다. 비용 정보도 없다.
"""
from __future__ import annotations

import csv
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_CSV = ROOT / "data" / "processed" / "seoul_interior_firms.csv"
OUT_SUMMARY = ROOT / "data" / "processed" / "seoul_interior_firms_summary.json"
FIELDS = ["업체명", "시군구명", "소재지도로명주소", "소재지지번주소", "등록일자", "등록번호", "데이터기준일자", "제공기관명"]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("사용법: python -m pipelines.build_interior_firms <전국인테리어업체표준데이터.json>")
    records = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["records"]
    seoul = [r for r in records if r.get("시도명") == "서울특별시"]
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(seoul)
    by_gu = Counter(r["시군구명"] for r in seoul)
    OUT_SUMMARY.write_text(json.dumps({
        "_meta": {"source": "공공데이터포털 전국인테리어업체표준데이터", "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "national_records": len(records),
                  "note": "제공한 구청의 업체만 들어 있다. 목록에 없는 구는 업체 0곳이 아니라 데이터 미제공"},
        "seoul_total": len(seoul), "by_gu": dict(by_gu.most_common()),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"서울 {len(seoul)}곳: {dict(by_gu.most_common())}")


if __name__ == "__main__":
    main()
