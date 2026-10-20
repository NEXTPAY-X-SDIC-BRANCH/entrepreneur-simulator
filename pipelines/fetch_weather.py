"""기상청 ASOS 서울(108) 일자료와 특일 정보를 받아 목업이 읽는 파일로 만든다.

    python -m pipelines.fetch_weather            # 2016~2025 날씨, 2026~2027 공휴일

키는 환경변수 DATA_GO_KR_KEY, 없으면 저장소 루트 .env에서 읽는다. 키는 출력하지 않는다.
출력: web/public/mock/weather_seoul.json, web/public/mock/holidays.json
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock"
ASOS = "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList"
HOLI = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo"
RAIN_MM = 1.0  # 하루 강수량이 이 값 이상이면 비 온 날로 센다


def key() -> str:
    """환경변수 DATA_GO_KR_KEY, 없으면 저장소 루트의 .env (저장소에 올리지 않는 파일)에서 읽는다."""
    k = os.environ.get("DATA_GO_KR_KEY")
    if k:
        return k
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATA_GO_KR_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("DATA_GO_KR_KEY가 없습니다. 환경변수나 저장소 루트 .env에 넣어 주세요 (.env.example 참고)")


def get(url: str, params: dict) -> dict:
    for attempt in range(4):
        r = requests.get(url, params=params, timeout=60)
        if r.status_code == 200 and r.text.lstrip().startswith("{"):
            return r.json()
        time.sleep(2 + attempt * 2)
    raise SystemExit(f"요청 실패: {url.rsplit('/', 1)[-1]} HTTP {r.status_code} {r.text[:200]}")


def weather(k: str, y0: int, y1: int) -> dict:
    days = []
    for y in range(y0, y1 + 1):
        d = get(ASOS, dict(serviceKey=k, pageNo=1, numOfRows=400, dataType="JSON", dataCd="ASOS", dateCd="DAY",
                           startDt=f"{y}0101", endDt=f"{y}1231", stnIds="108"))
        items = d["response"]["body"]["items"]["item"]
        days += items
        print(y, len(items), "일")
    num = lambda v: float(v) if v not in ("", None) else 0.0
    by = {m: [] for m in range(1, 13)}
    for it in days:
        by[int(it["tm"][5:7])].append(it)
    months = []
    for m in range(1, 13):
        rows = by[m]
        n = len(rows)
        months.append({
            "month": m, "days": n,
            "rain_share": round(sum(num(r["sumRn"]) >= RAIN_MM for r in rows) / n, 3),
            "heavy_rain_share": round(sum(num(r["sumRn"]) >= 30 for r in rows) / n, 3),
            "cold_share": round(sum(num(r["minTa"]) <= -10 for r in rows) / n, 3),
            "hot_share": round(sum(num(r["maxTa"]) >= 33 for r in rows) / n, 3),
            "avg_temp": round(sum(num(r["avgTa"]) for r in rows) / n, 1),
        })
    return {
        "_meta": {
            "source": "기상청 지상(종관, ASOS) 일자료 조회서비스 (data.go.kr 15059093), 서울 지점 108",
            "period": f"{y0}~{y1}", "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "method": f"달마다 {y1 - y0 + 1}년치 날을 모아 비율을 냄. 비 온 날 = 일강수량 {RAIN_MM}mm 이상, 큰비 = 30mm 이상, "
                      "한파 = 최저기온 영하 10도 이하, 폭염 = 최고기온 33도 이상",
            "caveat": "하루 전체 강수량 기준이라 저녁 장사 시간에 비가 왔는지는 알 수 없음",
        },
        "months": months,
    }


def holidays(k: str, years: list[int]) -> dict:
    out = {}
    for y in years:
        for m in range(1, 13):
            d = get(HOLI, dict(serviceKey=k, solYear=y, solMonth=f"{m:02d}", _type="json", numOfRows=50))
            items = d["response"]["body"]["items"]
            rows = items["item"] if items else []
            for it in rows if isinstance(rows, list) else [rows]:
                if it.get("isHoliday") == "Y":
                    s = str(it["locdate"])
                    out[f"{s[:4]}-{s[4:6]}-{s[6:]}"] = it["dateName"]
        print(y, "공휴일", sum(x.startswith(str(y)) for x in out), "일")
    return {
        "_meta": {"source": "한국천문연구원 특일 정보 (data.go.kr 15012690, getRestDeInfo)",
                  "fetched_at": datetime.now().isoformat(timespec="seconds"), "years": years},
        "days": dict(sorted(out.items())),
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    k = key()
    w = weather(k, 2016, 2025)
    (OUT / "weather_seoul.json").write_text(json.dumps(w, ensure_ascii=False, indent=1), encoding="utf-8")
    for m in w["months"]:
        print(m)
    h = holidays(k, [2026, 2027])
    (OUT / "holidays.json").write_text(json.dumps(h, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
