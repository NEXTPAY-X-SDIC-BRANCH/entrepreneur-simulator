"""6개월 결과의 '상위 몇 %'와 '놓친 것' (lab:standing). MVP는 엔진으로 미리 돌려 둔 판들과 비교한다.

    .venv/bin/python -m sim.standing build            # research/standing_baseline.json (고깃집 + 카페, 수십 분)
    .venv/bin/python -m sim.standing build --n 40     # 빨리 확인용
    from sim.standing import standing
    out = standing(summary)    # {"score", "top_pct", "n", "cohort", "hist", "missed": [...]}

비교 대상: 같은 업종, 같은 가진 돈 구간(BANDS)에서 구·평수·가격·알바 등 학습자가 고르는 값을 무작위로 바꿔 엔진(이지 모드와
같은 입력 규칙, 이달의 사건은 기본 대응)으로 6개월을 돌리고 sim.score 로 점수를 낸 판. 나중에 수강생 기록이 쌓이면 cohort 만
그 기록으로 바꾼다.
놓친 것: 그 구간 상위 10% 판이 많이 고른 값과 내 값이 다른 항목마다, 내 가게를 그 항목만 바꿔 엔진으로 다시 돌려 6개월
영업이익과 점수가 얼마나 달라지는지 잰다 (내 가게도 같은 규칙으로 다시 돌린 값과 비교). 시드 5개 평균이고, 5번 중 4번 이상
나아진 항목 중 효과가 큰 3개를 보여 준다.
"""
from __future__ import annotations

import json
import random
import statistics
import sys
import time
from pathlib import Path

from sim import easy as E
from sim.score import score

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "research" / "standing_baseline.json"
BANDS = [(0, 5000, "5천만원 미만"), (5000, 10000, "5천만~1억원"), (10000, 10 ** 9, "1억원 이상")]   # 가진 돈 (만원)
CAPITALS = [3000, 4000, 5000, 7000, 9000, 12000, 15000]
BAND_RUNS = 3                 # 한 달 손님 흔들기 횟수 (score_grid 와 같음, 빠르게)
BASELINE_RUNS = 30            # 새 점포의 '평소' 계산 횟수 (score_grid 와 같음)
# 놓친 것: 계획을 바꾸면 이달의 사건 뽑기도 달라져 한 번 돌린 차이는 흔들린다 (반찬 하나에 −12~+3점). 시드 5개로 돌려 평균을 내고,
# 6개월 영업이익이 5번 중 4번 이상 나아진 항목만 보여 준다
SEEDS = (E.EASY_SEED, 11, 23, 37, 51)
MIN_WINS = 4

# 학습자가 고르는 값. (키, 화면 이름, 고를 수 있는 값, 보여 줄 모양). 값 목록은 하드 모드 화면의 범위 안
LEVERS: dict[str, list[tuple[str, str, list, str]]] = {
    "bbq": [
        ("pyeong", "평수", [12, 15, 18, 20, 22, 25, 28, 30], "{}평"),
        ("staff", "교대당 알바", [0, 1, 2, 3], "{}명"),
        ("price", "삼겹살 1인분", [16000, 17000, 18000, 19000, 20000, 21000, 22000, 23000], "{:,}원"),
        ("close_hour", "마감 시간", [23, 24, 25], "close"),
        ("marketing_budget", "SNS 홍보", [0, 500_000, 1_500_000], "won"),
        ("meat_grade", "고기 등급", ["imported", "domestic", "aged"], "grade"),
        ("banchan", "반찬 가짓수", [3, 4, 5, 6, 7, 8], "{}가지"),
        ("delivery", "배달", ["none", "mid50_80"], "delivery"),
    ],
    "cafe": [
        ("pyeong", "평수", [10, 12, 14, 16, 18, 20, 23, 26, 30], "{}평"),
        ("staff", "바쁜 시간 직원", [0, 1, 2, 3], "{}명"),
        ("price_change_pct", "첫 달 가격 조정", [-10, 0, 5, 10], "pct"),
        ("hours", "영업시간", ["short", "standard", "long"], "hours"),
        ("marketing_krw", "홍보비 (월)", [0, 300_000, 1_000_000], "won"),
        ("dessert", "디저트", [True, False], "yesno"),
        ("delivery", "배달앱", [False, True], "yesno"),
    ],
}
PLAN_KEYS = ("close_hour", "marketing_budget", "meat_grade", "banchan", "delivery")
# 화면이 안 보낸 값은 엔진 기본값으로 본다 (이지 모드는 이 값들을 고르지 않는다)
DEFAULTS = {"bbq": {"close_hour": 24, "marketing_budget": 0, "meat_grade": "domestic", "banchan": 5, "delivery": "none"},
            "cafe": {"price_change_pct": 0, "marketing_krw": 0, "dessert": True, "delivery": False}}
CAFE_DEC_KEYS = ("price_change_pct", "hours", "marketing_krw", "dessert", "delivery")
WORDS = {"close": {23: "밤 11시", 24: "밤 12시", 25: "새벽 1시"}, "grade": {"imported": "수입 냉동", "domestic": "국내산", "aged": "숙성"},
         "delivery": {"none": "안 함", "mid50_80": "배달앱 입점"}, "hours": {"short": "짧게", "standard": "보통", "long": "길게"},
         "yesno": {True: "함", False: "안 함"}}
GUS = ["강남구", "강동구", "강북구", "강서구", "관악구", "광진구", "구로구", "금천구", "노원구", "도봉구", "동대문구", "동작구", "마포구",
       "서대문구", "서초구", "성동구", "성북구", "송파구", "양천구", "영등포구", "용산구", "은평구", "종로구", "중구", "중랑구"]


def show(ind: str, key: str, v) -> str:
    fmt = next(f for k, _, _, f in LEVERS[ind] if k == key)
    if fmt in WORDS:
        return WORDS[fmt].get(v, str(v))
    if fmt == "won":
        return "안 함" if not v else f"{int(v) // 10000:,}만원"
    if fmt == "pct":
        return "그대로" if not v else f"{int(v):+d}%"
    return fmt.format(v)


def band_of(capital_man: float) -> tuple[int, int, str]:
    return next(b for b in BANDS if b[0] <= capital_man < b[1])


# ---- 한 판 돌리기 ----------------------------------------------------------------------------------------------
def run_bbq(gu: str, capital_man: float, lv: dict, seed: int = E.EASY_SEED) -> dict:
    """이지 모드 입력 규칙(sim.easy.easy_bbq)에 고른 값을 넣어 6개월. 돌려주는 값은 화면 lab/modes/summary.ts bbqSummary 모양."""
    from sim import season as S
    from sim.params import load_params
    from sim.store_input import from_changeup
    from sim.venture import venture_ledger
    ov = {"pyeong": lv.get("pyeong"), "tables": lv.get("tables"), "staff": lv.get("staff"), "price": lv.get("price")}
    inp = E.easy_bbq(gu, capital_man, overrides={k: v for k, v in ov.items() if v is not None})
    run, spec = inp["run"], inp["run"]["store"]
    store, patch = from_changeup(gu_sales_man=float(spec["gu_sales_man"]), pyeong=float(spec["pyeong"]), tables=int(spec["tables"]),
                                 seats=int(spec["seats"]), cash_rent_man_per_pyeong=float(spec["cash_rent_man_per_pyeong"]),
                                 staff=int(spec["staff"]), price=int(spec["price"]), baseline_runs=BASELINE_RUNS,
                                 quarter_index=spec.get("quarter_index"), area_type=spec.get("area_type"),
                                 start_month=spec.get("start_month"), flow=spec.get("flow"))
    S.set_store(store)
    plan = {**S.base_plan(), **patch, **run["plan"], **{k: lv[k] for k in PLAN_KEYS if lv.get(k) is not None}}
    invest, loan, own = run["invest"], run["loan"], run["own_capital"]
    start_cash = own + (loan["principal"] if loan else 0.0) - sum(invest.values())
    state = S.new_season(seed, opening=True, cash=max(0.0, start_cash))
    rows, ops, rents = [], [], []
    for _ in range(len(S.months())):
        if state["closed"]:
            break
        r = S.play_month(state, plan, None, night=False, band_runs=BAND_RUNS)
        state = r["state_after"]
        k = r["draw"]["kpis"]
        rows.append((r["month"], k, state["rating"], state["cash"]))
        ops.append(float(k["op"])); rents.append(float(k["rent"]))
    led = venture_ledger(ops, invest, loan, own_capital=own, owner_draw=run["owner_draw"],
                         imputed_owner_wage=float(load_params()["cst_owner_imputed_wage"]), monthly_rent=rents)
    months = [{"month": m, "revenue": k["revenue"], "op": k["op"], "covers": k["covers"], "cogs": k["cogs"], "labor": k["labor"],
               "rent": k["rent"], "mgmt": k["mgmt"], "fees": k["fees"],
               "cash_after": led["rows"][i]["cash"] if i < len(led["rows"]) else cash, "satisfaction": k.get("satisfaction"),
               "rating": rating, "walkaways": k["walkaways"]} for i, (m, k, rating, cash) in enumerate(rows)]
    return {"industry": "bbq", "mode": "free", "start_cash": led["start_cash"], "opening_cost": sum(invest.values()),
            "loan": loan["principal"] if loan else 0, "loan_rate": loan["annual_rate"] if loan else None, "months": months,
            "closed": bool(state["closed"]), "closed_reason": state["closed_reason"],
            "inputs": {"gu": gu, "capital_man": capital_man, **{k: v for k, v in lv.items() if v is not None},
                       "pyeong": inp["store"]["pyeong"], "tables": inp["store"]["tables"], "staff": inp["staff"], "price": inp["price"]}}


def run_cafe(gu: str, capital_man: float, lv: dict, seed: int | None = None) -> dict:
    """카페 이지 입력(sim.easy.easy_cafe)에 고른 값을 넣어 6개월. 결정은 첫 달에 정하고 그대로 둔다 (가격 조정은 첫 달 한 번).
    돌려주는 값은 화면 lab/modes/summary.ts cafeSummary 모양."""
    from sim.cafe import season as cs
    ov = {"pyeong": lv.get("pyeong"), "staff": lv.get("staff")}
    inp = E.easy_cafe(gu, capital_man, overrides={k: v for k, v in ov.items() if v is not None})
    run = cs.start({**inp["run"], **({"seed": seed} if seed is not None else {})})
    dec = {k: lv[k] for k in CAFE_DEC_KEYS if lv.get(k) is not None}
    out = []
    while not run["state"]["closed"] and len(run["months"]) < run["months_total"]:
        run, m = cs.play_month(run, dec if not out else {})
        out.append(cs.public_month(m))
    st = cs.public_start(run)
    months = []
    for m in out:
        L = m["pnl"]["lines"]
        sm = lambda f: sum(x["krw"] for x in L if f(x["key"]))  # noqa: E731
        dep = m["pnl"].get("depreciation_krw") or 0
        detail = {x["item_ko"]: x["krw"] for x in L if x["key"] not in ("food", "card", "rent", "labor") and x["krw"]}
        if dep:
            detail["감가상각"] = dep
        months.append({"month": m["calendar_month"], "revenue": m["kpi"]["revenue_krw"], "op": m["kpi"]["op_krw"],
                       "covers": m["kpi"]["customers"], "cogs": sm(lambda k: k == "food"), "labor": sm(lambda k: k == "labor"),
                       "rent": sm(lambda k: k == "rent"), "mgmt": sm(lambda k: k not in ("food", "card", "labor", "rent")) + dep,
                       "fees": sm(lambda k: k == "card"), "opex_detail": detail, "cash_after": m["kpi"]["cash_krw"],
                       "rating": m["kpi"]["rating"], "walkaways": m["kpi"]["walkaways"]})
    rep = cs.report(run)
    return {"industry": "cafe", "mode": "free", "start_cash": st["start"]["cash_krw"], "opening_cost": st["start"]["capex_krw"],
            "loan": st["start"]["loan_krw"], "loan_rate": st["loan"]["rate"], "months": months, "closed": not rep["survived"],
            "closed_reason": out[-1]["closure"].get("reason_ko") if out else None,
            "inputs": {"gu": gu, "capital_man": capital_man, **{k: v for k, v in lv.items() if v is not None}, "pyeong": inp["pyeong"],
                       "staff": inp["staff"]}}


def run_case(ind: str, gu: str, capital_man: float, lv: dict, seed: int | None = None) -> dict:
    """엔진 전역(점포 설정)을 바꾸므로 서버에서는 api.changeup._LOCK 안에서 부른다 (api/lab_modes.py /lab/standing)."""
    if ind == "bbq":
        return run_bbq(gu, capital_man, lv, seed=seed if seed is not None else E.EASY_SEED)
    return run_cafe(gu, capital_man, lv, seed=seed)


# ---- 기준 판 만들기 --------------------------------------------------------------------------------------------
def _sample(ind: str, rng: random.Random, fixed: dict | None = None) -> dict:
    lv = {k: rng.choice(vals) for k, _, vals, _ in LEVERS[ind]}
    return {**lv, **(fixed or {})}


def build(n: int = 600, seed: int = 11, per_store: int = 4) -> dict:
    """업종마다 n판. 고깃집은 점포(구·평수)를 바꿀 때 '평소' 계산이 몇 초 걸려 점포 하나에 운영 선택 per_store 개를 돌린다."""
    rng = random.Random(seed)
    rows: dict[str, list[dict]] = {}
    t0 = time.time()
    for ind in ("bbq", "cafe"):
        rows[ind] = []
        while len(rows[ind]) < n:
            gu, cap = rng.choice(GUS), rng.choice(CAPITALS)
            store = _sample(ind, rng)
            for _ in range(per_store if ind == "bbq" else 1):
                lv = _sample(ind, rng, {"pyeong": store["pyeong"]})
                try:
                    s = run_case(ind, gu, cap, lv)
                    sc = score(s)
                except (ValueError, KeyError) as e:   # 그 돈으로 열 수 없는 조합 등은 건너뛴다
                    print(f"  skip {ind} {gu} {cap} {lv}: {e}", file=sys.stderr)
                    continue
                rows[ind].append({"gu": gu, "capital_man": cap, "levers": {k: s["inputs"].get(k) for k, *_ in LEVERS[ind]},
                                  "total": sc["total"], "cum_op": round(sum(m["op"] for m in s["months"])), "closed": s["closed"]})
            print(f"{ind} {len(rows[ind])}/{n}  {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    out = {"version": 1, "built": time.strftime("%Y-%m-%d"), "seed": seed, "note": "엔진으로 돌린 판 (sim/standing.py build). 수강생 기록이 아님",
           "rows": rows}
    BASELINE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


_BASE: dict | None = None


def baseline() -> dict:
    global _BASE
    if _BASE is None:
        _BASE = json.loads(BASELINE.read_text(encoding="utf-8"))
    return _BASE


# ---- 내 판의 자리와 놓친 것 -------------------------------------------------------------------------------------
def my_levers(summary: dict) -> tuple[str, float, dict]:
    """화면이 보낸 SeasonSummary 의 inputs 에서 구, 가진 돈(만원), 고른 값을 꺼낸다 (이지·하드, 고깃집·카페 이름이 조금 다름)."""
    ind, i = summary["industry"], summary.get("inputs") or {}
    cap = i.get("capital_man")
    if cap is None and i.get("capital") is not None:
        cap = float(i["capital"]) / 1e4
    lv = {}
    for k, _, vals, _ in LEVERS[ind]:
        v = i.get(k)
        if ind == "bbq" and k == "staff":
            v = i.get("staff_per_shift", v)
        if ind == "bbq" and k == "price":
            v = i.get("meat_price", v)
        if v is None:
            v = DEFAULTS[ind].get(k)
        if v is not None:
            lv[k] = v
    return ind, float(cap or 0), lv


def _top_value(ind: str, key: str, rows: list[dict]):
    vals = [r["levers"].get(key) for r in rows if r["levers"].get(key) is not None]
    if not vals:
        return None
    num = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals)
    if num:
        choices = next(c for k, _, c, _ in LEVERS[ind] if k == key)
        med = statistics.median(vals)
        return min(choices, key=lambda c: abs(c - med))
    return max(set(vals), key=vals.count)


def standing(summary: dict, max_missed: int = 3) -> dict:
    if summary.get("industry") not in LEVERS:
        raise ValueError("고깃집과 카페만 비교할 수 있어요")
    ind, cap, lv = my_levers(summary)
    me = score(summary)["total"]
    lo, hi, label = band_of(cap)
    rows = [r for r in baseline()["rows"][ind] if lo <= r["capital_man"] < hi]
    n = len(rows)
    above = sum(1 for r in rows if r["total"] > me)
    top_pct = max(1, min(100, round(100 * (above + 1) / max(1, n + 1))))
    hist = [0] * 10
    for r in rows:
        hist[min(9, int(r["total"] // 10))] += 1
    cut = sorted((r["total"] for r in rows), reverse=True)[max(0, n // 10 - 1)] if n else 100
    top = [r for r in rows if r["total"] >= cut]
    out = {"score": me, "top_pct": top_pct, "n": n, "cohort": f"{'고깃집' if ind == 'bbq' else '카페'}, 가진 돈 {label}",
           "source": "engine", "hist": hist, "top_cut": cut, "missed": []}
    gu = (summary.get("inputs") or {}).get("gu")
    if not gu or not top:
        return out
    cands = []
    for k, name, _, _ in LEVERS[ind]:
        tv = _top_value(ind, k, top)
        if tv is None or lv.get(k) is None or tv == lv.get(k):
            continue
        cands.append((k, name, tv))
    if not cands:
        return out
    res = lambda s: (score(s)["total"], sum(m["op"] for m in s["months"]))  # noqa: E731
    try:
        base = {sd: res(run_case(ind, gu, cap, lv, sd)) for sd in SEEDS}
        found = []
        for k, name, tv in cands:
            d = [(a[0] - base[sd][0], a[1] - base[sd][1]) for sd in SEEDS for a in [res(run_case(ind, gu, cap, {**lv, k: tv}, sd))]]
            found.append({"key": k, "label": name, "mine": show(ind, k, lv[k]), "top": show(ind, k, tv),
                          "d_score": round(statistics.mean(x[0] for x in d)), "d_op_krw": round(statistics.mean(x[1] for x in d)),
                          "wins": sum(1 for x in d if x[1] > 0), "runs": len(d)})
    except (ValueError, KeyError):
        return out
    found.sort(key=lambda x: (x["d_score"], x["d_op_krw"]), reverse=True)
    out["missed"] = [f for f in found if f["wins"] >= MIN_WINS and f["d_op_krw"] > 0][:max_missed]
    out["rerun_score"] = round(statistics.mean(b[0] for b in base.values()))
    return out


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "build":
        n = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 600
        res = build(n)
        for ind, rs in res["rows"].items():
            tot = sorted(r["total"] for r in rs)
            print(ind, len(rs), "min", tot[0], "median", tot[len(tot) // 2], "max", tot[-1])
    else:
        print(__doc__)
