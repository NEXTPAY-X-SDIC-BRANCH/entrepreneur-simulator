"""lab:pork — 돼지고기 도매가 예측: 방법, 백테스트, 엔진 배수, 엔진 플래그, API."""
import json
import math

import pytest

from pipelines import build_pork_forecast as B
from sim import pork_forecast as PF

DOC = json.loads(B.OUT.read_text(encoding="utf-8"))


def _synthetic(n=60, growth=0.004, amp=0.12, start="2020-01"):
    pts = []
    for i in range(n):
        ym = B.ym_add(start, i)
        m = int(ym[5:7])
        pts.append((ym, 10000 * (1 + growth) ** i * (1 + amp * math.sin(2 * math.pi * m / 12))))
    return pts


# --- methods ------------------------------------------------------------------------------------------------
def test_ceo_rule_is_last_year_same_month_times_inflation():
    vals = [100.0] * 12 + [110.0] * 12          # last year flat 100, this year flat 110 → +10%
    f = B.f_ceo(vals, list(range(1, 13)) * 2, 3)
    assert f == pytest.approx([110 * 1.1] * 3)
    assert B.f_ceo(vals, list(range(1, 13)) * 2, 2, infl=0.05) == pytest.approx([110 * 1.05] * 2)


def test_seasonal_method_recovers_a_clean_seasonal_series():
    pts = _synthetic()
    bt = B.backtest(pts, "seasonal", last=12)
    assert bt["mape_1_6"] < 1.5          # 깨끗한 계절 × 추세 자료는 거의 맞힌다
    assert bt["mape_1_6"] < B.backtest(pts, "naive", last=12)["mape_1_6"]


def test_backtest_uses_no_future_data():
    """기준 시점 뒤 값을 바꿔도 그 시점에서 만든 예측은 같아야 한다 (미래 정보 누수 없음)."""
    pts = _synthetic()
    vals = [p[1] for p in pts]; months = [int(p[0][5:7]) for p in pts]
    oi = 45
    for m in ("ceo", "seasonal"):
        a = B.METHODS[m](vals[:oi + 1], months[:oi + 1], 6)
        spoiled = vals[:oi + 1] + [v * 3 for v in vals[oi + 1:]]
        b = B.METHODS[m](spoiled[:oi + 1], months[:oi + 1], 6)
        assert a == b
    # backtest의 각 예측도 기준 시점까지만 본다: 마지막 달 값을 바꾸면 그 달 오차만 바뀐다
    pts2 = pts[:-1] + [(pts[-1][0], pts[-1][1] * 2)]
    r1 = B.backtest(pts, "ceo", last=12)["by_h"]; r2 = B.backtest(pts2, "ceo", last=12)["by_h"]
    assert r1 != r2


# --- the shipped JSON ---------------------------------------------------------------------------------------
def test_shipped_backtest_reproduces_from_cached_data():
    doc = B.build()
    for k in ("ceo", "ceo_cpi", "seasonal", "naive"):
        assert doc["backtest"][k]["mape_1_6"] == DOC["backtest"][k]["mape_1_6"], k
    assert doc["forecast"] == DOC["forecast"]


def test_shown_method_is_the_best_candidate_and_beats_naive():
    bt = DOC["backtest"]
    pick = DOC["_meta"]["method_key"]
    assert pick in B.CANDIDATES
    assert bt[pick]["mape_1_6"] == min(bt[m]["mape_1_6"] for m in B.CANDIDATES)
    assert bt[pick]["mape_1_6"] < bt["naive"]["mape_1_6"]
    assert DOC["_meta"]["backtest_mape"] == bt[pick]["mape_1_6"]
    assert bt[pick]["n"] >= 6 * 20               # 24개월 × 1~12개월 앞, 앞쪽 일부 제외


def test_contract_shape_and_band_order():
    assert set(DOC) >= {"_meta", "history", "forecast", "drivers"}
    assert set(DOC["_meta"]) >= {"source", "method", "backtest_mape", "basis_date"}
    assert len(DOC["forecast"]) == 6
    last = max(DOC["history"])
    assert min(DOC["forecast"]) > last
    for v in DOC["forecast"].values():
        assert v["lo"] <= v["mid"] <= v["hi"]
    kinds = {d["kind"] for d in DOC["drivers"]}
    assert {"season", "disease", "weather", "supply"} <= kinds
    for d in DOC["drivers"]:
        assert d["sources"], d["label"]
        for s in d["sources"]:
            assert s.get("publisher")


def test_disease_events_are_history_not_forecast_inputs():
    ev = next(d for d in DOC["drivers"] if d["kind"] == "disease")["data"]["events"]
    assert all(e["date"] <= DOC["_meta"]["basis_date"] + "-31" for e in ev)
    assert all(e["source"]["url"].startswith("https://") for e in ev)
    # 예측 방법은 질병 사건 목록을 받지 않는다
    for fn in (B.f_ceo, B.f_seasonal):
        assert "event" not in fn.__code__.co_varnames


# --- engine multiplier ----------------------------------------------------------------------------------
def test_meat_cost_mult_matches_forecast_over_base():
    base = DOC["cost_mult"]["base_value"]
    for k, f in DOC["forecast_12"].items():
        assert PF.meat_cost_mult(int(k[4:])) == pytest.approx(f["mid"] / base, abs=1e-4)


def test_meat_cost_mult_falls_back_to_one(monkeypatch, tmp_path):
    monkeypatch.setattr(PF, "FORECAST", tmp_path / "missing.json")
    PF.reload()
    try:
        assert all(PF.meat_cost_mult(m) == 1.0 for m in range(1, 13))
        bad = tmp_path / "bad.json"
        bad.write_text(json.dumps({"cost_mult": {"by_month": {"10": 9.0, "11": -1, "x": 2}}}))
        monkeypatch.setattr(PF, "FORECAST", bad)
        PF.reload()
        assert PF.meat_cost_mult(10) == PF.CLAMP[1] and PF.meat_cost_mult(11) == 1.0
    finally:
        monkeypatch.undo()
        PF.reload()


def test_engine_setup_applies_mult_only_when_flagged():
    from sim import season as S
    st = S.new_season(42)
    m = S.current_month(st)
    f = PF.meat_cost_mult(m)
    for grade, strength in (("domestic", 1.0), ("imported", S.v("meat_grade.pork_event_strength_imported")),
                            ("aged", S.v("meat_grade.pork_event_strength_aged"))):
        plan = {**S.base_plan(), "meat_grade": grade}
        off = S._setup(st, plan, [])["params"]["cst_meat_cost_per_portion"]
        off2 = S._setup(st, {**plan, "use_pork_forecast": False}, [])["params"]["cst_meat_cost_per_portion"]
        on = S._setup(st, {**plan, "use_pork_forecast": True}, [])["params"]["cst_meat_cost_per_portion"]
        # lab:merge 끄면 upstream 달별 원가 지수(calendar cost_index.meat)를, 켜면 그 대신 예측 배율을 쓴다 (두 번 곱하지 않는다)
        ci = (S._calendar(m).get("cost_index") or {}).get("meat", 1.0)
        base = S.data()["P"]["meat_grade"][grade]["cost"]
        assert off == off2 == pytest.approx(base * ci)
        assert on == pytest.approx(base * (1 + (f - 1) * strength))


def test_engine_month_identical_when_flag_off_and_cheaper_meat_when_mult_below_one():
    from sim import season as S
    st = S.new_season(42)
    k = ("revenue", "covers", "cogs", "op", "labor")
    a = S.play_month(st, S.base_plan(), [], night=False, band_runs=1)["draw"]["kpis"]
    b = S.play_month(st, {**S.base_plan(), "use_pork_forecast": False}, [], night=False, band_runs=1)["draw"]["kpis"]
    assert {x: a[x] for x in k} == {x: b[x] for x in k}
    c = S.play_month(st, {**S.base_plan(), "use_pork_forecast": True}, [], night=False, band_runs=1)["draw"]["kpis"]
    f = PF.meat_cost_mult(S.current_month(st))
    assert c["revenue"] == a["revenue"] and c["covers"] == a["covers"]
    assert (c["cogs"] < a["cogs"]) == (f < 1) and (c["cogs"] > a["cogs"]) == (f > 1)


# --- API ----------------------------------------------------------------------------------------------------
def test_api_routes():
    from fastapi.testclient import TestClient
    from api import changeup
    c = TestClient(changeup.app)
    r = c.get("/lab/pork/mult")
    assert r.status_code == 200
    j = r.json()
    assert j["basis_date"] == DOC["_meta"]["basis_date"] and len(j["by_month"]) == 12
    assert c.get("/lab/pork/forecast").json()["_meta"]["method_key"] == DOC["_meta"]["method_key"]


def test_carcass_comparison_uses_the_same_method_and_latest_is_labelled():
    assert DOC["carcass"]["method_key"] == DOC["_meta"]["method_key"]
    lt = DOC.get("latest") or {}
    if lt.get("belly_vs"):
        v = lt["belly_vs"]; w = lt["belly_weeks"][0]["belly"]
        assert v["where"] == ("in" if v["lo"] <= w <= v["hi"] else "above" if w > v["hi"] else "below")
