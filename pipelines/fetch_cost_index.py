"""고깃집 원가의 달별 배수: 돼지고기(KOSIS 생활물가지수)와 쌈채소·양념 채소(KAMIS 서울 중도매인 판매가).

    python -m pipelines.fetch_cost_index

입력: web/public/mock/kosis_pork.json (pipelines/fetch_kosis_pork.py), web/public/mock/jeju_pork.json (참고용 도매가)
키: KAMIS_API_KEY, KAMIS_CERT_ID (채소 월별 가격). 키는 출력하지 않는다.
출력: web/public/mock/cost_index.json
방법
  - 시즌(10월~다음 해 3월)마다 그해 10월 값을 1로 놓고 각 달 값을 나눈다. 10월이 엔진 원가의 기준 달이다.
  - 지난 시즌들의 평균을 달별 배수로, 가장 낮은·높은 해를 범위로 적는다. 예측이 아니라 "과거 같은 시기"의 값이다.
  - 채소는 아래 6개 품목을 같은 비중으로 평균한다 (비중은 가정. 고깃집 반찬·쌈 구성 자료가 없다).
    깐마늘은 월별 중도매인 값이 비어 있어 뺐다.
  - 사건(시세 급등·급락) 확률은 평균 경로에서 ±5% 넘게 벗어난 시즌·달의 비율로 센다.
"""
from __future__ import annotations

import json
import statistics as st
import time
from pathlib import Path

import requests

from .keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "cost_index.json"
KAMIS = "https://www.kamis.or.kr/service/price/xml.do"
SEASON = [10, 11, 12, 1, 2, 3]
VEG = {"상추(적)": ("214", "01"), "상추(청)": ("214", "02"), "깻잎": ("253", "00"), "풋고추": ("242", "00"),
       "양파": ("245", "00"), "대파": ("246", "00")}
SHOCK = 0.05


def kamis_monthly(k: str, cid: str, item: str, kind: str, last_year: int) -> dict[str, float]:
    p = {"action": "monthlySalesList", "p_cert_key": k, "p_cert_id": cid, "p_returntype": "json",
         "p_yyyy": str(last_year), "p_period": "6", "p_itemcategorycode": "200", "p_itemcode": item,
         "p_kindcode": kind, "p_graderank": "1", "p_countycode": "1101", "p_convert_kg_yn": "N"}
    r = requests.get(KAMIS, params=p, timeout=60)
    r.raise_for_status()
    d = r.json()
    if d.get("error_code") != "000":
        raise SystemExit(f"KAMIS 오류: {mask(r.text[:200])}")
    price = d.get("price") or []
    whole = [x for x in ([price] if isinstance(price, dict) else price) if str(x.get("caption", "")).startswith("중도매인")]
    if not whole:
        raise SystemExit(f"KAMIS {item}/{kind}: 중도매인 판매가격이 없습니다")
    out = {}
    rows = [y for w in whole for y in (w.get("item") or [])] if whole else []
    for y in [rows] if isinstance(rows, dict) else rows:
        for m in range(1, 13):
            s = str(y.get(f"m{m}") or "").replace(",", "").strip()
            if s and s != "-":
                out[f"{y['yyyy']}{m:02d}"] = float(s)
    return out


def ym(season: int, m: int) -> str:
    return f"{season if m >= 10 else season + 1}{m:02d}"


def season_path(series: dict[str, float]) -> dict:
    seasons = [y for y in range(2015, 2030) if all(ym(y, m) in series for m in SEASON)]
    rel = {m: [series[ym(y, m)] / series[ym(y, 10)] for y in seasons] for m in SEASON}
    mean = {m: st.mean(v) for m, v in rel.items()}
    dev = [rel[m][i] / mean[m] - 1 for m in SEASON[1:] for i in range(len(seasons))]
    return {"seasons": [f"{y}/{(y + 1) % 100:02d}" for y in seasons],
            "index": {str(m): round(mean[m], 3) for m in SEASON},
            "low": {str(m): round(min(rel[m]), 3) for m in SEASON},
            "high": {str(m): round(max(rel[m]), 3) for m in SEASON},
            "by_season": {f"{y}/{(y + 1) % 100:02d}": {str(m): round(rel[m][i], 3) for m in SEASON}
                          for i, y in enumerate(seasons)},
            "shock": {"threshold": SHOCK, "n": len(dev),
                      "up_share": round(sum(d >= SHOCK for d in dev) / len(dev), 3),
                      "down_share": round(sum(d <= -SHOCK for d in dev) / len(dev), 3),
                      "up_mean": round(st.mean([d for d in dev if d >= SHOCK] or [0]), 3),
                      "down_mean": round(st.mean([d for d in dev if d <= -SHOCK] or [0]), 3)}}


def main() -> None:
    pork = next(iter(json.loads((MOCK / "kosis_pork.json").read_text(encoding="utf-8"))["series"].values()))
    jeju = {x["month"].replace("-", ""): x["won_per_kg"]
            for x in json.loads((MOCK / "jeju_pork.json").read_text(encoding="utf-8"))["series"]}
    k, cid = key("KAMIS_API_KEY", fallback=None), key("KAMIS_CERT_ID", fallback=None)
    last = int(time.strftime("%Y"))
    veg_items = {}
    for name, (item, kind) in VEG.items():
        veg_items[name] = kamis_monthly(k, cid, item, kind, last)
        time.sleep(0.3)
    months = sorted(set.intersection(*(set(s) for s in veg_items.values())))
    # 품목마다 단위가 달라(4kg, 2kg, 10kg ...) 품목별 시즌 10월 대비 비율을 먼저 내고 평균한다
    veg_paths = {n: season_path(s) for n, s in veg_items.items()}
    veg = season_path({mo: st.mean(s[mo] / st.mean(s.values()) for s in veg_items.values()) for mo in months})

    out = {
        "_meta": {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "method": "pipelines/fetch_cost_index.py. 시즌마다 10월 = 1. index는 지난 시즌 평균, low/high는 가장 낮은·높은 해",
                  "pork_source": "KOSIS 생활물가지수 돼지고기 전국 (DT_1J22005, S100)",
                  "veg_source": "KAMIS 서울 중도매인 판매가격 월평균 (S101). 품목: " + ", ".join(VEG) + " (같은 비중, 가정)",
                  "wholesale_reference": "축산물품질평가원 제주 지육 경락가 (jeju_pork.json). 도매는 소매보다 더 크게 출렁인다",
                  "shock": f"평균 경로에서 ±{SHOCK:.0%} 넘게 벗어난 시즌·달의 비율 (11~3월)"},
        "pork": season_path(pork), "pork_wholesale_jeju": season_path(jeju), "veg": veg,
        "veg_items": {n: {"index": p["index"], "low": p["low"], "high": p["high"]} for n, p in veg_paths.items()},
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for n in ("pork", "pork_wholesale_jeju", "veg"):
        p = out[n]
        print(n, p["seasons"], p["index"], "급등", p["shock"]["up_share"], p["shock"]["up_mean"],
              "급락", p["shock"]["down_share"], p["shock"]["down_mean"])


if __name__ == "__main__":
    main()
