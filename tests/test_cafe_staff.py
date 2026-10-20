"""Cafe staff as a setup input: crew capacity, recommended crew, staff bottleneck, roster positions, labor."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import cafe as cafe_api
from sim.cafe import model as m
from sim.cafe import preview
from sim.cafe import season as S
from sim.cafe.params import GRADES, load_params, v

SAMPLE = dict(district="3120012", size_pyeong=20, tables=7, chairs=22, bar_seats=8, espresso_groups=2,
              showcase=1, oven=1, kiosks=1, pos=1)
CONFIGS = {
    "sample": SAMPLE,
    "no kiosk, 1 group": {**SAMPLE, "kiosks": 0, "espresso_groups": 1},
    "two machines, 2 POS, big room": {**SAMPLE, "size_pyeong": 35, "tables": 14, "chairs": 48, "espresso_groups": 4,
                                      "pos": 2, "kiosks": 0},
    "takeout only": {**SAMPLE, "tables": 0, "chairs": 0, "bar_seats": 0},
}
TOP = v("capacity", "staff_peak_range")[1]


def cfg(**kw):
    return {**SAMPLE, **kw}


@pytest.mark.parametrize("name", list(CONFIGS))
@pytest.mark.parametrize("demand", [None, 150, 300, 500])
def test_more_staff_never_lowers_capacity(name, demand):
    prev = None
    for n in range(1, TOP + 1):
        t = preview({**CONFIGS[name], "daily_customers": demand, "staff_peak": n})["throughput"]
        cur = (t["espresso_cph"], t["ordering_cph"], t["seating_cph"], t["staff_cph"])
        if prev:
            assert all(b >= a - 1e-9 for a, b in zip(prev, cur)), (n, prev, cur)
        assert t["espresso_cph"] <= t["espresso_equipment_cph"] + 1e-9
        assert t["ordering_cph"] <= t["ordering_equipment_cph"] + 1e-9
        assert t["seating_cph"] <= t["seating_equipment_cph"] + 1e-9
        prev = cur


def test_roles_are_a_growing_prefix_in_priority_order():
    c = m.normalize(cfg(kiosks=0))
    seats = 30
    lists = [m.role_order(c, n, 60.0, seats) for n in range(1, TOP + 1)]
    assert all(b[:len(a)] == a for a, b in zip(lists, lists[1:]))
    assert lists[2] == ["barista", "cashier", "floor"]                 # machine, then POS (no kiosk), then floor
    four = m.normalize(cfg(espresso_groups=4))                          # two 2-group machines -> two baristas first
    assert m.role_order(four, 2, 60.0, seats) == ["barista", "barista"]
    kiosk_covers = m.normalize(cfg(kiosks=3))     # kiosks take every order: the POS person comes after baristas + floor
    assert m.role_order(kiosk_covers, 3, 30.0, seats) == ["barista", "floor", "barista"]
    assert m.role_order(kiosk_covers, 5, 30.0, seats) == ["barista", "floor", "barista", "cashier", "floor"]
    no_pos = m.normalize(cfg(kiosks=3, pos=0))
    assert "cashier" not in m.role_order(no_pos, 8, 30.0, seats)


def test_cashier_stands_at_the_pos_with_staff_peak_5():
    for extra in ({}, {"kiosks": 0}, {"kiosks": 3}):
        r = preview(cfg(staff_peak=5, **extra))
        cashiers = [p for p in r["staff"]["roster"] if p["role"] == "cashier"]
        assert cashiers and r["staff"]["roles"]["cashier"] >= 1, extra
        pos = {i["id"]: i for i in r["layout"] if i["type"] == "pos"}
        cz = r["room"]["counter_zone"]
        for p in cashiers:
            assert p["station_id"] in pos and p["x"] == pos[p["station_id"]]["x"] and p["rot_deg"] == 180
            assert pos[p["station_id"]]["z"] < p["z"] < cz["z"] + cz["d"]   # barista side of the POS, facing customers
            assert p["label_ko"].startswith("계산")


def test_default_is_recommended_and_never_binding():
    for dc in (None, 120, 250, 450):
        st = preview(cfg(daily_customers=dc))
        s = st["staff"]
        assert s["source"] == "recommended" and s["user_peak"] is None
        assert s["staff_peak"] == s["recommended_peak"] and 1 <= s["recommended_peak"] <= TOP
        assert st["bottleneck"][0]["key"] != "staff"
        assert sum(s["roles"].values()) == s["staff_peak"] == len(s["roster"])
    r = preview(cfg(daily_customers=250, staff_peak=3))
    assert r["staff"]["source"] == "user" and r["staff"]["user_peak"] == 3


def test_under_staffed_makes_staff_the_bottleneck_and_the_suggestion_relieves_it():
    rec = preview(cfg(daily_customers=300))
    assert rec["staff"]["recommended_peak"] >= 2
    under = preview(cfg(daily_customers=300, staff_peak=1))
    top = under["bottleneck"][0]
    assert top["key"] == "staff" and top["label_ko"] == "인력" and top["ratio"] < 1
    assert "사장님 포함" in top["note_ko"]
    patch = under["suggestion"]["patch"]
    assert set(patch) == {"staff_peak"} and patch["staff_peak"] > 1
    after = preview(cfg(daily_customers=300, **patch))
    ratio = {b["key"]: b["ratio"] for b in after["bottleneck"]}
    assert ratio["staff"] > top["ratio"] and after["bottleneck"][0]["key"] != "staff"
    assert after["rough_month"]["revenue_krw"] > under["rough_month"]["revenue_krw"]   # fewer people = lost sales
    assert under["suggestion"]["grade"] in GRADES and "인력" in under["suggestion"]["effect_ko"]


def test_labor_rises_with_staff_peak_and_hours_short_are_flagged():
    labor = [preview(cfg(daily_customers=300, staff_peak=n))["monthly_fixed"]["labor_krw"] for n in range(1, TOP + 1)]
    assert all(b >= a for a, b in zip(labor, labor[1:])) and labor[-1] > labor[0], labor
    one = preview(cfg(daily_customers=300, staff_peak=1))["staff"]
    assert one["short_hours"] > 0 and all(r["staff"] == 1 for r in one["schedule"])
    assert all(r["short"] == (r["need"] > 1) for r in one["schedule"])
    rec = preview(cfg(daily_customers=300))["staff"]
    assert rec["short_hours"] == 0 and all(r["staff"] <= rec["staff_peak"] for r in rec["schedule"])


def test_roster_positions_follow_the_layout():
    r = preview(cfg(daily_customers=300, espresso_groups=4, pos=2, kiosks=0, staff_peak=8))
    again = preview(cfg(daily_customers=300, espresso_groups=4, pos=2, kiosks=0, staff_peak=8))
    assert json.dumps(r["staff"]["roster"]) == json.dumps(again["staff"]["roster"])
    items = {i["id"]: i for i in r["layout"]}
    cz = r["room"]["counter_zone"]
    roster = r["staff"]["roster"]
    assert len({p["id"] for p in roster}) == len(roster) == 8
    for p in roster:
        assert p["role"] in ("barista", "cashier", "floor") and p["label_ko"] and p["rot_deg"] == 180
        if p["role"] in ("barista", "cashier"):
            st = items[p["station_id"]]
            assert st["type"] == ("espresso" if p["role"] == "barista" else "pos")
            assert cz["z"] < p["z"] < cz["z"] + cz["d"]                  # in the work aisle behind the counter
            assert abs(p["x"] - st["x"]) <= 0.45 + 1e-9
        else:
            assert p["z"] < cz["z"] and 0 < p["x"] < r["room"]["width_m"]    # queue band in front of the counter
    assert {p["station_id"] for p in roster if p["role"] == "barista"} == {"espresso_1", "espresso_2"}
    assert any(p["station_id"] == "showcase_1" for p in roster if p["role"] == "floor")


def test_new_numbers_are_graded():
    for key in ("staff_peak_range", "barista_on_pos_order_factor", "barista_on_pos_drink_share",
                "dirty_table_block_share", "floor_staff_seat_threshold"):
        assert load_params()["capacity"][key]["grade"] in GRADES, key
    assert load_params()["layout"]["staff_floor_gap"]["grade"] in GRADES
    assert load_params()["season"]["staff_cover"]["grade"] in GRADES
    r = preview(cfg(daily_customers=250, staff_peak=2))
    assert r["staff"]["grade"] in GRADES and r["throughput"]["grade"] in GRADES
    assert all(b["grade"] in GRADES for b in r["bottleneck"])
    note = r["throughput"]["note_ko"]
    assert "모두 채워졌다고" not in note and "사장님 포함" in note
    assert "사장님 포함" in r["staff"]["note_ko"]




def test_season_under_staffed_loses_customers():
    def first(**kw):
        run = S.start({**SAMPLE, "own_capital_krw": 300_000_000, "daily_customers": 450, "seed": 3, **kw})
        return S.play_month(run, {})[1]
    rec, under = first(), first(staff_peak=1)
    assert under["kpi"]["walkaways"] > rec["kpi"]["walkaways"]
    assert under["drivers"]["bottleneck"] == "staff" and under["drivers"]["bottleneck_label_ko"] == "인력"
    labor = lambda mo: next(x["krw"] for x in mo["pnl"]["lines"] if x["key"] == "labor")   # noqa: E731
    assert labor(under) < labor(rec)
