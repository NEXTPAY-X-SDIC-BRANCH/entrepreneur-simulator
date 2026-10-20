"""서울 행정동(동네)별 한식음식점 요약 -> web/public/mock/dong_stats.json.

    python -m pipelines.build_dong_stats [--year 2025]

키: SEOUL_OPEN_DATA_KEY (서울 열린데이터광장), SBIZ_STORE_KEY (소상공인 상가정보). 키는 출력하지 않는다.

입력
  서울시 상권분석서비스 추정매출-행정동 (VwsmAdstrdSelngW): 분기별 한식음식점(CS100001) 매출, 요일·시간대·연령 비중
  소상공인시장진흥공단 상가업소 (storeListInDong): 행정동별 한식(I201)과 돼지고기 구이/찜(I20107) 점포 수
출력 (동마다)
  stores 한식 점포 수, pork 돼지고기 구이/찜 점포 수, sales_month 한식 월평균 추정 매출(만원),
  rel 구 평균 대비 점포당 매출 비(구 안에서의 상대 위치), dow 요일 비중(월~일), qidx 분기 지수, shares 시간대·연령·주말 비중,
  type 동네 유형(대학·청년 / 오피스 / 주거 / 일반)
읽기 전에
  - 매출은 카드사 추정치를 키운 값이고 점포 수는 상가 등록 기준이라 둘의 비(점포당 매출)는 절대값이 아니라 구 안의 상대 위치로만 쓴다.
  - 고깃집만의 매출은 없다. 한식음식점 전체 기준이다.
  - 유형은 비중에 기준을 둔 분류(규칙은 classify())이며 현장 조사가 아니다.
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests

from .keys import key, mask

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock" / "dong_stats.json"
SEOUL = "http://openapi.seoul.go.kr:8088/{k}/json/VwsmAdstrdSelngW/{a}/{b}/{q}"
SBIZ = "http://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong"
GU_CODE = {
    "종로구": "11110", "중구": "11140", "용산구": "11170", "성동구": "11200", "광진구": "11215", "동대문구": "11230",
    "중랑구": "11260", "성북구": "11290", "강북구": "11305", "도봉구": "11320", "노원구": "11350", "은평구": "11380",
    "서대문구": "11410", "마포구": "11440", "양천구": "11470", "강서구": "11500", "구로구": "11530", "금천구": "11545",
    "영등포구": "11560", "동작구": "11590", "관악구": "11620", "서초구": "11650", "강남구": "11680", "송파구": "11710",
    "강동구": "11740",
}
CODE_GU = {v: k for k, v in GU_CODE.items()}
DOW = ["MON", "TUES", "WED", "THUR", "FRI", "SAT", "SUN"]
BANDS = ["00_06", "06_11", "11_14", "14_17", "17_21", "21_24"]
AGES = ["10", "20", "30", "40", "50", "60_ABOVE"]


def getj(url: str, params: dict | None = None) -> dict:
    last = ""
    for attempt in range(4):
        try:
            r = requests.get(url, params=params, timeout=90)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError) as e:
            last = mask(str(e))[:120]
        time.sleep(2 + attempt * 2)
    raise SystemExit(f"요청 실패: {last}")


def sales_rows(k: str, quarter: str) -> list[dict]:
    rows, a = [], 1
    while True:
        d = getj(SEOUL.format(k=k, a=a, b=a + 999, q=quarter)).get("VwsmAdstrdSelngW")
        if not d:
            break
        rows += [r for r in d["row"] if r["SVC_INDUTY_CD"] == "CS100001"]
        if a + 999 >= d["list_total_count"]:
            break
        a += 1000
    return rows


def store_counts(k: str, gu: str, **cls) -> dict[str, tuple[str, int]]:
    """행정동 코드 -> (동 이름, 점포 수). 한 번에 1000건씩 받아 센다."""
    out: dict[str, list] = {}
    page = 1
    while True:
        d = getj(SBIZ, {"serviceKey": k, "pageNo": page, "numOfRows": 1000, "divId": "signguCd", "key": GU_CODE[gu],
                        "type": "json", **cls})
        body = d.get("body") or {}
        items = body.get("items") or []
        for it in items:
            c = out.setdefault(str(it["adongCd"]), [it.get("adongNm", ""), 0])
            c[1] += 1
        if page * 1000 >= int(body.get("totalCount") or 0) or not items:
            break
        page += 1
    return {c: (v[0], v[1]) for c, v in out.items()}


def classify(sh: dict) -> str:
    """동네 유형. 규칙은 단순하고 문서에 적힌 대로다 (임계값은 서울 424개 동의 분포를 보고 정했다).
    대학·청년: 20대 매출 비중이 높음 / 오피스: 점심 비중과 평일 비중이 높음 / 주거: 주말 비중이 높고 저녁이 낮음."""
    if sh["age20"] >= 0.27:
        return "대학·청년"
    if sh["lunch"] >= 0.30 and sh["weekend"] <= 0.25:
        return "오피스"
    if sh["weekend"] >= 0.36:
        return "주거"
    return "일반"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2025)
    a = ap.parse_args()
    sk = key("SEOUL_OPEN_DATA_KEY", fallback=None)
    bk = key("SBIZ_STORE_KEY")

    # 1) 분기별 행정동 한식 매출
    qs = [f"{a.year}{i}" for i in (1, 2, 3, 4)]
    by_q: dict[str, list[dict]] = {}
    for q in qs:
        by_q[q] = sales_rows(sk, q)
        print(f"{q}: 한식 행정동 {len(by_q[q])}행")
    dong: dict[str, dict] = {}
    for qi, q in enumerate(qs):
        for r in by_q[q]:
            c = r["ADSTRD_CD"]
            d = dong.setdefault(c, {"code": c, "name": r["ADSTRD_CD_NM"], "q": [0.0] * 4, "tx": 0.0,
                                    "dow": [0.0] * 7, "band": [0.0] * 6, "age": [0.0] * 6})
            amt = float(r["THSMON_SELNG_AMT"] or 0)
            d["q"][qi] += amt
            d["tx"] += float(r["THSMON_SELNG_CO"] or 0)
            for i, x in enumerate(DOW):
                d["dow"][i] += float(r[f"{x}_SELNG_AMT"] or 0)
            for i, x in enumerate(BANDS):
                d["band"][i] += float(r[f"TMZON_{x}_SELNG_AMT"] or 0)
            for i, x in enumerate(AGES):
                d["age"][i] += float(r[f"AGRDE_{x}_SELNG_AMT"] or 0)

    # 2) 점포 수
    hansik: dict[str, int] = {}
    pork: dict[str, int] = {}
    for gu in GU_CODE:
        for c, (_, n) in store_counts(bk, gu, indsMclsCd="I201").items():
            hansik[c] = n
        for c, (_, n) in store_counts(bk, gu, indsSclsCd="I20107").items():
            pork[c] = n
        print(f"{gu}: 한식 {sum(v for c, v in hansik.items() if c.startswith(GU_CODE[gu]))}, 돼지구이 {sum(v for c, v in pork.items() if c.startswith(GU_CODE[gu]))}")

    # 3) 합치기
    out: dict[str, list[dict]] = {g: [] for g in GU_CODE}
    for c, d in dong.items():
        gu = CODE_GU.get(c[:5])
        if not gu:
            continue
        tot = sum(d["q"])
        if tot <= 0:
            continue
        dow_sum, band_sum, age_sum = sum(d["dow"]), sum(d["band"]), sum(d["age"])
        sh = {
            "weekend": (d["dow"][5] + d["dow"][6]) / dow_sum if dow_sum else 0.0,
            "lunch": d["band"][2] / band_sum if band_sum else 0.0,
            "evening": (d["band"][4] + d["band"][5]) / band_sum if band_sum else 0.0,
            "age20": d["age"][1] / age_sum if age_sum else 0.0,
            "age30": d["age"][2] / age_sum if age_sum else 0.0,
        }
        n = hansik.get(c, 0)
        month = tot / 12 / 1e4  # 만원, 월 평균 추정 매출 (행정동 전체 한식)
        out[gu].append({
            "code": c, "name": d["name"], "stores": n, "pork": pork.get(c, 0), "sales_month": round(month),
            "raw_per_store": round(month / n, 1) if n else None,
            "dow": [round(x / dow_sum, 4) for x in d["dow"]] if dow_sum else [1 / 7] * 7,
            "qidx": [round(x / (tot / 4), 3) for x in d["q"]],
            "shares": {k2: round(v, 3) for k2, v in sh.items()}, "type": classify(sh),
        })
    # 구 안의 상대 위치: 점포당 매출을 구 합계 기준으로 나눈 비
    for gu, lst in out.items():
        s = sum(x["sales_month"] for x in lst)
        n = sum(x["stores"] for x in lst)
        base = s / n if n else None
        for x in lst:
            x["rel"] = round(x["raw_per_store"] / base, 3) if base and x["raw_per_store"] and x["stores"] >= 20 else None
        lst.sort(key=lambda x: -x["pork"])
    doc = {"_meta": {"generated": date.today().isoformat(), "year": a.year, "method": "pipelines/build_dong_stats.py",
                     "sources": {"sales": "서울시 상권분석서비스 추정매출-행정동 (VwsmAdstrdSelngW, 한식음식점 CS100001)",
                                 "stores": "소상공인시장진흥공단 상가업소 storeListInDong (I201 한식, I20107 돼지고기 구이/찜)"},
                     "caveats": ["매출은 카드사 추정치, 점포 수는 상가 등록 기준이라 점포당 매출은 구 안의 상대 위치(rel)로만 쓴다",
                                 "고깃집만의 매출은 없고 한식음식점 전체 기준", "rel은 한식 점포 20곳 미만인 동에는 없다",
                                 "유형은 매출 비중으로 나눈 규칙 분류이며 현장 조사가 아니다"]},
           "gu": out}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(len(v) for v in out.values())
    print(f"저장: {OUT.name}, 행정동 {n}개 ({OUT.stat().st_size // 1024} KB)")
    from collections import Counter
    print(Counter(x["type"] for v in out.values() for x in v))


if __name__ == "__main__":
    main()
