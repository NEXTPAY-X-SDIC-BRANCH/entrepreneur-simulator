"""이지/하드 모드와 민감도 (lab:modes). 계산은 sim/easy.py, 여기는 입력 확인과 엔진 잠금만.

    POST /lab/easy/defaults   업종, 구(동), 자본금(평수) -> 채운 입력과 근거 (엔진을 돌리지 않음, 빠름)
    POST /lab/easy/run        같은 입력 -> 채운 입력 + 6개월 결과 (고깃집 = /season/run 응답, 카페 = start/months/report)
    POST /lab/sensitivity     같은 계획을 손님·고깃값(재료비)·월세·인건비 ±로 여러 번 -> 토네이도 + 3x3 격자

상태는 서버에 저장하지 않는다. 판 기록(다시 해보기)은 화면이 들고 있다.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from sim import easy as E

router = APIRouter(prefix="/lab", tags=["lab-modes"])


class Overrides(BaseModel):
    pyeong: int | None = Field(None, ge=10, le=40)
    tables: int | None = Field(None, ge=1, le=30)
    staff: int | None = Field(None, ge=0, le=7)
    price: int | None = Field(None, ge=12000, le=30000)
    loan_man: float | None = Field(None, ge=0, le=100_000)


class EasyIn(BaseModel):
    industry: Literal["bbq", "cafe"]
    gu: str = Field(..., min_length=2, max_length=10)
    dong: str | None = Field(None, max_length=30)
    capital_man: float = Field(..., ge=500, le=200_000)
    pyeong: int | None = Field(None, ge=10, le=40)
    start_month: int = Field(3, ge=1, le=12)
    overrides: Overrides | None = None


class SensIn(BaseModel):
    industry: Literal["bbq", "cafe"]
    body: dict[str, Any]
    ranges: dict[str, float] | None = None


def _inputs(b: EasyIn) -> dict:
    try:
        return E.easy_inputs(b.industry, b.gu, b.capital_man, dong=b.dong, pyeong=b.pyeong, start_month=b.start_month,
                             overrides=b.overrides.model_dump(exclude_none=True) if b.overrides else None)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/easy/defaults")
def easy_defaults(b: EasyIn) -> dict:
    return _inputs(b)


@router.post("/easy/run")
def easy_run(b: EasyIn) -> dict:
    inp = _inputs(b)
    if b.industry == "cafe":
        return {"inputs": inp, "cafe": E.run_cafe(inp["run"])}
    from api import changeup as C   # 지연 import: changeup.py가 이 라우터를 include 한다
    return {"inputs": inp, "bbq": C.season_run(inp["run"])}


@router.post("/sensitivity")
def sensitivity(b: SensIn) -> dict:
    if b.industry == "cafe":
        from api.cafe import SeasonIn
        try:
            body = SeasonIn(**b.body).model_dump()
        except Exception as e:   # pydantic ValidationError -> 422 with the message
            raise HTTPException(422, f"카페 입력 오류: {e}") from e
        if not body.get("daily_customers"):
            raise HTTPException(422, "카페 민감도에는 daily_customers가 필요합니다")
        return E.sensitivity_cafe(body, b.ranges)
    from api import changeup as C
    if not isinstance(b.body.get("store"), dict):
        raise HTTPException(422, "store가 필요합니다 (/season/run 과 같은 몸통)")
    with C._LOCK:   # 엔진의 점포 설정과 한 달 설정 함수를 잠깐 바꾸므로 다른 요청과 겹치면 안 된다
        try:
            return E.sensitivity_bbq(b.body, b.ranges)
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(422, f"입력 오류: {e}") from e
