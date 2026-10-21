"""성적표 점수 분포 (lab:score). 엔진을 그럴듯한 입력 격자로 돌려 구간(적격·훈련·재검토)이 한쪽에 몰리지 않는지 본다.

    .venv/bin/python -m sim.score_grid            # 고깃집 + 카페, 구간별 개수와 점수 분포
    .venv/bin/python -m sim.score_grid --json     # 줄마다 입력과 점수

다른 레인(원가·메뉴·비용)이 엔진 숫자를 바꾼 뒤 lab/integrate에서 다시 돌려, 기본 실행이 전부 한 구간이면 구간을 조정한다.
점수 곡선(업계 비율, 생존율)은 근거에 묶여 있으니 여기 숫자에 맞춰 바꾸지 않는다. 고깃집은 처음 한 번 점포별 '평소' 계산에 몇 초씩 걸린다.
"""
from __future__ import annotations

import collections
import json
import sys

from sim.score import score

# 고깃집: (구 한식 점포당 월매출 만원, 평수, 평당 월세 만원) × 계획 × 운영자금. 매출·월세 범위는 web/public/mock 구별 값 안쪽.
BBQ_STORES = [(1800, 20, 12), (2578, 25, 17), (3500, 25, 20), (5000, 30, 23), (3000, 15, 15)]
BBQ_PLANS = [{"meat_price": 19000, "staff_per_shift": 2, "close_hour": 24},
             {"meat_price": 21000, "staff_per_shift": 1, "close_hour": 24},
             {"meat_price": 17000, "staff_per_shift": 3, "close_hour": 25},
             {"meat_price": 20000, "staff_per_shift": 2, "close_hour": 23, "marketing_budget": 500_000}]
BBQ_CASH = [30_000_000, 8_000_000]
CAFE_STORE = dict(tables=7, chairs=22, bar_seats=4, espresso_groups=2, showcase=1, oven=1, kiosks=1, pos=1)
CAFE_DISTRICTS = ["3120012", "11620630", "11560630"]   # 기준 상권 + 서울 동 두 곳
CAFE_SIZES = [(12, 4, 12), (20, 7, 22), (30, 10, 34)]
CAFE_DECS = [{}, {"price_change_pct": 10}, {"staff_policy": "lean", "hours": "long"}, {"hours": "short", "dessert": False}]


def bbq_runs(seed: int = 7) -> list[dict]:
    from sim import season as S
    from sim.store_input import from_changeup
    out = []
    for gs, py, rent in BBQ_STORES:
        tables = max(4, round(py * 0.4))
        store, patch = from_changeup(gu_sales_man=gs, pyeong=py, tables=tables, seats=tables * 4, cash_rent_man_per_pyeong=rent,
                                     staff=2, price=19000, baseline_runs=30, start_month=3)
        S.set_store(store)
        for plan in BBQ_PLANS:
            for cash in BBQ_CASH:
                st = S.new_season(seed, opening=True, cash=cash)
                p = {**S.base_plan(), **patch, **plan}
                ms = []
                for _ in range(6):
                    r = S.play_month(st, p, None, night=False, band_runs=3)
                    st, k = r["state_after"], r["draw"]["kpis"]
                    ms.append({"month": r["month"], **{x: k[x] for x in ("revenue", "op", "covers", "cogs", "labor", "rent", "mgmt", "fees", "walkaways")},
                               "cash_after": st["cash"], "rating": st["rating"]})
                    if st["closed"]:
                        break
                out.append({"industry": "bbq", "mode": "free", "start_cash": cash, "opening_cost": 120_000_000, "loan": 0,
                            "months": ms, "closed": st["closed"], "closed_reason": st["closed_reason"],
                            "inputs": {"gu_sales_man": gs, "pyeong": py, "rent_per_pyeong": rent, **plan}})
    S.set_store(None)
    return out


def cafe_runs(seed: int = 5) -> list[dict]:
    from sim.cafe import season as C
    out = []
    for d in CAFE_DISTRICTS:
        for py, tables, chairs in CAFE_SIZES:
            for dec in CAFE_DECS:
                run = C.start({**CAFE_STORE, "district": d, "size_pyeong": py, "tables": tables, "chairs": chairs,
                               "own_capital_krw": 200_000_000, "seed": seed})
                ms = []
                while True:
                    try:
                        run, mo = C.play_month(run, dec if not ms else {})
                    except C.SeasonOver:
                        break
                    m = C.public_month(mo)
                    L = {x["key"]: x["krw"] for x in m["pnl"]["lines"]}
                    cogs, rev, op = L["food"] + L["dessert_waste"], m["pnl"]["revenue_krw"], m["kpi"]["op_krw"]
                    ms.append({"month": m["calendar_month"], "revenue": rev, "op": op, "covers": m["kpi"]["customers"], "cogs": cogs,
                               "labor": L["labor"], "rent": L["rent"], "fees": L["card"],
                               "mgmt": rev - op - cogs - L["labor"] - L["rent"] - L["card"],
                               "cash_after": m["kpi"]["cash_krw"], "rating": m["kpi"]["rating"], "walkaways": m["kpi"]["walkaways"]})
                st = run["start"]
                out.append({"industry": "cafe", "mode": "free", "start_cash": st["cash_krw"], "opening_cost": st["capex_krw"],
                            "loan": st["loan_krw"], "months": ms, "closed": run["state"]["closed"],
                            "closed_reason": "cash" if run["state"]["closed"] else None,
                            "inputs": {"district": d, "size_pyeong": py, **dec}})
    return out


def distribution(runs: list[dict]) -> dict:
    tot = sorted(score(s)["total"] for s in runs)
    bands = collections.Counter(score(s)["band"] for s in runs)
    q = lambda f: tot[min(len(tot) - 1, int(f * len(tot)))] if tot else None  # noqa: E731
    return {"n": len(runs), "fit": bands["fit"], "train": bands["train"], "rethink": bands["rethink"],
            "min": tot[0] if tot else None, "p25": q(0.25), "median": q(0.5), "p75": q(0.75), "max": tot[-1] if tot else None}


def main() -> None:
    res = {"bbq": bbq_runs(), "cafe": cafe_runs()}
    if "--json" in sys.argv:
        for ind, runs in res.items():
            for s in runs:
                sc = score(s)
                print(json.dumps({"industry": ind, "inputs": s["inputs"], "total": sc["total"], "band": sc["band"]}, ensure_ascii=False))
        return
    for ind, runs in res.items():
        print(ind, distribution(runs))


if __name__ == "__main__":
    main()
