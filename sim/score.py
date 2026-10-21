"""6개월 성적표 (lab:score). SeasonSummary 하나로 100점 만점 점수를 낸다. 같은 입력이면 항상 같은 점수다.

    from sim.score import score
    out = score(summary)   # {"total", "band", "band_label", "parts", "fixes", "version"}

점수 구성 (합계 100)
  수익성 25   6개월 영업이익률과 마지막 두 달 이익률의 평균을 업계 영업이익률과 비교
  생존   20   폐업 여부, 현금이 바닥난 달, 끝까지 적자인지
  현금 여유 15  가장 낮았던 현금이 월 고정비(인건비+임차료+운영비)의 몇 달치인지
  손님   15   마지막 평점, 자리가 없어 돌아간 손님 비율, 첫 달 대비 마지막 달 손님 수
  비용 구조 15  재료비·인건비·임차료 비율을 업계 비율과 비교 (각 5점)
  위험 대응 10  초반 대비 회복, 가장 나빴던 달, 대출 비중

근거 (BENCH): 외식업체경영실태조사 2025 (농식품부·농경연, KOSIS org 114)
  고깃집: DT_114054_028 서울권 비용 구성 (식재료 39.3%, 고용인 14.7 + 대표자 13.7 + 가족 3.8 = 인건비 32.2%,
          임차료 8.5%, 영업이익 7.0%). 고깃집 엔진의 인건비에는 사장 가상 급여가 들어 있어 대표자·가족 인건비까지 더한 값과 비교한다.
  카페:   2025 원자료 독립 음료점 중앙값 (web/public/mock/cafe_cost.json: 식재료 40%, 고용인 인건비 11%, 임차료 10%,
          대표자 인건비 월 158만원, 영업이익률 10%). 카페 엔진은 사장 노동을 무급으로 두므로 비교할 때 대표자 인건비 중앙값을 뺀다.
  생존율: 통계청 기업생멸행정통계 (survival_kosis.json) 서울 숙박·음식점업 1년 생존율 69.2% (2023).
가정: 점수 곡선의 꺾이는 점(0점·만점 기준), 현금 3개월치, 평점·이탈 기준, 대출 비중 기준. 화면과 why에 '가정'으로 표시한다.
구간 (권고안): 90 이상 창업 적격, 60~89 훈련 필요, 60 미만 창업 재검토.
"""
from __future__ import annotations

import math
from typing import Any

VERSION = "score-v1"
SEASON_MONTHS = 6

BANDS = (  # (하한, key, label) 위에서부터 검사
    (90, "fit", "창업 적격"),
    (60, "train", "훈련 필요"),
    (0, "rethink", "창업 재검토"),
)
BAND_TEXT = {
    "fit": "이 계획이면 창업을 시작해도 될 만큼 준비가 됐어요",
    "train": "가능성은 있어요. 약한 부분을 한두 번 더 연습해 보세요",
    "rethink": "지금 조건으로는 위험이 커요. 창업 시점과 방식을 다시 생각해 보세요",
}

KOSIS_FOOD = "외식업체경영실태조사 2025"
BENCH: dict[str, dict[str, Any]] = {
    "bbq": {
        "label": "서울 외식업 평균", "src": f"{KOSIS_FOOD} 서울권, KOSIS",
        "margin": 0.070, "cogs": 0.393, "labor": 0.322, "rent": 0.085,
        "owner_wage_in_op": True, "owner_wage_month": 0,
    },
    "cafe": {
        "label": "독립 카페 중앙값", "src": f"{KOSIS_FOOD} 원자료 독립 음료점",
        "margin": 0.10, "cogs": 0.40, "labor": 0.11, "rent": 0.10,
        "owner_wage_in_op": False, "owner_wage_month": 1_584_167,
    },
}
# 업종 레인이 새 업종 기준을 넣기 전까지 쓰는 기본값: 서울권 외식업 평균 (인건비에 사장 몫이 들어 있다고 가정)
DEFAULT_BENCH = {**BENCH["bbq"], "label": "서울 외식업 평균 (업종 기준 없음, 가정)"}
SURVIVAL_1Y_SEOUL_FOOD = 69.2  # %, 통계청 기업생멸행정통계 2023, 서울 숙박·음식점업 1년 생존율

CASH_MONTHS_FULL = 3.0      # 가정: 가장 낮을 때도 월 고정비 3개월치가 남아 있으면 만점 (카페 엔진 운전자금 기준과 같음)
RATING_ZERO, RATING_MID, RATING_FULL = 3.0, 4.0, 4.5   # 가정: 엔진 시작 평점이 4.0
WALK_OK, WALK_ZERO = 0.03, 0.20                        # 가정
LOAN_OK, LOAN_ZERO = 0.30, 0.70                        # 가정: 전체 창업 자금 중 대출 비중


# ---------------------------------------------------------------- helpers
def _f(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _lerp(x: float, pts: list[tuple[float, float]]) -> float:
    """piecewise linear through (x, y) points, flat outside."""
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


def _r(x: float) -> int:
    """round half up, deterministic for display (no banker's rounding)."""
    return int(math.floor(x + 0.5))


def pct(x: float) -> str:
    return f"{_r(x * 100)}%"


def man(krw: float) -> str:
    v = _r(krw / 10_000)
    return f"{'−' if v < 0 else ''}{abs(v):,}만원"


def band_for(total: int) -> tuple[str, str]:
    for lo, key, label in BANDS:
        if total >= lo:
            return key, label
    return BANDS[-1][1], BANDS[-1][2]


def bench_for(industry: str) -> dict:
    return BENCH.get(str(industry), DEFAULT_BENCH)


# ---------------------------------------------------------------- facts (also used by the coach)
def facts(summary: dict) -> dict:
    """SeasonSummary → the numbers the score (and the coach) look at. Only numbers, never free text from inputs."""
    ms = [m for m in (summary.get("months") or []) if isinstance(m, dict)]
    ind = str(summary.get("industry") or "bbq")
    b = bench_for(ind)
    n = len(ms)
    g = lambda k: [_f(m.get(k)) for m in ms]  # noqa: E731
    rev, op = g("revenue"), g("op")
    R = sum(rev)
    owner = 0.0 if b["owner_wage_in_op"] else b["owner_wage_month"]
    adj = [o - owner for o in op]              # 사장 몫을 뺀 영업이익 (업계 영업이익률과 같은 기준)
    margin = sum(adj) / R if R > 0 else -1.0
    k2 = min(2, n)
    last2_rev, last2 = sum(rev[-k2:]), sum(adj[-k2:])
    first2_rev, first2 = sum(rev[:k2]), sum(adj[:k2])
    margin_last2 = last2 / last2_rev if last2_rev > 0 else -1.0
    margin_first2 = first2 / first2_rev if first2_rev > 0 else -1.0
    month_margins = [(a / r if r > 0 else -1.0) for a, r in zip(adj, rev)]
    cash = g("cash_after")
    start_cash = _f(summary.get("start_cash"))
    min_cash = min([start_cash] + cash) if ms else start_cash
    fixed = (sum(g("labor")) + sum(g("rent")) + sum(g("mgmt"))) / n if n else 0.0
    covers, walk = g("covers"), g("walkaways")
    ratings = [_f(m.get("rating"), float("nan")) for m in ms if m.get("rating") is not None]
    ratings = [x for x in ratings if math.isfinite(x)]
    opening, loan = _f(summary.get("opening_cost")), _f(summary.get("loan"))
    funds = start_cash + opening
    return {
        "industry": ind, "bench": b, "months": n, "closed": bool(summary.get("closed")),
        "closed_reason": summary.get("closed_reason") if summary.get("closed_reason") in ("cash", "revenue") else None,
        "revenue": R, "op": sum(op), "op_adj": sum(adj), "owner_wage_month": owner,
        "margin": margin, "margin_last2": margin_last2, "margin_first2": margin_first2,
        "worst_margin": min(month_margins) if month_margins else -1.0,
        "worst_month": ms[month_margins.index(min(month_margins))].get("month") if month_margins else None,
        "loss_months": sum(1 for o in adj if o < 0), "last2_loss": n >= 2 and all(o < 0 for o in adj[-2:]),
        "cogs_ratio": sum(g("cogs")) / R if R > 0 else 1.0,
        "labor_ratio": sum(g("labor")) / R if R > 0 else 1.0,
        "rent_ratio": sum(g("rent")) / R if R > 0 else 1.0,
        "mgmt_ratio": sum(g("mgmt")) / R if R > 0 else 1.0,
        "start_cash": start_cash, "min_cash": min_cash, "end_cash": cash[-1] if cash else start_cash,
        "negative_cash_months": sum(1 for c in cash if c < 0),
        "fixed_month": fixed, "cash_months": (min_cash / fixed) if fixed > 0 else (CASH_MONTHS_FULL if min_cash > 0 else 0.0),
        "rating_end": ratings[-1] if ratings else None,
        "walk_share": sum(walk) / (sum(covers) + sum(walk)) if (sum(covers) + sum(walk)) > 0 else 0.0,
        "covers_first": covers[0] if covers else 0.0, "covers_last": covers[-1] if covers else 0.0,
        "covers_trend": (covers[-1] / covers[0] - 1) if covers and covers[0] > 0 else 0.0,
        "loan": loan, "funds": funds, "loan_share": loan / funds if funds > 0 else (1.0 if loan > 0 else 0.0),
        "inputs": summary.get("inputs") if isinstance(summary.get("inputs"), dict) else {},
    }


# ---------------------------------------------------------------- parts
def _profit(F: dict) -> dict:
    b = F["bench"]["margin"]
    m = 0.5 * F["margin"] + 0.5 * F["margin_last2"] if F["months"] >= 3 else F["margin"]
    s = _lerp(m, [(-0.20, 0.0), (0.0, 10.0), (b, 20.0), (b + 0.06, 25.0)])
    owner = (f" 카페 엔진은 사장 노동을 무급으로 계산해서, 비교를 위해 대표자 인건비 중앙값 월 {man(F['owner_wage_month'])}을 뺐어요."
             if F["owner_wage_month"] else "")
    why = (f"6개월 영업이익률 {pct(F['margin'])}, 마지막 두 달 {pct(F['margin_last2'])}. "
           f"{F['bench']['label']}은 {pct(b)}예요 ({F['bench']['src']}).{owner} "
           f"손익분기(0%)면 10점, 업계 평균이면 20점 (점수 곡선은 가정).")
    return {"key": "profit", "label": "수익성", "max": 25, "raw": s, "why": why}


def _survival(F: dict) -> dict:
    base = (f"서울 음식점은 1년 안에 10곳 중 3곳이 문을 닫아요 (1년 생존율 {SURVIVAL_1Y_SEOUL_FOOD}%, "
            "통계청 기업생멸행정통계 2023).")
    if F["closed"]:
        s = 8.0 * min(F["months"], SEASON_MONTHS) / SEASON_MONTHS
        reason = {"cash": "현금이 두 달 연속 바닥나서", "revenue": "매출이 평소의 60% 아래로 두 달 이어져서"}.get(
            F["closed_reason"] or "", "")
        why = f"{F['months']}개월째에 {reason} 가게를 닫았어요. {base}"
        return {"key": "survival", "label": "생존", "max": 20, "raw": s, "why": why}
    s, notes = 20.0, []
    if F["negative_cash_months"]:
        s -= 6
        notes.append(f"현금이 마이너스인 달이 {F['negative_cash_months']}번 있었어요 (−6점)")
    if F["last2_loss"]:
        s -= 4
        notes.append("마지막 두 달도 적자라 아직 버티는 중이에요 (−4점)")
    why = f"{SEASON_MONTHS}개월을 버텼어요. " + (", ".join(notes) + ". " if notes else "") + base
    return {"key": "survival", "label": "생존", "max": 20, "raw": s, "why": why}


def _cash(F: dict) -> dict:
    cm = F["cash_months"]
    s = _lerp(cm, [(0.0, 0.0), (CASH_MONTHS_FULL, 15.0)])
    why = (f"가장 낮았던 현금 {man(F['min_cash'])}은 월 고정비(인건비·임차료·운영비) {man(F['fixed_month'])}의 "
           f"{max(0.0, cm):.1f}개월치예요. 3개월치 이상이면 만점 (가정).")
    return {"key": "cash", "label": "현금 여유", "max": 15, "raw": s, "why": why}


def _customer(F: dict) -> dict:
    r = F["rating_end"]
    if r is None:
        s_r, r_txt = 4.0, "평점 자료가 없어 중간 점수를 줬어요"
    else:
        s_r = _lerp(r, [(RATING_ZERO, 0.0), (RATING_MID, 5.0), (RATING_FULL, 8.0)])
        r_txt = f"마지막 평점 {r:.2f}점 (4.0이 시작 평점, 4.5 이상 만점)"
    s_w = _lerp(F["walk_share"], [(WALK_OK, 4.0), (WALK_ZERO, 0.0)])
    s_t = _lerp(F["covers_trend"], [(-0.20, 0.0), (0.10, 3.0)])
    why = (f"{r_txt}, 자리나 일손이 없어 돌아간 손님 {pct(F['walk_share'])}, "
           f"손님 수 첫 달 대비 마지막 달 {'+' if F['covers_trend'] >= 0 else '−'}{pct(abs(F['covers_trend']))}. "
           "평점 8점 + 이탈 4점 + 손님 추세 3점 (기준은 가정).")
    return {"key": "customer", "label": "손님", "max": 15, "raw": s_r + s_w + s_t, "why": why}


def _ratio_pts(r: float, b: float) -> float:
    return _lerp(r - b, [(0.02, 5.0), (0.15, 0.0)])


def _cost(F: dict) -> dict:
    b = F["bench"]
    parts = [("재료비", F["cogs_ratio"], b["cogs"]), ("인건비", F["labor_ratio"], b["labor"]), ("임차료", F["rent_ratio"], b["rent"])]
    s = sum(_ratio_pts(r, x) for _, r, x in parts)
    txt = ", ".join(f"{n} {pct(r)} (업계 {pct(x)})" for n, r, x in parts)
    lab = "인건비에 사장 가상 급여 포함" if b["owner_wage_in_op"] else "인건비는 직원 몫만"
    why = (f"매출 대비 {txt}. {lab}. 업계 비율 +2%p까지 만점, +15%p면 0점 "
           f"({b['src']}; 기울기는 가정).")
    return {"key": "cost", "label": "비용 구조", "max": 15, "raw": s, "why": why}


def _risk(F: dict) -> dict:
    b = F["bench"]["margin"]
    gain = F["margin_last2"] - F["margin_first2"]
    s_g = 4.0 if F["margin_last2"] >= b else _lerp(gain, [(0.0, 0.0), (0.05, 4.0)])
    s_w = _lerp(F["worst_margin"], [(-0.30, 0.0), (0.0, 3.0)])
    s_l = _lerp(F["loan_share"], [(LOAN_OK, 3.0), (LOAN_ZERO, 0.0)])
    wm = f"{F['worst_month']}월" if F["worst_month"] else "가장 나쁜 달"
    why = (f"첫 두 달 이익률 {pct(F['margin_first2'])} → 마지막 두 달 {pct(F['margin_last2'])}, "
           f"가장 나빴던 달({wm}) {pct(F['worst_margin'])}, 창업 자금 중 대출 {pct(F['loan_share'])}. "
           "회복 4점 + 최악의 달 3점 + 대출 비중 3점 (기준은 가정).")
    return {"key": "risk", "label": "위험 대응", "max": 10, "raw": s_g + s_w + s_l, "why": why}


# ---------------------------------------------------------------- fixes
def _num(inputs: dict, k: str) -> float | None:
    v = inputs.get(k)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def _fixes(F: dict, parts: list[dict]) -> list[dict]:
    """다음 판에 바꿔 볼 것. 점수를 가장 많이 잃은 부분부터, 업종별 실제 레버로. expected는 '다른 조건이 그대로일 때'의 단순 계산."""
    ind, b, inp, R = F["industry"], F["bench"], F["inputs"], F["revenue"]
    lost = {p["key"]: p["max"] - p["score"] for p in parts}
    out: list[dict] = []
    add = lambda key, text, lever, expected, w: out.append({"key": key, "text": text, "lever": lever, "expected": expected, "_w": w})  # noqa: E731

    gap = lambda r, x: max(0.0, r - x)  # noqa: E731
    lab_gap, rent_gap, cogs_gap = gap(F["labor_ratio"], b["labor"]), gap(F["rent_ratio"], b["rent"]), gap(F["cogs_ratio"], b["cogs"])
    if lab_gap > 0.02:
        save = man(lab_gap * R)
        if ind == "cafe":
            pol = inp.get("staff_policy")
            text = ("직원 운영을 한 단계 빠듯하게, 또는 영업시간을 짧게" if pol != "lean" else "영업시간을 짧게 (손님 적은 시간 빼기)")
            add("labor", text, "staff_policy" if pol != "lean" else "hours",
                f"인건비 비율 {pct(F['labor_ratio'])} → {pct(b['labor'])}이면 6개월 약 +{save} (단순 계산)", lost["cost"] + 3)
        else:
            staff = _num(inp, "staff_per_shift")
            cut = f"교대당 알바 {int(staff)}명 → {int(staff) - 1}명" if staff and staff >= 1 else "교대당 알바 한 명 줄이기, 또는 마감 한 시간 당기기"
            add("labor", cut, "staff_per_shift",
                f"인건비 비율 {pct(F['labor_ratio'])} → {pct(b['labor'])}이면 6개월 약 +{save} (단순 계산)", lost["cost"] + 3)
    if rent_gap > 0.02:
        add("rent", "평수를 줄이거나 월세가 낮은 자리로 (다음 판 가게 꾸미기에서)", "pyeong",
            f"임차료 비율 {pct(F['rent_ratio'])} → {pct(b['rent'])}이면 6개월 약 +{man(rent_gap * R)} (단순 계산)", lost["cost"] + 2)
    if cogs_gap > 0.02:
        if ind == "cafe":
            add("cogs", "디저트 폐기를 줄이거나 가격을 5% 올려 원가율 낮추기", "price_change_pct",
                f"재료비 비율 {pct(F['cogs_ratio'])} → {pct(b['cogs'])}이면 6개월 약 +{man(cogs_gap * R)} (단순 계산)", lost["cost"] + 1)
        else:
            add("cogs", "고기 등급을 한 단계 낮추거나 반찬 가짓수를 줄이기", "meat_grade",
                f"재료비 비율 {pct(F['cogs_ratio'])} → {pct(b['cogs'])}이면 6개월 약 +{man(cogs_gap * R)} (단순 계산)", lost["cost"] + 1)
    if lost["cash"] >= 5:
        need = CASH_MONTHS_FULL * F["fixed_month"] - F["min_cash"]
        add("cash", "문 열 때 운영자금을 더 남기기 (인테리어·평수를 줄이거나 자본금 늘리기)", "capital",
            f"가장 낮을 때도 고정비 3개월치({man(CASH_MONTHS_FULL * F['fixed_month'])})가 남으려면 약 {man(max(0.0, need))} 더 필요", lost["cash"])
    if F["walk_share"] > 0.08:
        lever = "staff_policy" if ind == "cafe" else "staff_per_shift"
        add("walk", "바쁜 시간에 일손이나 자리를 늘리기", lever,
            f"돌아간 손님 {pct(F['walk_share'])}의 절반만 받아도 손님이 약 {_r(F['walk_share'] / 2 * 100)}% 늘어요 (단순 계산)", lost["customer"] + 1)
    if F["rating_end"] is not None and F["rating_end"] < 3.8:
        if ind == "cafe":
            add("rating", "가격 인상을 되돌리거나 직원 운영을 넉넉하게", "price_change_pct",
                f"평점 {F['rating_end']:.2f}점 → 4.0점 이상이 목표 (평점이 손님 수를 정해요)", lost["customer"])
        else:
            add("rating", "가격을 1,000원 낮추거나 고기 등급·반찬을 올리기", "meat_price",
                f"평점 {F['rating_end']:.2f}점 → 4.0점 이상이 목표 (평점 1점 = 손님 약 ±7%, 엔진 가정)", lost["customer"])
    if F["margin"] < 0 and lab_gap <= 0.02 and rent_gap <= 0.02 and cogs_gap <= 0.02:
        add("demand", "비용은 업계 수준이에요. 손님이 부족하니 유동인구가 많은 동네나 작은 매장으로", "location",
            f"6개월 적자 {man(-F['op_adj'])}를 메우려면 매출이 약 {pct(-F['op_adj'] / R if R > 0 else 1)} 더 필요해요", lost["profit"] + 2)
    if F["loan_share"] > LOAN_OK + 0.1:
        add("loan", "대출 비중 낮추기 (창업 자금 중 대출 50% 아래)", "loan",
            f"지금 대출 비중 {pct(F['loan_share'])}, 대출 {man(F['loan'])}", lost["risk"])
    if F["closed"] and not out:
        add("closed", "가게를 닫게 된 달의 대응부터 다시 (다시 해보기)", "retry",
            f"{F['months']}개월째 폐업. 같은 조건에서 다른 대응을 고르면 결과가 달라져요", lost["survival"])
    if not out:
        weakest = max(parts, key=lambda p: p["max"] - p["score"])
        add("keep", f"가장 약한 부분은 '{weakest['label']}'이에요. 한 가지만 바꿔 다시 해 보세요", "retry",
            f"{weakest['label']} {weakest['score']}/{weakest['max']}점", 0)
    out.sort(key=lambda x: -x["_w"])
    return [{k: v for k, v in x.items() if k != "_w"} for x in out[:3]]


# ---------------------------------------------------------------- main
def score(summary: dict) -> dict:
    if not isinstance(summary, dict) or not summary.get("months"):
        raise ValueError("months가 비어 있어요")
    F = facts(summary)
    parts = [_profit(F), _survival(F), _cash(F), _customer(F), _cost(F), _risk(F)]
    for p in parts:
        p["score"] = max(0, min(p["max"], _r(p.pop("raw"))))
    total = sum(p["score"] for p in parts)
    band, label = band_for(total)
    return {
        "total": total, "band": band, "band_label": label, "band_text": BAND_TEXT[band],
        "parts": [{k: p[k] for k in ("key", "label", "score", "max", "why")} for p in parts],
        "fixes": _fixes(F, parts),
        "to_fit": max(0, 90 - total),
        "version": VERSION,
    }
