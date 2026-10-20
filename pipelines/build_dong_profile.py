"""동네(행정동) 성장률과 상권 특징 -> web/public/mock/dong_profile.json.   python -m pipelines.build_dong_profile

build_dong_stats.py가 만든 dong_stats.json(한식 매출·점포·고깃집 수·시간대 비중)에 아래를 붙인다.
  growth      한식음식점 추정 매출의 전년 대비 증감률(%) = 2025년 4분기 합 / 2024년 4분기 합 - 1. 서울시 상권분석서비스 추정매출-행정동.
              동 전체 매출이라 점포 수 변화가 섞여 있다(점포당 매출이 아니다). 명목값이라 물가 상승분이 섞인다.
  age         매출의 연령 비중(10대·20대·30대·40대·50대·60대 이상)
  서울 행정동 카페 지표 엑셀(cafe_dong.json)에서 같은 동의 면적, 상주·직장인구, 일평균 유동인구, 아파트 평균 시가, 지하철역 수, 대학교 수.
              (카페용으로 모은 자료지만 동네의 인구·면적·집값은 업종과 무관해 그대로 쓴다.)
  분류        경쟁 강도, 비용 수준, 동네 특징, '~형 상권' 이름, 키워드, 제안. 기준값은 서울 동 전체 분포에서 정하고 _meta.cut에 적는다.
읽기 전에
  - 분류는 규칙이다. 현장 조사가 아니고, 규칙과 기준값은 _meta.rules에 있다.
  - 고깃집만의 매출 증감은 없다(한식음식점 전체 기준).
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import numpy as np

from .build_dong_stats import AGES, getj, SEOUL
from .keys import key

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
CACHE = ROOT / "data" / "raw" / "dong_sales"


def quarter_rows(k: str, q: str) -> list[dict]:
    f = CACHE / f"{q}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    rows, a = [], 1
    while True:
        d = getj(SEOUL.format(k=k, a=a, b=a + 999, q=q)).get("VwsmAdstrdSelngW")
        if not d:
            break
        rows += [{"code": r["ADSTRD_CD"], "name": r["ADSTRD_CD_NM"], "amt": float(r["THSMON_SELNG_AMT"] or 0),
                  "age": [float(r[f"AGRDE_{x}_SELNG_AMT"] or 0) for x in AGES]} for r in d["row"] if r["SVC_INDUTY_CD"] == "CS100001"]
        if a + 999 >= d["list_total_count"]:
            break
        a += 1000
        time.sleep(0.2)
    f.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


def pct(v, cuts):
    return int(np.searchsorted(cuts, v, side="right"))


def main() -> None:
    k = key("SEOUL_OPEN_DATA_KEY", fallback=None)
    by_year: dict[int, dict[str, dict]] = {}
    for y in (2024, 2025):
        acc: dict[str, dict] = {}
        for i in (1, 2, 3, 4):
            for r in quarter_rows(k, f"{y}{i}"):
                a = acc.setdefault(r["code"], {"amt": 0.0, "age": [0.0] * 6})
                a["amt"] += r["amt"]
                a["age"] = [x + z for x, z in zip(a["age"], r["age"])]
        by_year[y] = acc
        print(y, len(acc), "동")
    stats = json.loads((MOCK / "dong_stats.json").read_text(encoding="utf-8"))
    cafe = json.loads((MOCK / "cafe_dong.json").read_text(encoding="utf-8"))["dong"]
    cafe_by = {(c["gu"], c["name"]): c for c in cafe}
    rent = json.loads((MOCK / "rent_gu.json").read_text(encoding="utf-8"))
    gus = json.loads((MOCK / "gu_stats.json").read_text(encoding="utf-8"))
    flat = []
    for gu, lst in stats["gu"].items():
        for d in lst:
            c = cafe_by.get((gu, d["name"]), {})
            a24, a25 = by_year[2024].get(d["code"]), by_year[2025].get(d["code"])
            growth = round((a25["amt"] / a24["amt"] - 1) * 100, 1) if a24 and a25 and a24["amt"] > 0 and d["stores"] >= 20 else None
            age = [x / sum(a25["age"]) for x in a25["age"]] if a25 and sum(a25["age"]) else None
            area = c.get("area_km2")
            pop = (c.get("work_pop") or 0) + (c.get("resident_pop") or 0)
            flat.append({"gu": gu, "name": d["name"], "code": d["code"], "stores": d["stores"], "pork": d["pork"], "type": d["type"], "shares": d["shares"],
                         "growth": growth, "age": [round(x, 3) for x in age] if age else None, "area_km2": area,
                         "pork_km2": round(d["pork"] / area, 1) if area else None, "pork_share": round(d["pork"] / d["stores"], 3) if d["stores"] else None,
                         "pop_per_pork": round(pop / d["pork"]) if d["pork"] and pop else None, "work_pop": c.get("work_pop"), "resident_pop": c.get("resident_pop"),
                         "flow_day": c.get("flow_day"), "apt_price": c.get("apt_price"), "subway": c.get("subway"), "univ": c.get("univ"),
                         "rent": (rent.get("dong") or {}).get(f"{gu}|{d['name']}", {}).get("rent_man_per_pyeong"),
                         "rent_gu": rent["gu"].get(gu, {}).get("rent_man_per_pyeong")})
    def col(f, key_, ok=lambda r: True):
        return np.array([r[key_] for r in f if r[key_] is not None and ok(r)], float)
    big = lambda r: r["stores"] >= 20
    cut = {
        "pork_km2": [float(np.quantile(col(flat, "pork_km2", big), q)) for q in (1 / 3, 2 / 3)],
        "growth": [float(np.quantile(col(flat, "growth"), q)) for q in (1 / 3, 2 / 3)],
        "apt_price_top": float(np.quantile(col(flat, "apt_price"), 0.85)),
        "rent": [float(np.quantile(col(flat, "rent_gu"), q)) for q in (1 / 3, 2 / 3)],
        "age40_family": float(np.quantile([r["age"][3] for r in flat if r["age"]], 0.8)),
        "lunch_hi": float(np.quantile([r["shares"]["lunch"] for r in flat if r["stores"] >= 20], 0.75)),
        "evening_hi": float(np.quantile([r["shares"]["evening"] for r in flat if r["stores"] >= 20], 0.75)),
        "weekend_hi": float(np.quantile([r["shares"]["weekend"] for r in flat if r["stores"] >= 20], 0.75)),
        "pork_share_hi": float(np.quantile([r["pork_share"] for r in flat if r["pork_share"] is not None and r["stores"] >= 20], 0.8)),
        "flow_hi": float(np.quantile(col(flat, "flow_day"), 0.75)),
    }
    for r in flat:
        r["comp"] = ["약함", "보통", "치열"][pct(r["pork_km2"], cut["pork_km2"])] if r["pork_km2"] is not None and r["stores"] >= 20 else None
        r["grow"] = ["하락", "보합", "성장"][pct(r["growth"], cut["growth"])] if r["growth"] is not None else None
        rv = r["rent"] if r["rent"] is not None else r["rent_gu"]
        r["cost"] = ["낮음", "보통", "높음"][pct(rv, cut["rent"])] if rv is not None else None
        r["rich"] = bool(r["apt_price"] and r["apt_price"] >= cut["apt_price_top"])
        r["family"] = bool(r["age"] and r["age"][3] >= cut["age40_family"] and r["shares"]["weekend"] >= 0.30)
    (MOCK / "dong_profile.json").write_text(json.dumps({"_meta": {"generated": date.today().isoformat(), "cut": cut, "n": len(flat)}, "dong": flat}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    print(Counter(r["comp"] for r in flat), Counter(r["grow"] for r in flat), Counter(r["cost"] for r in flat), sum(r["rich"] for r in flat), sum(r["family"] for r in flat))
    print(cut)


if __name__ == "__main__":
    main()
