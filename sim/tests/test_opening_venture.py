"""신규 오픈 시작 상태(new_season(opening=True))와 투자·대출 계층(sim.venture)."""
import pytest

from sim import season as S
from sim.venture import loan_schedule, venture_ledger


def run(opening: bool, seed: int = 42, months: int = 6):
    s = S.new_season(seed, opening=opening)
    out = []
    for _ in range(months):
        r = S.play_month(s, S.base_plan(), night=False, band_runs=1)
        s = r["state_after"]
        out.append(r)
    return out, s


def test_default_state_is_unchanged():
    s = S.new_season(7)
    assert s["review_count"] == 180 and s["regular_share"] == 0.25 and s["awareness"] == 1.0 and s["opening"] is False


def test_opening_state_starts_with_no_reviews_and_few_regulars():
    s = S.new_season(7, opening=True)
    assert s["review_count"] == 0 and s["regular_share"] < 0.1 and s["awareness"] < 1.0 and s["opening"] is True


def test_cash_override():
    assert S.new_season(7, opening=True, cash=12345678)["cash"] == 12345678


def test_new_store_sells_less_than_established_and_catches_up():
    est, _ = run(False)
    new, end = run(True)
    r_est = [m["draw"]["kpis"]["revenue"] for m in est]
    r_new = [m["draw"]["kpis"]["revenue"] for m in new]
    assert r_new[0] < 0.85 * r_est[0], "첫 달 매출이 기존 점포보다 눈에 띄게 낮아야 한다"
    assert sum(r_new) < sum(r_est)
    # 단골이 쌓인다: 6개월 뒤 시작보다 높고 상한을 넘지 않는다
    assert end["regular_share"] > 0.15 and end["regular_share"] <= S.v("regulars.max")


def test_regulars_accrue_only_while_below_established_level():
    s = S.new_season(3, opening=True)
    s["regular_share"] = S.v("start.regular_share")
    assert S._opening_accrual(s, 0.0) == 0.0
    s["regular_share"] = 0.05
    assert S._opening_accrual(s, 0.0) == pytest.approx(S.v("regulars.opening_accrual"))
    assert S._opening_accrual(s, -0.5) == pytest.approx(S.v("regulars.opening_accrual") / 2)
    s["opening"] = False
    assert S._opening_accrual(s, 0.0) == 0.0


def test_opening_is_deterministic():
    a, _ = run(True, seed=5, months=3)
    b, _ = run(True, seed=5, months=3)
    assert [m["draw"]["kpis"]["op"] for m in a] == [m["draw"]["kpis"]["op"] for m in b]


# --- venture -------------------------------------------------------------------------------------------
INVEST = {"deposit": 4000e4, "interior": 3000e4, "equip": 1500e4, "seat": 800e4}  # 원


def test_loan_interest_only_then_equal_principal():
    s = loan_schedule({"principal": 12e6, "annual_rate": 0.06, "term_months": 6, "grace_months": 2}, 6)
    assert s[0]["interest"] == pytest.approx(60000) and s[0]["principal"] == 0
    assert s[2]["principal"] == pytest.approx(3e6) and s[5]["balance"] == pytest.approx(0, abs=1)


def test_ledger_separates_owner_wage_and_refundable_deposit():
    ops = [-1e6, -1e6, 0, 1e6, 1e6, 1e6]
    L = venture_ledger(ops, INVEST, None, own_capital=1.2e8, owner_draw=2e6, imputed_owner_wage=3e6)
    assert L["spent"] == pytest.approx(5300e4) and L["deposit"] == pytest.approx(4000e4)
    assert L["start_cash"] == pytest.approx(1.2e8 - 9300e4)
    # 첫 달 영업 현금 = -100만 + 가상 임금 300만 - 생활비 200만 = 0
    assert L["rows"][0]["cash_op"] == pytest.approx(0)
    assert L["lowest_cash"] <= L["start_cash"]


def test_payback_is_extrapolated_and_flagged_as_estimate():
    ops = [5e6] * 6
    L = venture_ledger(ops, INVEST, None, own_capital=1.2e8, owner_draw=0.0, imputed_owner_wage=0.0)
    p = L["payback"]
    assert p["estimated"] is True and p["within_engine"] is False
    assert p["month"] == 6 + -(-int(5300e4 - 30e6) // int(5e6))  # 남은 2,300만원 / 500만원 = 5개월
    assert "추정" in L["note"]


def test_payback_none_when_losing_money():
    L = venture_ledger([-2e6] * 6, INVEST, None, own_capital=1.2e8)
    assert L["payback"]["month"] is None and "적자" in L["payback"]["reason"]


def test_payback_inside_engine_months_is_not_an_estimate():
    L = venture_ledger([2e7] * 6, INVEST, None, own_capital=1.2e8)
    assert L["payback"]["within_engine"] is True and L["payback"]["estimated"] is False and L["payback"]["month"] == 3


def test_engine_to_ledger_end_to_end():
    new, _ = run(True)
    ops = [m["draw"]["kpis"]["op"] for m in new]
    L = venture_ledger(ops, INVEST, {"principal": 3e7, "annual_rate": 0.06}, own_capital=1.0e8, owner_draw=2e6,
                       imputed_owner_wage=S.v("start.cash") * 0)
    assert len(L["rows"]) == 6 and L["rows"][-1]["cash"] == L["end_cash"]
