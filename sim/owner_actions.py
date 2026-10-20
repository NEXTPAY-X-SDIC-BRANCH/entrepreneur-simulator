"""Owner reaction menu: pure functions params -> new params.

An LLM owner agent (agents/, later) picks ONE action id plus its arguments from MENU after seeing a shock;
the simulation then reruns with the returned params (shock → owner reaction → second-order result).
Nothing here calls an LLM. Every function returns a new dict and never mutates its input.
"""
from __future__ import annotations

from sim.params import clone

MENU = {
    "absorb": {"label": "그대로 버티기", "phrase": "그대로 버티면",
               "description_ko": "가격도 인력도 메뉴도 그대로 둔다", "args": {}, "default_args": {}},
    "reprice": {"label": "고기 가격 5% 올리기", "phrase": "고기 가격을 5% 올리면",
                "description_ko": "고기 판매가를 올린다. 손님 수는 가격탄력성만큼 줄어든다",
                "args": {"pct": [0.0, 0.15]}, "default_args": {"pct": 0.05}},
    "discount": {"label": "고기 가격 5% 내리기", "phrase": "고기 가격을 5% 내리면",
                 "description_ko": "고기 판매가를 내린다. 손님은 늘지만 객단가가 내려간다",
                 "args": {"pct": [-0.15, 0.0]}, "default_args": {"pct": -0.05}},
    "reprice_alcohol": {"label": "소주 500원 올리기", "phrase": "소주 가격을 500원 올리면",
                        "description_ko": "소주 판매가를 올린다. 1인당 병수가 조금 줄어든다",
                        "args": {"delta_krw": [-1000, 2000]}, "default_args": {"delta_krw": 500}},
    "cut_staff_hours": {"label": "알바 근무 1시간 줄이기", "phrase": "알바 근무를 하루 1시간 줄이면",
                        "description_ko": "교대 시간을 줄여 인건비를 아낀다",
                        "args": {"hours": [0.5, 3.0]}, "default_args": {"hours": 1.0}},
    "cut_staff": {"label": "교대당 알바 1명 줄이기", "phrase": "교대마다 알바를 한 명 줄이면",
                  "description_ko": "인건비는 줄지만 서빙이 느려져 대기와 이탈이 늘 수 있다",
                  "args": {"n": [1, 2]}, "default_args": {"n": 1}},
    "change_mix": {"label": "술과 식사 더 권하기", "phrase": "술과 식사를 더 권하면",
                   "description_ko": "1인당 주류와 식사 주문을 10%씩 늘린다 (권유가 통한다는 가정)",
                   "args": {"alcohol_pct": [-0.3, 0.3], "side_pct": [-0.3, 0.3]},
                   "default_args": {"alcohol_pct": 0.1, "side_pct": 0.1}},
}


def _check(action: str, **kw) -> None:
    spec = MENU[action]["args"]
    for k, v in kw.items():
        if k not in spec:
            raise ValueError(f"{action}: unknown argument {k}")
        lo, hi = spec[k]
        if not lo <= v <= hi:
            raise ValueError(f"{action}: {k}={v} outside [{lo}, {hi}]")


def absorb(params: dict) -> dict:
    return clone(params)


def reprice(params: dict, pct: float) -> dict:
    _check("reprice", pct=pct)
    p = clone(params)
    p["prd_meat_price"] = params["prd_meat_price"] * (1 + pct)
    return p


def discount(params: dict, pct: float) -> dict:
    _check("discount", pct=pct)
    p = clone(params)
    p["prd_meat_price"] = params["prd_meat_price"] * (1 + pct)
    return p


def reprice_alcohol(params: dict, delta_krw: float) -> dict:
    _check("reprice_alcohol", delta_krw=delta_krw)
    p = clone(params)
    p["prd_alcohol_price"] = params["prd_alcohol_price"] + delta_krw
    return p


def cut_staff_hours(params: dict, hours: float) -> dict:
    _check("cut_staff_hours", hours=hours)
    p = clone(params)
    p["sto_parttime_shift_hours"] = max(0.0, params["sto_parttime_shift_hours"] - hours)
    return p


def cut_staff(params: dict, n: int) -> dict:
    _check("cut_staff", n=n)
    p = clone(params)
    p["sto_parttimers"] = max(0, int(params["sto_parttimers"]) - int(n))
    return p


def change_mix(params: dict, alcohol_pct: float = 0.0, side_pct: float = 0.0) -> dict:
    _check("change_mix", alcohol_pct=alcohol_pct, side_pct=side_pct)
    p = clone(params)
    p["prd_alcohol_per_cover"] = params["prd_alcohol_per_cover"] * (1 + alcohol_pct)
    p["prd_side_spend_per_cover"] = params["prd_side_spend_per_cover"] * (1 + side_pct)
    return p


ACTIONS = {"absorb": absorb, "reprice": reprice, "discount": discount, "reprice_alcohol": reprice_alcohol,
           "cut_staff_hours": cut_staff_hours, "cut_staff": cut_staff, "change_mix": change_mix}


def apply_action(params: dict, action: str, **kwargs) -> dict:
    """Entry point for the owner agent: validates the action id and argument bounds.
    With no kwargs, the action's default_args are used."""
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action}; choose from {sorted(ACTIONS)}")
    return ACTIONS[action](params, **(kwargs or MENU[action]["default_args"]))
