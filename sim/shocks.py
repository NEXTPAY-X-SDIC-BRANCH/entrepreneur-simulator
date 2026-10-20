"""Shock catalog, read from research/shocks.yaml (exported from the workbook's Shocks sheet).

A shock is one or more parameter deltas (pct / abs / set) with low/base/high values. Monte Carlo runs
sample each delta from a triangular(low, base, high) distribution, so the shock's own uncertainty shows
up in the p10/p90 band. Main profit drivers only; tech adoption is out of scope.
"""
from __future__ import annotations

import yaml

from sim.params import INDUSTRY_YAML, SHOCKS_YAML, clone


def load_shocks(path=SHOCKS_YAML) -> dict:
    """Shocks from the workbook. industry game.rain_mode = every_night makes SH10 the worst case (SH10b)."""
    raw = yaml.safe_load(open(path, encoding="utf-8"))
    out = {k: v for k, v in raw.items() if not k.startswith("_")}
    game = (yaml.safe_load(open(INDUSTRY_YAML, encoding="utf-8")) or {}).get("game", {})
    if game.get("rain_mode") == "every_night" and "SH10b" in out:
        out["SH10"] = out["SH10b"]
    return out


def _apply(value, dtype: str, delta):
    if dtype == "pct":
        return value * (1 + delta)
    if dtype == "abs":
        return value + delta
    if dtype == "set":
        return delta
    raise ValueError(f"unknown delta_type {dtype}")


def _draw(row: dict, rng) -> float:
    lo, base, hi = row["low"], row["base"], row["high"]
    left, right = min(lo, hi), max(lo, hi)
    if rng is None or left == right:
        return base
    return float(rng.triangular(left, min(max(base, left), right), right))


def apply_shock(params: dict, shock: dict, rng=None) -> dict:
    """Return a new params dict with the shock applied (base delta if rng is None, else sampled).
    Reference prices in params['_ref'] stay untouched, so price elasticity sees the change."""
    p = clone(params)
    for row in shock["params"]:
        cid = row["parameter"]
        p[cid] = _apply(p[cid], row["delta_type"], _draw(row, rng))
    if "sto_parttimers" in p:
        p["sto_parttimers"] = max(0, round(p["sto_parttimers"]))
    return p


def describe(shock_id: str, shock: dict) -> str:
    """Human-readable mechanism + assumptions, printed with every shock run."""
    lines = [f"[{shock_id}] {shock['driver']}"]
    fmts = {"pct": lambda x: f"{x * 100:+.1f}%", "abs": lambda x: f"{x:+g}", "set": lambda x: f"= {x:g}"}
    for r in shock["params"]:
        fmt = fmts[r["delta_type"]]
        lines.append(f"  {r['parameter']}: {fmt(r['base'])} (range {fmt(r['low'])} .. {fmt(r['high'])})")
        lines.append(f"    mechanism:  {r['mechanism']}")
        lines.append(f"    assumption: {r['rationale']} | confidence {r['confidence']} | source {r['source_id'] or 'none'}")
    return "\n".join(lines)
