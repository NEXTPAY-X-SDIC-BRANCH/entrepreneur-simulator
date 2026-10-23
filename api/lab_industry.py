"""새 업종 엔진 API (lab:industry). 카페 라우트(api/cafe.py)와 같은 모양: 미리보기, 시즌 시작, 한 달, 결과. 숫자는 모두 sim/generic.

    GET  /lab/industry/list                업종 목록과 화면에 쓸 대표값
    POST /lab/industry/preview             가게 구성 -> 배치(3D), 여는 비용, 자리 잡힌 달 손익, 좌석·일손 한도
    POST /lab/industry/season              시즌 시작 -> 대출, 첫 달 사건, state_token
    POST /lab/industry/season/month        {state_token, 결정} -> 그 달 결과와 다음 state_token, 다음 달 사건
    POST /lab/industry/season/report       {state_token} -> 시즌 결과와 SeasonSummary (LAB_CONTRACT)

상태는 서버에 두지 않는다. 시즌 = 시작 입력 + 지금까지 보낸 결정이고 모델이 결정론적이라 매번 다시 돌린다 (카페와 같은 방식).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import zlib
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from sim.generic import model as gm
from sim.generic import params as gp
from sim.generic import season as gs
from sim.generic.registry import INDUSTRIES

router = APIRouter(prefix="/lab/industry", tags=["lab-industry"])
Ind = Literal["hansik", "pub", "bunsik", "bakery", "chicken"]


class StoreIn(BaseModel):
    industry: Ind
    gu: str = Field(..., min_length=2, max_length=8)
    dong: str | None = Field(None, max_length=20)
    pyeong: int | None = Field(None, ge=10, le=40)
    tables: int | None = Field(None, ge=0, le=40)
    staff: int | None = Field(None, ge=0, le=8)                 # 사장님을 뺀 직원 수
    grade: Literal["basic", "mid", "high"] = "basic"
    own_capital_krw: int = Field(80_000_000, ge=0, le=5_000_000_000)
    key_money_krw: int = Field(0, ge=0, le=1_000_000_000)
    rent_man_per_pyeong: float | None = Field(None, gt=0, lt=100)   # 현금 월세, 없으면 R-ONE 구·동 값
    delivery: bool = True
    # lab:merge 가게 배치 (카페와 같은 값, sim/cafe/layout.py 가 배치를 다시 푼다). 없으면 예전 그대로
    aspect: float | None = Field(None, ge=0.35, le=3.0)
    door_wall: Literal["front", "back", "left", "right"] | None = None
    door_pos: float | None = Field(None, ge=0.0, le=1.0)
    windows: list[Literal["front", "back", "left", "right"]] | None = Field(None, max_length=4)
    doors: int | None = Field(None, ge=1, le=3)   # 출입문 수: 2개부터 하나에 150만원 '출입문 추가'


class SeasonIn(StoreIn):
    seed: int = Field(0, ge=0, le=2_147_483_647)
    start_month: int | None = Field(None, ge=1, le=12)
    extra_loan_krw: int | None = Field(None, ge=0, le=500_000_000)
    loan_rate: float | None = Field(None, gt=0, lt=0.3)   # lab:merge 가게 꾸미기에서 고른 은행·정책자금 연 금리 (소수, 0.045 = 4.5%). 없으면 한국은행 평균


class MonthIn(BaseModel):
    state_token: str = Field(..., min_length=10, max_length=8000)
    price_change_pct: float | None = Field(None, ge=-20, le=30)
    hours: Literal["short", "standard", "long"] | None = None
    staff: int | None = Field(None, ge=0, le=8)
    marketing_krw: int | None = Field(None, ge=0, le=3_000_000)
    delivery: bool | None = None
    choice: str | None = Field(None, max_length=40)
    month_index: int | None = Field(None, ge=0)


class TokenIn(BaseModel):
    state_token: str = Field(..., min_length=10, max_length=8000)


# ---------------------------------------------------------------------------------------------- state_token

DEV_KEY = "industry-dev-key-not-secret"


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(body: str) -> str:
    key = os.environ.get("INDUSTRY_TOKEN_KEY", DEV_KEY).encode()
    return _b64(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()[:16])


def encode_token(state: dict) -> str:
    body = _b64(zlib.compress(json.dumps(state, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode(), 9))
    return f"{body}.{_sign(body)}"


def decode_token(token: str) -> dict:
    try:
        body, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(body)):
            raise ValueError("signature")
        d = zlib.decompressobj()
        raw = d.decompress(_unb64(body), 64_000)
        if d.unconsumed_tail:
            raise ValueError("too large")
        state = json.loads(raw)
        if state.get("v") != 1 or not isinstance(state.get("b"), dict) or not isinstance(state.get("d"), list):
            raise ValueError("shape")
    except (ValueError, TypeError, zlib.error, UnicodeDecodeError) as e:
        raise HTTPException(400, {"error": "bad_state_token", "detail": str(e) if str(e) in ("signature", "too large", "shape") else "malformed"})
    if state.get("pv") != gp.model_version():
        raise HTTPException(409, {"error": "model_changed", "detail": "모델 값이 바뀌었어요. 시즌을 새로 시작해 주세요"})
    return state


def _replay(state: dict) -> dict:
    try:
        return gs.replay(state["b"], state["d"])
    except ValueError as e:
        raise HTTPException(400, {"error": "bad_decision", "detail": str(e)})


# ---------------------------------------------------------------------------------------------- routes

@router.get("/list")
def industry_list():
    out = []
    gd = gp.gu_data()
    for ind, k in INDUSTRIES.items():
        ch = gp.iv(ind, "demand", "channel_share")
        out.append({"id": ind, "name_ko": k["name"], "short_ko": k["short"], "desc_ko": k["desc"], "base_ko": k["base"], "krei_label": k["krei_label"],
                    "seoul_stores": gd[ind]["seoul"]["count"], "ticket_krw": gp.iv(ind, "demand", "ticket_krw"),
                    "sales_mean_month_krw": round(gp.iv(ind, "demand", "annual_sales_mean_man") * 1e4 / 12),
                    "closure_rate": gd[ind]["seoul"]["closure_rate"], "channels": ch,
                    "default_pyeong": round(gp.iv(ind, "demand", "area_pyeong_p50")), "default_staff": gp.iv(ind, "cost", "default_staff"),
                    "hours": gp.iv(ind, "demand", "hours")})
    return {"industries": out, "model_version": gp.model_version()}


@router.post("/preview")
def industry_preview(body: StoreIn):
    try:
        return gm.preview(body.model_dump())
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/season")
def industry_season(body: SeasonIn):
    b = body.model_dump()
    try:
        run = gs.start(b)
    except ValueError as e:
        raise HTTPException(422, str(e))
    state = {"v": 1, "pv": gp.model_version(), "b": b, "d": []}
    return {**gs.public_start(run), "state_token": encode_token(state)}


@router.post("/season/month")
def industry_month(body: MonthIn):
    state = decode_token(body.state_token)
    sent = body.model_dump(exclude_none=True, exclude={"state_token"})
    i = sent.pop("month_index", None)
    run = _replay(state)
    played = len(run["months"])
    if i is not None and i != played:
        if i < played and state["d"][i] == sent:   # 같은 달을 같은 결정으로 다시 보낸 것(시간 초과 뒤 재시도): 그 달과 그 달 뒤의 토큰
            prior = {**state, "d": state["d"][:i + 1]}
            return {**gs.public_month(_replay(prior), run["months"][i]), "state_token": encode_token(prior)}
        raise HTTPException(409, {"error": "month_mismatch", "month_index": i, "months_played": played})
    try:
        run, month = gs.play_month(run, sent)
    except gs.SeasonOver as e:
        raise HTTPException(409, {"error": "season_over", "detail": str(e), "months_played": played})
    except ValueError as e:
        raise HTTPException(400, {"error": "bad_decision", "detail": str(e)})
    new = {**state, "d": state["d"] + [sent]}
    return {**gs.public_month(run, month), "state_token": encode_token(new)}


@router.post("/season/report")
def industry_report(body: TokenIn):
    return gs.report(_replay(decode_token(body.state_token)))
