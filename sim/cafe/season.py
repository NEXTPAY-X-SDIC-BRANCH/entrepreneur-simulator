"""Step 3 월별 운영: a 12-month run of the store set up in steps 1~2.

Pure and deterministic: the run is a JSON-able dict, `play_month(run, decisions)` returns the next run and the month;
the same seed and the same decisions give the same months. Events are drawn per (seed, month, event), so a different
decision never changes which events happen (only their effect). Every effect size lives in research/cafe/params.yaml
`season:` with a grade; the store (demand, capacity, schedule, fixed costs, depreciation) comes from model.preview.
"""
from __future__ import annotations

import math
from pathlib import Path
import json
import functools
import random

from . import model as m
from .ko import won
from .params import g, load_districts, load_params, v, weakest
from ..opex import cafe_month_line   # lab:cost
from .. import menu as menu_mod   # lab:menu
from sim import rent_card  # lab:finance


def o_shares() -> dict:   # lab:cost — 수선 소모품 기본 마케팅 줄을 나눌 비율 (params.yaml opex)
    return {k: v("opex", f"{k}_share") for k in ("repairs", "supplies", "marketing")}


HOURS_KO = {"short": "짧게", "standard": "기본", "long": "길게"}
STAFF_KO = {"lean": "빠듯하게", "standard": "기본", "generous": "넉넉하게"}
DECISION_KEYS = ("price_change_pct", "hours", "staff_policy", "marketing_krw", "dessert", "delivery", "open_hour", "close_hour", "menu")
# hard 모드 메뉴·판촉 (보내지 않으면 이 값 = 효과 없음)
MENU_DEFAULT = {"bean": "standard", "seasonal": False, "dessert_price_pct": 0.0, "takeout_disc": 0.0, "loyalty": False,
                "delivery_share": None, "free_dlvy_krw": 0}
# waterfall: factors are switched from the reference month to this month one at a time, in this order
STEPS = (("season", "계절"), ("ingredient", "원두·우유 시세"), ("delivery", "배달"), ("reputation", "별점과 단골"), ("price", "가격"), ("hours", "영업시간"),
         ("staff", "직원 운영"), ("marketing", "마케팅"), ("dessert", "디저트"), ("menu", "메뉴·판촉"), ("rival", "경쟁 카페"),
         ("viral", "SNS 화제"), ("breakdown", "설비 고장"), ("rent", "임대료 인상"), ("scn", "이번 달 대응"))
STEP_FACTORS = {"season": ("season",), "ingredient": ("ingredient",), "delivery": ("delivery", "delivery_mult"), "reputation": ("rating", "maturity"), "price": ("price_level",),
                "hours": ("hours", "hours_t"), "staff": ("staff",), "marketing": ("marketing_krw",), "dessert": ("dessert",), "menu": ("menu",),
                "rival": ("rival",), "viral": ("viral",), "breakdown": ("breakdown",), "rent": ("rent_mult",), "scn": ("scn",)}
DAYS = m.DAYS_PER_MONTH_DATA


class SeasonOver(Exception):
    """The run is closed (cash rule) or every month is played."""


def s(key: str):
    return v("season", key)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# 구·행정동별 배달 배수: 소상공인365 배달분석 카페·디저트 (web/public/mock/sbiz_delivery.json, pipelines/build_sbiz365_delivery.py).
# 행정동 값이 있으면 그 동 카페 한 곳의 월평균 배달 주문 ÷ 서울 가운데값, 없으면 구 값, 파일이 없으면 params의 서울서베이 지수
_COMMERCIAL_GU = {"3120012": "종로구", "3120094": "서대문구", "3110131": "성동구"}   # 상권 코드 3곳이 속한 구


@functools.lru_cache(maxsize=1)
def _sbiz_cafe() -> dict | None:
    f = Path(__file__).resolve().parents[2] / "web" / "public" / "mock" / "sbiz_delivery.json"
    if not f.exists():
        return None
    return json.loads(f.read_text(encoding="utf-8")).get("inds", {}).get("cafe")


def delivery_area_mult(district: str) -> float:
    d = _sbiz_cafe()
    if d:
        seoul = d["seoul"]["orders"] or 1
        gname = _COMMERCIAL_GU.get(district)
        for g, x in d["gu"].items():
            if g == gname or x.get("cd") == district[:5]:
                dong = x["dongs"].get(district)
                if dong and dong["orders"] > 0:
                    return round(_clamp(dong["orders"] / seoul, 0.4, 2.5), 3)
                return x["index"]
    return s("delivery_gu_index").get(district, 1.0)


def _hrs(f: dict) -> tuple[int, int]:
    """영업 시각: 직접 정한 시각(hours_t)이 있으면 그것, 없으면 짧게/기본/길게 프리셋."""
    t = f.get("hours_t")
    return tuple(t) if t else tuple(s("hours")[f["hours"]])


def _menu(f: dict) -> dict:
    return {**MENU_DEFAULT, **(f.get("menu") or {})}


# ---------------------------------------------------------------------------------------------- store context

def _context(cfg: dict) -> dict:
    """Everything about the store that does not change month to month, from the step 1~2 model."""
    p = m.preview(cfg)
    cfg = p["input"]
    core = m._core(cfg)
    dist = load_districts()[cfg["district"]]
    meta = load_params()["district_meta"][cfg["district"]]
    fixed = {x["item_ko"]: x["krw"] for x in p["monthly_fixed"]["lines"]}
    return {
        "cfg": cfg, "preview": p, "core": core,
        "avg_day": core["demand"]["avg_day_customers"],
        "ticket": dist["ticket_krw"]["value"],
        "rent": fixed["임대료"], "maint": fixed["관리비"], "water_gas": fixed["수도 가스"], "misc": fixed["통신 보험 세무"],
        "dep": p["rough_month"]["depreciation_krw"],
        "day_factor": {d: dist[f"{d}_day_factor"]["value"] for d in ("weekend", "weekday")},
        "opens_per_year": meta["opens_per_year"]["value"],
        # lab:menu  메뉴판 (시즌 시작 때 정함). 없으면 None, 엔진은 예전 그대로
        "menu": menu_mod.cafe_ctx(menu_mod.clean(cfg.get("menu"), "cafe"), dist["ticket_krw"]["value"], s("dessert_share"),
                                  v("demand", "cups_per_tx")),
    }


def _coverage(code: str, hours: tuple[int, int]) -> float:
    """Demand the opening hours catch, relative to the standard hours: open hours keep their 상권 share, a part of the
    closed hours' customers shift into open hours. Standard hours = 1 (the step 2 model renormalizes over them)."""
    raw, shift = m.raw_hour_shares(code), s("hours_shift_share")

    def caught(o, c):
        inside = sum(raw[h] for h in range(o, c))
        return inside + shift * (sum(raw.values()) - inside)
    return caught(*hours) / caught(*s("hours")["standard"])


def _balk(util: float, mult: float) -> float:
    """Share of the customers a capacity could serve who still walk away at the sight of the queue (logistic in
    peak demand ÷ capacity; shape from Lu et al. 2013, research §6)."""
    return min(0.9, s("balk_max") * mult / (1 + math.exp(-(util - s("balk_mid_util")) / s("balk_width"))))


def _day_rows(ctx: dict, f: dict, day_orders: float) -> list[dict]:
    """The step 2 hourly schedule for this day's orders, with the owner's hours and the staff policy's utilization,
    capped at the peak crew (staff_peak, 사장님 included). Lean staffs by workload only: no extra person to cover a
    rush, so it saves wages and loses customers when an hour outruns its people."""
    core = ctx["core"]
    return m._schedule(ctx["cfg"], day_orders, core["crew"], hours=_hrs(f),
                       util=s("staff_utilization")[f["staff"]], cover=s("staff_cover")[f["staff"]])


def _served_day(ctx: dict, f: dict, day_orders: float, rows: list[dict]) -> tuple[float, str, float]:
    """Orders served on one day, hour by hour: drinks with the in-hour surge against what that hour's people can
    deliver with the equipment. Returns (served orders, binding resource at the busiest hour, peak utilization)."""
    cfg, core = ctx["cfg"], ctx["core"]
    equip = core["cap_equipment"]
    eq_key = min(equip, key=lambda k: (equip[k], k))
    cups, surge = v("demand", "cups_per_tx"), v("demand", "peak_surge")
    bm = s("staff_balk_mult")[f["staff"]]
    served, peak, key = 0.0, 0.0, eq_key
    for row, share in zip(rows, m._hour_shares(cfg["district"], _hrs(f)).values()):
        orders = day_orders * share
        drinks = orders * cups * surge
        c = m.crew_throughput(cfg, row["staff"], drinks, core["seats_total"])
        util = drinks / c if c > 0 else math.inf
        if util > peak:
            peak = util
            key = "staff" if c < min(drinks, equip[eq_key]) - 1e-6 else eq_key
        frac = (min(1.0, 1 / util) if util > 0 else 1.0) * (1 - _balk(util, bm))
        served += orders * frac
    return served, key, peak


def _labor(ctx: dict, f: dict, day_rows: dict) -> tuple[float, int]:
    """Paid hours and cost from the day schedules (owner's slot unpaid) plus dessert prep.
    Returns (paid hours per month, KRW)."""
    days = v("opex", "days_per_month")
    n_weekend = round(days * 2 / 7)
    paid = 0
    for day, n in (("weekend", n_weekend), ("weekday", days - n_weekend)):
        paid += m._owner_paid_split(day_rows[day])[1] * n
    if f["dessert"]:
        paid += s("dessert_prep_hours_per_day") * days
    return round(paid, 1), round(paid * m._hourly_cost())   # owner_hours_per_day can be fractional (9.3)


def scenario_points(cal: int | None = None) -> list[dict]:
    """달별 사건 (한 달에 하나). cal(1~12)을 주면 그 달의 사건만."""
    pts = s("scenario_points")
    return [p for p in pts if cal is None or p["month"] == cal]


def default_scenario(cal: int) -> dict:
    return {p["id"]: p["default"] for p in scenario_points(cal)}


def clean_scenario(chosen: dict | None, cal: int) -> dict:
    """그 달 사건의 고른 선택지. 안 고른 것은 기본 선택지, 모르는 id는 오류."""
    out = default_scenario(cal)
    for pid, oid in (chosen or {}).items():
        pt = next((p for p in scenario_points(cal) if p["id"] == pid), None)
        if pt is None or oid not in {o["id"] for o in pt["options"]}:
            raise ValueError(f"unknown scenario choice {pid}={oid} for month {cal}")
        out[pid] = oid
    return out


def _scn_effects(scn: dict) -> dict:
    eff = {"walk_recover": 0.0, "demand_mult": 1.0, "ticket_mult": 1.0, "cost_krw": 0, "satisfaction": 0.0}
    for p in scenario_points():
        oid = (scn or {}).get(p["id"])
        if oid is None:
            continue
        o = next(x for x in p["options"] if x["id"] == oid)
        eff["walk_recover"] += o.get("walk_recover", 0.0)
        eff["demand_mult"] *= o.get("demand_mult", 1.0)
        eff["ticket_mult"] *= o.get("ticket_mult", 1.0)
        eff["cost_krw"] += o.get("cost_krw", 0)
        eff["satisfaction"] += o.get("satisfaction", 0.0)
    return eff


def evaluate(ctx: dict, f: dict) -> dict:
    """One month's outcome for the factor set f (season, reputation, decisions, events). No state change."""
    cfg = ctx["cfg"]
    hours = _hrs(f)
    eps = s("price_elasticity") + (s("rival_elasticity_add") if f["rival"] else 0)
    lift = s("marketing_max_lift") * (1 - math.exp(-f["marketing_krw"] / s("marketing_half_krw")))
    mult = {
        "season": f["season"], "maturity": f["maturity"],
        "rating": 1 + s("rating_demand_per_star") * (f["rating"] - s("rating_start")),
        "price": f["price_level"] ** (-eps), "marketing": 1 + lift,
        "rival": s("rival_demand_mult") if f["rival"] else 1.0, "viral": f["viral"],
        "hours": _coverage(cfg["district"], hours), "scn": _scn_effects(f.get("scn"))["demand_mult"],
    }
    mn = _menu(f)
    to_sh = v("opex", "takeout_share")
    mult["menu"] = ((s("bean_specialty_demand") if mn["bean"] == "specialty" else 1.0)
                    * (s("seasonal_demand") if mn["seasonal"] else 1.0)
                    * (s("loyalty_demand") if mn["loyalty"] else 1.0)
                    * (1 + to_sh * s("takeout_disc_lift") * mn["takeout_disc"]))
    scn = _scn_effects(f.get("scn"))
    if ctx.get("menu"):   # lab:menu  메뉴의 가격 수준이 기본 메뉴보다 높으면 손님이 준다 (같은 탄력성)
        mult["price"] *= menu_mod.cafe_price_index(ctx["menu"], f["dessert"]) ** (-eps)
    avg_day = ctx["avg_day"] * math.prod(mult.values())
    open_share = 1 - (s("breakdown_down_days") / DAYS if f["breakdown"] else 0)
    demand = served = 0.0
    day_orders, day_rows, binding, peak = {}, {}, "seating", 0.0
    for day, w in (("weekend", 2 / 7), ("weekday", 5 / 7)):
        orders = avg_day * ctx["day_factor"][day]
        day_orders[day] = orders
        day_rows[day] = _day_rows(ctx, f, orders)
        got, key, pk = _served_day(ctx, f, orders, day_rows[day])
        demand += orders * w * DAYS
        served += got * w * DAYS
        if pk > peak:
            binding, peak = key, pk
    demand *= open_share
    served *= open_share
    served += (demand - served) * min(1.0, scn["walk_recover"])

    ds = s("dessert_share")
    ds_eff = ds * (1 if cfg["showcase"] else s("dessert_no_showcase_factor")) if f["dessert"] else 0.0
    # 디저트 가격: 같이 사는 비율이 가격^(-탄력)으로 변하고, 디저트 매출 몫은 가격 × 수량만큼 (원가는 수량만큼)
    dp = 1 + mn["dessert_price_pct"] / 100
    dq = dp ** (-s("dessert_price_elasticity"))
    ds_rev = ds_eff * dp * dq / (1 - ds_eff + ds_eff * dp * dq) if ds_eff else 0.0
    drink_ticket = ctx["ticket"] * (1 - ds)
    ticket = drink_ticket / (1 - ds_rev) * f["price_level"] * scn["ticket_mult"]
    ticket *= (s("seasonal_ticket") if mn["seasonal"] else 1.0) * (1 - s("loyalty_free_share") if mn["loyalty"] else 1.0)
    ticket *= 1 - to_sh * mn["takeout_disc"]   # 포장 손님에게 깎아 준 만큼
    # 배달: 배달하는 달에는 전체 주문의 delivery_order_share가 배달이고, 그중 delivery_cannibal은 원래 매장에 왔을 손님이다.
    # 배달 주문은 구·달별 배달 수요 배수를 곱하고, 한 건마다 배달앱·대행 수수료와 포장재가 든다 (주방 일손 한도는 보지 않음)
    deliv, served_store = 0.0, served
    if f.get("delivery"):
        sh0 = s("delivery_order_share")
        sh = mn["delivery_share"] if mn["delivery_share"] is not None else sh0
        # 배달 비중을 조사 값보다 키우면 덜 늘고(지수 0.6), 무료배달을 부담하면 주문이 는다 (가정)
        deliv = served * sh0 / (1 - sh0) * (sh / sh0) ** s("delivery_share_exp") * f.get("delivery_mult", 1.0)
        deliv *= 1 + s("free_dlvy_lift_per_1000") * mn["free_dlvy_krw"] / 1000
        served = served - deliv * s("delivery_cannibal") + deliv
    revenue = served * ticket
    dessert_rev = revenue * ds_rev
    drink_food = (v("opex", "food_cost_share") - ds * s("dessert_food_cost_share")) / (1 - ds)
    drink_food *= f.get("ingredient", 1.0)   # 원두·우유 시세 (2024년 대비, 달별)
    drink_food *= s("bean_specialty_cost") if mn["bean"] == "specialty" else 1.0
    food = served * drink_ticket / (1 - ds_eff) * ((1 - ds_eff) * drink_food + ds_eff * dq * s("dessert_food_cost_share"))
    if ctx.get("menu"):   # lab:menu  객단가·식재료비를 메뉴판에서 (sim/menu.py cafe_money)
        ticket, revenue, dessert_rev, food = menu_mod.cafe_money(ctx["menu"], ds_eff, served, f["price_level"] * scn["ticket_mult"])
    rate = m.card_fee_rate(revenue * 12)
    takeout_cups = served * v("demand", "cups_per_tx") * v("opex", "takeout_share")
    paid_h, labor = _labor(ctx, f, day_rows)
    elec = m._electricity(cfg, hours)["krw"]
    o = lambda k: v("opex", k)   # noqa: E731
    lines = [
        ("food", "식재료비", food, g("opex", "food_cost_share"),
         "음료 원가 + 디저트 원가 (디저트 원가율은 L), 가격을 올려도 원가는 그대로"),
        ("card", "카드수수료", revenue * o("card_share") * rate, g("opex", "card_fee_bands"), f"{rate * 100:.2f}% 구간"),
        ("packaging", "포장재", takeout_cups * o("packaging_per_takeout_cup"), "가정", "테이크아웃 잔당"),
        ("delivery", "배달 수수료·포장", deliv * (s("delivery_app_fee_krw") + s("delivery_agency_fee_krw") + s("delivery_packaging_krw")), "M",
         f"배달 {round(deliv):,}건 × (배달앱 {s('delivery_app_fee_krw'):,}원 + 대행 {s('delivery_agency_fee_krw'):,}원 + 포장 {s('delivery_packaging_krw'):,}원)"),
        ("shares", "수선 소모품 기본 마케팅", revenue * (o("repairs_share") + o("supplies_share") + o("marketing_share")),
         "가정", "매출 비례"),
        ("marketing", "추가 마케팅", f["marketing_krw"], "가정", "사장님이 정한 예산"),
        ("dessert_waste", "디저트 폐기",
         (dessert_rev * s("dessert_waste_share") + s("dessert_min_spoilage_krw")) if f["dessert"] else 0, "가정",
         "디저트 매출의 일부 + 최소 재고 폐기"),
        ("rent", "임대료", ctx["rent"] * f["rent_mult"],
         load_params()["district_meta"][cfg["district"]]["rent_per_pyeong_krw"]["grade"], "R-ONE 환산 임대료"),
        ("labor", "인건비", labor, "L", f"유급 {paid_h}시간, 사장님 하루 {o('owner_hours_per_day')}시간 무급"),
        ("owner", "사장 가상 급여", o("owner_pay_krw"), g("opex", "owner_pay_krw"),   # lab:cost
         "커피 전문점 대표자 인건비 평균 (농경연 2025). 조사의 영업이익은 이 값을 뺀 뒤라 같은 기준으로 뺌"),
        ("utilities", "전기 관리비 수도 통신", elec + ctx["maint"] + ctx["water_gas"] + ctx["misc"], "가정",
         "전기는 영업시간에 비례"),
        ("scenario", "이번 달 대응 비용", scn["cost_krw"], "가정", "고른 대응에 드는 돈"),
        ("menu", "시즌 음료·무료배달 부담", (s("seasonal_cost_krw") if mn["seasonal"] else 0) + deliv * mn["free_dlvy_krw"], "가정",
         "시즌 음료 개발·재료 손실, 배달 한 건마다 가게가 내는 무료배달 몫"),
        ("repair", "설비 수리", s("breakdown_repair_krw") if f["breakdown"] else 0, "가정", "고장 난 달만"),
    ]
    cost = [{"key": k, "item_ko": n, "krw": round(x), "grade": gr, "note_ko": note} for k, n, x, gr, note in lines]
    op_before = round(revenue) - sum(x["krw"] for x in cost)
    return {
        "revenue_krw": round(revenue), "customers": round(served), "demand": round(demand),
        "walkaways": round(demand - served_store), "walkaway_share": (demand - served_store) / demand if demand else 0.0,
        "ticket_krw": round(ticket), "dessert_revenue_krw": round(dessert_rev), "cost_lines": cost,
        "op_before_depreciation_krw": op_before, "depreciation_krw": ctx["dep"], "op_krw": op_before - ctx["dep"],
        "paid_hours": paid_h, "binding": binding, "peak_util": peak, "mult": mult, "marketing_lift": lift,
        "delivery_orders": round(deliv),
    }


# ---------------------------------------------------------------------------------------------- waterfall

# Against the baseline (a settled store) the reputation step is mostly the opening ramp, not a verdict on service:
# label it as such so a growing store is not told its regulars cost money.
VS_BASELINE = {"reputation": ("개업 초기 효과 (별점, 단골)",
                              "기준 달은 자리 잡은 가게 기준이라 처음 몇 달은 손님이 덜 와요, 단골이 쌓일수록 이 차이가 줄어요")}


def step_label(key: str, vs_baseline: bool) -> tuple[str, str | None]:
    if vs_baseline and key in VS_BASELINE:
        return VS_BASELINE[key]
    return dict(STEPS)[key], None


def waterfall(ctx: dict, f_from: dict, f_to: dict, vs_baseline: bool = False) -> list[dict]:
    """Why OP moved from f_from to f_to: switch one factor group at a time in STEPS order; the steps sum exactly."""
    cur = dict(f_from)
    prev = evaluate(ctx, cur)["op_krw"]
    out = []
    for key, _ in STEPS:
        for k in STEP_FACTORS[key]:
            cur[k] = f_to[k]
        now = evaluate(ctx, cur)["op_krw"]
        label, note = step_label(key, vs_baseline)
        out.append({"key": key, "label_ko": label, "krw": now - prev, **({"note_ko": note} if note else {})})
        prev = now
    return out


# ---------------------------------------------------------------------------------------------- run

def baseline_factors(decisions: dict) -> dict:
    """A mature month at the opening rating, the opening decisions, no season swing, no event."""
    return {"season": 1.0, "rating": s("rating_start"), "maturity": 1.0, "price_level": 1.0,
            "hours": decisions["hours"], "staff": decisions["staff_policy"], "marketing_krw": decisions["marketing_krw"],
            "dessert": decisions["dessert"], "rival": False, "viral": 1.0, "breakdown": False, "rent_mult": 1.0, "scn": {},
            "delivery": decisions.get("delivery", False), "delivery_mult": 1.0,
            "hours_t": _dec_hours(decisions), "menu": {**MENU_DEFAULT, **(decisions.get("menu") or {})}}


def _dec_hours(d: dict):
    return [int(d["open_hour"]), int(d["close_hour"])] if d.get("open_hour") is not None and d.get("close_hour") is not None else None


def _loan(principal: int, rate: float | None = None) -> dict:
    # lab:finance rate: 학습자가 고른 은행·정책자금 금리 (없으면 params의 loan_rate)
    picked = rate is not None
    rate = float(rate) if picked else s("loan_rate")
    r, n = rate / 12, s("loan_term_months")
    pay = (round(principal * r / (1 - (1 + r) ** -n)) if r > 0 else round(principal / n)) if principal > 0 else 0
    return {"principal_krw": principal, "rate": rate, "term_months": n, "monthly_payment_krw": pay,
            "grade": "가정" if picked else g("season", "loan_rate"),
            "note_ko": (f"연 {rate * 100:.2f}% (고른 금리) 원리금 균등 {n}개월, 거치 없음" if picked else
                        f"연 {s('loan_rate') * 100:.1f}% 원리금 균등 {n}개월, 거치 없음 (가정, 정책자금 금리는 GAP)")}


def _vat_refund(p: dict) -> int:
    return next((x["subtotal_krw"] for x in p["capex"]["lines"] if x["item_ko"].startswith("부가세")), 0)


def start(body: dict) -> dict:
    """New run from the step 2 store config + own_capital_krw + seed (+ start_month, extra_loan_krw; None = the default
    운전자금 that tops starting cash up to `working_capital_months` of monthly fixed costs)."""
    body = dict(body)
    seed = int(body.pop("seed", 0))
    start_month = int(body.pop("start_month", None) or s("start_month"))
    extra = body.pop("extra_loan_krw", None)
    loan_rate = body.pop("loan_rate", None)                       # lab:finance
    rc = rent_card.normalize(body.pop("rent_card", None))         # lab:finance 월세 카드 할부
    ctx = _context(body)
    p, cfg = ctx["preview"], ctx["cfg"]
    capex = p["capex"]["total_krw"]
    # one funding rule with the build screen (preview["funding"]) and 이지 모드: CAPEX gap + default 운전자금
    fund = m.funding(capex, cfg["own_capital_krw"], p["monthly_fixed"]["total_krw"], extra)
    extra, reserve, wc_note = fund["extra_loan_krw"], fund["working_capital_target_krw"], fund["working_capital_note_ko"]
    loan_amt, cash = fund["loan_krw"], fund["cash_krw"]
    decisions = {"price_change_pct": 0.0, "hours": "standard", "staff_policy": "standard", "marketing_krw": 0,
                 "dessert": True, "delivery": False}
    base = evaluate(ctx, baseline_factors(decisions))
    return {
        "cfg": cfg, "seed": seed, "start_month": start_month, "months_total": s("months"),
        "start": {"own_capital_krw": cfg["own_capital_krw"], "capex_krw": capex, "loan_krw": loan_amt,
                  "extra_loan_krw": extra, "working_capital_target_krw": reserve, "working_capital_note_ko": wc_note,
                  "cash_krw": cash, "vat_refund_krw": _vat_refund(p),
                  "vat_refund_month": s("vat_refund_month")},
        "loan": _loan(loan_amt, loan_rate), "loan_balance": loan_amt,  # lab:finance loan_rate
        **({"rent_card": rc, "rent_card_queue": []} if rc else {}),  # lab:finance
        "state": {"cash": cash, "rating": s("rating_start"), "regulars_idx": 0.0, "price_level": 1.0,
                  "rival": False, "rent_mult": 1.0, "viral_last": False, "negative_months": 0, "closed": False,
                  "decisions": decisions},
        "baseline": {**_month_summary(base), "preview_revenue_krw": p["rough_month"]["revenue_krw"],
                     "preview_op_krw": p["rough_month"]["op_krw"], "grade": "L",
                     "note_ko": "기준 달 = 단골이 다 쌓인 평범한 달 (계절 1.0, 사건 없음, 처음 결정). 디저트 폐기와 "
                                "준비 인건비, 줄 보고 돌아가는 손님이 들어가서 2단계 한 달 어림과 다를 수 있음"},
        "baseline_factors": baseline_factors(decisions),
        "months": [], "factors": [],
    }


def options() -> dict:
    """What the month screen may send, with Korean labels (all ranges from params.yaml)."""
    hrs = s("hours")
    return {
        "price_change_pct": {"min": s("price_change_pct_range")[0], "max": s("price_change_pct_range")[1],
                             "level_min": s("price_level_range")[0], "level_max": s("price_level_range")[1]},
        "hours": [{"key": k, "label_ko": f"{HOURS_KO[k]} ({o}~{c}시)", "open_hour": o, "close_hour": c}
                  for k, (o, c) in hrs.items()],
        "staff_policy": [{"key": k, "label_ko": STAFF_KO[k]} for k in s("staff_utilization")],
        "marketing_krw": {"min": 0, "max": s("marketing_max_krw")},
        "dessert": [True, False],
        "delivery": [False, True],
    }


def assumptions() -> list[dict]:
    """Every season parameter with its grade and source, for the 근거 panel."""
    return [{"key": k, "value": x["value"], "grade": x["grade"], "source": x.get("source"), "note_ko": x.get("note")}
            for k, x in load_params()["season"].items()]


def public_start(run: dict) -> dict:
    return {"season_id": run.get("id"), "seed": run["seed"], "start_month": run["start_month"],
            "months_total": run["months_total"], "start": run["start"], "loan": run["loan"],
            "baseline": run["baseline"], "decisions": run["state"]["decisions"], "options": options(),
            "status": "open", "assumptions": assumptions(),
            **({"rent_card": run["rent_card"]} if run.get("rent_card") else {})}  # lab:finance


def _month_summary(e: dict) -> dict:
    return {k: e[k] for k in ("revenue_krw", "op_krw", "customers", "walkaways")}


def _maturity(idx: float) -> float:
    return s("launch_share") + (1 - s("launch_share")) * idx


def _calendar(run: dict, i: int) -> int:
    return (run["start_month"] - 1 + i) % 12 + 1


def _events(run: dict, ctx: dict, i: int, lift_ratio: float) -> list[dict]:
    """Draw month i's events: one uniform per (seed, month, event), independent of decisions."""
    st, seed = run["state"], run["seed"]

    def u(key):
        return random.Random(f"cafe:{seed}:{i}:{key}").random()
    out = []
    p_rival = 1 - math.exp(-ctx["opens_per_year"] * s("rival_nearby_share") / 12)
    if not st["rival"] and u("rival") < p_rival:
        out.append({"key": "rival", "label_ko": "근처에 경쟁 카페 개업", "p": round(p_rival, 3),
                    "effect_ko": f"손님 {round((1 - s('rival_demand_mult')) * 100)}% 감소, 가격에 더 민감해짐 (시즌 끝까지)",
                    "grade": "L", "source": "상권 연간 개업 수 (H) x 바로 옆 비율 (가정)"})
    if st["rent_mult"] == 1.0 and u("rent_hike") < s("rent_hike_p"):
        out.append({"key": "rent_hike", "label_ko": "임대료 인상", "p": s("rent_hike_p"),
                    "effect_ko": f"임대료 {s('rent_hike_pct') * 100:.0f}% 인상 (법정 상한)",
                    "grade": g("season", "rent_hike_pct"), "source": load_params()["season"]["rent_hike_pct"]["source"]})
    if u("breakdown") < s("breakdown_p"):
        out.append({"key": "breakdown", "label_ko": "설비 고장", "p": s("breakdown_p"),
                    "effect_ko": f"수리비 {won(s('breakdown_repair_krw'))}, {s('breakdown_down_days')}일 휴업",
                    "grade": "가정", "source": "none"})
    p_viral = s("viral_p") * (1 + s("viral_marketing_boost") * lift_ratio)
    if u("viral") < p_viral:
        out.append({"key": "viral", "label_ko": "SNS 게시물 화제", "p": round(p_viral, 3),
                    "effect_ko": f"이번 달 손님 {round((s('viral_demand_mult') - 1) * 100)}% 증가, 다음 달 일부 남음",
                    "grade": "가정", "source": "none"})
    return out


def apply_decisions(prev: dict, body: dict) -> dict:
    """Omitted fields keep last month's choice; price_change_pct is a one-time change (0 when omitted)."""
    d = {**prev, "price_change_pct": 0.0}
    for k in DECISION_KEYS:
        if body.get(k) is not None:
            d[k] = body[k]
    lo, hi = s("price_change_pct_range")
    d["price_change_pct"] = _clamp(float(d["price_change_pct"]), lo, hi)
    d["marketing_krw"] = int(_clamp(int(d["marketing_krw"]), 0, s("marketing_max_krw")))
    if d["hours"] not in s("hours") or d["staff_policy"] not in s("staff_utilization"):
        raise ValueError("unknown hours or staff_policy")
    d["dessert"] = bool(d["dessert"])
    d["delivery"] = bool(d.get("delivery", False))
    if d.get("open_hour") is not None or d.get("close_hour") is not None:
        o, c = int(d.get("open_hour") or s("hours")[d["hours"]][0]), int(d.get("close_hour") or s("hours")[d["hours"]][1])
        lo, hi = s("custom_hours_range")
        o, c = int(_clamp(o, lo, hi - 4)), int(_clamp(c, o + 4, hi))
        d["open_hour"], d["close_hour"] = o, c
    mn = {**MENU_DEFAULT, **(d.get("menu") or {})}
    if mn["bean"] not in ("standard", "specialty"):
        raise ValueError("unknown bean")
    mn["seasonal"], mn["loyalty"] = bool(mn["seasonal"]), bool(mn["loyalty"])
    mn["dessert_price_pct"] = _clamp(float(mn["dessert_price_pct"]), -30, 50)
    mn["takeout_disc"] = _clamp(float(mn["takeout_disc"]), 0, 0.3)
    mn["delivery_share"] = None if mn["delivery_share"] is None else _clamp(float(mn["delivery_share"]), 0.05, 0.6)
    mn["free_dlvy_krw"] = int(_clamp(int(mn["free_dlvy_krw"]), 0, 3000))
    d["menu"] = mn
    return d


def play_month(run: dict, body: dict | None = None) -> tuple[dict, dict]:
    """Play the next month with the owner's decisions; returns (new run, month record)."""
    st0 = run["state"]
    if st0["closed"] or len(run["months"]) >= run["months_total"]:
        raise SeasonOver("season is over (closed or all months played)")
    run = {**run, "state": dict(st0), "months": list(run["months"]), "factors": list(run["factors"])}
    st = run["state"]
    ctx = _context(run["cfg"])
    i = len(run["months"])
    dec = apply_decisions(st["decisions"], body or {})
    cal = _calendar(run, i)
    scn = clean_scenario((body or {}).get("scenario"), cal)
    lo, hi = s("price_level_range")
    st["price_level"] = _clamp(st["price_level"] * (1 + dec["price_change_pct"] / 100), lo, hi)
    lift_ratio = 1 - math.exp(-dec["marketing_krw"] / s("marketing_half_krw"))
    events = _events(run, ctx, i, lift_ratio)
    keys = {e["key"] for e in events}
    st["rival"] = st["rival"] or "rival" in keys
    if "rent_hike" in keys:
        st["rent_mult"] = 1 + s("rent_hike_pct")
    viral = (s("viral_demand_mult") if "viral" in keys else 1.0) * (s("viral_carry_mult") if st["viral_last"] else 1.0)
    f = {"season": s("seasonality_by_quarter")[(cal - 1) // 3 + 1] * s("month_in_quarter")[cal], "rating": st["rating"],
         "maturity": _maturity(st["regulars_idx"]), "price_level": st["price_level"], "hours": dec["hours"],
         "staff": dec["staff_policy"], "marketing_krw": dec["marketing_krw"], "dessert": dec["dessert"],
         "rival": st["rival"], "viral": viral, "breakdown": "breakdown" in keys, "rent_mult": st["rent_mult"],
         "scn": scn, "ingredient": s("ingredient_index")[cal], "delivery": dec.get("delivery", False),
         "delivery_mult": delivery_area_mult(run["cfg"]["district"]) * s("delivery_month_index")[cal],
         "hours_t": _dec_hours(dec), "menu": dec["menu"]}
    e = evaluate(ctx, f)

    # cash: OP + depreciation (non-cash) - loan interest and principal + VAT refund
    bal, r = run["loan_balance"], run["loan"]["rate"] / 12  # lab:finance (기본값은 params loan_rate 그대로)
    interest = round(bal * r)
    principal = min(bal, run["loan"]["monthly_payment_krw"] - interest) if bal > 0 else 0
    run["loan_balance"] = bal - principal
    vat = run["start"]["vat_refund_krw"] if i + 1 == s("vat_refund_month") else 0
    cash_start = st["cash"]
    # lab:cost — 사장 가상 급여 is in OP (survey basis) but not a cash outflow here: added back like depreciation, so the
    # cash path (and closure) is exactly what it was before the OP basis change
    owner_back = next((x["krw"] for x in e["cost_lines"] if x["key"] == "owner"), 0)
    st["cash"] = cash_start + e["op_krw"] + owner_back + e["depreciation_krw"] - interest - principal + vat
    rent_now = next((x["krw"] for x in e["cost_lines"] if x["key"] == "rent"), 0)  # lab:finance 월세 카드 할부
    rc = rent_card.step(run.get("rent_card_queue"), run.get("rent_card"), rent_now)  # lab:finance
    if rc is not None:  # lab:finance
        st["cash"] = round(st["cash"] + rc["cash_delta"])
        run["rent_card_queue"] = rc["queue"]
    st["negative_months"] = st["negative_months"] + 1 if st["cash"] < 0 else 0
    st["closed"] = st["negative_months"] >= s("closure_negative_months")

    # reputation drift from this month's service
    sat = (s("satisfaction_walkaway") * e["walkaway_share"] + s("satisfaction_price") * (st["price_level"] - 1)
           + _scn_effects(scn)["satisfaction"] + s("satisfaction_staff")[dec["staff_policy"]] + (s("satisfaction_dessert") if dec["dessert"] else 0)
           + (s("satisfaction_specialty") if dec["menu"]["bean"] == "specialty" else 0) + (s("satisfaction_seasonal") if dec["menu"]["seasonal"] else 0)
           + (s("satisfaction_breakdown") if f["breakdown"] else 0))
    rating0, idx0 = st["rating"], st["regulars_idx"]
    st["rating"] = rating0 + s("rating_speed") * (_clamp(s("rating_start") + s("rating_per_satisfaction") * sat,
                                                         *s("rating_range")) - rating0)
    speed = s("regulars_speed") + s("regulars_speed_marketing") * lift_ratio
    target = _clamp(1 + s("regulars_target_per_satisfaction") * sat, *s("regulars_target_range"))
    st["regulars_idx"] = idx0 + speed * (target - idx0)
    st["viral_last"] = "viral" in keys
    st["decisions"] = {**dec, "price_change_pct": 0.0}

    prev_f = run["factors"][-1] if run["factors"] else run["baseline_factors"]
    prev_op = run["months"][-1]["kpi"]["op_krw"] if run["months"] else run["baseline"]["op_krw"]
    steps = waterfall(ctx, prev_f, f, vs_baseline=not run["months"])
    vs_base = waterfall(ctx, run["baseline_factors"], f, vs_baseline=True)
    regulars = lambda idx: round(idx * ctx["avg_day"] * DAYS * s("regular_share") / s("regular_visits_per_month"))  # noqa: E731
    month = {
        "month": i + 1, "calendar_month": cal, "months_total": run["months_total"],
        "status": "closed" if st["closed"] else ("finished" if i + 1 == run["months_total"] else "open"),
        "decisions": {**dec, "price_level": round(st["price_level"], 4),
                      "open_hour": _hrs({"hours": dec["hours"], "hours_t": _dec_hours(dec)})[0], "close_hour": _hrs({"hours": dec["hours"], "hours_t": _dec_hours(dec)})[1],
                      "scenario": scn},
        "scenario_ko": [{"title": p["title"], "choice": o["label"]} for p in scenario_points(cal) for o in p["options"]
                        if o["id"] == scn[p["id"]]],
        "month_line": cafe_month_line(e, ctx, o_shares()),   # lab:cost — SeasonSummary.MonthLine (opex_detail)
        "kpi": {"revenue_krw": e["revenue_krw"], "op_krw": e["op_krw"],
                "op_margin": round(e["op_krw"] / e["revenue_krw"], 3) if e["revenue_krw"] else 0.0,
                "cash_krw": st["cash"], "customers": e["customers"], "walkaways": e["walkaways"],
                "walkaway_share": round(e["walkaway_share"], 4), "ticket_krw": e["ticket_krw"],
                "rating": round(st["rating"], 2), "rating_delta": round(st["rating"] - rating0, 2),
                "regulars": regulars(st["regulars_idx"]),
                "regulars_delta": regulars(st["regulars_idx"]) - regulars(idx0),
                "loan_payment_krw": interest + principal},
        "kpi_grades": {"revenue_krw": "L", "op_krw": "L", "cash_krw": "L", "customers": "L", "walkaways": "L",
                       "rating": "가정", "regulars": "가정", "loan_payment_krw": "가정"},
        "pnl": {"revenue_krw": e["revenue_krw"], "dessert_revenue_krw": e["dessert_revenue_krw"],
                "lines": e["cost_lines"], "op_before_depreciation_krw": e["op_before_depreciation_krw"],
                "depreciation_krw": e["depreciation_krw"], "op_krw": e["op_krw"],
                "grade": weakest(*(x["grade"] for x in e["cost_lines"]))},
        "cash": {"start_krw": cash_start, "op_krw": e["op_krw"], "depreciation_addback_krw": e["depreciation_krw"],
                 "owner_pay_addback_krw": owner_back,   # lab:cost
                 "loan_interest_krw": interest, "loan_principal_krw": principal, "vat_refund_krw": vat,
                 "end_krw": st["cash"], "loan_balance_krw": run["loan_balance"],
                 "negative_months": st["negative_months"], "grade": "L",
                 **({"rent_card": {k: round(rc[k]) if k in ("paid", "charged", "fee", "balance", "cash_delta") else rc[k]
                                   for k in ("paid", "charged", "fee", "balance", "months", "fee_rate", "cash_delta")}}
                    if rc is not None else {})},  # lab:finance
        "drivers": {"season_index": f["season"], "maturity": round(f["maturity"], 3),
                    "rating_mult": round(e["mult"]["rating"], 3), "price_mult": round(e["mult"]["price"], 3),
                    "hours_coverage": round(e["mult"]["hours"], 3), "marketing_lift": round(e["marketing_lift"], 3),
                    "rival_mult": e["mult"]["rival"], "viral_mult": round(viral, 3),
                    "satisfaction": round(sat, 3), "bottleneck": e["binding"],
                    "bottleneck_label_ko": m.LABELS[e["binding"]], "peak_util": round(min(e["peak_util"], 99.0), 2),
                    "grade": "L"},
        "events": events,
        "waterfall": {"vs": "prev_month" if run["months"] else "baseline", "from_op_krw": prev_op,
                      "to_op_krw": e["op_krw"], "steps": steps, "grade": "L",
                      "note_ko": "요인을 " + ", ".join(lbl for _, lbl in STEPS) + " 순서로 하나씩 바꿔 계산"},
        "owner_note_ko": "",
        "closure": {"closed": st["closed"],
                    "reason_ko": f"현금이 {s('closure_negative_months')}달 연속 마이너스라 폐업" if st["closed"] else None},
    }
    month["owner_note_ko"] = _note(month, steps)
    run["months"].append({**month, "_vs_baseline": vs_base})
    run["factors"].append(f)
    return run, month


def scenario_preview(run: dict, body: dict | None = None) -> dict:
    """Before the month is played: this month's events (they do not depend on the scenario choices) and the decision
    points with their options, for the screen that asks the owner how to respond. Changes nothing."""
    st = run["state"]
    if st["closed"] or len(run["months"]) >= run["months_total"]:
        raise SeasonOver("season is over (closed or all months played)")
    ctx = _context(run["cfg"])
    dec = apply_decisions(st["decisions"], body or {})
    lift_ratio = 1 - math.exp(-dec["marketing_krw"] / s("marketing_half_krw"))
    events = _events(run, ctx, len(run["months"]), lift_ratio)
    cal = _calendar(run, len(run["months"]))
    pts = [{"id": p["id"], "clock": p["clock"], "title": p["title"], "prompt": p["prompt"], "note": p["note"],
            "default": p["default"],
            "options": [{"id": o["id"], "label": o["label"], "hint": o["hint"], "downside": o["downside"]} for o in p["options"]]}
           for p in scenario_points(cal)]
    return {"month": len(run["months"]) + 1, "events": events, "points": pts, "grade": "가정",
            "note_ko": "대응이 그달 계산에 미치는 크기는 모두 가정값"}


def replay(body: dict, decisions: list[dict]) -> dict:
    """Rebuild a run from its start body and the decisions sent so far (deterministic, so this equals the stored run).
    Used by the stateless token API: a 12-month replay is a few hundred milliseconds at most."""
    run = start(body)
    for d in decisions:
        run, _ = play_month(run, d)
    return run


def _note(mo: dict, steps: list[dict]) -> str:
    """One line in the owner's voice: closure, cash, queue, then the biggest reason profit moved."""
    k = mo["kpi"]
    if mo["closure"]["closed"]:
        return "현금이 두 달 연속 바닥이라 가게 문을 닫기로 했어요"
    if k["cash_krw"] < 0:
        return f"통장이 {won(k['cash_krw'])}, 다음 달도 마이너스면 버틸 수 없어요"
    if k["walkaway_share"] >= 0.05:
        return (f"줄이 길어서 손님 {k['walkaways']:,}명이 그냥 돌아갔어요, "
                f"{mo['drivers']['bottleneck_label_ko']} 쪽이 모자라요")
    ev = mo["events"]
    if ev:
        return f"이번 달은 {ev[0]['label_ko']} 때문에 정신없었어요"
    top = max(steps, key=lambda x: abs(x["krw"]))
    if mo["waterfall"]["vs"] == "baseline":   # month 1 compares with a settled store, not with a last month
        gap = mo["waterfall"]["to_op_krw"] - mo["waterfall"]["from_op_krw"]
        more = "많아요" if gap > 0 else "적어요"
        return f"첫 달이라 자리 잡은 가게보다 영업이익이 {won(abs(gap))} {more}, 가장 큰 이유는 {top['label_ko']}"
    if abs(top["krw"]) < 100_000:
        return f"지난달과 비슷했어요, 영업이익 {won(k['op_krw'])}"
    word = "늘었어요" if top["krw"] > 0 else "줄었어요"
    return f"{top['label_ko']} 영향으로 영업이익이 {won(abs(top['krw']))} {word}"


def public_month(rec: dict) -> dict:
    return {k: x for k, x in rec.items() if not k.startswith("_")}


def report(run: dict) -> dict:
    """Season summary: survival, cumulative OP, best and worst month, what drove it (vs the baseline month)."""
    months = run["months"]
    played = len(months)
    closed = run["state"]["closed"]
    summary = {"season_id": run.get("id"), "months_played": played, "months_total": run["months_total"],
               "status": "closed" if closed else ("finished" if played >= run["months_total"] else "open"),
               "survived": not closed, "closed_month": months[-1]["month"] if closed else None}
    if not played:
        return {**summary, "cumulative_op_krw": 0, "cumulative_revenue_krw": 0, "end_cash_krw": run["state"]["cash"],
                "best_month": None, "worst_month": None, "drivers": [], "events": [], "months": [],
                "summary_ko": "아직 진행한 달이 없어요", "baseline": run["baseline"], "grade": "L"}
    ops = [x["kpi"]["op_krw"] for x in months]
    best = max(months, key=lambda x: x["kpi"]["op_krw"])
    worst = min(months, key=lambda x: x["kpi"]["op_krw"])
    agg = {key: 0 for key, _ in STEPS}
    for x in months:
        for st in x["_vs_baseline"]:
            agg[st["key"]] += st["krw"]
    drivers = sorted(({"key": k, "label_ko": step_label(k, True)[0], "krw": x,
                       **({"note_ko": step_label(k, True)[1]} if step_label(k, True)[1] else {})}
                      for k, x in agg.items() if x),
                     key=lambda d: -abs(d["krw"]))
    base_total = run["baseline"]["op_krw"] * played
    cum = sum(ops)
    top = drivers[:3]
    why = ", ".join(f"{d['label_ko']} {'+' if d['krw'] > 0 else '-'}{won(abs(d['krw']))}" for d in top) or "기준 달과 같음"
    fate = (f"{summary['closed_month']}개월째 폐업" if closed else
            (f"{played}개월 버팀" if played >= run["months_total"] else f"{played}개월 진행 중"))
    return {
        **summary,
        "cumulative_op_krw": cum, "cumulative_revenue_krw": sum(x["kpi"]["revenue_krw"] for x in months),
        "end_cash_krw": run["state"]["cash"],
        "best_month": {"month": best["month"], "calendar_month": best["calendar_month"], "op_krw": best["kpi"]["op_krw"]},
        "worst_month": {"month": worst["month"], "calendar_month": worst["calendar_month"],
                        "op_krw": worst["kpi"]["op_krw"]},
        "baseline": run["baseline"], "baseline_cumulative_op_krw": base_total,
        "drivers": drivers,
        "events": [{"month": x["month"], **ev} for x in months for ev in x["events"]],
        "months": [{"month": x["month"], "calendar_month": x["calendar_month"], **{k: x["kpi"][k] for k in (
            "revenue_krw", "op_krw", "cash_krw", "customers", "walkaways", "rating", "regulars")}} for x in months],
        "summary_ko": (f"{fate}, 누적 영업이익 {won(cum)} (기준 달 x {played} = {won(base_total)}), "
                       f"차이를 만든 것: {why}"),
        "grade": "L",
    }
