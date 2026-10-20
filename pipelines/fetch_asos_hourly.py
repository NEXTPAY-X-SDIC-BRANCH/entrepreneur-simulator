"""기상청 ASOS 시간자료(서울 108)에서 월별 시간대 강수 비율을 만든다.

    KMA_ASOS_HOURLY_KEY=... python -m pipelines.fetch_asos_hourly

출력: web/public/mock/asos_hourly.json
정의: 비 온 시간 = 그 시간 강수량(rn)이 0보다 큰 시간. 저녁 = 17~23시 구간.
요청 한 번에 1,000건까지만 받으므로 한 달씩, 한 페이지씩 나눠 받는다. 키는 출력하지 않는다.
"""
from __future__ import annotations

import calendar
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "asos_hourly.json"
URL = "https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList"
YEARS = range(2016, 2026)


def get_json(url: str, tries: int = 4) -> dict:
    """일시적인 네트워크 끊김에 대비해 여러 번 재시도한다."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_month(key: str, year: int, month: int) -> list[dict]:
    last = calendar.monthrange(year, month)[1]
    items: list[dict] = []
    page = 1
    while True:
        params = {
            "serviceKey": key, "pageNo": str(page), "numOfRows": "200", "dataType": "JSON",
            "dataCd": "ASOS", "dateCd": "HR", "startDt": f"{year}{month:02d}01", "startHh": "00",
            "endDt": f"{year}{month:02d}{last:02d}", "endHh": "23", "stnIds": "108",
        }
        data = get_json(URL + "?" + urllib.parse.urlencode(params))
        header = data["response"]["header"]
        if header["resultCode"] != "00":
            raise RuntimeError(f"ASOS {year}-{month:02d}: {header['resultCode']} {header['resultMsg']}")
        body = data["response"]["body"]
        page_items = body["items"]["item"] if body.get("items") else []
        items.extend(page_items)
        if not page_items or len(items) >= int(body.get("totalCount", 0)):
            return items
        page += 1
        time.sleep(0.2)


def main() -> None:
    key = os.environ.get("KMA_ASOS_HOURLY_KEY", "")
    if not key:
        raise SystemExit("KMA_ASOS_HOURLY_KEY 환경변수가 없습니다.")
    # 월 -> [전체 시간 수, 비 온 시간 수] / [저녁 시간 수, 비 온 저녁 시간 수]
    all_t = {m: [0, 0] for m in range(1, 13)}
    eve_t = {m: [0, 0] for m in range(1, 13)}
    for year in YEARS:
        for month in range(1, 13):
            for it in fetch_month(key, year, month):
                rn = it.get("rn")
                # 시간자료는 비가 없는 시간의 강수량 칸을 비워 두므로, 빈 값은 0(비 없음)으로 센다
                wet = (float(rn) if rn not in (None, "") else 0.0) > 0
                hour = int(it["tm"][11:13])
                all_t[month][0] += 1
                all_t[month][1] += int(wet)
                if 17 <= hour <= 23:
                    eve_t[month][0] += 1
                    eve_t[month][1] += int(wet)
        time.sleep(0.5)
    months = []
    for m in range(1, 13):
        a, e = all_t[m], eve_t[m]
        months.append({
            "month": m,
            "all_hour_rain_share": round(a[1] / a[0], 3) if a[0] else None,
            "evening_hour_rain_share": round(e[1] / e[0], 3) if e[0] else None,
        })
    OUT.write_text(json.dumps({
        "_meta": {"source": "기상청 지상(종관, ASOS) 시간자료 조회서비스, 서울 108",
                  "years": f"{YEARS[0]}~{YEARS[-1]}",
                  "method": "비 온 시간 = 시간 강수량 0mm 초과. 강수량 칸이 빈 시간은 비 없음(0)으로 셈. 저녁 = 17~23시 구간의 비율.",
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
        "months": months,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("months:", len(months))


if __name__ == "__main__":
    main()
