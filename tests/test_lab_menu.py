"""lab:menu 메뉴판: 메뉴가 없으면 엔진 숫자가 그대로, 있으면 객단가와 원가가 메뉴를 따른다. 식자재 스냅샷과 API."""
import json

import pytest
from fastapi.testclient import TestClient

from api.changeup import app
from pipelines import fetch_ingredients as FI
from sim import menu as M
from sim import season as S
from sim.cafe import season as C
from sim.cafe.params import load_districts, v as cv
from sim.params import load_params

CAFE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
            showcase=1, oven=1, kiosks=1, pos=1, own_capital_krw=300_000_000)


@pytest.fixture(scope="module", autouse=True)
def hero_store():
    S.set_store(None)
    yield


def _bbq(plan, events=()):
    st = S.new_season(7)
    out, su = S._calibrated(st, plan, list(events))
    return out, su


def _cafe_month(menu="absent", decisions=None, **kw):
    b = {**CAFE, **kw, "seed": 3}
    if menu != "absent":
        b["menu"] = menu
    run = C.start(b)
    return C.play_month(run, decisions or {})[1]


def _scale(district):
    t = load_districts()[district]["ticket_krw"]["value"]
    return M.cafe_scale(t, cv("season", "dessert_share"), cv("demand", "cups_per_tx"))


# ------------------------------------------------------------------------------------------------- absent = identical
def test_bbq_menu_absent_is_identical():
    base = S.base_plan()
    ref, su_ref = _bbq(base)
    for plan in ({**base, "menu": None}, {**base, "menu": []}):
        out, su = _bbq(plan)
        assert json.dumps(out, sort_keys=True, default=str) == json.dumps(ref, sort_keys=True, default=str)
        assert su["params"] == su_ref["params"] and su["a"] == su_ref["a"]
        assert "menu" not in su["plan"]
    assert "menu" not in S._validate(base)


def test_cafe_menu_absent_is_identical():
    ref = _cafe_month()
    for menu in (None, []):
        assert json.dumps(_cafe_month(menu), sort_keys=True) == json.dumps(ref, sort_keys=True)


# ------------------------------------------------------------------------------------------------- present = follows
def test_bbq_ticket_and_cogs_follow_the_menu():
    p0 = load_params()
    tm = M.template_menu("bbq")
    out, su = _bbq({**S.base_plan(), "menu": tm})
    k = M.kind_stats(M.clean(tm, "bbq"), "bbq")
    p = su["params"]
    assert p["prd_meat_price"] == pytest.approx(k["main"]["price"])
    assert p["cst_meat_cost_per_portion"] == pytest.approx(k["main"]["cost"])
    assert p["prd_alcohol_price"] == pytest.approx(k["drink"]["price"])
    assert p["cst_alcohol_cost_per_bottle"] == pytest.approx(k["drink"]["cost"])
    side_per_cover = p0["prd_side_spend_per_cover"] / M.ref_prices("bbq")["side"]
    assert p["prd_side_spend_per_cover"] == pytest.approx(side_per_cover * k["side"]["price"])
    assert p["cst_side_cost_ratio"] == pytest.approx(k["side"]["cost"] / k["side"]["price"])
    # 기본 메뉴의 가격 수준 = 1: 가게 앞 가격 지수와 계획 가격은 메뉴가 없을 때와 같다
    ref, su_ref = _bbq(S.base_plan())
    assert p["_price_index"] == pytest.approx(su_ref["params"]["_price_index"])
    assert su["plan"]["meat_price"] == 19000 and su["plan"]["soju_price"] == 5000
    # 객단가 = 1인분 x 고기 평균 + 병 수 x 음료 평균 + 사이드 개수 x 사이드 평균 (가격 탄력성으로 병 수만 변함)
    bottles = (out["ticket"] - p["prd_portions_per_cover"] * k["main"]["price"] - p["prd_side_spend_per_cover"]) / k["drink"]["price"]
    assert 0.85 < bottles < 1.0
    assert out["ticket"] != ref["ticket"]


def test_bbq_menu_prices_and_costs_move_the_month():
    base = S.base_plan()
    tm = M.template_menu("bbq")
    a, _ = _bbq({**base, "menu": tm})
    up, su_up = _bbq({**base, "menu": [dict(x, price=x["price"] * 1.2) for x in tm]})
    assert up["ticket"] > a["ticket"] * 1.15 and up["covers"] < a["covers"]        # 비싸면 객단가는 오르고 손님은 준다
    assert su_up["plan"]["meat_price"] == round(19000 * 1.2)
    cheap, _ = _bbq({**base, "menu": [dict(x, unit_cost=x["unit_cost"] / 2) for x in tm]})
    assert cheap["revenue"] == pytest.approx(a["revenue"])
    assert cheap["cogs"] < a["cogs"] * 0.7 and cheap["op"] > a["op"]                 # 반찬 원가는 메뉴 밖이라 절반보다 덜 준다
    # 비싼 메뉴로 비중만 옮겨도 공짜 매출이 아니다: 가격 수준이 올라 손님이 준다
    pricey = [dict(x, mix=100 if x["id"] == "hangjeong" else (1 if x["kind"] == "main" else x["mix"])) for x in tm]
    mx, _ = _bbq({**base, "menu": pricey})
    assert mx["ticket"] > a["ticket"] and mx["covers"] < a["covers"]


def test_bbq_menu_pork_event_still_raises_meat_cost():
    tm = M.template_menu("bbq")
    a, su = _bbq({**S.base_plan(), "menu": tm})
    b, su_b = _bbq({**S.base_plan(), "menu": tm}, ["pork_up"])
    assert su_b["params"]["cst_meat_cost_per_portion"] > su["params"]["cst_meat_cost_per_portion"]


def test_bbq_menu_des_month_runs():
    st = S.new_season(7)
    r = S.play_month(st, {**S.base_plan(), "menu": M.template_menu("bbq")}, [], night=False, band_runs=3)
    k = r["draw"]["kpis"]
    assert k["revenue"] > 0 and 25000 < k["ticket"] < 31000
    assert r["state_after"]["plan"]["menu"][0]["id"] == "samgyeopsal"


def test_cafe_ticket_and_food_follow_the_menu():
    sc = _scale(CAFE["district"])
    tm = M.template_menu("cafe", scale=sc)
    ref, mo = _cafe_month(), _cafe_month(tm)
    k = M.kind_stats(M.clean(tm, "cafe"), "cafe", sc)
    assert k["drink"]["ratio"] == pytest.approx(1.0, abs=0.02)                        # 상권에 맞춘 기본 메뉴 = 가격 수준 1
    assert mo["kpi"]["customers"] == pytest.approx(ref["kpi"]["customers"], rel=0.03)
    assert mo["kpi"]["ticket_krw"] == pytest.approx(ref["kpi"]["ticket_krw"], rel=0.03)
    food = next(x["krw"] for x in mo["pnl"]["lines"] if x["key"] == "food")
    food0 = next(x["krw"] for x in ref["pnl"]["lines"] if x["key"] == "food")
    assert food != food0
    up = _cafe_month([dict(x, price=x["price"] * 1.2) for x in tm])
    assert up["kpi"]["ticket_krw"] > mo["kpi"]["ticket_krw"] * 1.15 and up["kpi"]["customers"] < mo["kpi"]["customers"]
    cheap = _cafe_month([dict(x, unit_cost=x["unit_cost"] / 2) for x in tm])
    cf = next(x["krw"] for x in cheap["pnl"]["lines"] if x["key"] == "food")
    assert cf == pytest.approx(food / 2, rel=0.01) and cheap["kpi"]["revenue_krw"] == mo["kpi"]["revenue_krw"]
    no_dessert = _cafe_month(tm, {"dessert": False})
    assert no_dessert["pnl"]["dessert_revenue_krw"] == 0


# ------------------------------------------------------------------------------------------------- validation
@pytest.mark.parametrize("bad", [
    "x", [{"id": "a", "kind": "main", "price": 1000}], [{"id": "a", "kind": "drink", "price": 5000, "mix": 1}],
    [{"id": "a", "kind": "food", "price": 5000, "mix": 1}],
    [{"id": "a", "kind": "main", "price": 5000, "mix": 1}, {"id": "a", "kind": "drink", "price": 5000, "mix": 1}],
    [{"id": "a", "kind": "main", "price": 50, "mix": 1}, {"id": "b", "kind": "drink", "price": 5000, "mix": 1}],
    [{"id": "a", "kind": "main", "price": 5000, "unit_cost": 99999, "mix": 1}, {"id": "b", "kind": "drink", "price": 5000, "mix": 1}],
])
def test_bbq_menu_rejects_bad_shapes(bad):
    with pytest.raises(ValueError):
        M.clean(bad, "bbq")


def test_api_rejects_bad_menu_and_accepts_template():
    c = TestClient(app)
    r = c.post("/cafe/season", json={**CAFE, "menu": [{"id": "a", "kind": "side", "price": 4000, "mix": 1}]})
    assert r.status_code == 422
    t = c.get("/lab/menu/template", params={"industry": "cafe", "district": CAFE["district"]}).json()
    r = c.post("/cafe/season", json={**CAFE, "menu": t["items"]})
    assert r.status_code == 200, r.text
    st = c.post("/season/new", json={"seed": 5}).json()
    bad = [{"id": "a", "kind": "main", "price": 19000, "mix": 1}]
    assert c.post("/season/play", json={"state": st, "plan": {"menu": bad}, "night": False, "band_runs": 2}).status_code == 409


# ------------------------------------------------------------------------------------------------- 원가 계산과 스냅샷
def test_template_costs_come_from_the_snapshot_and_grade():
    c = TestClient(app)
    dom = {x["id"]: x for x in c.get("/lab/menu/template", params={"industry": "bbq"}).json()["items"]}
    imp = {x["id"]: x for x in c.get("/lab/menu/template", params={"industry": "bbq", "grade": "imported"}).json()["items"]}
    aged = {x["id"]: x for x in c.get("/lab/menu/template", params={"industry": "bbq", "grade": "aged"}).json()["items"]}
    snap = M.snapshot()["items"]
    line = dom["samgyeopsal"]["cost_detail"]["lines"][0]
    assert line["ing"] == "pork_belly" and line["unit_price"] == snap["pork_belly"]["price"] and line["date"]
    assert dom["samgyeopsal"]["unit_cost"] == round(0.2 * snap["pork_belly"]["price"] * 1.05, -1)
    assert imp["samgyeopsal"]["unit_cost"] < dom["samgyeopsal"]["unit_cost"] < aged["samgyeopsal"]["unit_cost"]
    assert imp["soju"]["unit_cost"] == dom["soju"]["unit_cost"]                      # 원육 등급은 고기만 바꾼다
    assert dom["naengmyeon"]["cost_source"] == "가정"                                 # 냉면 사리·육수는 공개 자료 없음


def test_recompute_keeps_user_costs_unless_forced():
    c = TestClient(app)
    items = c.get("/lab/menu/template", params={"industry": "bbq"}).json()["items"]
    items[0] = {**items[0], "unit_cost": 1234, "cost_source": "user"}
    kept = c.post("/lab/menu/recompute", json={"industry": "bbq", "menu": items}).json()["items"]
    assert kept[0]["unit_cost"] == 1234
    forced = c.post("/lab/menu/recompute", json={"industry": "bbq", "menu": items, "force": True}).json()
    assert forced["items"][0]["unit_cost"] != 1234
    assert forced["snapshot"]["basis_date"] and forced["per_cover"]["ticket"] > 20000


def test_ingredient_snapshot_offline_build_is_labelled(monkeypatch):
    monkeypatch.delenv("SEOUL_OPEN_DATA_KEY", raising=False)
    monkeypatch.delenv("SEOUL_API_KEY", raising=False)
    monkeypatch.setattr(FI, "_key", lambda name: None)
    prev = json.loads(FI.OUT.read_text(encoding="utf-8"))
    doc = FI.build(prev, offline=True)
    src = {s["id"]: s for s in doc["_meta"]["sources"]}
    assert src["distributor"]["status"] == "not_connected" and src["distributor"]["items"] == 0
    assert src["seoul_necessities"]["status"] in ("cached", "missing")
    assert doc["items"] == prev["items"]                                              # 키가 없으면 지난 값을 그대로
    for iid, it in doc["items"].items():
        assert it["price"] > 0 and it["unit"] and it["source"] in FI.SOURCES, iid
        assert (it["stage"] == "가정") == (it["source"] == "assumed"), iid
        assert it["stage"] == "가정" or it["date"], iid
    # 템플릿의 모든 재료가 스냅샷에 있다
    for ind in ("bbq", "cafe"):
        for x in M.template(ind)["items"]:
            for ing, _ in x["recipe"] + [r for rs in (x.get("alt_recipe") or {}).values() for r in rs]:
                assert ing in doc["items"], (ind, x["id"], ing)
