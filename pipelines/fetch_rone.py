"""한국부동산원 R-ONE 상업용부동산 임대동향에서 서울 상권별 상가 임대료·공실률·전환율·권리금을 받는다.

    python -m pipelines.fetch_rone

키: RONE_KEY. 키는 출력하지 않는다.
출력: web/public/mock/rone_rent.json (상권 단위 원자료), web/public/mock/rent_gu.json (25개 구로 묶은 값)

주의
- 임대료는 상권 단위(서울 59곳)이고 구 단위가 아니다. 구 값은 상권을 구에 배정해 평균낸 근사다.
- R-ONE 임대료는 보증금 환산액이 섞인 값이다 (전환율로 월세에 합산). 현금 월세와 다르다.
- 단위: 천원/㎡/월 → 만원/평/월 로 바꿀 때 ×3.3058÷10.
"""
from __future__ import annotations

import json
import statistics
import time
from datetime import date
from pathlib import Path

import requests

from .keys import key, mask

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
BASE = "https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do"
PYEONG = 3.3058  # ㎡

TABLES = {
    "rent": ("T248223134698125", "QY", "소규모 상가 임대료 (천원/㎡/월, 보증금 환산 포함)"),
    "vacancy": ("T241833134686576", "QY", "소규모 상가 공실률 (%)"),
    "conv": ("T246253134905233", "QY", "소규모 상가 전월세 전환율 (%)"),
    "floor": ("T246233134891629", "QY", "소규모 상가 층별 효용비율 (1층=100)"),
    "premium": ("A_2024_00445", "YY", "시도별 업종별 상가 권리금 (숙박·음식점업 행만 사용)"),
}

# R-ONE 상권명 → 서울 25개 구. 상권이 구 경계에 걸치면 상권 중심지가 있는 구로 배정했다.
# 도봉구는 R-ONE 상권이 없어 rent_gu.json에서 imputed=true 로 표시한다.
AREA_GU = {
    "광화문": "종로구", "남대문": "중구", "동대문": "중구", "명동": "중구", "방산시장": "중구", "북촌": "종로구",
    "서촌": "종로구", "시청": "중구", "을지로": "중구", "종로": "종로구", "충무로": "중구",
    "강남대로": "강남구", "교대역": "서초구", "남부터미널": "서초구", "논현역": "강남구", "도산대로": "강남구",
    "신사역": "강남구", "압구정": "강남구", "청담": "강남구", "테헤란로": "강남구",
    "공덕역": "마포구", "당산역": "영등포구", "동교/연남": "마포구", "망원역": "마포구", "신촌/이대": "서대문구",
    "영등포역": "영등포구", "홍대/합정": "마포구",
    "가락시장": "송파구", "건대입구": "광진구", "경희대": "동대문구", "군자": "광진구", "까치산역": "강서구",
    "노량진": "동작구", "독산/시흥": "금천구", "뚝섬": "성동구", "목동": "양천구", "미아사거리": "강북구",
    "불광역": "은평구", "사당": "동작구", "상계역": "노원구", "상봉역": "중랑구", "서울대입구역": "관악구",
    "성신여대": "성북구", "수유": "강북구", "숙명여대": "용산구", "신림역": "관악구", "약수역": "중구",
    "연신내": "은평구", "오류동역": "구로구", "왕십리": "성동구", "용산역": "용산구", "이태원": "용산구",
    "잠실/송파": "송파구", "잠실새내역": "송파구", "장안동": "동대문구", "천호": "강동구", "청량리": "동대문구",
    "혜화동": "종로구", "화곡": "강서구",
}
# R-ONE 상권명 -> 행정동 이름. 이름만으로 확실한 곳만 적었다 (동 경계는 상권과 다르다). 여기에 없는 동은 구 평균 월세를 쓴다.
AREA_DONG = {
    "홍대/합정": ["서교동", "합정동"], "동교/연남": ["연남동"], "망원역": ["망원1동", "망원2동"], "공덕역": ["공덕동"],
    "신촌/이대": ["신촌동"], "건대입구": ["화양동"], "뚝섬": ["성수1가1동", "성수1가2동", "성수2가1동", "성수2가3동"],
    "왕십리": ["왕십리도선동", "왕십리2동", "행당1동"], "이태원": ["이태원1동", "이태원2동"], "혜화동": ["혜화동"],
    "종로": ["종로1·2·3·4가동", "종로5·6가동"], "광화문": ["사직동"], "북촌": ["가회동", "삼청동"], "서촌": ["청운효자동"],
    "명동": ["명동"], "시청": ["소공동"], "을지로": ["을지로동"], "충무로": ["필동"], "남대문": ["회현동"],
    "동대문": ["광희동"], "약수역": ["약수동"], "강남대로": ["역삼1동"], "테헤란로": ["역삼1동"], "논현역": ["논현1동"],
    "신사역": ["신사동"], "도산대로": ["신사동"], "압구정": ["압구정동"], "청담": ["청담동"],
    "당산역": ["당산1동", "당산2동"], "영등포역": ["영등포동", "영등포본동"], "가락시장": ["가락본동"],
    "잠실/송파": ["잠실본동"], "잠실새내역": ["잠실6동"], "장안동": ["장안1동", "장안2동"], "청량리": ["청량리동"],
    "경희대": ["회기동"], "군자": ["군자동"], "노량진": ["노량진1동", "노량진2동"],
    "사당": ["사당1동", "사당2동", "사당3동", "사당4동", "사당5동"], "천호": ["천호1동", "천호2동", "천호3동"],
    "수유": ["수유1동", "수유2동", "수유3동"], "미아사거리": ["미아동"], "신림역": ["신림동"], "성신여대": ["동선동"],
    "숙명여대": ["청파동"], "용산역": ["한강로동"], "독산/시흥": ["독산1동", "독산2동", "독산3동", "시흥1동"],
    "화곡": ["화곡1동", "화곡4동"], "목동": ["목1동", "목2동", "목3동", "목4동", "목5동"], "불광역": ["불광1동", "불광2동"],
    "연신내": ["갈현1동", "갈현2동", "구산동"], "오류동역": ["오류1동", "오류2동"], "상계역": ["상계1동", "상계2동"],
    "상봉역": ["상봉1동", "상봉2동"],
}
GU_25 = ["종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구", "노원구", "은평구",
         "서대문구", "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구", "관악구", "서초구", "강남구",
         "송파구", "강동구"]
GROUPS = {"서울", "도심", "강남", "영등포신촌", "기타"}  # 상권이 아닌 묶음 행


def get(k: str, tid: str, cycle: str) -> list[dict]:
    """전 행을 받는다. 한 번에 1000행까지라 pIndex로 넘긴다."""
    rows: list[dict] = []
    page = 1
    while True:
        p = {"KEY": k, "STATBL_ID": tid, "DTACYCLE_CD": cycle, "Type": "json", "pSize": "1000", "pIndex": str(page)}
        r = None
        for attempt in range(4):
            r = requests.get(BASE, params=p, timeout=60)
            if r.status_code == 200:
                break
            time.sleep(2 + attempt * 2)
        if r is None or r.status_code != 200:
            raise SystemExit(f"{tid}: HTTP {r.status_code if r is not None else '?'}")
        try:
            body = r.json()["SttsApiTblData"]
            total = int(body[0]["head"][0]["list_total_count"])
            got = body[1]["row"]
        except (ValueError, KeyError, IndexError):
            raise SystemExit(f"{tid}: 응답 형식 오류 {mask(r.text[:150])}")
        rows += got
        if len(rows) >= total or not got:
            return rows
        page += 1


def slim(r: dict) -> dict:
    return {"t": r["WRTTIME_IDTFR_ID"], "cls": r.get("CLS_FULLNM"), "grp": r.get("GRP_NM"), "item": r.get("ITM_NM"),
            "v": r.get("DTA_VAL"), "unit": r.get("UI_NM")}


def main() -> None:
    k = key("RONE_KEY", fallback=None)
    raw: dict = {}
    for name, (tid, cyc, why) in TABLES.items():
        rows = get(k, tid, cyc)
        if name == "premium":
            rows = [r for r in rows if "음식" in (r.get("CLS_FULLNM") or "") and r.get("GRP_NM") in ("서울", "전국")]
        else:
            rows = [r for r in rows if "서울" in (r.get("CLS_FULLNM") or "") or r.get("GRP_NM") == "서울"]
            quarters = sorted({r["WRTTIME_IDTFR_ID"] for r in rows})
            rows = [r for r in rows if r["WRTTIME_IDTFR_ID"] in quarters[-5:]]  # 최근 5분기
        raw[name] = {"table": tid, "desc": why, "rows": [slim(r) for r in rows]}
        print(f"{name} {tid}: {len(rows)}행")

    # 최신 분기의 상권별 임대료를 만원/평으로
    rent = raw["rent"]["rows"]
    latest = max(r["t"] for r in rent)
    now: dict[str, float] = {}
    for r in rent:
        if r["t"] == latest and r["item"] == "임대료" and r["v"] is not None:
            now[r["cls"].split(">")[-1]] = round(float(r["v"]) * PYEONG / 10, 2)
    seoul_avg = now.get("서울")
    conv_rows = [r for r in raw["conv"]["rows"] if r["cls"] == "서울" and r["t"] == latest and r["v"] is not None]
    conv_seoul = round(float(conv_rows[0]["v"]), 3) if conv_rows else None  # 전월세 전환율 %/년
    unmapped = sorted(n for n in now if n not in AREA_GU and n not in GROUPS)
    if unmapped:
        print("구 배정이 없는 상권:", unmapped)

    by_gu: dict[str, list[tuple[str, float]]] = {g: [] for g in GU_25}
    for area, val in now.items():
        gu = AREA_GU.get(area)
        if gu:
            by_gu[gu].append((area, val))
    gu_out: dict[str, dict] = {}
    for g in GU_25:
        items = by_gu[g]
        if items:
            gu_out[g] = {"rent_man_per_pyeong": round(statistics.mean(v for _, v in items), 1),
                         "n_areas": len(items), "areas": [a for a, _ in items], "imputed": False}
        else:
            gu_out[g] = {"rent_man_per_pyeong": None, "n_areas": 0, "areas": [], "imputed": True}
    mapped_vals = [v for a, v in now.items() if a in AREA_GU]
    fill = round(statistics.median(mapped_vals), 1) if mapped_vals else seoul_avg
    for o in gu_out.values():
        if o["imputed"]:
            o["rent_man_per_pyeong"] = fill

    # 행정동 월세: 이름이 맞는 동에만. 한 동에 상권이 둘 이상이면 평균
    dong_acc: dict[str, list[tuple[str, float]]] = {}
    for area, dongs in AREA_DONG.items():
        gu, val = AREA_GU.get(area), now.get(area)
        if gu and val is not None:
            for dn in dongs:
                dong_acc.setdefault(f"{gu}|{dn}", []).append((area, val))
    dong_rent = {k: {"rent_man_per_pyeong": round(statistics.mean(v for _, v in lst), 1), "areas": [a for a, _ in lst]}
                 for k, lst in dong_acc.items()}

    prem: dict[str, dict] = {}
    prem_rows = raw["premium"]["rows"]
    if prem_rows:
        last_y = max(x["t"] for x in prem_rows)
        for r in prem_rows:
            if r["grp"] == "서울" and r["t"] == last_y:
                prem[r["item"]] = {"v": r["v"], "unit": r["unit"], "year": r["t"]}

    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"generated": date.today().isoformat(), "quarter": latest,
            "source": "한국부동산원 R-ONE 상업용부동산 임대동향조사", "method": "pipelines/fetch_rone.py"}
    (OUT / "rone_rent.json").write_text(
        json.dumps({"_meta": meta, "tables": raw}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    doc = {
        "_meta": {**meta, "unit": "만원/평/월 (보증금 환산 포함)", "caveats": [
            "상권 단위(서울 59곳)를 구에 배정해 평균낸 근사. 구 전체 임대료가 아님",
            "임대료에 보증금 환산액이 섞여 있어 현금 월세보다 높게 나옴",
            "R-ONE 상권이 없는 구는 배정된 상권의 중앙값으로 채움 (imputed)",
            "소규모 상가 1층 기준. 2층 이상은 층별 효용비율로 환산해야 함",
        ]},
        "seoul_avg": seoul_avg,
        "conv_seoul_pct": conv_seoul,
        "gu": gu_out,
        "area": now,
        "premium_seoul_food": prem,
        "area_to_gu": AREA_GU,
        "dong": dong_rent,
    }
    (OUT / "rent_gu.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    n_ok = sum(1 for o in gu_out.values() if not o["imputed"])
    print(f"분기 {latest}, 서울 평균 {seoul_avg}만원/평, 구 {n_ok}/25 배정")


if __name__ == "__main__":
    main()
