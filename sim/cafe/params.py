"""Load research/cafe/params.yaml (hand-curated, graded) and districts.yaml (generated from the Seoul cache)."""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PARAMS_YAML = ROOT / "research" / "cafe" / "params.yaml"
DISTRICTS_YAML = ROOT / "research" / "cafe" / "districts.yaml"
# 서울 행정동 확장 (build_dongs.py가 만든다). 있으면 원래 3개 상권과 합쳐 읽는다.
META_DONG_YAML = ROOT / "research" / "cafe" / "district_meta_dong.yaml"
DISTRICTS_DONG_YAML = ROOT / "research" / "cafe" / "districts_dong.yaml"

GRADES = ("H", "M", "L", "가정")


@lru_cache(maxsize=1)
def load_params() -> dict:
    p = yaml.safe_load(PARAMS_YAML.read_text(encoding="utf-8"))
    if META_DONG_YAML.exists():
        p["district_meta"].update(yaml.safe_load(META_DONG_YAML.read_text(encoding="utf-8")))
    return p


@lru_cache(maxsize=1)
def load_districts() -> dict:
    d = yaml.safe_load(DISTRICTS_YAML.read_text(encoding="utf-8"))["districts"]
    if DISTRICTS_DONG_YAML.exists():
        d.update(yaml.safe_load(DISTRICTS_DONG_YAML.read_text(encoding="utf-8"))["districts"])
    return d


@lru_cache(maxsize=1)
def load_seoul() -> dict:
    """Seoul-wide mean per cafe for the same quarter as the districts (the demand index denominator)."""
    return yaml.safe_load(DISTRICTS_YAML.read_text(encoding="utf-8"))["seoul"]


@lru_cache(maxsize=1)
def model_version() -> str:
    """Short hash of the two input files: a season token made under other numbers must not replay silently."""
    h = hashlib.sha256(b"".join(f.read_bytes() for f in (PARAMS_YAML, DISTRICTS_YAML, META_DONG_YAML, DISTRICTS_DONG_YAML) if f.exists()))
    return h.hexdigest()[:10]


def v(section: str, key: str):
    return load_params()[section][key]["value"]


def g(section: str, key: str) -> str:
    return load_params()[section][key]["grade"]


def weakest(*grades: str) -> str:
    """Block grade = its weakest input; 가정 rolls up as L (a block is never purer than its worst number)."""
    rank = {"H": 0, "M": 1, "L": 2, "가정": 2}
    worst = max(grades, key=lambda x: rank[x]) if grades else "H"
    return "L" if worst == "가정" else worst
