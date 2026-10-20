"""Table packing for the cafe layout: rows of tables in the free seating region, best of several candidates.

The free region is the room minus the window band, the entry path and the counter block: a rectangle or an L-shape.
An L is cut into two rectangles (vertical or horizontal cut, a half row-gap trimmed off each side of the cut). Each
rectangle is filled with parallel rows, either along x or along z:

    row band depth 1.6 m (chair 0.45 + table 0.7 + chair 0.45), 0.6 m between bands (chair back to chair back),
    tables in a row 0.5 m apart (table edge to table edge), bands against a wall keep their chairs back-to-wall.

A 2-top occupies 0.7 m of row length (chairs on the two sides facing across the row); a 4-top 1.6 m (two extra chairs
at its row ends). A wall band (0.7 m deep, against a wall) holds 2-tops turned along the wall, 1.6 m each.
Rectangles are filled by a guillotine search (k bands of one orientation, the leftover strip in the other), scored
once for the most tables and once for the most seats.
table_slots = the most tables any candidate holds as 2-tops. For a given (tables, chairs) the candidate that seats
the most requested chairs with every table placed wins, and a DP picks 4-tops vs 2-tops per row.
Rows along z that start at the front wall keep a 0.9 m cross aisle there so their gaps reach a walkway.
Everything is deterministic: candidates and rows are tried in a fixed order and ties keep the first.
"""
from __future__ import annotations

from functools import lru_cache

from .params import v


def P(key):
    return v("layout", key)


W2, W4 = 0.7, 1.6   # row length taken by a 2-top / 4-top (4-top includes its end chairs)


def _rects(W, D, zs, xr, xc, zc, wm):
    """Candidate decompositions of the seating region into rectangles (x0, z0, x1, z1)."""
    half_gap = P("row_gap") / 2
    if xc >= xr:                                   # counter block lies wholly right of the entry path edge
        return [[(wm, zs, xr, D - wm)]]
    if zc <= zs:                                   # counter block spans the whole seating depth
        return [[(wm, zs, xc, D - wm)]]
    v_cut = [(wm, zs, xc - half_gap, D - wm), (xc + half_gap, zs, xr, zc)]
    h_cut = [(wm, zs, xr, zc - half_gap), (wm, zc + half_gap, xc, D - wm)]
    return [v_cut, h_cut, [(wm, zs, xc, D - wm)], [(wm, zs, xr, zc)]]   # the last two drop one arm of the L


def _rk(rect):
    return tuple(round(c, 6) for c in rect)


def _band(kind: str) -> float:
    return W4 if kind == "std" else W2


def _rows(rect, orient, walls, flip=False, lead_wall=False):
    """Row bands in a rectangle. orient 'x' = rows run along x (stacked in z); 'z' = rows run along z.
    Bands stack from the near edge (v0, or v1 when flip). A 'wall' band (0.7 m: table against the wall, its two
    chairs facing each other along the wall) may lead at the start edge and/or close at the end edge, when that
    edge is a wall. Columns along z that start at the front wall keep a 0.9 m cross aisle there."""
    x0, z0, x1, z1 = rect
    if orient == "z" and walls.get("front"):
        z0 += P("aisle")
    u0, u1, v0, v1 = (x0, x1, z0, z1) if orient == "x" else (z0, z1, x0, x1)
    w_near, w_far = (walls["z0"], walls["z1"]) if orient == "x" else (walls["x0"], walls["x1"])
    if flip:
        w_near, w_far = w_far, w_near
    length, span = u1 - u0, v1 - v0
    if length < W2 or span <= 0:
        return []
    kinds = []
    pos = 0.0                                     # distance from the start edge
    if lead_wall and w_near and span >= W2:
        kinds.append((pos, "wall"))
        pos += W2 + P("row_gap")
    while pos + W4 <= span + 1e-9:
        kinds.append((pos, "std"))
        pos += W4 + P("row_gap")
    if w_far and pos + W2 <= span + 1e-9:
        kinds.append((span - W2, "wall"))
    rows = []
    for d, kind in kinds:
        band = _band(kind)
        vc = (v0 + d + band / 2) if not flip else (v1 - d - band / 2)
        rows.append({"orient": orient, "kind": kind, "u0": u0, "length": length, "vc": vc, "d_end": d + band})
    return rows


def _cap2(row) -> int:
    """Tables a row holds as 2-tops: std 0.7 m each with a 0.5 m gap; wall 1.6 m each with a 0.3 m gap."""
    if row["kind"] == "std":
        w, g = W2, P("table_gap")
    else:
        w, g = W4, P("wall_table_gap")
    return max(0, int((row["length"] + g) / (w + g) + 1e-9))


def _n(rows) -> int:
    return sum(_cap2(r) for r in rows)


def _seats_row(row) -> int:
    """Most chairs a row can seat: a std row mixes 4-tops (1.6 m) and 2-tops (0.7 m); a wall row is 2 per table."""
    if row["kind"] == "wall":
        return 2 * _cap2(row)
    g, length = P("table_gap"), row["length"]
    best = 0
    k = 0
    while k * W4 + max(0, k - 1) * g <= length + 1e-9:
        rest = length - (k * (W4 + g)) if k else length
        n2 = max(0, int((rest + g) / (W2 + g) + 1e-9)) if (rest > 0 or not k) else 0
        best = max(best, 4 * k + 2 * n2)
        k += 1
    return best


def _seats(rows) -> int:
    return sum(_seats_row(r) for r in rows)


def _score(rows, mode):
    return (_n(rows), _seats(rows)) if mode == "n" else (_seats(rows), _n(rows))


def _variants(rect, orient, walls):
    for flip in (False, True):
        for lead in (False, True):
            yield flip, _rows(rect, orient, walls, flip, lead)


def _best_simple(rect, walls, mode="n"):
    best, best_s = [], None
    for o in ("x", "z"):
        for _, rows in _variants(rect, o, walls):
            if best_s is None or _score(rows, mode) > best_s:
                best, best_s = rows, _score(rows, mode)
    return best


def _wkey(walls):
    return tuple(sorted(walls.items()))


def _guillotine(rect, walls, mode="n") -> list[dict]:
    """The first k bands of one orientation, then the leftover strip filled with the best simple fill. k runs from
    all bands down to 0, so plain one-orientation fills are included."""
    x0, z0, x1, z1 = rect
    if x1 - x0 <= 0 or z1 - z0 <= 0:
        return []
    best, best_s = [], None
    for o in ("x", "z"):
        for flip, full in _variants(rect, o, walls):
            for k in range(len(full), -1, -1):
                head = full[:k]
                end = head[-1]["d_end"] + P("row_gap") if head else 0.0
                rw = dict(walls)
                if o == "x":
                    rest = (x0, z0 + end, x1, z1) if not flip else (x0, z0, x1, z1 - end)
                    if head:
                        rw["z1" if flip else "z0"] = False
                        rw["front"] = rw["front"] and flip
                else:
                    rest = (x0 + end, z0, x1, z1) if not flip else (x0, z0, x1 - end, z1)
                    if head:
                        rw["x1" if flip else "x0"] = False
                tail = _best_simple(rest, rw, mode) if rest[2] > rest[0] and rest[3] > rest[1] else []
                sc = _score(head + tail, mode)
                if best_s is None or sc > best_s:
                    best, best_s = head + tail, sc
    return best


@lru_cache(maxsize=4096)
def _pack_c(rect, wk, mode):
    return _guillotine(rect, dict(wk), mode)


def candidates(W, D, zs, xr, xc, zc, wm) -> list[list[dict]]:
    """Row sets to choose from: per decomposition, each rectangle packed for the most tables or for the most seats,
    in every combination. table_slots = the most tables any of them holds."""
    eps = 1e-6
    out = []
    for rects in _rects(W, D, zs, xr, xc, zc, wm):
        per_rect = []
        for r in rects:
            walls = {"x0": r[0] <= wm + eps, "x1": False, "z0": r[1] <= wm + eps, "z1": r[3] >= D - wm - eps,
                     "front": r[1] <= wm + eps}
            per_rect.append([_pack_c(_rk(r), _wkey(walls), m) for m in ("n", "seats")])
        combos = [[]]
        for opts in per_rect:
            combos = [c + o for c in combos for o in opts]
        out += combos
    return out


def choose(cands: list[list[dict]], tables: int, chairs: int) -> tuple[list[dict], int]:
    """(row set, table_slots): the set that seats the most of the requested chairs with every requested table placed
    (or as many as fit); ties go to more slots, then to the earlier candidate."""
    slots = max(_n(c) for c in cands)
    best, best_key = None, None
    for c in cands:
        n = _n(c)
        if n < min(tables, slots):
            continue
        placed = arrange(_fill_order(c), tables, chairs)
        key = (min(chairs, sum(p["cap"] for p in placed)), n)
        if best_key is None or key > best_key:
            best, best_key = c, key
    return _fill_order(best), slots


def _fill_order(rows):
    """Long free-standing rows first (they take 4-tops), then shorter ones, wall rows last; stable otherwise."""
    return sorted(rows, key=lambda r: (r["kind"] != "std", -round(r["length"], 3)))


def _used(n4, n2) -> float:
    n = n4 + n2
    return n4 * W4 + n2 * W2 + max(0, n - 1) * P("table_gap")


def _row_options(row):
    """(n4, n2) mixes a row can hold."""
    if row["kind"] == "wall":
        return [(0, n2) for n2 in range(_cap2(row) + 1)]
    opts = []
    n4 = 0
    while n4 == 0 or _used(n4, 0) <= row["length"] + 1e-9:
        n2 = 0
        while _used(n4, n2 + 1) <= row["length"] + 1e-9:
            n2 += 1
        opts += [(n4, k) for k in range(n2 + 1)]
        n4 += 1
    return opts


def arrange(rows: list[dict], tables: int, chairs: int) -> list[dict]:
    """Place min(tables, slots) tables and choose 4-tops vs 2-tops per row by a small DP: as many 4-tops as
    round-robin chair assignment wants (tables that would get a 3rd chair), every table placed. Rows and options
    are visited in a fixed order and ties keep the first found, so the result is deterministic."""
    g = P("table_gap")
    placed = min(tables, sum(_cap2(r) for r in rows))
    need4 = min(placed, max(0, chairs - 2 * placed))
    # dp[k] = (score, choice list) for k tables over the rows seen so far; score = (min(n4, need4), -n4)
    dp = {0: ((0, 0), [])}
    for r in rows:
        nxt = {}
        for k, (sc, picks) in dp.items():
            for n4, n2 in _row_options(r):
                kk = k + n4 + n2
                if kk > placed:
                    continue
                tot4 = -sc[1] + n4
                cand = ((min(tot4, need4), -tot4), picks + [(n4, n2)])
                if kk not in nxt or cand[0] > nxt[kk][0]:
                    nxt[kk] = cand
        dp = nxt
    counts = [list(x) for x in dp[placed][1]] if placed in dp else [[0, 0] for _ in rows]
    out = []
    for r, (n4, n2) in zip(rows, counts):
        u = r["u0"]
        wall = r["kind"] == "wall"
        for kind in [4] * n4 + [2] * n2:
            w = W4 if (kind == 4 or wall) else W2
            uc = u + w / 2
            x, z = (uc, r["vc"]) if r["orient"] == "x" else (r["vc"], uc)
            out.append({"x": x, "z": z, "cap": kind, "orient": r["orient"], "wall": wall})
            u += w + (P("wall_table_gap") if wall else g)
    return out


def seat_offsets(orient: str, off: float, wall: bool = False) -> list[tuple[float, float, int]]:
    """Chair (dx, dz, rot) in fill order: the two across-row sides first, then the row-end sides (4-tops only).
    A wall table's two chairs sit along the row (its across sides are the wall and the walkway)."""
    across_x = [(0.0, -off, 0), (0.0, off, 180)]     # chairs on -z / +z
    across_z = [(-off, 0.0, 90), (off, 0.0, 270)]    # chairs on -x / +x
    order = across_x + across_z if orient == "x" else across_z + across_x
    return order[2:] + order[:2] if wall else order
