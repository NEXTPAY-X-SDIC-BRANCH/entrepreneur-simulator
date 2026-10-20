"""Load simulation inputs: hero-store parameters, sim-only assumptions, and the district demand profile.

Every hero-store number comes from research/hero_base.yaml (exported from the research workbook) and is
keyed by its ontology criterion_id. SIM_ASSUMPTIONS holds the few mechanism constants the ontology does not
carry yet; each one is illustrative and listed in docs/SIMULATION.md.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
HERO_YAML = ROOT / "research" / "hero_base.yaml"
SHOCKS_YAML = ROOT / "research" / "shocks.yaml"
PROFILE_JSON = ROOT / "data" / "processed" / "district_profile.json"
INDUSTRY_YAML = ROOT / "industry" / "pork_bbq.yaml"

# Mechanism constants with no criterion row yet. All illustrative (confidence L, no source).
SIM_ASSUMPTIONS = {
    "open_clock_min": 17 * 60,        # store opens 17:00; closes after drv_open_hours
    "last_seating_before_close": 60,  # minutes; no new seatings in the last hour
    "slot_min": 15,                   # arrival-profile resolution
    "max_party": 4,                   # party size = 1 + Binomial(3, p); all tables are 4-tops
    "party_size_categorical": None,   # sensitivity only: {size: prob} replaces the per-segment binomial
    "meal_price": 7000,               # 냉면·된장찌개 price; attach prob = side spend ÷ this
    "initial_order_ratio": 0.75,      # first order = ceil(ratio × target portions); rest are re-orders
    "dwell_sigma": 0.36,              # lognormal spread of dwell (CV 0.37 in Kimes & Robson 2004, S72)
    "dwell_alcohol_sensitivity": 0.3, # +10% bottles per cover → +3% dwell
    "dwell_factor_chobeol": 0.85,     # 초벌 shortens table grilling
    "dwell_factor_staff_grill": 0.90, # staff grilling is faster than self-grilling
    "patience_shape": 4.0,            # gamma shape; mean = mkt_patience
    "svc_order_min": 3.0,             # staff minutes to seat + take the first order
    "svc_reorder_min": 1.5,           # staff minutes per re-order (incl. 불판 교체)
    "svc_refill_per_bottle_min": 0.5, # staff minutes per bottle (drinks, 반찬 refills), one mid-meal visit
    "svc_pay_min": 2.0,               # staff minutes at the counter; the party holds its table meanwhile
    "svc_clear_min": 4.0,             # staff minutes to clear and reset a table (table blocked meanwhile)
    "svc_staff_grill_min": 10.0,      # staff minutes per table when svc_staff_grilling = Y
    "owner_on_floor": 1,              # servers = sto_parttimers + owner
    "closed_weekday": "mon",          # lowest 요일 share in 3120012; one closed day → 26 nights
    # Customer segments: which 상권 age bands feed which segment (card-sales age shares, S12).
    "segment_age_bands": {"twenties": ["age10", "age20"], "office": ["age30", "age40"],
                          "family": ["age50", "age60plus"]},
    "segment_early_before": 19 * 60,  # clock minute: arrivals before this use seg_*_early_mult
    "segment_late_from": 21 * 60,     # clock minute: arrivals from this use seg_*_late_mult
    # Decision 2.2 (flag game.peak_reshape): share of 17-21 arrivals per hour, an assumed 삼겹살 peak at 19-21.
    # The card data only gives the 17-21 band total, which is kept; the hourly split is an assumption (L).
    "peak_hour_weights_17_21": [0.12, 0.23, 0.33, 0.32],
}

SEGMENTS = ["twenties", "office", "family"]

WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TIMEBANDS = [("t00_06", 0, 6), ("t06_11", 6, 11), ("t11_14", 11, 14), ("t14_17", 14, 17),
             ("t17_21", 17, 21), ("t21_24", 21, 24)]


def load_params(path: Path = HERO_YAML) -> dict:
    """Return {criterion_id: base, ..., '_range': {id: (low, base, high)}, '_ref': frozen base copy}."""
    raw = yaml.safe_load(open(path, encoding="utf-8"))
    params, ranges = {}, {}
    for cid, row in raw.items():
        if cid.startswith("_"):
            continue
        params[cid] = row["base"]
        ranges[cid] = (row.get("low"), row["base"], row.get("high"))
    params["_range"] = ranges
    params["_pnl"] = raw.get("_pnl_base", {})
    params["_ref"] = {k: v for k, v in params.items() if not k.startswith("_")}
    return params


def clone(params: dict) -> dict:
    return copy.deepcopy(params)


def load_profile(profile_path: Path = PROFILE_JSON, industry_path: Path = INDUSTRY_YAML, n_quarters: int = 4) -> dict:
    """Average the latest n quarters of 요일 and time-band sales shares (weighted by sales) for the primary 상권."""
    industry = yaml.safe_load(open(industry_path, encoding="utf-8"))
    trdar = industry["trdar"]["primary"][0]
    prof = json.load(open(profile_path, encoding="utf-8"))["trdar"][trdar]
    qs = sorted(prof["quarters"])[-n_quarters:]
    w = [prof["quarters"][q]["hansik_sales_krw"] for q in qs]
    tot = sum(w)
    dow = {d: sum(prof["quarters"][q]["dow_share"][d] * wi for q, wi in zip(qs, w)) / tot for d in WEEK}
    band = {b: sum(prof["quarters"][q]["timeband_share"][b] * wi for q, wi in zip(qs, w)) / tot for b, _, _ in TIMEBANDS}
    ages = prof["quarters"][qs[-1]]["age_share"].keys()
    age = {k: sum(prof["quarters"][q]["age_share"][k] * wi for q, wi in zip(qs, w)) / tot for k in ages}
    return {"trdar": trdar, "trdar_name": prof["trdar_name"], "quarters": qs, "dow_share": dow, "timeband_share": band,
            "age_share": age, "game": industry.get("game", {})}


def band_intensity(profile: dict, clock_hour: float) -> float:
    """Sales share per hour of the band that contains clock_hour (hours, may exceed 24)."""
    h = clock_hour % 24
    for name, lo, hi in TIMEBANDS:
        if lo <= h < hi:
            return profile["timeband_share"][name] / (hi - lo)
    return 0.0


def arrival_slots(profile: dict, params: dict, a: dict = SIM_ASSUMPTIONS) -> list[tuple[float, float]]:
    """Piecewise-constant arrival shape: [(slot_start_min, share)] summing to 1.

    Card sales are stamped at payment, i.e. when a party leaves. A party arriving at t pays at about
    t + mean dwell, so the arrival weight of slot t is the sales intensity of the band containing
    t + dwell. Arrivals are limited to [open, close − last_seating_before_close].
    """
    open_min = params["drv_open_hours"] * 60
    last = open_min - a["last_seating_before_close"]
    dwell_h = params["drv_dwell_time"] / 60
    slots, t = [], 0.0
    while t < last:
        mid_clock_h = (a["open_clock_min"] + t + a["slot_min"] / 2) / 60
        slots.append((t, band_intensity(profile, mid_clock_h + dwell_h)))
        t += a["slot_min"]
    s = sum(w for _, w in slots)
    slots = [(t0, w / s) for t0, w in slots]
    if profile.get("game", {}).get("peak_reshape"):
        slots = reshape_peak(slots, a)
    return slots


def reshape_peak(slots: list[tuple[float, float]], a: dict = SIM_ASSUMPTIONS) -> list[tuple[float, float]]:
    """Redistribute arrivals between 17:00 and 21:00 by peak_hour_weights_17_21, keeping their total."""
    band = [(t0, w) for t0, w in slots if t0 < 240]
    total = sum(w for _, w in band)
    weights = a["peak_hour_weights_17_21"]
    per_hour = {h: sum(1 for t0, _ in band if int(t0 // 60) == h) for h in range(4)}
    out = []
    for t0, w in slots:
        if t0 < 240:
            h = int(t0 // 60)
            out.append((t0, total * weights[h] / sum(weights) / per_hour[h]))
        else:
            out.append((t0, w))
    return out


def dow_factors(profile: dict, a: dict = SIM_ASSUMPTIONS) -> dict:
    """Night demand relative to the average open night (closed weekday excluded)."""
    open_days = [d for d in WEEK if d != a["closed_weekday"]]
    mean = sum(profile["dow_share"][d] for d in open_days) / len(open_days)
    return {d: profile["dow_share"][d] / mean for d in open_days}


def month_nights(n_nights: int, a: dict = SIM_ASSUMPTIONS) -> list[str]:
    """The calendar of open nights, cycling Tue→Sun from the day after the closed day."""
    start = (WEEK.index(a["closed_weekday"]) + 1) % 7
    order = [WEEK[(start + i) % 7] for i in range(7) if WEEK[(start + i) % 7] != a["closed_weekday"]]
    return [order[i % len(order)] for i in range(n_nights)]
