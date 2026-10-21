"""Cafe fixes before the 10-24 demo (lab 2026-10-22).

A: one source for the opening cost and loan. 가게 꾸미기 (CafeBuild), the sim intro (CafeSim) and 이지 모드 all read the
   engine's preview `capex` + `funding`; season.start uses the same `funding` rule, so the numbers cannot drift.
B: daily-customer calibration divides by the uncapped demand revenue, so revenue no longer falls as the store grows.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.changeup import app
from sim.cafe import model as cm
from sim import easy as E
from sim.cafe import season as cs

PREVIEW_DROP = ("seed", "start_month", "extra_loan_krw", "menu", "daily_customers")


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _hard_preview(body: dict) -> tuple[dict, int]:
    """What CafeBuild and CafeSim do: preview without daily_customers, cafeDaily, preview again with it."""
    base = {k: x for k, x in body.items() if k not in PREVIEW_DROP}
    p0 = cm.preview(base)
    daily = E.cafe_daily(p0, E.gu_stat("cafe", body["_gu"], body["_dong"])["sales"], E.cafe_area_fx(body["size_pyeong"]))
    return cm.preview({**base, "daily_customers": daily}), daily


@pytest.mark.parametrize("capital", [12000, 3000])
def test_opening_cost_and_loan_match_across_screens(client, capital):
    r = client.post("/lab/easy/run", json={"industry": "cafe", "gu": "마포구", "capital_man": capital, "start_month": 3})
    assert r.status_code == 200
    out = r.json()
    inp, easy_start = out["inputs"], out["cafe"]["start"]["start"]
    run = inp["run"]
    pv, daily = _hard_preview({**run, "_gu": "마포구", "_dong": inp["dong"]})
    assert daily == run["daily_customers"]                              # 이지 = 하드 손님 수
    f = pv["funding"]
    # 가게 꾸미기 / sim intro (preview funding) == 이지 결과 (season start) == the season the hard sim starts
    season = client.post("/cafe/season", json={k: x for k, x in run.items() if k != "menu"}).json()["start"]
    for s in (easy_start, season):
        assert s["capex_krw"] == pv["capex"]["total_krw"] == f["capex_krw"]
        assert s["loan_krw"] == f["loan_krw"]
        assert s["cash_krw"] == f["cash_krw"]
    assert inp["opening_total"] == round(pv["capex"]["total_krw"] / 10000)
    labels = {x["label"] for x in inp["opening"]}
    assert {"권리금", "보증금"} <= labels and any(x.startswith("부가세") for x in labels)   # the lines the build screen left out
    assert f["cash_krw"] > 0                                            # HUD before opening is not 0만원
    if capital == 3000:
        assert f["capex_gap_krw"] == f["capex_krw"] - f["own_capital_krw"] > 0 and f["loan_krw"] > f["capex_gap_krw"]


def test_funding_rule():
    f = cm.funding(100_000_000, 30_000_000, 10_000_000)
    assert f["capex_gap_krw"] == 70_000_000 and f["extra_loan_krw"] == 30_000_000 and f["cash_krw"] == 30_000_000
    rich = cm.funding(100_000_000, 200_000_000, 10_000_000)
    assert rich["loan_krw"] == 0 and rich["loan_payment_krw"] == 0 and rich["cash_krw"] == 100_000_000
    fixed = cm.funding(100_000_000, 30_000_000, 10_000_000, extra_loan_krw=0)
    assert fixed["loan_krw"] == 70_000_000 and fixed["cash_krw"] == 0 and fixed["loan_payment_krw"] > 0


def test_season_start_uses_the_preview_funding():
    a = E.easy_inputs("cafe", "마포구", 5000, pyeong=20)
    run = cs.start(dict(a["run"]))
    pv = cm.preview({k: x for k, x in a["run"].items() if k not in ("seed", "start_month", "extra_loan_krw", "menu")})
    assert run["start"]["loan_krw"] == pv["funding"]["loan_krw"] and run["start"]["cash_krw"] == pv["funding"]["cash_krw"]


def test_area_fx_is_monotone_and_keeps_the_buckets():
    fx = [E.cafe_area_fx(p) for p in range(10, 41)]
    assert all(b >= a for a, b in zip(fx, fx[1:]))
    assert E.cafe_area_fx(10) == pytest.approx(0.89) and E.cafe_area_fx(20) == pytest.approx(1.0)
    assert E.cafe_area_fx(35) == pytest.approx(1.37) and E.cafe_area_fx(40) == pytest.approx(1.37)


@pytest.mark.parametrize("gu", ["마포구", "강남구"])
def test_revenue_non_decreasing_in_pyeong(gu):
    rev, daily = [], []
    for p in range(10, 31, 2):
        a = E.easy_inputs("cafe", gu, 12000, pyeong=p)
        out = E.run_cafe(a["run"])
        months = [m for m in out["months"]]
        rev.append(sum(m["kpi"]["revenue_krw"] for m in months) / len(months))
        daily.append(a["run"]["daily_customers"])
    assert all(b >= a - 1 for a, b in zip(rev, rev[1:])), rev     # 1원 slack for rounding
    assert all(b >= a for a, b in zip(daily, daily[1:])), daily
    assert rev[-1] > rev[0]
