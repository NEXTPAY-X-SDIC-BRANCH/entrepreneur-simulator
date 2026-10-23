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
    size_pyeong: int = Field(..., ge=10, le=80)
    tables: int = Field(..., ge=0, le=40)
    chairs: int = Field(..., ge=0, le=160)
    bar_seats: int = Field(0, ge=0, le=30)
    espresso_groups: int = Field(2, ge=1, le=4)
    showcase: int = Field(0, ge=0, le=1)
    oven: int = Field(0, ge=0, le=1)
    kiosks: int = Field(0, ge=0, le=3)
    pos: int = Field(1, ge=1, le=3)
    shape: Literal["wide", "square", "deep"] | None = None             # 가게 모양 (가로 ÷ 세로 1.6 / 1.0 / 0.7), None = wide
    door: Literal["right", "left"] | None = None                       # 출입문 자리, None = right (배치를 좌우로 뒤집음)
    own_capital_krw: int = Field(80_000_000, ge=0)
    daily_customers: int | None = Field(None, ge=10, le=600)   # orders on the peak day; None = data default
    peak_day: Literal["weekday", "weekend"] | None = None              # None = the district's busier day type
    staff_peak: int | None = Field(None, ge=1, le=8)                   # people at the peak, 사장님 included; None = recommended
    # lab:layout: room shape (가로 ÷ 세로) and the door (wall + 0..1 along it); None = the old default room
    aspect: float | None = Field(None, ge=0.35, le=3.0)
    door_wall: Literal["front", "back", "left", "right"] | None = None
    door_pos: float | None = Field(None, ge=0.0, le=1.0)
    windows: list[Literal["front", "back", "left", "right"]] | None = Field(None, max_length=4)   # echoed for the 3D walls
    doors: int | None = Field(None, ge=1, le=3)   # lab:merge 출입문 수 (수빈 10/23). 2개부터 '출입문 추가' 값이 여는 비용에 들어감, 배치는 그대로


class MenuItemIn(BaseModel):   # lab:menu  메뉴판 한 줄 (sim/menu.py). 화면용 값(recipe 등)은 버린다
    id: str = Field(..., min_length=1, max_length=32)
    name: str = Field("", max_length=24)
    kind: Literal["main", "side", "drink"]
    price: float = Field(..., ge=100, le=300_000)
    unit_cost: float = Field(0, ge=0)
    mix: float = Field(0, ge=0, le=1000)


class RentCardIn(BaseModel):  # lab:finance sim/rent_card.py
    months: Literal[0, 2, 3, 6] = 0
    fee_rate: float | None = Field(None, ge=0, le=0.2)


class SeasonIn(CafeIn):
    menu: list[MenuItemIn] | None = Field(None, max_length=30)   # lab:menu  None = 예전 그대로 (상권 객단가, 업계 원가율)

    @field_validator("menu")
    @classmethod
    def _menu_ok(cls, x):   # lab:menu
        if x:
            from sim.menu import clean
            clean([i.model_dump() for i in x], "cafe")
        return x
    seed: int = Field(0, ge=0, le=2_147_483_647)
    start_month: int | None = Field(None, ge=1, le=12)                 # None = params season.start_month
    extra_loan_krw: int | None = Field(None, ge=0, le=500_000_000)     # 운전자금 on top of the CAPEX gap; None = enough
                                                                       # to open with 3 months of fixed costs in cash
    loan_rate: float | None = Field(None, ge=0, le=0.2)               # lab:finance 고른 은행·정책자금 금리 (연, 0.0438 = 4.38%)
    rent_card: RentCardIn | None = None                                # lab:finance 월세 카드 할부; None = 현금


class MonthIn(BaseModel):
    price_change_pct: float | None = Field(None, ge=-20, le=30)        # one-time change this month; None = 0
    hours: Literal["short", "standard", "long"] | None = None          # None = keep last month's
    staff_policy: Literal["lean", "standard", "generous"] | None = None
    staff_max: int | None = Field(None, ge=1, le=8)    # 바쁜 시간 최대 인원 (사장님 포함, None = 가게 설정 인원)
    marketing_krw: int | None = Field(None, ge=0, le=5_000_000)
    dessert: bool | None = None
    delivery: bool | None = None                  # 배달앱 입점 (None = 지난달 그대로)
    open_hour: int | None = Field(None, ge=0, le=24)    # hard 모드: 여는 시각 직접 (None = 프리셋)
    close_hour: int | None = Field(None, ge=0, le=24)
    menu: dict | None = None                      # hard 모드 메뉴·판촉 (sim/cafe/season.py MENU_DEFAULT)
    scenario: dict[str, str] | None = None        # {decision point id: option id}; missing ones take the default
    month_index: int | None = Field(None, ge=0)   # optional: 0-based month this request is for (= months played); a
                                                  # repeat of a played month with the same decisions returns it again


class TokenIn(BaseModel):
    state_token: str = Field(..., min_length=10, max_length=8000)


class TokenMonthIn(MonthIn):
    state_token: str = Field(..., min_length=10, max_length=8000)


LAB_LAYOUT_KEYS = ("aspect", "door_wall", "door_pos", "windows", "doors")   # lab:layout


def _dump(body: BaseModel) -> dict:
    """요청 본문 → 엔진 입력. 고르지 않은 가게 모양·출입문(None)은 넣지 않는다 (예전 입력과 같은 결과·같은 입력 기록).
    lab:layout 의 aspect·door_wall·door_pos·windows 와 upstream 의 shape·door 모두 같은 규칙."""
    d = body.model_dump()
    for k in (*LAB_LAYOUT_KEYS, "shape", "door"):
        if d.get(k) is None:
            d.pop(k, None)
    return d


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
