"""Season engine v2 (sim/season.py): calibration, each lever's upside AND downside, dominance over sampled plans,
lose and win paths, determinism, and the §11 MonthResult shape."""
import json
import random
import re

import numpy as np
import pytest

from sim import season as S
from sim.engine import monte_carlo
from sim.params import load_params, load_profile


@pytest.fixture(scope="module")
def st():
    return S.new_season(11)


def pv(state, **plan):
    return S.preview(state, {**S.base_plan(), **plan}, [])["expected"]


def nxt(state, **plan):
    return S.preview(state, {**S.base_plan(), **plan}, [])["state_next"]


def at_month(month: int) -> dict:
    s = S.new_season(11)
    s["month_index"] = S.months().index(month)
    return s


# --- calibration ------------------------------------------------------------------------------------------
def test_base_plan_october_reproduces_hero_base_month(st):
    r = S.play_month(st, S.base_plan(), [], band_runs=100)
    hero = monte_carlo(load_params(), load_profile(), 100, 42)
    rev = float(np.median([m["revenue"] for m in hero]))
    op = float(np.median([m["op"] for m in hero]))
    assert abs(r["draw"]["p50"]["revenue"] / rev - 1) < 0.03
    assert abs(r["draw"]["p50"]["op"] - op) < 400_000   # extra table tasks may cost a few walk-aways


def test_preview_of_base_plan_equals_baseline(st):
    assert pv(st)["op"] == pytest.approx(S._baseline()["op"], abs=1)


def test_waterfall_adds_up(st):
    r = S.play_month(st, {**S.base_plan(), "meat_price": 20500, "lunch": True}, ["pork_up"], band_runs=10)
    steps = [w["delta"] for w in r["waterfall"] if w["kind"] == "step"]
    assert r["waterfall"][0]["delta"] + sum(steps) == pytest.approx(r["waterfall"][-1]["delta"], abs=10)
    assert r["waterfall"][-1]["delta"] == r["draw"]["kpis"]["op"]


# --- every lever: upside and downside ------------------------------------------------------------------------
def test_meat_price(st):
    hi, lo = pv(st, meat_price=21500), pv(st)
    assert hi["ticket"] > lo["ticket"] and hi["covers"] < lo["covers"] and hi["satisfaction"] < lo["satisfaction"]


def test_soju_price(st):
    # upside: margin per bottle; downside: fewer bottles and fewer visits (menu price index), lower satisfaction
    hi, lo = pv(st, soju_price=6000), pv(st)
    cost = S._setup(st, S.base_plan(), [])["params"]["cst_alcohol_cost_per_bottle"]
    assert 6000 - cost > 5000 - cost
    assert hi["covers"] < lo["covers"] and hi["satisfaction"] < lo["satisfaction"]
    assert hi["cogs"] < lo["cogs"]   # fewer bottles bought


def test_meat_grade(st):
    imp, dom, aged = pv(st, meat_grade="imported"), pv(st), pv(st, meat_grade="aged")
    assert imp["cogs"] < dom["cogs"] < aged["cogs"]
    assert imp["satisfaction"] < dom["satisfaction"] < aged["satisfaction"]


def test_menu_extras(st):
    on, off = pv(st, menu_extras=["minari", "naengsam"]), pv(st)
    _, s_on = S.step_estimate(st, {**S.base_plan(), "menu_extras": ["minari", "naengsam"]})
    _, s_off = S.step_estimate(st, S.base_plan())
    assert s_on["awareness"] > s_off["awareness"] and on["covers"] > off["covers"]
    assert on["cogs"] / on["covers"] > off["cogs"] / off["covers"] and on["staff_load"] > off["staff_load"]


def test_banchan(st):
    more, base = pv(st, banchan=8), pv(st)
    assert more["satisfaction"] > base["satisfaction"] and more["cogs"] > base["cogs"]


def test_staff_grilling(st):
    on, off = pv(st, staff_grilling=True), pv(st)
    assert on["satisfaction"] > off["satisfaction"]
    assert on["staff_load"] > off["staff_load"] and nxt(st, staff_grilling=True)["fatigue"] > nxt(st)["fatigue"]


def test_staff_per_shift(st):
    few, base = pv(st, staff_per_shift=0), pv(st)
    assert few["labor"] < base["labor"]
    assert few["staff_load"] > base["staff_load"] and few["satisfaction"] < base["satisfaction"]
    assert few["walkaways"] > base["walkaways"] and nxt(st, staff_per_shift=0)["fatigue"] > nxt(st)["fatigue"]
    # more 알바 = more people who can quit; the owner alone has nobody to lose
    assert nxt(st, staff_per_shift=3)["quit_risk"] > nxt(st)["quit_risk"] > nxt(st, staff_per_shift=0)["quit_risk"] == 0


def test_close_hour(st):
    late, base, early = pv(st, close_hour=25), pv(st), pv(st, close_hour=23)
    assert late["covers"] > base["covers"] > early["covers"]
    assert late["labor"] > base["labor"] > early["labor"]
    assert nxt(st, close_hour=25)["fatigue"] > nxt(st)["fatigue"]


def test_lunch(st):
    on, off = pv(st, lunch=True), pv(st)
    assert on["revenue"] > off["revenue"] and on["labor"] > off["labor"] and on["mgmt"] > off["mgmt"]
    assert nxt(st, lunch=True)["fatigue"] > nxt(st)["fatigue"]


def test_terrace(st):
    assert pv(st, terrace=True)["covers"] >= pv(st, terrace=False)["covers"]
    on = sum("noise_complaint" in S.draw_events({**S.new_season(s), "plan": {**S.base_plan(), "terrace": True}}) for s in range(200))
    off = sum("noise_complaint" in S.draw_events({**S.new_season(s), "plan": {**S.base_plan(), "terrace": False}}) for s in range(200))
    assert on > 0 and off == 0


def test_review_event(st):
    _, on = S.step_estimate(st, {**S.base_plan(), "review_event": True})
    _, off = S.step_estimate(st, S.base_plan())
    assert on["review_count"] > off["review_count"] and pv(st, review_event=True)["mgmt"] > pv(st)["mgmt"]


def test_marketing(st):
    _, on = S.step_estimate(st, {**S.base_plan(), "marketing_budget": 1_000_000})
    _, off = S.step_estimate(st, S.base_plan())
    assert on["awareness"] > off["awareness"]
    hype = pv(st, marketing_budget=1_000_000)
    assert hype["mgmt"] > pv(st)["mgmt"] and hype["satisfaction"] < pv(st)["satisfaction"]


def test_group_reservations_in_december():
    dec = at_month(12)
    on, off = pv(dec, group_reservations=True), pv(dec)
    assert on["group_revenue"] > 0 and on["revenue"] > off["revenue"]
    busy = {**dec, "awareness": 2.5}   # crowded nights: the blocked table turns walk-ins away
    assert pv(busy, group_reservations=True)["walkaways"] > pv(busy)["walkaways"]


def test_hygiene():
    high, normal = pv(S.new_season(1), hygiene="high"), pv(S.new_season(1))
    assert high["labor"] > normal["labor"] and high["satisfaction"] > normal["satisfaction"]
    fails = {h: 0 for h in ("basic", "high")}
    for seed in range(300):
        s = S.new_season(seed)
        closure, notes = S._hygiene_and_sickness(s, {**S.base_plan(), "hygiene": "basic"}, ["hygiene_inspection"], S._rng(s, 9))
        fails["basic"] += notes[0]["outcome"] == "fail"
        closure, notes = S._hygiene_and_sickness(s, {**S.base_plan(), "hygiene": "high"}, ["hygiene_inspection"], S._rng(s, 9))
        fails["high"] += notes[0]["outcome"] == "fail"
    assert fails["basic"] > fails["high"]


# --- dominance over sampled plans ------------------------------------------------------------------------------
LEVERS = {"meat_price": [16000, 17500, 19000, 20500, 22000], "soju_price": [4500, 5000, 5500, 6000],
          "meat_grade": ["imported", "domestic", "aged"], "menu_extras": [[], ["minari"], ["naengsam"], ["naengsam", "minari"]],
          "banchan": [3, 5, 7], "staff_grilling": [False, True], "staff_per_shift": [0, 1, 2, 3], "close_hour": [23, 24, 25],
          "lunch": [False, True], "terrace": [False, True], "marketing_budget": [0, 500_000, 1_000_000],
          "review_event": [False, True], "group_reservations": [False, True], "hygiene": ["basic", "normal", "high"]}
SCENARIOS = {"calm": [[]] * 6,
             "costs": [["pork_up"], ["veg_up"], [], ["cold_wave"], [], ["rent_renewal"]],
             "demand": [["rain_week"], ["competitor_open"], [], [], ["cold_wave"], []]}


def test_no_plan_wins_every_month_and_calendar():
    """Hold each sampled plan for a season (analytic, with state carried). If one plan were the best month OP in
    every month of every scenario, some lever would have no real downside: check research/season_params.yaml."""
    rnd = random.Random(3)
    plans = [S.base_plan()] + [{k: rnd.choice(vs) for k, vs in LEVERS.items()} for _ in range(120)]
    winners = set()
    for evs in SCENARIOS.values():
        res = [S.estimate_season(p, evs) for p in plans]
        for m in range(6):
            winners.add(max(range(len(plans)), key=lambda i: res[i]["ops"][m] if len(res[i]["ops"]) > m else -1e12))
    assert len(winners) > 1, f"plan {plans[winners.pop()]} wins every month of every scenario"


# --- lose and win paths, determinism, shape -------------------------------------------------------------------
BAD = {**S.base_plan(), "meat_grade": "aged", "meat_price": 16000, "staff_per_shift": 4, "marketing_budget": 2_000_000,
       "close_hour": 25, "lunch": True, "banchan": 9, "menu_extras": ["naengsam", "tongsam", "minari"], "hygiene": "high",
       "review_event": True}
GOOD = {**S.base_plan(), "meat_grade": "aged", "meat_price": 21000}   # premiumise: better meat, priced for it


def play_season(plan, seed):
    s = S.new_season(seed)
    out = []
    while s["month_index"] < len(S.months()) and not s["closed"]:
        r = S.play_month(s, plan, None, band_runs=5)
        out.append(r)
        s = r["state_after"]
    return s, out


def test_lose_path_reachable():
    s, months = play_season(BAD, 5)
    assert s["closed"] and len(months) < 6 and months[-1]["state_after"]["negative_months"] >= 2


def test_win_path_reachable():
    """Premiumising can beat 평소 over a season, but it carries risk (숙성육 편차, pork spikes): not every seed."""
    wins = 0
    for seed in range(1, 6):
        base, _ = play_season(S.base_plan(), seed)
        s, months = play_season(GOOD, seed)
        assert len(months) == 6
        wins += s["cash"] > base["cash"]
    assert 1 <= wins <= 4


def test_same_seed_same_month(st):
    a = S.play_month(st, S.base_plan(), None, band_runs=5)
    b = S.play_month(st, S.base_plan(), None, band_runs=5)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert S.draw_events(st) == S.draw_events(st)


def test_month_result_shape(st):
    r = S.play_month(st, S.base_plan(), None, band_runs=5)
    for k in ("month", "calendar", "events", "plan", "draw", "waterfall", "state_after", "reviews", "owner_line",
              "night_events", "labels"):
        assert k in r
    assert set(r["draw"]) >= {"kpis", "p10", "p50", "p90"}
    assert all({"segment", "stars", "reason_codes", "drivers"} <= set(x) for x in r["reviews"])
    assert all("tag" in lab for lab in r["labels"])
    json.dumps(r)




def test_no_plan_wins_every_season():
    """Season level: sampled plans x seeds, events drawn from the event model, analytic seasons with state carried.
    No plan may end with the most cash in every seed (that plan would solve the game)."""
    rnd = random.Random(11)
    plans = [S.base_plan(), GOOD] + [{k: rnd.choice(vs) for k, vs in LEVERS.items()} for _ in range(60)]
    best = set()
    for seed in range(1, 9):
        cash = [S.estimate_season(p, seed=seed, draw=True)["cash"] for p in plans]
        best.add(int(np.argmax(cash)))
    assert len(best) > 1, f"plan {plans[best.pop()]} ends with the most cash in every seed"


def test_season_end_store_value():
    s, months = play_season(GOOD, 4)
    end = months[-1]["season_end"]
    assert all(m["season_end"] is None for m in months[:-1])
    assert end["store_value"] == pytest.approx(end["cash"] + end["forward_value"], abs=2)
    assert end["horizon_months"] == 6 and end["tag"] == "가정"
    # a better reputation than at the start is worth something under the same plan; a worse one costs
    up = S.season_value({**s, "rating": 4.6, "regular_share": 0.33})
    down = S.season_value({**s, "rating": 3.8, "regular_share": 0.10})
    assert up["reputation_effect"] > 0 > down["reputation_effect"]
    assert up["forward_value"] > down["forward_value"]
    closed = S.season_value({**s, "closed": True})
    assert closed["store_value"] == pytest.approx(s["cash"] - S.v("season_value.closure_cost"))   # S89 closure cost


def test_preview_names_lunch_trap_and_aged_risk(st):
    lunch = S.preview(st, {**S.base_plan(), "lunch": True}, [])
    assert lunch["lunch"]["net"] < 0 and "lunch_negative" in lunch["warning_codes"]
    aged = S.preview(st, {**S.base_plan(), "meat_grade": "aged"}, [])
    assert [r["id"] for r in aged["risks"]] == ["aged_spoilage"] and aged["risks"][0]["op_delta"] < 0
    assert aged["op_range"]["p10"] < aged["expected"]["op"] < aged["op_range"]["p90"]
    assert S.preview(st, S.base_plan(), [])["risks"] == []
    # money in the warning text: the UI minus, rounded before the sign (N19)
    texts = [t for pv in (lunch, aged) for t, c in zip(pv["warnings"], pv["warning_codes"]) if c in ("lunch_negative", "risk:aged_spoilage")]
    assert len(texts) == 2 and all("\u2212" in t and not re.search(r"-\d", t) for t in texts), texts


LEAD_PLAN = {**S.base_plan(), "meat_grade": "aged", "menu_extras": ["minari"], "review_event": True}


def _des_mean(st, plan, events, runs=200, seed0=9000):
    from sim.engine import simulate_month
    su = S._setup(st, plan, events, closure_days=3 if "owner_sick" in events else 0, quit_now="staff_quit" in events)
    return float(np.mean([S._pnl(simulate_month(su["params"], su["profile"], seed0 + j, a=su["a"]), su, None, 0)["op"]
                          for j in range(runs)]))


def _tol(des_op):
    return max(300_000, 0.15 * abs(des_op))   # the lead's decision tolerance


def test_preview_every_event_type_within_tolerance():
    """Each event type, October, on the base plan and on the lead's repro plan: |preview OP - DES mean OP| within
    max(30만, 15% of |OP|) (200 DES runs, SE about 6만)."""
    st = S.new_season(1)
    for plan in (S.base_plan(), LEAD_PLAN):
        for eid in [k for k in S.data()["EV"] if not k.startswith("_")]:
            if eid == "aged_spoilage" and plan["meat_grade"] != "aged":
                continue
            des = _des_mean(st, plan, [eid])
            err = S.preview(st, plan, [eid])["expected"]["op"] - des
            assert abs(err) <= _tol(des), (eid, plan["meat_grade"], err)


def _random_plan_errors(seed=17):
    """One random multi-lever plan per event type in a random month and state, inside the preview's domain (at
    least one 알바 after quits, load <= 0.8; outside it the preview warns). Returns (error / tolerance, signed error,
    DES mean inside the shown op_range) per plan."""
    rnd = random.Random(seed)
    out = []
    for eid in [k for k in S.data()["EV"] if not k.startswith("_")]:
        while True:
            plan = {k: rnd.choice(vs) for k, vs in LEVERS.items()}
            if eid == "aged_spoilage":
                plan["meat_grade"] = "aged"
            st = S.new_season(rnd.randrange(1000))
            st["month_index"], st["fatigue"], st["rating"] = rnd.randrange(6), rnd.choice([30, 50, 70]), rnd.choice([3.8, 4.2, 4.5])
            pv = S.preview(st, plan, [eid])
            if "overload" not in pv["warning_codes"]:
                break
        des = _des_mean(st, plan, [eid])
        err = pv["expected"]["op"] - des
        out.append((abs(err) / _tol(des), err, pv["op_range"]["p10"] <= des <= pv["op_range"]["p90"]))
    return out


def test_preview_random_multilever_plans():
    """Bars (lead, 2026-10-01): >= 70% of random multi-lever plans within max(30만, 15% |OP|) of the DES mean, mean
    signed bias within ±15만, none worse than 1.5x the tolerance, and the DES mean inside the board's op_range.
    Measured: 13/18 within, mean +11.7만, worst 1.27x, 18/18 inside. Mutations caught: +40만 bias, point or ±1%
    range. Not caught: the measured +12만 optimism itself (within the ±15만 bar)."""
    res = _random_plan_errors()
    ratios, errs, inside = zip(*res)
    assert sum(r <= 1 for r in ratios) >= 0.7 * len(res), ratios
    assert abs(np.mean(errs)) <= 150_000, np.mean(errs)
    assert max(ratios) <= 1.5, max(ratios)
    assert all(inside), inside


def test_overloaded_plans_carry_the_warning():
    st = S.new_season(1)
    assert "overload" in S.preview(st, {**S.base_plan(), "staff_per_shift": 0}, [])["warning_codes"]
    assert "overload" in S.preview(st, {**S.base_plan(), "staff_per_shift": 1}, ["staff_quit"])["warning_codes"]
    assert "overload" not in S.preview(st, S.base_plan(), [])["warning_codes"]


def test_lead_repro_seeds():
    """Seeds 3 (festival + rain), 11 (festival), 21 (inspection), October, lead's plan: preview within tolerance of
    the DES mean, and different events give different previews."""
    pvs = {}
    for sd in (3, 11, 21):
        st = S.new_season(sd, "free")
        ev = S.draw_events(st)
        pvs[sd] = S.preview(st, LEAD_PLAN)["expected"]["op"]
        des = _des_mean(st, LEAD_PLAN, ev)
        assert abs(pvs[sd] - des) <= _tol(des), (sd, ev, pvs[sd], des)
    assert pvs[3] != pvs[11]


def test_preview_uses_the_months_events_and_matches_play():
    """Lead's repro: seed 7, October (festival + staff quit), aged + 미나리 + review event."""
    st = S.new_season(7, "free")
    plan = {**S.base_plan(), "meat_grade": "aged", "menu_extras": ["minari"], "review_event": True}
    pv = S.preview(st, plan)
    assert pv["events"] == S.draw_events(st)
    r = S.play_month(st, plan, None)
    assert abs(pv["expected"]["op"] - r["draw"]["p50"]["op"]) < 0.04 * pv["expected"]["revenue"]
    assert pv["op_range"]["p10"] < r["draw"]["p50"]["op"] < pv["op_range"]["p90"]


def test_waterfall_starts_from_the_same_month_shadow():
    st = S.new_season(7)
    r = S.play_month(st, S.base_plan(), None, band_runs=3)
    assert r["shadow"]["kpis"]["op"] == r["draw"]["kpis"]["op"]          # base plan: shadow == draw
    assert all(w["delta"] == 0 for w in r["waterfall"] if w["kind"] == "step")
    r = S.play_month(st, {**S.base_plan(), "meat_grade": "aged"}, None, band_runs=3)
    assert r["waterfall"][0]["delta"] == r["shadow"]["kpis"]["op"]
    labor = next(w for w in r["waterfall"] if w["key"] == "labor")
    assert labor["delta"] == 0 and labor["note"] == "계획 차이 없음"   # a quit this month is in both runs


def test_base_plan_is_sustainable():
    """평소 must not burn staff out: no events, base plan, fatigue stays near the start all season."""
    st = S.new_season(7)
    path = []
    for _ in range(6):
        st = S.play_month(st, S.base_plan(), [], band_runs=3)["state_after"]
        path.append(st["fatigue"])
    assert max(path) < v_start_fatigue() + 10, path


def v_start_fatigue():
    return S.v("start.fatigue")


def test_no_plan_beats_base_on_cash_and_store_value_by_a_wide_margin_in_every_seed():
    """Season level, both scores (review 2026-10-01: 숙성 + ₩24,000 beat the base on cash and 가게 가치 in every seed).
    Better-than-default plans are fine; one that beats the base plan on BOTH by 300만 or more (about three normal
    months of OP) in every seed would solve the season. Sampled plans plus the premium candidates, analytic seasons,
    events drawn, 8 seeds. Mutation: without the grade price ceiling, aged ₩24,000 clears it by 464만."""
    rnd = random.Random(23)
    premium = [{**S.base_plan(), "meat_grade": "aged", "meat_price": p} for p in (21000, 22000, 24000)]
    plans = [S.base_plan(), *premium] + [{k: rnd.choice(vs) for k, vs in LEVERS.items()} for _ in range(50)]
    margin = np.full(len(plans), np.inf)
    for seed in range(1, 9):
        ends = [S.estimate_season(p, seed=seed, draw=True)["state"] for p in plans]
        cash = np.array([e["cash"] for e in ends])
        value = np.array([S.season_value(e)["store_value"] for e in ends])
        margin = np.minimum(margin, np.minimum(cash - cash[0], value - value[0]))
    worst = int(np.argmax(margin[1:])) + 1
    assert margin[worst] < 3_000_000, f"plan {plans[worst]} beats the base on both by {margin[worst]:,.0f} in every seed"


def _night_revenue(events):
    return sum(e.get("bill", 0) for e in events if e.get("type") == "leave" and not e.get("group"))


def _saturday_mean_revenue(su, n=40):
    from sim.engine import simulate_night
    p, revs = su["params"], []
    for i in range(n):
        g = np.random.default_rng([999, i])
        rain = p["wx_rain_nights_share"] >= 0.5 or (p["wx_rain_nights_share"] > 0 and g.random() < p["wx_rain_nights_share"])
        r = simulate_night(p, su["profile"], "sat", g, elasticity=p["mkt_price_elasticity"],
                           terrace_open=p["sto_terrace"] > 0 and p["sto_terrace_availability"] > 0 and not rain,
                           log=True, a=su["a"], rain=rain)
        revs.append(_night_revenue(r["events"]))
    return float(np.mean(revs))


def test_replayed_night_is_a_typical_saturday():
    """Review 2026-10-01: 12월 replayed its emptiest night. The chosen Saturday's revenue (walk-in parties) is within
    ±15% of the month's mean Saturday revenue, across months and plans. Mutation: picking the emptiest draw fails."""
    for mi, plan in ((0, S.base_plan()), (2, S.base_plan()), (2, {**S.base_plan(), "group_reservations": True}),
                     (3, S.base_plan()), (5, {**S.base_plan(), "staff_per_shift": 1}),
                     (1, {**S.base_plan(), "meat_grade": "aged", "meat_price": 21000})):
        st = S.new_season(31)
        st["month_index"] = mi
        su = S._setup(st, plan, [])
        chosen = _night_revenue([e for e in S._night(su, 12345) if "night" not in e])
        mean = _saturday_mean_revenue(su)
        assert abs(chosen / mean - 1) <= 0.15, (S.current_month(st), plan, chosen, mean)






# --- in-night decisions (GAME-V2-SPEC §12.1) -------------------------------------------------------------------------
def _states_with_decisions(n, seed=41):
    rnd = random.Random(seed)
    for _ in range(n):
        plan = {k: rnd.choice(vs) for k, vs in LEVERS.items()}
        st = S.new_season(rnd.randrange(10**6))
        st["month_index"] = rnd.randrange(6)
        yield st, plan


def test_start_month_then_play_month_is_deterministic_and_consistent():
    st = S.new_season(7)
    start = S.start_month(st, S.base_plan())
    assert start["decision_points"] and "draw" not in start
    cut = start["decision_points"][0]["clock_min"]
    for dp in start["decision_points"]:
        for opt in dp["options"]:
            a = S.play_month(st, S.base_plan(), None, band_runs=3, night_choices={dp["id"]: opt["id"]})
            b = S.play_month(st, S.base_plan(), None, band_runs=3, night_choices={dp["id"]: opt["id"]})
            assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)   # same seed + choices, same month
            played = [e for e in a["night_events"][1:] if e["t"] <= cut and not e.get("special")]
            shown = [e for e in start["night"]["events"] if not e.get("special")]
            skeleton = lambda es: [{k: x for k, x in e.items() if k not in ("satisfaction", "spend", "reason", "bubble")} for e in es]  # noqa: E731
            assert skeleton(played) == skeleton(shown)   # the night before the decision is the same night
            done = {e["party"] for e in shown if e["type"] in ("leave", "balk")}
            assert [e for e in played if e.get("party") in done] == [e for e in shown if e.get("party") in done]
            assert not any("spend" in e for e in shown if e.get("party") is not None and e["party"] not in done)
            assert a["decision_points"] == start["decision_points"]
    with pytest.raises(ValueError):
        S.play_month(st, S.base_plan(), None, band_runs=3, night_choices={start["decision_points"][0]["id"]: "nope"})


def test_every_option_changes_the_outcome():
    """Each non-default option moves the month (OP) or the state against the default handling."""
    checked = 0
    for st, plan in _states_with_decisions(6):
        start = S.start_month(st, plan)
        for dp in start["decision_points"]:
            base = S.play_month(st, plan, None, band_runs=2, night=True)
            for opt in dp["options"]:
                if opt["id"] == dp["default"]:
                    continue
                r = S.play_month(st, plan, None, band_runs=2, night_choices={dp["id"]: opt["id"]})
                moved = (r["draw"]["kpis"]["op"] != base["draw"]["kpis"]["op"]
                         or any(r["state_after"][k] != base["state_after"][k] for k in ("fatigue", "awareness", "rating")))
                assert moved, (dp["id"], opt["id"])
                checked += 1
    assert checked >= 4


def test_no_decision_option_dominates_in_every_state():
    """Pareto guard: an option dominates a state when it is at least as good on month OP, night satisfaction and state
    effects (fatigue lower, 인지도 and rating higher) as every other option, and better on one. Differences inside the
    night's noise count as ties (month OP 5만, night satisfaction 0.5). No option may dominate in every sampled state
    where its decision appears. Mutation: a free, instant 대타 dominates every staff_late state (caught)."""
    import collections
    seen, dom = collections.Counter(), collections.defaultdict(collections.Counter)
    for st, plan in _states_with_decisions(90):
        ev = S.draw_events(st)
        su = S._setup(st, plan, ev, quit_now="staff_quit" in ev)
        seed = int(S._rng(st, 2).integers(1 << 30))
        pick = S._night_pick(su, seed)
        night = S._night_sim(su, seed, pick)
        plain = S._night_kpis(night, su)
        for slot, dp in enumerate(S._decision_points(st, su, pick, night["events"])):
            sc = {}
            for o in dp["options"]:
                d = S._dp_month_delta(dp, o["id"], su, seed, pick, plain, slot)
                x = d["state"]
                sc[o["id"]] = (d["month"]["op"], d["night"]["sat_sum"], -x.get("fatigue", 0), x.get("awareness", 0), x.get("rating", 0))
            seen[dp["kind"]] += 1
            eps = (50_000, 0.5, 1e-9, 1e-9, 1e-9)
            for a, xa in sc.items():
                if all(all(p >= q - e for p, q, e in zip(xa, xb, eps)) and any(p > q + e for p, q, e in zip(xa, xb, eps))
                       for b, xb in sc.items() if b != a):
                    dom[dp["kind"]][a] += 1
    assert len(seen) >= 4, seen
    for kind, n in seen.items():
        for opt, k in dom[kind].items():
            assert k < n, f"{kind}: {opt} dominates in all {n} states"


def test_preview_sensitivity_signs_and_exactness():
    """§12.2: one step per lever. Directions follow the mechanisms; the op delta equals the preview difference."""
    st = S.new_season(7)
    pv = S.preview(st, S.base_plan())
    sens = pv["sensitivity"]
    assert set(sens) == set(LEVERS)
    assert sens["meat_price"]["up"]["covers"] < 0 < sens["meat_price"]["down"]["covers"]
    assert sens["meat_grade"]["up"]["rating_recent"] > 0 > sens["meat_grade"]["down"]["rating_recent"]
    assert sens["banchan"]["up"]["op"] < 0 < sens["banchan"]["up"]["rating_recent"]
    assert sens["staff_per_shift"]["up"]["fatigue"] < 0 < sens["staff_per_shift"]["down"]["fatigue"]
    assert sens["lunch"]["up"]["fatigue"] > 0 and sens["lunch"]["down"] is None and sens["terrace"]["up"] is None
    up = S.preview(st, {**S.base_plan(), "meat_price": 20000}, sensitivity=False)["expected"]["op"]
    assert sens["meat_price"]["up"]["op"] == pytest.approx(up - pv["expected"]["op"], abs=1)


def test_cause_links_on_waterfall_and_reviews():
    """§12.3: waterfall steps name the plan differences, month events and decisions behind them; reviews name the
    levers and events behind their reason codes."""
    st = S.new_season(7)
    r = S.play_month(st, {**S.base_plan(), "meat_grade": "aged", "staff_per_shift": 1}, ["pork_up", "festival_week"], band_runs=3)
    steps = {w["key"]: w for w in r["waterfall"] if w["kind"] == "step"}
    assert all({"levers", "events", "decisions"} <= set(w) for w in steps.values())
    assert "meat_grade" in steps["cogs"]["levers"] and "pork_up" in steps["cogs"]["events"]
    assert "staff_per_shift" in steps["labor"]["levers"] and steps["rent"]["levers"] == []
    assert "festival_week" in steps["covers"]["events"]
    assert all(steps[k]["decisions"] == [k[3:]] for k in steps if k.startswith("dp:"))
    for rv in r["reviews"]:
        assert {"cause_levers", "cause_events"} <= set(rv)
        if "understaffed" in rv["reason_codes"]:
            assert "staff_per_shift" in rv["cause_levers"]


def test_night_events_carry_mood_spend_reason():
    """§12.4: every event that belongs to a party (walk-ins, booked 회식, decision parties) has satisfaction, spend and
    reason; a party's events agree with each other and walk-aways spend nothing."""
    st = S.new_season(7)
    st["month_index"] = 2
    r = S.play_month(st, {**S.base_plan(), "group_reservations": True}, [], band_runs=3)
    ev = [e for e in r["night_events"] if "night" not in e and e.get("party") is not None]
    assert ev and all({"satisfaction", "spend", "reason"} <= set(e) for e in ev)
    by = {}
    for e in ev:
        by.setdefault(e["party"], set()).add((e["satisfaction"], e["spend"], e["reason"]))
    assert all(len(x) == 1 for x in by.values())
    assert all(e["spend"] == 0 for e in ev if e["type"] == "balk")
    assert all(0 <= e["satisfaction"] <= 1 for e in ev)




def test_reviews_name_the_decisions_that_touched_them():
    """§12.3: reviews from the decision night carry cause_decisions (and decision_party for the decision's own party);
    month reviews carry none; declining the party leaves no party review; unknown decision ids raise.
    달별 사건 이후 3월 개강 총회 단체 문의가 그 달의 유일한 결정이다(시작 10월이면 5번째 달). 협찬 후기처럼 반드시 쓰는 손님이
    없어서 후기는 확률로 나오므로, 단체 손님의 후기가 나올 때까지 시드를 바꿔 본다."""
    r = dp = start = st = None
    for seed in range(7, 31):
        st = S.new_season(seed)
        st["month_index"] = 5
        start = S.start_month(st, S.base_plan())
        assert [d["kind"] for d in start["decision_points"]] == ["semester_party"]
        dp = start["decision_points"][0]
        r = S.play_month(st, S.base_plan(), band_runs=3, night_choices={dp["id"]: "course"})
        if any(x.get("decision_party") == dp["id"] for x in r["reviews"]):
            break
    night = [x for x in r["reviews"] if x.get("from_decision_night")]
    assert r["decision_reviews"] == len(night) >= 1
    assert all(x["cause_decisions"] and set(x["cause_decisions"]) <= {d["id"] for d in start["decision_points"]} for x in night)
    assert any(x["decision_party"] == dp["id"] for x in night)
    assert all(x["cause_decisions"] == [] and x["decision_party"] is None for x in r["reviews"] if not x.get("from_decision_night"))
    declined = S.play_month(st, S.base_plan(), band_runs=3, night_choices={dp["id"]: "decline"})
    assert not any(x["decision_party"] == dp["id"] for x in declined["reviews"])
    with pytest.raises(ValueError):
        S.play_month(st, S.base_plan(), band_runs=3, night_choices={"dp9-nope": "x"})
