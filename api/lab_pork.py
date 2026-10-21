"""돼지고기 도매가 예측 API (lab:pork). 엔진 서버(api/changeup.py)에 붙는다.

    GET /lab/pork/forecast   pork_forecast.json 그대로 (화면은 정적 파일 /mock/pork_forecast.json도 읽을 수 있다)
    GET /lab/pork/mult       달별 고기 원가 배수 {basis_date, method, backtest_mape, base_value, by_month}
                             계획에 use_pork_forecast: true를 넣으면 /season/play·/season/run이 이 배수를 쓴다
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sim import pork_forecast as PF

router = APIRouter(prefix="/lab/pork", tags=["lab:pork"])


@router.get("/forecast")
def forecast() -> dict:
    d = PF._doc()
    if not d:
        raise HTTPException(404, "pork_forecast.json이 없어요. python -m pipelines.build_pork_forecast 로 만들어 주세요")
    return d


@router.get("/mult")
def mult() -> dict:
    return PF.summary()
