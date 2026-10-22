"""Deterministic floor-plan solver for the cafe preview.

Frame: metres, origin = room corner, +x along the front (window/door) wall, +z into the room; the front wall is z=0,
the back wall z=depth. Item x/z = footprint centre. rot_deg = yaw about +y, clockwise seen from above, 0 = the item's
front faces +z (so 90 faces +x, 180 faces the front wall). This matches Unity's Euler y.

Zones, all anchored to a wall so a bigger room never loses a slot (table_slots is monotone in 평):
  front band   bar counter + stools along the window from the left wall, kiosks just left of the entry path
  entry path   x >= width - entry_w, kept clear from the door to the counter
  counter      back-right corner: front line (POS, espresso + grinder, showcase, pickup) faces the customers,
               back line (sink, ice maker, fridge, oven) against the back wall facing the barista aisle (both lines
               rot 180); queue band in front of it
  seating      rows of 2-tops / 4-tops (and wall 2-tops) packed into the free region by sim/cafe/seating.py; every
               zone is anchored to a wall, so a bigger room never loses a slot
Whatever does not fit gets fits:false and is laid out in a ghost zone to the right of the room (x > width).
"""
from __future__ import annotations

import math

from . import seating
from .params import v

PYEONG_M2 = 3.3058


def L(key):
    return v("layout", key)


# 가게 모양 (사용자 선택): 가로 ÷ 세로. 고르지 않으면 params layout.aspect (1.6)
SHAPE_ASPECT = {"wide": None, "square": 1.0, "deep": 0.7}


def room_dims(size_pyeong: float, shape: str | None = None) -> tuple[float, float, float]:
    area = size_pyeong * PYEONG_M2
    width = math.sqrt(area * (SHAPE_ASPECT.get(shape or "wide") or L("aspect")))
    return area, width, area / width


def machines_for(groups: int) -> list[int]:
    """Group count -> machines; 4 groups = two 2-group machines."""
    return {1: [1], 2: [2], 3: [3], 4: [2, 2]}[groups]


def _r(x: float) -> float:
    return round(x, 3)


def _counter_lines(cfg: dict) -> tuple[list, list]:
    w = L("item_w")
    front = [("pos", w["pos"])] * cfg["pos"]
    for m in machines_for(cfg["espresso_groups"]):
        front += [("espresso", w[f"espresso_{m}"]), ("grinder", w["grinder"])]
    if cfg["showcase"]:
        front.append(("showcase", w["showcase"]))
    back = [("sink", w["sink"]), ("ice_maker", w["ice_maker"]), ("fridge", w["fridge"])]
    if cfg["oven"]:
        back.append(("oven", w["oven"]))
    return front, back


def seat_band_start(cfg: dict) -> float:
    if cfg["bar_seats"] > 0 or cfg["kiosks"] > 0:
        return L("bar_band_d") + L("aisle")
    return L("wall_margin")


def solve(cfg: dict) -> dict:
    """cfg keys: size_pyeong, tables, chairs, bar_seats, espresso_groups, showcase, oven, kiosks, pos,
    shape ("wide" | "square" | "deep", 없으면 wide), door ("right" | "left", 없으면 right).
    문이 왼쪽이면 오른쪽 문 배치를 그대로 풀고 좌우로 뒤집는다 (자리 수·처리량은 같고 위치만 거울처럼 바뀜)."""
    area, W, D = room_dims(cfg["size_pyeong"], cfg.get("shape"))
    wm, cd, line_d = L("wall_margin"), L("counter_d"), L("counter_line_d")
    items: list[dict] = []
    ghosts: list[dict] = []   # non-fitting items in placement order, laid out in the ghost zone at the end

    def add(id_, type_, x, z, rot, fits=True, w=None, d=None, parent=None, **extra):
        it = {"id": id_, "type": type_, "x": _r(x), "z": _r(z), "rot_deg": rot, "fits": fits, "parent": parent,
              "w": _r(w) if w is not None else None, "d": _r(d) if d is not None else None, **extra}
        items.append(it)
        if not fits:
            ghosts.append(it)
        return it

    # ---- counter zone (back-right). Lines fill right to left; anything past the left limit overflows. The pickup
    # slot is bare counter at the left end of the front line, so it only widens the zone.
    front, back = _counter_lines(cfg)
    pickup = L("item_w")["pickup"]
    need = max(sum(x for _, x in front) + pickup, sum(x for _, x in back)) + L("counter_side_access")
    cw = min(need, W - 2 * wm)
    cx0, cz0 = W - cw, D - cd
    counter_zone = {"x": _r(cx0), "z": _r(cz0), "w": _r(cw), "d": _r(cd)}
    left_limit = cx0 + L("counter_side_access")
    for line, z, rot in ((front, cz0 + line_d / 2, 180), (back, D - line_d / 2, 180)):   # both face -z
        cursor = W - wm
        n = {}
        for type_, iw in line:
            n[type_] = n.get(type_, 0) + 1
            fits = cursor - iw >= left_limit - 1e-9
            add(f"{type_}_{n[type_]}", type_, cursor - iw / 2, z, rot, fits, iw, line_d)
            if fits:
                cursor -= iw

    # ---- door + kiosks + bar along the front wall
    entry_w = L("entry_w")
    door = {"x": _r(W - entry_w / 2), "z": 0.0, "w": L("door_w")}
    kx = W - entry_w
    kw = L("kiosk_w")
    for i in range(cfg["kiosks"]):
        fits = kx - kw >= wm - 1e-9
        add(f"kiosk_{i + 1}", "kiosk", kx - kw / 2, 0.3, 0, fits, kw, 0.5)
        if fits:
            kx -= kw
    bar_len_max = max(0.0, kx - 0.1 - wm)
    pitch = L("bar_pitch")
    bar_cap = int(bar_len_max / pitch + 1e-9)
    bar_fit = min(cfg["bar_seats"], bar_cap)
    bcd = L("bar_counter_d")
    if cfg["bar_seats"] > 0 and bar_fit > 0:
        add("bar_counter_1", "bar_counter", wm + bar_fit * pitch / 2, bcd / 2, 0, True, bar_fit * pitch, bcd)
    for i in range(cfg["bar_seats"]):
        fits = i < bar_fit
        add(f"bar_seat_{i + 1}", "bar_seat", wm + pitch * (i + 0.5), bcd + 0.3, 180, fits, 0.4, 0.4,
            "bar_counter_1" if fits else None)

    # ---- seating: rows of 2-tops / 4-tops in the free region (sim/cafe/seating.py)
    z_start = seat_band_start(cfg)
    cands = seating.candidates(W, D, z_start, W - entry_w, cx0 - L("counter_side_access"), cz0 - L("queue_d"), wm)
    nt, nc = cfg["tables"], cfg["chairs"]
    rows, table_slots = seating.choose(cands, nt, nc)
    placed = seating.arrange(rows, nt, nc)

    # ---- tables and chairs: chairs go round-robin over tables (table 1, 2, ... then again), each table up to its
    # capacity (2-top 2, 4-top 4; a ghost table counts as a 4-top). Chairs past every table's capacity are spare.
    off = L("table_w") / 2 + 0.25
    tables, caps, offs = [], [], []
    for t in range(nt):
        fits = t < len(placed)
        sp = placed[t] if fits else {"x": 0.0, "z": 0.0, "cap": L("max_chairs_per_table"), "orient": "x"}
        tables.append(add(f"table_{t + 1}", "table", sp["x"], sp["z"], 0, fits, L("table_w"), L("table_w"),
                          seats_max=sp["cap"]))
        caps.append(sp["cap"])
        offs.append(seating.seat_offsets(sp["orient"], off, sp.get("wall", False)))
    assigned = [0] * nt
    unassigned = 0
    for k in range(nc):
        t = None
        for s_ in range(L("max_chairs_per_table")):
            t = next((i for i in range(nt) if assigned[i] == s_ and caps[i] > s_), None)
            if t is not None:
                break
        if t is None:
            unassigned += 1
            add(f"chair_{k + 1}", "chair", 0.0, 0.0, 0, False, 0.45, 0.45, None, unassigned=True)
            continue
        tb = tables[t]
        dx, dz, rot = offs[t][assigned[t]]
        assigned[t] += 1
        it = add(f"chair_{k + 1}", "chair", tb["x"] + dx, tb["z"] + dz, rot, tb["fits"], 0.45, 0.45, tb["id"])
        it["_seat"] = (dx, dz)
    seat_capacity = sum(caps)

    # ---- ghost zone: one cell per overflowing table (its chairs ride along) or other item, 3 cells deep
    cell = L("ghost_cell")
    idx = 0
    by_table = {}
    for it in ghosts:
        if it["type"] == "chair" and it["parent"]:
            continue   # placed with its table below
        col, row = divmod(idx, 3)
        x, z = W + 1.0 + cell * (col + 0.5), cell * (row + 0.5)
        it["x"], it["z"] = _r(x), _r(z)
        by_table[it["id"]] = (x, z)
        idx += 1
    for it in ghosts:
        if it["type"] == "chair" and it["parent"] in by_table:
            tx, tz = by_table[it["parent"]]
            dx, dz = it["_seat"]
            it["x"], it["z"] = _r(tx + dx), _r(tz + dz)
    for it in items:
        it.pop("_seat", None)

    overflow: dict[str, int] = {}
    for it in ghosts:
        if not it.get("unassigned"):
            overflow[it["type"]] = overflow.get(it["type"], 0) + 1

    n_tables_fit = min(nt, table_slots)
    # used = floor each placed thing claims incl. its clearance: counter block (+ queue, side access), the entry
    # strip in front of it, the window band (+ aisle) under bar seats and kiosks, one grid cell per table
    n_kiosk_fit = sum(1 for it in items if it["type"] == "kiosk" and it["fits"])
    band = L("bar_band_d") + L("aisle")
    counter_block = (cw + L("counter_side_access")) * (cd + L("queue_d"))
    entry_strip = entry_w * max(0.0, D - cd - L("queue_d"))
    used = min(area, counter_block + entry_strip + (bar_fit * pitch + n_kiosk_fit * kw) * band
               + sum(((seating.W4 + L("table_gap")) * (seating.W4 + L("row_gap")) if p["cap"] == 4 and not p["wall"]
                     else (seating.W2 + L("table_gap")) * (seating.W4 + L("row_gap")) if not p["wall"]
                     else (seating.W4 + L("wall_table_gap")) * (seating.W2 + L("row_gap"))) for p in placed))
    if cfg.get("door") == "left":
        for it in items:
            if it["fits"]:
                it["x"] = _r(W - it["x"])
                it["rot_deg"] = (360 - it["rot_deg"]) % 360
        door = {**door, "x": _r(W - door["x"])}
        counter_zone = {**counter_zone, "x": _r(W - counter_zone["x"] - counter_zone["w"])}
    return {
        "room": {"area_m2": _r(area), "width_m": _r(W), "depth_m": _r(D), "door": door,
                 "counter_zone": counter_zone},
        "layout": items,
        "table_slots": table_slots,
        "bar_capacity": bar_cap,
        "overflow": [{"type": t, "count": c} for t, c in overflow.items()],
        "used_m2": used,
        "seats_table": sum(1 for it in items if it["type"] == "chair" and it["fits"]),
        "seats_bar": bar_fit,
        "unassigned_chairs": unassigned,
        "seat_capacity": seat_capacity,
    }
