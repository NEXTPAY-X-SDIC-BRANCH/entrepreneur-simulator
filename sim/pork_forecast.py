"""돼지고기 도매가 예측 → 엔진 고기 원가 배수 (lab:pork).

    meat_cost_mult(month) -> float      1.0 = 기준 달(마지막 실제 달) 삼겹 도매가

예측은 pipelines/build_pork_forecast.py가 만든 web/public/mock/pork_forecast.json의 cost_mult를 읽는다.
기준 달 다음 12개월(예: 2026-10 ~ 2027-09) 각각의 예측 중간값 ÷ 기준 달 값이다. 달(1~12)은 그 12개월 안에서
한 번씩만 나오므로 달 번호만으로 찾는다. 파일이 없거나 그 달 값이 없으면 1.0 (엔진은 지금과 같게 돈다).

엔진은 계획에 use_pork_forecast: true가 있을 때만 이 배수를 쓴다 (sim/season.py _setup, 기본은 끔).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

FORECAST = Path(__file__).resolve().parents[1] / "web" / "public" / "mock" / "pork_forecast.json"
CLAMP = (0.6, 1.6)   # 파일이 깨져도 엔진이 터무니없는 원가로 돌지 않게 (가정 안전장치)


@lru_cache(maxsize=1)
def _doc() -> dict:
    try:
        return json.loads(FORECAST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def reload() -> None:
    _doc.cache_clear()


def table() -> dict[int, float]:
    by = ((_doc().get("cost_mult") or {}).get("by_month")) or {}
    out = {}
    for k, v in by.items():
        try:
            m, x = int(k), float(v)
        except (TypeError, ValueError):
            continue
        if 1 <= m <= 12 and x > 0:
            out[m] = min(max(x, CLAMP[0]), CLAMP[1])
    return out


def meat_cost_mult(month: int) -> float:
    return table().get(int(month), 1.0)


def summary() -> dict:
    d = _doc()
    meta = d.get("_meta", {})
    return {"basis_date": meta.get("basis_date"), "method": meta.get("method"), "backtest_mape": meta.get("backtest_mape"),
            "base_value": (d.get("cost_mult") or {}).get("base_value"), "by_month": {m: meat_cost_mult(m) for m in range(1, 13)}}
