"""lab:layout — cafe floor solver with a chosen aspect ratio and door (wall + position).

Checks the geometry stays valid for a door on every wall at several positions and ratios: everything that fits
lies inside the door-frame room, nothing seated stands in the entry path, tables do not overlap, seats >= 0, and
without the new keys the solver output is exactly the old one."""
from __future__ import annotations

import itertools

import pytest

from sim.cafe import layout as lay

BASE = dict(size_pyeong=20, tables=7, chairs=25, bar_seats=4, espresso_groups=2, showcase=1, oven=0, kiosks=1, pos=1)
TOL = 0.05   # chairs sit 2.5 cm past their row band by design (seating.py), same as the old layout


def _check(r):
    room = r["room"]
    W, D = room["width_m"], room["depth_m"]
    fit = [i for i in r["layout"] if i["fits"]]
    for i in fit:
        hw, hd = (i["w"] or 0) / 2, (i["d"] or 0) / 2
        rot = i["rot_deg"] % 180 == 90
        if rot:
            hw, hd = hd, hw
        assert -TOL <= i["x"] - hw and i["x"] + hw <= W + TOL, i
        assert -TOL <= i["z"] - hd and i["z"] + hd <= D + TOL, i
    xd, e, cz = room["door"]["x"], lay.L("entry_w") / 2, room["counter_zone"]
    assert 0 <= xd <= W
    for i in fit:   # the entry path from the door to the counter stays clear of tables and chairs
        if i["type"] in ("table", "chair") and i["z"] < cz["z"]:
            assert abs(i["x"] - xd) >= e + i["w"] / 2 - TOL, (i, xd)
    tables = [i for i in fit if i["type"] == "table"]
    for a, b in itertools.combinations(tables, 2):
        assert abs(a["x"] - b["x"]) >= 0.7 - 1e-6 or abs(a["z"] - b["z"]) >= 0.7 - 1e-6
    assert r["seats_table"] >= 0 and r["seats_bar"] >= 0
    assert r["seats_table"] == sum(1 for i in fit if i["type"] == "chair")


@pytest.mark.parametrize("wall", lay.WALLS)
@pytest.mark.parametrize("pos", [0.0, 0.3, 0.5, 0.8, 1.0])
@pytest.mark.parametrize("aspect", [0.4, 1.0, 1.6, 2.5])
def test_door_on_every_wall_stays_valid(wall, pos, aspect):
    for size, tables, chairs in ((12, 4, 12), (20, 7, 25), (30, 14, 50)):
        r = lay.solve({**BASE, "size_pyeong": size, "tables": tables, "chairs": chairs,
                       "door_wall": wall, "door_pos": pos, "aspect": aspect})
        _check(r)
        assert r["room"]["frame"]["wall"] == wall
        Wr, Dr = r["room"]["frame"]["real_width_m"], r["room"]["frame"]["real_depth_m"]
        assert Wr / Dr == pytest.approx(aspect, rel=1e-3)
        assert Wr * Dr == pytest.approx(size * lay.PYEONG_M2, rel=1e-3)


def test_default_is_unchanged_and_front_right_door():
    r = lay.solve(dict(BASE))
    assert r["room"]["frame"] == {"wall": "front", "mirror": False, "real_width_m": r["room"]["width_m"],
                                  "real_depth_m": r["room"]["depth_m"]}
    assert r["room"]["door"]["x"] == pytest.approx(r["room"]["width_m"] - lay.L("entry_w") / 2, abs=1e-3)
    # the explicit right-end front door is the same plan as no door keys at all
    same = lay.solve({**BASE, "door_wall": "front", "door_pos": 1.0, "aspect": lay.L("aspect")})
    assert same["layout"] == r["layout"] and same["seats_table"] == r["seats_table"]


def test_door_position_mirrors():
    left = lay.solve({**BASE, "door_wall": "front", "door_pos": 0.0})
    right = lay.solve({**BASE, "door_wall": "front", "door_pos": 1.0})
    W = right["room"]["width_m"]
    assert left["room"]["frame"]["mirror"] and not right["room"]["frame"]["mirror"]
    assert left["room"]["door"]["x"] == pytest.approx(W - right["room"]["door"]["x"], abs=1e-3)
    assert left["seats_table"] == right["seats_table"]


def test_back_and_side_doors_change_the_room_frame():
    side = lay.solve({**BASE, "door_wall": "left", "door_pos": 0.5, "aspect": 2.0})
    fr = side["room"]["frame"]
    assert side["room"]["width_m"] == pytest.approx(fr["real_depth_m"], abs=1e-3)   # door frame x runs along the left wall
    assert side["room"]["depth_m"] == pytest.approx(fr["real_width_m"], abs=1e-3)


def test_layout_changes_flow_into_seats_through_the_api():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api import cafe as cafe_api
    from tests.test_cafe import SAMPLE
    app = FastAPI()
    app.include_router(cafe_api.router)
    client = TestClient(app)
    a = client.post("/cafe/preview", json=SAMPLE).json()
    b = client.post("/cafe/preview", json={**SAMPLE, "aspect": 0.4, "door_wall": "front", "door_pos": 0.5}).json()
    assert a["seats"]["total"] >= 0 and b["seats"]["total"] >= 0
    assert b["room"]["frame"]["wall"] == "front" and b["room"]["width_m"] < a["room"]["width_m"]
    bad = client.post("/cafe/preview", json={**SAMPLE, "door_wall": "roof"})
    assert bad.status_code == 422
