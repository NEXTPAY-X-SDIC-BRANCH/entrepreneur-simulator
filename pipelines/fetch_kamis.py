"""KAMIS(한국농수산식품유통공사) 서울 소매가격: 식량작물·채소류를 챗봇 근거 문장으로 만든다.

    python -m pipelines.fetch_kamis [--date 2026-10-16]

키: KAMIS_API_KEY (필수), KAMIS_CERT_ID (KAMIS 가입 ID, 권장). 키는 출력하지 않는다.
출력: web/public/mock/kamis.json  ({"_meta", "sources", "facts"}; 문장 id는 kamis_ 로 시작)
주의: 서울 소매가격 조사값이다. 주말·공휴일은 조사가 없어 가장 가까운 앞 날짜를 쓴다.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import requests

from .keys import _FILE, key, mask

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
URL = "https://www.kamis.or.kr/service/price/xml.do"
CATEGORIES = {"100": "식량작물", "200": "채소류"}
SEOUL = "1101"


def fetch(k: str, cert_id: str, cat: str, day: date) -> list[dict]:
    p = {"action": "dailyPriceByCategoryList", "p_product_cls_code": "01", "p_item_category_code": cat,
         "p_country_code": SEOUL, "p_regday": day.isoformat(), "p_convert_kg_yn": "N",
         "p_cert_key": k, "p_cert_id": cert_id, "p_returntype": "json"}
    r = requests.get(URL, params=p, timeout=60)
    r.raise_for_status()
    data = r.json().get("data")
    if isinstance(data, dict) and data.get("error_code") == "000":
        items = data.get("item") or []
        return items if isinstance(items, list) else [items]
    if isinstance(data, list) and data and data[0] not in ("001",):
        raise SystemExit(f"KAMIS 오류 코드 {data[0]}: {mask(r.text[:200])}")
    return []


def num(s) -> int | None:
    s = str(s or "").replace(",", "").strip()
    return int(float(s)) if s and s != "-" and s.replace(".", "").isdigit() else None


def label(item: str, kind: str, unit: str) -> str:
    """'대파(1kg)' -> '대파', '20kg(햅쌀)(20kg)' -> '쌀(햅쌀)', '적(100g)' -> '상추(적)'."""
    k = re.sub(r"\([^()]*\)$", "", kind).replace(unit, "").strip()
    if k.startswith("(") and k.endswith(")"):
        k = k[1:-1]
    if k.count("(") != k.count(")"):
        k = k.replace("(", " ").replace(")", " ").strip()
    return item if not k or k == item else k if item in k else f"{item}({k})"


def sentence(it: dict, day: date, month_ok: bool) -> str | None:
    now, year = num(it.get("dpr1")), num(it.get("dpr6"))
    if now is None:
        return None
    unit = it.get("unit", "")
    s = f"{day.month}월 {day.day}일 서울 {label(it['item_name'], it.get('kind_name', ''), unit)} 소매가격은 {unit}당 {now:,}원이에요."
    # 한 달 전 값이 같은 품목의 여러 종류에 똑같이 찍혀 오는 경우가 있어(쌀), 그때는 2주 전 값과 비교한다
    when, before = ("한 달 전", num(it.get("dpr5"))) if month_ok else ("2주 전", num(it.get("dpr4")))
    if before:
        pct = (now - before) / before * 100
        way = "올랐어요" if pct > 0 else "내렸어요"
        s += f" {when} {before:,}원보다 {abs(pct):.0f}% {way}." if round(pct) else f" {when}({before:,}원)과 비슷해요."
    if year:
        s += f" 1년 전에는 {year:,}원이었어요."
    return s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date.today().isoformat())
    a = ap.parse_args()
    k = key("KAMIS_API_KEY", fallback=None)
    cert_id = _FILE.get("KAMIS_CERT_ID") or "entre-simulator"
    day = date.fromisoformat(a.date)
    rows: list[dict] = []
    for _ in range(10):  # 주말·공휴일이면 하루씩 앞으로
        rows = [dict(it, _cat=c) for c in CATEGORIES for it in fetch(k, cert_id, c, day)]
        if any(num(it.get("dpr1")) for it in rows):
            break
        day -= timedelta(days=1)
    else:
        raise SystemExit("최근 10일 동안 KAMIS 서울 소매가격이 없습니다")

    shared = Counter((it["item_name"], it.get("dpr5")) for it in rows)
    facts, seen = [], set()
    for it in rows:
        if it.get("rank") not in ("상품", None) and any(o["item_name"] == it["item_name"] and o.get("rank") == "상품" for o in rows):
            continue
        text = sentence(it, day, shared[(it["item_name"], it.get("dpr5"))] == 1)
        fid = f"kamis_{it['item_name']}_{it.get('kind_code', '')}"
        if not text or fid in seen:
            continue
        seen.add(fid)
        facts.append({"id": fid, "tags": [it["item_name"], CATEGORIES[it["_cat"]], "가격", "소매가격"],
                      "text": text, "sources": ["kamis"]})

    doc = {"_meta": {"generated": date.today().isoformat(), "price_date": day.isoformat(),
                     "method": "pipelines/fetch_kamis.py", "caveat": "서울 소매가격(상품 등급). 날마다 바뀌니 다시 받아야 최신이다"},
           "sources": {"kamis": {"publisher": "한국농수산식품유통공사 (KAMIS)", "title": "농산물 일별 소매가격 (서울)",
                                 "api": "KAMIS Open API dailyPriceByCategoryList", "url": "https://www.kamis.or.kr",
                                 "period": day.isoformat()}},
           "facts": facts}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "kamis.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{day} 기준 {len(facts)}개 품목 문장 저장" + ("" if _FILE.get("KAMIS_CERT_ID") else " (KAMIS_CERT_ID 없음: .env에 KAMIS 가입 ID를 넣어 주세요)"))


if __name__ == "__main__":
    main()
