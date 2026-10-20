"""ChangeUp의 점포 입력(구, 평수, 테이블, 월세, 직원, 가격)을 엔진의 점포 덮어쓰기와 계획으로 바꾼다.

엔진은 혜화동 25평 한 곳을 기준으로 맞춰져 있다 (research/hero_base.yaml). 여기서 바꾸는 것은 아래 값뿐이고,
나머지(손님 구성, 체류 시간, 인건비 단가, 달력, 사건)는 기준 점포 그대로다.

    store, plan = from_changeup(gu_sales_man=2400, pyeong=20, tables=9, seats=36, cash_rent_man_per_pyeong=17.1, staff=3, price=19000)
    S.set_store(store)

덮어쓰는 것
  평수, 테이블 수, 테이블당 좌석, 야장(없음)          sto_area_pyeong, sto_tables, sto_seats_per_table, sto_terrace
  직원                                                sto_parttimers(계획의 staff_per_shift), sto_employees=0
  월세 (현금)                                          drv_rent = 평당 월세 × 평수
  공과금                                              cst_utilities = 기준 × 평수 / 25
  손님 규모                                            arrival_scale = 구 한식 점포 월매출 / 기준 상권 월매출(2,578만원)
  요일·시간대·연령 모양 (flow를 주면)                  profile.dow_share / timeband_share / age_share = 그 동네 길단위인구 비율
                                                      (서울시 상권분석서비스 길단위인구-행정동, pipelines/build_dong_flow.py). 안 주면 기준 상권(대학로) 값
한계: 달력(10~3월 대학로 행사), 사건 목록, 손님 구성(20대 학생 위주)은 아직 구별로 바꾸지 않았다.
"""
from __future__ import annotations

HERO_SALES_MAN = 2578   # 만원/월. 기준 상권 한식음식점 점포당 월매출 (hero_base 앵커)
HERO_PYEONG = 25
SCALE_RANGE = (0.4, 2.0)  # 구 값이 이상하게 커도 엔진이 맞춰진 범위를 크게 벗어나지 않게


CAMPUS_ONLY_EVENTS = ("festival_week", "exam_week")   # 대학가 행사. 다른 동네 유형에는 나오지 않게 뺀다


_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_BANDS = ["t00_06", "t06_11", "t11_14", "t14_17", "t17_21", "t21_24"]
_AGES = ["age10", "age20", "age30", "age40", "age50", "age60plus"]


def _flow_profile(flow: dict) -> dict:
    """flow = {"dow": [7 비율, 월..일], "band": [6 비율, 00~06..21~24], "age": [6 비율, 10대..60대 이상]} -> 엔진 profile 덮어쓰기."""
    out = {}
    for key, names, field in (("dow", _WEEK, "dow_share"), ("band", _BANDS, "timeband_share"), ("age", _AGES, "age_share")):
        v = [float(x) for x in flow[key]]
        if len(v) != len(names) or any(x < 0 for x in v) or sum(v) <= 0:
            raise ValueError(f"flow.{key}는 {len(names)}개의 0 이상 값이어야 합니다")
        t = sum(v)
        out[field] = {n: x / t for n, x in zip(names, v)}
    return out


def from_changeup(*, gu_sales_man: float, pyeong: float, tables: int, seats: int, cash_rent_man_per_pyeong: float,
                  staff: int = 3, price: int = 19000, baseline_runs: int = 150, quarter_index: list[float] | None = None,
                  area_type: str | None = None, start_month: int | None = None, n_months: int = 6,
                  flow: dict | None = None) -> tuple[dict, dict]:
    """quarter_index: 그 동네의 분기별 매출 지수(1~4분기, 연평균 1). 주면 달력 수요 지수를 이것으로 바꾼다.
    start_month: 시작 달(1~12). 없으면 엔진 기본(10월). 6개월을 이 달부터 돈다. calendar.yaml에 없는 달(4~9월)은 분기 지수로 채운다.
    area_type: "대학·청년"이면 대학가 달력과 행사를 그대로 두고, 그 밖의 유형은 달력을 분기 지수로, 대학가 행사를 뺀다."""
    tables = max(1, int(tables))
    per_table = min(6, max(2, round(seats / tables))) if seats else 4
    scale = min(SCALE_RANGE[1], max(SCALE_RANGE[0], gu_sales_man / HERO_SALES_MAN))
    store = {
        "params": {
            "sto_area_pyeong": float(pyeong),
            "sto_tables": tables,
            "sto_seats_per_table": int(per_table),
            "sto_terrace": 0,
            "sto_employees": 0,   # ChangeUp의 직원은 전부 홀 인력(교대 알바)으로 본다. 엔진의 정규직 1명은 서빙에 세지 않는다
            "drv_rent": round(float(cash_rent_man_per_pyeong) * float(pyeong) * 1e4),
            "cst_utilities": round(1_700_000 * float(pyeong) / HERO_PYEONG),
        },
        "arrival_scale": round(scale, 4),
        "baseline_runs": int(baseline_runs),
    }
    if flow:
        store["profile"] = _flow_profile(flow)
    campus = area_type in (None, "", "대학·청년")
    if start_month:
        sm = int(start_month)
        store["months"] = [(sm - 1 + i) % 12 + 1 for i in range(n_months)]
    if quarter_index:
        q = [float(x) for x in quarter_index]   # 1~4분기, 연평균 1
        qm = lambda m: q[(m - 1) // 3]          # 월 분할은 하지 않는다 (가정)
        if not campus:
            store["calendar"] = {"demand_index": {str(m): qm(m) for m in range(1, 13)},
                                 "neutral_segments": True, "note": f"{area_type} 동네, 분기 지수"}
        else:
            # 대학가: 달력 있는 달(10~3월)은 엔진 값 그대로. 달력 밖의 달만 분기 지수(10월 분기 대비)로 채운다
            extra = {str(m): qm(m) / q[3] for m in range(4, 10)}
            store["calendar"] = {"demand_index": extra, "neutral_segments": False, "note": "대학가, 달력 밖의 달은 분기 지수"}
    if not campus:
        store["excluded_events"] = list(CAMPUS_ONLY_EVENTS)
    # 직원: 엔진은 교대 알바 수(0~4)가 서빙 인력이다. 인건비는 알바 시급 × 근무시간으로 계산돼 목업의 직원 1명 약 200만원과 비슷하다
    plan = {"meat_price": int(price), "staff_per_shift": min(4, max(0, int(staff))), "terrace": False}
    return store, plan
