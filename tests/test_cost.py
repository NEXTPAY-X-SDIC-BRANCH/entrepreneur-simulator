"""cost lane: 비용 쌓기 (인건비·매장 운영비가 빠짐없이 영업이익에 들어가고, 내역의 합이 총액과 같은지)."""
import pytest

from sim import opex
from sim.cafe import season as CS
from sim.cafe.params import v as cv

CAFE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
            showcase=1, oven=1, kiosks=1, pos=1, own_capital_krw=300_000_000)


def test_opex_yaml_shares_and_survey():
    o = opex.load()
    for block in ("bbq_utilities", "bbq_other_opex"):
        assert abs(sum(r["share"] for r in o[block]) - 1) < 1e-9, block
        assert all(r["grade"] == "가정" for r in o[block])          # 내역 비율은 가정으로만 표시
    for key in ("bbq_meat", "restaurant_seoul"):                    # 평균 표: 비용 + 영업이익 = 매출
        sh = o["survey"][key]["shares"]
        assert abs(sum(sh.values()) - 1) < 0.005, (key, sum(sh.values()))
        assert o["survey"][key]["grade"] == "조사"


def test_bbq_detail_sums_to_mgmt():
    k = {"mgmt": 3_712_345.6, "opex_util": 1_700_000, "opex_other": 1_500_000, "opex_mkt": 500_000}
    d = opex.bbq_detail(k)
    assert sum(d.values()) == round(k["mgmt"])
    assert d["마케팅 (SNS 협찬·리뷰 이벤트)"] == 500_000
    assert d["이달 사건 대응"] == round(k["mgmt"]) - 3_700_000      # 남는 몫 = 사건·밤 결정 비용
    assert "가스 (불판·주방)" in d and "세무 기장" in d
    # 사건이 없는 달: 반올림 차이 몇 원으로 '이달 사건 대응' 줄이 생기지 않는다
    d0 = opex.bbq_detail({"mgmt": 1_020_001.4, "opex_util": 612_000.3, "opex_other": 408_001.1, "opex_mkt": 0})
    assert "이달 사건 대응" not in d0 and sum(d0.values()) == round(1_020_001.4)
    # 예전 캐시처럼 내역 키가 없으면 총액 한 줄
    assert opex.bbq_detail({"mgmt": 100.4}) == {"매장 운영비": 100}


def test_bbq_month_has_owner_and_opex_detail():
    from api.changeup import _cost_kpis, _owner_wage
    from sim import season as S
    st = S.new_season(7, opening=True, cash=60_000_000)
    r = S.play_month(st, S.base_plan(), [], night=False, band_runs=1)
    k = r["draw"]["kpis"]
    assert k["labor_owner"] == _owner_wage() and k["labor"] > k["labor_owner"]
    assert abs(k["opex_util"] + k["opex_other"] + k["opex_mkt"] - k["mgmt"]) < 1
    c = _cost_kpis(k)
    assert abs(c["labor_owner"] + c["labor_hired"] - k["labor"]) < 1
    assert abs(sum(c["opex_detail"].values()) - k["mgmt"]) <= 1
    # 영업이익 = 매출 − (재료비 + 인건비(사장 포함) + 임차료 + 운영비 + 수수료): 빠진 비용이 없다
    assert abs(k["revenue"] - (k["cogs"] + k["labor"] + k["rent"] + k["mgmt"] + k["fees"]) - k["op"]) < 1


@pytest.fixture(scope="module")
def cafe_month():
    run = CS.start({**CAFE, "seed": 3, "daily_customers": 200})
    return CS.play_month(run, {})[1]


def test_cafe_op_is_after_owner_pay(cafe_month):
    lines = {x["key"]: x for x in cafe_month["pnl"]["lines"]}
    assert lines["owner"]["krw"] == cv("opex", "owner_pay_krw") == 2_110_000
    assert lines["owner"]["item_ko"] == "사장 가상 급여"
    p = cafe_month["pnl"]
    assert p["op_krw"] == p["revenue_krw"] - sum(x["krw"] for x in p["lines"]) - p["depreciation_krw"]


def test_cafe_month_line_matches_pnl(cafe_month):
    ml = cafe_month["month_line"]
    assert ml["revenue"] == cafe_month["kpi"]["revenue_krw"] and ml["op"] == cafe_month["kpi"]["op_krw"]
    assert ml["revenue"] - (ml["cogs"] + ml["labor"] + ml["rent"] + ml["mgmt"] + ml["fees"] + ml["depreciation"]) == ml["op"]
    assert ml["labor_owner"] == 2_110_000 and ml["labor_hired"] + ml["labor_owner"] == ml["labor"]
    assert sum(ml["opex_detail"].values()) == ml["mgmt"]
    assert {"전기", "관리비", "소모품", "포장재"} <= set(ml["opex_detail"])
    assert all(x >= 0 for x in ml["opex_detail"].values())


def test_cafe_owner_pay_moves_op_not_cash(monkeypatch):
    """사장 가상 급여는 영업이익에서만 빠지고 현금 경로(와 폐업 판정)는 그대로: bbq 화면처럼 현금 장부에서는 되돌린다."""
    from sim.cafe.params import load_params
    body = {**CAFE, "seed": 5, "daily_customers": 90, "own_capital_krw": 80_000_000, "extra_loan_krw": 0}

    def season():
        run = CS.start(body)
        out = []
        while not run["state"]["closed"] and len(run["months"]) < run["months_total"]:
            run, mo = CS.play_month(run, {})
            out.append(mo)
        return out

    with_pay = season()
    monkeypatch.setitem(load_params()["opex"]["owner_pay_krw"], "value", 0)
    without = season()
    assert len(with_pay) == len(without)
    for a, b in zip(with_pay, without):
        assert a["kpi"]["op_krw"] == b["kpi"]["op_krw"] - 2_110_000
        assert a["kpi"]["cash_krw"] == b["kpi"]["cash_krw"] and a["status"] == b["status"]
        assert a["cash"]["owner_pay_addback_krw"] == 2_110_000 and b["cash"]["owner_pay_addback_krw"] == 0
