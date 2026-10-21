"""Cafe 창업 시뮬레이터 endpoints. Validation only; every number comes from sim/cafe (docs/CAFE.md)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import uuid
import zlib
from collections import OrderedDict
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from sim import cafe
from sim.cafe import season as cafe_season
from sim.cafe.params import load_districts, model_version

router = APIRouter(prefix="/cafe", tags=["cafe"])


class CafeIn(BaseModel):
    district: str = Field(..., min_length=7, max_length=8)  # 상권 코드 3곳 또는 서울 행정동 코드(sim/cafe/build_dongs.py)

    @field_validator("district")
    @classmethod
    def _known_district(cls, v: str) -> str:
        if v not in load_districts():
            raise ValueError(f"unknown district {v}")
        return v
    size_pyeong: int = Field(..., ge=10, le=40)
    tables: int = Field(..., ge=0, le=40)
    chairs: int = Field(..., ge=0, le=160)
    bar_seats: int = Field(0, ge=0, le=30)
    espresso_groups: int = Field(2, ge=1, le=4)
    showcase: int = Field(0, ge=0, le=1)
    oven: int = Field(0, ge=0, le=1)
    kiosks: int = Field(0, ge=0, le=3)
    pos: int = Field(1, ge=1, le=3)
    own_capital_krw: int = Field(80_000_000, ge=0)
    daily_customers: int | None = Field(None, ge=10, le=600)   # orders on the peak day; None = data default
    peak_day: Literal["weekday", "weekend"] | None = None              # None = the district's busier day type
    staff_peak: int | None = Field(None, ge=1, le=8)                   # people at the peak, 사장님 included; None = recommended
    # lab:layout: room shape (가로 ÷ 세로) and the door (wall + 0..1 along it); None = the old default room
    aspect: float | None = Field(None, ge=0.35, le=3.0)
    door_wall: Literal["front", "back", "left", "right"] | None = None
    door_pos: float | None = Field(None, ge=0.0, le=1.0)
    windows: list[Literal["front", "back", "left", "right"]] | None = Field(None, max_length=4)   # echoed for the 3D walls


class SeasonIn(CafeIn):
    seed: int = Field(0, ge=0, le=2_147_483_647)
    start_month: int | None = Field(None, ge=1, le=12)                 # None = params season.start_month
    extra_loan_krw: int | None = Field(None, ge=0, le=500_000_000)     # 운전자금 on top of the CAPEX gap; None = enough
                                                                       # to open with 3 months of fixed costs in cash


class MonthIn(BaseModel):
    price_change_pct: float | None = Field(None, ge=-20, le=30)        # one-time change this month; None = 0
    hours: Literal["short", "standard", "long"] | None = None          # None = keep last month's
    staff_policy: Literal["lean", "standard", "generous"] | None = None
    marketing_krw: int | None = Field(None, ge=0, le=5_000_000)
    dessert: bool | None = None
    scenario: dict[str, str] | None = None        # {decision point id: option id}; missing ones take the default
    month_index: int | None = Field(None, ge=0)   # optional: 0-based month this request is for (= months played); a
                                                  # repeat of a played month with the same decisions returns it again


class TokenIn(BaseModel):
    state_token: str = Field(..., min_length=10, max_length=8000)


class TokenMonthIn(MonthIn):
    state_token: str = Field(..., min_length=10, max_length=8000)


LAB_LAYOUT_KEYS = ("aspect", "door_wall", "door_pos", "windows")   # lab:layout


def _dump(body: BaseModel) -> dict:
    """lab:layout: drop the room-shape keys when unset, so an old request gives the old answer byte for byte."""
    return body.model_dump(exclude={k for k in LAB_LAYOUT_KEYS if getattr(body, k, None) is None})


@router.post("/preview")
def cafe_preview(body: CafeIn):
    return cafe.preview(_dump(body))


@router.get("/districts")
def cafe_districts():
    return cafe.districts()


# ---------------------------------------------------------------------------------------------- step 3 월별 운영
# A season is its start body + the decisions sent so far; the model is deterministic, so every call replays it.
# Stateless (serverless, web): POST /season returns state_token; POST /season/month and /season/report take it and
# /month returns the next one. The token = base64url(zlib(JSON {v, pv, b, d})) + "." + HMAC-SHA256 (16 bytes) under
# CAFE_TOKEN_KEY (set it on any public deployment; the dev default only keeps honest clients honest).
# Stateful (desktop app): /season/{id}/month and /season/{id}/report keep the same state in memory (lost on restart,
# oldest dropped past MAX_RUNS) and replay it the same way.

TOKEN_VERSION = 1
DEV_TOKEN_KEY = "cafe-dev-key-not-secret"
MAX_TOKEN_JSON = 64_000
MAX_RUNS = 500
_runs: OrderedDict[str, dict] = OrderedDict()
_lock = threading.Lock()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(body: str) -> str:
    key = os.environ.get("CAFE_TOKEN_KEY", DEV_TOKEN_KEY).encode()
    return _b64(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()[:16])


def encode_token(state: dict) -> str:
    raw = json.dumps(state, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode()
    body = _b64(zlib.compress(raw, 9))
    return f"{body}.{_sign(body)}"


def decode_token(token: str) -> dict:
    """400 for anything not signed by this server's key, 409 when the model inputs changed since it was made."""
    try:
        body, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(body)):
            raise ValueError("signature")
        d = zlib.decompressobj()
        raw = d.decompress(_unb64(body), MAX_TOKEN_JSON)
        if d.unconsumed_tail:
            raise ValueError("too large")
        state = json.loads(raw)
        if state.get("v") != TOKEN_VERSION or not isinstance(state.get("b"), dict) or not isinstance(state.get("d"), list):
            raise ValueError("shape")
    except (ValueError, TypeError, zlib.error, UnicodeDecodeError) as e:
        raise HTTPException(400, {"error": "bad_state_token", "detail": str(e) if str(e) in (
            "signature", "too large", "shape") else "malformed"})
    if state.get("pv") != model_version():
        raise HTTPException(409, {"error": "model_changed", "detail": "the model numbers changed; start a new season"})
    return state


def _replay(state: dict) -> dict:
    return cafe_season.replay(state["b"], state["d"])


def _advance(state: dict, sent: dict, i: int | None) -> tuple[dict, dict]:
    """Play the next month of the season in `state` with the decisions `sent`; (new state, month)."""
    run = _replay(state)
    played = len(run["months"])
    if i is not None and i != played:
        prior = run["months"][i] if i < played else None
        if prior is not None and all(prior["decisions"].get(k) == x for k, x in sent.items()):
            return state, cafe_season.public_month(prior)
        raise HTTPException(409, {"error": "month_mismatch", "month_index": i, "months_played": played})
    try:
        _, month = cafe_season.play_month(run, sent)
    except cafe_season.SeasonOver as e:
        raise HTTPException(409, {"error": "season_over", "detail": str(e), "months_played": played})
    except ValueError as e:
        raise HTTPException(400, {"error": "bad_decision", "detail": str(e)})
    return {**state, "d": state["d"] + [sent]}, month


def _sent(body: MonthIn) -> tuple[dict, int | None]:
    sent = body.model_dump(exclude_none=True, exclude={"state_token"})
    return sent, sent.pop("month_index", None)


@router.post("/season")
def cafe_season_start(body: SeasonIn):
    b = _dump(body)   # lab:layout
    run = cafe_season.start(b)
    run["id"] = uuid.uuid4().hex[:12]
    state = {"v": TOKEN_VERSION, "pv": model_version(), "b": b, "d": []}
    with _lock:
        _runs[run["id"]] = state
        while len(_runs) > MAX_RUNS:
            _runs.popitem(last=False)
    return {**cafe_season.public_start(run), "state_token": encode_token(state)}


@router.post("/season/month")
def cafe_season_month_token(body: TokenMonthIn):
    state = decode_token(body.state_token)
    state, month = _advance(state, *_sent(body))
    return {**month, "state_token": encode_token(state)}


@router.post("/season/scenario")
def cafe_season_scenario(body: TokenMonthIn):
    state = decode_token(body.state_token)
    sent, _ = _sent(body)
    try:
        return cafe_season.scenario_preview(_replay(state), sent)
    except cafe_season.SeasonOver as e:
        raise HTTPException(409, {"error": "season_over", "detail": str(e)})


@router.post("/season/report")
def cafe_season_report_token(body: TokenIn):
    return cafe_season.report(_replay(decode_token(body.state_token)))


def _get(season_id: str) -> dict:
    state = _runs.get(season_id)
    if state is None:
        raise HTTPException(404, f"no cafe season {season_id}")
    return state


@router.post("/season/{season_id}/month")
def cafe_season_month(season_id: str, body: MonthIn | None = None):
    with _lock:   # one month at a time per process: a double click must not append the same month twice
        state, month = _advance(_get(season_id), *_sent(body or MonthIn()))
        _runs[season_id] = state
    return {**month, "state_token": encode_token(state)}


@router.get("/season/{season_id}/report")
def cafe_season_report(season_id: str):
    with _lock:
        state = _get(season_id)
    run = _replay(state)
    run["id"] = season_id
    return cafe_season.report(run)
