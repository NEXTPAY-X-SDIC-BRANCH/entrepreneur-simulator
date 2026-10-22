"""소상공인365 SNS 분석 (오픈API 키 SBIZ365_SNS_KEY로 여는 화면이 쓰는 자료) -> web/public/mock/sbiz_sns.json

SNS 분석 화면은 /gis/api/snsAnls/getSnsAnlsDetail?keyword=&startDate=&endDate=&topN= 으로 키워드의 SNS 언급 수(frequency)와
연관어(childList: label, frequency)를 받는다. 업종 키워드마다 최근 12개월을 달 단위로 나눠 언급 수를 받고(달별 관심도),
12개월 전체로 연관어 20개를 받는다. 1초에 한 번만 부른다 (빠르게 부르면 사이트가 연결을 끊는다).
  python -m pipelines.fetch_sbiz365_sns
"""
from __future__ import annotations

import datetime as dt
import json
import time
from pathlib import Path

import requests

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "sbiz_sns.json"
BASE = "https://bigdata.sbiz.or.kr"
# 업종 -> SNS 키워드 (손님이 실제로 쓰는 말)
KEYWORDS = {"chicken": "치킨", "bunsik": "떡볶이", "bbq": "삼겹살", "cafe": "카페", "apparel": "옷가게"}


def get(s: requests.Session, kw: str, a: dt.date, b: dt.date, top: int) -> dict:
    for attempt in range(3):
        try:
            r = s.get(f"{BASE}/gis/api/snsAnls/getSnsAnlsDetail", timeout=60, params={
                "keyword": kw, "startDate": a.strftime("%Y%m%d"), "endDate": b.strftime("%Y%m%d"),
                "include": "", "exclude": "", "patternExcList": "#**", "topN": top})
            d = r.json()
            if d.get("returnCode") == "00":
                return d["data"]
        except Exception as e:  # 잠깐 쉬고 다시
            print(mask(f"  retry {kw} {a}: {e}"))
        time.sleep(3 + attempt * 3)
    return {}


def main() -> None:
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (changeup-simulator research)"
    s.get(f"{BASE}/#/openApi/snsAnaly", params={"certKey": key("SBIZ365_SNS_KEY", fallback=None)}, timeout=30)
    today = dt.date.today()
    first = today.replace(day=1)
    months = []
    for k in range(12, 0, -1):   # 지난 12개 달 (이번 달 제외)
        y, m = first.year, first.month - k
        while m <= 0:
            y, m = y - 1, m + 12
        a = dt.date(y, m, 1)
        b = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
        months.append((a, b))
    out: dict = {"src": "소상공인365 SNS 분석 (오픈API, SNS 언급 수와 연관어)", "period": f"{months[0][0]:%Y-%m}~{months[-1][1]:%Y-%m}", "inds": {}}
    for ind, kw in KEYWORDS.items():
        freq = {}
        for a, b in months:
            d = get(s, kw, a, b, 5)
            freq[f"{a:%Y%m}"] = int(d.get("frequency") or 0)
            time.sleep(1.0)
        whole = get(s, kw, months[0][0], months[-1][1], 20)
        time.sleep(1.0)
        vals = [v for v in freq.values() if v > 0]
        mean = sum(vals) / len(vals) if vals else 0
        out["inds"][ind] = {
            "keyword": kw, "monthly": freq,
            # 달(1~12)별 관심도: 그 달 언급 수 ÷ 12개월 평균
            "season_index": {str(int(ym[4:])): round(v / mean, 3) for ym, v in freq.items() if mean and v},
            "total": int(whole.get("frequency") or sum(freq.values())),
            "related": [{"word": c["label"], "freq": int(c.get("frequency") or 0)} for c in (whole.get("childList") or [])][:20],
        }
        print(ind, kw, "총", out["inds"][ind]["total"], "연관어", [r["word"] for r in out["inds"][ind]["related"][:8]])
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    print("->", OUT)


if __name__ == "__main__":
    main()
