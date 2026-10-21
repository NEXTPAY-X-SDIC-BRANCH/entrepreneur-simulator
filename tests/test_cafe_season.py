"""Cafe step 3 월별 운영: determinism, closure rule, decision directions, no dominant decision, API round trip."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import cafe as cafe_api
from sim.cafe import season as S
from sim.cafe.params import GRADES, load_params, v

N = v("season", "months")   # 한 시즌의 달 수 (research/cafe/params.yaml season.months)

ROOT = Path(__file__).resolve().parents[1]
STORE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
             showcase=1, oven=1, kiosks=1, pos=1, own_capital_krw=300_000_000)


def run_season(decisions=None, seed=3, **kw):
    """decisions: {month index: body}; months without an entry send {} (keep last month's choices)."""
    run = S.start({**STORE, **kw, "seed": seed})
    months = []
    while True:
        try:
            run, mo = S.play_month(run, (decisions or {}).get(len(months), {}))
        except S.SeasonOver:
            return run, months
        months.append(mo)


def first_month(body, seed=3, **kw):
    run = S.start({**STORE, **kw, "seed": seed})
    return S.play_month(run, body)[1]


def dumps(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False)


# ---------------------------------------------------------------------------------------------- determinism

def test_deterministic_given_seed_and_decisions():
    dec = {0: {"price_change_pct": 5, "marketing_krw": 500_000}, 4: {"hours": "long"}, 7: {"dessert": False}}
    a, b = run_season(dec, seed=11, daily_customers=200), run_season(dec, seed=11, daily_customers=200)
    assert dumps(a[1]) == dumps(b[1])
    assert dumps(S.report(a[0])) == dumps(S.report(b[0]))


def test_seed_changes_events_and_decisions_never_do():
    draws = {seed: [[e["key"] for e in m["events"]] for m in run_season(seed=seed, daily_customers=200)[1]]
             for seed in range(12)}
    assert len({dumps(x) for x in draws.values()}) > 1
    for seed in (0, 5):
        other = run_season({0: {"price_change_pct": 20, "staff_policy": "lean", "marketing_krw": 3_000_000}},
                           seed=seed, daily_customers=200)[1]
        keys = [[e["key"] for e in m["events"] if e["key"] != "viral"] for m in other]
        assert keys == [[k for k in x if k != "viral"] for x in draws[seed]]   # viral odds rise with marketing


# ---------------------------------------------------------------------------------------------- cash and closure

def test_start_cash_is_capital_plus_loan_minus_capex():
    run = S.start({**STORE, "own_capital_krw": 80_000_000, "extra_loan_krw": 0, "seed": 0})
    st = run["start"]
    assert st["loan_krw"] > 0 and st["cash_krw"] == 80_000_000 + st["loan_krw"] - st["capex_krw"] == 0
    assert run["loan"]["monthly_payment_krw"] > 0 and run["loan"]["grade"] in GRADES
    run2 = S.start({**STORE, "own_capital_krw": 80_000_000, "extra_loan_krw": 10_000_000, "seed": 0})
    assert run2["start"]["cash_krw"] == 10_000_000
    assert run2["loan"]["monthly_payment_krw"] > run["loan"]["monthly_payment_krw"]
    rich = S.start({**STORE, "seed": 0})
    assert rich["start"]["loan_krw"] == 0 and rich["loan"]["monthly_payment_krw"] == 0


def test_default_working_capital_reserve():
    """No extra_loan_krw: borrow just enough 운전자금 to open with working_capital_months of monthly fixed costs."""
    months = v("season", "working_capital_months")
    for capital in (0, 80_000_000, 170_000_000, 300_000_000):
        run = S.start({**STORE, "own_capital_krw": capital, "seed": 0})
        st = run["start"]
        fixed = S._context({**STORE, "own_capital_krw": capital})["preview"]["monthly_fixed"]["total_krw"]
        assert st["working_capital_target_krw"] == round(months * fixed)
        assert st["cash_krw"] == max(st["working_capital_target_krw"], capital - st["capex_krw"])
        assert st["extra_loan_krw"] == max(0, st["working_capital_target_krw"] - max(0, capital - st["capex_krw"]))
        assert "운전자금" in st["working_capital_note_ko"] and "가정" in st["working_capital_note_ko"]
    assert S.start({**STORE, "own_capital_krw": 300_000_000, "seed": 0})["start"]["extra_loan_krw"] == 0
    # the data-default store no longer closes in month 2: the reserve buys months to change course
    run, months = run_season(own_capital_krw=80_000_000)
    assert len(months) > 2 and months[0]["kpi"]["cash_krw"] > 0


def test_cash_identity_and_loan_line():
    run, months = run_season(own_capital_krw=80_000_000, daily_customers=150)
    prev_bal = run["start"]["loan_krw"]
    for mo in months:
        c = mo["cash"]
        assert c["end_krw"] == (c["start_krw"] + c["op_krw"] + c["depreciation_addback_krw"] - c["loan_interest_krw"]
                                - c["loan_principal_krw"] + c["vat_refund_krw"])
        assert c["loan_balance_krw"] == prev_bal - c["loan_principal_krw"] and c["loan_interest_krw"] > 0
        assert mo["kpi"]["loan_payment_krw"] == c["loan_interest_krw"] + c["loan_principal_krw"]
        prev_bal = c["loan_balance_krw"]
    assert [m["cash"]["vat_refund_krw"] > 0 for m in months] == [m["month"] == v("season", "vat_refund_month")
                                                                for m in months]


def test_closure_after_two_negative_months_only():
    # 44/day (the data default before the 10-14 demand anchor), cash 0, OP < 0
    run, months = run_season(own_capital_krw=80_000_000, extra_loan_krw=0, daily_customers=44)
    assert run["state"]["closed"] and len(months) == 2
    assert all(m["kpi"]["cash_krw"] < 0 for m in months)
    assert months[-1]["status"] == "closed" and months[-1]["closure"]["closed"] and months[-1]["closure"]["reason_ko"]
    assert months[0]["status"] == "open" and not months[0]["closure"]["closed"]
    with pytest.raises(S.SeasonOver):
        S.play_month(run, {})
    rep = S.report(run)
    assert rep["survived"] is False and rep["closed_month"] == 2 and rep["status"] == "closed"
    # one negative month (before the VAT refund lands) is survivable
    # lab:cost: 80 -> 100/day. OP now has 사장 가상 급여 (₩2.11M, survey basis) taken out, so the old 80/day store
    # closes; 100/day is the same story (month 1 negative, VAT refund in month 2 brings it back).
    run, months = run_season(own_capital_krw=80_000_000, extra_loan_krw=0, daily_customers=100, seed=0)
    assert months[0]["kpi"]["cash_krw"] < 0 and months[1]["kpi"]["cash_krw"] >= 0
    assert not run["state"]["closed"] and len(months) == N and S.report(run)["survived"]


# ---------------------------------------------------------------------------------------------- decisions

def _ctx_and_base(**kw):
    ctx = S._context({**STORE, **kw})
    f = S.baseline_factors({"hours": "standard", "staff_policy": "standard", "marketing_krw": 0, "dessert": True})
    return ctx, f


def test_price_elasticity_sign():
    ctx, f = _ctx_and_base()
    base, up, down = (S.evaluate(ctx, {**f, "price_level": p}) for p in (1.0, 1.1, 0.9))
    assert up["customers"] < base["customers"] < down["customers"]
    assert up["ticket_krw"] > base["ticket_krw"] > down["ticket_krw"]
    eps = v("season", "price_elasticity")
    assert up["customers"] / base["customers"] == pytest.approx(1.1 ** -eps, rel=0.01)
    # a rival nearby makes customers more price sensitive
    rival = S.evaluate(ctx, {**f, "rival": True}), S.evaluate(ctx, {**f, "rival": True, "price_level": 1.1})
    assert rival[1]["customers"] / rival[0]["customers"] < up["customers"] / base["customers"]


def _cost(mo, key):
    return next(x["krw"] for x in mo["pnl"]["lines"] if x["key"] == key)


def test_each_decision_moves_numbers_the_expected_way():
    std = first_month({}, daily_customers=200)
    up = first_month({"price_change_pct": 10}, daily_customers=200)
    assert up["kpi"]["customers"] < std["kpi"]["customers"] and up["kpi"]["ticket_krw"] > std["kpi"]["ticket_krw"]
    assert up["kpi"]["rating"] < std["kpi"]["rating"]

    long_, short = (first_month({"hours": h}, daily_customers=200) for h in ("long", "short"))
    assert long_["kpi"]["customers"] > std["kpi"]["customers"] > short["kpi"]["customers"]
    for key in ("labor", "utilities"):
        assert _cost(long_, key) > _cost(std, key) > _cost(short, key)
    assert long_["decisions"]["open_hour"] < std["decisions"]["open_hour"] < short["decisions"]["open_hour"]

    jam = {k: first_month({"staff_policy": k}, daily_customers=450) for k in ("lean", "standard", "generous")}
    assert _cost(jam["lean"], "labor") < _cost(jam["standard"], "labor") < _cost(jam["generous"], "labor")
    w = {k: x["kpi"]["walkaways"] for k, x in jam.items()}
    assert w["lean"] > w["standard"] > w["generous"]
    r = {k: x["kpi"]["rating"] for k, x in jam.items()}
    assert r["lean"] < r["standard"] < r["generous"]

    mkt = first_month({"marketing_krw": 1_000_000}, daily_customers=200)
    assert mkt["kpi"]["customers"] > std["kpi"]["customers"] and _cost(mkt, "marketing") == 1_000_000
    assert mkt["kpi"]["regulars"] >= std["kpi"]["regulars"]

    off = first_month({"dessert": False}, daily_customers=200)
    assert off["kpi"]["revenue_krw"] < std["kpi"]["revenue_krw"] and off["kpi"]["ticket_krw"] < std["kpi"]["ticket_krw"]
    assert _cost(off, "dessert_waste") == 0 < _cost(std, "dessert_waste")
    assert _cost(off, "labor") < _cost(std, "labor")
    assert off["pnl"]["dessert_revenue_krw"] == 0 < std["pnl"]["dessert_revenue_krw"]


def test_decisions_persist_and_price_change_is_one_time():
    run, months = run_season({0: {"price_change_pct": 10, "hours": "long", "dessert": False}}, daily_customers=200)
    assert months[0]["decisions"]["price_change_pct"] == 10 and months[1]["decisions"]["price_change_pct"] == 0
    assert all(m["decisions"]["price_level"] == pytest.approx(1.1) for m in months)
    assert all(m["decisions"]["hours"] == "long" and m["decisions"]["dessert"] is False for m in months)
    lo, hi = v("season", "price_level_range")
    run, months = run_season({i: {"price_change_pct": 30} for i in range(N)}, daily_customers=200)
    assert months[-1]["decisions"]["price_level"] == pytest.approx(hi)


SCENARIOS = {
    "대학로 data default": dict(),
    "대학로 44/day (quiet store)": dict(daily_customers=44),
    "대학로 120/day": dict(daily_customers=120),
    "대학로 250/day": dict(daily_customers=250),
    "대학로 450/day (capacity binds)": dict(daily_customers=450),
    "신촌 data default": dict(district="3120094"),
    "신촌, rival opens in month 1": dict(district="3120094", seed=9),
    "성수동카페거리 250/day": dict(district="3110131", daily_customers=250),
}
LEVERS = {
    "price +10%": {"price_change_pct": 10}, "price -10%": {"price_change_pct": -10},
    "short hours": {"hours": "short"}, "long hours": {"hours": "long"},
    "lean staff": {"staff_policy": "lean"}, "generous staff": {"staff_policy": "generous"},
    "marketing 1M": {"marketing_krw": 1_000_000}, "marketing 3M": {"marketing_krw": 3_000_000},
    "no dessert": {"dessert": False},
}
NEVER_WINS = {"marketing 3M"}   # allowed to lose everywhere; every other lever must win somewhere


def _cum(body, kw):
    kw = dict(kw)
    seed = kw.pop("seed", 3)
    return sum(m["kpi"]["op_krw"] for m in run_season({0: body}, seed=seed, **kw)[1])


def test_no_single_decision_dominates():
    """Each lever loses money (12-month OP vs keeping the defaults) in at least one scenario, so it has a modelled
    downside; each lever but the extreme one also wins somewhere, so it is a real choice."""
    base = {name: _cum({}, kw) for name, kw in SCENARIOS.items()}
    assert next(e for m in run_season(seed=9, district="3120094")[1][:1] for e in m["events"])["key"] == "rival"
    for lever, body in LEVERS.items():
        delta = {name: _cum(body, kw) - base[name] for name, kw in SCENARIOS.items()}
        assert min(delta.values()) < 0, (lever, delta)
        if lever not in NEVER_WINS:
            assert max(delta.values()) > 0, (lever, delta)


# ---------------------------------------------------------------------------------------------- waterfall, report, grades

def test_waterfall_sums_and_report_drivers_sum():
    run, months = run_season({0: {"price_change_pct": 5}, 3: {"marketing_krw": 800_000}}, seed=4, daily_customers=220)
    prev = run["baseline"]["op_krw"]
    for mo in months:
        wf = mo["waterfall"]
        assert wf["from_op_krw"] == prev and wf["to_op_krw"] == mo["kpi"]["op_krw"]
        assert sum(s["krw"] for s in wf["steps"]) == wf["to_op_krw"] - wf["from_op_krw"]
        assert [s["key"] for s in wf["steps"]] == [k for k, _ in S.STEPS]
        prev = mo["kpi"]["op_krw"]
    assert months[0]["waterfall"]["vs"] == "baseline" and months[1]["waterfall"]["vs"] == "prev_month"
    rep = S.report(run)
    assert rep["cumulative_op_krw"] == sum(m["kpi"]["op_krw"] for m in months)
    assert sum(d["krw"] for d in rep["drivers"]) == rep["cumulative_op_krw"] - rep["baseline_cumulative_op_krw"]
    assert rep["best_month"]["op_krw"] == max(m["kpi"]["op_krw"] for m in months)
    assert rep["worst_month"]["op_krw"] == min(m["kpi"]["op_krw"] for m in months)
    assert rep["survived"] and rep["months_played"] == N and rep["status"] == "finished"
    assert months[-1]["status"] == "finished" and rep["summary_ko"]


def test_rating_and_regulars_drift():
    _, months = run_season(daily_customers=150)
    assert months[0]["drivers"]["maturity"] == pytest.approx(v("season", "launch_share"))
    assert months[-1]["kpi"]["regulars"] > months[0]["kpi"]["regulars"] > 0
    _, jam = run_season(daily_customers=500)
    assert jam[-1]["kpi"]["rating"] < v("season", "rating_start")             # long queues wear the rating down
    assert all(x["kpi"]["walkaways"] > 0 for x in jam)
    assert jam[0]["drivers"]["bottleneck"] in ("espresso", "ordering", "seating")


def test_seasonality_follows_quarter_index():
    q = v("season", "seasonality_by_quarter")
    for start in (1, 7):   # 한 시즌이 6개월이라 상반기·하반기를 따로 본다
        _, months = run_season(daily_customers=100, start_month=start)
        cal = [(start - 1 + i) % 12 + 1 for i in range(N)]
        assert [m["calendar_month"] for m in months] == cal
        assert [m["drivers"]["season_index"] for m in months] == [q[(c - 1) // 3 + 1] for c in cal]
    assert load_params()["season"]["seasonality_by_quarter"]["grade"] == "H"


def test_every_number_graded():
    for key, x in load_params()["season"].items():
        assert x["grade"] in GRADES and "source" in x, key
    assert all(load_params()["district_meta"][d]["opens_per_year"]["grade"] == "H" for d in ("3120012", "3120094", "3110131"))
    _, months = run_season(seed=9, district="3120094", daily_customers=150)
    for mo in months:
        assert mo["pnl"]["grade"] in GRADES and mo["cash"]["grade"] in GRADES and mo["drivers"]["grade"] in GRADES
        assert all(x["grade"] in GRADES for x in mo["pnl"]["lines"])
        assert all(g in GRADES for g in mo["kpi_grades"].values())
        assert all(e["grade"] in GRADES and e["source"] for e in mo["events"])
        assert mo["owner_note_ko"] and not mo["owner_note_ko"].endswith(".")
    assert all(a["grade"] in GRADES for a in S.assumptions())


def test_season_params_match_step2_defaults():
    assert v("season", "staff_utilization")["standard"] == v("opex", "staff_utilization")
    assert v("season", "hours")["standard"] == [v("opex", "open_hour"), v("opex", "close_hour")]
    ctx, f = _ctx_and_base()
    assert S._coverage("3120012", (10, 22)) == pytest.approx(1.0)
    # with dessert on and no queue the baseline month sells exactly the step 2 rough month's revenue
    assert S.evaluate(ctx, f)["revenue_krw"] == pytest.approx(ctx["preview"]["rough_month"]["revenue_krw"], rel=1e-3)


def test_docs_list_every_season_param():
    doc = (ROOT / "docs" / "CAFE.md").read_text(encoding="utf-8")
    missing = [k for k in load_params()["season"] if f"`{k}`" not in doc]
    assert not missing, missing




# ---------------------------------------------------------------------------------------------- API

@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(cafe_api.router)
    return TestClient(app)


def test_api_round_trip(client):
    body = {k: x for k, x in STORE.items() if k != "own_capital_krw"} | {"own_capital_krw": 100_000_000,
                                                                       "daily_customers": 200, "seed": 5}
    r = client.post("/cafe/season", json=body)
    assert r.status_code == 200
    st = r.json()
    sid = st["season_id"]
    assert st["start"]["cash_krw"] == 100_000_000 + st["start"]["loan_krw"] - st["start"]["capex_krw"]
    assert {o["key"] for o in st["options"]["hours"]} == {"short", "standard", "long"}
    assert st["decisions"]["hours"] == "standard" and st["assumptions"]
    m1 = client.post(f"/cafe/season/{sid}/month", json={"price_change_pct": 5, "month_index": 0})
    assert m1.status_code == 200 and m1.json()["month"] == 1
    again = client.post(f"/cafe/season/{sid}/month", json={"price_change_pct": 5, "month_index": 0})
    assert again.json() == m1.json()                                       # a retry returns the played month
    assert client.post(f"/cafe/season/{sid}/month", json={"price_change_pct": 9, "month_index": 0}).status_code == 409
    assert client.post(f"/cafe/season/{sid}/month", json={"month_index": 5}).status_code == 409
    for i in range(1, N):
        r = client.post(f"/cafe/season/{sid}/month", json={"month_index": i} if i % 2 else {})
        assert r.status_code == 200 and r.json()["month"] == i + 1
    over = client.post(f"/cafe/season/{sid}/month", json={})
    assert over.status_code == 409 and over.json()["detail"]["error"] == "season_over"
    rep = client.get(f"/cafe/season/{sid}/report").json()
    assert rep["months_played"] == N and rep["status"] == "finished" and len(rep["months"]) == N
    assert "_vs_baseline" not in json.dumps(m1.json())
    # same seed and decisions through the API = same months as the library
    _, lib = run_season({0: {"price_change_pct": 5}}, seed=5, own_capital_krw=100_000_000, daily_customers=200)
    assert lib[0]["kpi"] == m1.json()["kpi"]


def test_api_validation_and_missing(client):
    assert client.post("/cafe/season/nope/month", json={}).status_code == 404
    assert client.get("/cafe/season/nope/report").status_code == 404
    sid = client.post("/cafe/season", json={k: x for k, x in STORE.items()}).json()["season_id"]
    assert client.post(f"/cafe/season/{sid}/month", json={"hours": "allday"}).status_code == 422
    assert client.post(f"/cafe/season/{sid}/month", json={"price_change_pct": 50}).status_code == 422
    assert client.post(f"/cafe/season/{sid}/month", json={"marketing_krw": -1}).status_code == 422
    assert client.post(f"/cafe/season/{sid}/month").status_code == 200    # no body = keep everything
    assert client.post("/cafe/season", json={**STORE, "start_month": 13}).status_code == 422




# ---------------------------------------------------------------------------------------------- stateless tokens + web app

SEASON_BODY = {**STORE, "own_capital_krw": 100_000_000, "daily_customers": 200, "seed": 5}
PLAN = {0: {"price_change_pct": 5}, 3: {"hours": "long"}, 6: {"marketing_krw": 500_000}, 8: {"dessert": False}}


def _token_season(client, prefix="/cafe"):
    st = client.post(f"{prefix}/season", json=SEASON_BODY).json()
    tok, months = st["state_token"], []
    for i in range(N):
        r = client.post(f"{prefix}/season/month", json={"state_token": tok, **PLAN.get(i, {})})
        assert r.status_code == 200, r.text
        months.append(r.json())
        tok = months[-1].pop("state_token")
    return st, tok, months


def test_token_round_trip_equals_stateful_and_library(client):
    st, tok, months = _token_season(client)
    assert len(st["state_token"]) < 600 and len(tok) < 800             # compact: start body + 12 small decision dicts
    sid = client.post("/cafe/season", json=SEASON_BODY).json()["season_id"]
    stateful = []
    for i in range(N):
        m = client.post(f"/cafe/season/{sid}/month", json=PLAN.get(i, {})).json()
        m.pop("state_token")
        stateful.append(m)
    assert dumps(months) == dumps(stateful)
    _, lib = run_season(PLAN, seed=5, own_capital_krw=100_000_000, daily_customers=200)
    assert dumps(months) == dumps(lib)
    rep = client.post("/cafe/season/report", json={"state_token": tok}).json()
    rep_stateful = client.get(f"/cafe/season/{sid}/report").json()
    assert {**rep, "season_id": sid} == rep_stateful
    assert client.post("/cafe/season/month", json={"state_token": tok}).status_code == 409   # season over


def test_token_retry_and_mismatch(client):
    tok0 = client.post("/cafe/season", json=SEASON_BODY).json()["state_token"]
    a = client.post("/cafe/season/month", json={"state_token": tok0, "price_change_pct": 5, "month_index": 0}).json()
    tok1 = a.pop("state_token")
    b = client.post("/cafe/season/month", json={"state_token": tok1, "price_change_pct": 5, "month_index": 0}).json()
    assert b.pop("state_token") == tok1 and b == a                       # a retry with the new token changes nothing
    c = client.post("/cafe/season/month", json={"state_token": tok0, "price_change_pct": 5, "month_index": 0}).json()
    assert c.pop("state_token") == tok1 and c == a                       # a retry with the old token replays the same month
    assert client.post("/cafe/season/month", json={"state_token": tok1, "price_change_pct": 9,
                                                    "month_index": 0}).status_code == 409


def test_tampered_or_foreign_token_is_400(client, monkeypatch):
    tok = client.post("/cafe/season", json=SEASON_BODY).json()["state_token"]
    body, sig = tok.split(".")
    flip = lambda s, i: s[:i] + ("A" if s[i] != "A" else "B") + s[i + 1:]   # noqa: E731
    for bad in (flip(body, 5), f"{body}.{flip(sig, 3)}", body, "x" * 20, f"{body}.{sig}.x", "!!!!!!!!!!.@@@@"):
        r = client.post("/cafe/season/month", json={"state_token": bad})
        assert r.status_code == 400, (bad, r.text)
        assert r.json()["detail"]["error"] == "bad_state_token"
    # a well-formed state with an edited decision history, signed by another key
    state = cafe_api.decode_token(tok)
    monkeypatch.setenv("CAFE_TOKEN_KEY", "someone-else")
    forged = cafe_api.encode_token({**state, "d": [{"price_change_pct": 30}]})
    monkeypatch.delenv("CAFE_TOKEN_KEY")
    assert client.post("/cafe/season/report", json={"state_token": forged}).status_code == 400
    # the same token is accepted again once the key matches
    assert client.post("/cafe/season/report", json={"state_token": tok}).status_code == 200


def test_token_key_from_env(client, monkeypatch):
    monkeypatch.setenv("CAFE_TOKEN_KEY", "deploy-key")
    tok = client.post("/cafe/season", json=SEASON_BODY).json()["state_token"]
    assert client.post("/cafe/season/report", json={"state_token": tok}).status_code == 200
    monkeypatch.setenv("CAFE_TOKEN_KEY", "rotated")
    assert client.post("/cafe/season/report", json={"state_token": tok}).status_code == 400


def test_token_from_older_model_is_409(client, monkeypatch):
    tok = client.post("/cafe/season", json=SEASON_BODY).json()["state_token"]
    monkeypatch.setattr(cafe_api, "model_version", lambda: "changed000")
    r = client.post("/cafe/season/month", json={"state_token": tok})
    assert r.status_code == 409 and r.json()["detail"]["error"] == "model_changed"


def test_replay_cost_is_small():
    import time
    t0 = time.perf_counter()
    S.replay({**STORE, "daily_customers": 250, "seed": 1}, [PLAN.get(i, {}) for i in range(N)])
    assert time.perf_counter() - t0 < 2.0                                # measured ~0.07 s on an M-series Mac




# ---------------------------------------------------------------------------------------------- Korean text

def _ko_strings(x, path=""):
    if isinstance(x, dict):
        for k, v in x.items():
            if isinstance(v, str) and k.endswith("_ko"):
                yield f"{path}.{k}", v
            else:
                yield from _ko_strings(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from _ko_strings(v, f"{path}[{i}]")


def test_won_formatter():
    from sim.cafe.ko import won
    cases = {9_772: "9,772원", 10_320: "1만 320원", 411_733: "41만원", 800_000: "80만원", -37_849_333: "-3,785만원",
             167_593_268: "1억 6,759만원", 200_000_000: "2억원", 0: "0원"}
    assert {k: won(k) for k in cases} == cases


def test_no_raw_won_of_10000_or_more_in_korean_text():
    """Money in *_ko text reads as 만/억: no number of 10,000 or more directly followed by 원."""
    import re
    from sim.cafe import preview
    bad = re.compile(r"(\d[\d,]*)원")
    texts = []
    for kw in ({}, {"daily_customers": 250}, {"daily_customers": 450, "staff_peak": 1}, {"district": "3110131"}):
        texts += list(_ko_strings(preview({**STORE, **kw}), "preview"))
    for seed, kw in ((7, {"daily_customers": 150}), (9, {"district": "3120094"}),
                     (3, {"own_capital_krw": 80_000_000, "extra_loan_krw": 0}), (4, {"daily_customers": 450})):
        run, months = run_season({0: {"price_change_pct": 5}}, seed=seed, **kw)
        texts += list(_ko_strings({"start": S.public_start(run), "months": months, "report": S.report(run)}, "season"))
    assert len(texts) > 200
    offenders = [(p, s) for p, s in texts for n in bad.findall(s) if int(n.replace(",", "")) >= 10_000]
    assert not offenders, offenders[:5]


def test_opening_ramp_is_labelled_and_reputation_rises_month_over_month():
    run, months = run_season(seed=7, daily_customers=150)
    first = next(s for s in months[0]["waterfall"]["steps"] if s["key"] == "reputation")
    assert first["label_ko"].startswith("개업 초기 효과") and first["krw"] < 0 and "자리 잡은" in first["note_ko"]
    assert "첫 달" in months[0]["owner_note_ko"]
    later = [next(s for s in m["waterfall"]["steps"] if s["key"] == "reputation") for m in months[1:]]
    assert all(s["label_ko"] == "별점과 단골" for s in later)
    grow = [m["kpi"]["regulars_delta"] > 0 and m["kpi"]["rating_delta"] >= 0 for m in months[1:]]
    for g, s in zip(grow, later):
        if g:
            assert s["krw"] > 0                      # growing regulars never show as a loss month over month
    rep = next(d for d in S.report(run)["drivers"] if d["key"] == "reputation")
    assert rep["label_ko"].startswith("개업 초기 효과") and rep["krw"] < 0 and rep["note_ko"]
