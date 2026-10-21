"""메뉴판 API (lab:menu). 기본 메뉴판과 오늘 시세로 원가 다시 계산하기. 엔진 계산은 sim/menu.py.

    GET  /lab/menu/template?industry=bbq|cafe&grade=domestic&district=   기본 메뉴 (원가 = 오늘 시세)
    POST /lab/menu/recompute {industry, grade?, district?, menu}         recipe가 있는 메뉴의 원가를 다시 계산
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

from sim import menu as M
from sim.params import load_params

router = APIRouter(prefix="/lab/menu", tags=["lab-menu"])
GRADES = ("imported", "domestic", "aged")


def _scale(industry: str, district: str | None) -> float:
    if industry != "cafe" or not district:
        return 1.0
    from sim.cafe.params import load_districts, v
    d = load_districts().get(district)
    if not d:
        raise HTTPException(422, f"unknown district {district}")
    return M.cafe_scale(d["ticket_krw"]["value"], v("season", "dessert_share"), v("demand", "cups_per_tx"))


def _per_cover(industry: str, menu: list[dict], scale: float) -> dict:
    """1인(카페는 결제 1건) 예상 지출: 자료가 정한 개수 x 메뉴 평균 가격. 가격 탄력성 전, 화면 요약용."""
    k = M.kind_stats(M.clean(menu, industry) or [], industry, scale)
    if industry == "bbq":
        p = load_params()
        side = k.get("side")
        parts = {"main": k["main"]["price"] * p["prd_portions_per_cover"] if "main" in k else 0.0,
                 "drink": k["drink"]["price"] * p["prd_alcohol_per_cover"] if "drink" in k else 0.0,
                 "side": side["price"] * p["prd_side_spend_per_cover"] / M.ref_prices("bbq")["side"] if side else 0.0}
        cost = ((k["main"]["cost"] * p["prd_portions_per_cover"] if "main" in k else 0.0)
                + (k["drink"]["cost"] * p["prd_alcohol_per_cover"] if "drink" in k else 0.0)
                + (side["cost"] * p["prd_side_spend_per_cover"] / M.ref_prices("bbq")["side"] if side else 0.0))
    else:
        from sim.cafe.params import v
        mc = M.cafe_ctx(M.clean(menu, "cafe"), M.ref_prices("cafe")["drink"] * scale * v("demand", "cups_per_tx")
                        / (1 - v("season", "dessert_share")), v("season", "dessert_share"), v("demand", "cups_per_tx"))
        ds = v("season", "dessert_share")
        t, _, _, food = M.cafe_money(mc, ds, 1.0, 1.0)
        parts = {"drink": mc["cups"] * mc["drink"]["price"], "side": t - mc["cups"] * mc["drink"]["price"]}
        cost = food
    total = sum(parts.values())
    return {"ticket": round(total), "parts": {k_: round(x) for k_, x in parts.items()},
            "cost_ratio": round(cost / total, 3) if total else 0.0}


def _out(industry: str, menu: list[dict], scale: float) -> dict:
    t = M.template(industry)
    snap = M.snapshot()
    return {"industry": industry, "items": menu, "kinds": t["kinds"], "overhead": t["overhead"],
            "aged_cost_mult": t.get("aged_cost_mult"), "scale": round(scale, 4),
            "levels": M.summary(menu, industry, scale), "per_cover": _per_cover(industry, menu, scale),
            "snapshot": {"basis_date": snap["_meta"].get("basis_date"), "generated": snap["_meta"].get("generated"),
                         "caveat": snap["_meta"].get("caveat"),
                         "sources": [{k: s.get(k) for k in ("id", "publisher", "title", "url", "stage", "status", "basis_date", "note")}
                                     for s in snap["_meta"].get("sources", [])]}}


@router.get("/template")
def menu_template(industry: str = "bbq", grade: str = "domestic", district: str | None = None) -> dict:
    if industry not in ("bbq", "cafe") or grade not in GRADES:
        raise HTTPException(422, "industry는 bbq|cafe, grade는 imported|domestic|aged")
    sc = _scale(industry, district)
    return _out(industry, M.template_menu(industry, grade, sc), sc)


@router.post("/recompute")
def menu_recompute(body: dict[str, Any] = Body(...)) -> dict:
    industry, grade = body.get("industry", "bbq"), body.get("grade", "domestic")
    if industry not in ("bbq", "cafe") or grade not in GRADES:
        raise HTTPException(422, "industry는 bbq|cafe, grade는 imported|domestic|aged")
    menu = body.get("menu")
    try:
        M.clean(menu, industry)   # 형식 검사 (recipe 같은 화면용 값은 그대로 둔다)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    keep = ("id", "name", "kind", "price", "unit_cost", "mix", "recipe", "alt_recipe", "portion", "cost_source")
    items = [{k: x[k] for k in keep if k in x} for x in menu]
    if body.get("force"):   # '오늘 시세로 다시 계산': 직접 고친 원가도 recipe가 있으면 시세 값으로 되돌린다
        for x in items:
            x.pop("cost_source", None)
    sc = _scale(industry, body.get("district"))
    return _out(industry, M.with_costs(items, industry, grade), sc)
