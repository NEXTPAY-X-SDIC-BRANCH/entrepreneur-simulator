"""새 업종 엔진 입력 읽기 (lab:industry). 모두 파일에서 읽고 네트워크는 쓰지 않는다.

research/industries/<id>.yaml   업종 값 (pipelines/build_industry_params.py가 krei.json에서 생성)
research/industries/common.yaml 공통 값 (손으로)
research/industries/events.yaml 이달의 사건 (손으로)
web/public/mock/industry_gu.json, industry_<id>_dong.json  동네 값 (pipelines/build_industry_gu.py, build_industry_dong.py)
web/public/mock/rent_gu.json, ecos_rates.json             월세(R-ONE)와 대출 금리(ECOS), 화면과 같은 파일
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

import yaml

from .registry import INDUSTRIES

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "research" / "industries"
MOCK = ROOT / "web" / "public" / "mock"
RANK = {"H": 0, "M": 1, "L": 2, "가정": 2}


@lru_cache(maxsize=None)
def industry(ind: str) -> dict:
    if ind not in INDUSTRIES:
        raise KeyError(f"unknown industry {ind}")
    return yaml.safe_load((DIR / f"{ind}.yaml").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def common() -> dict:
    return yaml.safe_load((DIR / "common.yaml").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def events() -> dict:
    return yaml.safe_load((DIR / "events.yaml").read_text(encoding="utf-8"))


def iv(ind: str, section: str, key: str):
    return industry(ind)[section][key]["value"]


def cv(section: str, key: str):
    return common()[section][key]["value"]


@lru_cache(maxsize=1)
def gu_data() -> dict:
    return json.loads((MOCK / "industry_gu.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def dong_data(ind: str) -> dict | None:
    p = MOCK / f"industry_{ind}_dong.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=1)
def rent_data() -> dict | None:
    p = MOCK / "rent_gu.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=1)
def loan_rate() -> tuple[float, str]:
    p = MOCK / "ecos_rates.json"
    if p.exists():
        d = json.loads(p.read_text(encoding="utf-8")).get("latest", {}).get("loan_sme")
        if d:
            return d["rate"] / 100, f"한국은행 ECOS 예금은행 중소기업 대출금리 {d['month'][:4]}년 {int(d['month'][4:])}월"
    return cv("season", "loan_rate"), "common.yaml season.loan_rate"


def cash_rent_man(gu: str, dong: str | None = None) -> tuple[float, str]:
    """현금 월세 (만원/평·월). model.ts guStat과 같은 식: R-ONE 환산 임대료 ÷ (1 + 보증금 개월 × 전환율 ÷ 12)."""
    r = rent_data()
    if not r:
        return 12.0, "가정 (월세 자료 없음)"
    conv = (r.get("conv_seoul_pct") or cv("cost", "rent_conv_pct_default")) / 100
    months = cv("cost", "deposit_months")
    raw, src = None, ""
    if dong and r.get("dong", {}).get(f"{gu}|{dong}"):
        raw, src = r["dong"][f"{gu}|{dong}"]["rent_man_per_pyeong"], "R-ONE 동네"
    elif gu in r.get("gu", {}):
        raw, src = r["gu"][gu]["rent_man_per_pyeong"], "R-ONE 근사" if not r["gu"][gu].get("imputed") else "R-ONE 채움"
    if raw is None:
        return round(r.get("seoul_avg", 17.45) / (1 + months * conv / 12), 1), "R-ONE 서울 평균"
    return round(raw / (1 + months * conv / 12), 1), src


def grade_of(ind: str, section: str, key: str) -> str:
    return industry(ind)[section][key]["grade"]


def weakest(*grades: str) -> str:
    worst = max(grades, key=lambda x: RANK[x]) if grades else "H"
    return "L" if worst == "가정" else worst


@lru_cache(maxsize=1)
def model_version() -> str:
    files = sorted(DIR.glob("*.yaml")) + [MOCK / "industry_gu.json"]
    h = hashlib.sha256(b"".join(f.read_bytes() for f in files if f.exists()))
    return h.hexdigest()[:10]
