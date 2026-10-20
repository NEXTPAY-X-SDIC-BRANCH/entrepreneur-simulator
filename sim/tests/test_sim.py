"""Calibration + metamorphic tests. A broken mechanism (wrong sign, dead parameter) must fail the build."""
import numpy as np
import pytest

from sim.engine import monte_carlo, sample_night, simulate_month, summarize
from sim.owner_actions import MENU, apply_action
from sim.params import clone, load_params, load_profile
from sim.shocks import apply_shock, load_shocks

RUNS, SEED = 100, 11


@pytest.fixture(scope="module")
def base():
    return load_params()


@pytest.fixture(scope="module")
def profile():
    return load_profile()


@pytest.fixture(scope="module")
def shocks():
    return load_shocks()


@pytest.fixture(scope="module")
def base_months(base, profile):
    return monte_carlo(base, profile, RUNS, SEED)


def p50(months, k):
    return float(np.median([m[k] for m in months]))


def mc(params, profile, runs=RUNS, seed=SEED):
    return monte_carlo(params, profile, runs, seed)


# --- calibration against the workbook P&L ---------------------------------------------------------
def test_revenue_within_10pct_of_pnl(base, base_months):
    target = base["_pnl"]["rev"]
    assert abs(p50(base_months, "revenue") / target - 1) <= 0.10


def test_covers_within_10pct_of_pnl(base, base_months):
    assert abs(p50(base_months, "covers") / base["_pnl"]["covers_month"] - 1) <= 0.10


@pytest.mark.parametrize("sim_key,pnl_key", [("cogs", "food"), ("labor", "labor"), ("rent", "rent"),
                                             ("mgmt", "mgmt"), ("fees", "fees")])
def test_cost_shares_within_3pp_of_pnl(base, base_months, sim_key, pnl_key):
    sim_share = float(np.median([m[sim_key] / m["revenue"] for m in base_months]))
    pnl_share = base["_pnl"][pnl_key] / base["_pnl"]["rev"]
    assert abs(sim_share - pnl_share) <= 0.03, (sim_share, pnl_share)


def test_alcohol_share_matches_workbook(base, base_months):
    # The 17-25% band was an unverified blog range; after S62 (0.9 bottles) the share sits near 16.7%.
    pnl_share = base["_pnl"]["rev_alc"] / base["_pnl"]["rev"]
    assert abs(p50(base_months, "alcohol_share") - pnl_share) <= 0.02


# --- metamorphic -------------------------------------------------------------------------------------
def test_price_up_covers_down(base, profile, base_months):
    up = clone(base)
    up["prd_meat_price"] *= 1.10
    assert p50(mc(up, profile), "covers") < p50(base_months, "covers")


def test_price_down_covers_up(base, profile, base_months):
    down = clone(base)
    down["prd_meat_price"] *= 0.90
    assert p50(mc(down, profile), "covers") > p50(base_months, "covers")


def test_wage_up_op_down(base, profile, base_months):
    w = clone(base)
    w["sto_parttime_wage"] *= 1.10
    months = mc(w, profile)
    assert all(a["op"] < b["op"] for a, b in zip(months, base_months))


def test_more_seats_fewer_walkaways_at_peak(base, profile):
    peak = clone(base)
    peak["drv_arrival_rate"] *= 1.8
    wide = clone(peak)
    wide["sto_tables"] += 4
    assert sum(m["walkaways"] for m in mc(wide, profile)) < sum(m["walkaways"] for m in mc(peak, profile))


def test_demand_down_revenue_down(base, profile, base_months, shocks):
    months = monte_carlo(base, profile, RUNS, SEED, param_fn=lambda p, r: apply_shock(p, shocks["SH09"], r))
    assert p50(months, "revenue") < p50(base_months, "revenue")


def test_rain_every_night_terrace_unused(base, profile, shocks):
    rain = apply_shock(base, shocks["SH10b"])
    assert rain["wx_rain_nights_share"] == 1.0
    assert sum(m["terrace_seatings"] for m in mc(rain, profile, runs=30)) == 0
    assert sum(m["terrace_seatings"] for m in mc(base, profile, runs=30)) > 0
    night = sample_night(rain, profile, SEED)
    assert not any(e.get("table_id", "").startswith("Y") for e in night["events"] if e["type"] == "seat")


def test_average_rain_between_base_and_worst_case(base, profile, base_months, shocks):
    avg = monte_carlo(base, profile, RUNS, SEED, param_fn=lambda p, r: apply_shock(p, shocks["SH10"], r))
    worst = monte_carlo(base, profile, RUNS, SEED, param_fn=lambda p, r: apply_shock(p, shocks["SH10b"], r))
    assert p50(worst, "revenue") < p50(avg, "revenue") < p50(base_months, "revenue")


def test_peak_reshape_keeps_band_total_and_moves_peak(base, profile):
    from sim.params import arrival_slots
    flat = arrival_slots({**profile, "game": {}}, base)
    peak = arrival_slots({**profile, "game": {"peak_reshape": True}}, base)
    band = lambda sl, lo, hi: sum(w for t, w in sl if lo <= t < hi)  # noqa: E731
    assert band(peak, 0, 240) == pytest.approx(band(flat, 0, 240))
    assert sum(w for _, w in peak) == pytest.approx(1.0)
    assert band(peak, 120, 240) > band(peak, 0, 120)  # 19-21 busier than 17-19




def test_competitor_arrivals_down(base, profile, base_months, shocks):
    months = monte_carlo(base, profile, RUNS, SEED, param_fn=lambda p, r: apply_shock(p, shocks["SH11"], r))
    assert p50(months, "arrivals") < p50(base_months, "arrivals")


def test_pork_cost_up_op_down_revenue_same(base, profile, base_months, shocks):
    months = monte_carlo(base, profile, RUNS, SEED, param_fn=lambda p, r: apply_shock(p, shocks["SH03"], r))
    assert p50(months, "revenue") == p50(base_months, "revenue")
    assert p50(months, "op") < p50(base_months, "op")


def test_same_seed_identical(base, profile):
    assert simulate_month(base, profile, 123) == simulate_month(base, profile, 123)
    a, b = sample_night(base, profile, 5), sample_night(base, profile, 5)
    assert a["events"] == b["events"]


def test_shock_catalog_has_no_tech_adoption(shocks):
    touched = {r["parameter"] for s in shocks.values() for r in s["params"]}
    assert not touched & {"svc_qr_kiosk", "mkt_waitlist_app", "mkt_delivery"}


# --- owner actions are pure --------------------------------------------------------------------------
def test_owner_actions_pure_and_bounded(base):
    before = clone(base)
    out = apply_action(base, "reprice", pct=0.05)
    assert base == before
    assert out["prd_meat_price"] == pytest.approx(base["prd_meat_price"] * 1.05)
    with pytest.raises(ValueError):
        apply_action(base, "reprice", pct=0.5)
    assert set(MENU) >= {"absorb", "reprice", "cut_staff_hours", "change_mix"}


# --- calibration: OP margin and walk-away rate ------------------------------------------------------
def test_op_margin_within_1_5pp_of_pnl(base, base_months):
    pnl_margin = base["_pnl"]["op"] / base["_pnl"]["rev"]
    assert abs(p50(base_months, "op_margin") - pnl_margin) <= 0.015




# --- customer segments -------------------------------------------------------------------------------
def test_segment_means_pinned_to_base(base, profile):
    from sim.engine import segment_model
    sm = segment_model(base, profile)
    mix = sm["mix"]
    assert sum(mix.values()) == pytest.approx(1.0)
    assert sum(mix[s] * sm["size"][s] for s in mix) == pytest.approx(base["mkt_party_size"])
    cov = {s: mix[s] * sm["size"][s] for s in mix}
    assert sum(cov[s] * sm["alcohol"][s] for s in mix) / sum(cov.values()) == pytest.approx(1.0)
    assert sum(mix[s] * sm["dwell"][s] for s in mix) == pytest.approx(1.0)


def test_segments_behave_differently(base, profile):
    from sim.engine import segment_model
    sm = segment_model(base, profile)
    assert sm["alcohol"]["office"] > sm["alcohol"]["twenties"] > sm["alcohol"]["family"]
    assert sm["size"]["office"] > sm["size"]["twenties"]
    assert sm["patience"]["twenties"] > sm["patience"]["office"]


def test_family_weight_up_more_family_covers(base, profile, base_months):
    fam = clone(base)
    fam["seg_family_early_mult"] *= 2
    share = lambda ms: np.median([m["covers_by_segment"]["family"] / m["covers"] for m in ms])  # noqa: E731
    assert share(mc(fam, profile)) > share(base_months)


def test_event_log_carries_segment(base, profile):
    night = sample_night(base, profile, SEED)
    arrivals = [e for e in night["events"] if e["type"] == "arrive"]
    assert arrivals and all(e["segment"] in ("twenties", "office", "family") for e in arrivals)


# --- owner response loop -----------------------------------------------------------------------------




def test_every_menu_action_has_default_args_inside_bounds(base):
    for aid, spec in MENU.items():
        apply_action(base, aid, **spec["default_args"])  # raises if out of bounds


# --- season mode (lasting choices) ------------------------------------------------------------------






# --- game guard: no free lunch ----------------------------------------------------------------------
