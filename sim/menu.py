"""메뉴판 (lab:menu): 여러 메뉴의 가격·원가·주문 비중 → 엔진의 객단가와 원가율.

메뉴 한 줄: {id, name, price, unit_cost, mix, kind: "main" | "side" | "drink"} (+ 화면이 쓰는 recipe, alt_recipe, cost_source)
  price      판매가 (원)
  unit_cost  한 개(1인분, 1잔, 1병)를 내는 데 드는 재료비 (원). ingredients_today.json으로 다시 계산할 수 있다
  mix        같은 종류 안에서의 주문 비중. 종류마다 합으로 나눠 쓴다 (합이 100이 아니어도 된다)

몇 개를 시키는지는 학습자가 아니라 자료가 정한다 (엔진과 같은 값):
  고깃집  고기: 손님 1명이 1인분 (S28;S74). 주류·음료: 1인 0.9병 (S62, 가격 탄력성으로 변함).
          식사·사이드: 1인 사이드 지출 3,500원 (S30)을 기본 메뉴의 사이드 평균 가격으로 나눈 개수.
  카페    음료: 결제 1건 1.6잔. 디저트: 매출 비중 18.5%를 기본 메뉴의 디저트 평균 가격으로 나눈 개수.
가게 앞에서 손님이 보는 가격 수준은 종류별 (메뉴 평균 가격 ÷ 기본 메뉴 평균 가격)을 엔진의 매출 비중으로 섞은 값이다.
그래서 비싼 메뉴 쪽으로 비중을 옮기면 객단가는 오르고 손님은 조금 줄어든다 (메뉴만 바꿔서 공짜로 매출이 늘지 않게).

메뉴가 없으면(None, []) 엔진은 예전 그대로다 (삼겹살 한 가지 가격). 이 파일은 엔진의 숫자를 바꾸지 않고 덮어쓸 값만 만든다.
"""
from __future__ import annotations

import functools
import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MENUS = ROOT / "research" / "menus"
SNAPSHOT = ROOT / "web" / "public" / "mock" / "ingredients_today.json"
KINDS = ("main", "side", "drink")
MAX_ITEMS = 30
# 원가 하한 (판매가 대비, 가정): 원가 0원 같은 공짜 이익을 막는다. 고기는 수입 냉동 목살이 약 6%라 5%로 두고, 원육 등급별 하한은
# check_grade_cost가 따로 본다. 사이드·음료는 기본 메뉴에서 가장 낮은 공기밥이 약 17%
MIN_COST_SHARE = {"main": 0.05, "side": 0.10, "drink": 0.10}
# 가격 수준 허용 범위 (기본 메뉴 = 1). 고깃집 고기는 엔진의 삼겹살 가격 범위 12,000~30,000원 ÷ 19,000원, 주류는 3,000~9,000원 ÷ 5,000원
LEVEL_RANGE = {"bbq": {"main": (12000 / 19000, 30000 / 19000), "drink": (0.6, 1.8), "side": (0.5, 1.6)},
               "cafe": {"drink": (0.5, 1.8), "side": (0.5, 1.8)}}
KIND_KO = {"bbq": {"main": "고기", "side": "식사·사이드", "drink": "주류·음료"}, "cafe": {"main": "푸드", "side": "디저트·푸드", "drink": "음료"}}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


# ------------------------------------------------------------------------------------------------- data
@functools.lru_cache(maxsize=4)
def template(industry: str) -> dict:
    if industry not in ("bbq", "cafe"):
        raise ValueError(f"메뉴 기본값이 없는 업종: {industry}")
    return yaml.safe_load((MENUS / f"{industry}.yaml").read_text(encoding="utf-8"))


def _snap_cached(mtime: float) -> dict:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8")) if SNAPSHOT.exists() else {"_meta": {}, "items": {}}


_SNAP: dict = {}


def snapshot() -> dict:
    """ingredients_today.json (pipelines/fetch_ingredients.py). 파일이 바뀌면 다시 읽는다."""
    m = SNAPSHOT.stat().st_mtime if SNAPSHOT.exists() else 0.0
    if _SNAP.get("m") != m:
        _SNAP.update(m=m, doc=_snap_cached(m))
    return _SNAP["doc"]


def _avg(items: list[dict], key: str) -> float:
    w = sum(x["mix"] for x in items)
    return sum(x[key] * x["mix"] for x in items) / w


@functools.lru_cache(maxsize=4)
def ref_prices(industry: str) -> dict[str, float]:
    """기본 메뉴의 종류별 평균 가격 (주문 비중 가중). 손님이 '보통'이라고 느끼는 가격 수준의 기준."""
    t = template(industry)
    out = {}
    for k in KINDS:
        xs = [x for x in t["items"] if x["kind"] == k and x["mix"] > 0]
        if xs:
            out[k] = _avg(xs, "price")
    return out


# ------------------------------------------------------------------------------------------------- validation
def clean(menu, industry: str | None = None) -> list[dict] | None:
    """화면·API에서 온 메뉴를 검사한다. None 또는 빈 목록이면 None (메뉴 없음 = 예전 그대로). 형식이 틀리면 ValueError."""
    if menu is None:
        return None
    if not isinstance(menu, list):
        raise ValueError("menu는 목록이어야 합니다")
    if not menu:
        return None
    if len(menu) > MAX_ITEMS:
        raise ValueError(f"메뉴는 {MAX_ITEMS}개까지입니다")
    out, seen = [], set()
    for i, x in enumerate(menu):
        if not isinstance(x, dict):
            raise ValueError(f"menu[{i}]가 객체가 아닙니다")
        mid = str(x.get("id", ""))
        if not _ID.match(mid) or mid in seen:
            raise ValueError(f"menu[{i}].id가 비었거나 겹칩니다")
        seen.add(mid)
        kind = x.get("kind")
        if kind not in KINDS:
            raise ValueError(f"menu[{i}].kind는 main, side, drink 중 하나여야 합니다")
        try:
            price, cost, mix = float(x["price"]), float(x.get("unit_cost", 0)), float(x.get("mix", 0))
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"menu[{i}]의 price, unit_cost, mix는 숫자여야 합니다") from e
        if not (100 <= price <= 300_000):
            raise ValueError(f"menu[{i}].price는 100원 ~ 30만원이어야 합니다")
        floor = MIN_COST_SHARE[kind]
        if not (price * floor <= cost <= price * 3):
            raise ValueError(f"'{x.get('name') or mid}'의 원가는 판매가의 {round(floor * 100)}% ~ 3배여야 합니다")
        if not (0 <= mix <= 1000):
            raise ValueError(f"menu[{i}].mix는 0 ~ 1000이어야 합니다")
        name = str(x.get("name") or mid)[:24]
        out.append({"id": mid, "name": name, "kind": kind, "price": price, "unit_cost": cost, "mix": mix})
    has = {k for k in KINDS if any(x["kind"] == k and x["mix"] > 0 for x in out)}
    need = {"bbq": ("main", "drink"), "cafe": ("drink",)}.get(industry or "", ())
    ko = {"main": "고기", "side": "식사·사이드", "drink": "주류·음료" if industry == "bbq" else "음료"}
    miss = [ko[k] for k in need if k not in has]
    if miss:
        raise ValueError(f"메뉴판에 주문 비중이 있는 {', '.join(miss)} 메뉴가 한 개 이상 있어야 합니다")
    return out


def kind_stats(menu: list[dict], industry: str, scale: float = 1.0) -> dict[str, dict]:
    """종류별 평균 판매가·원가 (주문 비중 가중)와 가격 수준(기본 메뉴 평균 대비). scale = 카페 상권 배율."""
    refs = ref_prices(industry)
    out = {}
    for k in KINDS:
        xs = [x for x in menu if x["kind"] == k and x["mix"] > 0]
        if not xs:
            continue
        price, cost = _avg(xs, "price"), _avg(xs, "unit_cost")
        ref = refs.get(k, price) * scale
        out[k] = {"price": price, "cost": cost, "ref": ref, "ratio": price / ref, "n": len(xs)}
    return out


def check_levels(menu: list[dict], industry: str, scale: float = 1.0) -> None:
    """종류별 가격 수준이 엔진이 맞춰진 범위를 벗어나면 ValueError (가격을 크게 올려 손님이 거의 안 줄어드는 구간을 막는다)."""
    for k, v in kind_stats(menu, industry, scale).items():
        lo, hi = LEVEL_RANGE[industry].get(k, (0.5, 1.8))
        if not lo - 1e-9 <= v["ratio"] <= hi + 1e-9:
            raise ValueError(f"{KIND_KO[industry][k]} 평균 가격이 기본 메뉴의 {round(v['ratio'] * 100)}%예요. "
                             f"{round(lo * 100)}~{round(hi * 100)}% 안에서 정해 주세요")


def check_grade_cost(menu: list[dict], grade_label: str, grade_cost: float) -> None:
    """원육 등급에 비해 고기 원가가 너무 낮으면 ValueError (숙성 고기를 수입육 원가로 파는 것을 막는다). 하한 = 등급 원가의 60% (가정)."""
    m = kind_stats(menu, "bbq")["main"]
    if m["cost"] < 0.6 * grade_cost:
        raise ValueError(f"{grade_label} 고기인데 1인분 평균 원가가 {round(m['cost']):,}원이에요. "
                         f"{round(0.6 * grade_cost):,}원 이상이어야 해요 (원가를 오늘 시세로 다시 계산해 보세요)")


# ------------------------------------------------------------------------------------------------- 고깃집 엔진 (sim/season.py)
def bbq_plan_prices(menu: list[dict], base_meat: float, base_soju: float) -> tuple[int, int]:
    """계획의 meat_price, soju_price 자리에 넣을 값: 메뉴의 가격 수준을 삼겹살·소주 기준 가격으로 환산.
    만족도(비싸다), 가격 상한, 지난달과의 가격 변경 판정이 이 값을 그대로 쓴다."""
    k = kind_stats(menu, "bbq")
    return round(base_meat * k["main"]["ratio"]), round(base_soju * k["drink"]["ratio"])


def apply_bbq(p: dict, a: dict, menu: list[dict], pork: float, w_meat: float, w_alc: float, base_side_spend: float,
              table: dict | None = None) -> None:
    """_setup의 엔진 입력을 메뉴로 덮어쓴다 (제자리 수정). pork = 이번 달 돼지고기 원가 배율 (사건, 원육 등급 반영).
    고기: 1인분 평균 가격·원가. 주류·음료: 1병 평균 가격·원가. 식사·사이드: 평균 가격, 원가율, 1인 개수는 자료 고정.
    가게 앞 가격 수준(_price_index)의 사이드 몫을 메뉴의 사이드 가격 수준으로 바꾼다 (고기·주류 몫은 계획 가격에 이미 들어 있다)."""
    k = kind_stats(menu, "bbq")
    m, d = k["main"], k["drink"]
    p["prd_meat_price"] = m["price"]
    p["cst_meat_cost_per_portion"] = m["cost"] * pork
    p["prd_alcohol_price"] = d["price"]
    p["cst_alcohol_cost_per_bottle"] = d["cost"]
    s = k.get("side")
    if s:
        per_cover = base_side_spend / ref_prices("bbq")["side"]   # 사이드 개수/인: 자료의 지출 ÷ 기본 메뉴 사이드 평균 가격
        a["meal_price"] = s["price"]
        p["prd_side_spend_per_cover"] = per_cover * s["price"]
        p["cst_side_cost_ratio"] = s["cost"] / s["price"]
        side_ratio = s["ratio"]
    else:
        p["prd_side_spend_per_cover"] = 0.0
        side_ratio = 1.0
    p["_price_index"] += (1 - w_meat - w_alc) * (side_ratio - 1)
    if table and table.get("cost") is not None:
        # 기본 상차림: 엔진의 반찬 원가(반찬 가짓수 x 가짓수당 단가, 사건 배율 포함)를 상차림 원가로 바꾼다. 가짓수 비례는 그대로
        part = p["cst_banchan_cost_per_cover"] - table["extras"]
        engine_base = table["base_banchan"] * table["unit"]   # 엔진의 기본 반찬 원가 (5가지 x 단가)
        p["cst_banchan_cost_per_cover"] = part * table["cost"] / engine_base + table["extras"]


# ------------------------------------------------------------------------------------------------- 카페 엔진 (sim/cafe/season.py)
def cafe_scale(ticket: float, dessert_share: float, cups_per_tx: float) -> float:
    """상권 배율: 이 상권의 음료 한 잔 값(결제 1건 × 음료 몫 ÷ 잔 수) ÷ 기본 메뉴 음료 평균 가격."""
    return ticket * (1 - dessert_share) / cups_per_tx / ref_prices("cafe")["drink"]


def cafe_ctx(menu: list[dict] | None, ticket: float, dessert_share: float, cups_per_tx: float) -> dict | None:
    if not menu:
        return None
    scale = cafe_scale(ticket, dessert_share, cups_per_tx)
    check_levels(menu, "cafe", scale)
    k = kind_stats(menu, "cafe", scale)
    food = [x for x in menu if x["kind"] in ("main", "side") and x["mix"] > 0]   # 카페는 main도 푸드로 센다
    f = None
    if food:
        price, cost = _avg(food, "price"), _avg(food, "unit_cost")
        ref = ref_prices("cafe")["side"] * scale
        f = {"price": price, "cost": cost, "ref": ref, "ratio": price / ref}
    return {"drink": k["drink"], "food": f, "scale": scale, "cups": cups_per_tx, "ticket": ticket, "ds": dessert_share}


def cafe_price_index(mc: dict, dessert_on: bool) -> float:
    """가게 앞 가격 수준: 음료와 디저트의 가격 수준을 매출 비중(18.5%)으로 섞는다. 디저트를 안 팔면 음료만."""
    if dessert_on and mc["food"]:
        return (1 - mc["ds"]) * mc["drink"]["ratio"] + mc["ds"] * mc["food"]["ratio"]
    return mc["drink"]["ratio"]


def cafe_money(mc: dict, ds_eff: float, served: float, price_mult: float) -> tuple[float, float, float, float]:
    """(객단가, 매출, 디저트 매출, 식재료비). 음료 = 1.6잔 x 평균 가격. 디저트 개수는 자료의 디저트 매출(기본 메뉴 가격 기준)에서
    정하고 가격은 메뉴를 따른다. 가격 조정(price_mult)은 매출에만, 원가는 그대로 (엔진과 같다)."""
    drink_po = mc["cups"] * mc["drink"]["price"]
    drink_cost = mc["cups"] * mc["drink"]["cost"]
    dessert_po = dessert_cost = 0.0
    if mc["food"] and ds_eff > 0:
        base_dessert = mc["ticket"] * (1 - mc["ds"]) * ds_eff / (1 - ds_eff)   # 기본 메뉴일 때 결제 1건의 디저트 매출
        qty = base_dessert / mc["food"]["ref"]
        dessert_po, dessert_cost = qty * mc["food"]["price"], qty * mc["food"]["cost"]
    ticket = (drink_po + dessert_po) * price_mult
    return ticket, served * ticket, served * dessert_po * price_mult, served * (drink_cost + dessert_cost)


# ------------------------------------------------------------------------------------------------- 원가 계산 (오늘 시세)
def cafe_drink_overhead(scale: float, snap: dict | None = None) -> dict:
    """카페 음료의 손실·부자재 몫 (가정): 이 상권의 기본 메뉴가 업계 평균 식재료비율(38.9%)이 되게 맞춘다. 판매가는 상권을 따라
    늘고 줄지만 재료값은 그대로라, 같은 비율로 두면 싼 동네는 원가율이 80%, 비싼 동네는 14%가 된다 (기본 메뉴가 중립이 아님)."""
    t = template("cafe")
    snap = snap or snapshot()
    ds = 0.185   # 디저트 매출 비중 (research/cafe/params.yaml season.dessert_share)
    try:
        from sim.cafe.params import v as cv
        ds = cv("season", "dessert_share")
    except Exception:   # noqa: BLE001  params를 못 읽어도 기본값으로 계산
        pass
    drinks = [x for x in t["items"] if x["kind"] == "drink" and x["mix"] > 0]
    food = [x for x in t["items"] if x["kind"] != "drink" and x["mix"] > 0]
    raw = lambda x: item_cost(x, "cafe", "domestic", snap, overhead={"value": 0.0})["raw"]   # noqa: E731
    w_d, w_f = sum(x["mix"] for x in drinks), sum(x["mix"] for x in food)
    raw_d = sum(raw(x) * x["mix"] for x in drinks) / w_d
    p_d = sum(x["price"] * x["mix"] for x in drinks) / w_d * scale
    oh_f = t["overhead"]["side"]["value"]
    cr_f = (sum(raw(x) * x["mix"] for x in food) / w_f * (1 + oh_f)) / (sum(x["price"] * x["mix"] for x in food) / w_f * scale)
    target = (t["benchmark"]["cost_ratio"] - ds * cr_f) / (1 - ds)
    val = min(3.0, max(0.10, target * p_d / raw_d - 1))
    base = t["overhead"]["drink"]
    return {**base, "value": round(val, 3),
            "note": f"이 상권의 기본 메뉴가 업계 평균 식재료비율 {t['benchmark']['cost_ratio'] * 100:.1f}%가 되게 맞춘 값 (가정). "
                    "레시피에 없는 손실·시럽·얼음·직원 음료·테스트 추출 몫"}


def item_cost(item: dict, industry: str, grade: str = "domestic", snap: dict | None = None, overhead: dict | None = None) -> dict:
    """recipe → 원가 내역. 재료 단가는 ingredients_today.json, 없는 재료는 missing. 손실(overhead)은 가정."""
    snap = snap or snapshot()
    t = template(industry)
    recipe = item.get("recipe") or []
    if industry == "bbq" and item.get("kind") == "main" and grade == "imported":
        recipe = (item.get("alt_recipe") or {}).get("imported") or recipe
    lines, missing = [], []
    for ing, qty in recipe:
        s = snap["items"].get(ing)
        if not s:
            missing.append(ing)
            continue
        lines.append({"ing": ing, "name": s["name"], "qty": qty, "unit": s["unit"], "unit_price": s["price"],
                      "amount": round(qty * s["price"]), "source": s["source"], "date": s.get("date"),
                      "stage": s.get("stage")})
    raw = sum(x["amount"] for x in lines)
    oh = overhead or t["overhead"].get(item.get("kind"), {"value": 0.0})
    mult = t["aged_cost_mult"]["value"] if industry == "bbq" and item.get("kind") == "main" and grade == "aged" else 1.0
    total = raw * mult * (1 + oh["value"])
    assumed = sum(x["amount"] for x in lines if x["stage"] == "가정")
    return {"unit_cost": round(total, -1), "raw": raw, "overhead": oh, "aged_mult": mult, "lines": lines, "missing": missing,
            "assumed_share": assumed / raw if raw else 1.0}


def table_setting(industry: str = "bbq", snap: dict | None = None) -> dict | None:
    """기본 상차림 원가 (손님 1명당, 반찬 기본 가짓수 기준). 고깃집만."""
    ts = template(industry).get("table_setting")
    if not ts:
        return None
    c = item_cost({"recipe": ts["recipe"], "kind": "_table"}, industry, "domestic", snap, overhead=ts["overhead"])
    return {"label": ts["label"], "base_banchan": ts["base_banchan"], "cost": c["unit_cost"], "cost_source": "data",
            "cost_detail": c}


def with_costs(menu: list[dict], industry: str, grade: str = "domestic", scale: float = 1.0) -> list[dict]:
    """recipe가 있고 직접 고치지 않은(cost_source != user) 메뉴의 unit_cost를 오늘 시세로 다시 계산한다. scale = 카페 상권 배율."""
    snap = snapshot()
    oh_drink = cafe_drink_overhead(scale, snap) if industry == "cafe" else None
    out = []
    for x in menu:
        y = dict(x)
        if y.get("recipe"):
            c = item_cost(y, industry, grade, snap, overhead=oh_drink if y.get("kind") == "drink" else None)
            if y.get("cost_source") != "user" and not c["missing"]:   # 직접 고친 원가는 그대로, 내역만 붙인다
                y["unit_cost"] = c["unit_cost"]
                y["cost_source"] = "data" if c["assumed_share"] < 0.5 else "가정"
            y["cost_detail"] = c
        out.append(y)
    return out


def template_menu(industry: str, grade: str = "domestic", scale: float = 1.0) -> list[dict]:
    """기본 메뉴판 (원가는 오늘 시세로 계산). 카페는 scale(상권 배율)만큼 판매가를 늘이거나 줄인다 (100원 단위)."""
    items = []
    for x in template(industry)["items"]:
        y = {k: x[k] for k in ("id", "name", "kind", "price", "mix", "recipe") if k in x}
        if "alt_recipe" in x:
            y["alt_recipe"] = x["alt_recipe"]
        if "portion" in x:
            y["portion"] = x["portion"]
        y["price"] = int(round(x["price"] * scale, -2))
        y["unit_cost"] = 0
        items.append(y)
    return with_costs(items, industry, grade, scale)


def summary(menu: list[dict], industry: str, scale: float = 1.0) -> dict:
    """화면 요약: 종류별 평균 가격·원가율과 가격 수준."""
    k = kind_stats(clean(menu, industry) or [], industry, scale)
    return {kk: {"price": round(v["price"]), "cost_ratio": round(v["cost"] / v["price"], 3), "level": round(v["ratio"], 3)}
            for kk, v in k.items()}
