"""카페 동네(행정동) 분석 자료 -> web/public/mock/cafe_dong_stats.json, cafe_dong_profile.json.   python -m pipelines.build_cafe_area

고깃집용 dong_stats.json / dong_profile.json과 같은 모양으로 만든다. 그러면 동네 분석 화면이 업종만 바꿔서 같은 코드로 돈다.
입력은 build_cafe_data.py가 만든 cafe_dong.json(서울 행정동 카페 지표 엑셀, 독립 카페 기준, 서울 425개 행정동)과 cafe_gu.json, 월세는 rent_gu.json.

  stores          커피-음료 가게 수 (서울시 상권분석서비스). 20곳 미만이면 화면이 비교를 하지 않는다(지표 엑셀의 thin과 같은 기준).
  pork            카페 수 (소상공인 상가정보 2026년 6월). 고깃집 쪽 이름(pork)을 그대로 써서 화면 코드를 재사용한다.
  rel             보정 점포당 월매출 ÷ 같은 구의 (점포 수 가중) 평균. 점포 20곳 미만(thin)인 동에는 없다.
  growth          카페는 2024년 동 단위 매출을 갖고 있지 않아 '가게 수 흐름' = 연 개업률 − 연 폐업률(%p)을 쓴다. 매출 성장률이 아니다.
  dow, qidx       동 단위 값이 없어 구의 카페 값(gu_stats.json cafe)을 쓴다.
읽기 전에
  - 유형(오피스·주거·대학·청년·일반)은 지표 엑셀의 매출 비중 규칙 분류이고 현장 조사가 아니다.
  - 매출은 카드 추정매출에 서울 소상공인 카페 월매출(KREI n=63)로 맞춘 배율 1.538을 곱한 값이다.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"


def load(name: str):
    return json.loads((MOCK / name).read_text(encoding="utf-8"))


def pct(v, cuts):
    return int(np.searchsorted(cuts, v, side="right"))


def main() -> None:
    cafe = load("cafe_dong.json")
    cgu = load("cafe_gu.json")
    gus = load("gu_stats.json")["cafe"]["gu"]
    rent = load("rent_gu.json")
    adj = cgu["_meta"]["assumptions"]["보정 배율"]["value"]
    gu_cafes = {v["id"]: v["values"] for v in cgu["vars"]}["reg_raw_003"]
    gu_cafes = {k: int(x) for k, x in gu_cafes.items() if k != "서울 전체"}

    rows = cafe["dong"]
    # 구 평균 매출(점포 수 가중, thin 제외) -> rel
    acc: dict[str, list[float]] = {}
    for r in rows:
        if not r["thin"] and r["sales_m_adj_man"]:
            a = acc.setdefault(r["gu"], [0.0, 0.0])
            a[0] += r["sales_m_adj_man"] * r["cafes"]
            a[1] += r["cafes"]
    gu_mean = {g: a[0] / a[1] for g, a in acc.items() if a[1]}

    stats: dict[str, list[dict]] = {}
    flat: list[dict] = []
    for r in rows:
        gu = r["gu"]
        g = gus.get(gu, {})
        rel = round(r["sales_m_adj_man"] / gu_mean[gu], 3) if not r["thin"] and gu in gu_mean and r["sales_m_adj_man"] else None
        n = lambda k: r[k] if r.get(k) is not None else 0.0  # 매출이 없는 동은 비중도 비어 있다
        shares = {"weekend": round(n("weekend"), 3), "lunch": round(n("share_1114"), 3), "evening": round(n("share_1721") + n("share_2124"), 3),
                  "age20": round(n("age20"), 3), "age30": round(max(n("age2030") - n("age20"), 0), 3)}
        stats.setdefault(gu, []).append({
            "code": r["code"], "name": r["name"], "stores": r["cf_stores"], "pork": r["cafes"], "sales_month": r["sales_q"] / 3 / 10000 if r["sales_q"] else 0,
            "raw_per_store": r["sales_m_adj_man"], "dow": g.get("dow_share"), "qidx": g.get("quarter_index"), "shares": shares, "type": r["type"], "rel": rel})
        area = r["area_km2"]
        pop = (r["work_pop"] or 0) + (r["resident_pop"] or 0)
        net = round((r["open_y"] - r["close_y"]) * 100, 1) if r["open_y"] is not None and r["close_y"] is not None and not r["thin"] else None
        rg = rent["gu"].get(gu, {}).get("rent_man_per_pyeong")
        flat.append({"gu": gu, "name": r["name"], "code": r["code"], "stores": r["cf_stores"], "pork": r["cafes"], "type": r["type"], "shares": shares,
                     "growth": net, "age": None, "area_km2": area,
                     "pork_km2": round(r["cafes"] / area, 1) if area else None, "pork_share": round(r["cafes"] / r["shops"], 3) if r["shops"] else None,
                     "pop_per_pork": round(pop / r["cafes"]) if r["cafes"] and pop else None, "work_pop": r["work_pop"], "resident_pop": r["resident_pop"],
                     "flow_day": r["flow_day"], "apt_price": r["apt_price"], "subway": r["subway"], "univ": r["univ"],
                     "rent": (rent.get("dong") or {}).get(f"{gu}|{r['name']}", {}).get("rent_man_per_pyeong"), "rent_gu": rg,
                     "franchise_share": r["franchise_share"], "near_station": r["near_station_share"], "thin": r["thin"]})

    big = lambda r: not r["thin"]
    col = lambda k, ok=lambda r: True: np.array([r[k] for r in flat if r[k] is not None and ok(r)], float)
    q3 = lambda a: [float(np.quantile(a, q)) for q in (1 / 3, 2 / 3)]
    cut = {
        "pork_km2": q3(col("pork_km2", big)), "growth": q3(col("growth")),
        "apt_price_top": float(np.quantile(col("apt_price"), 0.85)), "rent": q3(col("rent_gu")), "age40_family": 0.0,
        "lunch_hi": float(np.quantile([r["shares"]["lunch"] for r in flat if big(r)], 0.75)),
        "evening_hi": float(np.quantile([r["shares"]["evening"] for r in flat if big(r)], 0.75)),
        "weekend_hi": float(np.quantile([r["shares"]["weekend"] for r in flat if big(r)], 0.75)),
        "pork_share_hi": float(np.quantile(col("pork_share", big), 0.8)),
        "flow_hi": float(np.quantile(col("flow_day"), 0.75)),
    }
    for r in flat:
        r["comp"] = ["약함", "보통", "치열"][pct(r["pork_km2"], cut["pork_km2"])] if r["pork_km2"] is not None and not r["thin"] else None
        r["grow"] = ["하락", "보합", "성장"][pct(r["growth"], cut["growth"])] if r["growth"] is not None else None
        rv = r["rent"] if r["rent"] is not None else r["rent_gu"]
        r["cost"] = ["낮음", "보통", "높음"][pct(rv, cut["rent"])] if rv is not None else None
        r["rich"] = bool(r["apt_price"] and r["apt_price"] >= cut["apt_price_top"])
        r["family"] = False  # 카페 쪽에는 연령별 매출이 없어 가족형은 '주거' 유형으로만 나타낸다

    meta = {"generated": date.today().isoformat(), "year": 2025, "method": "pipelines/build_cafe_area.py", "adj": adj, "gu_cafes": gu_cafes,
            "sources": {"sales": "서울시 상권분석서비스 추정매출 커피-음료(카드) × 보정 배율 %.3f (서울 소상공인 카페 월매출, KREI 2025 n=63)" % adj,
                        "stores": "소상공인시장진흥공단 상가업소 2026년 6월, 서울 행정동 카페 지표 엑셀 정리"},
            "caveats": ["매출은 카드 추정치에 배율을 곱한 값이라 점포당 매출은 구 안의 상대 위치(rel)로만 쓴다",
                        "독립(비프랜차이즈) 카페 기준 자료지만 점포 수에는 프랜차이즈가 섞여 있다",
                        "동 단위 요일·분기 지수가 없어 구 값을 쓴다", "유형은 매출 비중으로 나눈 규칙 분류이며 현장 조사가 아니다"]}
    (MOCK / "cafe_dong_stats.json").write_text(json.dumps({"_meta": meta, "gu": stats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (MOCK / "cafe_dong_profile.json").write_text(json.dumps({"_meta": {"generated": date.today().isoformat(), "cut": cut, "n": len(flat)}, "dong": flat}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    from .build_cafe_extra import RAW, main as add_extra
    if (RAW / "trdar_change_dong.csv").exists():
        add_extra()  # 상권변화지표·소비를 같은 파일에 더한다
    print(len(flat), Counter(r["comp"] for r in flat), Counter(r["grow"] for r in flat), Counter(r["cost"] for r in flat), sum(r["rich"] for r in flat))
    print(cut)


if __name__ == "__main__":
    main()
