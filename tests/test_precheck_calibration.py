"""lab:cost — 열기 전 점검(web/src/mock/model.ts engineCovers)의 자리 잡힌 달 매출이 엔진과 ±10% 안인지.

model.ts 의 식과 계수를 여기 그대로 옮겨 둔다 (바꾸면 둘 다 바꾼다). 엔진(sim.season)이 바뀌어 어긋나면 이 테스트가 깨진다.
격자 전체(마포·강남·관악 × 12~25평 × 직원 0~4명, 75점) 맞춤의 최대 오차는 9.9%. 여기서는 대표 점 몇 개만 돈다.
"""
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GU = json.loads((ROOT / "web/public/mock/gu_stats.json").read_text(encoding="utf-8"))["bbq"]["gu"]
KREI = json.loads((ROOT / "web/public/mock/gogi_krei.json").read_text(encoding="utf-8"))["tables"]["pl_sales"]
UPLIFT = KREI["meat"]["values"]["평균"] / KREI["hansik_all"]["values"]["평균"]   # model.ts meatUplift()


def precheck_revenue(gu: str, seats: int, staff: int) -> float:
    demand = GU[gu]["sales_per_store_month"] * UPLIFT * 1e4 / (27000 * 26)    # model.ts simulate(): settled, 19,000원
    covers = ((0.92 * demand) ** -2.3 + (2.1 * seats) ** -2.3 + (34 * (staff + 1)) ** -2.3) ** (-1 / 2.3)
    return covers * 27000 * 26


def engine_settled_revenue(gu: str, pyeong: int, tables: int, staff: int) -> float:
    from sim import season as S
    from sim.store_input import from_changeup
    g = GU[gu]
    store, patch = from_changeup(gu_sales_man=g["sales_per_store_month"], pyeong=pyeong, tables=tables, seats=tables * 4,
                                 cash_rent_man_per_pyeong=17.0, staff=staff, price=19000, baseline_runs=40,
                                 quarter_index=g["quarter_index"], area_type="일반", start_month=11)
    S.set_store(store)
    try:
        st = S.new_season(11, opening=False, cash=60_000_000)
        plan = {**S.base_plan(), **patch, "staff_per_shift": staff}
        revs = []
        for _ in range(6):
            r = S.play_month(st, plan, None, night=False, band_runs=1)
            st = r["state_after"]
            revs.append(r["draw"]["kpis"]["revenue"])
            if st["closed"]:
                break
        return sum(revs) / len(revs)
    finally:
        S.set_store(None)


@pytest.mark.parametrize("gu,pyeong,staff", [("강남구", 18, 2), ("관악구", 15, 1), ("강남구", 12, 1)])
def test_precheck_revenue_within_10pct_of_engine(gu, pyeong, staff):
    tables = max(3, round(pyeong / 3))
    pre, eng = precheck_revenue(gu, tables * 4, staff), engine_settled_revenue(gu, pyeong, tables, staff)
    assert abs(pre / eng - 1) <= 0.10, (gu, pyeong, staff, round(pre), round(eng))
