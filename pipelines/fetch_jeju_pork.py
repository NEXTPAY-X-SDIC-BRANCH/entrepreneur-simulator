"""제주 돼지도체 등급별 경락가격(축산물품질평가원)을 월 두수 가중평균으로 만든다.

    python -m pipelines.fetch_jeju_pork [--from 2023-01]

키: LIVESTOCK_AUCTION_KEY. 키는 출력하지 않는다.
출력: web/public/mock/jeju_pork.json
주의: 제주 지육 경락가(원/kg)이고 서울 삼겹 도매가가 아니다. 가격 방향과 변동 폭을 보는 참고용.
"""
from __future__ import annotations

import argparse
import calendar
import json
import re
import time
from datetime import date
from pathlib import Path

import requests

from .keys import key, mask

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
URL = "http://data.ekape.or.kr/openapi-data/service/user/grade/auct/pigJejuGrade"
TAG = re.compile(r"<[^>]+>")


def month_avg(k: str, y: int, m: int) -> tuple[int | None, int]:
    last = calendar.monthrange(y, m)[1]
    p = {"startYmd": f"{y}{m:02d}01", "endYmd": f"{y}{m:02d}{last}", "skinYn": "Y", "serviceKey": k}
    text = ""
    for attempt in range(4):
        r = requests.get(URL, params=p, timeout=90)
        text = r.text
        if r.status_code == 200 and "<resultCode>00</resultCode>" in text:
            break
        if "<resultCode>" in text and "<resultCode>00</resultCode>" not in text:
            raise SystemExit(f"{y}-{m:02d}: {mask(TAG.sub(' ', text)[:160])}")
        time.sleep(2 + attempt * 2)
    n = total = 0
    for it in re.findall(r"<item>(.*?)</item>", text, flags=re.S):
        c = re.search(r"<totCnt>(\d+)</totCnt>", it)
        pr = re.search(r"<totPrice>(\d+)</totPrice>", it)
        if c and pr:
            n += int(c.group(1))
            total += int(c.group(1)) * int(pr.group(1))
    return (round(total / n) if n else None), n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2023-01")
    a = ap.parse_args()
    k = key("LIVESTOCK_AUCTION_KEY", fallback=None)
    y, m = map(int, a.start.split("-"))
    today = date.today()
    series = []
    while (y, m) < (today.year, today.month):  # 진행 중인 달은 제외
        avg, n = month_avg(k, y, m)
        series.append({"month": f"{y}-{m:02d}", "won_per_kg": avg, "heads": n})
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    OUT.mkdir(parents=True, exist_ok=True)
    doc = {"_meta": {"generated": today.isoformat(),
                     "source": "축산물품질평가원 축산물경락가격정보 (제주 돼지도체 등급별)",
                     "method": "pipelines/fetch_jeju_pork.py", "unit": "원/kg, 지육, 두수 가중평균",
                     "caveat": "제주 한 곳의 지육 경락가. 서울 삼겹 도매가와 단계가 다르다"},
           "series": series}
    (OUT / "jeju_pork.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = [s for s in series if s["won_per_kg"]]
    print(f"{len(series)}개월, 값 있음 {len(ok)}, 최근 {series[-1] if series else None}")


if __name__ == "__main__":
    main()
