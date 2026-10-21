"""외식업체 경영실태조사(농림축산식품부·aT, KOSIS org 114)에서 치킨전문점·분식(김밥 및 기타 간이 음식점업) 값을 받는다.

    python -m pipelines.fetch_krei_quickfood

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/quickfood_krei.json  {"_meta", "chicken": {...}, "bunsik": {...}}
표 (DT_114054_xxx, 2025년 조사 = 2024년 실적, 전국)
  004 사업장 신고면적   009 영업시간·영업일수   012 개업시 인테리어 비용   016 배달앱·배달대행 이용
  022 객단가            023 하루 방문·배달·포장 수   024 근로형태별 근로자   029 수익성(영업이익률, 식재료+인건비 비율, 종사원당 매출)
  030 월평균 매출액     031 식재료비 품목 비중
읽기 전에
  - 전국 값이다 (서울만의 값은 업종 세분류로 나오지 않는다).
  - '분식'은 조사의 '김밥 및 기타 간이 음식점업'이다. 서울시 상권분석서비스의 분식전문점(CS100008)과 범위가 조금 다르다.
  - 023의 방문은 명, 배달·포장은 인분이라 단위가 다르다. 주문 비중을 낼 때 1명 = 1인분으로 본다 (가정).
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "quickfood_krei.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
META = "https://kosis.kr/openapi/statisticsData.do"
CODES = {"chicken": "A02020303", "bunsik": "A02020304"}
TABLES = ["004", "009", "012", "016", "022", "023", "024", "029", "030", "031"]


def get(url: str, params: dict) -> list[dict]:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=90) as r:
                d = json.loads(r.read().decode("utf-8"))
            if isinstance(d, list):
                return d
            raise RuntimeError(str(d)[:200])
        except Exception as e:  # 오류 문구에 키가 섞일 수 있다
            last = mask(str(e))
            time.sleep(2 + attempt * 2)
    raise SystemExit(f"KOSIS 요청 실패: {last}")


def table(k: str, tbl: str) -> list[dict]:
    meta = get(META, {"method": "getMeta", "type": "ITM", "apiKey": k, "format": "json", "jsonVD": "Y", "orgId": "114", "tblId": tbl})
    objs = sorted({r["OBJ_ID"] for r in meta if r["OBJ_ID"] != "ITEM"})
    p = {"method": "getList", "apiKey": k, "format": "json", "jsonVD": "Y", "orgId": "114", "tblId": tbl,
         "itmId": "ALL", "prdSe": "Y", "newEstPrdCnt": "1"}
    for i, o in enumerate(objs):
        p[f"objL{i + 1}"] = "+".join(CODES.values()) + "+" if o == "A" else "ALL"
    return get(URL, p)


def num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main() -> None:
    k = key("KOSIS_API_KEY", fallback=None)
    rows = {t: table(k, f"DT_114054_{t}") for t in TABLES}
    year = next((r.get("PRD_DE") for r in rows["029"]), None)
    out: dict = {"_meta": {"source": "외식업체 경영실태조사 (농림축산식품부, KOSIS orgId 114, DT_114054_*)", "survey_year": year,
                           "basis": "전년도 실적, 전국", "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                           "method": "pipelines/fetch_krei_quickfood.py",
                           "caveat": ["전국 값 (서울 세분류 값 없음)", "분식 = 김밥 및 기타 간이 음식점업",
                                      "방문(명)과 배달·포장(인분)을 같은 단위로 보고 주문 비중을 냄 (가정)"]}}
    for ind, code in CODES.items():
        pick = lambda t: [r for r in rows[t] if r.get("C1") == code]  # noqa: E731
        avg = lambda t, unit=None: [num(r["DT"]) for r in pick(t) if r.get("C2_NM") == "평균" and (unit is None or r.get("UNIT_NM") == unit)]  # noqa: E731
        prof = {r["ITM_NM"]: num(r["DT"]) for r in pick("029")}
        visit, deliv_take, *rest = avg("023")
        delivery, takeout = (rest + [None, None])[:2] if rest else (None, None)
        # 023의 평균 줄 순서: 방문(명), 배달/테이크아웃(인분), 배달(인분), 테이크아웃(인분). 합계 줄이 빠지는 경우가 있어 이름 대신 순서로 읽는다
        vals = avg("023")
        if len(vals) == 3:   # 배달/테이크아웃 합계 줄이 없다
            visit, delivery, takeout = vals
        elif len(vals) >= 4:
            visit, _, delivery, takeout = vals[:4]
        apps = {(r.get("C2_NM"), r.get("C3_NM")): num(r["DT"]) for r in pick("016")}
        labor = {}
        for r in pick("024"):
            labor.setdefault(r.get("C2_NM"), {})[r.get("ITM_NM")] = num(r["DT"])
        food_mix = {r.get("C2_NM"): num(r["DT"]) for r in pick("031")}
        hours = avg("009")
        out[ind] = {
            "name": next((r.get("C1_NM") for r in pick("029")), ind),
            "sales_month_man": next((num(r["DT"]) for r in pick("030")), None),
            "op_margin": (prof.get("매출액 대비 영업이익률") or 0) / 100,
            "food_labor_ratio": (prof.get("매출 대비 식재료 및 인건비 비율") or 0) / 100,
            "sales_per_worker_year_man": prof.get("종사원 당 매출액"),
            "sales_per_pyeong_year_man": prof.get("평당 매출액"),
            "ticket_krw": (avg("022") or [None])[0],
            "visit_per_day": visit, "delivery_per_day": delivery, "takeout_per_day": takeout,
            "delivery_app_use": apps.get(("배달앱", "예")), "delivery_app_fee_month_krw": apps.get(("배달앱", "평균")),
            "delivery_agency_use": apps.get(("배달대행", "예")), "delivery_agency_fee_month_krw": apps.get(("배달대행", "평균")),
            "interior_total_man": (avg("012", "만원") or [None])[0],
            "area_m2": (avg("004") or [None])[0],
            "hours_per_day": hours[0] if hours else None, "open_days": hours[1] if len(hours) > 1 else None,
            "workers": labor.get("전체", {}).get("월 평균 근로자수"),
            "family_unpaid": labor.get("무급 가족", {}).get("월 평균 근로자수"),
            "wage_month_man": labor.get("전체", {}).get("월 평균 인건비"),
            "food_mix_pct": food_mix,
        }
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    for ind in CODES:
        v = out[ind]
        print(ind, {k2: v[k2] for k2 in ("sales_month_man", "op_margin", "food_labor_ratio", "ticket_krw", "visit_per_day", "delivery_per_day", "takeout_per_day", "workers", "wage_month_man", "interior_total_man", "area_m2")})


if __name__ == "__main__":
    main()
