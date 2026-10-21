"""lab:finance — 월세 카드 할부 (sim/rent_card.py)와 은행별 가상 금리 (web/public/mock/bank_rates.json)."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sim import rent_card as RC
from sim import season as S
from sim.cafe import season as CS
from sim.venture import venture_ledger

ROOT = Path(__file__).resolve().parents[1]
CAFE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
            showcase=1, oven=1, kiosks=1, pos=1, own_capital_krw=300_000_000)


# ---------------------------------------------------------------- 규칙 자체
def test_off_by_default_and_bad_input():
    assert RC.step(None, None, 3e6) is None
    assert RC.step([], {"months": 0}, 3e6) is None
    for bad in ({"months": 4}, {"months": "x"}, "3", 3, {"months": -2}):
        assert RC.normalize(bad) is None
    assert RC.normalize({"months": 3, "fee_rate": 9})["fee_rate"] == RC.MAX_FEE
    assert RC.normalize({"months": 3, "fee_rate": -1})["fee_rate"] == 0.0


def test_fee_grows_with_months_and_interest_free_is_service_only():
    f2, f3, f6 = (RC.default_fee_rate(m) for m in (2, 3, 6))
    assert RC.SERVICE_FEE < f2 < f3 < f6 < RC.MAX_FEE
    assert RC.default_fee_rate(6, interest_free=True) == RC.SERVICE_FEE
    assert RC.default_fee_rate(0) == 0.0


@pytest.mark.parametrize("months", [2, 3, 6])
def test_cash_shift_conserves_money(months):
    """N달 동안 같은 월세: 첫 달은 월세만큼 현금이 덜 나가고, 할부가 다 끝나면 더 낸 돈은 수수료뿐이다."""
    rent, fee = 3_000_000, 0.05
    rows = RC.schedule([rent] * 6 + [0] * months, {"months": months, "fee_rate": fee})
    assert rows[0]["paid"] == 0 and rows[0]["cash_delta"] == rent
    assert rows[1]["paid"] == pytest.approx(rent * (1 + fee) / months)
    total_delta = sum(r["cash_delta"] for r in rows)
    assert total_delta == pytest.approx(-6 * rent * fee)           # 추가로 나간 현금 = 수수료
    assert rows[-1]["balance"] == pytest.approx(0)
    assert sum(r["fee"] for r in rows) == pytest.approx(6 * rent * fee)


def test_switching_back_to_cash_still_pays_the_queue():
    a = RC.step([], {"months": 2, "fee_rate": 0}, 2e6)
    b = RC.step(a["queue"], None, 2e6)
    assert b is not None and b["paid"] == 1e6 and b["charged"] == 0 and b["balance"] == 1e6
    c = RC.step(b["queue"], None, 2e6)
    assert c["paid"] == 1e6 and c["balance"] == 0
    assert RC.step(c["queue"], None, 2e6) is None


# ---------------------------------------------------------------- 고깃집 엔진
def _month(plan_extra=None, state=None):
    st = state or S.new_season(7, opening=True, cash=5e7)
    return S.play_month(st, {**S.base_plan(), **(plan_extra or {})}, [], night=False, lean=True)


def test_bbq_default_plan_has_no_rent_card_keys():
    r = _month()
    assert "rent_card" not in r and "rent_card_queue" not in r["state_after"]


def test_bbq_rent_card_moves_cash_not_pnl():
    base, card = _month(), _month({"rent_card": {"months": 3}})
    assert card["draw"]["kpis"]["op"] == base["draw"]["kpis"]["op"]          # 손익 그대로
    assert card["draw"]["kpis"]["rent"] == base["draw"]["kpis"]["rent"]
    rent = base["draw"]["kpis"]["rent"]
    assert card["state_after"]["cash"] - base["state_after"]["cash"] == pytest.approx(rent, abs=1)
    rc = card["rent_card"]
    assert rc["paid"] == 0 and rc["charged"] == pytest.approx(rent, abs=1)
    assert rc["balance"] == pytest.approx(rent * (1 + RC.default_fee_rate(3)), abs=2)
    nxt = _month(None, card["state_after"])                                  # 다음 달은 현금으로 돌아가도 할부는 낸다
    assert nxt["rent_card"]["paid"] == pytest.approx(rc["balance"] / 3, abs=2)


def test_bbq_api_slim_passes_rent_card():
    from api.changeup import app
    c = TestClient(app)
    st = c.post("/season/new", json={"seed": 7, "cash": 5e7}).json()
    out = c.post("/season/play", json={"state": st, "plan": {"rent_card": {"months": 2}}, "night": False,
                                       "band_runs": 1}).json()
    assert out["result"]["rent_card"]["months"] == 2
    assert out["state"]["rent_card_queue"]
    plain = c.post("/season/play", json={"state": st, "night": False, "band_runs": 1}).json()
    assert "rent_card" not in plain["result"]
    assert out["state"]["cash"] - plain["state"]["cash"] == pytest.approx(out["result"]["rent_card"]["charged"], abs=1)


# ---------------------------------------------------------------- 투자·대출 장부
def test_ledger_identical_without_rent_card():
    args = ([1e6] * 6, {"deposit": 1e7, "interior": 2e7}, None)
    a = venture_ledger(*args, own_capital=5e7)
    b = venture_ledger(*args, own_capital=5e7, rent_card=None, monthly_rent=[3e6] * 6)
    c = venture_ledger(*args, own_capital=5e7, rent_card={"months": 3}, monthly_rent=None)
    assert a == b == c


def test_ledger_rent_card_balance_and_payback_cost():
    args = ([1e6] * 6, {"deposit": 1e7, "interior": 2e7}, None)
    a = venture_ledger(*args, own_capital=5e7)
    b = venture_ledger(*args, own_capital=5e7, rent_card={"months": 3, "fee_rate": 0.05}, monthly_rent=[3e6] * 6)
    fee = 6 * 3e6 * 0.05
    assert b["rows"][0]["cash"] - a["rows"][0]["cash"] == pytest.approx(3e6)
    # 남은 할부를 다 갚으면 현금 차이는 수수료뿐
    assert b["end_cash"] - b["rent_card"]["card_balance"] - a["end_cash"] == pytest.approx(-fee)
    assert b["rent_card"]["fee_total"] == pytest.approx(fee)
    assert b["rows"][-1]["cum_recovered"] == pytest.approx(a["rows"][-1]["cum_recovered"] - fee)


# ---------------------------------------------------------------- 카페 엔진
def test_cafe_default_unchanged_and_card_shifts_cash():
    a = CS.start({**CAFE, "seed": 2})
    b = CS.start({**CAFE, "seed": 2, "rent_card": {"months": 6, "fee_rate": 0.03}, "loan_rate": None})
    assert "rent_card" not in a and a["loan"] == b["loan"]
    a1, ma = CS.play_month(a, {})
    b1, mb = CS.play_month(b, {})
    rent = next(x["krw"] for x in ma["pnl"]["lines"] if x["key"] == "rent")
    assert ma["kpi"]["op_krw"] == mb["kpi"]["op_krw"]
    assert "rent_card" not in ma["cash"]
    rc = mb["cash"]["rent_card"]
    assert rc["charged"] == rent > 0
    assert mb["cash"]["end_krw"] - ma["cash"]["end_krw"] == rc["cash_delta"] == rc["charged"]
    b2, mb2 = CS.play_month(b1, {})
    assert mb2["cash"]["rent_card"]["paid"] == pytest.approx(rc["charged"] * 1.03 / 6, abs=1)


def test_cafe_loan_rate_override():
    a = CS.start({**CAFE, "own_capital_krw": 80_000_000, "seed": 0})
    b = CS.start({**CAFE, "own_capital_krw": 80_000_000, "seed": 0, "loan_rate": 0.0472})
    assert a["loan"]["rate"] == pytest.approx(0.045) and b["loan"]["rate"] == pytest.approx(0.0472)
    assert b["loan"]["monthly_payment_krw"] > a["loan"]["monthly_payment_krw"]
    _, ma = CS.play_month(a, {})
    _, mb = CS.play_month(b, {})
    assert mb["cash"]["loan_interest_krw"] > ma["cash"]["loan_interest_krw"]


def test_cafe_api_accepts_and_validates():
    from api.changeup import app
    c = TestClient(app)
    ok = c.post("/cafe/season", json={**CAFE, "rent_card": {"months": 3}, "loan_rate": 0.0418})
    assert ok.status_code == 200, ok.text
    assert ok.json()["rent_card"]["months"] == 3 and ok.json()["loan"]["rate"] == pytest.approx(0.0418)
    m = c.post("/cafe/season/month", json={"state_token": ok.json()["state_token"]}).json()
    assert m["cash"]["rent_card"]["paid"] == 0 and m["cash"]["rent_card"]["charged"] > 0
    plain = c.post("/cafe/season", json=CAFE).json()
    m0 = c.post("/cafe/season/month", json={"state_token": plain["state_token"]}).json()
    assert m["cash"]["end_krw"] - m0["cash"]["end_krw"] == m["cash"]["rent_card"]["charged"]
    assert c.post("/cafe/season", json={**CAFE, "rent_card": {"months": 4}}).status_code == 422
    assert c.post("/cafe/season", json={**CAFE, "loan_rate": 0.9}).status_code == 422


# ---------------------------------------------------------------- 은행별 가상 금리 자료
def test_bank_rates_json_is_labelled_and_link_only():
    d = json.loads((ROOT / "web/public/mock/bank_rates.json").read_text(encoding="utf-8"))
    ecos = json.loads((ROOT / "web/public/mock/ecos_rates.json").read_text(encoding="utf-8"))
    anchor = d["_meta"]["anchor"]
    assert anchor["rate"] == ecos["latest"]["loan_sme"]["rate"] and anchor["month"] == ecos["latest"]["loan_sme"]["month"]
    ids = [x["id"] for x in d["lenders"]]
    assert len(ids) == len(set(ids))
    names = " ".join(x["name"] for x in d["lenders"])
    for must in ("KB국민", "신한", "우리", "하나", "NH농협", "IBK기업", "카카오뱅크", "토스뱅크", "케이뱅크", "소상공인시장진흥공단", "서울신용보증재단"):
        assert must in names
    for x in d["lenders"]:
        assert x["url"].startswith("https://")
        assert x["label"] in ("가상 값", "공고 금리", "금리 공고 확인 필요")
        if x["label"] == "가상 값":
            assert x["rate"] == pytest.approx(anchor["rate"] + x["spread"], abs=0.005)
        if x["label"] == "공고 금리":
            assert x["source"] and x["as_of"]
        if x["label"] == "금리 공고 확인 필요":
            assert x["rate"] is None
        blob = json.dumps(x, ensure_ascii=False)
        assert "신청" not in blob.replace("신청 전", "") and "대출 받기" not in blob
    assert d["compare_url"].endswith("loan_snmindustry.php")


def test_web_preview_constants_match_engine():
    """화면 미리보기(web/src/lab/finance/finance.ts)는 엔진 식을 옮긴 것: 수수료 상수가 같아야 한다."""
    import re
    ts = (ROOT / "web/src/lab/finance/finance.ts").read_text(encoding="utf-8")
    assert float(re.search(r"export const SERVICE_FEE = ([0-9.]+)", ts).group(1)) == RC.SERVICE_FEE
    apr = re.search(r"INSTALLMENT_APR[^=]*= \{ 2: ([0-9.]+), 3: ([0-9.]+), 6: ([0-9.]+) \}", ts)
    assert tuple(float(x) for x in apr.groups()) == (RC.INSTALLMENT_APR[2], RC.INSTALLMENT_APR[3], RC.INSTALLMENT_APR[6])
