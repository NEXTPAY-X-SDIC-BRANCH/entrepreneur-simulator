"""SimPy discrete-event model of the composite hero store: one night, one month, Monte Carlo.

One night (17:00 → close): parties arrive (non-homogeneous Poisson shaped by the 상권 time bands and 요일
share), wait for a free 4-top (indoor first, 야장 if open), walk away when the wait exceeds their patience,
order, grill, maybe re-order, pay and leave. Floor staff are a capacity-limited resource: taking orders,
re-orders, staff grilling and clearing tables all need a server, and a table is not free until cleared.
Fewer servers → slower table turnover → longer waits → more walk-aways.

Costs use the same parameters and arithmetic as the workbook P&L. Everything is seeded; the same seed
gives the same output. No LLM calls anywhere in sim/.
"""
from __future__ import annotations

import math

import numpy as np
import simpy

from sim.params import SEGMENTS, SIM_ASSUMPTIONS, arrival_slots, dow_factors, month_nights

KPIS = ["covers", "revenue", "ticket", "table_utilization", "avg_wait_min", "walkaways", "labor_hours",
        "cogs", "op", "op_margin", "revpash", "alcohol_share", "arrivals"]


def _yes(v) -> bool:
    return str(v).strip().upper() in ("Y", "YES", "TRUE", "1")


def effective(params: dict, elasticity: float) -> dict:
    """Per-run derived quantities. Price changes vs the reference (unshocked) prices move demand
    through a constant elasticity: arrivals × (meat price ÷ ref)^ε, bottles × (soju price ÷ ref)^ε."""
    ref = params["_ref"]
    meat_ratio = params["prd_meat_price"] / ref["prd_meat_price"]
    alc_ratio = params["prd_alcohol_price"] / ref["prd_alcohol_price"]
    # season mode passes a menu price index (meat, soju and meal prices weighted by the base revenue mix)
    price_ratio = params.get("_price_index", meat_ratio)
    return {
        "arrivals_per_night": params["drv_arrival_rate"] * price_ratio ** elasticity,
        "bottles_pp": params["prd_alcohol_per_cover"] * alc_ratio ** elasticity,
    }


def _dwell_mean(params: dict, bottles_pp: float, a: dict) -> float:
    base = params["drv_dwell_time"]
    if _yes(params.get("prd_chobeol")):
        base *= a["dwell_factor_chobeol"]
    if _yes(params.get("svc_staff_grilling")):
        base *= a["dwell_factor_staff_grill"]
    ref_b = params["_ref"]["prd_alcohol_per_cover"]
    return base * (1 + a["dwell_alcohol_sensitivity"] * (bottles_pp / ref_b - 1))


def segment_model(params: dict, profile: dict, a: dict = SIM_ASSUMPTIONS) -> dict:
    """Customer segments per arrival slot and their behaviour.

    P(segment | slot) ∝ the segment's 상권 card-sales age share × its early/late arrival weight (seg_*_early_mult
    before 19:00, seg_*_late_mult from 21:00). Party size, dwell, alcohol and patience are relative factors
    (seg_*_factor); each is rescaled so the store-wide mean equals its base parameter, which keeps the
    workbook P&L calibration while letting the segments differ.
    """
    slots = arrival_slots(profile, params, a)
    age = {s: sum(profile["age_share"][b] for b in a["segment_age_bands"][s]) for s in SEGMENTS}

    def weight(s, start):
        clock = a["open_clock_min"] + start + a["slot_min"] / 2
        if clock < a["segment_early_before"]:
            return age[s] * params[f"seg_{s}_early_mult"]
        if clock >= a["segment_late_from"]:
            return age[s] * params[f"seg_{s}_late_mult"]
        return age[s]

    probs = []
    for start, _ in slots:
        w = {s: weight(s, start) for s in SEGMENTS}
        tot = sum(w.values())
        probs.append([w[s] / tot for s in SEGMENTS])
    mix = {s: sum(sh * pr[i] for (_, sh), pr in zip(slots, probs)) for i, s in enumerate(SEGMENTS)}
    f = {k: {s: params[f"seg_{s}_{k}_factor"] for s in SEGMENTS} for k in ("party", "dwell", "alcohol", "patience")}
    m = params["mkt_party_size"]
    pf = sum(mix[s] * f["party"][s] for s in SEGMENTS)
    size = {s: min(float(a["max_party"]), 1 + (m - 1) * f["party"][s] / pf) for s in SEGMENTS}
    cov = {s: mix[s] * size[s] for s in SEGMENTS}
    alc_n = sum(cov[s] * f["alcohol"][s] for s in SEGMENTS) / sum(cov.values())
    dw_n = sum(mix[s] * f["dwell"][s] for s in SEGMENTS)
    pat_n = sum(mix[s] * f["patience"][s] for s in SEGMENTS)
    return {"slots": slots, "probs": probs, "mix": mix, "size": size,
            "alcohol": {s: f["alcohol"][s] / alc_n for s in SEGMENTS},
            "dwell": {s: f["dwell"][s] / dw_n for s in SEGMENTS},
            "patience": {s: f["patience"][s] / pat_n for s in SEGMENTS}}


def simulate_night(params: dict, profile: dict, dow: str, rng: np.random.Generator, *, elasticity: float,
                   terrace_open: bool, log: bool = False, a: dict = SIM_ASSUMPTIONS, seg: dict | None = None,
                   rain: bool = False, record: bool = False, streams: list | None = None,
                   hooks: list | None = None, mods: dict | None = None) -> dict:
    """One night. Season mode can pass `streams` (a seed list): arrivals and every party then draw from their own
    generators, so a decision taken mid-night (`hooks`: [(minute, fn(ctx))], `mods`: shared switches) changes what
    follows only through the mechanics (tables, staff, orders), never by reshuffling who walks in."""
    mods = {} if mods is None else mods
    arr_rng = np.random.default_rng([*streams, 0]) if streams is not None else rng
    eff = effective(params, elasticity)
    seg = seg or segment_model(params, profile, a)
    env = simpy.Environment()
    tables = simpy.PriorityStore(env)
    n_in = int(params["sto_tables"])
    seats_per = int(params["sto_seats_per_table"])
    n_ter = int(round(params["sto_terrace"] / seats_per)) if terrace_open else 0
    for i in range(n_in):
        tables.put(simpy.PriorityItem(0, f"T{i + 1:02d}"))
    for i in range(n_ter):
        tables.put(simpy.PriorityItem(1, f"Y{i + 1:02d}"))
    servers = max(1, int(params["sto_parttimers"]) + a["owner_on_floor"])
    staff = simpy.Resource(env, capacity=servers)

    open_min = params["drv_open_hours"] * 60
    dwell_mean = _dwell_mean(params, eff["bottles_pp"], a)
    attach = min(1.0, params["prd_side_spend_per_cover"] / a["meal_price"])
    staff_grill = _yes(params.get("svc_staff_grilling"))
    lam = eff["arrivals_per_night"] * dow_factors(profile, a)[dow]
    if rain:  # rainy night: fewer people on the street (wx_rain_arrival_effect); terrace closed by the caller
        lam *= 1 + params["wx_rain_arrival_effect"]

    events, res = [], {"arrivals": 0, "arrived_persons": 0, "covers": 0, "walkaways": 0, "walkaway_persons": 0,
                       "rev_meat": 0.0, "rev_alc": 0.0, "rev_side": 0.0, "portions": 0, "bottles": 0, "meals": 0,
                       "waits": [], "dwells": [], "table_busy_min": 0.0, "terrace_seatings": 0,
                       "covers_by_segment": {s: 0 for s in SEGMENTS}, "staff_work_min": 0.0, "parties": [],
                       "tables_available": n_in + n_ter, "seats_available": (n_in + n_ter) * seats_per,
                       "servers": servers}
    extra_min = a.get("svc_extra_per_party_min", 0.0)   # season mode: menu complexity etc.
    svc_mult = a.get("svc_speed_factor", 1.0)           # season mode: staff fatigue slows every task

    def ev(kind, pid, **kw):
        if log:
            t = env.now
            clock = a["open_clock_min"] + t
            events.append({"t": round(t, 2), "clock": f"{int(clock // 60) % 24:02d}:{int(clock % 60):02d}",
                           "type": kind, "party": pid, **kw})

    def work(minutes):
        res["staff_work_min"] += minutes
        return env.timeout(minutes)

    def clear(table_id, prio, seated_at):
        with staff.request() as s:
            yield s
            yield work(a["svc_clear_min"] * svc_mult)
        res["table_busy_min"] += env.now - seated_at
        ev("table_ready", None, table_id=table_id)
        claims = mods.get("table_claims")
        if claims:   # the owner promised the next free table to a party ahead of the queue
            claims.pop(0).succeed(simpy.PriorityItem(prio, table_id))
            return
        yield tables.put(simpy.PriorityItem(prio, table_id))

    seated = {}   # pid -> (table priority, seated at), while at the table

    def _flags(pid, prio, at):
        out = [f for t0, f, where in mods.get("seat_flags", []) if at >= t0 and (where == "all" or (where == "terrace" and prio == 1))]
        return out + list(mods.get("pid_flags", {}).get(pid, []))

    def party(pid, size, segment):
        prng = np.random.default_rng([*streams, 1, pid]) if streams is not None else rng
        res["arrivals"] += 1
        res["arrived_persons"] += size
        ev("arrive", pid, size=size, segment=segment)
        queued = not tables.items
        if queued:
            ev("queue", pid, size=size, queue_len=len(tables.get_queue))
        t0 = env.now
        patience = prng.gamma(a["patience_shape"], params["mkt_patience"] * seg["patience"][segment] / a["patience_shape"])
        req = tables.get()
        yield req | env.timeout(patience)
        if not req.triggered:
            req.cancel()
            res["walkaways"] += 1
            res["walkaway_persons"] += size
            ev("balk", pid, size=size, waited=round(env.now - t0, 2))
            if record:
                res["parties"].append({"pid": pid, "segment": segment, "size": size, "t": t0, "wait": env.now - t0,
                                       "svc_wait": 0.0, "queued": True, "walked": True, "bill": 0.0, "bottles": 0})
            return
        item = req.value
        table_id, prio = item.item, item.priority
        res["waits"].append(env.now - t0)
        res["covers"] += size
        res["covers_by_segment"][segment] += size
        if prio == 1:
            res["terrace_seatings"] += 1
        seated_at = env.now
        seated[pid] = (prio, seated_at)
        ev("seat", pid, size=size, table_id=table_id, waited=round(env.now - t0, 2))

        target = params["prd_portions_per_cover"] * size
        initial = max(1, math.ceil(a["initial_order_ratio"] * target))
        extra = int(prng.poisson(max(0.0, target - initial)))
        bottles = int(prng.poisson(eff["bottles_pp"] * seg["alcohol"][segment] * size))
        meals = int(prng.binomial(size, attach))
        t_req = env.now
        with staff.request() as s:
            yield s
            svc_wait = env.now - t_req
            yield work((a["svc_order_min"] + (a["svc_staff_grill_min"] if staff_grill else 0.0) + extra_min) * svc_mult)
        ev("order", pid, table_id=table_id, portions=initial, bottles=bottles, meals=meals)

        dwell = dwell_mean * seg["dwell"][segment] * prng.lognormal(-a["dwell_sigma"] ** 2 / 2, a["dwell_sigma"])
        yield env.timeout(dwell / 2)
        t_mid = env.now
        with staff.request() as s:  # mid-meal visit: drinks, refills, re-order
            yield s
            mid_wait = env.now - t_mid
            pat = a.get("reorder_patience_min")  # season mode: nobody comes, so the 추가 주문 does not happen
            if pat:
                keep = math.exp(-mid_wait / pat)
                extra = int(prng.binomial(extra, keep)) if extra else 0
                late = bottles // 2
                bottles = bottles - late + (int(prng.binomial(late, keep)) if late else 0)
            rk = mods.get("reorder_keep")   # a decision from minute rk[0] on: fewer 추가 주문 (e.g. a cut ran out)
            if rk and env.now >= rk[0] and extra:
                extra = int(prng.binomial(extra, rk[1]))
            yield work((a["svc_refill_per_bottle_min"] * bottles + (a["svc_reorder_min"] if extra else 0.0)) * svc_mult)
        if extra:
            ev("order", pid, table_id=table_id, portions=extra, bottles=0, meals=0, reorder=True)
        yield env.timeout(dwell / 2)
        with staff.request() as s:  # payment
            yield s
            yield work(a["svc_pay_min"] * svc_mult)

        portions = initial + extra
        r_meat = portions * params["prd_meat_price"]
        r_alc = bottles * params["prd_alcohol_price"]
        r_side = meals * a["meal_price"]
        res["rev_meat"] += r_meat
        res["rev_alc"] += r_alc
        res["rev_side"] += r_side
        res["portions"] += portions
        res["bottles"] += bottles
        res["meals"] += meals
        res["dwells"].append(env.now - seated_at)
        seated.pop(pid, None)
        if record:
            res["parties"].append({"pid": pid, "segment": segment, "size": size, "t": t0, "wait": seated_at - t0,
                                   "svc_wait": svc_wait, "mid_wait": mid_wait, "queued": queued, "walked": False,
                                   "bill": r_meat + r_alc + r_side, "bottles": bottles, "table_id": table_id,
                                   "flags": _flags(pid, prio, seated_at)})
        ev("leave", pid, table_id=table_id, bill=r_meat + r_alc + r_side, segment=segment)
        env.process(clear(table_id, prio, seated_at))

    def turned_away(pid, size, segment):
        res["arrivals"] += 1
        res["arrived_persons"] += size
        res["walkaways"] += 1
        res["walkaway_persons"] += size
        ev("arrive", pid, size=size, segment=segment)
        ev("balk", pid, size=size, waited=0.0, closed=True)
        if record:
            res["parties"].append({"pid": pid, "segment": segment, "size": size, "t": env.now, "wait": 0.0,
                                   "svc_wait": 0.0, "queued": False, "walked": True, "bill": 0.0, "bottles": 0,
                                   "flags": ["closed"]})

    def source():
        pid = 0
        for (start, share), probs in zip(seg["slots"], seg["probs"]):
            n = int(arr_rng.poisson(lam * share))
            for t in sorted(arr_rng.uniform(start, start + a["slot_min"], size=n)):
                segment = SEGMENTS[int(arr_rng.choice(len(SEGMENTS), p=probs))]
                cat = a.get("party_size_categorical")
                if cat:
                    sizes = sorted(cat)
                    size = int(sizes[int(arr_rng.choice(len(sizes), p=[cat[k] for k in sizes]))])
                else:
                    p_size = (seg["size"][segment] - 1) / (a["max_party"] - 1)
                    size = 1 + int(arr_rng.binomial(a["max_party"] - 1, min(1.0, p_size)))
                if t > env.now:
                    yield env.timeout(t - env.now)
                pid += 1
                stop = mods.get("stop_seating_from")
                leave = mods.get("door_leave")   # (minute, share): told at the door, some go elsewhere
                if stop is not None and env.now >= stop:
                    turned_away(pid, size, segment)
                elif leave and env.now >= leave[0] and np.random.default_rng([*(streams or [0]), 3, pid]).random() < leave[1]:
                    turned_away(pid, size, segment)
                else:
                    env.process(party(pid, size, segment))

    def special_party(pid, size, segment, n_tables, dwell, comp=False, flags=()):
        """A party a decision puts in the room (a walk-in 회식, a blogger): takes n tables as they free up."""
        res["arrivals"] += 1
        res["arrived_persons"] += size
        ev("arrive", pid, size=size, segment=segment, special=True)
        t0 = env.now
        got = []
        for _ in range(n_tables):
            if tables.items:
                item = yield tables.get()
            else:   # seated first: the next table that frees up is theirs, ahead of the waiting walk-ins
                claim = env.event()
                mods.setdefault("table_claims", []).append(claim)
                item = yield claim
            got.append(item)
        seated_at = env.now
        seated[pid] = (got[0].priority, seated_at)
        res["covers"] += size
        res["covers_by_segment"][segment] += size
        ids = [g.item for g in got]
        ev("seat", pid, size=size, table_id=ids[0], tables=ids, waited=round(env.now - t0, 2), special=True)
        portions = max(1, round(params["prd_portions_per_cover"] * size))
        bottles = round(eff["bottles_pp"] * seg["alcohol"][segment] * size)
        meals = round(size * attach)
        with staff.request() as s:
            yield s
            yield work((a["svc_order_min"] + extra_min) * n_tables * svc_mult)
        ev("order", pid, table_id=ids[0], portions=portions, bottles=bottles, meals=meals, special=True)
        yield env.timeout(dwell)
        r_meat, r_alc, r_side = portions * params["prd_meat_price"], bottles * params["prd_alcohol_price"], meals * a["meal_price"]
        bill = 0.0 if comp else r_meat + r_alc + r_side
        if not comp:
            res["rev_meat"] += r_meat
            res["rev_alc"] += r_alc
            res["rev_side"] += r_side
        res["portions"] += portions
        res["bottles"] += bottles
        res["meals"] += meals
        res["dwells"].append(env.now - seated_at)
        seated.pop(pid, None)
        if record:
            res["parties"].append({"pid": pid, "segment": segment, "size": size, "t": t0, "wait": seated_at - t0,
                                   "svc_wait": 0.0, "mid_wait": 0.0, "queued": False, "walked": False, "bill": bill,
                                   "bottles": bottles, "table_id": ids[0], "flags": list(flags), "special": True})
        ev("leave", pid, table_id=ids[0], bill=bill, segment=segment, special=True)
        for g in got:
            env.process(clear(g.item, g.priority, seated_at))

    def hold_tables(n, minutes):
        """Keep n tables out of use for a while (guests moved in from the rain), as they free up."""
        got = []
        for _ in range(n):
            item = yield tables.get()
            got.append(item)
        yield env.timeout(minutes)
        for g in got:
            yield tables.put(g)

    def hold_staff(minutes):
        """One server missing for a while (an 알바 late)."""
        with staff.request() as r:
            yield r
            yield env.timeout(minutes)

    env.process(source())
    ctx = {"env": env, "tables": tables, "staff": staff, "a": a, "params": params, "res": res, "mods": mods,
           "seated": seated, "special_party": special_party, "hold_tables": hold_tables, "hold_staff": hold_staff}

    def run_hook(t_h, fn):
        yield env.timeout(t_h)
        g = fn(ctx)
        if g is not None:
            yield from g

    for t_h, fn in (hooks or []):
        env.process(run_hook(t_h, fn))
    env.run()
    res["open_min"] = open_min
    res["events"] = events
    res["dow"] = dow
    res["terrace_open"] = terrace_open
    res["rain"] = rain
    return res


def simulate_month(params: dict, profile: dict, seed: int, *, a: dict = SIM_ASSUMPTIONS,
                   elasticity: float | None = None, record: bool = False) -> dict:
    """Roll up sto_open_days nights with the 요일 mix into the month KPIs and a P&L."""
    rng = np.random.default_rng(seed)
    if elasticity is None:
        lo, base, hi = params["_range"]["mkt_price_elasticity"]
        left, right = min(lo, hi), max(lo, hi)
        elasticity = float(rng.triangular(left, base, right))
    nights = month_nights(int(params["sto_open_days"]), a)
    seg = segment_model(params, profile, a)
    keys = ("arrivals", "arrived_persons", "covers", "walkaways", "walkaway_persons", "rev_meat", "rev_alc",
            "rev_side", "portions", "bottles", "meals", "table_busy_min", "terrace_seatings")
    tot = {k: 0.0 for k in (*keys, "table_min_available", "seat_hours_available")}
    by_seg = {s: 0 for s in SEGMENTS}
    waits, dwells, parties = [], [], []
    staff_work = staff_avail = 0.0
    rainy = 0
    per_night = []   # 밤별 합계: 화면의 일별 흐름에 쓴다
    for night_i, dow in enumerate(nights):
        rain = bool(rng.random() < params["wx_rain_nights_share"])
        terrace = bool(rng.random() < params["sto_terrace_availability"]) and not rain
        rainy += rain
        r = simulate_night(params, profile, dow, rng, elasticity=elasticity, terrace_open=terrace, a=a, seg=seg,
                           rain=rain, record=record)
        staff_work += r["staff_work_min"]
        staff_avail += r["servers"] * r["open_min"]
        n_rev = r["rev_meat"] + r["rev_alc"] + r["rev_side"]
        n_food = (r["portions"] * params["cst_meat_cost_per_portion"] + r["bottles"] * params["cst_alcohol_cost_per_bottle"]
                  + r["meals"] * a["meal_price"] * params["cst_side_cost_ratio"] + r["covers"] * params["cst_banchan_cost_per_cover"])
        per_night.append({"dow": dow, "rain": rain, "revenue": n_rev, "covers": r["covers"], "walkaways": r["walkaways"],
                          "cogs": n_food, "fees": n_rev * params["cst_card_share"] * params["cst_card_fee_rate"]})
        if record:
            parties += [{**pt, "night": night_i, "dow": dow, "rain": rain} for pt in r["parties"]]
        for k in keys:
            tot[k] += r[k]
        for s in SEGMENTS:
            by_seg[s] += r["covers_by_segment"][s]
        tot["table_min_available"] += r["tables_available"] * r["open_min"]
        tot["seat_hours_available"] += r["seats_available"] * r["open_min"] / 60
        waits += r["waits"]
        dwells += r["dwells"]
    n = len(nights)
    return {**month_pnl(params, tot, n, a), "avg_wait_min": float(np.mean(waits)) if waits else 0.0,
            "elasticity": elasticity, "covers_by_segment": by_seg,
            # driver-tree values (sim-measured, for the UI tree)
            "covers_day": tot["covers"] / n, "arrivals_day": tot["arrivals"] / n,
            "balk_rate": tot["walkaway_persons"] / tot["arrived_persons"] if tot["arrived_persons"] else 0.0,
            "dwell_avg_min": float(np.mean(dwells)) if dwells else 0.0, "nights": per_night,
            "seats_eff": tot["seat_hours_available"] / (params["drv_open_hours"] * n),
            "staff_load": staff_work / staff_avail if staff_avail else 0.0, "rainy_nights": rainy,
            **({"parties": parties} if record else {})}


def month_pnl(params: dict, tot: dict, n_nights: int, a: dict = SIM_ASSUMPTIONS) -> dict:
    """Same cost arithmetic as the workbook P&L, applied to simulated quantities."""
    p = params
    revenue = tot["rev_meat"] + tot["rev_alc"] + tot["rev_side"]
    food = (tot["portions"] * p["cst_meat_cost_per_portion"] + tot["bottles"] * p["cst_alcohol_cost_per_bottle"]
            + tot["meals"] * a["meal_price"] * p["cst_side_cost_ratio"] + tot["covers"] * p["cst_banchan_cost_per_cover"])
    labor = (p["sto_parttimers"] * p["sto_parttime_shift_hours"] * n_nights * p["sto_parttime_wage"]
             * p["cst_holiday_pay_factor"] + p["sto_employees"] * p["cst_employee_wage"] + p["cst_owner_imputed_wage"])
    rent = p["drv_rent"]
    mgmt = p["cst_utilities"] + p["cst_other_opex"]
    fees = revenue * p["cst_card_share"] * p["cst_card_fee_rate"]
    cost = food + labor + rent + mgmt + fees
    op = revenue - cost
    labor_hours = n_nights * (p["sto_parttimers"] * p["sto_parttime_shift_hours"]
                              + (p["sto_employees"] + a["owner_on_floor"]) * p["drv_open_hours"])
    return {
        "covers": tot["covers"], "arrivals": tot["arrivals"], "walkaways": tot["walkaways"],
        "revenue": revenue, "ticket": revenue / tot["covers"] if tot["covers"] else 0.0,
        "table_utilization": tot["table_busy_min"] / tot["table_min_available"],
        "labor_hours": labor_hours, "cogs": food, "labor": labor, "rent": rent, "mgmt": mgmt, "fees": fees,
        "cost": cost, "op": op, "op_margin": op / revenue if revenue else 0.0,
        "revpash": revenue / tot["seat_hours_available"],
        "alcohol_share": tot["rev_alc"] / revenue if revenue else 0.0,
        "alc_meat_ratio": tot["rev_alc"] / tot["rev_meat"] if tot["rev_meat"] else 0.0,
        "order_kg": tot["portions"] * p["prd_portion_grams"] / 1000,
        "terrace_seatings": tot["terrace_seatings"],
    }


def run_seeds(seed: int, runs: int) -> list[int]:
    """Child seeds shared by base and shock runs (common random numbers)."""
    return [int(s.generate_state(1)[0]) for s in np.random.SeedSequence(seed).spawn(runs)]


def monte_carlo(params: dict, profile: dict, runs: int = 200, seed: int = 42, param_fn=None,
                a: dict = SIM_ASSUMPTIONS) -> list[dict]:
    """runs × simulate_month. param_fn(params, rng) -> params lets shocks sample their delta per run."""
    out = []
    for s in run_seeds(seed, runs):
        p = param_fn(params, np.random.default_rng(s + 1)) if param_fn else params
        out.append(simulate_month(p, profile, s, a=a))
    return out


# Ontology driver node -> simulated month key (the UI driver tree shows these sim p50 values).
DRIVER_MAP = {
    "drv_operating_profit": "op", "drv_revenue": "revenue", "drv_total_cost": "cost", "drv_covers": "covers_day",
    "drv_ticket": "ticket", "drv_arrival_rate": "arrivals_day", "drv_seats": "seats_eff",
    "drv_dwell_time": "dwell_avg_min", "drv_balk_rate": "balk_rate", "drv_food_cost": "cogs",
    "drv_labor_cost": "labor", "drv_rent": "rent", "drv_mgmt_cost": "mgmt", "drv_fees": "fees",
    "cst_alcohol_meat_ratio": "alc_meat_ratio", "cst_order_volume": "order_kg", "lbl_revpash": "revpash",
}


def driver_p50(months: list[dict]) -> dict:
    return {node: float(np.median([m[key] for m in months])) for node, key in DRIVER_MAP.items()}


def summarize(months: list[dict], kpis: list[str] = KPIS) -> dict:
    return {k: {q: float(np.percentile([m[k] for m in months], pct)) for q, pct in (("p10", 10), ("p50", 50), ("p90", 90))}
            for k in kpis}


def sample_night(params: dict, profile: dict, seed: int, dow: str = "sat", terrace_open: bool | None = None) -> dict:
    """One logged night for the 3D replay (default: Saturday, the busiest open night). It rains on the sample
    night when at least half of the month's nights are rainy (SH10b), so the replay shows the worst case."""
    rng = np.random.default_rng(seed)
    rain = params["wx_rain_nights_share"] >= 0.5
    if terrace_open is None:
        terrace_open = params["sto_terrace_availability"] > 0 and not rain
    return simulate_night(params, profile, dow, rng, elasticity=params["mkt_price_elasticity"],
                          terrace_open=terrace_open, log=True, rain=rain)
