"""매장 운영비 내역 (cost lane). 엔진이 계산한 월 비용 총액을 화면과 다른 레인이 쓸 줄별 내역으로 나눈다.

총액은 바꾸지 않는다: 줄을 모두 더하면 항상 엔진의 mgmt(고깃집) 또는 운영비 줄 합(카페)과 같다.
줄별 비율과 근거는 research/opex.yaml. SeasonSummary.MonthLine.opex_detail (web/src/lab/types.ts) 의 값이다.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


@lru_cache(maxsize=1)
def load() -> dict:
    return yaml.safe_load((ROOT / "research" / "opex.yaml").read_text(encoding="utf-8"))


def _split(total: float, rows: list[dict]) -> dict[str, float]:
    """total을 rows의 share로 나눈다. 반올림 차이는 마지막 줄에 몰아 합이 total과 같게 한다."""
    s = sum(r["share"] for r in rows) or 1.0
    out, acc = {}, 0
    for r in rows[:-1]:
        x = round(total * r["share"] / s)
        out[r["label"]] = x
        acc += x
    out[rows[-1]["label"]] = round(total) - acc
    return out


def bbq_detail(k: dict) -> dict[str, float]:
    """고깃집 한 달의 매장 운영비(k['mgmt']) 내역. k는 sim.season 의 draw kpis
    (opex_util, opex_other, opex_mkt 가 있으면 쓰고, 없으면 mgmt 전체를 '매장 운영비'로 둔다)."""
    mgmt = float(k.get("mgmt") or 0.0)
    if "opex_util" not in k:
        return {"매장 운영비": round(mgmt)}
    o = load()
    util, other, mkt = float(k["opex_util"]), float(k["opex_other"]), float(k.get("opex_mkt") or 0.0)
    out = {**_split(util, o["bbq_utilities"]), **_split(other, o["bbq_other_opex"])}
    if mkt:
        out["마케팅 (SNS 협찬·리뷰 이벤트)"] = round(mkt)
    rest = round(mgmt) - sum(out.values())
    if abs(rest) >= 1:          # 이달 사건·밤 결정에 쓴 돈 (events.yaml cost_won, 결정 대응 비용)
        out["이달 사건 대응"] = rest
    return out


CAFE_UTIL_KEYS = (("전기", "elec"), ("관리비", "maint"), ("수도·가스", "water_gas"), ("통신·보험·세무", "misc"))


def cafe_detail(lines: list[dict], parts: dict, shares: dict) -> dict[str, float]:
    """카페 한 달의 매장 운영비 내역. lines = evaluate()의 cost_lines, parts = 전기 관리비 수도 통신 줄의 구성
    (maint, water_gas, misc; 전기는 나머지), shares = params.yaml의 repairs/supplies/marketing 비율."""
    by = {x["key"]: x["krw"] for x in lines}
    out: dict[str, float] = {}
    util = by.get("utilities", 0)
    fixed = {k: round(parts.get(k, 0)) for _, k in CAFE_UTIL_KEYS if k != "elec"}
    out["전기"] = util - sum(fixed.values())
    for label, k in CAFE_UTIL_KEYS[1:]:
        out[label] = fixed[k]
    sh = by.get("shares", 0)
    tot = sum(shares.values()) or 1.0
    rep = round(sh * shares["repairs"] / tot)
    sup = round(sh * shares["supplies"] / tot)
    out["수선"] = rep
    out["소모품"] = sup
    out["기본 마케팅"] = sh - rep - sup
    for key, label in (("marketing", "추가 마케팅"), ("packaging", "포장재"), ("dessert_waste", "디저트 폐기"),
                       ("scenario", "이달 사건 대응"), ("repair", "설비 수리")):
        if by.get(key):
            out[label] = by[key]
    return {k: x for k, x in out.items() if x}


# 카페 비용 줄을 MonthLine 칸으로 묶는 표
CAFE_GROUP = {"food": "cogs", "card": "fees", "rent": "rent", "labor": "labor", "owner": "labor",
              "packaging": "mgmt", "shares": "mgmt", "marketing": "mgmt", "dessert_waste": "mgmt", "utilities": "mgmt",
              "scenario": "mgmt", "repair": "mgmt"}


def cafe_month_line(e: dict, parts: dict, shares: dict) -> dict:
    """카페 evaluate() 결과 → MonthLine 모양 (revenue, op, covers, cogs, labor, rent, mgmt, fees, opex_detail).
    감가상각은 현금이 나가지 않는 비용이라 따로 depreciation 으로 둔다 (op에는 들어 있음)."""
    g = {"cogs": 0, "labor": 0, "rent": 0, "mgmt": 0, "fees": 0}
    for x in e["cost_lines"]:
        g[CAFE_GROUP.get(x["key"], "mgmt")] += x["krw"]
    owner = next((x["krw"] for x in e["cost_lines"] if x["key"] == "owner"), 0)
    return {"revenue": e["revenue_krw"], "op": e["op_krw"], "covers": e["customers"], **g,
            "labor_owner": owner, "labor_hired": g["labor"] - owner, "depreciation": e["depreciation_krw"],
            "opex_detail": cafe_detail(e["cost_lines"], parts, shares)}


def survey() -> dict:
    return load()["survey"]
