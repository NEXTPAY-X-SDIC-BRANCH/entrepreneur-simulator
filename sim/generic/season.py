"""새 업종의 6개월 시즌 (lab:industry). 카페 시즌(sim/cafe/season.py)처럼 순수하고 결정론적이다.

run = start(body) 는 JSON으로 저장할 수 있는 dict이고, play_month(run, decisions)가 다음 달을 돌린다. 같은 시드와 같은 결정이면
같은 달이 나온다. 무작위 사건(경쟁 가게, 임대료 인상, 설비 고장)은 (시드, 달, 사건)마다 뽑아서 결정이 사건을 바꾸지 않는다.
이달의 사건(research/industries/events.yaml)은 달력 월에 맞는 업종 사건, 없으면 공통 사건 하나이고, 사장님이 대응을 고른다.
"""
from __future__ import annotations

import math
import random

from sim.cafe.ko import won

from . import model as m
from . import params as P
from .registry import INDUSTRIES

DECISION_KEYS = ("price_change_pct", "hours", "staff", "marketing_krw", "delivery", "choice")


class SeasonOver(Exception):
    """폐업했거나 모든 달을 돌았다."""


def _josa(word: str, pair: str) -> str:
    ch = word[-1]
    return word + (pair[0] if "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 else pair[1])


def _rng(seed: int, i: int, tag: str) -> random.Random:
    return random.Random(f"{seed}:{i}:{tag}")


def _loan_payment(principal: float, rate: float, n: int) -> float:
    if principal <= 0:
        return 0.0
    r = rate / 12
    return principal * r / (1 - (1 + r) ** -n) if r > 0 else principal / n


# ---------------------------------------------------------------------------------------------- 사건

def _calendar(run: dict, i: int) -> int:
    return (run["start_month"] - 1 + i) % 12 + 1


def event_for(run: dict, i: int) -> dict:
    """i번째 달(0부터)의 이달의 사건. 업종 사건 중 그 달에 맞는 것, 없으면 공통 사건.
    같은 사건이 두 달 연속 나오지 않고, 공통 사건은 이번 시즌에 덜 나온 것부터 (같으면 시드로 고름)."""
    ev = P.events()
    cal = _calendar(run, i)
    past = [event_for(run, j)["id"] for j in range(i)] if i > 0 else []
    prev = past[-1] if past else None
    cands = [e for e in ev["industry"][run["body"]["industry"]] if cal in e["months"] and e["id"] != prev]
    rng = _rng(run["seed"], i, "event")
    if not cands:
        gen = [e for e in ev["generic"] if not (e.get("needs_staff") and run["body"]["staff"] <= 0) and e["id"] != prev]
        least = min(past.count(e["id"]) for e in gen)
        cands = [e for e in gen if past.count(e["id"]) == least]
    return cands[rng.randrange(len(cands))]


def public_event(e: dict) -> dict:
    return {"id": e["id"], "title": e["title"], "prompt": e["prompt"], "why": e.get("why") or "", "default": e["default"],
            "grade": "가정", "options": [{k: o[k] for k in ("id", "label", "hint", "downside")} for o in e["options"]]}


def _random_events(run: dict, ctx: dict, i: int) -> list[dict]:
    out = []
    s = run["state"]
    if not s["rival"]:
        p = 1 - math.exp(-ctx["opening_rate"] * P.cv("season", "rival_nearby_share"))
        if _rng(run["seed"], i, "rival").random() < p:
            out.append({"key": "rival", "label_ko": "근처에 같은 업종 가게가 새로 열었어요", "p": round(p, 3),
                        "effect_ko": f"손님 {round((1 - P.cv('season', 'rival_demand_mult')) * 100)}% 감소 (시즌 끝까지)", "grade": "가정",
                        "source": f"{run['body']['gu']} 연 개업률 {ctx['opening_rate']:.1%} (서울시 상권분석서비스 2025)"})
    if not s["rent_hiked"] and _rng(run["seed"], i, "rent").random() < P.cv("season", "rent_hike_p"):
        out.append({"key": "rent_hike", "label_ko": "건물주가 월세를 올렸어요", "p": P.cv("season", "rent_hike_p"),
                    "effect_ko": f"월세 {P.cv('season', 'rent_hike_pct'):.0%} 인상 (법정 상한)", "grade": "H", "source": "상가건물 임대차보호법 시행령 제4조"})
    if _rng(run["seed"], i, "breakdown").random() < P.cv("season", "breakdown_p"):
        out.append({"key": "breakdown", "label_ko": "주방 설비가 고장 났어요", "p": P.cv("season", "breakdown_p"),
                    "effect_ko": f"수리비 {won(P.cv('season', 'breakdown_repair_krw'))}, {P.cv('season', 'breakdown_down_days')}일 영업 못 함",
                    "grade": "가정", "source": "none"})
    return out


# ---------------------------------------------------------------------------------------------- 시작

def start(body: dict) -> dict:
    cfg = m.normalize(body)
    ctx = m.context(cfg)
    cx = m.capex(ctx)
    seed = int(body.get("seed", 0))
    start_month = int(body.get("start_month") or P.cv("season", "start_month"))
    if not 1 <= start_month <= 12:
        raise ValueError("start_month 1..12")
    rate, rate_src = P.loan_rate()
    if body.get("loan_rate"):   # lab:merge 학습자가 고른 금리 (고깃집·카페처럼)
        rate, rate_src = float(body["loan_rate"]), "가게 꾸미기에서 고른 금리"
    fixed = ctx["rent_krw"] + cfg["staff"] * ctx["pay"]
    gap = max(0, cx["total_krw"] - cfg["own_capital_krw"])
    extra = body.get("extra_loan_krw")
    if extra is None:
        target = P.cv("season", "working_capital_months") * fixed
        extra = max(0.0, target - max(0, cfg["own_capital_krw"] - cx["total_krw"]))
    principal = gap + float(extra)
    term = P.cv("season", "loan_term_months")
    cash = cfg["own_capital_krw"] + principal - cx["total_krw"]
    return {
        "body": cfg, "seed": seed, "start_month": start_month, "months_total": P.cv("season", "months"),
        "capex": cx, "loan": {"principal_krw": round(principal), "rate": rate, "rate_source": rate_src, "term_months": term,
                              "monthly_payment_krw": round(_loan_payment(principal, rate, term)), "extra_krw": round(float(extra)),
                              "note_ko": "모자란 돈과 석 달 치 고정비(월세 + 인건비)를 5년 원리금 균등으로 빌린다고 봤어요 (금리 출처: " + rate_src + ")"},
        "start_cash_krw": round(cash),
        "state": {"cash": cash, "loan_balance": principal, "rating": P.cv("dynamics", "rating_start"), "price": 1.0, "hours": "standard",
                  "staff": cfg["staff"], "marketing": 0, "delivery": cfg["delivery"], "rival": False, "rent_hiked": False,
                  "neg_months": 0, "closed": False, "closed_reason": None},
        "months": [],
    }


def public_start(run: dict) -> dict:
    b = run["body"]
    return {"industry": b["industry"], "name_ko": INDUSTRIES[b["industry"]]["name"], "start_month": run["start_month"],
            "months_total": run["months_total"], "capex": run["capex"], "loan": run["loan"], "start_cash_krw": run["start_cash_krw"],
            "decisions": {"price_change_pct": 0, "hours": "standard", "staff": b["staff"], "marketing_krw": 0, "delivery": b["delivery"]},
            "options": {"hours": {k: list(m.hours_preset(b["industry"], k)) for k in ("short", "standard", "long")},
                        "staff": [0, 8], "price_change_pct": [-20, 30], "marketing_krw": [0, 3_000_000],
                        "delivery_available": P.iv(b["industry"], "demand", "channel_share")["delivery"] >= 0.05},
            "next_event": public_event(event_for(run, 0)), "next_calendar_month": _calendar(run, 0)}


# ---------------------------------------------------------------------------------------------- 한 달

def _apply(state: dict, d: dict) -> None:
    lo, hi = P.cv("demand", "price_level_range")
    if d.get("price_change_pct"):
        pc = float(d["price_change_pct"])
        if not -20 <= pc <= 30:
            raise ValueError("price_change_pct -20..30")
        state["price"] = max(lo, min(hi, state["price"] * (1 + pc / 100)))
    if d.get("hours") is not None:
        if d["hours"] not in ("short", "standard", "long"):
            raise ValueError("hours short|standard|long")
        state["hours"] = d["hours"]
    if d.get("staff") is not None:
        if not 0 <= int(d["staff"]) <= 8:
            raise ValueError("staff 0..8")
        state["staff"] = int(d["staff"])
    if d.get("marketing_krw") is not None:
        if not 0 <= int(d["marketing_krw"]) <= 3_000_000:
            raise ValueError("marketing_krw 0..3,000,000")
        state["marketing"] = int(d["marketing_krw"])
    if d.get("delivery") is not None:
        state["delivery"] = bool(d["delivery"])


def _note(r: dict, ev: dict, opt: dict, ctx: dict, t: int) -> str:
    bits = []
    if r["op"] < 0:
        costs = sorted(((k, v) for k, v in r["lines"].items()), key=lambda kv: -kv[1])[:2]
        bits.append(f"이번 달 {won(-r['op'])} 적자예요. 큰 비용은 {m.LINE_KO[costs[0][0]]} {won(costs[0][1])}, {m.LINE_KO[costs[1][0]]} {won(costs[1][1])}")
    else:
        bits.append(f"이번 달 {won(r['op'])} 남았어요")
    if r["walk_share"] >= 0.05:
        where = "좌석" if r["bottleneck"] == "seats" else "일손"
        bits.append(f"{where}이 모자라 손님 {round(r['walkaways'])}명({r['walk_share']:.0%})을 못 받았어요")
    if t < 3:
        bits.append(f"아직 개업 {t + 1}개월째라 자리 잡힌 가게 손님의 {r['drivers']['ramp']:.0%}만 와요")
    if r["lost_delivery_off"] > 0:
        bits.append(f"배달을 끈 탓에 {round(r['lost_delivery_off'])}인분을 놓쳤어요")
    return ", ".join(bits) + "."


def play_month(run: dict, body: dict | None = None) -> tuple[dict, dict]:
    body = body or {}
    s = run["state"]
    i = len(run["months"])
    if s["closed"] or i >= run["months_total"]:
        raise SeasonOver("season over")
    _apply(s, body)
    cfg = run["body"]
    ctx = m.context(cfg)
    ctx["dep_krw"] = run["capex"]["depreciation_month_krw"]
    try:   # 3D 배치에서 실제로 놓인 의자 수 (미리보기와 같게)
        lay = m._layout(ctx)
        if lay["room"] is not None:
            ctx["seats"] = lay["seats_placed"]
    except Exception:
        pass
    cal = _calendar(run, i)
    ev = event_for(run, i)
    choice = body.get("choice") or ev["default"]
    opt = next((o for o in ev["options"] if o["id"] == choice), None)
    if opt is None:
        raise ValueError(f"unknown choice {choice} for {ev['id']}")
    rnd = _random_events(run, ctx, i)
    keys = {x["key"] for x in rnd}
    if "rival" in keys:
        s["rival"] = True
    if "rent_hike" in keys:
        s["rent_hiked"] = True
    f = m.factors(cal=cal, t=i, rating=s["rating"], price=s["price"], hours=s["hours"], staff=s["staff"], marketing=s["marketing"],
                  delivery=s["delivery"], rival=P.cv("season", "rival_demand_mult") if s["rival"] else 1.0,
                  rent_mult=1 + P.cv("season", "rent_hike_pct") if s["rent_hiked"] else 1.0, breakdown="breakdown" in keys,
                  effect=opt["effect"])
    r = m.evaluate(ctx, f)
    rate = run["loan"]["rate"]
    interest = s["loan_balance"] * rate / 12
    principal = min(s["loan_balance"], max(0.0, run["loan"]["monthly_payment_krw"] - interest))
    start_cash = s["cash"]
    s["cash"] = start_cash + r["op"] + r["depreciation"] - interest - principal
    s["loan_balance"] -= principal
    lo, hi = P.cv("dynamics", "rating_range")
    target = P.cv("dynamics", "rating_start") + P.cv("dynamics", "rating_per_satisfaction") * r["satisfaction"]
    rating_before = s["rating"]
    s["rating"] = max(lo, min(hi, s["rating"] + P.cv("dynamics", "rating_speed") * (target - s["rating"])))
    s["neg_months"] = s["neg_months"] + 1 if s["cash"] < 0 else 0
    if s["neg_months"] >= P.cv("season", "closure_negative_months"):
        s["closed"] = True
        s["closed_reason"] = f"현금이 {P.cv('season', 'closure_negative_months')}달 연속 마이너스라 문을 닫았어요"
    status = "closed" if s["closed"] else ("finished" if i + 1 >= run["months_total"] else "open")
    month = {
        "month": i + 1, "calendar_month": cal, "status": status,
        "decisions": {"price_level": round(s["price"], 3), "hours": s["hours"], "staff": s["staff"], "marketing_krw": s["marketing"],
                      "delivery": s["delivery"], "choice": choice, "event_id": ev["id"]},
        "event": {"id": ev["id"], "title": ev["title"], "choice": choice, "choice_label": opt["label"], "downside": opt["downside"]},
        "random_events": rnd,
        "kpi": {"revenue_krw": round(r["revenue"]), "op_krw": round(r["op"]), "op_margin": round(r["op"] / r["revenue"], 3) if r["revenue"] else None,
                "cash_krw": round(s["cash"]), "covers": round(r["covers"]), "hall_covers": round(r["hall"]), "walkaways": round(r["walkaways"]), "walkaway_share": round(r["walk_share"], 3),
                "delivery_revenue_krw": round(r["delivery_revenue"]), "ticket_krw": round(r["ticket"]), "rating": round(s["rating"], 2),
                "rating_delta": round(s["rating"] - rating_before, 2), "satisfaction": round(r["satisfaction"], 3),
                "owner_pay_ref_krw": P.iv(cfg["industry"], "cost", "owner_pay_month_krw")},
        "pnl": {"revenue_krw": round(r["revenue"]), "lines": m.pnl_lines(r), "op_krw": round(r["op"])},
        "cash": {"start_krw": round(start_cash), "op_krw": round(r["op"]), "depreciation_addback_krw": round(r["depreciation"]),
                 "loan_interest_krw": round(interest), "loan_principal_krw": round(principal), "end_krw": round(s["cash"]),
                 "loan_balance_krw": round(s["loan_balance"])},
        "drivers": {k: round(v, 3) for k, v in r["drivers"].items()} | {"bottleneck": r["bottleneck"], "days_open": r["days_open"],
                                                                          "seat_units_day": round(r["seat_cap"] / max(1, r["days_open"]), 1),
                                                                          "crew_units_day": round(r["crew_cap"] / max(1, r["days_open"]), 1)},
        "owner_note_ko": _note(r, ev, opt, ctx, i),
        "closure": {"closed": s["closed"], "reason_ko": s["closed_reason"]},
        "_lines_raw": {k: round(v) for k, v in r["lines"].items()},
    }
    run["months"].append(month)
    return run, month


def public_month(run: dict, month: dict) -> dict:
    out = {k: v for k, v in month.items() if not k.startswith("_")}
    i = len(run["months"])
    if not run["state"]["closed"] and i < run["months_total"]:
        out["next_event"] = public_event(event_for(run, i))
        out["next_calendar_month"] = _calendar(run, i)
    return out


def replay(body: dict, decisions: list[dict]) -> dict:
    run = start(body)
    for d in decisions:
        run, _ = play_month(run, d)
    return run


# ---------------------------------------------------------------------------------------------- 결과

def season_summary(run: dict) -> dict:
    """LAB_CONTRACT의 SeasonSummary 모양 (score·modes 레인이 읽는다)."""
    b = run["body"]
    lines = []
    for mo in run["months"]:
        raw = mo["_lines_raw"] if "_lines_raw" in mo else {x["key"]: x["krw"] for x in mo["pnl"]["lines"]}
        lines.append({
            "month": mo["calendar_month"], "revenue": mo["kpi"]["revenue_krw"], "op": mo["kpi"]["op_krw"], "covers": mo["kpi"]["covers"],
            "cogs": raw["food"], "labor": raw["labor"], "rent": raw["rent"],
            "mgmt": raw["tax"] + raw["other"] + raw["marketing"] + raw["repair"], "fees": raw["card"] + raw["delivery"],
            "opex_detail": {"세금과 공과": raw["tax"], "기타 운영비": raw["other"], "마케팅·사건": raw["marketing"], "설비 수리": raw["repair"],
                            "카드 수수료": raw["card"], "배달 비용": raw["delivery"]},
            "cash_after": mo["kpi"]["cash_krw"], "satisfaction": mo["kpi"]["satisfaction"], "rating": mo["kpi"]["rating"],
            "walkaways": mo["kpi"]["walkaways"],
        })
    return {"industry": b["industry"], "mode": "free", "start_cash": run["start_cash_krw"], "opening_cost": run["capex"]["total_krw"],
            "loan": run["loan"]["principal_krw"], "loan_rate": run["loan"]["rate"], "months": lines, "closed": run["state"]["closed"],
            "closed_reason": run["state"]["closed_reason"],
            "inputs": {**b, "start_month": run["start_month"], "seed": run["seed"]}}


def report(run: dict) -> dict:
    ms = run["months"]
    ops = [x["kpi"]["op_krw"] for x in ms]
    best = max(ms, key=lambda x: x["kpi"]["op_krw"]) if ms else None
    worst = min(ms, key=lambda x: x["kpi"]["op_krw"]) if ms else None
    s = run["state"]
    name = INDUSTRIES[run["body"]["industry"]]["name"]
    if s["closed"]:
        summary = f"{_josa(name, '은는')} {len(ms)}개월째 문을 닫았어요. {s['closed_reason']}."
    elif ms:
        summary = f"{name} {len(ms)}개월 동안 영업이익 합계 {won(sum(ops))}, 남은 현금 {won(s['cash'])}이에요."
    else:
        summary = "아직 돌린 달이 없어요."
    walk = sum(x["kpi"]["walkaways"] for x in ms)
    return {
        "months_played": len(ms), "months_total": run["months_total"], "status": "closed" if s["closed"] else ("finished" if len(ms) >= run["months_total"] else "open"),
        "survived": not s["closed"], "cumulative_op_krw": sum(ops), "cumulative_revenue_krw": sum(x["kpi"]["revenue_krw"] for x in ms),
        "end_cash_krw": round(s["cash"]), "walkaways_total": walk,
        "best_month": {"month": best["month"], "calendar_month": best["calendar_month"], "op_krw": best["kpi"]["op_krw"]} if best else None,
        "worst_month": {"month": worst["month"], "calendar_month": worst["calendar_month"], "op_krw": worst["kpi"]["op_krw"]} if worst else None,
        "months": [{"month": x["month"], "calendar_month": x["calendar_month"], **{k: x["kpi"][k] for k in ("revenue_krw", "op_krw", "cash_krw", "covers", "walkaways", "rating")},
                    "event": x["event"]["title"], "choice": x["event"]["choice_label"]} for x in ms],
        "summary_ko": summary, "season_summary": season_summary(run), "grade": "L",
    }
