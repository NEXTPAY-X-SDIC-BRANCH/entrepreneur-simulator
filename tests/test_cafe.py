"""Cafe 창업 시뮬레이터: layout solver, capacity model, grades, API round trip (no DB, no LLM)."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import cafe as cafe_api
from sim.cafe import preview
from sim.cafe import layout as lay
from sim.cafe.params import GRADES

DISTRICTS = ("3120012", "3120094", "3110131")
SAMPLE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
              showcase=1, oven=1, kiosks=1, pos=1)


def cfg(**kw):
    return {**SAMPLE, **kw}


def test_deterministic():
    a, b = preview(cfg()), preview(cfg())
    assert json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)


@pytest.mark.parametrize("kiosks,bar", [(0, 0), (1, 8), (3, 12)])
def test_more_pyeong_never_fewer_slots(kiosks, bar):
    slots = [preview(cfg(size_pyeong=p, kiosks=kiosks, bar_seats=bar))["space"]["table_slots"] for p in range(10, 41)]
    assert all(b >= a for a, b in zip(slots, slots[1:])), slots
    assert slots[-1] > slots[0]


@pytest.mark.parametrize("p", [12, 20, 30])
def test_overflow_exactly_when_tables_exceed_slots(p):
    slots = preview(cfg(size_pyeong=p, bar_seats=4))["space"]["table_slots"]
    for t in range(0, slots + 3):
        r = preview(cfg(size_pyeong=p, bar_seats=4, tables=t, chairs=2 * t))
        over = {o["type"]: o["count"] for o in r["space"]["overflow"]}
        assert ("table" in over) == (t > slots)
        assert r["space"]["table_slots"] == slots
        ghost_tables = [i for i in r["layout"] if i["type"] == "table" and not i["fits"]]
        assert len(ghost_tables) == max(0, t - slots)
        assert all(i["x"] > r["room"]["width_m"] for i in ghost_tables)
        if t > slots:
            labels = [f["label_ko"] for f in r["space"]["fix"]]
            assert f"테이블 {slots}개로 줄이기" in labels
            patch = next(f["patch"] for f in r["space"]["fix"] if "tables" in f["patch"])
            fixed = preview({**cfg(size_pyeong=p, bar_seats=4, tables=t, chairs=2 * t), **patch})
            assert not fixed["space"]["overflow"]


def test_size_fix_is_smallest_pyeong_that_fits():
    r = preview(cfg(size_pyeong=14, tables=8, chairs=24))
    fix = next(f for f in r["space"]["fix"] if "size_pyeong" in f["patch"])
    p = fix["patch"]["size_pyeong"]
    assert not preview(cfg(size_pyeong=p, tables=8, chairs=24))["space"]["overflow"]
    assert preview(cfg(size_pyeong=p - 1, tables=8, chairs=24))["space"]["overflow"]


def test_chairs_beyond_four_per_table_are_unassigned():
    r = preview(cfg(size_pyeong=30, tables=3, chairs=15))
    assert r["seats"]["unassigned_chairs"] == 3 and r["seats"]["table"] == 12
    chairs = [i for i in r["layout"] if i["type"] == "chair"]
    per_table = {}
    for c in chairs:
        if c["parent"]:
            per_table[c["parent"]] = per_table.get(c["parent"], 0) + 1
    assert max(per_table.values()) == 4
    loose = [c for c in chairs if c["parent"] is None]
    assert len(loose) == 3 and all(not c["fits"] and c.get("unassigned") for c in loose)
    assert not r["space"]["overflow"]   # spare chairs are not a space problem
    assert any(f["patch"] == {"chairs": 12} for f in r["space"]["fix"])


def test_round_robin_assignment():
    r = preview(cfg(size_pyeong=30, tables=4, chairs=10))
    counts = {}
    for c in r["layout"]:
        if c["type"] == "chair":
            counts[c["parent"]] = counts.get(c["parent"], 0) + 1
    assert sorted(counts.values()) == [2, 2, 3, 3]


def test_bottleneck_moves_from_espresso_to_seating():
    low = preview(cfg(size_pyeong=25, tables=5, chairs=16, bar_seats=4, espresso_groups=1))
    high = preview(cfg(size_pyeong=25, tables=5, chairs=16, bar_seats=4, espresso_groups=2))
    assert low["bottleneck"][0]["key"] == "espresso"
    assert high["bottleneck"][0]["key"] == "seating"
    assert low["suggestion"]["patch"] == {"espresso_groups": 2}
    assert high["throughput"]["espresso_cph"] > low["throughput"]["espresso_cph"]


def _rect(i):
    return (i["x"] - i["w"] / 2, i["z"] - i["d"] / 2, i["x"] + i["w"] / 2, i["z"] + i["d"] / 2)


def _hit(a, b, eps=1e-6):
    return a[0] < b[2] - eps and b[0] < a[2] - eps and a[1] < b[3] - eps and b[1] < a[3] - eps


@pytest.mark.parametrize("p", [10, 15, 20, 27, 40])
def test_placed_items_inside_room_and_clear_of_each_other(p):
    for d in DISTRICTS:
        for extra in (dict(tables=40, chairs=160, bar_seats=20, kiosks=3, pos=3, espresso_groups=4),
                      dict(tables=7, chairs=22, bar_seats=8)):
            r = preview(cfg(district=d, size_pyeong=p, **extra))
            W, D, cz = r["room"]["width_m"], r["room"]["depth_m"], r["room"]["counter_zone"]
            placed = [i for i in r["layout"] if i["fits"]]
            for i in placed:
                x0, z0, x1, z1 = _rect(i)
                assert -1e-6 <= x0 and x1 <= W + 1e-6 and -1e-6 <= z0 and z1 <= D + 1e-6, i
            seating = [i for i in placed if i["type"] in ("table", "chair")]
            counter = (cz["x"], cz["z"], cz["x"] + cz["w"], cz["z"] + cz["d"])
            entry = (W - 1.5, 0.0, W, D)
            for i in seating:
                assert not _hit(_rect(i), counter) and not _hit(_rect(i), entry), i
            for a in range(len(seating)):
                for b in range(a + 1, len(seating)):
                    assert not _hit(_rect(seating[a]), _rect(seating[b])), (seating[a], seating[b])


SLOT_CONFIGS = {
    "no bar, POS only": dict(bar_seats=0, showcase=0, oven=0, kiosks=0, pos=1),
    "8 bar, POS only": dict(bar_seats=8, showcase=0, oven=0, kiosks=0, pos=1),
    "sample (8 bar, kiosk, showcase, oven)": dict(bar_seats=8),
    "no bar, no kiosk, showcase, oven": dict(bar_seats=0, kiosks=0),
}


def _slots(extra):
    return [preview(cfg(size_pyeong=p, tables=1, chairs=0, **extra))["space"]["table_slots"] for p in range(10, 41)]


@pytest.mark.parametrize("name", list(SLOT_CONFIGS))
def test_bigger_store_gets_more_tables(name):
    s = _slots(SLOT_CONFIGS[name])
    assert all(b >= a for a, b in zip(s, s[1:])), s                          # never fewer
    assert all(s[i + 3] > s[i] for i in range(len(s) - 3)), s                # always more within 3평
    stalls = [10 + i for i in range(len(s) - 2) if s[i + 2] <= s[i]]
    assert len(stalls) <= 2, (stalls, s)                                     # within 2평 almost everywhere


PACKING_FLOOR = {"no bar, POS only": 769, "8 bar, POS only": 551, "sample (8 bar, kiosk, showcase, oven)": 513,
                 "no bar, no kiosk, showcase, oven": 732}   # Σ table_slots over 10~40평 at commit time


@pytest.mark.parametrize("name", list(SLOT_CONFIGS))
def test_packing_never_regresses(name):
    assert sum(_slots(SLOT_CONFIGS[name])) >= PACKING_FLOOR[name]


def test_small_cafe_with_window_bar_fits_four_tables():
    assert preview(cfg(size_pyeong=15, tables=1, chairs=0, bar_seats=8, showcase=0, oven=0, kiosks=0))["space"][
        "table_slots"] >= 4
    assert preview(cfg(size_pyeong=15, tables=1, chairs=0))["space"]["table_slots"] >= 4


def test_back_counter_items_face_the_aisle():
    r = preview(cfg())
    D = r["room"]["depth_m"]
    back = [i for i in r["layout"] if i["type"] in ("sink", "ice_maker", "fridge", "oven")]
    assert back and all(i["rot_deg"] == 180 and abs(i["z"] + i["d"] / 2 - D) < 1e-6 for i in back)


def test_sample_seats_every_chair():
    r = preview(cfg())
    assert r["seats"]["unassigned_chairs"] == 0 and r["seats"]["table"] == 22
    caps = [i["seats_max"] for i in r["layout"] if i["type"] == "table" and i["fits"]]
    assert set(caps) <= {2, 4} and sum(caps) >= 22


def _numbers_have_grades(r):
    for key in ("room", "demand", "space", "seats", "throughput", "suggestion", "capex", "monthly_fixed", "staff",
                "rough_month", "district"):
        assert r[key]["grade"] in GRADES, key
    for b in r["bottleneck"]:
        assert b["grade"] in GRADES
    for line in r["capex"]["lines"]:
        assert line["grade"] in GRADES and line["source"]


@pytest.mark.parametrize("d", DISTRICTS)
def test_all_districts_and_grades(d):
    r = preview(cfg(district=d))
    _numbers_have_grades(r)
    assert r["district"]["code"] == d and r["district"]["sales_per_store_month_krw"] > 0
    assert r["throughput"]["demand_peak_cups_per_h"] > 0
    assert r["monthly_fixed"]["rent_krw"] == round(r["district"]["rent_per_pyeong_krw"] * 20)
    assert r["capex"]["total_krw"] == sum(x["subtotal_krw"] for x in r["capex"]["lines"])
    assert r["rough_month"]["grade"] == "L" and "빠른 추정" in r["rough_month"]["note_ko"]
    items = {x["item_ko"] for x in r["capex"]["lines"]}
    assert {"보증금", "권리금"} <= items


def test_quarter_sales_divided_by_three():
    r = preview(cfg(district="3120012"))
    assert 18_500_000 < r["district"]["sales_per_store_month_krw"] < 19_500_000   # ₩69.9억 / 122 / 3


def test_api_round_trip():
    app = FastAPI()
    app.include_router(cafe_api.router)
    c = TestClient(app)
    ds = c.get("/cafe/districts").json()
    assert {d["code"] for d in ds} >= set(DISTRICTS) and all(d["context_ko"] for d in ds)   # 서울 행정동(build_dongs.py)이 더해져 있어 3곳은 일부
    r = c.post("/cafe/preview", json=SAMPLE)
    assert r.status_code == 200
    assert r.json() == json.loads(json.dumps(preview(SAMPLE)))
    assert c.post("/cafe/preview", json={**SAMPLE, "size_pyeong": 41}).status_code == 422
    assert c.post("/cafe/preview", json={**SAMPLE, "district": "9999999"}).status_code == 422


def test_mounted_on_main_app():
    from api import changeup
    c = TestClient(changeup.app)
    assert c.post("/cafe/preview", json=SAMPLE).json()["space"]["table_slots"] == lay.solve(
        {**SAMPLE})["table_slots"]


def test_daily_customers_default_and_user_grade():
    r = preview(cfg())
    d = r["demand"]
    assert d["source"] == "data" and d["daily_customers"] == d["default_daily_customers"] and d["peak_day"] == "weekend"
    assert d["grade"] == "M" and "업계 평균" in d["range_hint_ko"]   # anchor M x 상권 index H (2026-10-14)
    u = preview(cfg(daily_customers=250))["demand"]
    assert u["source"] == "user" and u["grade"] == "가정" and u["default_daily_customers"] == d["default_daily_customers"]
    wk = preview(cfg(peak_day="weekday"))["demand"]
    assert wk["default_daily_customers"] < d["default_daily_customers"]   # 대학로 weekend > weekday
    # data default reproduces the anchor month: industry average ÷ 12 x (상권 per-store ÷ Seoul per-store), within the
    # integer rounding of the default
    anchor = 190_330_000 / 12 * 19_096_864 / 11_638_466
    assert abs(r["rough_month"]["revenue_krw"] - anchor) / anchor < 0.02


def test_higher_daily_customers_raises_demand_monotonically():
    prev = None
    for n in range(20, 601, 20):
        r = preview(cfg(daily_customers=n))
        cur = (r["throughput"]["demand_peak_cups_per_h"], r["seats"]["demand_peak_seats"], r["demand"]["peak_orders_per_h"])
        if prev:
            assert all(c > p for c, p in zip(cur, prev)), (n, cur, prev)
        prev = cur


@pytest.mark.parametrize("over", [dict(), dict(chairs=28, tables=6, espresso_groups=1),
                                  dict(tables=6, chairs=24, bar_seats=13, kiosks=0, pos=1, espresso_groups=4)])
def test_high_demand_binds_and_suggestion_relieves(over):
    base = cfg(**over)
    low, high = preview(base), preview({**base, "daily_customers": 250})
    assert low["bottleneck"][0]["ratio"] > 1.1                    # data default: headroom (1.5 before the 10-14 demand anchor,
                                                                  # 1.2 before the peak share was renormalized over open hours)
    assert high["bottleneck"][0]["ratio"] < low["bottleneck"][0]["ratio"]
    assert high["bottleneck"][0]["ratio"] < 1.2                   # at 250/day something is (nearly) binding
    key, patch = high["bottleneck"][0]["key"], high["suggestion"]["patch"]
    if patch:
        after = preview({**base, "daily_customers": 250, **patch})
        ratio = {b["key"]: b["ratio"] for b in after["bottleneck"]}
        assert ratio[key] > high["bottleneck"][0]["ratio"]
        assert after["bottleneck"][0]["ratio"] >= high["bottleneck"][0]["ratio"]


def test_demand_flips_binding_not_order():
    """Every capacity is demand-independent, so all ratios scale by the same 1/demand: the ORDER of the bottleneck
    list is fixed by the store setup, and demand decides whether the top one binds (note flips to 돌아감)."""
    low, high = preview(cfg()), preview(cfg(daily_customers=300))
    assert [b["key"] for b in low["bottleneck"]] == [b["key"] for b in high["bottleneck"]]
    assert "여유 있음" in low["bottleneck"][0]["note_ko"] and "돌아감" in high["bottleneck"][0]["note_ko"]
    assert high["rough_month"]["revenue_krw"] > low["rough_month"]["revenue_krw"]


@pytest.mark.parametrize("d", DISTRICTS)
@pytest.mark.parametrize("peak_day", ["weekday", "weekend"])
def test_peak_demand_is_the_schedules_busiest_hour(d, peak_day):
    """Orders outside 10~22 are redistributed into the opening hours (opex close_hour note, season._coverage = 1 at
    the standard hours), so the bottleneck's peak hour must carry the same share as the busiest row of the schedule."""
    from sim.cafe import model as m
    r = preview(cfg(district=d, peak_day=peak_day, daily_customers=200))
    share = max(m._hour_shares(d).values())
    want = 200 * share * m.v("demand", "peak_surge") * m.v("demand", "cups_per_tx")
    assert r["throughput"]["demand_peak_cups_per_h"] == pytest.approx(want, abs=0.06)
    busiest = max(x["orders"] for x in r["staff"]["schedule"])
    assert r["demand"]["peak_orders_per_h"] == pytest.approx(busiest * m.v("demand", "peak_surge"), abs=0.15)


def test_api_demand_fields():
    app = FastAPI()
    app.include_router(cafe_api.router)
    c = TestClient(app)
    r = c.post("/cafe/preview", json={**SAMPLE, "daily_customers": 250, "peak_day": "weekday"}).json()
    assert r["demand"]["daily_customers"] == 250 and r["demand"]["peak_day"] == "weekday"
    assert c.post("/cafe/preview", json={**SAMPLE, "daily_customers": 9}).status_code == 422
    assert c.post("/cafe/preview", json={**SAMPLE, "district": "3110131", "daily_customers": 19}).status_code == 200
    assert c.post("/cafe/preview", json={**SAMPLE, "daily_customers": 601}).status_code == 422
    assert c.post("/cafe/preview", json={**SAMPLE, "peak_day": "friday"}).status_code == 422


def test_peak_day_defaults_to_busier_day():
    assert preview(cfg(district="3120012"))["demand"]["peak_day"] == "weekend"    # weekend factor 1.24
    assert preview(cfg(district="3110131"))["demand"]["peak_day"] == "weekday"    # weekday 1.10 vs weekend 0.75
    assert preview(cfg(district="3110131", peak_day="weekend"))["demand"]["peak_day"] == "weekend"


def test_labor_rises_with_daily_customers():
    labor = [preview(cfg(daily_customers=n))["monthly_fixed"]["labor_krw"] for n in range(20, 601, 20)]
    assert all(b >= a for a, b in zip(labor, labor[1:])), labor
    assert labor[-1] > labor[0]
    assert preview(cfg(daily_customers=250))["monthly_fixed"]["labor_krw"] > preview(cfg())["monthly_fixed"]["labor_krw"]


def test_schedule_and_owner_line():
    r = preview(cfg(daily_customers=250))
    st, mf = r["staff"], r["monthly_fixed"]
    assert [x["hour"] for x in st["schedule"]] == list(range(10, 22)) and st["schedule_day"] == "weekend"
    assert all(1 <= x["staff"] <= st["stations"] for x in st["schedule"])
    assert st["peak"] == max(x["staff"] for x in st["schedule"]) and st["base"] == 1
    assert abs(sum(x["orders"] for x in st["schedule"]) - 250) < 1          # the day's orders land in opening hours
    owner = next(x for x in mf["lines"] if x["item_ko"] == "사장님 인건비 (참고)")
    assert owner["in_total"] is False and owner["krw"] > 0
    assert mf["total_krw"] == sum(x["krw"] for x in mf["lines"] if x["in_total"])
    assert "무급" in next(x for x in mf["lines"] if x["item_ko"] == "인건비")["note_ko"]
    # OP excludes the owner's reference pay
    rm = r["rough_month"]
    costs = {x["item_ko"]: x["krw"] for x in rm["lines"]}
    assert costs["월 고정비"] == mf["total_krw"]
    assert abs(rm["op_krw"] - (rm["revenue_krw"] - sum(costs.values()))) <= 2


def test_depreciation_lowers_op_margin():
    rm = preview(cfg(daily_customers=250))["rough_month"]
    assert rm["depreciation_krw"] > 0
    assert rm["op_krw"] == rm["op_before_depreciation_krw"] - rm["depreciation_krw"]
    assert rm["op_krw"] / rm["revenue_krw"] < rm["op_before_depreciation_krw"] / rm["revenue_krw"]
    # more capex (bigger room = more interior) -> more depreciation, same everything else
    assert preview(cfg(size_pyeong=30, daily_customers=250))["rough_month"]["depreciation_krw"] > rm["depreciation_krw"]


def test_card_fee_band_switch():
    from sim.cafe.model import card_fee_rate
    assert card_fee_rate(299_999_999) == 0.004 and card_fee_rate(300_000_001) == 0.01
    assert card_fee_rate(800_000_000) == 0.0115 and card_fee_rate(2_000_000_000) == 0.0145
    rates = {}
    for n in range(10, 601, 10):
        rm = preview(cfg(daily_customers=n))["rough_month"]
        rates[n] = (rm["revenue_krw"] * 12, rm["card_fee_rate"])
        fee = next(x["krw"] for x in rm["lines"] if x["item_ko"] == "카드수수료")
        assert abs(fee - rm["revenue_krw"] * rm["card_fee_rate"]) <= 1
    assert all(r == card_fee_rate(a) for a, r in rates.values())
    assert {0.004, 0.01, 0.0115} <= {r for _, r in rates.values()}       # the sweep crosses the bands


def test_cost_lines_and_benchmark_graded():
    r = preview(cfg(daily_customers=250))
    rm = r["rough_month"]
    names = {x["item_ko"] for x in rm["lines"]}
    assert {"식재료비", "카드수수료", "포장재", "수선 소모품 마케팅", "월 고정비", "감가상각"} <= names
    assert all(x["grade"] in GRADES and x["krw"] > 0 for x in rm["lines"])
    b = rm["benchmark"]
    assert b["industry_op_margin"] == 0.098 and b["grade"] == "M" and "농경연" in b["source"]
    assert b["model_op_margin"] == rm["op_margin"] and b["model_op_margin_with_owner_pay"] < b["model_op_margin"]
    assert "참고용" in b["gap_note_ko"]
    elec = next(x for x in r["monthly_fixed"]["lines"] if x["item_ko"] == "전기")
    more = next(x for x in preview(cfg(daily_customers=250, espresso_groups=4, oven=1, showcase=1))["monthly_fixed"]["lines"]
                if x["item_ko"] == "전기")
    assert more["krw"] > elec["krw"]
    assert "가정" in r["throughput"]["note_ko"]
