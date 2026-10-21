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
  고깃집: DT_114054_028 사업실적 서울권 2025: 매출 100 = 식재료 39.3 + 고용인 인건비 14.7 + 가족 종사자 인건비 3.8
          + 대표자 인건비 13.7 + 임차료 8.5 + 세금 6.6 + 기타 6.5 + 영업이익 7.0 (%). 대표자 인건비는 비용 줄에 있고 영업이익은
          그것을 뺀 뒤다. 엔진 영업이익도 사장 가상 급여(cst_owner_imputed_wage 월 300만원)를 뺀 값이라 이익률은 그대로 비교한다.
          인건비는 같은 기준으로 맞추려고 엔진 인건비에서 사장 몫을 빼고(정직원·알바만) 고용인 인건비(C2-2) 14.7%와 비교한다.
          참고로 사장 몫을 넣은 전체 인건비는 고용인+가족+대표자(C2-2+C2-5+C2-6) 32.2%와 같이 보여 준다 (점수에는 안 씀).
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
        "margin": 0.070, "cogs": 0.393, "labor": 0.147, "rent": 0.085, "labor_total": 0.322,
        "owner_wage_in_op": True, "owner_wage_month": 0,
        "owner_in_labor": 3_000_000,   # 엔진 인건비에 들어 있는 사장 가상 급여 (research/hero_base.yaml cst_owner_imputed_wage)
        "labor_def": "정직원·알바 인건비(사장 가상 급여 제외)를 업계 고용인 인건비와 비교해요",
        "def": ("외식업체경영실태조사 2025 사업실적(KOSIS DT_114054_028) 서울권: 매출 = 식재료 39.3 + 고용인 인건비 14.7 + 가족 3.8 "
                "+ 대표자 인건비 13.7 + 임차료 8.5 + 세금 6.6 + 기타 6.5 + 영업이익 7.0(%). 서울권은 97%가 임차 매장이라 임차료는 그대로 비교"),
    },
    "cafe": {
        "label": "독립 카페 중앙값", "src": f"{KOSIS_FOOD} 원자료 독립 음료점",
        "margin": 0.10, "cogs": 0.40, "labor": 0.11, "rent": 0.109,   # 임차료: 10% × 임차 매장 월세 103.5 / 전체 95 (자가 0 포함) = 임차 매장 기준
        "owner_wage_in_op": False, "owner_wage_month": 1_584_167, "owner_in_labor": 0,
        "labor_def": "직원 인건비(사장은 무급)를 업계 고용인 인건비와 비교해요", "labor_total": None,
        "def": ("외식업체경영실태조사 2025 원자료, 독립 음료점 중앙값: 식재료 40%, 고용인 인건비 11%, 임차료 10%, "
                "대표자 인건비 월 158만원(별도), 영업이익률 10%(대표자 인건비를 뺀 뒤). 임차료 10%는 자가 매장을 0으로 넣은 값이라 "
                "임차 매장 기준(월 103.5만원 ÷ 95만원)으로 바꿔 약 11%와 비교"),
    },
}
# 업종 레인이 새 업종 기준을 넣기 전까지 쓰는 기본값: 서울권 외식업 평균 (인건비에 사장 몫이 들어 있다고 가정)
DEFAULT_BENCH = {**BENCH["bbq"], "label": "서울 외식업 평균 (업종 기준 없음, 가정)", "owner_in_labor": 0}
SURVIVAL_1Y_SEOUL_FOOD = 69.2  # %, 통계청 기업생멸행정통계 2023, 서울 숙박·음식점업 1년 생존율

# 고깃집 엔진의 알바 한 명 월 인건비: 시급 10,320원(2026 최저임금) × 5시간 × 26일 × 주휴 1.33 (research/hero_base.yaml)
PARTTIMER_MONTH = 10_320 * 5 * 26 * 1.33
RENT_FIX_AT = 0.20   # 가정: 매출 대비 임차료가 이보다 클 때만 '평수·자리 바꾸기'를 권한다
SIDE_STAFF = "대기 시간과 돌아간 손님 변화는 이 계산에 없어요, 다음 판 시뮬레이션에서 확인"
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


def _month(x: Any) -> int | None:
    v = _f(x, 0.0)
    return int(v) if v == int(v) and 1 <= v <= 12 else None


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
    dep = sum(_f((m.get("opex_detail") or {}).get("depreciation")) for m in ms if isinstance(m.get("opex_detail"), dict))
    fixed = (sum(g("labor")) + sum(g("rent")) + sum(g("mgmt")) - dep) / n if n else 0.0   # 감가상각은 현금이 안 나가서 뺀다
    inp = summary.get("inputs") if isinstance(summary.get("inputs"), dict) else {}
    ow = inp.get("owner_wage_month")
    owner_in_labor = float(ow) if isinstance(ow, (int, float)) and not isinstance(ow, bool) and 0 <= ow < 1e8 else b["owner_in_labor"]
    hired = max(0.0, sum(g("labor")) - owner_in_labor * n)
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
        "worst_month": _month(ms[month_margins.index(min(month_margins))].get("month")) if month_margins else None,
        # 적자 판단은 화면의 영업이익(사장 몫을 빼기 전) 그대로. 업계 비교(adj)는 수익성·위험 대응 점수에만 쓴다
        "loss_months": sum(1 for o in op if o < 0), "last2_loss": n >= 2 and all(o < 0 for o in op[-2:]),
        "cogs_ratio": sum(g("cogs")) / R if R > 0 else 1.0,
        "labor_ratio": hired / R if R > 0 else 1.0, "labor_total_ratio": sum(g("labor")) / R if R > 0 else 1.0,
        "owner_in_labor": owner_in_labor,
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
        "inputs": inp,
    }


# ---------------------------------------------------------------- parts
def _profit(F: dict) -> dict:
    b = F["bench"]["margin"]
    m = 0.5 * F["margin"] + 0.5 * F["margin_last2"] if F["months"] >= 3 else F["margin"]
    s = _lerp(m, [(-0.20, 0.0), (0.0, 10.0), (b, 20.0), (b + 0.06, 25.0)])
    owner = (f" 카페 엔진은 사장 노동을 무급으로 계산해서, 비교를 위해 대표자 인건비 중앙값 월 {man(F['owner_wage_month'])}을 뺐어요."
             if F["owner_wage_month"] else
             f" 영업이익은 사장 가상 급여(월 {man(F['owner_in_labor'])})를 뺀 값이라 업계 영업이익(대표자 인건비를 뺀 값)과 같은 기준이에요."
             if F["owner_in_labor"] else "")
    adjtxt = " (사장 인건비를 뺀 뒤)" if F["owner_wage_month"] else ""
    why = (f"{F['months']}개월 영업이익률{adjtxt} {pct(F['margin'])}, 마지막 두 달 {pct(F['margin_last2'])}. "
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
    why = f"{F['months']}개월을 버텼어요. " + (", ".join(notes) + ". " if notes else "") + base
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
    tot = (f" 사장 몫을 넣은 전체 인건비는 {pct(F['labor_total_ratio'])} (업계 고용인+가족+대표자 {pct(b['labor_total'])}, 점수에는 안 씀)."
           if b.get("labor_total") and F["owner_in_labor"] else "")
    why = (f"매출 대비 {txt}. {b['labor_def']}.{tot} 업계 비율 +2%p까지 만점, +15%p면 0점 (기울기는 가정). "
           f"근거: {b['def']}.")
    return {"key": "cost", "label": "비용 구조", "max": 15, "raw": s, "why": why}


def _risk(F: dict) -> dict:
    b = F["bench"]["margin"]
    gain = F["margin_last2"] - F["margin_first2"]
    s_g = 4.0 if F["margin_last2"] >= b else _lerp(gain, [(0.0, 0.0), (0.05, 4.0)])
    if F["margin_last2"] < 0:   # 좋아졌어도 아직 적자면 회복 점수는 절반까지만
        s_g = min(s_g, 2.0)
    s_w = _lerp(F["worst_margin"], [(-0.30, 0.0), (0.0, 3.0)])
    s_l = _lerp(F["loan_share"], [(LOAN_OK, 3.0), (LOAN_ZERO, 0.0)])
    wm = f"{F['worst_month']}월" if F["worst_month"] else "가장 나쁜 달"
    adjtxt = "(사장 인건비를 뺀 뒤) " if F["owner_wage_month"] else ""
    why = (f"첫 두 달 이익률 {adjtxt}{pct(F['margin_first2'])} → 마지막 두 달 {pct(F['margin_last2'])}, "
           f"가장 나빴던 달({wm}) {pct(F['worst_margin'])}, 창업 자금 중 대출 {pct(F['loan_share'])}. "
           "회복 4점(아직 적자면 2점까지) + 최악의 달 3점 + 대출 비중 3점 (기준은 가정).")
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
                f"인건비 비율 {pct(F['labor_ratio'])} → {pct(b['labor'])}이면 {F['months']}개월 약 +{save} (단순 계산). {SIDE_STAFF}", lost["cost"] + 1 + lab_gap * 10)
        else:
            staff = _num(inp, "staff_per_shift")
            if staff and staff >= 1:
                one = PARTTIMER_MONTH * F["months"]
                after = max(0.0, F["labor_ratio"] - one / R) if R > 0 else F["labor_ratio"]
                add("labor", f"교대당 알바 {int(staff)}명 → {int(staff) - 1}명", "staff_per_shift",
                    f"알바 한 명은 월 약 {man(PARTTIMER_MONTH)}(최저임금 시급·주휴 포함, 엔진 기준), {F['months']}개월 약 {man(one)} 줄어요. "
                    f"인건비 비율 {pct(F['labor_ratio'])} → {pct(after)} (단순 계산). {SIDE_STAFF}", lost["cost"] + 1 + lab_gap * 10)
            else:
                add("labor", "마감을 한 시간 당기거나 손님 적은 요일 영업 줄이기", "close_hour",
                    f"인건비 비율 {pct(F['labor_ratio'])}, 업계 고용인 인건비 {pct(b['labor'])}. {SIDE_STAFF}", lost["cost"] + 1 + lab_gap * 10)
    if F["rent_ratio"] > RENT_FIX_AT and rent_gap > 0.02:   # 엔진 월세는 시세라 첫 6개월엔 비율이 높기 쉽다: 20%를 넘을 때만 권한다
        add("rent", "평수를 줄이거나 월세가 낮은 자리로 (다음 판 가게 꾸미기에서)", "pyeong",
            f"임차료 비율 {pct(F['rent_ratio'])} → {pct(b['rent'])}이면 {F['months']}개월 약 +{man(rent_gap * R)} (단순 계산). "
            "좌석이 줄면 손님도 줄 수 있어요, 다음 판 시뮬레이션에서 확인", lost["cost"] + rent_gap * 10)
    if cogs_gap > 0.02:
        if ind == "cafe":
            add("cogs", "디저트 폐기를 줄이거나 가격을 5% 올려 원가율 낮추기", "price_change_pct",
                f"재료비 비율 {pct(F['cogs_ratio'])} → {pct(b['cogs'])}이면 {F['months']}개월 약 +{man(cogs_gap * R)} (단순 계산). "
                "가격을 올리면 손님이 줄 수 있어요, 다음 판 시뮬레이션에서 확인", lost["cost"] + cogs_gap * 10)
        else:
            add("cogs", "고기 등급을 한 단계 낮추거나 반찬 가짓수를 줄이기", "meat_grade",
                f"재료비 비율 {pct(F['cogs_ratio'])} → {pct(b['cogs'])}이면 {F['months']}개월 약 +{man(cogs_gap * R)} (단순 계산). "
                "맛 평가와 평점이 내려갈 수 있어요, 다음 판 시뮬레이션에서 확인", lost["cost"] + cogs_gap * 10)
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
            (f"{F['months']}개월 적자 {man(-F['op'])}를 메우려면 매출이 약 {pct(-F['op'] / R if R > 0 else 1)} 더 필요해요" if F["op"] < 0 else
             f"업계 이익률 {pct(b['margin'])}까지 매출이 더 필요해요 (지금 {pct(F['margin'])})"), lost["profit"] + 2)
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
