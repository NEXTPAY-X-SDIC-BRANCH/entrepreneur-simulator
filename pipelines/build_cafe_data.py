"""카페용 데이터 묶음을 만든다 (고깃집의 gu_stats.json, dong_stats.json, rent_gu.json, kosis_food.json 에 해당).

    python -m pipelines.build_cafe_data <서울 행정동 카페 지표 엑셀>

입력: 서울 행정동 카페 지표·독립 카페 창업 조건 엑셀 (공유받은 자료). 이 저장소 밖에 둔다.
  2단계_입지        서울 + 25개 자치구 x 카페 변수 188개 (구 합계, 비율은 합계끼리 나눠 다시 계산)
  2단계_서울 행정동 raw   425개 행정동 x 143개 열 (상가정보 2026.06, 서울시 상권분석서비스 2026Q2, 역사 좌표)
  1단계_창업조건    독립(비프랜차이즈) 비알코올 음료점의 KREI 2025 원자료 값 (낮음/기본/높음 = 가중 25/50/75백분위)
  1단계_지역별 비용 시도별, 서울 자치구별 월세·보증금·권리금·인건비·식재료비 (독립 음료점)
  2단계_참고(설문·전국)
출력 (web/public/mock/)
  cafe_gu.json     구 단위 변수 표 (동네 분석용)
  cafe_dong.json   행정동 425곳의 핵심 지표와 유형 (동네 선택용)
  cafe_cost.json   창업 조건·비용 변수와 시도·구별 비용 (드는 돈, 점검, 시뮬 입력용)
값은 엑셀에 적힌 그대로 옮기고 반올림만 한다. 해석을 붙이지 않는다.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import openpyxl

MOCK = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
SRC_NAME = "서울 행정동 카페 지표·독립 카페 창업 조건·비용 (외식업체 경영실태조사 2025 원자료 가공, 2026-10-14)"


def r(v, d=4):
    return round(v, d) if isinstance(v, float) else v


def rows_of(ws):
    return [list(x) for x in ws.iter_rows(values_only=True)]


def gu_table(ws) -> dict:
    rows = rows_of(ws)
    hdr_i = next(i for i, x in enumerate(rows) if x[0] == "하위 항목")
    hdr = rows[hdr_i]
    gus = [str(c) for c in hdr[4:30]]            # 서울 전체 + 25개 구
    assumptions = {}
    for x in rows[2:hdr_i]:
        if x[1] is not None and x[2] is not None:
            assumptions[str(x[1])] = {"value": r(x[2]), "note": x[3]}
    out, section = [], ""
    for x in rows[hdr_i + 1:]:
        if x[0] and not x[1]:
            section = str(x[0])
            continue
        if not x[1]:
            continue
        out.append({"section": section, "group": x[0], "id": x[1], "name": x[2], "unit": x[3],
                    "values": {g: r(v) for g, v in zip(gus, x[4:30])},
                    "grade": x[30], "use": x[31], "note": x[32], "source": x[33]})
    return {"_meta": {"source": SRC_NAME, "sheet": "2단계_입지", "regions": gus, "assumptions": assumptions,
                      "caveat": "추정매출은 카드 기반이라 실제보다 낮음(보정 배율 적용 열 별도). 프랜차이즈 포함 경쟁 환경. 집객시설·대학교 수는 갱신 의심(확신도 L)."},
            "vars": out}


# 행정동 raw 에서 가져오는 열 (엑셀 머리글 그대로). 나머지 열은 구 단위 표(cafe_gu.json)에 이미 합산돼 있다.
DONG_COLS = {
    "gu": "자치구", "code": "행정동 코드", "name": "행정동", "area_km2": "면적(㎢)",
    "shops": "전체 상가 수", "cafes": "카페 수", "franchise": "프랜차이즈 추정 카페", "lowcost": "저가 프랜차이즈 카페",
    "indie_coffee": "개인 커피전문점", "indie_dessert": "개인 디저트·음료 전문", "unmanned": "무인카페",
    "cafe_1f": "1층 카페", "restaurants": "음식점 수(카페 제외)", "cf_stores": "커피-음료 점포 수",
    "open_q": "개업 점포(분기)", "close_q": "폐업 점포(분기)", "open_y": "연 개업률(최근 4분기)", "close_y": "연 폐업률(최근 4분기)",
    "sales_q": "커피-음료 분기 매출(원)", "tx_q": "매출 건수",
    "share_0611": "매출 비중 06~11시", "share_1114": "매출 비중 11~14시", "share_1417": "매출 비중 14~17시",
    "share_1721": "매출 비중 17~21시", "share_2124": "매출 비중 21~24시", "peak": "매출 피크 시간대",
    "weekend": "주말 매출 비중", "age2030": "20·30대 매출 비중", "female": "여성 매출 비중",
    "sales_m_man": "점포당 월평균 매출(만원)", "sales_idx": "매출 지수(서울 평균=1)", "sales_m_adj_man": "보정 점포당 월매출(만원)",
    "ticket": "건당 결제 금액(원)", "tx_day": "점포당 일평균 결제 건수",
    "flow_day": "일평균 유동인구", "flow_2030": "유동 20·30대 비중", "flow_weekend": "유동 주말 비중", "flow_lunch": "유동 점심(11~14시) 비중",
    "flow_per_cafe": "카페 1곳당 일평균 유동인구", "work_per_cafe": "카페 1곳당 직장인구", "resident_per_cafe": "카페 1곳당 상주인구",
    "work_pop": "직장인구", "resident_pop": "상주인구", "density": "카페 밀도(개/㎢)", "franchise_share": "프랜차이즈 비중(점포)",
    "near_station_share": "역 500m 안 카페 비중", "station_dist_m": "카페 평균 최근접역 거리(m)", "subway": "지하철역 수(전 노선)",
    "attract": "집객시설 수", "univ": "대학교 수", "apt_price": "아파트 평균 시가(원)",
}
# 동네 유형: 고깃집(build_dong_stats.py)과 같은 문턱을 카페 매출 비중에 적용한다 (현장 조사 아님, 규칙 분류).
TYPE_RULE = "20대 매출 비중 27% 이상이면 대학·청년, 점심(11~14시) 매출 비중 30% 이상이고 주말 25% 이하면 오피스, 주말 36% 이상이면 주거, 나머지는 일반"


def dong_type(s20, lunch, weekend) -> str:
    if s20 is not None and s20 >= 0.27:
        return "대학·청년"
    if lunch is not None and weekend is not None and lunch >= 0.30 and weekend <= 0.25:
        return "오피스"
    if weekend is not None and weekend >= 0.36:
        return "주거"
    return "일반"


def dong_table(ws) -> dict:
    rows = rows_of(ws)
    hi = next(i for i, x in enumerate(rows) if x[0] == "자치구")
    head = rows[hi]
    idx = {k: head.index(v) for k, v in DONG_COLS.items()}
    i20 = head.index("매출 20대")
    i_sales = head.index("커피-음료 분기 매출(원)")
    out = []
    for x in rows[hi + 1:]:
        if not x[0] or not x[3]:
            continue
        d = {k: r(x[i]) for k, i in idx.items()}
        d["code"] = str(d["code"])
        ok = isinstance(x[i20], (int, float)) and isinstance(x[i_sales], (int, float)) and x[i_sales]
        s20 = x[i20] / x[i_sales] if ok else None
        d["age20"] = r(s20) if s20 is not None else None
        d["type"] = dong_type(s20, d.get("share_1114"), d.get("weekend"))
        d["thin"] = bool((d.get("cf_stores") or 0) < 20)   # 점포가 너무 적은 동은 점포당 값이 흔들린다
        out.append(d)
    return {"_meta": {"source": SRC_NAME, "sheet": "2단계_서울 행정동 raw", "n": len(out), "type_rule": TYPE_RULE,
                      "types": dict(Counter(d["type"] for d in out)),
                      "caveats": ["추정매출은 카드 기반이라 실제보다 낮음. 보정 점포당 월매출은 서울 소상공인 카페 월매출(KREI n=63)로 맞춘 배율 1.538을 곱한 값",
                                  "점포 수 20 미만인 동(thin)은 점포당 값이 흔들림",
                                  "상권분석서비스는 이전 행정동 코드 기준이라 상가정보를 이전 코드로 합침",
                                  "유형은 매출 비중 규칙 분류이며 현장 조사가 아님"]},
            "dong": out}


def cost_table(wb) -> dict:
    def block(ws):
        rows = rows_of(ws)
        hi = next(i for i, x in enumerate(rows) if x[0] == "하위 항목")
        out, section = [], ""
        for x in rows[hi + 1:]:
            if x[0] and not x[1]:
                section = str(x[0])
                continue
            if x[1] and x[2]:
                out.append({"section": section, "group": x[0], "id": x[1], "name": x[2], "unit": x[3], "low": r(x[4]), "base": r(x[5]),
                            "high": r(x[6]), "grade": x[7], "use": x[8], "note": x[9], "source": x[10]})
        return out

    start = block(wb["1단계_창업조건"])
    ref = block(wb["2단계_참고(설문·전국)"])
    tables, cur = [], None
    for x in rows_of(wb["1단계_지역별 비용"]):
        if x[0] and str(x[0]).startswith("표 "):
            cur = {"title": x[0], "regions": [], "rows": []}
            tables.append(cur)
        elif cur is not None and x[0] == "변수":
            cur["regions"] = [c for c in x[3:] if c]
        elif cur is not None and x[0] and cur["regions"]:
            cur["rows"].append({"name": x[0], "unit": x[1], "note": x[2],
                                "values": {g: r(v) for g, v in zip(cur["regions"], x[3:]) if v is not None}})
    return {"_meta": {"source": SRC_NAME,
                      "basis": "2025 외식업체 경영실태조사 원자료 (농식품부·농경연), 소상공인·독립 매장, 커피 전문점 + 기타 비알코올 음료점, 가중 25/50/75백분위",
                      "caveat": "낮음/기본/높음은 불확실성 범위가 아니라 매장 분포의 분위수. 서울 구별 값은 구마다 1~8곳이라 경향만 참고"},
            "start": start, "ref": ref, "regional": tables}


def main() -> None:
    wb = openpyxl.load_workbook(Path(sys.argv[1]), data_only=True, read_only=True)
    gu, dong, cost = gu_table(wb["2단계_입지"]), dong_table(wb["2단계_서울 행정동 raw"]), cost_table(wb)
    for name, obj in (("cafe_gu.json", gu), ("cafe_dong.json", dong), ("cafe_cost.json", cost)):
        (MOCK / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"cafe_gu.json  변수 {len(gu['vars'])}개 x {len(gu['_meta']['regions'])}개 지역")
    print(f"cafe_dong.json 행정동 {dong['_meta']['n']}개", dong["_meta"]["types"])
    print(f"cafe_cost.json 창업조건 {len(cost['start'])}개, 참고 {len(cost['ref'])}개, 지역표 {len(cost['regional'])}개")


if __name__ == "__main__":
    main()
