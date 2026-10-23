"""새 업종(한식 백반집, 호프·주점, 분식집, 베이커리, 치킨집)의 월 단위 결정론 모델 (lab:industry).

카페 엔진(sim/cafe, docs/CAFE.md)의 틀을 따른다: 업종 중앙값 매출을 동네 지수로 옮겨 '자리 잡힌 달'의 수요를 정하고,
좌석과 사람이 받을 수 있는 만큼만 손님을 받고, 비용은 업종 비중과 동네 월세로 뺀다. 같은 입력이면 같은 결과다.
값의 출처는 research/industries/*.yaml (값마다 등급), 설명은 docs/INDUSTRY.md.

  수요(인분/월) = 업종 연매출 중앙값 ÷ 12 (중앙값 평수 가게 기준, '보통 가게' 기준점) × 서울 배율(중앙값끼리) × 구 지수 × 동네 위치 × (평수 ÷ 중앙값 평수)^면적 탄력성 ÷ 객단가
                  × 분기 지수 × 개업 곡선 × 별점 × 가격^(-탄력성) × 마케팅 × 영업시간 × 경쟁 × 사건
  받는 손님 = min(홀 수요, 좌석 × 하루 회전 상한 × 영업일) + 배달 + 포장, 전체가 (직원 + 사장님) × 1인 처리 상한 × 영업일을 넘으면 줄임
  영업이익 = 매출 − 식재료 − 카드 − 배달 − 세금과 공과 − 기타 − 월세 − 인건비 − 마케팅 − 수리 − 감가상각 (사장님 인건비는 빼지 않음)
"""
from __future__ import annotations

import math

from sim.cafe import layout as cafe_layout
from sim.cafe.ko import won
from sim.cafe.model import card_fee_rate

from . import params as P
from .registry import INDUSTRIES

BANDS = ((0, 6), (6, 11), (11, 14), (14, 17), (17, 21), (21, 24))
GRADES = ("basic", "mid", "high")
GRADE_KO = {"basic": "기본", "mid": "중급", "high": "고급"}
HOURS_KO = {"short": "짧게", "standard": "기본", "long": "길게"}
# 3D 가게: 카페 배치기(sim/cafe/layout.py)를 빌려 테이블과 카운터를 놓고, 카운터 위 조각을 업종 이름으로 읽는다
# 카페 배치기의 카운터 칸(진열장, 오븐, 제빙기, 냉장고, 개수대)을 업종 설비 이름으로 읽는다. 진열장을 빼면 카페 배치기가 뒤쪽 줄
# 마지막 칸을 못 놓는 경우가 있어(sim/cafe/layout.py 카운터 폭 계산) 모든 업종에 진열장 칸을 둔다.
FURNITURE = {
    "hansik": {"oven": 1, "showcase": 1, "labels": {"showcase": "반찬 진열대", "oven": "가스레인지", "ice_maker": "밥솥", "fridge": "반찬 냉장고", "sink": "개수대", "pos": "계산대"}},
    "pub": {"oven": 1, "showcase": 1, "labels": {"showcase": "안주 냉장 진열대", "oven": "화구·튀김기", "ice_maker": "생맥주 디스펜서", "fridge": "맥주 냉장고", "sink": "개수대", "pos": "계산대"}},
    "bunsik": {"oven": 1, "showcase": 1, "labels": {"showcase": "김밥 진열대", "oven": "떡볶이 판", "ice_maker": "튀김기", "fridge": "재료 냉장고", "sink": "개수대", "pos": "계산대"}},
    "bakery": {"oven": 1, "showcase": 1, "labels": {"showcase": "빵 진열장", "oven": "제빵 오븐", "ice_maker": "발효기", "fridge": "반죽 냉장고", "sink": "개수대", "pos": "계산대"}},
    "chicken": {"oven": 1, "showcase": 1, "labels": {"showcase": "포장 대기대", "oven": "튀김기", "ice_maker": "염지 작업대", "fridge": "닭 냉장고", "sink": "개수대", "pos": "계산대·배달 주문"}},
}


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------------------------- 입력

def normalize(body: dict) -> dict:
    """빈 값을 업종 기본값으로 채우고 범위를 확인한다 (ValueError = 422)."""
    ind = body.get("industry")
    if ind not in INDUSTRIES:
        raise ValueError(f"unknown industry {ind}")
    gu = body.get("gu")
    if gu not in P.gu_data()[ind]["gu"]:
        raise ValueError(f"unknown gu {gu}")
    area = P.iv(ind, "demand", "area_pyeong_p50")
    pyeong = int(body.get("pyeong") or round(_clamp(area, 10, 40)))
    if not 10 <= pyeong <= 40:
        raise ValueError("pyeong 10..40")
    spt = P.iv(ind, "demand", "seats_per_table")
    tables = body.get("tables")
    tables = int(round(pyeong * P.iv(ind, "demand", "seats_per_pyeong") / spt)) if tables is None else int(tables)
    if not 0 <= tables <= 40:
        raise ValueError("tables 0..40")
    staff = body.get("staff")
    staff = int(P.iv(ind, "cost", "default_staff")) if staff is None else int(staff)
    if not 0 <= staff <= 8:
        raise ValueError("staff 0..8")
    grade = body.get("grade") or "basic"
    if grade not in GRADES:
        raise ValueError("grade basic|mid|high")
    rent = body.get("rent_man_per_pyeong")
    if rent is not None and not 0 < float(rent) < 100:
        raise ValueError("rent_man_per_pyeong 0..100")
    dong = body.get("dong") or None
    return {
        "industry": ind, "gu": gu, "dong": dong, "pyeong": pyeong, "tables": tables, "staff": staff, "grade": grade,
        "own_capital_krw": int(body.get("own_capital_krw", 80_000_000)), "key_money_krw": int(body.get("key_money_krw") or 0),
        "rent_man_per_pyeong": float(rent) if rent is not None else None,
        "delivery": bool(body.get("delivery", True)),
        # lab:merge 가게 배치 (카페 배치기에 그대로 넘긴다). 없으면 예전 그대로
        **{k: body[k] for k in ("aspect", "door_wall", "door_pos", "windows") if body.get(k) is not None},
        "doors": max(1, min(3, int(body.get("doors") or 1))),
    }


# ---------------------------------------------------------------------------------------------- 가게 맥락 (달마다 안 바뀌는 것)

def _dong_row(ind: str, gu: str, dong: str | None) -> dict | None:
    if not dong:
        return None
    d = P.dong_data(ind)
    return next((x for x in (d or {}).get("gu", {}).get(gu, []) if x["name"] == dong), None)


def hours_preset(ind: str, key: str) -> tuple[int, int]:
    o, c = P.iv(ind, "demand", "hours")
    return {"short": (o + 1, c - 1), "standard": (o, c), "long": (max(6, o - 1), c + 2)}[key]


def _coverage(bands: list[float], hours: tuple[int, int]) -> float:
    """영업시간 안에 드는 매출 비중 (시간대 매출 비중을 시간마다 고르게 나눔)."""
    cov = 0.0
    for h in range(hours[0], hours[1]):
        hh = h % 24
        for i, (a, b) in enumerate(BANDS):
            if a <= hh < b:
                cov += bands[i] / (b - a)
    return min(1.0, cov)


def context(cfg: dict) -> dict:
    ind, gu = cfg["industry"], cfg["gu"]
    gd = P.gu_data()[ind]
    g, seoul = gd["gu"][gu], gd["seoul"]
    dr = _dong_row(ind, gu, cfg["dong"])
    lo, hi = P.cv("demand", "dong_rel_range")
    rel = _clamp(dr["rel"], lo, hi) if dr and dr.get("rel") else 1.0
    glo, ghi = P.cv("demand", "gu_index_range")
    gu_index = _clamp(g["sales_per_store_month"] / seoul["sales_per_store_month"], glo, ghi)
    area = P.iv(ind, "demand", "area_pyeong_p50")   # 기준점은 중앙값 가게: 중앙값 매출과 중앙값 평수를 짝짓는다
    size = (cfg["pyeong"] / area) ** P.iv(ind, "demand", "area_elasticity")
    uplift = P.cv("demand", "seoul_uplift")
    anchor = P.iv(ind, "demand", "annual_sales_p50_man") * 1e4 / 12 * uplift * gu_index * rel * size
    ticket = P.iv(ind, "demand", "ticket_krw")
    if cfg["rent_man_per_pyeong"] is not None:
        rent_pp, rent_src = cfg["rent_man_per_pyeong"], "입력"
    else:
        rent_pp, rent_src = P.cash_rent_man(gu, cfg["dong"])
    pay = P.iv(ind, "cost", "pay_per_staff_month_krw")
    ch = P.iv(ind, "demand", "channel_share")
    std = hours_preset(ind, "standard")
    return {
        "cfg": cfg, "ind": ind, "anchor_krw": anchor, "ticket": ticket, "gu_index": gu_index, "rel": rel, "size": size, "uplift": uplift,
        "seats": int(round(cfg["tables"] * P.iv(ind, "demand", "seats_per_table"))),
        "qidx": (dr or {}).get("qidx") or g["quarter_index"], "bands": g["band_share"],
        "days": P.iv(ind, "demand", "days_month"), "std_hours": std, "cov_std": _coverage(g["band_share"], std),
        "rent_pp_man": rent_pp, "rent_src": rent_src, "rent_krw": rent_pp * cfg["pyeong"] * 1e4,
        "pay": pay, "default_staff": int(P.iv(ind, "cost", "default_staff")),
        "channels": ch, "delivery_ok": ch["delivery"] >= 0.05,
        "opening_rate": g["opening_rate"], "closure_rate": g["closure_rate"],
        "dong_row": dr, "gu_row": g,
    }


def capex(ctx: dict) -> dict:
    cfg, ind = ctx["cfg"], ctx["ind"]
    py, gr = cfg["pyeong"], cfg["grade"]
    per = {k: P.iv(ind, "capex", f"{k}_per_pyeong_man")[gr] for k in ("interior", "kitchen", "hall")}
    months = P.cv("cost", "deposit_months")
    lines = [
        {"key": "deposit", "item_ko": "보증금", "krw": round(ctx["rent_krw"] * months), "grade": "M",
         "note_ko": f"월세 {months}개월분 (서울시 실태조사: 월세의 11~15개월)", "depreciate": False},
        {"key": "interior", "item_ko": "인테리어 공사", "krw": round(per["interior"] * py * 1e4), "grade": "L",
         "note_ko": f"{py}평, 평당 {per['interior']:g}만원 ({GRADE_KO[gr]})", "depreciate": True},
        {"key": "kitchen", "item_ko": "주방 설비", "krw": round(per["kitchen"] * py * 1e4), "grade": "L",
         "note_ko": f"평당 {per['kitchen']:g}만원 ({GRADE_KO[gr]})", "depreciate": True},
        {"key": "hall", "item_ko": "홀 가구와 집기", "krw": round(per["hall"] * py * 1e4), "grade": "L",
         "note_ko": f"평당 {per['hall']:g}만원 ({GRADE_KO[gr]})", "depreciate": True},
        {"key": "sign", "item_ko": "간판", "krw": round(P.cv("cost", "sign_man") * 1e4), "grade": "가정", "note_ko": "전면 간판 1개, 가정", "depreciate": False},
        {"key": "stock", "item_ko": "첫 재료와 소모품", "krw": round(P.cv("cost", "first_stock_man") * 1e4), "grade": "가정", "note_ko": "가정", "depreciate": False},
    ]
    if cfg.get("doors", 1) > 1:   # lab:merge 고깃집·카페와 같은 문 값 (가정)
        lines.append({"key": "door", "item_ko": "출입문 추가", "krw": round((cfg["doors"] - 1) * 150 * 1e4), "grade": "가정",
                      "note_ko": f"{cfg['doors'] - 1}개 × 150만원 (유리문·문틀·도어클로저, 가정)", "depreciate": True})
    if cfg["key_money_krw"] > 0:
        lines.insert(0, {"key": "keymoney", "item_ko": "권리금", "krw": cfg["key_money_krw"], "grade": "가정",
                         "note_ko": "직접 넣은 값 (나갈 때 돌려받지 못할 수 있어요)", "depreciate": False})
    total = sum(x["krw"] for x in lines)
    dep = sum(x["krw"] for x in lines if x["depreciate"]) / P.cv("cost", "depreciation_months")
    own = cfg["own_capital_krw"]
    return {"lines": lines, "total_krw": total, "own_capital_krw": own, "loan_needed_krw": max(0, total - own),
            "depreciation_month_krw": round(dep), "grade": "L",
            "note_ko": f"평당 설비비는 경영실태조사 2025 {INDUSTRIES[ind]['krei_label']} 개업 투자 비용의 25·50·75% 분위를 기본·중급·고급으로 놓고 면적 중앙값으로 나눈 값이에요."}


# ---------------------------------------------------------------------------------------------- 한 달

NO_EVENT = {"demand": 1.0, "ticket": 1.0, "food": 1.0, "labor": 1.0, "cost_krw": 0, "closed_days": 0, "satisfaction": 0.0,
            "extra_staff": 0, "delivery_to_takeout": 0.0}


def factors(**kw) -> dict:
    f = {"cal": 6, "t": 5, "rating": P.cv("dynamics", "rating_start"), "price": 1.0, "hours": "standard", "staff": None,
         "marketing": 0, "delivery": None, "rival": 1.0, "rent_mult": 1.0, "breakdown": False, "season": None, "effect": dict(NO_EVENT)}
    f.update(kw)
    return f


def evaluate(ctx: dict, f: dict) -> dict:
    """한 달 결과. f = factors(); season=None이면 그 달 분기 지수, 1.0을 주면 계절 효과 없음."""
    ind, cfg = ctx["ind"], ctx["cfg"]
    e = {**NO_EVENT, **(f.get("effect") or {})}
    staff = cfg["staff"] if f["staff"] is None else f["staff"]
    delivery_on = cfg["delivery"] if f["delivery"] is None else f["delivery"]
    hours = hours_preset(ind, f["hours"])
    hours_ratio = (hours[1] - hours[0]) / (ctx["std_hours"][1] - ctx["std_hours"][0])
    shift = P.cv("demand", "hours_shift_share")
    cov = _coverage(ctx["bands"], hours)
    cov_ratio = (cov + shift * (1 - cov)) / (ctx["cov_std"] + shift * (1 - ctx["cov_std"]))
    days = ctx["days"]
    down = e["closed_days"] + (P.cv("season", "breakdown_down_days") if f["breakdown"] else 0)
    days_open = max(0.0, days - down)
    season = f["season"] if f["season"] is not None else ctx["qidx"][(f["cal"] - 1) // 3]
    ramp = P.cv("demand", "open_curve")[min(f["t"], 5)]
    rating_mult = 1 + P.cv("dynamics", "rating_demand_per_star") * (f["rating"] - P.cv("dynamics", "rating_start"))
    price = f["price"]
    price_fx = price ** (-P.cv("demand", "price_elasticity"))
    mkt = P.cv("demand", "marketing_max_lift") * (1 - math.exp(-f["marketing"] / P.cv("demand", "marketing_half_krw")))
    ticket = ctx["ticket"]
    volume = (ctx["anchor_krw"] / ticket) * season * ramp * rating_mult * price_fx * (1 + mkt) * cov_ratio * f["rival"] \
        * e["demand"] * (days_open / days)
    ch = ctx["channels"]
    hall, dlv, take = volume * ch["hall"], volume * ch["delivery"], volume * ch["takeout"]
    move = dlv * e["delivery_to_takeout"]
    dlv, take = dlv - move, take + move
    if not delivery_on:
        take += dlv * P.cv("demand", "delivery_off_to_takeout")
        dlv = 0.0
    lost_delivery_off = (volume * ch["delivery"] - move) * (1 - P.cv("demand", "delivery_off_to_takeout")) if not delivery_on else 0.0
    demand_units = hall + dlv + take
    seat_cap = ctx["seats"] * P.iv(ind, "demand", "seat_turn_max") * days_open * hours_ratio
    workers = max(1, staff + 1 + e["extra_staff"])
    crew_cap = workers * P.iv(ind, "demand", "orders_per_worker_max") * days_open * min(1.25, hours_ratio)
    s_hall = min(hall, seat_cap)
    served = s_hall + dlv + take
    scale = min(1.0, crew_cap / served) if served > 0 else 1.0
    s_hall, s_dlv, s_take = s_hall * scale, dlv * scale, take * scale
    served = s_hall + s_dlv + s_take
    walk = max(0.0, demand_units - served)
    walk_share = walk / demand_units if demand_units > 0 else 0.0
    if served <= 0:
        bottleneck = None
    elif scale < 0.999:
        bottleneck = "staff"
    elif hall > seat_cap + 1e-9:
        bottleneck = "seats"
    else:
        bottleneck = None
    unit_price = ticket * price * e["ticket"]
    revenue = served * unit_price
    dlv_rev = s_dlv * unit_price
    pay = ctx["pay"]
    extra = e["extra_staff"]
    labor = staff * pay * hours_ratio * e["labor"] + (extra * pay * P.cv("capacity", "extra_staff_cost_share") if extra > 0 else extra * pay)
    labor = max(0.0, labor)
    lines = {
        "food": served * ticket * P.iv(ind, "cost", "food_share") * e["food"],
        "card": revenue * card_fee_rate(revenue * 12) * P.cv("cost", "card_share"),
        "delivery": dlv_rev * P.iv(ind, "cost", "delivery_cost_of_delivery_revenue"),
        "tax": revenue * P.iv(ind, "cost", "tax_share"),
        "other": revenue * P.iv(ind, "cost", "other_share"),
        "rent": ctx["rent_krw"] * f["rent_mult"],
        "labor": labor,
        "marketing": f["marketing"] + e["cost_krw"],
        "repair": P.cv("season", "breakdown_repair_krw") if f["breakdown"] else 0.0,
    }
    dep = ctx.get("dep_krw", 0.0)
    op_before_dep = revenue - sum(lines.values())
    understaffed = staff < ctx["default_staff"]
    sat = P.cv("dynamics", "satisfaction_walkaway") * walk_share + P.cv("dynamics", "satisfaction_price") * (price * e["ticket"] - 1) \
        + e["satisfaction"] + (P.cv("dynamics", "satisfaction_understaffed") if understaffed else 0.0) \
        + (P.cv("dynamics", "satisfaction_wellstaffed") if staff > ctx["default_staff"] else 0.0)
    return {
        "revenue": revenue, "delivery_revenue": dlv_rev, "lines": lines, "depreciation": dep, "op": op_before_dep - dep,
        "op_before_dep": op_before_dep, "covers": served, "hall": s_hall, "delivery_units": s_dlv, "takeout_units": s_take,
        "demand_units": demand_units, "walkaways": walk, "walk_share": walk_share, "lost_delivery_off": lost_delivery_off,
        "bottleneck": bottleneck, "seat_cap": seat_cap, "crew_cap": crew_cap, "satisfaction": sat, "days_open": days_open,
        "hours": hours, "staff": staff, "ticket": unit_price,
        "drivers": {"season": season, "ramp": ramp, "rating_mult": rating_mult, "price_fx": price_fx, "marketing_lift": mkt,
                    "hours_coverage": cov_ratio, "rival": f["rival"], "event_demand": e["demand"]},
    }


LINE_KO = {"food": "식재료비", "card": "카드 수수료", "delivery": "배달 수수료·대행비", "tax": "세금과 공과 (공과금 포함)",
           "other": "기타 운영비 (소모품·홍보)", "rent": "월세", "labor": "인건비", "marketing": "마케팅·사건 비용", "repair": "설비 수리"}
LINE_GRADE = {"food": "H", "card": "H", "delivery": "L", "tax": "H", "other": "L", "rent": "H", "labor": "L", "marketing": "가정", "repair": "가정"}


def pnl_lines(r: dict) -> list[dict]:
    out = [{"key": k, "item_ko": LINE_KO[k], "krw": round(v), "grade": LINE_GRADE[k]} for k, v in r["lines"].items()]
    out.append({"key": "depreciation", "item_ko": "감가상각 (설비 5년)", "krw": round(r["depreciation"]), "grade": "M"})
    return out


# ---------------------------------------------------------------------------------------------- 미리보기

def _layout(ctx: dict) -> dict:
    cfg, ind = ctx["cfg"], ctx["ind"]
    fu = FURNITURE[ind]
    spt = P.iv(ind, "demand", "seats_per_table")
    lay_cfg = {"size_pyeong": cfg["pyeong"], "tables": cfg["tables"], "chairs": int(round(cfg["tables"] * spt)), "bar_seats": 0,
               "espresso_groups": 1, "showcase": fu["showcase"], "oven": fu["oven"], "kiosks": 0, "pos": 1,
               **{k: cfg[k] for k in ("aspect", "door_wall", "door_pos", "windows") if k in cfg}}   # lab:merge 가게 모양·출입문·창문
    try:
        solved = cafe_layout.solve(lay_cfg)
    except Exception:   # 배치기가 바뀌어도 숫자 계산은 계속한다 (3D만 빈다)
        return {"room": None, "layout": [], "roster": [], "seats_placed": 0}
    # 에스프레소 머신은 빼고, 테이블에 못 붙은 의자(unassigned)도 뺀다 (좌석은 실제로 놓인 의자만 센다)
    items = [x for x in solved["layout"] if x["type"] not in ("espresso", "grinder") and not x.get("unassigned")]
    for x in items:
        x["label_ko"] = fu["labels"].get(x["type"])
    room = solved["room"]
    cz = room["counter_zone"]
    roster = []
    n = cfg["staff"] + 1
    for i in range(n):   # 사장님과 직원: 카운터 안쪽 통로에 0.7m 간격, 넘치면 홀(카운터 앞)
        inside = i < max(1, int(cz["w"] // 0.7))
        x = room["width_m"] - 0.5 - 0.7 * (i if inside else i - int(cz["w"] // 0.7))
        z = cz["z"] + cz["d"] / 2 if inside else cz["z"] - 0.6
        roster.append({"id": f"p{i + 1}", "role": "owner" if i == 0 else ("kitchen" if inside else "floor"),
                       "label_ko": "사장님" if i == 0 else ("주방" if inside else "홀"), "x": round(x, 3), "z": round(z, 3), "fits": True})
    seats = sum(1 for x in items if x["type"] == "chair" and x["fits"] and not x.get("unassigned"))
    return {"room": room, "layout": items, "roster": roster, "seats_placed": seats}


def preview(body: dict) -> dict:
    cfg = normalize(body)
    ctx = context(cfg)
    cx = capex(ctx)
    ctx["dep_krw"] = cx["depreciation_month_krw"]
    ind = cfg["industry"]
    lay = _layout(ctx)
    if lay["room"] is not None:
        ctx["seats"] = lay["seats_placed"]   # 실제로 놓인 의자만 좌석으로 센다
    settled = evaluate(ctx, factors(season=1.0))
    rev = settled["revenue"]
    fixed = {"rent_krw": round(ctx["rent_krw"]), "labor_krw": round(settled["lines"]["labor"]), "depreciation_krw": cx["depreciation_month_krw"]}
    owner = P.iv(ind, "cost", "owner_pay_month_krw")
    days = ctx["days"]
    per_unit_margin = ctx["ticket"] * (1 - P.iv(ind, "cost", "food_share") - P.iv(ind, "cost", "tax_share") - P.iv(ind, "cost", "other_share")
                                       - card_fee_rate(rev * 12) - ctx["channels"]["delivery"] * P.iv(ind, "cost", "delivery_cost_of_delivery_revenue"))
    breakeven_day = (fixed["rent_krw"] + fixed["labor_krw"] + fixed["depreciation_krw"]) / per_unit_margin / days if per_unit_margin > 0 else None
    k = INDUSTRIES[ind]
    return {
        "industry": ind, "name_ko": k["name"], "model_version": P.model_version(), "input": cfg,
        "demand": {
            "anchor_month_krw": round(ctx["anchor_krw"]), "settled_units_day": round(settled["demand_units"] / days, 1),
            "gu_index": round(ctx["gu_index"], 3), "dong_rel": round(ctx["rel"], 3), "size_factor": round(ctx["size"], 3), "seoul_uplift": ctx["uplift"],
            "ticket_krw": ctx["ticket"], "days_month": days, "channels": ctx["channels"], "delivery_available": ctx["delivery_ok"],
            "grade": "M",
            "note_ko": (f"{k['krei_label']} 연매출 중앙값 {P.iv(ind, 'demand', 'annual_sales_p50_man'):,.0f}만원(전국, 중앙값 {P.iv(ind, 'demand', 'area_pyeong_p50'):g}평 가게) × 서울 배율 {ctx['uplift']} × "
                        f"{cfg['gu']} 지수 {ctx['gu_index']:.2f}" + (f" × {cfg['dong']} 위치 {ctx['rel']:.2f}" if ctx["rel"] != 1.0 else "")
                        + f" × 평수 효과 {ctx['size']:.2f}"),
        },
        "room": lay["room"], "layout": lay["layout"], "roster": lay["roster"],
        "furniture_ko": FURNITURE[ind]["labels"],
        "seats": {"total": ctx["seats"], "tables": cfg["tables"], "per_table": P.iv(ind, "demand", "seats_per_table")},
        "capacity": {"seat_units_day": round(settled["seat_cap"] / days, 1), "crew_units_day": round(settled["crew_cap"] / days, 1),
                     "demand_units_day": round(settled["demand_units"] / days, 1), "bottleneck": settled["bottleneck"],
                     "walk_share": round(settled["walk_share"], 3), "grade": "L",
                     "note_ko": "좌석 한 개가 하루에 받는 손님과 한 사람이 하루에 감당하는 인분의 상한은 경영실태조사 원자료의 90% 분위예요."},
        "staff": {"staff": cfg["staff"], "default": ctx["default_staff"], "pay_month_krw": ctx["pay"]},
        "hours": {"standard": list(ctx["std_hours"]), "presets": {kk: list(hours_preset(ind, kk)) for kk in ("short", "standard", "long")}},
        "rent": {"man_per_pyeong": ctx["rent_pp_man"], "source": ctx["rent_src"]},
        "capex": cx,
        "monthly_fixed": {**fixed, "total_krw": sum(fixed.values())},
        "rough_month": {"revenue_krw": round(rev), "op_krw": round(settled["op"]), "op_margin": round(settled["op"] / rev, 3) if rev else None,
                        "lines": pnl_lines(settled), "covers": round(settled["covers"]), "walkaways": round(settled["walkaways"]),
                        "owner_pay_ref_krw": owner, "grade": "L",
                        "note_ko": "자리가 잡힌 달(개업 6개월째, 계절 평균, 사건 없음). 사장님 인건비는 비용에 넣지 않았어요."},
        "breakeven_units_day": round(breakeven_day, 1) if breakeven_day else None,
        "benchmark": {"op_share_survey": P.iv(ind, "cost", "op_share_survey"), "rent_share_survey": P.iv(ind, "cost", "rent_share_survey"),
                      "krei_label": k["krei_label"], "owner_family_share_survey": P.iv(ind, "cost", "owner_family_share_survey"),
                      "sales_p25_month_krw": round(P.iv(ind, "demand", "annual_sales_p25_man") * 1e4 / 12),
                      "sales_p50_month_krw": round(P.iv(ind, "demand", "annual_sales_p50_man") * 1e4 / 12),
                      "sales_mean_month_krw": round(P.iv(ind, "demand", "annual_sales_mean_man") * 1e4 / 12),
                      "sales_p75_month_krw": round(P.iv(ind, "demand", "annual_sales_p75_man") * 1e4 / 12),
                      "note_ko": f"경영실태조사 2025 {k['krei_label']} (전국): 영업이익 {P.iv(ind, 'cost', 'op_share_survey'):.1%}는 대표자·가족 인건비 "
                                 f"{P.iv(ind, 'cost', 'owner_family_share_survey'):.1%}를 뺀 뒤의 값이에요. 이 화면의 영업이익은 사장님 몫을 빼기 전이라 둘을 더한 값과 견줘요."},
        "area": {"opening_rate": ctx["opening_rate"], "closure_rate": ctx["closure_rate"], "rent_source": ctx["rent_src"]},
        "summary_ko": f"자리 잡힌 달 매출 {won(rev)}, 영업이익 {won(settled['op'])} (사장님 몫 빼기 전)",
    }
