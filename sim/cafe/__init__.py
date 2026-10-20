"""Cafe 창업 시뮬레이터: store-setup preview (layout solver, peak capacity, CAPEX, monthly fixed cost).

Single source of truth for the Unity configurator and any web client: api/cafe.py only validates and calls
`preview()`. See docs/CAFE.md for the contract and the assumptions table.
"""
from .model import districts, preview  # noqa: F401
