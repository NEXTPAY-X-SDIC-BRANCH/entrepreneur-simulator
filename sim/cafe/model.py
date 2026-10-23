"""Store-setup preview: layout + peak-hour capacity + staff + CAPEX + monthly fixed cost + a rough month.

Pure and deterministic: same cfg -> same dict. Every numeric block carries a grade (H/M/L, 가정 on single lines);
the inputs and their grades live in research/cafe/params.yaml and districts.yaml.
"""
from __future__ import annotations

import math

from . import layout as lay
from .ko import won
from .params import g, load_districts, load_params, load_seoul, v, weakest

DEFAULTS = {"own_capital_krw": 80_000_000, "daily_customers": None, "peak_day": None, "staff_peak": None}
DAYS_PER_MONTH_DATA = 91 / 3   # the 상권 quarter is 91 days; per-month sales = quarter ÷ 3
MAX_PYEONG = 40


def districts() -> list[dict]:
    out = []
    meta, dist = load_params()["district_meta"], load_districts()
    for code, m in meta.items():
        d = dist[code]
        out.append({
            "code": code, "name_ko": m["name_ko"], "trdar_name": d["trdar_name"], "context_ko": m["context_ko"],
            "rent_per_pyeong_krw": m["rent_per_pyeong_krw"]["value"],
            "sales_per_store_month_krw": d["sales_per_store_month_krw"]["value"],
            "tx_per_store_day": d["tx_per_store_day"]["value"], "ticket_krw": d["ticket_krw"]["value"],
            "stores": m["stores"]["value"], "peak_band": d["peak_band"], "grade": "H",
        })
    return out


# ---------------------------------------------------------------------------------------------- capacity

def _day_factor(code: str, peak_day: str) -> float:
    return load_districts()[code][f"{peak_day}_day_factor"]["value"]


def demand_index(code: str) -> float:
    """상권 sales per cafe ÷ Seoul sales per cafe, same file and quarter, so the units cancel (H)."""
    return load_districts()[code]["sales_per_store_month_krw"]["value"] / load_seoul()["sales_per_store_month_krw"]["value"]


def anchor_month_krw(code: str) -> float:
    """Demand anchor (Keonhee 2026-10-14): the average 비알코올 음료점's sales (농경연 2024, national, franchise
    included, M) scaled to this 상권 by the demand index (H). Grade M."""
    return v("opex", "industry_avg_sales_krw") / 12 * demand_index(code)


def default_daily_customers(code: str, peak_day: str) -> int:
    """Orders on a typical weekday/weekend day: the anchor month ÷ 상권 ticket ÷ 91/3 days (the month every revenue
    line here uses), x the day factor. At the data default the rough month's revenue is the anchor month."""
    d = load_districts()[code]
    avg_day = anchor_month_krw(code) / d["ticket_krw"]["value"] / DAYS_PER_MONTH_DATA
    return round(avg_day * _day_factor(code, peak_day))


def _demand(cfg: dict) -> dict:
    """daily_customers = orders (card transactions) on the chosen peak day; data default unless the user sets it."""
    code, peak_day = cfg["district"], cfg["peak_day"]
    d = load_districts()[code]
    default = default_daily_customers(code, peak_day)
    user = cfg.get("daily_customers") is not None
    daily = cfg["daily_customers"] if user else default
    # the busiest opening hour's share, renormalized over the opening hours like the schedule (orders outside 10~22
    # move into them); the raw 24h peak_hour_tx_share understated the peak by the hours' coverage (8~18%)
    tx_peak = daily * max(_hour_shares(code).values()) * v("demand", "peak_surge")
    cups = tx_peak * v("demand", "cups_per_tx")
    grade = "가정" if user else weakest("H", g("opex", "industry_avg_sales_krw"))
    return {"daily_customers": daily, "default_daily_customers": default, "source": "user" if user else "data",
            "peak_day": peak_day, "avg_day_customers": daily / _day_factor(code, peak_day),
            "tx_peak": tx_peak, "cups": cups,
            "grade": grade, "rollup": weakest(grade, g("demand", "cups_per_tx"), g("demand", "peak_surge"))}


def _stations(cfg: dict, seats_total: int) -> dict:
    """How many people the setup can put to work at once: baristas by groups, a cashier per POS, floor people by
    seats (one per `floor_staff_seat_threshold` seats)."""
    baristas = v("capacity", "baristas_by_groups")[cfg["espresso_groups"]]
    floor = math.ceil(seats_total / v("capacity", "floor_staff_seat_threshold")) if seats_total else 0
    return {"max": baristas + cfg["pos"] + floor, "baristas": baristas, "cashiers": cfg["pos"], "floor": floor}


BAND_HOURS = {"00~06": range(0, 6), "06~11": range(6, 11), "11~14": range(11, 14), "14~17": range(14, 17),
              "17~21": range(17, 21), "21~24": range(21, 24)}


def raw_hour_shares(code: str) -> dict[int, float]:
    """Share of the 상권's day of card transactions per clock hour 0~23: band share ÷ band hours."""
    bands = load_districts()[code]["band_tx_share"]["value"]
    return {h: share / len(BAND_HOURS[band]) for band, share in bands.items() for h in BAND_HOURS[band]}


def _hour_shares(code: str, hours: tuple[int, int] | None = None) -> dict[int, float]:
    """Share of the day's orders per opening hour: 상권 band share ÷ band hours, renormalized over opening hours
    (default the params opening hours; the month sim passes the owner's hours)."""
    per_hour = raw_hour_shares(code)
    open_h, close_h = hours or (v("opex", "open_hour"), v("opex", "close_hour"))
    total = sum(per_hour[h] for h in range(open_h, close_h))
    return {h: per_hour[h] / total for h in range(open_h, close_h)}


# ---------------------------------------------------------------------------------------------- crew (people)

ROLES_KO = {"barista": "바리스타", "cashier": "계산", "floor": "홀"}


def _kiosk_cph(cfg: dict) -> float:
    return cfg["kiosks"] * 3600 / v("capacity", "kiosk_order_s") * v("demand", "cups_per_tx")


def _lane_cph() -> float:
    return 3600 / v("capacity", "cashier_order_s") * v("demand", "cups_per_tx")


def role_order(cfg: dict, n: int, demand: float, seats_total: int) -> list[str]:
    """Roles for n people (사장님 included), deterministic priority: one barista per espresso machine; a cashier when
    the kiosks cannot take the peak's orders; one floor person when there are seats; the remaining baristas the
    machines can use; a cashier at the POS if there is none yet (kiosks cover ordering; with seats this is the person
    after baristas + 1 floor); more cashiers while ordering still falls short; the remaining floor slots; anyone else
    floor.
    The list for n + 1 people is the list for n plus one role, so adding a person never lowers a capacity."""
    machines = len(lay.machines_for(cfg["espresso_groups"]))
    max_b = v("capacity", "baristas_by_groups")[cfg["espresso_groups"]]
    floor_slots = math.ceil(seats_total / v("capacity", "floor_staff_seat_threshold")) if seats_total else 0
    kiosk, lane = _kiosk_cph(cfg), _lane_cph()
    seq = ["barista"] * machines
    short = cfg["pos"] > 0 and kiosk < demand
    cashiers = 1 if short else 0
    seq += ["cashier"] * cashiers
    seq += ["floor"] * min(1, floor_slots)
    seq += ["barista"] * (max_b - machines)
    if cfg["pos"] and not cashiers:   # kiosks cover ordering: the POS still gets a person before any extra floor
        cashiers = 1
        seq.append("cashier")
    while short and cashiers < cfg["pos"] and kiosk + cashiers * lane < demand:
        cashiers += 1
        seq.append("cashier")
    seq += ["floor"] * max(0, floor_slots - 1)
    return (seq + ["floor"] * max(0, n - len(seq)))[:n]


def crew_capacity(cfg: dict, roles: list[str], demand: float, seats_total: int) -> dict:
    """Drinks/h the people can deliver at each station. Espresso = min(machine, baristas x barista rate); ordering =
    kiosks + POS lanes with a cashier (no cashier: a barista takes orders at a penalty and pulls fewer shots);
    seating loses `dirty_table_block_share` of its turnover where no floor person clears tables."""
    b, c, f = (roles.count(r) for r in ("barista", "cashier", "floor"))
    kiosk, lane = _kiosk_cph(cfg), _lane_cph()
    on_pos = c == 0 and cfg["pos"] > 0 and kiosk < demand and b > 0
    b_eff = b - (1 - v("capacity", "barista_on_pos_drink_share")) if on_pos else b
    machine = v("capacity", "machine_cph_by_groups")[cfg["espresso_groups"]]
    espresso = min(machine, b_eff * v("capacity", "barista_cph"))
    ordering = kiosk + min(c, cfg["pos"]) * lane + (lane * v("capacity", "barista_on_pos_order_factor") if on_pos else 0)
    seating = 0.0
    if seats_total:
        cover = min(1.0, f * v("capacity", "floor_staff_seat_threshold") / seats_total)
        seating = (seats_total / v("demand", "dwell_h") / v("demand", "dine_in_share") / v("demand", "persons_per_cup")
                   * (1 - v("capacity", "dirty_table_block_share") * (1 - cover)))
    return {"espresso": espresso, "ordering": ordering, "seating": seating, "on_pos": on_pos}


def _equipment_capacity(cfg: dict, seats_total: int, stations: dict) -> dict:
    """What the equipment allows with every station staffed (the step 2 numbers before people became an input)."""
    machine = v("capacity", "machine_cph_by_groups")[cfg["espresso_groups"]]
    espresso = min(machine, stations["baristas"] * v("capacity", "barista_cph"))
    ordering = _kiosk_cph(cfg) + cfg["pos"] * _lane_cph()
    seating = seats_total / v("demand", "dwell_h") / v("demand", "dine_in_share") / v("demand", "persons_per_cup")
    return {"espresso": espresso, "ordering": ordering, "seating": seating}


def crew_throughput(cfg: dict, n: int, demand: float, seats_total: int) -> float:
    cap = crew_capacity(cfg, role_order(cfg, n, demand, seats_total), demand, seats_total)
    return min(cap["espresso"], cap["ordering"], cap["seating"])


def people_to_cover(cfg: dict, demand: float, seats_total: int, equip_min: float) -> int:
    """Fewest people whose throughput reaches min(demand, what the equipment allows); the max if none does."""
    target = min(demand, equip_min) - 1e-9
    top = v("capacity", "staff_peak_range")[1]
    return next((n for n in range(1, top + 1) if crew_throughput(cfg, n, demand, seats_total) >= target), top)


def _schedule(cfg: dict, day_customers: float, crew: dict, hours: tuple[int, int] | None = None,
              util: float | None = None, cover: bool = True) -> list[dict]:
    """People per opening hour = max(1, workload need, people to cover the hour's drinks), capped at the crew size
    (staff_peak, 사장님 included). Workload (person-hours per hour) = drinks x surge ÷ barista rate + orders x support
    time (+ order taking when there is no kiosk), ÷ utilization, at most the stations the setup has. `short`: the hour
    wanted more people than the crew has. cover=False (step 3 lean staffing) skips the top-up to cover the drinks."""
    cups, surge = v("demand", "cups_per_tx"), v("demand", "peak_surge")
    util = util or v("opex", "staff_utilization")
    support = v("opex", "support_s_per_order")
    rows = []
    for h, share in _hour_shares(cfg["district"], hours).items():
        orders = day_customers * share
        work = orders * cups * surge / v("capacity", "barista_cph") + orders * support / 3600
        if cfg["kiosks"] == 0:
            work += orders * v("capacity", "cashier_order_s") / 3600
        need = min(max(1, math.ceil(work / util - 1e-9)), crew["stations"])
        drinks = orders * cups * surge
        want = max(need, people_to_cover(cfg, drinks, crew["seats"], crew["equip_min"])) if cover else need
        rows.append({"hour": h, "orders": round(orders, 1), "staff": min(want, crew["peak"]), "need": want,
                     "short": want > crew["peak"]})
    return rows


def _owner_paid_split(rows: list[dict]) -> tuple[int, int]:
    """Owner takes one slot for owner_hours_per_day, busiest hours first; returns (staff-hours, paid staff-hours)."""
    total = sum(r["staff"] for r in rows)
    owner = min(v("opex", "owner_hours_per_day"), len(rows))
    return total, total - owner


def _crew(cfg: dict, dem: dict, seats_total: int, stations: dict, equip: dict) -> dict:
    """Peak crew: the user's staff_peak or the recommended one (the busiest hour of the peak day's schedule, and enough
    people for the peak's drinks), its roles and what it can deliver."""
    equip_min = min(equip.values())
    ctx = {"stations": stations["max"], "seats": seats_total, "equip_min": equip_min,
           "peak": v("capacity", "staff_peak_range")[1]}
    day_customers = dem["avg_day_customers"] * _day_factor(cfg["district"], dem["peak_day"])
    rows = _schedule(cfg, day_customers, ctx)
    rec = max(max(r["staff"] for r in rows), people_to_cover(cfg, dem["cups"], seats_total, equip_min))
    user = cfg.get("staff_peak")
    peak = user if user is not None else rec
    roles = role_order(cfg, peak, dem["cups"], seats_total)
    cap = crew_capacity(cfg, roles, dem["cups"], seats_total)
    return {**ctx, "peak": peak, "recommended": rec, "user": user, "source": "user" if user is not None else "recommended",
            "roles": roles, "on_pos": cap.pop("on_pos"), "cap": cap,
            "cover_peak": people_to_cover(cfg, dem["cups"], seats_total, equip_min)}


LABELS = {"espresso": "에스프레소 추출", "ordering": "주문 받기", "seating": "좌석", "staff": "인력"}


def _note(ratio: float) -> str:
    if ratio < 1:
        return f"피크 수요의 {ratio * 100:.0f}%만 처리, 손님이 기다리거나 돌아감"
    if ratio < 1.5:
        return f"피크 수요의 {ratio:.1f}배, 여유가 거의 없음"
    return f"피크 수요의 {ratio:.1f}배, 여유 있음"


def _bottlenecks(equip: dict, crew: dict, demand: float) -> list[dict]:
    """espresso / ordering / seating at what the equipment allows; `staff` = what the peak crew delivers. Staff sorts
    first only when the crew loses sales the equipment would have served; otherwise it goes last (people are added as
    demand grows, so the setup decides)."""
    rows = []
    for key in ("espresso", "ordering", "seating"):
        ratio = equip[key] / demand if demand > 0 else math.inf
        rows.append({"key": key, "label_ko": LABELS[key], "ratio": round(ratio, 2), "note_ko": _note(ratio)})
    crew_cph = min(crew["cap"].values())
    ratio = crew_cph / demand if demand > 0 else math.inf
    binding = crew_cph < min(demand, min(equip.values())) - 1e-6
    note = _note(ratio) + f", 피크 인원 {crew['peak']}명 (사장님 포함)"
    rows.append({"key": "staff", "label_ko": LABELS["staff"], "ratio": round(ratio, 2), "note_ko": note})
    rows.sort(key=lambda r: (r["ratio"] if (r["key"] != "staff" or binding) else math.inf, r["key"]))
    return rows


# ---------------------------------------------------------------------------------------------- money

def _hourly_cost() -> float:
    return v("opex", "min_wage") * (1 + v("opex", "employer_insurance")) * v("opex", "weekly_holiday_factor")


def _labor(cfg: dict, dem: dict, crew: dict) -> dict:
    """Monthly paid hours from the weekend and weekday schedules (8 + 20 of 28 days), owner's slot excluded."""
    code, days = cfg["district"], v("opex", "days_per_month")
    n_weekend = round(days * 2 / 7)
    out = {}
    for day, n in (("weekend", n_weekend), ("weekday", days - n_weekend)):
        rows = _schedule(cfg, dem["avg_day_customers"] * _day_factor(code, day), crew)
        total, paid = _owner_paid_split(rows)
        out[day] = {"rows": rows, "days": n, "staff_hours": total, "paid_hours": paid}
    paid_month = sum(x["paid_hours"] * x["days"] for x in out.values())
    out["paid_hours_month"] = round(paid_month, 1)   # owner_hours_per_day can be fractional (9.3)
    out["labor_krw"] = round(paid_month * _hourly_cost())
    owner_h = min(v("opex", "owner_hours_per_day"), v("opex", "close_hour") - v("opex", "open_hour")) * days
    out["owner_hours_month"] = round(owner_h, 1)
    out["owner_ref_krw"] = v("opex", "owner_pay_krw")   # surveyed owner pay (농경연 2025), not hours x wage
    return out


def _electricity(cfg: dict, hours: tuple[int, int] | None = None) -> dict:
    """kWh from opening-hour loads (lighting/HVAC per 평, espresso boilers), 24h loads (showcase, fridge, ice maker)
    and the oven's daily run, x a blended KRW/kWh. All 가정; checked against the one 20평 anchor (~₩300k, L)."""
    o = lambda k: v("opex", k)   # noqa: E731
    open_hour, close_hour = hours or (o("open_hour"), o("close_hour"))
    open_h = (close_hour - open_hour) * o("days_per_month")
    kwh = (o("base_kw_per_pyeong") * cfg["size_pyeong"] + o("espresso_kw_per_group") * cfg["espresso_groups"]) * open_h
    kwh += (o("showcase_kw") * cfg["showcase"] + o("fridge_kw") + o("ice_maker_kw")) * 24 * 30
    kwh += o("oven_kw") * o("oven_hours") * o("days_per_month") * cfg["oven"]
    return {"kwh": round(kwh), "krw": round(kwh * o("electricity_krw_per_kwh")),
            "note_ko": f"월 {round(kwh):,}kWh x {o('electricity_krw_per_kwh')}원, 영업시간과 설비에 비례 (가정)"}


def _monthly_fixed(cfg: dict, labor: dict, area_m2: float) -> dict:
    meta = load_params()["district_meta"][cfg["district"]]
    rent = round(meta["rent_per_pyeong_krw"]["value"] * cfg["size_pyeong"])
    elec = _electricity(cfg)
    maint = round(v("opex", "maintenance_per_m2") * area_m2)
    other = elec["krw"] + maint + v("opex", "misc_krw") + v("opex", "water_gas_krw")
    lab = labor["labor_krw"]
    labor_note = (f"시간대별 필요 인원 기준 유급 {labor['paid_hours_month']}시간, 최저임금 {won(v('opex', 'min_wage'))}"
                  f" x 4대보험 {v('opex', 'employer_insurance') * 100:.1f}% x 주휴 {v('opex', 'weekly_holiday_factor')}배 (가정), "
                  f"사장님이 하루 {v('opex', 'owner_hours_per_day')}시간 한 자리를 무급으로 맡음")
    lines = [
        {"item_ko": "임대료", "krw": rent, "in_total": True, "grade": meta["rent_per_pyeong_krw"]["grade"]},
        {"item_ko": "인건비", "krw": lab, "in_total": True, "grade": "L", "note_ko": labor_note},
        {"item_ko": "전기", "krw": elec["krw"], "in_total": True, "grade": "가정", "note_ko": elec["note_ko"]},
        {"item_ko": "관리비", "krw": maint, "in_total": True, "grade": g("opex", "maintenance_per_m2")},
        {"item_ko": "수도 가스", "krw": v("opex", "water_gas_krw"), "in_total": True, "grade": "가정"},
        {"item_ko": "통신 보험 세무", "krw": v("opex", "misc_krw"), "in_total": True, "grade": "가정"},
        {"item_ko": "사장님 인건비 (참고)", "krw": labor["owner_ref_krw"], "in_total": False, "grade": g("opex", "owner_pay_krw"),
         "note_ko": f"커피 전문점 대표자 인건비 평균 (농경연 2025), 사장님은 월 {labor['owner_hours_month']:g}시간 일함. "
                    "월 고정비 합계에는 빼고, 영업이익에서는 '사장 가상 급여'로 뺌"},   # lab:cost
    ]
    grade = weakest(meta["rent_per_pyeong_krw"]["grade"], g("opex", "min_wage"), g("opex", "open_hour"),
                    g("opex", "electricity_krw_per_kwh"), g("opex", "misc_krw"))
    return {"rent_krw": rent, "labor_krw": lab, "other_krw": other, "total_krw": rent + lab + other,
            "owner_ref_krw": labor["owner_ref_krw"], "lines": lines, "grade": grade,
            "note_ko": f"사장님 인건비 제외 (영업이익에서 따로 {won(labor['owner_ref_krw'])}), 인건비는 시간대별 필요 인원 기준"}   # lab:cost


def _capex(cfg: dict, solved: dict) -> dict:
    P = load_params()["capex"]
    meta = load_params()["district_meta"][cfg["district"]]
    lines = []

    def line(item_ko, qty, unit, grade, source, vat_base=True, dep=None):
        lines.append({"item_ko": item_ko, "qty": qty, "unit_krw": round(unit), "subtotal_krw": round(qty * unit),
                      "grade": grade, "source": source, "_vat": vat_base, "_dep": dep})

    def p(key, item_ko, qty, dep="equipment"):
        if qty:
            line(item_ko, qty, P[key]["value"], P[key]["grade"], P[key]["source"], dep=dep)

    line("인테리어", cfg["size_pyeong"], P["interior_per_pyeong"]["value"], P["interior_per_pyeong"]["grade"],
         P["interior_per_pyeong"]["source"], dep="interior")
    p("electrical", "전기 증설", 1, dep="interior")
    machines = lay.machines_for(cfg["espresso_groups"])
    for m in sorted(set(machines)):
        p(f"espresso_{m}g", f"에스프레소 머신 {m}그룹", machines.count(m))
    p("grinder", "그라인더", len(machines))
    p("showcase", "디저트 쇼케이스", cfg["showcase"])
    p("oven", "오븐", cfg["oven"])
    p("kiosk", "키오스크", cfg["kiosks"])
    p("pos", "POS", cfg["pos"])
    p("fridge", "업소용 냉장고", 1)
    p("ice_maker", "제빙기", 1)
    p("sink", "싱크대", 1)
    n_tables = min(cfg["tables"], solved["table_slots"])
    p("table", "테이블", n_tables, dep="furniture")
    p("chair", "의자", solved["seats_table"], dep="furniture")
    p("bar_seat", "바 스툴", solved["seats_bar"], dep="furniture")
    if solved["seats_bar"]:
        line("바 테이블 (길이 m)", round(solved["seats_bar"] * v("layout", "bar_pitch"), 2), P["bar_counter_per_m"]["value"],
             P["bar_counter_per_m"]["grade"], P["bar_counter_per_m"]["source"], dep="furniture")
    extra_doors = max(0, min(3, int(cfg.get("doors") or 1)) - 1)   # lab:merge 첫 문은 인테리어에 들어 있다고 보고 더 단 문만
    if extra_doors:
        line("출입문 추가", extra_doors, 1_500_000, "가정", "유리문·문틀·도어클로저 1개 150만원 (가정, 화면 DOOR_PRICE와 같음)", dep="interior")
    vat_base = sum(x["subtotal_krw"] for x in lines if x["_vat"])
    line("부가세 (환급 전 선지급)", 1, vat_base * P["vat_rate"]["value"], P["vat_rate"]["grade"], P["vat_rate"]["source"], False)
    dep = meta["deposit_per_pyeong_krw"]
    line("보증금", 1, dep["value"] * cfg["size_pyeong"], dep["grade"], dep["source"], False)
    km = meta["key_money_krw"]
    line("권리금", 1, km["value"], km["grade"], km["source"], False)
    depreciable = {"equipment": 0, "interior": 0, "furniture": 0}
    for x in lines:
        x.pop("_vat")
        cat = x.pop("_dep")
        if cat:
            depreciable[cat] += x["subtotal_krw"]
    total = sum(x["subtotal_krw"] for x in lines)
    return {"lines": lines, "total_krw": total, "own_capital_krw": cfg["own_capital_krw"], "depreciable": depreciable,
            "loan_needed_krw": max(0, total - cfg["own_capital_krw"]),
            "grade": weakest(*(x["grade"] for x in lines))}


def funding(capex_krw: int, own_capital_krw: int, monthly_fixed_krw: int, extra_loan_krw: int | None = None) -> dict:
    """How the store opens: the CAPEX gap is borrowed, plus a 운전자금 loan so the bank account holds
    `working_capital_months` of fixed costs on day one (None = that default, an int = the learner's own amount).
    One rule for the build screen (preview), the season (season.start) and 이지 모드, so every screen shows the
    same loan and opening cash. The VAT line in the CAPEX is paid now and refunded in `vat_refund_month`."""
    months = v("season", "working_capital_months")
    reserve = round(months * monthly_fixed_krw)
    gap = max(0, capex_krw - own_capital_krw)
    if extra_loan_krw is None:
        extra = max(0, reserve - max(0, own_capital_krw - capex_krw))
        note = (f"운전자금 {won(extra)}: 문을 열 때 통장에 월 고정비 {months}개월치({won(reserve)})가 있도록 모자란 만큼 빌림 (가정)")
    else:
        extra = int(extra_loan_krw)
        note = f"운전자금 {won(extra)}: 직접 정한 값"
    loan = gap + extra
    r, n = v("season", "loan_rate") / 12, v("season", "loan_term_months")
    pay = (round(loan * r / (1 - (1 + r) ** -n)) if r > 0 else round(loan / n)) if loan > 0 else 0
    return {"capex_krw": capex_krw, "own_capital_krw": own_capital_krw, "capex_gap_krw": gap, "extra_loan_krw": extra,
            "loan_krw": loan, "working_capital_target_krw": reserve, "cash_krw": own_capital_krw + loan - capex_krw,
            "loan_payment_krw": pay, "loan_rate": v("season", "loan_rate"), "loan_term_months": n,
            "working_capital_note_ko": note, "grade": "가정"}


# ---------------------------------------------------------------------------------------------- core

def _core(cfg: dict) -> dict:
    solved = lay.solve(cfg)
    seats_total = solved["seats_table"] + solved["seats_bar"]
    dem = _demand(cfg)
    stations = _stations(cfg, seats_total)
    equip = _equipment_capacity(cfg, seats_total, stations)
    crew = _crew(cfg, dem, seats_total, stations, equip)
    return {"solved": solved, "seats_total": seats_total, "demand": dem, "stations": stations, "crew": crew,
            "cap": crew["cap"], "cap_equipment": equip, "bottleneck": _bottlenecks(equip, crew, dem["cups"])}


def _fits_all(cfg: dict) -> bool:
    return not lay.solve(cfg)["overflow"]


def _space_fixes(cfg: dict, solved: dict) -> list[dict]:
    fixes = []
    if solved["overflow"]:
        for p in range(int(math.floor(cfg["size_pyeong"])) + 1, MAX_PYEONG + 1):
            if _fits_all({**cfg, "size_pyeong": p}):
                fixes.append({"label_ko": f"{p}평으로 늘리기", "patch": {"size_pyeong": p}})
                break
    if cfg["tables"] > solved["table_slots"]:
        fixes.append({"label_ko": f"테이블 {solved['table_slots']}개로 줄이기", "patch": {"tables": solved["table_slots"]}})
    if cfg["bar_seats"] > solved["bar_capacity"]:
        fixes.append({"label_ko": f"바 좌석 {solved['bar_capacity']}개로 줄이기", "patch": {"bar_seats": solved["bar_capacity"]}})
    if solved["unassigned_chairs"]:
        n = cfg["chairs"] - solved["unassigned_chairs"]
        fixes.append({"label_ko": f"의자 {n}개로 줄이기", "patch": {"chairs": n}})
    return fixes


def _seating_fix(cfg: dict, core: dict):
    """First seat-adding change that really adds seats on a re-solve (tables come in 2-tops and 4-tops, so the
    room, not a formula, decides): fill chairs, add a 4-top, add a 2-top, fill the bar, then grow the room."""
    solved, t, c = core["solved"], cfg["tables"], cfg["chairs"]
    seats = core["seats_total"]
    tries = []
    if solved["unassigned_chairs"] == 0 and solved["seats_table"] < solved["seat_capacity"]:
        n = solved["seat_capacity"] - solved["seats_table"]
        tries.append(({"chairs": c + n}, f"빈 자리에 의자 {n}개 채우기"))
    base_c = c - solved["unassigned_chairs"]
    tries.append(({"tables": t + 1, "chairs": base_c + 4}, f"테이블 {t + 1}개로 늘리기 (의자 4개 포함)"))
    tries.append(({"tables": t + 1, "chairs": base_c + 2}, f"테이블 {t + 1}개로 늘리기 (의자 2개 포함)"))
    if cfg["bar_seats"] < solved["bar_capacity"]:
        tries.append(({"bar_seats": solved["bar_capacity"]}, f"바 좌석 {solved['bar_capacity']}개로 늘리기"))
    for patch, label in tries:
        if lay_seats({**cfg, **patch}) > seats:
            return patch, label
    for p in range(int(math.floor(cfg["size_pyeong"])) + 1, MAX_PYEONG + 1):
        patch = {"size_pyeong": p, "tables": t + 1, "chairs": base_c + 4}
        if lay_seats({**cfg, **patch}) > seats:
            return patch, f"{p}평으로 늘리고 테이블 1개 추가"
    return None, None


def lay_seats(cfg: dict) -> int:
    s = lay.solve(cfg)
    return s["seats_table"] + s["seats_bar"]


def _suggestion(cfg: dict, core: dict) -> dict:
    """The single change that relieves the binding resource, with its effect from a re-run."""
    top = core["bottleneck"][0]
    key, solved = top["key"], core["solved"]
    patch, label = None, None
    if key == "espresso" and cfg["espresso_groups"] < 4:
        n = cfg["espresso_groups"] + 1
        patch, label = {"espresso_groups": n}, f"에스프레소 {n}그룹으로 늘리기"
    elif key == "ordering" and cfg["kiosks"] < 3:
        patch, label = {"kiosks": cfg["kiosks"] + 1}, f"키오스크 {cfg['kiosks'] + 1}대로 늘리기"
    elif key == "ordering" and cfg["pos"] < 3:
        patch, label = {"pos": cfg["pos"] + 1}, f"POS {cfg['pos'] + 1}대로 늘리기"
    elif key == "seating":
        patch, label = _seating_fix(cfg, core)
    elif key == "staff" and core["crew"]["peak"] < v("capacity", "staff_peak_range")[1]:
        n = max(core["crew"]["peak"] + 1, core["crew"]["cover_peak"])
        patch, label = {"staff_peak": n}, f"피크 인원 {n}명으로 늘리기 (사장님 포함)"
    if patch is None:
        return {"label_ko": f"{top['label_ko']} 더 늘릴 수 있는 설정 없음", "patch": {},
                "effect_ko": top["note_ko"], "grade": "L"}
    after = _core({**cfg, **patch})
    unit = "잔/h"
    if key == "staff":
        old, new = min(core["cap"].values()), min(after["cap"].values())
    else:
        old, new = core["cap_equipment"][key], after["cap_equipment"][key]
    nxt = after["bottleneck"][0]
    tail = "여전히 가장 먼저 차는 곳" if nxt["key"] == key else f"다음 병목은 {nxt['label_ko']}"
    effect = f"{top['label_ko']} {old:.0f}{unit}에서 {new:.0f}{unit}로, {tail}"
    return {"label_ko": label, "patch": patch, "effect_ko": effect, "grade": "L"}


def card_fee_rate(annual_sales_krw: float) -> float:
    bands = v("opex", "card_fee_bands")
    for upper, rate in bands:
        if annual_sales_krw <= upper:
            return rate
    return bands[-1][1]


def _rough_month(cfg: dict, dem: dict, revenue: int, served: float, monthly: dict, capex: dict) -> dict:
    """Monthly P&L with every cost line graded; OP is after the owner's pay (사장 가상 급여, as the survey's OP is)."""
    o = lambda k: v("opex", k)   # noqa: E731
    orders = dem["avg_day_customers"] * DAYS_PER_MONTH_DATA * served
    takeout_cups = orders * v("demand", "cups_per_tx") * o("takeout_share")
    rate = card_fee_rate(revenue * 12)
    dep = capex["depreciable"]
    dep_krw = round(dep["equipment"] / (o("depreciation_years_equipment") * 12)
                    + dep["interior"] / (o("depreciation_years_interior") * 12)
                    + dep["furniture"] / (o("depreciation_years_furniture") * 12))
    pct = lambda x: f"{x * 100:.1f}%"   # noqa: E731
    lines = [
        ("식재료비", revenue * o("food_cost_share"), g("opex", "food_cost_share"), f"매출의 {pct(o('food_cost_share'))}"),
        ("카드수수료", revenue * o("card_share") * rate, g("opex", "card_fee_bands"),
         f"연매출 {revenue * 12 / 1e8:.1f}억 구간 {rate * 100:.2f}%, 전 매출 신용카드 가정"),
        ("포장재", takeout_cups * o("packaging_per_takeout_cup"), "가정",
         f"테이크아웃 {pct(o('takeout_share'))} x 월 {round(takeout_cups):,}잔 x {o('packaging_per_takeout_cup')}원"),
        ("수선 소모품 마케팅", revenue * (o("repairs_share") + o("supplies_share") + o("marketing_share")), "가정",
         f"매출의 {pct(o('repairs_share') + o('supplies_share') + o('marketing_share'))}"),
        ("월 고정비", monthly["total_krw"], monthly["grade"], "임대료 인건비 전기 관리비 등, 사장님 인건비 제외"),
        ("사장 가상 급여", monthly["owner_ref_krw"], g("opex", "owner_pay_krw"),   # lab:cost
         "커피 전문점 대표자 인건비 평균 (농경연 2025), 조사의 영업이익과 같은 기준"),
        ("감가상각", dep_krw, g("opex", "depreciation_years_equipment"),
         f"설비 가구 인테리어 {won(sum(dep.values()))} ÷ 5년, 권리금 보증금 부가세 제외"),
    ]
    cost_lines = [{"item_ko": n, "krw": round(k), "grade": gr, "note_ko": note} for n, k, gr, note in lines]
    op_before_dep = round(revenue - sum(x["krw"] for x in cost_lines if x["item_ko"] != "감가상각"))
    op = op_before_dep - dep_krw
    margin = op / revenue if revenue else 0.0
    bench = o("industry_op_margin")
    margin_owner = margin   # lab:cost — OP already has the owner's pay taken out
    gap = (margin - bench) * 100
    scale = revenue * 12 / o("industry_avg_sales_krw")   # the benchmark margin belongs to a ~₩190M/yr store
    if abs(gap) <= 5:
        verdict = "업계 평균과 비슷"
    elif gap > 0:
        why = (f"매출이 업계 평균 점포의 {scale:.1f}배라 고정비 비중이 작음" if scale >= 1.5
               else "최저임금 인건비와 비용 가정 영향이 큼")   # lab:cost
        verdict = f"업계 평균보다 {gap:.0f}%p 높음, {why}"
    else:
        why = (f"매출이 업계 평균 점포의 {scale:.1f}배라 임대료 인건비 부담이 큼" if scale < 1
               else "손님 수 대비 임대료 인건비 부담이 큼")
        verdict = f"업계 평균보다 {-gap:.0f}%p 낮음, {why}"
    return {
        "revenue_krw": revenue, "op_before_depreciation_krw": op_before_dep, "depreciation_krw": dep_krw,
        "op_krw": op, "op_margin": round(margin, 3), "card_fee_rate": rate, "lines": cost_lines, "grade": "L",
        "note_ko": (f"빠른 추정, 하루 손님 {dem['daily_customers']}명({'주말' if dem['peak_day'] == 'weekend' else '주중'} 기준)"
                    f" x 객단가 {won(load_districts()[cfg['district']]['ticket_krw']['value'])}, 사장 가상 급여 포함"),   # lab:cost
        "benchmark": {
            "industry_op_margin": bench, "model_op_margin": round(margin, 3),
            "model_op_margin_with_owner_pay": round(margin_owner, 3),
            "revenue_vs_industry_avg": round(scale, 2),
            "gap_note_ko": f"모델 {margin * 100:.1f}% vs 업계 {bench * 100:.1f}%, {verdict} (참고용, 맞추지 않음)",
            "source": load_params()["opex"]["industry_op_margin"]["source"],
            "grade": g("opex", "industry_op_margin"),
        },
    }


def normalize(cfg: dict) -> dict:
    out = {**DEFAULTS, **cfg}
    out["district"] = str(out["district"])
    if out["district"] not in load_params()["district_meta"]:
        raise ValueError(f"unknown district {out['district']}")
    if out["peak_day"] is None:   # default = the district's busier day type
        out["peak_day"] = max(("weekend", "weekday"), key=lambda d: _day_factor(out["district"], d))
    return out


def _roster(cfg: dict, solved: dict, roles: list[str]) -> list[dict]:
    """Where each person stands, from the layout: baristas in the work aisle behind their machine (two on one machine
    stand side by side), cashiers behind their POS, floor people in the queue band in front of the counter starting
    at the dessert showcase (else the pickup end) and spreading left. rot 180 = facing the front wall (the customers)."""
    items = {i["id"]: i for i in solved["layout"]}
    cz = solved["room"]["counter_zone"]
    aisle_z = round(cz["z"] + cz["d"] / 2, 3)
    floor_z = round(cz["z"] - v("layout", "queue_d") / 2, 3)
    gap, wm = v("layout", "staff_floor_gap"), v("layout", "wall_margin")
    machines = [k for k in sorted(items) if items[k]["type"] == "espresso"]
    poses = [k for k in sorted(items) if items[k]["type"] == "pos"]
    anchor = items.get("showcase_1")
    floor_x0 = anchor["x"] if anchor else cz["x"] + v("layout", "counter_side_access") + v("layout", "item_w")["pickup"] / 2
    out, n = [], {"barista": 0, "cashier": 0, "floor": 0}
    for role in roles:
        k = n[role]
        n[role] += 1
        if role == "barista":
            sid = machines[k % len(machines)]
            shift = 0.0 if k < len(machines) else -0.45   # a second barista on a machine stands at its left side
            x, z, rot, fits = items[sid]["x"] + shift, aisle_z, 180, items[sid]["fits"]
        elif role == "cashier":
            sid = poses[k % len(poses)]
            x, z, rot, fits = items[sid]["x"], aisle_z, 180, items[sid]["fits"]
        else:
            sid = "showcase_1" if anchor else "floor"
            x, z, rot, fits = max(wm + 0.3, floor_x0 - k * gap), floor_z, 180, True
        out.append({"id": f"{role}_{k + 1}", "role": role, "label_ko": f"{ROLES_KO[role]} {k + 1}", "station_id": sid,
                    "x": round(x, 3), "z": z, "rot_deg": rot, "fits": fits})
    return out


def preview(cfg: dict) -> dict:
    cfg = normalize(cfg)
    core = _core(cfg)
    solved, dem, crew, cap, equip = core["solved"], core["demand"], core["crew"], core["cap"], core["cap_equipment"]
    area = solved["room"]["area_m2"]
    meta = load_params()["district_meta"][cfg["district"]]
    dist = load_districts()[cfg["district"]]

    seats_grade = weakest(dem["rollup"], g("demand", "dwell_h"), g("demand", "dine_in_share"))
    throughput_grade = weakest(dem["rollup"], g("capacity", "machine_cph_by_groups"), g("capacity", "kiosk_order_s"),
                               g("demand", "dwell_h"))
    labor = _labor(cfg, dem, crew)
    monthly = _monthly_fixed(cfg, labor, area)
    sched = labor[dem["peak_day"]]["rows"]
    capex = _capex(cfg, solved)

    ratio = core["bottleneck"][0]["ratio"]
    # average-day orders x 상권 ticket x 30.3 days; equals the anchor month (industry average x 상권 index) at the data default
    revenue = round(dem["avg_day_customers"] * dist["ticket_krw"]["value"] * DAYS_PER_MONTH_DATA * min(1.0, ratio))
    rough = _rough_month(cfg, dem, revenue, min(1.0, ratio), monthly, capex)
    # demand before the capacity cap: callers that scale daily_customers to a target month divide by THIS, not by the
    # capped rough revenue (dividing by the capped one inflated demand for small stores, lab 2026-10-22)
    revenue_uncapped = round(dem["avg_day_customers"] * dist["ticket_krw"]["value"] * DAYS_PER_MONTH_DATA)

    return {
        "input": cfg,
        "room": {**solved["room"], "grade": "가정"},
        "layout": solved["layout"],
        "space": {"used_m2": round(solved["used_m2"], 1), "use_pct": round(solved["used_m2"] / area * 100, 1),
                  "table_slots": solved["table_slots"], "bar_capacity": solved["bar_capacity"],
                  "overflow": solved["overflow"], "fix": _space_fixes(cfg, solved), "grade": "L"},
        "seats": {"total": core["seats_total"], "table": solved["seats_table"], "bar": solved["seats_bar"],
                  "unassigned_chairs": solved["unassigned_chairs"],
                  "demand_peak_seats": round(dem["cups"] * v("demand", "dine_in_share") * v("demand", "dwell_h")
                                             * v("demand", "persons_per_cup"), 1),
                  "grade": seats_grade},
        "throughput": {"demand_peak_cups_per_h": round(dem["cups"], 1), "espresso_cph": round(cap["espresso"], 1),
                       "ordering_cph": round(cap["ordering"], 1), "seating_cph": round(cap["seating"], 1),
                       "staff_cph": round(min(cap.values()), 1),
                       "espresso_equipment_cph": round(equip["espresso"], 1),
                       "ordering_equipment_cph": round(equip["ordering"], 1),
                       "seating_equipment_cph": round(equip["seating"], 1),
                       "note_ko": (f"처리량은 피크 인원 {crew['peak']}명 (사장님 포함) 기준, "
                                   + ("바리스타가 주문도 받음 (가정), " if crew["on_pos"] else "")
                                   + "장비만의 한계는 *_equipment_cph (인원 효과는 가정)"),
                       "grade": throughput_grade},
        "bottleneck": [{**b, "grade": throughput_grade} for b in core["bottleneck"]],
        "suggestion": _suggestion(cfg, core),
        "capex": {k: x for k, x in capex.items() if k != "depreciable"},
        "funding": funding(capex["total_krw"], cfg["own_capital_krw"], monthly["total_krw"]),
        "monthly_fixed": monthly,
        "staff": {"peak": max(r["staff"] for r in sched), "base": min(r["staff"] for r in sched),
                  "staff_peak": crew["peak"], "recommended_peak": crew["recommended"], "user_peak": crew["user"],
                  "source": crew["source"], "stations": core["stations"]["max"],
                  "roles": {r: crew["roles"].count(r) for r in ROLES_KO},
                  "roster": _roster(cfg, solved, crew["roles"]),
                  "schedule_day": dem["peak_day"], "schedule": sched, "short_hours": sum(r["short"] for r in sched),
                  "paid_hours_month": labor["paid_hours_month"],
                  "note_ko": (f"피크 인원 {crew['peak']}명은 사장님 포함, 시간당 인원 = 필요 인원 (음료 x 몰림 "
                              f"{v('demand', 'peak_surge')}배 ÷ 바리스타 {v('capacity', 'barista_cph')}잔/h + 응대 시간, "
                              f"여유율 {v('opex', 'staff_utilization')}) 과 그 시간 손님을 놓치지 않을 인원 중 큰 값, "
                              "피크 인원을 넘으면 short (가정)"),
                  "grade": "L"},
        "demand": {"daily_customers": dem["daily_customers"], "default_daily_customers": dem["default_daily_customers"],
                   "source": dem["source"], "peak_day": dem["peak_day"],
                   "peak_orders_per_h": round(dem["tx_peak"], 1), "grade": dem["grade"],
                   "revenue_uncapped_krw": revenue_uncapped,
                   "range_hint_ko": (f"기본값 {dem['default_daily_customers']}명은 업계 평균 카페 연매출 "
                                     f"{won(v('opex', 'industry_avg_sales_krw'))}(전국, 프랜차이즈 포함)에 이 상권의 매출 지수 "
                                     f"{demand_index(cfg['district']):.2f}(점포당 매출 ÷ 서울 점포당 매출)를 곱해 객단가로 나눈 값, "
                                     "장사가 잘되는 카페는 하루 수백 명도 받으니 직접 바꿔 보세요")},
        "rough_month": rough,
        "district": {"code": cfg["district"], "name_ko": meta["name_ko"], "context_ko": meta["context_ko"],
                     "rent_per_pyeong_krw": meta["rent_per_pyeong_krw"]["value"],
                     "sales_per_store_month_krw": dist["sales_per_store_month_krw"]["value"],
                     "peak_band": dist["peak_band"], "grade": "H"},
    }
