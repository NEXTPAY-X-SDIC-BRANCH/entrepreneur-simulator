"""ChangeUp 엔진 서버. 시즌 엔진(sim.season)과 투자·대출 계층(sim.venture)만 얇게 감싼다.

    uvicorn api.changeup:app --host 127.0.0.1 --port 8010

DB, LLM, 임베딩은 쓰지 않는다 (기존 api/main.py와 별개). 상태는 서버에 저장하지 않고 요청마다 주고받는다.
그래서 화면의 되감기(스냅샷)는 클라이언트가 받은 state를 들고 있다가 다시 보내면 된다.

    POST /season/new     신규 오픈 시작 상태
    POST /season/start   한 달의 사건과 토요일 밤 결정 상황(선택지)
    POST /season/play    한 달 진행 (상태, 계획, 사건, 밤 결정 선택 → 결과와 다음 상태)
    POST /season/run     6개월을 한 번에 돌리고 투자·대출 장부까지 계산
    POST /venture        월별 영업이익 목록만 주고 현금 장부와 회수 시점 계산
    GET/POST /scores     6개월 성적표 점수 랭킹 (반 코드별, data/scores.json)
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from sim import season as S
from sim.params import load_params
from sim.store_input import from_changeup
from sim.venture import venture_ledger

app = FastAPI(title="ChangeUp engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5174", "http://localhost:5174", "http://127.0.0.1:5175", "http://localhost:5175"],
    allow_methods=["*"], allow_headers=["*"],
)

from api.cafe import router as cafe_router  # 카페 엔진 (sim/cafe, docs/CAFE.md): /cafe/preview, /cafe/season ...
app.include_router(cafe_router)

KPI = ("revenue", "op", "covers", "ticket", "cogs", "labor", "rent", "mgmt", "fees", "walkaways", "avg_wait_min",
       "table_utilization", "satisfaction", "reviews", "delivery_revenue", "delivery_fee", "delivery_orders")


_LOCK = threading.Lock()  # 엔진의 점포 설정과 캐시가 프로세스 전역이라 요청을 한 번에 하나씩 처리한다


def _apply_store(spec: dict | None) -> dict:
    """ChangeUp 점포 입력 → 엔진 점포 덮어쓰기. 계획에 합칠 값(가격, 직원)을 돌려준다. spec이 없으면 기준 점포(혜화동 25평)."""
    if not spec:
        S.set_store(None)
        return {}
    try:
        store, plan = from_changeup(
            gu_sales_man=float(spec["gu_sales_man"]), pyeong=float(spec["pyeong"]), tables=int(spec["tables"]),
            seats=int(spec.get("seats", 0)), cash_rent_man_per_pyeong=float(spec["cash_rent_man_per_pyeong"]),
            staff=int(spec.get("staff", 3)), price=int(spec.get("price", 19000)),
            baseline_runs=int(spec.get("baseline_runs", 150)), quarter_index=spec.get("quarter_index"),
            area_type=spec.get("area_type"), start_month=spec.get("start_month"), flow=spec.get("flow"),
            delivery_gu_index=spec.get("delivery_gu_index"))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(422, f"store 입력 오류: {e}") from e
    S.set_store(store)
    return plan


def _owner_wage() -> float:
    return float(load_params()["cst_owner_imputed_wage"])


def _dp_public(dp: dict) -> dict:
    return {"id": dp["id"], "kind": dp["kind"], "title": dp["title_ko"], "prompt": dp["prompt_ko"], "clock": dp["clock"],
            "default": dp["default"], "count": dp["monthly_count"], "count_tag": dp["count_tag"],
            "options": [{"id": o["id"], "label": o["label_ko"], "hint": o["effect_hint_ko"], "downside": o["downside_ko"],
                         "tag": o["tag"]} for o in dp["options"]]}


def _slim(r: dict) -> dict:
    d = r["draw"]
    dps = {x["id"]: x for x in r.get("decision_points") or []}
    decisions = []
    for nd in r.get("night_decisions") or []:
        dp = dps.get(nd["id"])
        if not dp:
            continue
        label = next((o["label_ko"] for o in dp["options"] if o["id"] == nd["option_id"]), nd["option_id"])
        default_label = next((o["label_ko"] for o in dp["options"] if o["id"] == dp["default"]), dp["default"])
        decisions.append({**_dp_public(dp), "chosen": nd["option_id"], "chosen_label": label, "default_label": default_label,
                          "month_op": nd["month_delta"]["op"], "month_revenue": nd["month_delta"]["revenue"],
                          "night": nd["night_delta"], "state": nd["state_delta"], "vs_default_op": nd["vs_default_op"]})
    bp = S.base_plan()
    return {
        "decisions": decisions,
        # 평소(기준 운영): 엔진의 기준 계획으로 같은 달·같은 사건·같은 손님 흐름을 돌린 값
        "base_plan": {k: bp[k] for k in ("meat_price", "staff_per_shift", "close_hour", "banchan", "marketing_budget", "meat_grade")},
        "shadow": {k: r["shadow"]["kpis"][k] for k in ("revenue", "op", "covers")},
        "waterfall": [{"driver": w["driver"], "delta": w["delta"]} for w in r.get("waterfall", []) if w.get("kind") == "step" and w.get("delta")],
        "month": r["month"], "month_index": r["month_index"], "label": r["calendar"]["label"],
        "demand_index": r["calendar"]["demand_index"],
        "cost_index": r["calendar"].get("cost_index"), "cost_range": r["calendar"].get("cost_range"),
        "events": [{"id": e["id"], "label": e["label"].replace("대학로", "대학가"), "group": e["group"],
                    "mechanism": (e.get("mechanism") or "").replace("대학로", "대학가") or None, "outcome": e.get("outcome")}
                   for e in r["events"]],
        "note": r["calendar"].get("note"),
        "kpis": {k: d["kpis"].get(k) for k in KPI},
        "p10": {k: d["p10"].get(k) for k in ("revenue", "op")}, "p50": {k: d["p50"].get(k) for k in ("revenue", "op")},
        "p90": {k: d["p90"].get(k) for k in ("revenue", "op")},
        "demand_factors": r["demand_factors"],
        "nights": [{k: (round(v) if isinstance(v, float) else v) for k, v in n.items()} for n in r["nights"]],
        "reviews": [{"stars": x.get("stars"), "text": x.get("text")} for x in (r.get("reviews") or [])[:6]],
        "owner_line": r.get("owner_line"),
        "state_after": {k: r["state_after"][k] for k in ("cash", "rating", "review_count", "awareness", "regular_share", "fatigue")},
        "closed": r["state_after"]["closed"], "closed_reason": r["state_after"]["closed_reason"],
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True, "engine": "sim.season v2", "months": S.months(), "owner_imputed_wage": _owner_wage()}


@app.post("/season/new")
def season_new(body: dict[str, Any] = Body(default_factory=dict)) -> dict:
    """신규 오픈 시작 상태. body: {seed?, cash? (원, 문 연 뒤 남은 운영자금), opening? (기본 true)}"""
    return S.new_season(int(body.get("seed", 42)), opening=bool(body.get("opening", True)),
                        cash=body.get("cash"))


@app.post("/season/start")
def season_start(body: dict[str, Any] = Body(...)) -> dict:
    """한 달의 시작: 이번 달 사건과 토요일 밤의 결정 상황(선택지)만 돌려준다. 선택은 /season/play 의 night_choices로 보낸다.
    body: {state, plan?, store?, events?}"""
    state = body.get("state")
    if not isinstance(state, dict):
        raise HTTPException(422, "state가 필요합니다")
    with _LOCK:
        spec = body.get("store") or state.get("store_input")
        patch = _apply_store(spec)
        plan = {**S.base_plan(), **patch, **(body.get("plan") or {})}
        try:
            r = S.start_month(state, plan, body.get("events"))
        except ValueError as e:
            raise HTTPException(409, str(e)) from e
    return {"month": r["month"], "label": r["calendar"]["label"], "note": r["calendar"].get("note"),
            "events": [{"id": e["id"], "label": e["label"].replace("대학로", "대학가"), "group": e["group"],
                        "mechanism": (e.get("mechanism") or "").replace("대학로", "대학가") or None} for e in r["events"]],
            "decision_points": [_dp_public(dp) for dp in r["decision_points"]]}


@app.post("/season/play")
def season_play(body: dict[str, Any] = Body(...)) -> dict:
    """한 달 진행. body: {state, plan? (기본 평소 계획), events? (생략하면 시드로 뽑음), band_runs?}"""
    state = body.get("state")
    if not isinstance(state, dict):
        raise HTTPException(422, "state가 필요합니다 (POST /season/new 의 결과)")
    with _LOCK:
        spec = body.get("store") or state.get("store_input")
        patch = _apply_store(spec)
        plan = {**S.base_plan(), **patch, **(body.get("plan") or {})}
        try:
            r = S.play_month(state, plan, body.get("events"), night=bool(body.get("night", True)),
                             night_choices=body.get("night_choices") or None, band_runs=int(body.get("band_runs", 20)))
        except ValueError as e:  # 이미 폐업한 점포, 없는 결정 id 등
            raise HTTPException(409, str(e)) from e
        nxt = r["state_after"]
        if spec:
            nxt["store_input"] = spec
    return {"result": _slim(r), "state": nxt}


@app.post("/season/run")
def season_run(body: dict[str, Any] = Body(default_factory=dict)) -> dict:
    """6개월을 돌리고 현금 장부까지. body:
    {seed?, opening?, plan?, store?: {gu_sales_man, pyeong, tables, seats, cash_rent_man_per_pyeong, staff, price},
     invest: {deposit, interior, ...} (원), loan?: {principal, annual_rate, term_months, grace_months},
     own_capital (원), owner_draw? (월, 원), months? (기본 전부)}
    store를 주면 그 점포로, 없으면 기준 점포(혜화동 25평)로 돌린다. 새 점포는 처음 한 번 '평소'를 계산해 20초쯤 걸린다."""
    invest = body.get("invest") or {}
    own = float(body.get("own_capital", 0.0))
    loan = body.get("loan")
    start_cash = own + (float(loan["principal"]) if loan else 0.0) - sum(float(v) for v in invest.values())
    cash0 = body.get("operating_cash")  # 문 연 뒤 엔진이 쓰는 운영자금. 없으면 투자 후 남은 돈
    n = min(int(body.get("months", len(S.months()))), len(S.months()))
    results, ops = [], []
    with _LOCK:
        spec = body.get("store")
        patch = _apply_store(spec)
        state = S.new_season(int(body.get("seed", 42)), opening=bool(body.get("opening", True)),
                             cash=float(cash0) if cash0 is not None else max(0.0, start_cash))
        if spec:
            state["store_input"] = spec
        plan = {**S.base_plan(), **patch, **(body.get("plan") or {})}
        for _ in range(n):
            if state["closed"]:
                break
            r = S.play_month(state, plan, None, night=False, band_runs=int(body.get("band_runs", 20)))
            state = r["state_after"]
            if spec:
                state["store_input"] = spec
            results.append(_slim(r))
            ops.append(float(r["draw"]["kpis"]["op"]))
    ledger = venture_ledger(ops, invest, loan, own_capital=own, owner_draw=float(body.get("owner_draw", 0.0)),
                            imputed_owner_wage=_owner_wage())
    return {"months": results, "ledger": ledger, "state": state, "closed": state["closed"],
            "closed_reason": state["closed_reason"]}


@app.post("/venture")
def venture(body: dict[str, Any] = Body(...)) -> dict:
    ops = body.get("monthly_op")
    if not isinstance(ops, list) or not ops:
        raise HTTPException(422, "monthly_op 목록이 필요합니다")
    return venture_ledger([float(x) for x in ops], body.get("invest") or {}, body.get("loan"),
                          own_capital=float(body.get("own_capital", 0.0)), owner_draw=float(body.get("owner_draw", 0.0)),
                          imputed_owner_wage=float(body.get("imputed_owner_wage", _owner_wage())))


# --- 성적표 랭킹 ---------------------------------------------------------------------------------------------
# 6개월 성적표 점수를 반(클래스 코드)별로 모은다. 같은 서버를 쓰는 사람끼리 순위를 본다 (교육 현장 시연용).
# 파일 하나에 쌓고 DB는 쓰지 않는다. 이름은 화면에서 받은 별명이고 개인정보는 받지 않는다.
SCORES = Path(__file__).resolve().parents[1] / "data" / "scores.json"
_SCORE_LOCK = threading.Lock()


def _load_scores() -> list[dict]:
    try:
        return json.loads(SCORES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _same(r: dict, cls: str, shop: str, mode: str) -> bool:
    """같은 반·업종·모드끼리만 순위를 매긴다 (예전 기록은 shop이 없으면 고깃집, mode가 없으면 쉬운 모드로 본다)."""
    return r["cls"] == cls and r.get("shop", "고깃집") == shop and r.get("mode", "easy") == mode


def _board(rows: list[dict], cls: str, shop: str, mode: str, limit: int = 20) -> list[dict]:
    mine = sorted((r for r in rows if _same(r, cls, shop, mode)), key=lambda r: (-r["score"], r["ts"]))
    return [{**r, "rank": i + 1} for i, r in enumerate(mine[:limit])]


@app.get("/scores")
def scores(cls: str = "공개", shop: str = "고깃집", mode: str = "easy") -> dict:
    rows = _load_scores()
    mode = "hard" if mode == "hard" else "easy"
    return {"cls": cls, "shop": shop, "mode": mode, "count": sum(_same(r, cls, shop, mode) for r in rows), "top": _board(rows, cls, shop, mode)}


@app.post("/scores")
def score_add(body: dict[str, Any] = Body(...)) -> dict:
    """body: {name, cls?, score (0~100), grade, mode, gu, shop, end_cash, seed?}.
    저장한 기록의 순위와 같은 반·업종·모드의 상위 20명을 돌려준다. seed는 그 판이 겪은 사건·날씨를 다시 볼 수 있게 함께 저장한다."""
    name = str(body.get("name", "")).strip()[:12]
    cls = str(body.get("cls") or "공개").strip()[:20] or "공개"
    try:
        score = int(round(float(body["score"])))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(422, "score가 필요합니다") from e
    if not name or not 0 <= score <= 100:
        raise HTTPException(422, "별명과 0~100 점수가 필요합니다")
    row = {"id": uuid.uuid4().hex[:10], "name": name, "cls": cls, "score": score, "grade": str(body.get("grade", ""))[:20],
           "mode": "hard" if body.get("mode") == "hard" else "easy", "gu": str(body.get("gu", ""))[:10], "shop": str(body.get("shop", "고깃집"))[:10],
           "end_cash": int(float(body.get("end_cash", 0))), "seed": int(body["seed"]) if isinstance(body.get("seed"), (int, float)) else None,
           "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with _SCORE_LOCK:
        rows = _load_scores() + [row]
        SCORES.parent.mkdir(parents=True, exist_ok=True)
        SCORES.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    ranked = sorted((r for r in rows if _same(r, cls, row["shop"], row["mode"])), key=lambda r: (-r["score"], r["ts"]))
    rank = next(i + 1 for i, r in enumerate(ranked) if r["id"] == row["id"])
    return {"id": row["id"], "rank": rank, "count": len(ranked), "cls": cls, "shop": row["shop"], "mode": row["mode"],
            "top": _board(rows, cls, row["shop"], row["mode"])}
