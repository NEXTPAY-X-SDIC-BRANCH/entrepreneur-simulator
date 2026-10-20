"""KOSIS 온라인쇼핑동향에서 음식서비스(배달 앱·주문 중개) 월별 거래액을 받아 배달 시장 흐름과 달별 배율을 만든다.

    python -m pipelines.fetch_kosis_delivery [--from 2019-01]

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/delivery_market.json
표: DT_1KE10071 온라인쇼핑몰 판매매체별/상품군별 거래액 (통계청, 백만원), 상품군 021 음식서비스.
  - yoy: 1년 전 같은 달보다 몇 % 늘었나
  - month_index: 최근 3개 완결 연도에서 달마다 (그달 거래액 ÷ 그해 월평균)의 평균. 1보다 크면 배달이 많은 달.
전국 값이라 서울만의 흐름은 아니다. 가게 한 곳의 배달 주문 수가 아니라 시장 전체 크기다.
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
OUT = ROOT / "web" / "public" / "mock" / "delivery_market.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"


def fetch(api_key: str, start: str, end: str) -> list[dict]:
    q = urllib.parse.urlencode({"method": "getList", "apiKey": api_key, "format": "json", "jsonVD": "Y", "orgId": "101",
                                "tblId": "DT_1KE10071", "itmId": "T20", "objL1": "021", "objL2": "ALL", "prdSe": "M",
                                "startPrdDe": start, "endPrdDe": end})
    try:
        with urllib.request.urlopen(f"{URL}?{q}", timeout=180) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"KOSIS DT_1KE10071: {e}")) from None
    if not isinstance(data, list):
        raise RuntimeError(f"KOSIS DT_1KE10071: {data.get('errMsg', data)}")
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2019-01", help="YYYY-MM")
    args = ap.parse_args()
    api_key = key("KOSIS_API_KEY", fallback=None)
    rows = fetch(api_key, args.start.replace("-", ""), time.strftime("%Y%m"))
    media: dict[str, dict[str, float]] = {}  # 판매매체(계·인터넷·모바일) → 월 → 억원
    names: dict[str, str] = {}
    for r in rows:
        names[r["C2"]] = r["C2_NM"]
        media.setdefault(r["C2"], {})[r["PRD_DE"]] = round(float(r["DT"]) / 100, 1)  # 백만원 → 억원
    total = dict(sorted(media["00"].items()))
    yoy = {m: round((v / total[f"{int(m[:4]) - 1}{m[4:]}"] - 1) * 100, 1)
           for m, v in total.items() if f"{int(m[:4]) - 1}{m[4:]}" in total}
    full = sorted({m[:4] for m in total if sum(k[:4] == m[:4] for k in total) == 12})[-3:]
    month_index = {}
    for mm in range(1, 13):
        ratios = []
        for y in full:
            avg = sum(total[f"{y}{i:02d}"] for i in range(1, 13)) / 12
            ratios.append(total[f"{y}{mm:02d}"] / avg)
        month_index[mm] = round(sum(ratios) / len(ratios), 3)
    latest = max(total)
    mobile = next((c for c, n in names.items() if "모바일" in n), None)
    OUT.write_text(json.dumps({
        "_meta": {"source": "통계청 온라인쇼핑동향 (KOSIS DT_1KE10071, 상품군 음식서비스)", "unit": "억원 (월 거래액, 전국)",
                  "latest": latest, "index_years": full, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "note": "배달앱 등 온라인으로 주문한 음식 거래액. 가게 한 곳의 주문 수가 아니다"},
        "latest": {"month": latest, "amount": total[latest], "yoy": yoy.get(latest),
                   "mobile_share": round(media[mobile][latest] / total[latest] * 100, 1) if mobile else None},
        "month_index": month_index,
        "total": total, "yoy": yoy,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{latest}: {total[latest]:,}억원, 1년 전보다 {yoy.get(latest)}%")
    print("달별 배율:", month_index)


if __name__ == "__main__":
    main()
