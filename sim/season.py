"""Season engine v2 (docs/GAME-V2-SPEC.md §2-6, §11): one month = one turn, October to March.

  new_season(seed, mode)          -> state (dict, JSON-ready)
  draw_events(state)              -> [event ids] for the month about to be played (seeded; month-open)
  preview(state, plan, events)    -> fast analytic estimate (< 100 ms), no randomness
  play_month(state, plan, events) -> MonthResult (one seeded draw on the DES + a p10-p90 band), incl. state_after

State carries cash, rating, review count, 인지도, 단골 비율, staff fatigue, the plan, and persistent flags
(competitor open, rent raised, minimum wage raised). Every mechanism reads its numbers from
research/season_params.yaml, research/calendar.yaml and research/events.yaml, each tagged with a source or 가정.
The base plan in October with the starting state reproduces the hero base month (tests/test_season.py).
"""
from __future__ import annotations

import copy
import functools
import math
from pathlib import Path

import numpy as np
import yaml

from agents.ko import man_won
from sim.engine import simulate_month, simulate_night
from sim import menu as menu_mod   # lab:menu
from sim.params import ROOT, SEGMENTS, SIM_ASSUMPTIONS, clone, load_params, load_profile
from sim import rent_card  # lab:finance

RESEARCH = ROOT / "research"
SEGMENT_KO = {"twenties": "20대 친구 모임", "office": "직장인 회식", "family": "동네 가족"}
GRADE_KO = {"imported": "수입 냉동", "domestic": "국내산", "aged": "숙성"}
HYGIENE_KO = {"basic": "기본", "normal": "보통", "high": "철저"}
MOODS = ("great", "ok", "worried", "desperate")


# --- data ------------------------------------------------------------------------------------------------
@functools.lru_cache(maxsize=1)
def data() -> dict:
    load = lambda name: yaml.safe_load((RESEARCH / name).read_text(encoding="utf-8"))  # noqa: E731
    return {"P": load("season_params.yaml"), "CAL": load("calendar.yaml"), "EV": load("events.yaml")}


@functools.lru_cache(maxsize=1)
def _delivery_month_index() -> dict[int, float]:
    """달별 배달 배율 (pipelines/fetch_kosis_delivery.py, KOSIS 온라인쇼핑동향 음식서비스). 파일이 없으면 모든 달 1."""
    f = ROOT / "web" / "public" / "mock" / "delivery_market.json"
    if not f.exists():
        return {}
    import json
    return {int(k): float(x) for k, x in json.loads(f.read_text(encoding="utf-8"))["month_index"].items()}


def v(path: str):
    """season_params value by dotted path; {value: x} leaves are unwrapped."""
    node = data()["P"]
    for k in path.split("."):
        node = node[k]
    return node["value"] if isinstance(node, dict) and "value" in node else node


# --- store context -----------------------------------------------------------------------------------------
# 엔진의 기준 점포는 혜화동 25평 한 곳이다 (research/hero_base.yaml). set_store()로 점포 입력(평수, 테이블, 월세,
# 수요 규모)을 덮어쓰면 기준 점포가 그 점포로 바뀐다. 평소(baseline) 같은 캐시는 점포마다 따로 만든다.
# 덮어쓴 점포의 평소는 반복 횟수를 줄여(기본 150회) 몇십 초 안에 만들고 디스크에 저장한다.
_STORE_KEY = ""
_STORE_CACHED = ("_neutral_sat", "_baseline_cached", "_load_full", "_elasticity_samples", "_calibration", "_month_means")


def set_store(store: dict | None) -> None:
    """store = {"params": {criterion_id: value}, "arrival_scale": float, "baseline_runs": int} 또는 None(기준 점포)."""
    import json as _json
    global _STORE_KEY
    key = _json.dumps(store, sort_keys=True, ensure_ascii=False) if store else ""
    if key == _STORE_KEY:
        return
    _STORE_KEY = key
    for name in _STORE_CACHED:
        globals()[name].cache_clear()


def _store() -> dict:
    import json as _json
    return _json.loads(_STORE_KEY) if _STORE_KEY else {}


def _runs(path: str) -> int:
    """평소와 월별 평균에 쓰는 반복 횟수. 기준 점포는 yaml 값, 덮어쓴 점포는 store.baseline_runs."""
    if _STORE_KEY:
        return int(_store().get("baseline_runs", 150))
    return int(v(path))


@functools.lru_cache(maxsize=16)
def _base_for(key: str) -> tuple[dict, dict]:
    import json as _json
    base, prof = load_params(), load_profile()
    if key:
        st = _json.loads(key)
        for k, val in (st.get("params") or {}).items():
            base[k] = val
            base["_ref"][k] = val
        if st.get("profile"):   # 동네의 요일·시간대·연령 비율 (store_input.from_changeup flow)
            prof = {**prof, **{k: dict(v) for k, v in st["profile"].items()}}
        if "arrival_scale" in st:
            base["drv_arrival_rate"] = base["drv_arrival_rate"] * float(st["arrival_scale"])
            base["_ref"]["drv_arrival_rate"] = base["drv_arrival_rate"]
    return base, prof


def _base() -> tuple[dict, dict]:
    return _base_for(_STORE_KEY)


# 엔진 달력(calendar.yaml)은 10~3월뿐이다. 다른 달을 시작 달로 고르면 아래 값으로 채운다 (전부 가정).
#   수요 지수: 동네 분기 지수 (store.calendar.demand_index). 손님 구성: 중립, 대학가는 7~8월만 방학(1월 값).
_ALL_MONTHS = list(range(1, 13))
_VACATION = {"twenties": 0.7, "office": 1.0, "family": 1.05}
_EXT_NOTE = {4: "봄, 중간고사 철", 5: "야외 활동이 늘고 대학 축제가 있는 달", 6: "초여름, 기말고사 철", 7: "여름방학과 장마",
             8: "여름방학, 무더위", 9: "개강 시즌, 선선해지는 달"}
# 사건 확률 (4~9월 가정). 달마다 다른 사건만 따로 두고, 나머지는 가까운 달의 값을 쓴다.
_EXT_PROB = {
    "festival_week": {4: 0.20, 5: 0.45, 6: 0.10, 7: 0.0, 8: 0.0, 9: 0.40},
    "exam_week": {4: 0.30, 5: 0.0, 6: 0.40, 7: 0.0, 8: 0.0, 9: 0.0},
    "rain_week": {4: 0.10, 5: 0.15, 6: 0.30, 7: 0.45, 8: 0.40, 9: 0.25},
    "cold_wave": {4: 0.0, 5: 0.0, 6: 0.0, 7: 0.0, 8: 0.0, 9: 0.0},
}
_PROXY = {4: 3, 5: 10, 6: 11, 7: 11, 8: 11, 9: 10}   # 그 밖의 사건: 가까운 계절의 달 값


def _event_prob(eid: str, e: dict, m: int) -> float:
    pr = e.get("prob") or {}
    if m in pr:
        return float(pr[m])
    if eid in _EXT_PROB:
        return _EXT_PROB[eid].get(m, 0.0)
    return float(pr.get(_PROXY.get(m), 0.0))


def _calendar(m: int) -> dict:
    """달력 한 달. 점포 덮어쓰기에 calendar가 있으면 수요 지수를 그 동네의 분기 지수로 바꾼다.
    대학가가 아닌 동네는 방학·시험으로 20대 비중이 달라지는 효과(segment_mult)도 중립으로 둔다.
    calendar.yaml에 없는 달(4~9월)은 분기 지수와 중립 구성으로 만든다."""
    c = _store().get("calendar")
    base = data()["CAL"].get(m)
    if base is not None:
        cal = dict(base)
    else:
        cal = {"label": f"{m}월", "note": _EXT_NOTE.get(m, ""), "demand_index": 1.0,
               "segment_mult": dict(_VACATION) if m in (7, 8) else {"twenties": 1.0, "office": 1.0, "family": 1.0},
               "terrace_availability": 0.0, "rain_nights_share": 0.0, "group_bookings": 4,
               "tags": {"demand_index": "동네 분기 지수 (월 분할 없음)", "weather": "가정"}}
    if c and str(m) in c["demand_index"]:
        cal["demand_index"] = float(c["demand_index"][str(m)])
        if c.get("neutral_segments"):
            cal["segment_mult"] = {k: 1.0 for k in cal["segment_mult"]}
        cal["label"] = f"{m}월"
        cal["note"] = c.get("note", "") if base is not None else _EXT_NOTE.get(m, c.get("note", ""))
    return cal


def months() -> list[int]:
    ms = _store().get("months")
    return [int(x) for x in ms] if ms else data()["CAL"]["_meta"]["months"]


def base_plan() -> dict:
    return copy.deepcopy(data()["P"]["base_plan"])


# --- state -----------------------------------------------------------------------------------------------
def new_season(seed: int = 42, mode: str = "free", *, opening: bool = False, cash: float | None = None) -> dict:
    """opening=True starts a store that has just opened (no reviews, low 인지도, few 단골) instead of the established
    hero store. start.* stays the reference the demand multipliers are measured against; start_new.* is only the
    starting state. cash overrides the 운영자금 (what is left after the opening costs)."""
    st = {k: v(f"start.{k}") for k in ("cash", "rating", "review_count", "awareness", "regular_share", "fatigue")}
    if opening:
        st.update({k: v(f"start_new.{k}") for k in ("review_count", "awareness", "regular_share")})
    if cash is not None:
        st["cash"] = float(cash)
    st["rating_recent"] = st["rating_all"] = st["rating"]   # rating (= rating_recent) drives demand
    return {"engine": "sim.season v2", "mode": mode, "seed": int(seed), "month_index": 0, "opening": bool(opening), **st,
            "negative_months": 0, "low_revenue_months": 0, "closed": False, "closed_reason": None,
            "plan": base_plan(),
            "flags": {"competitor": False, "rent_mult": 1.0, "wage_mult": 1.0}, "history": []}


def current_month(state: dict) -> int:
    return months()[state["month_index"] % len(months())]


def _rng(state: dict, salt: int) -> np.random.Generator:
    return np.random.default_rng([int(state["seed"]), int(state["month_index"]), salt])


def draw_events(state: dict) -> list[str]:
    """Month-open draw: calendar probabilities, the 야장 noise complaint (if the current plan uses it), and the
    fatigue-driven staff quit. Seeded by (seed, month); at most _meta.max_per_month random events."""
    ev, m, rng = data()["EV"], current_month(state), _rng(state, 1)
    out = []
    excluded = set(_store().get("excluded_events") or [])   # 동네 유형에 맞지 않는 사건 (예: 대학가 행사)
    for eid, e in ev.items():
        if eid.startswith("_") or eid in excluded:
            continue
        p = _event_prob(eid, e, m)
        if any(state["plan"].get(k) != want for k, want in (e.get("requires") or {}).items()):
            continue   # e.g. 숙성육 편차 only when last month's stock was aged
        if eid == "owner_sick":
            p *= 1 + (v("fatigue.sick_mult_at_100") - 1) * state["fatigue"] / 100
        if eid == "competitor_open" and state["flags"]["competitor"]:
            p = 0.0
        if eid == "competitor_close" and not state["flags"]["competitor"]:
            p *= 0.5
        if rng.random() < p:
            out.append(eid)
    rng.shuffle(out)
    out = out[: ev["_meta"]["max_per_month"]]
    if state["plan"].get("terrace") and rng.random() < v("terrace.noise_complaint_prob"):
        out.append("noise_complaint")
    if rng.random() < quit_prob(state["fatigue"], state["plan"].get("staff_per_shift", 2)):
        out.append("staff_quit")
    return out


def quit_prob(fatigue: float, parttimers: int) -> float:
    """Chance that at least one 알바 quits this month: per person base rate, rising with fatigue above slow_from."""
    f = max(0.0, fatigue - v("fatigue.slow_from")) / (100 - v("fatigue.slow_from"))
    q = min(0.9, v("fatigue.quit_per_parttimer") + v("fatigue.quit_at_100") * f * f)
    return 1 - (1 - q) ** max(0, int(parttimers))


# --- plan + state + month + events -> engine inputs -------------------------------------------------------
def _validate(plan: dict) -> dict:
    p = {**base_plan(), **(plan or {})}
    if "menu" in p:   # lab:menu  메뉴판이 있으면 가격 수준을 삼겹살·소주 기준으로 환산 (sim/menu.py). 없으면 예전 그대로
        p["menu"] = menu_mod.clean(p["menu"], "bbq")
        if p["menu"]:
            menu_mod.check_levels(p["menu"], "bbq")   # 가격 수준이 엔진 범위 밖이면 오류 (아래 가격 clamp를 우회하지 않게)
            g_ = data()["P"]["meat_grade"].get(p["meat_grade"], data()["P"]["meat_grade"]["domestic"])
            menu_mod.check_grade_cost(p["menu"], GRADE_KO.get(p["meat_grade"], "국내산"), g_["cost"])
            p["meat_price"], p["soju_price"] = menu_mod.bbq_plan_prices(p["menu"], base_plan()["meat_price"], base_plan()["soju_price"])
            if p.get("table_cost") is not None:   # 기본 상차림 원가 (원/손님, 반찬 5가지 기준)
                p["table_cost"] = float(p["table_cost"])
                if not 500 <= p["table_cost"] <= 20000:
                    raise ValueError("기본 상차림 원가는 손님 1명당 500원 ~ 2만원이어야 합니다")
        else:
            del p["menu"]
    p["meat_price"] = int(min(max(p["meat_price"], 12000), 30000))
    p["soju_price"] = int(min(max(p["soju_price"], 3000), 9000))
    p["meat_grade"] = p["meat_grade"] if p["meat_grade"] in data()["P"]["meat_grade"] else "domestic"
    p["menu_extras"] = [x for x in p.get("menu_extras", []) if x in data()["P"]["menu_extras"]]
    p["banchan"] = int(min(max(p["banchan"], 2), 10))
    p["staff_per_shift"] = int(min(max(p["staff_per_shift"], v("staff.min_per_shift")), v("staff.max_per_shift")))
    p["close_hour"] = int(p["close_hour"]) if int(p["close_hour"]) in (23, 24, 25) else 24
    p["marketing_budget"] = int(min(max(p["marketing_budget"], 0), 3_000_000))
    p["hygiene"] = p["hygiene"] if p["hygiene"] in ("basic", "normal", "high") else "normal"
    p["delivery"] = p.get("delivery") if p.get("delivery") in data()["P"]["delivery"]["tier"] else "none"
    for k in ("staff_grilling", "lunch", "terrace", "review_event", "group_reservations"):
        p[k] = bool(p[k])
    return p


def _setup(state: dict, plan: dict, events: list[str], *, closure_days: int = 0, quit_now: bool = False) -> dict:
    """Engine params + assumptions + profile for this month, plus the off-DES pieces (lunch, groups, marketing)."""
    P, EV = data()["P"], data()["EV"]
    base, profile = _base()
    m = current_month(state)
    cal = _calendar(m)
    plan = _validate(plan)
    p = clone(base)
    a = dict(SIM_ASSUMPTIONS)
    flags = dict(state["flags"])

    # event parameter ops (collected first, applied after the plan mapping)
    ops, demand_ev = [], 1.0
    for eid in events:
        eff = EV[eid]["effects"]
        ops += eff.get("params", [])
        demand_ev *= eff.get("demand", 1.0)
        if eff.get("persist") == "competitor_on":
            flags["competitor"] = True
        if eff.get("persist") == "competitor_off":
            flags["competitor"] = False
        if eff.get("persist") == "rent_up":
            flags["rent_mult"] = flags["rent_mult"] * 1.05
    op_mult = {}
    for o in ops:
        if o["op"] == "mul":
            op_mult[o["param"]] = op_mult.get(o["param"], 1.0) * o["value"]

    # price, meat grade (cost and quality), banchan, menu extras
    p["prd_meat_price"] = plan["meat_price"]
    p["prd_alcohol_price"] = plan["soju_price"]
    # customers choose a store on its menu prices: weighted by the base revenue mix (가정 weights from the P&L)
    pnl = base["_pnl"]
    w_meat, w_alc = pnl["rev_meat"] / pnl["rev"], pnl["rev_alc"] / pnl["rev"]
    g = P["meat_grade"][plan["meat_grade"]]
    # the menu must state the meat's origin (원산지 표시), so the grade acts at the door like a price change:
    # 수입 냉동 at ₩19,000 reads like a dearer menu, 숙성 like a cheaper one (weight 가정)
    perceived = plan["meat_price"] / (1 + v("meat_grade.door_weight") * g["tolerance"])
    p["_price_index"] = (w_meat * perceived / base["prd_meat_price"] + w_alc * plan["soju_price"] / base["prd_alcohol_price"]
                         + (1 - w_meat - w_alc))
    pork = op_mult.get("cst_meat_cost_per_portion", 1.0)
    if plan["meat_grade"] == "imported":
        pork = (1 + (pork - 1) * v("meat_grade.pork_event_strength_imported")) * op_mult.get("import_meat_cost_mult", 1.0)
    elif plan["meat_grade"] == "aged":
        pork = 1 + (pork - 1) * v("meat_grade.pork_event_strength_aged")
    if plan.get("use_pork_forecast"):  # lab:pork — 원가가 돼지고기 도매가 예측(sim/pork_forecast.py)을 따른다. 기본 끔
        from sim.pork_forecast import meat_cost_mult
        strength = {"imported": v("meat_grade.pork_event_strength_imported"),
                    "aged": v("meat_grade.pork_event_strength_aged")}.get(plan["meat_grade"], 1.0)
        pork *= 1 + (meat_cost_mult(m) - 1) * strength
    p["cst_meat_cost_per_portion"] = g["cost"] * pork
    extras = [P["menu_extras"][x] for x in plan["menu_extras"]]
    p["cst_banchan_cost_per_cover"] = (plan["banchan"] * v("banchan.cost_per_item") * op_mult.get("cst_banchan_cost_per_cover", 1.0)
                                       + sum(x["cost_per_cover"] for x in extras))
    a["svc_extra_per_party_min"] = v("staff.table_tasks_min") + sum(x["service_min"] for x in extras)
    a["reorder_patience_min"] = v("staff.reorder_patience_min")
    if plan.get("menu"):   # lab:menu  메뉴판 → 1인분·1병 평균 가격과 원가, 사이드 지출과 원가율 (sim/menu.py)
        menu_mod.apply_bbq(p, a, plan["menu"], pork, w_meat, w_alc, base["prd_side_spend_per_cover"],
                           {"cost": plan.get("table_cost"), "extras": sum(x["cost_per_cover"] for x in extras),
                            "base_banchan": base_plan()["banchan"], "unit": v("banchan.cost_per_item")})

    # service: staff grilling, staff per shift (a sudden quit removes one this month), fatigue slows service
    p["svc_staff_grilling"] = "Y" if plan["staff_grilling"] else "N"
    a["dwell_factor_staff_grill"] = v("staff_grilling.dwell_factor")
    staff = plan["staff_per_shift"] - (1 if quit_now else 0)
    p["sto_parttimers"] = max(0, staff)
    f = state["fatigue"]
    a["svc_speed_factor"] = 1 + v("fatigue.slow_at_100") * max(0.0, f - v("fatigue.slow_from")) / (100 - v("fatigue.slow_from"))

    # hours: close 23 / 24 / 01시
    extra_h = plan["close_hour"] - 24
    p["drv_open_hours"] = base["drv_open_hours"] + extra_h
    p["sto_parttime_shift_hours"] = base["sto_parttime_shift_hours"] + extra_h
    hours_demand = data()["P"]["hours"]["demand"][plan["close_hour"]]
    util_mult = 1 + v("hours.utilities_per_hour_share") * extra_h + (v("lunch.utilities_share") if plan["lunch"] else 0)
    p["cst_utilities"] = base["cst_utilities"] * util_mult

    # space, weather, calendar
    p["sto_terrace"] = base["sto_terrace"] if plan["terrace"] else 0
    p["sto_terrace_availability"] = cal["terrace_availability"]
    p["wx_rain_nights_share"] = cal["rain_nights_share"]
    p["sto_open_days"] = max(1, cal.get("open_days", base["sto_open_days"]) - closure_days)
    if plan["group_reservations"]:
        p["sto_tables"] = base["sto_tables"] - v("groups.blocked_tables")

    # fixed costs that persist (rent at renewal, minimum wage from January)
    if cal.get("min_wage_change") and flags["wage_mult"] == 1.0:
        flags["wage_mult"] = 1 + cal["min_wage_change"]
    p["sto_parttime_wage"] = base["sto_parttime_wage"] * flags["wage_mult"]
    p["drv_rent"] = base["drv_rent"] * flags["rent_mult"]

    # demand: calendar x reputation x 인지도 x 단골 x 경쟁 x events x hours x menu appeal
    mix_tw = 0.25
    appeal = sum(x["appeal_twenties"] for x in extras)
    demand = {
        "calendar": cal["demand_index"],
        "rating": 1 + v("demand.rating_per_star") * (state["rating"] - v("start.rating")),
        "awareness": state["awareness"] ** v("demand.awareness_exponent"),
        "regulars": 1 + v("demand.regular_effect") * (state["regular_share"] - v("start.regular_share")),
        "competitor": v("demand.competitor_effect") if flags["competitor"] else 1.0,
        "events": demand_ev,
        "hours": hours_demand,
        "menu": 1 + mix_tw * appeal,
    }
    p["drv_arrival_rate"] = base["drv_arrival_rate"] * math.prod(demand.values())

    # remaining event ops (set / mul / add on engine params)
    for o in ops:
        k = o["param"]
        if k in ("cst_meat_cost_per_portion", "import_meat_cost_mult", "cst_banchan_cost_per_cover"):
            continue
        if k not in p:
            continue
        p[k] = o["value"] if o["op"] == "set" else p[k] * o["value"] if o["op"] == "mul" else p[k] + o["value"]

    prof = copy.deepcopy(profile)
    seg_mult = dict(cal["segment_mult"])
    seg_mult["twenties"] = seg_mult["twenties"] * (1 + appeal)
    for s_, bands in a["segment_age_bands"].items():
        for b in bands:
            prof["age_share"][b] *= seg_mult[s_]

    servers = max(1, p["sto_parttimers"] + a["owner_on_floor"])
    writeoff = sum(EV[e]["effects"].get("meat_writeoff", 0.0) for e in events
                   if plan["meat_grade"] == (EV[e].get("requires") or {}).get("meat_grade", plan["meat_grade"]))
    off = {"meat_writeoff": writeoff, "tables_per_server": p["sto_tables"] / servers, "fatigue": state["fatigue"], "lunch": plan["lunch"], "groups": plan["group_reservations"], "staff_grilling": plan["staff_grilling"],
           "group_bookings": cal["group_bookings"], "waste": sum(x["waste"] for x in extras),
           "hygiene_hours": P["hygiene"][plan["hygiene"]]["labor_hours"], "marketing": plan["marketing_budget"],
           "review_event": plan["review_event"], "open_days": p["sto_open_days"], "delivery": plan["delivery"],
           "lunch_demand": cal["demand_index"] * demand["rating"] * demand["awareness"]}
    return {"params": p, "a": a, "profile": prof, "plan": plan, "flags": flags, "demand": demand, "off": off, "events": list(events),
            "month": m, "cal": cal, "tolerance": g["tolerance"], "price_ceiling": g.get("price_ceiling"),
            "quality": g["quality"] + sum(EV[e]["effects"].get("quality", 0.0) for e in events
                                          if not EV[e].get("requires") or plan["meat_grade"] == EV[e]["requires"].get("meat_grade"))}


# --- money: DES month + off-DES pieces -> one P&L ----------------------------------------------------------
def _pnl(month: dict, su: dict, rng: np.random.Generator | None, n_reviews: float) -> dict:
    p, off = su["params"], su["off"]
    wage_cost = p["sto_parttime_wage"] * p["cst_holiday_pay_factor"]
    covers, revenue = month["covers"], month["revenue"]
    ticket = month["ticket"]
    food_ratio = month["cogs"] / revenue if revenue else 0.38
    out = {"dinner_covers": covers, "dinner_revenue": revenue, "dinner_ticket": ticket,
           "cogs": month["cogs"] * (1 + off["waste"]) + off["meat_writeoff"] * covers * p["prd_portions_per_cover"] * p["cst_meat_cost_per_portion"],
           "labor": month["labor"] + off["hygiene_hours"] * wage_cost,
           "rent": month["rent"], "mgmt": month["mgmt"] + off["marketing"], "lunch_revenue": 0.0, "group_revenue": 0.0,
           "lunch_covers": 0.0, "group_covers": 0.0, "groups": 0.0}
    if off["lunch"]:
        lc = v("lunch.covers_per_day") * off["open_days"] * off["lunch_demand"]
        out["lunch_covers"] = lc
        out["lunch_revenue"] = lc * v("lunch.ticket")
        out["cogs"] += out["lunch_revenue"] * v("lunch.food_ratio")
        out["labor"] += v("lunch.parttime_hours_per_day") * off["open_days"] * wage_cost
    if off["groups"]:
        g_mean = off["group_bookings"] * (v("staff_grilling.group_appeal") if off["staff_grilling"] else 1.0)
        n = rng.binomial(int(round(g_mean)), 1 - v("groups.noshow")) if rng is not None else g_mean * (1 - v("groups.noshow"))
        gc = n * v("groups.people") * v("groups.incremental")
        out["groups"], out["group_covers"] = float(n), gc
        out["group_revenue"] = gc * ticket * v("groups.spend_factor") * (1 - v("groups.discount"))
        out["cogs"] += out["group_revenue"] * food_ratio
    if off["review_event"]:
        out["mgmt"] += v("marketing.review_event_fixed") + v("marketing.review_event_cost_per_review") * n_reviews
    # lab:cost — parts of mgmt and labor for the cost-stack panel (sim/opex.py splits them; mgmt total unchanged)
    out["opex_util"], out["opex_other"] = p["cst_utilities"], p["cst_other_opex"]
    out["opex_mkt"] = out["mgmt"] - month["mgmt"]
    out["labor_owner"] = p["cst_owner_imputed_wage"]
    rev = revenue + out["lunch_revenue"] + out["group_revenue"]
    out["fees"] = rev * p["cst_card_share"] * p["cst_card_fee_rate"]
    out["delivery_revenue"] = out["delivery_fee"] = out["delivery_orders"] = 0.0
    if off.get("delivery", "none") != "none":
        # 배달 매출 = 저녁 매출 x 배달 비중 x 달별 배율. 그중 cannibal 몫은 원래 매장에 왔을 손님이라 매장 매출에서 뺀다.
        # 앱 결제라 매장 카드 수수료는 붙지 않고, 중개수수료·결제대행 수수료·건당 배달비·포장재가 나간다.
        # 결제대행 수수료는 영세·중소 우대수수료율로 환급되므로 매장 카드 수수료율과 같게 둔다 (쿠팡이츠 상생 요금제 공지).
        d_rev = revenue * v("delivery.share") * _delivery_month_index().get(su["month"], 1.0)
        lost = d_rev * v("delivery.cannibal")
        orders = d_rev / (ticket * v("delivery.people_per_order")) if ticket else 0.0
        tier = data()["P"]["delivery"]["tier"][off["delivery"]]
        fee = (d_rev * (tier["commission"] + p["cst_card_fee_rate"])
               + orders * (tier["rider_fee"] + v("delivery.packaging_per_order")))
        out["cogs"] += (d_rev - lost) * food_ratio
        out["fees"] += fee - lost * p["cst_card_share"] * p["cst_card_fee_rate"]
        out["delivery_revenue"], out["delivery_fee"], out["delivery_orders"] = d_rev, fee, orders
        rev += d_rev - lost
    out["revenue"] = rev
    out["covers"] = covers + out["lunch_covers"] + out["group_covers"]
    out["cost"] = out["cogs"] + out["labor"] + out["rent"] + out["mgmt"] + out["fees"]
    out["op"] = rev - out["cost"]
    out["op_margin"] = out["op"] / rev if rev else 0.0
    out["ticket"] = ticket
    for k in ("walkaways", "avg_wait_min", "table_utilization", "staff_load", "alcohol_share", "revpash"):
        out[k] = month[k]
    if "staff_load_raw" in month:
        out["staff_load_raw"] = month["staff_load_raw"]
    return out


# --- customers: satisfaction, reviews, bubbles ---------------------------------------------------------------
REASON_KO = {
    "wait_long": "너무 오래 기다림", "service_slow": "주문이 늦게 나옴", "price_high": "비싸다", "price_good": "가격이 착하다",
    "meat_good": "고기 좋다", "meat_bad": "고기가 별로", "banchan_good": "반찬이 푸짐", "banchan_poor": "반찬이 아쉽다",
    "clean": "깔끔하다", "dirty": "위생이 아쉽다", "staff_grill": "구워 줘서 편하다", "soju_high": "소주가 비싸다",
    "crowded": "북적거린다", "menu_fun": "메뉴가 재밌다", "hyped": "기대보다 별로", "understaffed": "직원 부르기 힘들다",
    "tired_staff": "직원이 지쳐 보인다", "comped": "이벤트 서비스를 받고 쓴 리뷰", "meat_swapped": "고기가 다른 부위로 바뀌었다",
    "moved_inside": "비 때문에 자리를 옮겼다", "rain_tarp": "비를 맞으며 먹었다", "comp": "협찬으로 대접받았다", "noisy_group": "단체 손님이 시끄러웠다", "reviews_inflated": "별점이 이벤트로 부풀려진 것 같다",
}


def satisfaction(party: dict, su: dict) -> tuple[float, dict]:
    """0-1 score and its signed terms (the review engine uses the terms as reason codes)."""
    S, plan = data()["P"]["satisfaction"], su["plan"]
    val = lambda k: S[k]["value"]  # noqa: E731
    seg = party["segment"]
    t = {}
    t["wait_long"] = max(val("wait_cap"), val("wait_per_10min") * party["wait"] / 10)
    t["service_slow"] = val("service_wait_per_5min") * max(0.0, party["svc_wait"] + party.get("mid_wait", 0.0) - 3) / 5
    t["meat_good"] = val("quality_weight") * (su["quality"] - 0.6)
    exp_price = S["expected_price"][seg] * (1 + su["tolerance"])
    if su.get("price_ceiling"):   # what customers accept for this grade tops out (원산지 on the menu)
        exp_price = min(exp_price, su["price_ceiling"])
    r = plan["meat_price"] / exp_price
    t["price_high"] = val("price_over_weight") * max(0.0, r - 1) + val("price_under_weight") * max(0.0, 1 - r)
    if su.get("price_ceiling"):   # past the grade's price resistance line, better meat no longer excuses the price
        t["price_high"] += val("price_over_ceiling_weight") * max(0.0, plan["meat_price"] / su["price_ceiling"] - 1)
    t["soju_high"] = val("soju_over_weight") * max(0.0, plan["soju_price"] / val("expected_soju") - 1)
    t["banchan_good"] = v("banchan.satisfaction_per_item") * (plan["banchan"] - 5)
    t["clean"] = val("clean_weight") * (data()["P"]["hygiene"][plan["hygiene"]]["cleanliness"] - 0.65)
    t["staff_grill"] = (v("staff_grilling.satisfaction_office_family") if seg != "twenties" else v("staff_grilling.satisfaction")) \
        if plan["staff_grilling"] else 0.0
    t["menu_fun"] = sum(data()["P"]["menu_extras"][x]["appeal_twenties"] for x in plan["menu_extras"]) if seg == "twenties" else 0.0
    t["crowded"] = val("crowd_penalty") if party["queued"] else 0.0
    t["hyped"] = -v("marketing.expectation_per_million") * plan["marketing_budget"] / 1e6
    tps = su["off"]["tables_per_server"]
    t["understaffed"] = max(v("staff.attentive_penalty_cap"),
                            v("staff.attentive_penalty_per_table") * max(0.0, tps - v("staff.attentive_tables_per_server")))
    t["tired_staff"] = v("staff.tired_penalty_at_100") * max(0.0, su["off"]["fatigue"] - v("staff.tired_from")) / (100 - v("staff.tired_from"))
    for f in party.get("flags", ()):   # what happened to this party during an in-night decision
        x = S["flag_terms"]["value"].get(f)
        if x:
            t[f] = x
    s = val("base") + sum(t.values())
    if party["walked"]:
        s = min(s, 0.15)
    return float(min(1.0, max(0.0, s))), t


NEG_NAME = {"meat_good": "meat_bad", "banchan_good": "banchan_poor", "clean": "dirty"}
POS_NAME = {"price_high": "price_good"}


def _codes(terms: dict, s: float, positive_first: bool = False) -> list[str]:
    """Reason codes: the strongest negative terms, the strongest positive ones for satisfied parties. A 4-5 star
    review leads with what went right (an incentivized one may still carry only negatives: inflated stars)."""
    neg = [NEG_NAME.get(k, k) for k, x in sorted(terms.items(), key=lambda kv: kv[1]) if x < -0.02][:2]
    pos = [POS_NAME.get(k, k) for k, x in sorted(terms.items(), key=lambda kv: -kv[1]) if x > 0.02][:2]
    if s >= 0.6 and not pos:
        pos = ["meat_good"]
    out = (pos + neg) if positive_first else neg + (pos if s >= 0.5 else [])
    return out[:3]


def _bubble_code(terms: dict, s: float, rng: np.random.Generator) -> str | None:
    """One speech bubble per noticeable party, drawn with weight |term| so the room says different things
    (not only its loudest complaint). Satisfied parties may praise; unhappy ones only complain."""
    cands = [(NEG_NAME.get(k, k), -x) for k, x in terms.items() if x < -0.02]
    if s >= 0.5:
        cands += [(POS_NAME.get(k, k), x) for k, x in terms.items() if x > 0.02]
    if s >= 0.6:
        cands.append(("meat_good", 0.04))
    if not cands:
        return None
    w = np.array([c[1] for c in cands])
    return cands[int(rng.choice(len(cands), p=w / w.sum()))][0]


# reason code -> the levers a player can pull about it, and the month events that push it (§12.3)
_CODE_LEVERS = {
    "price_high": ("meat_price", "meat_grade"), "price_good": ("meat_price", "meat_grade"), "soju_high": ("soju_price",),
    "meat_good": ("meat_grade",), "meat_bad": ("meat_grade",), "banchan_good": ("banchan",), "banchan_poor": ("banchan",),
    "clean": ("hygiene",), "dirty": ("hygiene",), "staff_grill": ("staff_grilling",),
    "understaffed": ("staff_per_shift",), "service_slow": ("staff_per_shift", "staff_grilling"),
    "tired_staff": ("staff_per_shift", "close_hour", "lunch"), "wait_long": ("terrace", "group_reservations", "meat_price"),
    "crowded": ("terrace", "group_reservations"), "menu_fun": ("menu_extras",), "hyped": ("marketing_budget",),
    "comped": ("review_event",), "reviews_inflated": ("review_event",),
}
_CODE_EVENTS = {
    "wait_long": ("festival_week", "viral_blog", "competitor_close"), "crowded": ("festival_week", "viral_blog", "competitor_close"),
    "service_slow": ("staff_quit", "owner_sick"), "understaffed": ("staff_quit",), "tired_staff": ("staff_quit",),
    "meat_bad": ("aged_spoilage",), "price_high": ("pork_up",), "dirty": ("hygiene_inspection",),
}


def _reviews(parties: list[dict], su: dict, rng: np.random.Generator, month_label: str, mi: int) -> tuple[list, float, int]:
    R = data()["P"]["reviews"]
    prob_mult = v("marketing.review_event_prob_mult") if su["plan"]["review_event"] else 1.0
    event = su["plan"]["review_event"]
    out, total_s, total_l, n_s = [], 0.0, 0.0, 0
    for pt in parties:
        s, terms = satisfaction(pt, su)
        total_s += s
        total_l += _loyal(s, terms)
        n_s += 1
        pr = R["base_prob"]["value"] * R["segment_mult"][pt["segment"]] * prob_mult * (R["walkaway_prob_mult"]["value"] if pt["walked"] else 1)
        if rng.random() < pr:
            # with a review event, about 2 in 3 reviewers write for the reward (S82): their stars run high and noisy
            inc = bool(event and rng.random() < v("marketing.review_event_share"))
            bias = v("marketing.review_event_star_bias") if inc else 0.0
            noise = v("satisfaction.star_noise") + (v("marketing.review_event_star_noise") if inc else 0.0)
            # a party at the base satisfaction gives the starting rating on average (가정 mapping, slope 5 stars per 1.0)
            star = int(min(5, max(1, round(v("start.rating") + v("satisfaction.star_slope") * (s - _neutral_sat()["s"])
                                           + bias + rng.normal(0, noise)))))
            codes = _codes(terms, s, positive_first=star >= 4)
            if inc:
                codes.append("comped")
            elif event and s < _neutral_sat()["s"] and rng.random() < v("marketing.review_event_skeptic_prob"):
                codes.append("reviews_inflated")   # an organic reviewer who finds the rating oversold
            out.append({"id": f"r{mi + 1}-{len(out) + 1}", "month": month_label, "segment": pt["segment"],
                        "segment_ko": SEGMENT_KO[pt["segment"]], "stars": star, "party_size": pt["size"],
                        "wait_min": round(pt["wait"], 1), "service_wait_min": round(pt["svc_wait"], 1),
                        "walked_away": pt["walked"], "satisfaction": round(s, 3),
                        "drivers": {k: round(x, 3) for k, x in terms.items() if abs(x) > 1e-9},
                        "reason_codes": codes, "incentivized": inc,
                        "cause_levers": sorted({lv for c in codes for lv in _CODE_LEVERS.get(c, ())}),
                        "cause_events": [e for e in su.get("events", []) if any(e in _CODE_EVENTS.get(c, ()) for c in codes)],
                        "cause_decisions": [], "decision_party": None,
                        "night": pt.get("night"), "dow": pt.get("dow")})
    su["_mean_loyal"] = total_l / n_s if n_s else 0.5
    return out, (total_s / n_s if n_s else 0.5), len(out)


# --- one month ------------------------------------------------------------------------------------------------
def _hygiene_and_sickness(state: dict, plan: dict, events: list[str], rng: np.random.Generator) -> tuple[int, list[dict]]:
    """Resolve outcome events: inspection pass/fail by hygiene level; owner sickness closes 3 days."""
    closure, notes = 0, []
    if "hygiene_inspection" in events:
        fail = rng.random() < data()["P"]["hygiene"][_validate(plan)["hygiene"]]["inspection_fail"]
        notes.append({"id": "hygiene_inspection", "outcome": "fail" if fail else "pass"})
        if fail:
            closure += v("hygiene.fail_closed_days")
    if "owner_sick" in events:
        closure += 3
        notes.append({"id": "owner_sick", "outcome": "closed_3_days"})
    return closure, notes


@functools.lru_cache(maxsize=2)
def _neutral_sat(analytic: bool = False) -> dict:
    """Mean party satisfaction in 평소 (base plan, October, starting state). Stars and 단골 move relative to this,
    so the base plan is stationary: an average 평소 party gives the starting rating and keeps 단골 flat."""
    st = new_season(0)
    if analytic:
        out, su = _analytic(st, base_plan(), [])
        e = _preview_result(st, base_plan(), out, su, [])["expected"]
        return {"s": float(e["satisfaction"]), "loyal": float(e["satisfaction_loyal"])}
    su = _setup(st, base_plan(), [])
    vals, loyal = [], []
    for i in range(10):
        m = simulate_month(su["params"], su["profile"], 2000 + i, a=su["a"], record=True)
        for pt in m["parties"]:
            s, terms = satisfaction(pt, su)
            vals.append(s)
            loyal.append(_loyal(s, terms))
    return {"s": float(np.mean(vals)), "loyal": float(np.mean(loyal))}


def _loyal(s: float, terms: dict) -> float:
    """What keeps 단골 coming: satisfaction with the price terms at part weight (price already moves demand through
    the elasticity; counting it fully again would double it, ignoring it lets any price ride on quality)."""
    w = 1 - v("regulars.price_weight")   # value for money matters to 단골, at part weight (elasticity has the rest)
    return s - w * (terms.get("price_high", 0.0) + terms.get("soju_high", 0.0))


def _regular_delta(ds: float) -> float:
    """단골 are lost faster than they are won (one bad visit vs many good ones)."""
    band = v("regulars.deadband")   # month-to-month noise in the mean must not drift 단골 one way
    if abs(ds) <= band:
        return 0.0
    ds = ds - band if ds > 0 else ds + band
    d = (v("regulars.satisfaction_gain") if ds > 0 else v("regulars.satisfaction_loss")) * ds
    cap = v("regulars.max_monthly_change")   # 단골 leave (and return) over months, not all at once
    return max(-cap, min(cap, d))


def _opening_accrual(state: dict, loyal_diff: float) -> float:
    """A new store has no 단골. They build up with repeat visits (KOSIS 한식 재방문율 34.75% caps the share), more
    slowly when guests are less satisfied than usual. Only while the share is below the established level."""
    if not state.get("opening"):
        return 0.0
    gap = max(0.0, v("start.regular_share") - state["regular_share"])
    rate = v("regulars.opening_accrual") * (1.0 if loyal_diff >= -v("regulars.deadband") else 0.5)
    return min(gap, rate)


def _baseline() -> dict:
    """평소: base plan, October, starting state, no events. The mean of every P&L line over many DES runs (the
    preview is a mean, so its anchor must be one too). Cached on disk by a hash of every input it depends on."""
    return _baseline_cached()


_BASELINE_INPUTS = ("research/season_params.yaml", "research/calendar.yaml", "research/events.yaml",
                    "research/hero_base.yaml", "sim/engine.py", "sim/params.py", "sim/season.py")


@functools.lru_cache(maxsize=1)
def _baseline_cached() -> dict:
    import json
    n = _runs("band.baseline_runs")
    path = _cache_path("season_baseline", n)
    if path.exists():
        return json.loads(path.read_text())
    su = _setup(new_season(0), base_plan(), [])
    runs = [_pnl(simulate_month(su["params"], su["profile"], 1000 + i, a=su["a"]), su, None, 0) for i in range(n)]
    out = {k: float(np.mean([r[k] for r in runs])) for k, x in runs[0].items() if isinstance(x, (int, float))}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    return out


# which plan levers (vs the base plan) and events move each waterfall line
_WF_LEVERS = {
    "covers": ("meat_price", "soju_price", "meat_grade", "menu_extras", "close_hour", "terrace", "group_reservations",
               "staff_per_shift", "staff_grilling", "marketing_budget"),
    "ticket": ("meat_price", "soju_price", "staff_per_shift"),
    "extra_revenue": ("lunch", "group_reservations"),
    "cogs": ("meat_grade", "menu_extras", "banchan", "lunch", "group_reservations"),
    "labor": ("staff_per_shift", "close_hour", "lunch", "hygiene"),
    "rent": (),
    "mgmt": ("close_hour", "lunch", "marketing_budget", "review_event"),
    "fees": (),
}
_LEVER_KO = {"meat_price": "삼겹살 가격", "soju_price": "소주 가격", "meat_grade": "원육", "menu_extras": "메뉴 추가",
             "banchan": "반찬 수", "staff_grilling": "직원이 구워 주기", "staff_per_shift": "교대당 알바", "close_hour": "영업시간",
             "lunch": "점심 영업", "terrace": "야장", "marketing_budget": "SNS 협찬", "review_event": "리뷰 이벤트",
             "group_reservations": "단체 예약", "hygiene": "청결 관리"}


_PARAM_LINE = {"cst_meat_cost_per_portion": "cogs", "import_meat_cost_mult": "cogs", "cst_banchan_cost_per_cover": "cogs",
               "drv_rent": "rent", "wx_rain_nights_share": "covers", "sto_terrace_availability": "covers",
               "seg_twenties_late_mult": "covers"}
_RESOLVE_LINES = {"hygiene": ("covers",), "quit": ("labor", "covers"), "owner_sick": ("covers", "labor")}


def _event_lines(eid: str) -> set:
    """Which waterfall lines a month event touches (it shapes the size of the plan's difference there)."""
    e = data()["EV"][eid]
    eff = e["effects"]
    lines = {_PARAM_LINE[o["param"]] for o in eff.get("params", []) if o["param"] in _PARAM_LINE}
    if "demand" in eff or eff.get("persist") in ("competitor_on", "competitor_off"):
        lines.add("covers")
    if eff.get("persist") == "rent_up":
        lines.add("rent")
    lines.update(_RESOLVE_LINES.get(eff.get("resolve"), ()))
    if "meat_writeoff" in eff:
        lines.add("cogs")
    return lines


def _wf_note(key: str, plan: dict) -> str:
    changed = [_LEVER_KO[k] for k in _WF_LEVERS[key] if plan.get(k) != base_plan().get(k)]
    if changed:
        return "평소 계획과 다른 점: " + ", ".join(changed)
    return "계획 차이 없음 (같은 사건, 같은 손님 흐름이라 차이는 다른 줄의 영향)" if key in ("covers", "ticket") else "계획 차이 없음"


def _waterfall(base: dict, draw: dict, plan: dict | None = None, events: list[str] | None = None) -> list[dict]:
    steps = [
        ("손님 수", "covers", (draw["dinner_covers"] - base["dinner_covers"]) * base["dinner_ticket"]),
        ("객단가", "ticket", draw["dinner_covers"] * (draw["dinner_ticket"] - base["dinner_ticket"])),
        ("점심·단체 매출", "extra_revenue", draw["lunch_revenue"] + draw["group_revenue"] - base["lunch_revenue"] - base["group_revenue"]),
        ("식재료비", "cogs", -(draw["cogs"] - base["cogs"])),
        ("인건비", "labor", -(draw["labor"] - base["labor"])),
        ("임차료", "rent", -(draw["rent"] - base["rent"])),
        ("관리비·마케팅", "mgmt", -(draw["mgmt"] - base["mgmt"])),
        ("카드 수수료", "fees", -(draw["fees"] - base["fees"])),
    ]
    out = [{"driver": "평소대로였다면 (이번 달)", "key": "base", "delta": round(base["op"]), "kind": "start",
            "note": "같은 달, 같은 사건, 같은 손님 흐름에서 평소 계획"}]
    out += [{"driver": d, "key": k, "delta": round(x), "kind": "step",
             **({"note": _wf_note(k, plan),
                 "levers": [lv for lv in _WF_LEVERS[k] if plan.get(lv) != base_plan().get(lv)],
                 "events": [e for e in (events or []) if k in _event_lines(e)], "decisions": []}
                if plan is not None else {})} for d, k, x in steps]
    out.append({"driver": "이번 달 영업이익", "key": "end", "delta": round(draw["op"]), "kind": "end"})
    return out


KPI_KEYS = ["revenue", "op", "op_margin", "covers", "dinner_covers", "ticket", "walkaways", "avg_wait_min",
            "table_utilization", "staff_load", "alcohol_share", "cogs", "labor", "rent", "mgmt", "fees",
            "lunch_revenue", "group_revenue", "groups", "delivery_revenue", "delivery_fee", "delivery_orders",
            "opex_util", "opex_other", "opex_mkt", "labor_owner"]   # lab:cost


def _round(x):
    if isinstance(x, (float, np.floating)):
        return float(round(float(x), 4)) if abs(x) < 100 else int(round(float(x)))
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, dict):
        return {k: _round(y) for k, y in x.items()}
    if isinstance(x, list):
        return [_round(y) for y in x]
    return x


def _labels(su: dict, events: list[str]) -> list[dict]:
    P, EV = data()["P"], data()["EV"]
    plan = su["plan"]
    L = [
        {"mechanism": "calendar", "label": f"{su['cal']['label']} 수요 지수 {su['cal']['demand_index']}", "tag": su["cal"]["tags"]["demand_index"]},
        {"mechanism": "rating_demand", "label": "평점 1점 = 손님 ±7%", "tag": P["demand"]["rating_per_star"]["tag"]},
        {"mechanism": "awareness", "label": "인지도가 손님 수를 바꾼다", "tag": P["demand"]["awareness_exponent"]["tag"]},
        {"mechanism": "regulars", "label": "단골 비율이 손님 수를 바꾼다", "tag": P["demand"]["regular_effect"]["tag"]},
        {"mechanism": "satisfaction", "label": "손님 만족이 리뷰와 별점을 정한다", "tag": "가정"},
        {"mechanism": "fatigue", "label": "직원 피로가 서비스 속도와 퇴사 위험을 올린다", "tag": "가정"},
        {"mechanism": "price_elasticity", "label": "가격이 손님 수를 바꾼다 (탄력성 −0.81, 범위 −0.3~−2.5)", "tag": "S58;가정"},
        {"mechanism": "meat_grade", "label": f"원육 {GRADE_KO[plan['meat_grade']]}: 원가 ₩{P['meat_grade'][plan['meat_grade']]['cost']:,}, 품질 {P['meat_grade'][plan['meat_grade']]['quality']}",
         "tag": P["meat_grade"][plan["meat_grade"]]["tag"], "downside": "좋은 고기일수록 원가가 오른다"},
    ]
    lever_labels = [
        (plan["staff_grilling"], "staff_grilling", "직원이 구워 주기", "직원 시간이 테이블마다 10분 더 들고 손님이 더 오래 머문다"),
        (plan["lunch"], "lunch", "점심 영업", "알바 3시간, 공과금, 직원 피로가 늘어난다"),
        (plan["review_event"], "review_event", "리뷰 이벤트", "리뷰당 음료 비용, 별점이 들쭉날쭉해진다"),
        (plan["marketing_budget"] > 0, "marketing", "SNS 협찬", "비용, 기대가 높아져 만족이 떨어질 수 있다"),
        (plan["group_reservations"], "group_reservations", "단체 예약", "예약석이 워크인 손님을 막고 노쇼 위험"),
        (plan["close_hour"] != 24, "hours", "영업시간", "늦게 닫으면 알바와 공과금, 피로가 늘어난다"),
        (bool(plan["menu_extras"]), "menu_extras", "메뉴 추가", "원가, 준비 시간, 폐기가 늘어난다"),
        (plan["staff_per_shift"] != 2, "staff", "교대당 알바 수", "줄이면 서비스가 느려지고 피로와 퇴사 위험이 오른다"),
        (plan["hygiene"] != "normal", "hygiene", "청결 관리", "철저할수록 인건비, 느슨할수록 위생점검 위험"),
    ]
    L += [{"mechanism": k, "label": lab, "tag": "가정", "downside": d} for on, k, lab, d in lever_labels if on]
    L += [{"mechanism": f"event:{e}", "label": EV[e]["label"], "tag": EV[e]["tag"], "detail": EV[e]["mechanism"]} for e in events]
    C = P["closure"]
    L += [{"mechanism": "closure_cash", "label": "폐업: 현금이 두 달 연속 0 아래", "tag": C["negative_months_to_close"]["tag"],
           "detail": C["negative_months_to_close"]["note"]},
          {"mechanism": "closure_revenue", "label": "폐업: 매출이 평소의 60% 이하로 두 달 연속", "tag": C["low_revenue_share"]["tag"],
           "detail": C["low_revenue_share"]["note"]}]
    return L


def _owner_line(op: float, shadow_op: float, cash: float, events: list[str], fatigue: float, waterfall: list[dict]) -> dict:
    """Owner's line in facts the HUD also shows: mood from the cash runway (months of cash left at this month's loss),
    the net against 평소대로였다면 (the shadow) first, then the biggest driver each way."""
    runway = cash / -op if op < 0 and cash > 0 else (0.0 if cash <= 0 else None)
    if cash <= 0 or (runway is not None and runway < 3):
        mood = "desperate"
    elif runway is not None and runway < 12:
        mood = "worried"
    elif op > max(shadow_op, 0) * 1.3 and op > 0:
        mood = "great"
    else:
        mood = "ok"
    net = op - shadow_op
    if mood in ("ok", "great") and net <= -max(300_000, 0.2 * abs(shadow_op)):
        mood = "worried"   # well below 평소 is never a 무난 month (agents/persona.py below_usual)
    steps = [w for w in waterfall if w["kind"] == "step" and w["delta"]]
    pos = max(steps, key=lambda w: w["delta"], default=None)
    neg = min(steps, key=lambda w: w["delta"], default=None)
    pos = pos if pos and pos["delta"] > 0 else None
    neg = neg if neg and neg["delta"] < 0 else None
    codes = (["loss"] if op < 0 else []) + (["cash_negative"] if cash < 0 else []) + (["staff_tired"] if fatigue > 70 else [])
    codes += [f"event:{e}" for e in events]
    won = lambda x: man_won(abs(x))  # noqa: E731
    text = ("평소대로였다면과 거의 같아요." if abs(net) < 50_000 else
            f"평소대로였다면보다 {won(net)} {'더 벌었어요' if net >= 0 else '덜 벌었어요'}.")
    text = (text
            + (f" {pos['driver']}에서 {won(pos['delta'])} 벌고" if pos else "")
            + (f" {neg['driver']}에서 {won(neg['delta'])} 잃었어요." if neg else ("." if pos else "")))
    if cash <= 0:
        text += " 운영자금이 바닥났어요."
    elif runway is not None and mood in ("worried", "desperate"):
        text += f" 이 속도면 운영자금이 약 {max(1, int(runway))}개월 버팁니다."   # whole months, like the HUD
    return {"mood": mood, "text": text, "codes": codes, "placeholder": True,
            "net_vs_shadow": net, "runway_months": runway,
            "top_positive": {"driver": pos["driver"], "delta": pos["delta"]} if pos else None,
            "top_negative": {"driver": neg["driver"], "delta": neg["delta"]} if neg else None}


def _night_pick(su: dict, seed: int) -> tuple[int, bool, bool]:
    """A typical Saturday, not a lucky or empty one: 32 draws on their own customer streams, the one closest to
    their mean revenue (and arrivals). Returns (draw index, rain, terrace open)."""
    p = su["params"]
    draws = []
    for i in range(32):
        g = np.random.default_rng([seed, i])
        rain = p["wx_rain_nights_share"] >= 0.5 or (p["wx_rain_nights_share"] > 0 and g.random() < p["wx_rain_nights_share"])
        terrace = p["sto_terrace"] > 0 and p["sto_terrace_availability"] > 0 and not rain
        r = simulate_night(p, su["profile"], "sat", g, elasticity=p["mkt_price_elasticity"], terrace_open=terrace,
                           a=su["a"], rain=rain, streams=[seed, i])
        draws.append((i, rain, terrace, r["arrivals"], r["rev_meat"] + r["rev_alc"] + r["rev_side"]))
    mean_arr = float(np.mean([d[3] for d in draws]))
    mean_rev = float(np.mean([d[4] for d in draws]))
    i, rain, terrace, _, _ = min(draws, key=lambda d: 2 * abs(d[4] / mean_rev - 1) + abs(d[3] / mean_arr - 1))
    return i, rain, terrace


def _night_sim(su: dict, seed: int, pick: tuple, hooks=None, mods=None, log: bool = True) -> dict:
    """The picked Saturday, optionally with in-night decisions applied from their clock on (same customer stream)."""
    p = su["params"]
    i, rain, terrace = pick
    return simulate_night(p, su["profile"], "sat", np.random.default_rng([seed, i]), elasticity=p["mkt_price_elasticity"],
                          terrace_open=terrace, log=log, a=su["a"], rain=rain, record=True, streams=[seed, i],
                          hooks=hooks, mods=mods)


def _night_render(su: dict, r: dict, seed: int, pick: tuple) -> list[dict]:
    """Header + EVENT_LOG for the 3D; leave/balk events carry speech bubbles."""
    rng = np.random.default_rng([seed, pick[0], 7])
    by_pid = {pt["pid"]: pt for pt in r["parties"]}
    out = []
    for e in r["events"]:
        if e["type"] in ("leave", "balk") and e["party"] in by_pid:
            s, terms = satisfaction(by_pid[e["party"]], su)
            s += rng.normal(0, v("satisfaction.mood_noise"))  # 그날 기분과 입맛: a normal night has praise too
            if e["type"] == "balk" or s < 0.49 or s > 0.6 or any(abs(x) > 0.03 for x in terms.values()):
                code = "wait_long" if e["type"] == "balk" else _bubble_code(terms, s, rng)
                if code:
                    e = {**e, "bubble": {"code": code, "text": REASON_KO.get(code, code)}}
        out.append(e)
    out = sorted(out + _group_parties(su, r), key=lambda e: e["t"])
    # every party's events carry its mood, its bill and its top reason (per-table tint and hover card, §12.4)
    mood = {}
    for pt in r["parties"]:
        s_, terms = satisfaction(pt, su)
        codes = _codes(terms, s_, positive_first=s_ >= _neutral_sat()["s"])
        mood[pt["pid"]] = {"satisfaction": round(s_, 3), "spend": round(pt["bill"]), "reason": codes[0] if codes else None}
    booked = [e for e in out if e.get("group")]
    if booked:
        s_, terms = satisfaction({"segment": "office", "wait": 0.0, "svc_wait": 0.0, "queued": False, "walked": False,
                                  "size": int(v("groups.people"))}, su)
        codes = _codes(terms, s_, positive_first=s_ >= _neutral_sat()["s"])
        for e in booked:
            bill = next((x["bill"] for x in booked if x["party"] == e["party"] and x["type"] == "leave"), 0)
            mood[e["party"]] = {"satisfaction": round(s_, 3), "spend": round(bill), "reason": codes[0] if codes else None}
    out = [{**e, **mood[e["party"]]} if e.get("party") in mood else e for e in out]
    snow = any(e in ("cold_wave",) for e in su.get("events", []))
    weather = "rain" if pick[1] else "snow" if snow else "clear"
    return [{"night": {"dow": "sat", "rain": pick[1], "weather": weather, "terrace_open": pick[2],
                       "tables_available": r["tables_available"], "servers": r["servers"], "open_clock": "17:00",
                       "close_hour": su["plan"]["close_hour"]}}] + out


def _night(su: dict, seed: int) -> list[dict]:
    """A representative Saturday with the month's plan and events, no in-night decisions."""
    pick = _night_pick(su, seed)
    return _night_render(su, _night_sim(su, seed, pick), seed, pick)


# --- in-night decisions (docs/GAME-V2-SPEC.md §12.1) ------------------------------------------------------------
def _dp_catalog() -> dict:
    return data()["EV"]["_night_decisions"]


def _clock(minute: float) -> str:
    m = 17 * 60 + minute
    return f"{int(m // 60) % 24:02d}:{int(m % 60):02d}"


def _occupancy(events: list[dict]) -> list[tuple[float, int, int]]:
    """(minute, tables taken, 야장 tables taken) after every seat / table_ready in a logged night."""
    busy, out = {}, []
    for e in events:
        if e["type"] == "seat":
            for tid in e.get("tables") or [e["table_id"]]:
                busy[tid] = True
        elif e["type"] == "table_ready":
            busy.pop(e["table_id"], None)
        else:
            continue
        out.append((e["t"], len(busy), sum(1 for k in busy if k.startswith("Y"))))
    return out


def _dp_clock(d: dict, occ: list[tuple], tables: int, queued: list[float]) -> float | None:
    """A decision's moment in this night: fixed, or the fullest moment of its window (None when it cannot happen:
    nobody on the 야장 for a rain burst; no full house with a queue for a walk-in 회식)."""
    win = d.get("clock_window")
    if not win:
        return float(d["clock_min"])
    col = 2 if d["condition"] == "terrace" else 1
    inside = [o for o in occ if win[0] <= o[0] <= win[1]]
    if not inside or max(o[col] for o in inside) == 0:
        return None
    if d["condition"] == "full":
        full = [o for o in inside if o[1] >= tables - 1 and any(abs(q - o[0]) <= 30 for q in queued)]
        if not full:
            return None
        inside = full
    best = max(inside, key=lambda o: (o[col], -o[0]))
    return float(round(best[0]))


def _decision_points(state: dict, su: dict, pick: tuple, plain_events: list[dict]) -> list[dict]:
    """이번 달의 사건 하나 (2026-10-20부터 한 달에 하나): events.yaml 의 `months`에 이 달이 든 사건. 조건이 안 맞으면
    (알바가 없는데 알바 사건 등) 달 제한이 없는 일반 사건 중에서 시드로 뽑는다."""
    cat = _dp_catalog()
    ok = {"always": True, "full": True, "staff": su["params"]["sto_parttimers"] >= 1, "terrace": bool(pick[2])}
    occ = _occupancy(plain_events)
    tables = sum(1 for _ in {e["table_id"] for e in plain_events if e["type"] == "seat"})
    queued = [e["t"] for e in plain_events if e["type"] == "queue"]
    clocks = {k: _dp_clock(d, occ, tables, queued) for k, d in cat.items()}
    usable = [k for k, d in cat.items() if ok.get(d["condition"], False) and clocks[k] is not None]
    cal = int(su["month"])
    kinds = [k for k in usable if cal in (cat[k].get("months") or [])]
    if not kinds:
        kinds = [k for k in usable if not cat[k].get("months")]
    rng = _rng(state, 5)
    chosen = [rng.choice(kinds)] if kinds else []
    out = []
    for k in chosen:
        d = cat[k]
        out.append({"id": f"dp{state['month_index'] + 1}-{k}", "kind": k, "title_ko": d["title_ko"],
                    "clock_min": clocks[k],
                    "clock": "이달" if d.get("months") and not d["clock_min"] else _clock(clocks[k]),   # 한 밤의 시각이 아니라 한 달 사건
                    "prompt_ko": (d["prompt_ko"] if not d.get("clock_window") else f"{_clock(clocks[k])}, {d['prompt_ko']}"), "default": d["default"], "monthly_count": d["monthly_count"]["value"],
                    "count_tag": d["monthly_count"]["tag"], "count_note": d["monthly_count"].get("note"),
                    "options": [{"id": oid, "label_ko": o["label_ko"], "effect_hint_ko": o["effect_hint_ko"],
                                 "tag": "가정" if o["tag"] == "가정" else "근거", "source_id": None if o["tag"] == "가정" else o["tag"],
                                 "downside_ko": o["downside_ko"]} for oid, o in d["options"].items()]})
    return out


def _dp_effect(dp: dict, option_id: str, su: dict, slot: int) -> dict:
    """Hooks, switches, costs and state changes of one option, from its clock on."""
    e = _dp_catalog()[dp["kind"]]["options"][option_id]["effect"]
    t, p = dp["clock_min"], su["params"]
    hooks, mods = [], {}
    if "special_party" in e:
        sp = e["special_party"]
        hooks.append((t, lambda ctx, sp=sp: ctx["special_party"](900 + slot, sp["size"], sp["segment"], sp["tables"], sp["dwell"],
                                                                 sp.get("comp", False), ["comp"] if sp.get("comp") else [])))
    if "hold_staff" in e:
        hooks.append((t, lambda ctx, m=e["hold_staff"]: ctx["hold_staff"](m)))
    if "hold_tables" in e:
        hooks.append((t, lambda ctx, n=e["hold_tables"], m=e["hold_minutes"]: ctx["hold_tables"](n, m)))
    for key, where in (("flag_present", "all"), ("flag_present_terrace", "terrace")):
        if key in e:
            def tag_present(ctx, flag=e[key], where=where):
                for pid, (prio, _) in ctx["seated"].items():
                    if where == "all" or prio == 1:
                        ctx["mods"].setdefault("pid_flags", {}).setdefault(pid, []).append(flag)
            hooks.append((t, tag_present))
    if e.get("stop_seating"):
        mods["stop_seating_from"] = t
    if "reorder_keep" in e:
        mods["reorder_keep"] = (t, e["reorder_keep"])
    if "door_leave" in e:
        mods["door_leave"] = (t, e["door_leave"])
    for key, where in (("seat_flag", "all"), ("seat_flag_terrace", "terrace")):
        if key in e:
            mods.setdefault("seat_flags", []).append((t, e[key], where))
    labor = e.get("cost_hours", 0) * p["sto_parttime_wage"] * p["cst_holiday_pay_factor"] * e.get("cost_hour_mult", 1.0)
    food = e.get("cost_portions", 0) * p["cst_meat_cost_per_portion"] * e.get("cost_portion_premium", 0.0)
    return {"hooks": hooks, "mods": mods, "labor": labor, "food": food, "other": e.get("cost_won", 0),
            "state": dict(e.get("state", {})), "price_mult": e.get("price_mult", 1.0), "lam_mult": e.get("lam_mult", 1.0)}


def _merge_mods(parts: list[dict]) -> dict:
    out = {}
    for m in parts:
        for k, x in m.items():
            if k == "seat_flags":
                out.setdefault(k, []).extend(x)
            else:
                out[k] = x
    return out


def _night_kpis(r: dict, su: dict) -> dict:
    p = su["params"]
    rev = r["rev_meat"] + r["rev_alc"] + r["rev_side"]
    food = (r["portions"] * p["cst_meat_cost_per_portion"] + r["bottles"] * p["cst_alcohol_cost_per_bottle"]
            + r["rev_side"] * p["cst_side_cost_ratio"] + r["covers"] * p["cst_banchan_cost_per_cover"])
    return {"revenue": rev, "food": food, "covers": r["covers"], "walkaways": r["walkaways"],
            "sat_sum": sum(satisfaction(pt, su)[0] for pt in r["parties"])}


def _dp_month_delta(dp: dict, option_id: str, su: dict, seed: int, pick: tuple, plain: dict, slot: int) -> dict:
    """monthly_count x (the night with this situation handled this way - the same night without it)."""
    eff = _dp_effect(dp, option_id, su, slot)
    k = _night_kpis(_night_sim(su, seed, pick, eff["hooks"], eff["mods"], log=False), su)
    night = {key: k[key] - plain[key] for key in k}
    # 손님 수를 바꾸는 선택(한파, 장마, 축제 등)은 표본 한 밤을 다시 돌리지 않고 평소 밤의 값에 비율로 곱한다.
    # 한 밤의 도착 수는 0.9와 0.93 같은 작은 차이를 구분하지 못해 선택지가 똑같이 나오기 때문이다 (자리가 모자라 돌려보내는 효과는 안 본다).
    d_lam = eff["lam_mult"] - 1
    for key in ("revenue", "food", "covers", "sat_sum"):
        night[key] += plain[key] * d_lam
    night["revenue"] += (plain["revenue"] * (1 + d_lam)) * (eff["price_mult"] - 1)   # 가격을 올린 선택: 같은 손님이 더 낸다
    n = dp["monthly_count"]
    p = su["params"]
    rev = n * night["revenue"]
    month = {"revenue": rev, "cogs": n * (night["food"] + eff["food"]), "labor": n * eff["labor"],
             "mgmt": n * eff["other"], "fees": rev * p["cst_card_share"] * p["cst_card_fee_rate"],
             "covers": n * night["covers"], "walkaways": n * night["walkaways"], "sat_sum": n * night["sat_sum"]}
    month["op"] = month["revenue"] - month["cogs"] - month["labor"] - month["mgmt"] - month["fees"]
    night["op"] = night["revenue"] - night["food"] - eff["food"] - eff["labor"] - eff["other"]
    return {"night": night, "month": month, "state": {key: n * x for key, x in eff["state"].items()}}


def _apply_month_delta(pnl: dict, d: dict, sign: float = 1.0) -> None:
    for key in ("revenue", "cogs", "labor", "mgmt", "fees", "covers", "walkaways"):
        if key in pnl:
            pnl[key] += sign * d[key]
    pnl["cost"] = pnl["cogs"] + pnl["labor"] + pnl["rent"] + pnl["mgmt"] + pnl["fees"]
    pnl["op"] = pnl["revenue"] - pnl["cost"]
    pnl["op_margin"] = pnl["op"] / pnl["revenue"] if pnl["revenue"] else 0.0


def _decide_night(state: dict, su: dict, seed: int, choices: dict | None, pick: tuple | None = None) -> dict:
    """The month's Saturday with its decision points: chosen and default month deltas, and the night as played."""
    pick = pick or _night_pick(su, seed)
    plain_night = _night_sim(su, seed, pick)
    dps = _decision_points(state, su, pick, plain_night["events"])
    choices = dict(choices or {})
    unknown = set(choices) - {dp["id"] for dp in dps}
    if unknown:
        raise ValueError(f"unknown decision point(s) {sorted(unknown)}; this month has {[dp['id'] for dp in dps]}")
    plain = _night_kpis(plain_night, su)
    rows, hooks, mods = [], [], []
    for slot, dp in enumerate(dps):
        opt = choices.get(dp["id"], dp["default"])
        if opt not in _dp_catalog()[dp["kind"]]["options"]:
            raise ValueError(f"{dp['id']}: unknown option {opt}")
        chosen = _dp_month_delta(dp, opt, su, seed, pick, plain, slot)
        default = chosen if opt == dp["default"] else _dp_month_delta(dp, dp["default"], su, seed, pick, plain, slot)
        eff = _dp_effect(dp, opt, su, slot)
        hooks += eff["hooks"]
        mods.append(eff["mods"])
        rows.append({"dp": dp, "option_id": opt, "chosen": chosen, "default": default})
    played = _night_sim(su, seed, pick, hooks, _merge_mods(mods))
    return {"pick": pick, "dps": dps, "rows": rows, "night": played, "plain": plain_night}


_DP_FLAGS = {"meat_swapped": "meat_low", "noisy_group": "walkin_group", "moved_inside": "rain_burst", "rain_tarp": "rain_burst",
             "comp": "blogger"}


def _night_reviews(dn: dict, su: dict, state: dict, start_id: int) -> list[dict]:
    """Reviews from the decision night (§12.3): parties a decision touched (its own party, a flagged party, or one
    whose wait, service or bill changed against the same night without the decisions) write at twice the usual rate
    (가정: an incident makes people write); a comped blogger always does. Each names the decisions behind it."""
    R = data()["P"]["reviews"]
    rng = np.random.default_rng([dn["pick"][0], state["month_index"], 11])
    plain = {pt["pid"]: pt for pt in dn["plain"]["parties"]}
    by_kind = {r["dp"]["kind"]: r["dp"] for r in dn["rows"] if r["option_id"]}
    chosen = {r["dp"]["id"]: r["option_id"] for r in dn["rows"]}
    first = min((r["dp"]["clock_min"] for r in dn["rows"]), default=None)
    out = []
    for pt in dn["night"]["parties"]:
        causes, party_of = set(), None
        if pt.get("special"):
            slot = pt["pid"] - 900
            if 0 <= slot < len(dn["rows"]):
                party_of = dn["rows"][slot]["dp"]["id"]
                causes.add(party_of)
        for f in pt.get("flags", ()):
            if _DP_FLAGS.get(f) in by_kind:
                causes.add(by_kind[_DP_FLAGS[f]]["id"])
        base = plain.get(pt["pid"])
        if base is not None and first is not None and pt["t"] + pt["wait"] >= first - 120:
            moved = (abs(pt["wait"] - base["wait"]) > 1 or abs(pt.get("svc_wait", 0) - base.get("svc_wait", 0)) > 1
                     or abs(pt.get("mid_wait", 0) - base.get("mid_wait", 0)) > 1 or abs(pt["bill"] - base["bill"]) > 1
                     or pt["walked"] != base["walked"])
            if moved:
                causes.update(r["dp"]["id"] for r in dn["rows"] if r["dp"]["clock_min"] <= pt["t"] + pt["wait"] + 150)
        if not causes:
            continue
        s, terms = satisfaction(pt, su)
        blogger = "comp" in pt.get("flags", ())
        pr = 1.0 if blogger else min(1.0, 2 * R["base_prob"]["value"] * R["segment_mult"][pt["segment"]])
        if rng.random() >= pr:
            continue
        star = int(min(5, max(1, round(v("start.rating") + v("satisfaction.star_slope") * (s - _neutral_sat()["s"])
                                       + rng.normal(0, v("satisfaction.star_noise"))))))
        codes = _codes(terms, s, positive_first=star >= 4)
        out.append({"id": f"r{state['month_index'] + 1}-n{start_id + len(out)}", "month": su["cal"]["label"],
                    "segment": pt["segment"], "segment_ko": SEGMENT_KO[pt["segment"]], "stars": star, "party_size": pt["size"],
                    "wait_min": round(pt["wait"], 1), "service_wait_min": round(pt.get("svc_wait", 0.0), 1),
                    "walked_away": pt["walked"], "satisfaction": round(s, 3),
                    "drivers": {k: round(x, 3) for k, x in terms.items() if abs(x) > 1e-9}, "reason_codes": codes,
                    "incentivized": False, "night": "sat", "dow": "sat", "from_decision_night": True,
                    "cause_levers": sorted({lv for c in codes for lv in _CODE_LEVERS.get(c, ())}),
                    "cause_events": [e for e in su.get("events", []) if any(e in _CODE_EVENTS.get(c, ()) for c in codes)],
                    "cause_decisions": sorted(causes), "decision_party": party_of,
                    "decision_options": {d: chosen[d] for d in sorted(causes)}})
    return out


def start_month(state: dict, plan: dict, events: list[str] | None = None) -> dict:
    """Step 1 of a month: the night up to (and including) its first decision point, and the decision points. No KPIs.
    play_month(state, plan, events, night_choices=...) is step 2; the night before each decision is identical."""
    if state.get("closed"):
        raise ValueError("this store has closed (폐업); start a new season")
    events = draw_events(state) if events is None else list(events)
    rng = _rng(state, 2)
    plan = _validate(plan)
    closure, _ = _hygiene_and_sickness(state, plan, events, rng)
    su = _setup(state, plan, events, closure_days=closure, quit_now="staff_quit" in events)
    seed_draw = int(rng.integers(1 << 30))
    pick = _night_pick(su, seed_draw)
    plain_night = _night_sim(su, seed_draw, pick)
    dps = _decision_points(state, su, pick, plain_night["events"])
    night = _night_render(su, plain_night, seed_draw, pick)
    cut = dps[0]["clock_min"] if dps else float("inf")
    # a party still at the table when the first decision comes has no outcome yet: no mood, bill or reason in the prefix
    done = {e["party"] for e in night[1:] if e["type"] in ("leave", "balk") and e["t"] <= cut}
    prefix = [e if e.get("party") in done or e.get("party") is None else
              {k: x for k, x in e.items() if k not in ("satisfaction", "spend", "reason", "bubble")}
              for e in night[1:] if e["t"] <= cut]
    return _round({"engine": "sim.season v2", "month": su["month"], "month_index": state["month_index"],
                   "calendar": {"label": su["cal"]["label"], "note": su["cal"]["note"], "demand_index": su["cal"]["demand_index"],
                                "tags": su["cal"]["tags"]},
                   "events": [{"id": e, "label": data()["EV"][e]["label"], "group": data()["EV"][e]["group"],
                               "mechanism": data()["EV"][e]["mechanism"], "tag": data()["EV"][e]["tag"]} for e in events],
                   "plan": plan, "night": {"night": night[0]["night"], "events": prefix},
                   "decision_points": dps, "seed": seed_draw, "state_seed": state["seed"]})


def _group_parties(su: dict, night: dict) -> list[dict]:
    """With 단체 예약 on, the month's booked 회식 appear on the reserved table: a Saturday's share of the month's
    bookings (Saturdays carry about 1.5x an average night), at most two seatings, 18:30 and 21:00."""
    if not su["plan"]["group_reservations"] or not su["off"]["group_bookings"]:
        return []
    p, a = su["params"], su["a"]
    n = int(min(2, max(1, round(su["off"]["group_bookings"] / su["off"]["open_days"] * 1.5))))
    size = int(v("groups.people"))
    ticket = (p["prd_portions_per_cover"] * p["prd_meat_price"] + p["prd_alcohol_per_cover"] * p["prd_alcohol_price"]
              + p["prd_side_spend_per_cover"]) * v("groups.spend_factor") * (1 - v("groups.discount"))
    table = f"T{int(p['sto_tables']) + 1:02d}"   # the table held back from walk-ins
    out = []
    for i, start in enumerate((90.0, 240.0)[:n]):
        pid, dwell = 900 + i, 140.0
        clock = lambda t: f"{int((a['open_clock_min'] + t) // 60) % 24:02d}:{int((a['open_clock_min'] + t) % 60):02d}"  # noqa: E731
        base = {"party": pid, "group": True}
        out += [{"t": start, "clock": clock(start), "type": "arrive", **base, "size": size, "segment": "office"},
                {"t": start, "clock": clock(start), "type": "seat", **base, "size": size, "table_id": table, "waited": 0.0},
                {"t": start + 3, "clock": clock(start + 3), "type": "order", **base, "table_id": table,
                 "portions": round(size * p["prd_portions_per_cover"]), "bottles": round(size * p["prd_alcohol_per_cover"] * 1.3),
                 "meals": size // 2},
                {"t": start + dwell, "clock": clock(start + dwell), "type": "leave", **base, "table_id": table,
                 "bill": round(ticket * size, -3), "segment": "office"},
                {"t": start + dwell + 4, "clock": clock(start + dwell + 4), "type": "table_ready", "party": None, "table_id": table}]
    return out


def _op_range(out: dict, su: dict) -> dict:
    """p10-p90 the board shows: the month's own spread (DES draws) widened by this quick estimate's measured error
    against the DES mean (larger for overloaded or one-server plans), combined in quadrature."""
    b = data()["P"]["band"]
    over = out.get("staff_load_raw", 0.0) > v("staff.overload_from") or su["params"]["sto_parttimers"] == 0
    err = b["preview_error_overload" if over else "preview_error"]["value"]
    z = 1.2816
    lo = math.hypot(b["preview_spread"]["low"] * out["revenue"], z * err)
    hi = math.hypot(b["preview_spread"]["high"] * out["revenue"], z * err)
    return {"p10": out["op"] - lo, "p90": out["op"] + hi, "error": err, "overload": over,
            "tag": "계산: 달마다의 운 (DES 산포) + 빠른 추정 오차 (DES 평균 대비 RMSE)"}


def _lunch_net(out: dict, su: dict) -> dict:
    p = su["params"]
    rev = out["lunch_revenue"]
    cost = (rev * v("lunch.food_ratio") + rev * p["cst_card_share"] * p["cst_card_fee_rate"]
            + v("lunch.parttime_hours_per_day") * su["off"]["open_days"] * p["sto_parttime_wage"] * p["cst_holiday_pay_factor"]
            + _base()[0]["cst_utilities"] * v("lunch.utilities_share"))
    return {"revenue": rev, "cost": cost, "net": rev - cost}


def season_value(state: dict) -> dict:
    """가게 가치 (6개월 전망) at season end: ending cash + the operating profit the store is expected to make over the
    next `horizon` 평소 months on the base plan, starting from the reputation it ends with (rating, 단골, 인지도), by
    the same engine (step_estimate). One yardstick for every store, so branches and plans compare. reputation_effect
    is the part of that forecast owed to the reputation vs the starting one. Guards and tests use cash."""
    h = int(v("season_value.horizon_months"))
    if state.get("closed"):
        cost = v("season_value.closure_cost")
        return {"cash": state["cash"], "forward_value": -cost, "reputation_effect": 0.0, "store_value": state["cash"] - cost,
                "horizon_months": h, "closed": True, "label": "폐업: 현금 − 폐업 비용 (S89)",
                "tag": data()["P"]["season_value"]["horizon_months"]["tag"]}
    common = {"cash": 0.0, "negative_months": 0, "low_revenue_months": 0, "closed": False, "fatigue": v("start.fatigue"),
              "plan": base_plan(), "history": [], "flags": state["flags"], "month_index": 0}
    end = {**copy.deepcopy(state), **common}
    ref = {**end, **{k: v(f"start.{k}") for k in ("rating", "review_count", "awareness", "regular_share")}}
    totals = []
    for s in (end, ref):
        tot = 0.0
        for _ in range(h):
            pv, s = step_estimate(s, base_plan(), [])
            s["month_index"] = 0
            tot += pv["expected"]["op"]
        totals.append(tot)
    fwd = max(totals[0], -v("season_value.closure_cost"))   # an owner can always close: losses stop at the closure cost
    return {"cash": state["cash"], "forward_value": fwd, "reputation_effect": totals[0] - totals[1],
            "forecast_op": totals[0], "close_is_better": totals[0] < -v("season_value.closure_cost"),
            "store_value": state["cash"] + fwd, "horizon_months": h, "closed": False,
            "label": "6개월 전망: 현금 + 앞으로 6개월 예상 영업이익", "tag": data()["P"]["season_value"]["horizon_months"]["tag"],
            "basis": data()["P"]["season_value"]["horizon_months"]["note"],
            "drivers": {k: {"end": state[k], "start": v(f"start.{k}")} for k in ("rating", "regular_share", "awareness")}}


@functools.lru_cache(maxsize=1)
def _load_full() -> float:
    """Serving load that means fatigue 100, derived so the base plan in a 평소 month holds the starting fatigue
    (평소 must be sustainable): starting fatigue / 100 of the way from load_zero to load_full."""
    z = v("fatigue.load_zero")
    return z + (_baseline()["staff_load"] - z) * 100 / v("start.fatigue")


def _fatigue_target(load: float, plan: dict, events: list[str]) -> float:
    z = v("fatigue.load_zero")
    t = 100 * min(1.0, max(0.0, (load - z) / (_load_full() - z)))
    t += v("hours.fatigue_per_late_hour") * max(0, plan["close_hour"] - 24) + (v("lunch.fatigue") if plan["lunch"] else 0)
    if "staff_quit" in events:
        t += v("fatigue.quit_shock")
    return min(100.0, t)


def _rating_all(state: dict, star_sum: float, n_rev: float) -> float:
    """All-time mean of every review (what a review count next to it implies). rating / rating_recent is the
    recent-window rating customers react to; both are shown so 180 -> 194 reviews reconciles."""
    prev = state.get("rating_all", state["rating"])
    n0 = state["review_count"]
    return float((prev * n0 + star_sum) / (n0 + n_rev)) if n_rev else float(prev)


def _closure(s: dict) -> tuple[bool, str | None]:
    """폐업: cash below zero at two consecutive month-ends (hard), or revenue at or under 60% of 평소 for two
    consecutive months (soft; S89: most owners decide to close after a 40%+ sales drop)."""
    if s["negative_months"] >= v("closure.negative_months_to_close"):
        return True, "cash"
    if s.get("low_revenue_months", 0) >= v("closure.low_revenue_months"):
        return True, "revenue"
    return False, None


def play_month(state: dict, plan: dict, events: list[str] | None = None, *, band_runs: int | None = None,
               night: bool = True, night_choices: dict | None = None, lean: bool = False) -> dict:
    """Simulate one month: a single seeded draw (the month that 'happened') + a p10-p90 band of the same setup."""
    if state.get("closed"):
        raise ValueError("this store has closed (폐업); start a new season")
    events = draw_events(state) if events is None else list(events)
    rng = _rng(state, 2)
    plan = _validate(plan)
    closure, outcomes = _hygiene_and_sickness(state, plan, events, rng)
    su = _setup(state, plan, events, closure_days=closure, quit_now="staff_quit" in events)
    seed_draw = int(rng.integers(1 << 30))
    month = simulate_month(su["params"], su["profile"], seed_draw, a=su["a"], record=True)
    reviews, mean_s, n_rev = _reviews(month["parties"], su, rng, su["cal"]["label"], state["month_index"])
    draw = _pnl(month, su, rng, n_rev)
    draw["satisfaction"] = mean_s
    draw["reviews"] = n_rev
    n_band = 1 if lean else int(band_runs or v("band.runs"))   # lean: counterfactual paths need the draw and the state
    band = [_pnl(simulate_month(su["params"], su["profile"], seed_draw + 1 + i, a=su["a"]), su, None, n_rev)
            for i in range(n_band)] if not lean else [dict(draw)]
    # 평소대로였다면 (this month): base plan, same state, same events and closures, same customer stream (seed)
    su_b = _setup(state, base_plan(), events, closure_days=closure, quit_now="staff_quit" in events)
    shadow = (_pnl(simulate_month(su_b["params"], su_b["profile"], seed_draw, a=su_b["a"]), su_b, None, 0)
              if not lean else dict(draw))
    night = night and not lean
    # in-night decisions: the chosen handling moves this month (and its band); 평소 handles them the default way
    draw_pre, shadow_pre = dict(draw), dict(shadow)
    dn = _decide_night(state, su, seed_draw, night_choices) if night else None
    dp_state = {}
    for row in (dn["rows"] if dn else []):
        _apply_month_delta(draw, row["chosen"]["month"])
        for b in band:
            _apply_month_delta(b, row["chosen"]["month"])
        _apply_month_delta(shadow, row["default"]["month"])
        d_sat = row["chosen"]["month"]["sat_sum"] / max(1, len(month["parties"]))
        mean_s += d_sat
        su["_mean_loyal"] += d_sat
        for k, x in row["chosen"]["state"].items():
            dp_state[k] = dp_state.get(k, 0.0) + x
    draw["satisfaction"] = mean_s
    pct = {q: {k: float(np.percentile([b[k] for b in band], q)) for k in KPI_KEYS} for q in (10, 50, 90)}
    percentile = float(np.mean([b["op"] <= draw["op"] for b in band]))

    # state after the month
    s2 = copy.deepcopy(state)
    s2["flags"] = su["flags"]
    s2["cash"] = state["cash"] + draw["op"]
    rc = rent_card.step(state.get("rent_card_queue"), plan.get("rent_card"), draw["rent"])  # lab:finance 월세 카드 할부
    if rc is not None:  # lab:finance
        s2["cash"] += rc["cash_delta"]
        s2["rent_card_queue"] = rc["queue"]
    s2["negative_months"] = state["negative_months"] + 1 if s2["cash"] < 0 else 0
    low = draw["revenue"] <= v("closure.low_revenue_share") * _baseline()["revenue"]
    s2["low_revenue_months"] = state.get("low_revenue_months", 0) + 1 if low else 0
    s2["closed"], s2["closed_reason"] = _closure(s2)
    ev_state = {}
    for e in events:
        for k, x in data()["EV"][e]["effects"].get("state", {}).items():
            ev_state[k] = ev_state.get(k, 0) + x
    stars = sum(r["stars"] for r in reviews)
    w = min(state["review_count"], v("reviews.window"))  # recent reviews dominate what customers see
    rating = (state["rating"] * w + stars) / (w + n_rev) if n_rev else state["rating"]
    if any(o["id"] == "hygiene_inspection" and o["outcome"] == "fail" for o in outcomes):
        rating += v("hygiene.fail_rating")
    s2["rating"] = float(min(5.0, max(1.0, rating + ev_state.get("rating", 0))))
    s2["rating_recent"] = s2["rating"]
    s2["rating_all"] = _rating_all(state, stars, n_rev)
    s2["review_count"] = int(state["review_count"] + n_rev + ev_state.get("review_count", 0))
    extras_aw = sum(data()["P"]["menu_extras"][x]["awareness"] for x in plan["menu_extras"])
    aw = 1 + v("awareness.decay") * (state["awareness"] - 1) + v("marketing.awareness_per_million") * plan["marketing_budget"] / 1e6 \
        + extras_aw + v("awareness.reviews_per_100") * n_rev / 100 + ev_state.get("awareness", 0)
    s2["awareness"] = float(max(0.5, aw))
    prev = state["plan"]
    changes = int(prev.get("meat_price") != plan["meat_price"]) + int(prev.get("meat_grade") != plan["meat_grade"])
    loyal_diff = su["_mean_loyal"] - _neutral_sat()["loyal"]
    reg = (state["regular_share"] + _regular_delta(loyal_diff) + _opening_accrual(state, loyal_diff)
           - v("regulars.change_penalty") * changes)
    s2["regular_share"] = float(min(v("regulars.max"), max(v("regulars.min"), reg)))
    target = _fatigue_target(month["staff_load"], plan, events)
    s2["fatigue"] = float(min(100.0, max(0.0, v("fatigue.carry") * state["fatigue"] + (1 - v("fatigue.carry")) * target
                                         + dp_state.get("fatigue", 0.0))))
    s2["awareness"] = float(max(0.5, s2["awareness"] + dp_state.get("awareness", 0.0)))
    s2["rating"] = s2["rating_recent"] = float(min(5.0, max(1.0, s2["rating"] + dp_state.get("rating", 0.0))))
    s2["plan"] = plan
    base = _baseline()
    s2["history"] = state["history"] + [{"month": su["month"], "label": su["cal"]["label"], "op": round(draw["op"]),
                                         "cash": round(s2["cash"]), "rating": round(s2["rating"], 3), "events": events}]
    s2["month_index"] = state["month_index"] + 1
    if s2["month_index"] >= len(months()) and not s2["closed"]:
        s2["season_over"] = True

    night_reviews = _night_reviews(dn, su, state, 1) if dn else []
    waterfall = _waterfall(shadow_pre, draw_pre, plan, events)
    waterfall[0]["delta"] = round(shadow["op"])
    dp_lines = [{"driver": f"밤 결정: {r['dp']['title_ko']} ({next(o['label_ko'] for o in r['dp']['options'] if o['id'] == r['option_id'])})",
                 "key": f"dp:{r['dp']['id']}", "delta": round(r["chosen"]["month"]["op"] - r["default"]["month"]["op"]),
                 "kind": "step", "note": f"이런 밤이 한 달에 {r['dp']['monthly_count']}번 ({r['dp']['count_tag']}), 기본 대응과 비교",
                 "levers": [], "events": [], "decisions": [r["dp"]["id"]]}
                for r in (dn["rows"] if dn else [])]
    waterfall = waterfall[:-1] + dp_lines + [{**waterfall[-1], "delta": round(draw["op"])}]
    result = {
        "engine": "sim.season v2",
        "month": su["month"], "month_index": state["month_index"], "state_seed": state["seed"],
        "calendar": {"label": su["cal"]["label"], "note": su["cal"]["note"], "demand_index": su["cal"]["demand_index"],
                     "tags": su["cal"]["tags"]},
        "events": [{"id": e, "label": data()["EV"][e]["label"], "group": data()["EV"][e]["group"],
                    "mechanism": data()["EV"][e]["mechanism"], "tag": data()["EV"][e]["tag"],
                    **next(({"outcome": o["outcome"]} for o in outcomes if o["id"] == e), {})} for e in events],
        "plan": plan,
        "draw": {"kpis": {k: draw[k] for k in KPI_KEYS + ["satisfaction", "reviews"]}, "p10": pct[10], "p50": pct[50],
                 "p90": pct[90], "op_percentile": percentile, "band_runs": n_band},
        "demand_factors": su["demand"],
        "shadow": {"basis": "이번 달, 같은 사건·같은 손님 흐름에서 평소 계획이었다면", "kpis": {k: shadow[k] for k in KPI_KEYS}},
        "waterfall": waterfall,
        "night_decisions": [{"id": r["dp"]["id"], "kind": r["dp"]["kind"], "option_id": r["option_id"],
                             "default": r["dp"]["default"], "monthly_count": r["dp"]["monthly_count"],
                             "night_delta": {k: r["chosen"]["night"][k] for k in ("revenue", "op", "covers", "walkaways")}
                             | {"satisfaction": r["chosen"]["night"]["sat_sum"]},
                             "month_delta": {k: r["chosen"]["month"][k] for k in ("revenue", "op")},
                             "vs_default_op": r["chosen"]["month"]["op"] - r["default"]["month"]["op"],
                             "state_delta": r["chosen"]["state"]} for r in (dn["rows"] if dn else [])],
        "decision_points": dn["dps"] if dn else [],
        "state_before": {k: state[k] for k in ("cash", "rating", "review_count", "awareness", "regular_share", "fatigue")},
        "state_after": s2,
        "reviews": (night_reviews + reviews)[: int(v("reviews.max_listed"))],
        "decision_reviews": len(night_reviews),
        "reviews_total": n_rev,
        "nights": month["nights"],
        "owner_line": _owner_line(draw["op"], shadow["op"], s2["cash"], events, s2["fatigue"], waterfall),
        "night_events": _night_render(su, dn["night"], seed_draw, dn["pick"]) if dn else [],
        "labels": _labels(su, events),
        "season_end": season_value(s2) if s2.get("season_over") or s2["closed"] else None,
    }
    if rc is not None:  # lab:finance
        result["rent_card"] = {k: rc[k] for k in ("paid", "charged", "fee", "balance", "months", "fee_rate", "cash_delta")}
    return _round(result)


# --- preview: analytic, deterministic, fast --------------------------------------------------------------------
@functools.lru_cache(maxsize=1)
def _elasticity_samples() -> np.ndarray:
    base, _ = _base()
    lo, mode, hi = base["_range"]["mkt_price_elasticity"]
    return np.random.default_rng(7).triangular(min(lo, hi), mode, max(lo, hi), 400)


def preview(state: dict, plan: dict, events: list[str] | None = None, *, sensitivity: bool = True,
            light: bool = False, baseline: bool = True) -> dict:
    """Expected month for this plan (no randomness, no DES): scaled from the 평소 baseline by the same demand,
    price, cost and staff mechanisms as play_month. Labelled 빠른 추정; play_month is the real month."""
    out, su = _calibrated(state, plan, events)
    res = _preview_result(state, plan, out, su, events, light=light)
    if sensitivity and not light:
        res["sensitivity"] = _sensitivity(state, su["plan"], res["events"])
    if baseline and not light:
        res["vs_baseline"] = _vs_baseline_month(res)
    return res


def _vs_baseline_month(res: dict) -> dict:
    """This preview against the declared baseline month (the welcome tour's 영업이익): the gap a player sees between
    the tour and the planning board, with this month's external events named as its visible cause."""
    b = baseline_month()
    return {"base_op": b["op"], "op": res["expected"]["op"] - b["op"], "label_ko": b["label_ko"],
            "events_ko": [data()["EV"][e]["label"] for e in res["events"] if e in data()["EV"]]}


BASELINE_LABEL = "외부 사건이 없는 평소 달"
BASELINE_BASIS = "외부 사건이 없는 평소 달: 10월, 기본 계획, 시작 상태 (시뮬레이션 평균)"


def baseline_inputs() -> tuple[dict, dict, list[str]]:
    """The baseline month's inputs (state, plan, events): the starting state, the default plan, no external events.
    The one definition: baseline_month() and sim.tour both run the month from here."""
    return new_season(0), base_plan(), []


def baseline_month() -> dict:
    """The one declared baseline month: the preview of the default plan for the first month (October) from the
    starting state with NO external events (events=[], never the month's drawn festival etc.), which is the 평소
    anchor (_baseline) every waterfall and 평소 대비 starts from; the same for every seed. Screens and persona text
    call it 외부 사건이 없는 평소 달 (평균 예상); a played month is 이번 달 결과. research/hero_base.yaml _pnl_base is
    the workbook's own P&L (calibration target), not this baseline."""
    pv = preview(*baseline_inputs(), sensitivity=False, baseline=False)
    e = pv["expected"]
    return {"month": pv["month"], "label_ko": BASELINE_LABEL, "basis": BASELINE_BASIS,
            **{k: e[k] for k in ("revenue", "op", "covers", "ticket", "cogs", "labor", "rent", "mgmt", "fees")}}


_GRADES = ["imported", "domestic", "aged"]
_HYGIENE = ["basic", "normal", "high"]
_EXTRAS = ["naengsam", "tongsam", "minari"]


def _lever_steps(plan: dict) -> dict:
    """One step up / down for every lever from this plan (None where it cannot move): (up plan, down plan, step)."""
    def num(k, d, lo, hi):
        x = plan[k]
        return ({**plan, k: x + d} if x + d <= hi else None, {**plan, k: x - d} if x - d >= lo else None, f"±{d:,}")

    def order(k, seq):
        i = seq.index(plan[k])
        return ({**plan, k: seq[i + 1]} if i + 1 < len(seq) else None, {**plan, k: seq[i - 1]} if i > 0 else None, "한 단계")

    def flag(k):
        return ({**plan, k: True} if not plan[k] else None, {**plan, k: False} if plan[k] else None, "켜기/끄기")

    missing = [x for x in _EXTRAS if x not in plan["menu_extras"]]
    return {
        "meat_price": num("meat_price", 1000, 12000, 30000), "soju_price": num("soju_price", 500, 3000, 9000),
        "meat_grade": order("meat_grade", _GRADES),
        "menu_extras": ({**plan, "menu_extras": plan["menu_extras"] + missing[:1]} if missing else None,
                        {**plan, "menu_extras": plan["menu_extras"][:-1]} if plan["menu_extras"] else None, "메뉴 하나"),
        "banchan": num("banchan", 1, 2, 10), "staff_grilling": flag("staff_grilling"),
        "staff_per_shift": num("staff_per_shift", 1, int(v("staff.min_per_shift")), int(v("staff.max_per_shift"))),
        "close_hour": num("close_hour", 1, 23, 25), "lunch": flag("lunch"), "terrace": flag("terrace"),
        "marketing_budget": num("marketing_budget", 500_000, 0, 3_000_000), "review_event": flag("review_event"),
        "group_reservations": flag("group_reservations"), "hygiene": order("hygiene", _HYGIENE),
    }


def _consequence(state: dict, plan: dict, events: list[str]) -> dict:
    pv, s2 = step_estimate(state, plan, events)
    op = pv["expected"]["op"]
    return {"op": op, "covers": pv["expected"]["covers"], "rating_recent": s2["rating"], "fatigue": s2["fatigue"],
            "runway_months": (s2["cash"] / -op if op < 0 and s2["cash"] > 0 else (0.0 if s2["cash"] <= 0 else None))}


def _sensitivity(state: dict, plan: dict, events: list[str]) -> dict:
    """§12.2: for one step of each lever, the change in op, covers, rating_recent, fatigue (next month) and the cash
    runway after the month (absolute; None = not losing money). Analytic, same month and events."""
    now = _consequence(state, plan, events)

    def delta(p2):
        if p2 is None:
            return None
        x = _consequence(state, p2, events)
        return {k: (x[k] - now[k]) for k in ("op", "covers", "rating_recent", "fatigue")} | {"runway_months": x["runway_months"]}
    return {k: {"up": delta(up), "down": delta(down), "step": step} for k, (up, down, step) in _lever_steps(plan).items()}


def _vs_base(state: dict, plan: dict, out: dict, events: list[str]) -> dict:
    """Against the base plan in the same month, state and events (the play_month shadow, analytically)."""
    b, _ = _calibrated(state, base_plan(), events)
    return {"op": out["op"] - b["op"], "revenue": out["revenue"] - b["revenue"], "base_op": b["op"],
            "basis": "이번 달, 같은 사건에서 평소 계획이었다면"}


def _calibrated(state: dict, plan: dict, events: list[str] | None) -> tuple[dict, dict]:
    out, su = _analytic(state, plan, events)
    k = _calibration(current_month(state))
    out["revenue"] *= k["revenue"]
    out["cogs"] *= k["cogs"]
    out["fees"] *= k["revenue"]
    # measured bias: the analytic estimate runs optimistic as more levers move away from the base plan
    changed = sum(1 for key, x in _validate(plan).items() if x != base_plan().get(key))
    out["revenue"] -= v("band.preview_bias_per_lever") * changed * out["revenue"]
    out["cost"] = out["cogs"] + out["labor"] + out["rent"] + out["mgmt"] + out["fees"]
    out["op"] = out["revenue"] - out["cost"]
    out["op_margin"] = out["op"] / out["revenue"] if out["revenue"] else 0.0
    return out, su


@functools.lru_cache(maxsize=8)
def _calibration(month: int = 10) -> dict:
    """Ratio of the DES mean to the analytic estimate for the base plan in this calendar month (start state, no
    events), so preview(base plan) equals the DES mean in every month, not only October."""
    st = new_season(0)
    st["month_index"] = months().index(month)
    out, _ = _analytic(st, base_plan(), [])
    des = _baseline() if month == 10 else _month_means()[str(month)]
    return {"revenue": des["revenue"] / out["revenue"], "cogs": des["cogs"] / out["cogs"]}


@functools.lru_cache(maxsize=1)
def _month_means() -> dict:
    """DES means of the base plan in every other season month (start state, no events); cached like 평소."""
    import json
    n = _runs("band.month_runs")
    path = _cache_path("season_months", n)
    if path.exists():
        return json.loads(path.read_text())
    out = {}
    for m in months():
        if m == 10:
            continue
        st = new_season(0)
        st["month_index"] = months().index(m)
        su = _setup(st, base_plan(), [])
        runs = [_pnl(simulate_month(su["params"], su["profile"], 3000 + i, a=su["a"]), su, None, 0) for i in range(n)]
        out[str(m)] = {k: float(np.mean([r[k] for r in runs])) for k in ("revenue", "cogs", "op")}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    return out


def _cache_path(name: str, n: int) -> Path:
    import hashlib
    h = hashlib.sha1(str(n).encode())
    h.update(_STORE_KEY.encode("utf-8"))
    for f in _BASELINE_INPUTS:
        h.update((ROOT / f).read_bytes())
    return ROOT / "data" / "cache" / f"{name}_{h.hexdigest()[:16]}.json"


# DES fits (sim/tests/test_season.py checks the direction): mean wait for a server, walk-away parties, lost add-ons
_FIT_MAX_LOAD = 0.95   # the DES grid behind these fits reached about this load; beyond it, hold the curve flat


def _svc_wait(load: float) -> float:
    return 108.6 * max(0.0, min(load, _FIT_MAX_LOAD) - 0.15) ** 3.12


def _keep(load: float) -> float:
    """Share of dinner revenue kept when service slows (walk-aways + dropped 추가 주문), vs the analytic serving
    load. Fitted on a DES grid (RMSE 1.4% of revenue, worst 3.6% for an overloaded owner alone)."""
    return max(0.3, 1 - 0.3668 * max(0.0, load - 0.2983))


def _eff_load(load: float) -> float:
    """DES serving load saturates where the analytic one keeps rising (fit RMSE 0.008)."""
    return load / (1 + 0.4021 * max(0.0, load - 0.3183) ** 1.4795)


def _walk_share(crowd: float) -> float:
    """Share of demand lost to a full house (queue, balk), fitted on a DES grid of demand x0.8-1.7, tables -0..-2
    and terrace 0/0.4 (RMSE 0.8% of covers): crowd = demand / seating capacity, both relative to 평소."""
    return min(0.6, 0.0542 * crowd ** 1.909)


def _analytic(state: dict, plan: dict, events: list[str] | None) -> tuple[dict, dict]:
    base = _baseline()
    events = draw_events(state) if events is None else list(events)   # the same events play_month will use
    plan = _validate(plan)
    # closures as play_month resolves them: owner sickness for sure, an inspection fail by its probability
    sick_days = 3 if "owner_sick" in events else 0
    hyg_days = (data()["P"]["hygiene"][plan["hygiene"]]["inspection_fail"] * v("hygiene.fail_closed_days")
                if "hygiene_inspection" in events else 0.0)
    su = _setup(state, plan, events, closure_days=sick_days, quit_now="staff_quit" in events)
    b0 = _setup(new_season(0), base_plan(), [])
    p, pb = su["params"], b0["params"]
    open_days = p["sto_open_days"] - hyg_days
    eps = _elasticity_samples()
    price_eff = float(np.mean((p["_price_index"] / pb["_price_index"]) ** eps))
    soju_eff = float(np.mean((p["prd_alcohol_price"] / pb["prd_alcohol_price"]) ** eps))
    days_ratio = open_days / pb["sto_open_days"]
    # rain nights: fewer people out (wx_rain_arrival_effect) and the 야장 stays shut, as in the DES
    rain, rain0 = p["wx_rain_nights_share"], pb["wx_rain_nights_share"]
    rain_eff = (1 + rain * p["wx_rain_arrival_effect"]) / (1 + rain0 * pb["wx_rain_arrival_effect"])
    cap = (p["sto_tables"] + (p["sto_terrace"] / 4) * p["sto_terrace_availability"] * (1 - rain)) / \
          (pb["sto_tables"] + (pb["sto_terrace"] / 4) * pb["sto_terrace_availability"] * (1 - rain0))
    demand_ratio = p["drv_arrival_rate"] / pb["drv_arrival_rate"] * price_eff * rain_eff
    crowd = demand_ratio / cap
    walk_share = _walk_share(crowd)
    covers = base["dinner_covers"] * demand_ratio * days_ratio * (1 - walk_share) / (1 - _walk_share(1.0))
    bottles_pp = pb["prd_alcohol_per_cover"] * soju_eff
    ticket = p["prd_portions_per_cover"] * p["prd_meat_price"] + bottles_pp * p["prd_alcohol_price"] + p["prd_side_spend_per_cover"]
    revenue = covers * ticket
    food_pc = (p["prd_portions_per_cover"] * p["cst_meat_cost_per_portion"] + bottles_pp * p["cst_alcohol_cost_per_bottle"]
               + p["prd_side_spend_per_cover"] * p["cst_side_cost_ratio"] + p["cst_banchan_cost_per_cover"])
    month = {"covers": covers, "revenue": revenue, "ticket": ticket, "cogs": covers * food_pc,
             "labor": (p["sto_parttimers"] * p["sto_parttime_shift_hours"] * p["sto_open_days"] * p["sto_parttime_wage"]
                       * p["cst_holiday_pay_factor"] + p["sto_employees"] * p["cst_employee_wage"] + p["cst_owner_imputed_wage"]),
             "rent": p["drv_rent"], "mgmt": p["cst_utilities"] + p["cst_other_opex"],
             "walkaways": base["walkaways"] * demand_ratio * days_ratio * walk_share / _walk_share(1.0), "avg_wait_min": base["avg_wait_min"] * crowd ** 3,
             "table_utilization": base["table_utilization"] * covers / base["dinner_covers"] / cap,
             "alcohol_share": bottles_pp * p["prd_alcohol_price"] / ticket, "revpash": 0.0}
    # staff load: work per party scales with grilling, extras and bottles; servers = part-timers + owner
    work_pp = 11.0 + (SIM_ASSUMPTIONS["svc_staff_grill_min"] if plan["staff_grilling"] else 0) + su["a"]["svc_extra_per_party_min"]
    work_pp0 = 11.0 + b0["a"]["svc_extra_per_party_min"]
    servers, servers0 = max(1, p["sto_parttimers"] + 1), max(1, pb["sto_parttimers"] + 1)
    month["staff_load"] = base["staff_load"] * (covers / base["dinner_covers"]) * (work_pp / work_pp0) * (servers0 / servers) \
        * su["a"]["svc_speed_factor"] / b0["a"]["svc_speed_factor"] * (pb["drv_open_hours"] / p["drv_open_hours"])
    # slow service costs seats and 추가 주문 (fitted on a DES grid: staff 0-2, grilling, fatigue 30/70, Oct/Dec/Jan)
    raw = month["staff_load"]
    keep = _keep(raw) / _keep(base["staff_load"])
    month["walkaways"] += covers * (1 - keep) / 2.8
    covers *= keep
    month["covers"], month["revenue"], month["cogs"] = covers, covers * ticket, covers * food_pc
    month["staff_load"] = _eff_load(raw)          # what staff can actually do saturates
    month["staff_load_raw"] = raw
    month["svc_wait"] = _svc_wait(month["staff_load"])
    n_rev_exp = covers / 2.8 * v("reviews.base_prob") * (v("marketing.review_event_prob_mult") if plan["review_event"] else 1)
    out = _pnl(month, su, None, n_rev_exp)
    out["_crowd"] = crowd
    out["_events"] = events
    return out, su


def _preview_result(state: dict, plan: dict, out: dict, su: dict, events: list[str] | None, light: bool = False) -> dict:
    base = _baseline()
    events = out["_events"]
    plan = su["plan"]
    crowd = out["_crowd"]
    # expected satisfaction of a typical party per segment
    svc_wait = _svc_wait(out["staff_load"])
    sats, loyal = [], []
    for seg in SEGMENTS:
        s, terms = satisfaction({"segment": seg, "wait": out["avg_wait_min"], "svc_wait": svc_wait, "mid_wait": 1.1 * svc_wait,
                                 "queued": crowd > 1.3, "walked": False, "size": 3}, su)
        sats.append(s)
        loyal.append(_loyal(s, terms))
    out["satisfaction"] = float(np.mean(sats))
    out["satisfaction_loyal"] = float(np.mean(loyal))
    target = _fatigue_target(out["staff_load"], plan, events)
    fatigue_next = v("fatigue.carry") * state["fatigue"] + (1 - v("fatigue.carry")) * min(100.0, target)
    quit_risk = quit_prob(fatigue_next, plan["staff_per_shift"])
    if light:   # analytic rollouts (step_estimate, reports): just what the next state needs
        return {"plan": plan, "events": events, "month": su["month"], "_su": su,
                "expected": {k: out[k] for k in ("revenue", "op", "covers", "walkaways", "staff_load", "satisfaction",
                                                 "satisfaction_loyal", "cogs", "labor", "rent", "mgmt", "fees")},
                "state_next": {"fatigue": fatigue_next, "quit_risk": quit_risk, "cash": state["cash"] + out["op"]}}
    warnings = []
    if fatigue_next > 70:
        warnings.append({"code": "fatigue_high", "text": "직원 피로가 높아 다음 달 퇴사 위험이 커집니다"})
    if out["satisfaction"] < 0.45:
        warnings.append({"code": "satisfaction_low", "text": "손님 만족이 낮아 평점과 단골이 줄 수 있습니다"})
    if state["cash"] + out["op"] < 0:
        warnings.append({"code": "cash_negative", "text": "이대로면 이번 달 말 현금이 0 아래로 내려갑니다"})
    if out.get("staff_load_raw", 0.0) > v("staff.overload_from") or su["params"]["sto_parttimers"] == 0:
        warnings.append({"code": "overload", "text": "일손이 크게 모자라거나 사장님 혼자 서빙하는 구간입니다. 손님이 많이 돌아가고, "
                                                     "이 빠른 추정의 오차도 커집니다 (실제 달은 시뮬레이션으로 계산)"})
    lunch = _lunch_net(out, su) if plan["lunch"] else None
    if lunch and lunch["net"] < 0:
        warnings.append({"code": "lunch_negative", "text": (
            f"점심 영업은 이번 달 약 {man_won(lunch['net'])}으로 추정됩니다. 상권 한식 매출의 23%가 점심이지만 (S12) "
            f"점심 특선은 객단가가 낮아 매출 {man_won(lunch['revenue'])}이 재료·알바·공과금 "
            f"{man_won(lunch['cost'])}을 넘지 못합니다")})
    # risks this plan carries into the coming months (events that need the plan, e.g. 숙성육 편차)
    risks = []
    for eid, e in data()["EV"].items():
        req = e.get("requires") if isinstance(e, dict) else None
        if not req or eid in events or any(plan.get(k) != w for k, w in req.items()):
            continue
        hit, _ = _calibrated(state, plan, events + [eid])
        prob = max((e.get("prob") or {}).values() or [0.0])
        risks.append({"id": eid, "label": e["label"], "prob": prob, "op_delta": hit["op"] - out["op"], "tag": e["tag"]})
        warnings.append({"code": f"risk:{eid}", "text": (
            f"{e['label']}: 매달 {prob:.0%} 확률로 일어나고, 일어나면 영업이익이 약 {man_won(hit['op'] - out['op'])} "
            f"달라집니다 (가정)")})
    return _round({
        "engine": "sim.season v2 preview", "estimate": "빠른 추정 (분석식, 확률 없음)", "month": su["month"],
        "calendar": {"label": su["cal"]["label"], "demand_index": su["cal"]["demand_index"]},
        "events": events, "plan": plan,
        "expected": {k: out[k] for k in ("revenue", "op", "op_margin", "covers", "ticket", "walkaways", "staff_load",
                                         "satisfaction", "satisfaction_loyal", "cogs", "labor", "rent", "mgmt", "fees",
                                         "lunch_revenue", "group_revenue")},
        "op_range": _op_range(out, su),
        "risks": risks, "lunch": lunch,
        "state_next": {"fatigue": fatigue_next, "quit_risk": quit_risk, "cash": state["cash"] + out["op"]},
        "vs_base": _vs_base(state, plan, out, events),
        "warnings": [w["text"] for w in warnings], "warning_codes": [w["code"] for w in warnings],
        "labels": _labels(su, events),
    })


# --- analytic season rollout (dominance guard, planning aids) -------------------------------------------------
def step_estimate(state: dict, plan: dict, events: list[str] | None = None) -> tuple[dict, dict]:
    """Expected next state after one month with this plan: preview numbers + the same state update rules as
    play_month, using expected reviews instead of drawn ones. Deterministic."""
    events = [] if events is None else list(events)
    pv = preview(state, plan, events, sensitivity=False, light=True)
    plan = pv["plan"]
    su = pv["_su"]
    e = pv["expected"]
    s = e["satisfaction"]
    n_rev = e["covers"] / 2.8 * v("reviews.base_prob") * (v("marketing.review_event_prob_mult") if plan["review_event"] else 1)
    stars = v("start.rating") + v("satisfaction.star_slope") * (s - _neutral_sat(analytic=True)["s"]) \
        + (v("marketing.review_event_star_bias") * v("marketing.review_event_share") if plan["review_event"] else 0)
    stars = min(5.0, max(1.0, stars))
    ev_state = {}
    for ev_id in events:
        for k, x in data()["EV"][ev_id]["effects"].get("state", {}).items():
            ev_state[k] = ev_state.get(k, 0) + x
    s2 = copy.deepcopy(state)
    s2["flags"] = su["flags"]
    s2["cash"] = state["cash"] + e["op"]
    s2["negative_months"] = state["negative_months"] + 1 if s2["cash"] < 0 else 0
    low = e["revenue"] <= v("closure.low_revenue_share") * _baseline()["revenue"]
    s2["low_revenue_months"] = state.get("low_revenue_months", 0) + 1 if low else 0
    s2["closed"], s2["closed_reason"] = _closure(s2)
    w = min(state["review_count"], v("reviews.window"))
    s2["rating"] = min(5.0, max(1.0, (state["rating"] * w + stars * n_rev) / (w + n_rev) + ev_state.get("rating", 0)))
    s2["rating_recent"] = s2["rating"]
    s2["rating_all"] = _rating_all(state, stars * n_rev, n_rev)
    s2["review_count"] = state["review_count"] + n_rev + ev_state.get("review_count", 0)
    extras_aw = sum(data()["P"]["menu_extras"][x]["awareness"] for x in plan["menu_extras"])
    s2["awareness"] = max(0.5, 1 + v("awareness.decay") * (state["awareness"] - 1)
                          + v("marketing.awareness_per_million") * plan["marketing_budget"] / 1e6 + extras_aw
                          + v("awareness.reviews_per_100") * n_rev / 100 + ev_state.get("awareness", 0))
    prev = state["plan"]
    changes = int(prev.get("meat_price") != plan["meat_price"]) + int(prev.get("meat_grade") != plan["meat_grade"])
    ld = e["satisfaction_loyal"] - _neutral_sat(analytic=True)["loyal"]
    s2["regular_share"] = min(v("regulars.max"), max(v("regulars.min"), state["regular_share"]
                              + _regular_delta(ld) + _opening_accrual(state, ld)
                              - v("regulars.change_penalty") * changes))
    s2["fatigue"] = pv["state_next"]["fatigue"]
    s2["plan"] = plan
    s2["month_index"] = state["month_index"] + 1
    s2["history"] = state["history"] + [{"month": su["month"], "op": round(e["op"]), "cash": round(s2["cash"])}]
    return pv, s2


def estimate_season(plan: dict, events_by_month: list[list[str]] | None = None, seed: int = 0,
                    draw: bool = False) -> dict:
    """Hold one plan for the whole season (analytic): month OPs, ending cash, rating, closed or not.
    draw=True draws each month's events from the event model (seeded), as play_month would."""
    st = new_season(seed)
    ops = []
    for i in range(len(months())):
        if draw:
            evs = draw_events({**st, "plan": _validate(plan) if i else st["plan"]})
        else:
            evs = (events_by_month or [[]] * len(months()))[i]
        pv, st = step_estimate(st, plan, evs)
        ops.append(pv["expected"]["op"])
        if st["closed"]:
            break
    return {"ops": ops, "cash": st["cash"], "rating": st["rating"], "closed": st["closed"], "state": st}
