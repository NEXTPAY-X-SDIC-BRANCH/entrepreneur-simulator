"""lab:modes — 이지 모드 기본값(결정적, 자료 기반)과 민감도 격자 모양."""
import copy

import pytest
from fastapi.testclient import TestClient

from sim import easy as E


@pytest.fixture(scope="module")
def client():
    from api.changeup import app
    return TestClient(app)


# ---- 이지 기본값 -------------------------------------------------------------------------------------
def test_easy_bbq_is_deterministic_and_complete():
    a = E.easy_inputs("bbq", "마포구", 12000, start_month=11)
    b = E.easy_inputs("bbq", "마포구", 12000, start_month=11)
    assert a == b
    spec, plan = a["run"]["store"], a["run"]["plan"]
    for k in ("gu_sales_man", "pyeong", "tables", "seats", "cash_rent_man_per_pyeong", "staff", "price", "quarter_index",
              "area_type", "start_month"):
        assert spec[k] is not None, k
    assert 12 <= spec["pyeong"] <= 30 and spec["seats"] == spec["tables"] * 4
    assert 0 <= plan["staff_per_shift"] <= 4 and plan["meat_price"] == 19000
    assert a["run"]["seed"] == E.EASY_SEED
    # 여는 비용은 화면(openingCost)과 같은 줄, 원 단위로 엔진에 넘어간다
    assert set(a["run"]["invest"]) == {"deposit", "interior", "equip", "seat", "deco", "sign", "stock"}
    assert sum(a["run"]["invest"].values()) == pytest.approx(a["opening_total"] * 1e4)
    # 화면에 보여 줄 값마다 출처 구분이 있다
    assert all(x["src"] in ("공공 통계", "업계 자료", "가정", "입력") for x in a["shown"])


def test_easy_bbq_uses_real_rent_and_gu_sales():
    a = E.easy_inputs("bbq", "강남구", 20000)
    st = E.gu_stat("bbq", "강남구")
    assert st["rent_src"].startswith("R-ONE")
    assert a["run"]["store"]["cash_rent_man_per_pyeong"] == st["rent"]
    assert a["run"]["store"]["gu_sales_man"] == 3329   # gu_stats.json 강남구 sales_per_store_month


def test_easy_bbq_short_capital_borrows_enough_to_open():
    a = E.easy_inputs("bbq", "종로구", 3000)
    assert not a["fits_capital"] and a["loan_man"] > 0
    start = a["capital_man"] + a["loan_man"] - a["opening_total"]
    assert start > 0   # 모자란 돈 + 석 달 고정비를 빌린다


def test_easy_bbq_loan_override_too_small_is_rejected():
    with pytest.raises(ValueError, match="모자라요"):
        E.easy_inputs("bbq", "종로구", 3000, overrides={"loan_man": 0})
    ok = E.easy_inputs("bbq", "종로구", 3000, overrides={"loan_man": 5000})
    assert ok["capital_man"] + ok["loan_man"] >= ok["opening_total"]


def test_easy_bbq_pyeong_and_overrides_win():
    a = E.easy_inputs("bbq", "마포구", 15000, pyeong=25)
    assert a["store"]["pyeong"] == 25
    b = E.easy_inputs("bbq", "마포구", 15000, pyeong=25, overrides={"staff": 3, "price": 21000, "tables": 6})
    assert b["run"]["plan"]["staff_per_shift"] == 3 and b["run"]["plan"]["meat_price"] == 21000
    assert b["store"]["tables"] == 6 and b["run"]["store"]["price"] == 21000


def test_easy_cafe_is_deterministic_and_runs_six_months():
    from sim.cafe.params import load_districts
    a = E.easy_inputs("cafe", "마포구", 12000, start_month=3)
    assert a == E.easy_inputs("cafe", "마포구", 12000, start_month=3)
    assert a["run"]["district"] in load_districts()
    assert 10 <= a["run"]["daily_customers"] <= 600 and 10 <= a["pyeong"] <= 20
    out = E.run_cafe(a["run"])
    assert 1 <= len(out["months"]) <= 6 and out["report"]["months_played"] == len(out["months"])


def test_easy_rejects_bad_input():
    with pytest.raises(ValueError):
        E.easy_inputs("bbq", "없는구", 12000)
    with pytest.raises(ValueError):
        E.easy_inputs("pizza", "마포구", 12000)
    with pytest.raises(ValueError):
        E.easy_inputs("bbq", "마포구", 100)


def test_js_round_matches_math_round():
    assert [E.js_round(x) for x in (0.5, 1.5, 2.5, -0.5)] == [1, 2, 3, 0]


# ---- 민감도 ---------------------------------------------------------------------------------------------
def _shape(out, keys):
    assert [f["key"] for f in sorted(out["factors"], key=lambda f: keys.index(f["key"]))] == keys
    assert len(out["grid"]["cells"]) == 3 and all(len(r) == 3 for r in out["grid"]["cells"])
    assert out["grid"]["cells"][1][1] == out["base"]      # 격자 가운데 = 바꾸지 않은 판
    for c in [out["base"], out["worst"], out["best"], *(f["low"] for f in out["factors"])]:
        assert {"cum_op", "end_cash", "lowest_cash", "closed", "ops"} <= set(c)
    assert out["runs"] <= 15


def test_sensitivity_cafe_shape_and_direction():
    a = E.easy_inputs("cafe", "마포구", 12000)
    out = E.sensitivity_cafe(a["run"])
    _shape(out, ["customers", "food", "rent", "labor"])
    f = {x["key"]: x for x in out["factors"]}
    assert f["customers"]["high"]["cum_op"] > out["base"]["cum_op"] > f["customers"]["low"]["cum_op"]
    for k in ("food", "rent", "labor"):
        assert f[k]["high"]["end_cash"] < out["base"]["end_cash"] < f[k]["low"]["end_cash"]
    assert out["worst"]["end_cash"] <= min(c["end_cash"] for r in out["grid"]["cells"] for c in r)
    # 바꾸지 않은 칸은 평소 6개월과 같다 (폐업하지 않은 경우)
    run = E.run_cafe(a["run"])
    if run["report"]["survived"]:
        assert out["base"]["cum_op"] == run["report"]["cumulative_op_krw"]
        assert out["base"]["end_cash"] == run["report"]["end_cash_krw"]


def test_sensitivity_cafe_ranges_are_clamped():
    a = E.easy_inputs("cafe", "마포구", 12000)
    out = E.sensitivity_cafe(a["run"], {"rent": 999, "unknown": 5, "labor": -3})
    assert out["ranges"]["rent"] == E.MAX_RANGE and out["ranges"]["labor"] == 0 and "unknown" not in out["ranges"]


@pytest.fixture(scope="module")
def bbq_body():
    a = E.easy_inputs("bbq", "마포구", 12000, start_month=11)
    body = copy.deepcopy(a["run"])
    body["store"]["baseline_runs"] = 20   # 테스트용: 새 점포의 '평소' 계산을 짧게
    return body


def test_sensitivity_bbq_shape_and_cost_factors_are_exact(bbq_body):
    from sim import season as S
    orig = S._setup
    out = E.sensitivity_bbq(bbq_body, {"customers": 15, "meat": 20, "rent": 10, "labor": 10})
    assert S._setup is orig                       # 엔진 함수는 원래대로 돌아온다
    _shape(out, ["customers", "meat", "rent", "labor"])
    f = {x["key"]: x for x in out["factors"]}
    for k in ("meat", "rent", "labor"):
        assert f[k]["high"]["cum_op"] < out["base"]["cum_op"] < f[k]["low"]["cum_op"], k
    assert f["customers"]["high"]["revenue"] > out["base"]["revenue"] > f["customers"]["low"]["revenue"]
    # 월세는 고정비라 +10%면 6개월 영업이익이 정확히 월세 합계의 10%만큼 준다 (같은 시드, 손님 흐름 같음)
    base_rent = out["base"]["revenue"] - out["base"]["cum_op"]   # 비용 합 (참고용)
    assert base_rent > 0
    gap_hi = out["base"]["cum_op"] - f["rent"]["high"]["cum_op"]
    gap_lo = f["rent"]["low"]["cum_op"] - out["base"]["cum_op"]
    assert gap_hi == pytest.approx(gap_lo, rel=0.02, abs=2)


def test_scaled_restores_engine_on_error():
    from sim import season as S
    orig = S._setup
    with pytest.raises(RuntimeError):
        with E._scaled({"drv_rent": 1.1}):
            assert S._setup is not orig
            raise RuntimeError("boom")
    assert S._setup is orig


# ---- API -------------------------------------------------------------------------------------------------
def test_api_easy_defaults_and_validation(client):
    r = client.post("/lab/easy/defaults", json={"industry": "bbq", "gu": "마포구", "capital_man": 12000, "start_month": 11})
    assert r.status_code == 200 and r.json()["industry"] == "bbq"
    assert client.post("/lab/easy/defaults", json={"industry": "bbq", "gu": "없는구", "capital_man": 12000}).status_code == 422
    assert client.post("/lab/easy/defaults", json={"industry": "bbq", "gu": "마포구", "capital_man": 10}).status_code == 422


def test_api_easy_run_cafe_and_sensitivity(client):
    r = client.post("/lab/easy/run", json={"industry": "cafe", "gu": "마포구", "capital_man": 12000, "start_month": 3})
    assert r.status_code == 200
    body = r.json()["inputs"]["run"]
    s = client.post("/lab/sensitivity", json={"industry": "cafe", "body": body, "ranges": {"customers": 10}})
    assert s.status_code == 200 and s.json()["ranges"]["customers"] == 10
    assert client.post("/lab/sensitivity", json={"industry": "bbq", "body": {}}).status_code == 422
    bad = {**body, "district": "0000000"}
    assert client.post("/lab/sensitivity", json={"industry": "cafe", "body": bad}).status_code == 422
