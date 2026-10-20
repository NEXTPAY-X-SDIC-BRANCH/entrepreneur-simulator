"""store_input.from_changeup 의 flow(동네 요일·시간대·연령 비율)가 엔진 profile 덮어쓰기로 바뀐다."""
import pytest

from sim.store_input import from_changeup

BASE = dict(gu_sales_man=2400, pyeong=20, tables=9, seats=36, cash_rent_man_per_pyeong=17.1)


def test_flow_becomes_profile_override_and_is_normalised():
    flow = {"dow": [1, 1, 1, 1, 2, 2, 1], "band": [1, 1, 1, 1, 2, 1], "age": [1, 2, 3, 2, 1, 1]}
    store, _ = from_changeup(**BASE, flow=flow)
    p = store["profile"]
    assert set(p) == {"dow_share", "timeband_share", "age_share"}
    assert abs(sum(p["dow_share"].values()) - 1) < 1e-9 and p["dow_share"]["fri"] == pytest.approx(2 / 9)
    assert p["timeband_share"]["t17_21"] == pytest.approx(2 / 7) and p["age_share"]["age30"] == pytest.approx(3 / 10)


def test_no_flow_keeps_reference_profile():
    store, _ = from_changeup(**BASE)
    assert "profile" not in store


def test_bad_flow_is_rejected():
    with pytest.raises(ValueError):
        from_changeup(**BASE, flow={"dow": [1] * 6, "band": [1] * 6, "age": [1] * 6})
