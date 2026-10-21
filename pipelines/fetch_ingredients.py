"""오늘의 식자재 단가 스냅샷 (lab:menu). 메뉴판의 원가(unit_cost)를 다시 계산할 때 쓴다.

    python -m pipelines.fetch_ingredients            # 받을 수 있는 출처는 새로 받고, 키가 없는 출처는 저장된 값을 쓴다
    python -m pipelines.fetch_ingredients --offline  # 아무것도 받지 않고 저장된 자료만으로 다시 만든다

출력: web/public/mock/ingredients_today.json
    {_meta: {basis_date, generated, sources: [{id, publisher, title, url, stage, status, basis_date, note}]},
     items: {id: {name, unit, price, source, date, stage, n?, alt?}}}

출처 (어댑터 순서대로)
  seoul_necessities  서울 열린데이터광장 생필품 농수축산물 가격 (ListNecessariesPricesService), 소매, 날마다
                     키 SEOUL_OPEN_DATA_KEY. 없으면 지난 스냅샷의 값을 그대로 쓴다 (status: cached)
  kamis              KAMIS 서울 소매가격. 키 KAMIS_API_KEY가 있으면 pipelines.fetch_kamis로 새로 받고, 없으면 kamis.json
  kape_wholesale     축산물품질평가원 돼지 부위별 도매 식육포장가격 (pork_kape_2026.json, 월평균 캡처)
  kmta_import        한국육류유통수출협회 월간 육류유통 수입 돼지고기 도매가 (kmta_2026_10.json)
  distributor        식자재 유통 플랫폼 (식봄, 마켓보로 등). 공개 API가 없다. 유통업체와 제휴하면 여기에 연결한다
  assumed            research/menus/ingredients_assumed.yaml, 공개 자료가 없는 품목 (전부 가정)

같은 품목이 두 출처에 있으면 기준일이 늦은 쪽을 쓰고, 다른 쪽은 alt에 남긴다. 키 값은 출력하지 않는다.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from datetime import date
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "ingredients_today.json"
ASSUMED = ROOT / "research" / "menus" / "ingredients_assumed.yaml"
SEOUL_URL = "http://openapi.seoul.go.kr:8088/{key}/json/ListNecessariesPricesService/{a}/{b}/"

# 서울 생필품 가격: 품목명(A_NAME) → (id, 이름, 단위, 단위 환산 배수). 가격 × 배수 = 단위당 가격
SEOUL_MAP: dict[str, tuple[str, str, str, float]] = {
    "돼지고기 100g": ("pork_belly_retail", "돼지 삼겹살 (소매)", "kg", 10),
    "소고기(국산) 100g": ("beef_korean_retail", "한우 등심 1등급 이상 (소매)", "kg", 10),
    "소고기(수입) 100g": ("beef_import_retail", "수입 소고기 등심 (소매)", "kg", 10),
    "닭고기 1kg": ("chicken", "닭고기 (육계)", "kg", 1),
    "소주 360ml, 1병": ("soju", "소주 360ml", "병", 1),
    "맥주 500ml 1캔": ("beer", "맥주 500ml (캔)", "병", 1),
    "콜라 1.5L(1병)": ("cola", "콜라", "L", 1 / 1.5),
    "사이다 1.5L 1병": ("cider", "사이다", "L", 1 / 1.5),
    "생수 500ml 1병": ("water", "생수 500ml", "병", 1),
    "쌀(이천쌀) 10kg 1포": ("rice_brand_retail", "쌀 (브랜드 10kg, 소매)", "kg", 1 / 10),
    "쌀(오대쌀) 10kg 1포": ("rice_brand_retail", "쌀 (브랜드 10kg, 소매)", "kg", 1 / 10),
    "된장 1kg": ("doenjang", "된장", "kg", 1),
    "고추장 1kg": ("gochujang", "고추장", "kg", 1),
    "두부 380g": ("tofu", "두부 (380g 한 모)", "모", 1),
    "애호박 1개": ("zucchini", "애호박", "개", 1),
    "배추(가을) 1포기": ("cabbage", "배추 (가을)", "포기", 1),
    "감자 100g": ("potato", "감자", "kg", 10),
    "청양고추 100g": ("chili", "청양고추", "kg", 10),
    "상추(청상추) 100g": ("lettuce", "상추 (청)", "kg", 10),
    "깻잎 100g": ("perilla", "깻잎", "kg", 10),
    "깐마늘 1kg": ("garlic", "깐마늘", "kg", 1),
    "계란 10개": ("egg", "계란 (특란)", "개", 1 / 10),
    "우유 1L": ("milk", "우유", "L", 1),
    "설탕 1kg": ("sugar", "설탕", "kg", 1),
    "밀가루 1kg": ("flour", "밀가루 (중력)", "kg", 1),
}

# KAMIS 문장 id → (id, 이름, 단위). 문장의 "Nkg당 / Ng당 / N개당 X원"을 단위당 값으로 바꾼다
KAMIS_MAP: dict[str, tuple[str, str, str]] = {
    "kamis_쌀_01": ("rice", "쌀 (20kg, 소매)", "kg"),
    "kamis_양파_00": ("onion", "양파", "kg"),
    "kamis_파_00": ("green_onion", "대파", "kg"),
    "kamis_감자_01": ("potato", "감자", "kg"),
    "kamis_상추_02": ("lettuce", "상추 (청)", "kg"),
    "kamis_깻잎_00": ("perilla", "깻잎", "kg"),
    "kamis_호박_01": ("zucchini", "애호박", "개"),
    "kamis_풋고추_03": ("chili", "청양고추", "kg"),
    "kamis_깐마늘(국산)_01": ("garlic", "깐마늘", "kg"),
}

# 축산물품질평가원 부위별 도매 식육포장가격 (전국 평균, 원/kg)
KAPE_MAP: dict[str, tuple[str, str]] = {
    "pork_wholesale_삼겹살_sep": ("pork_belly", "돼지 삼겹살 (국내산 냉장, 도매)"),
    "pork_wholesale_목심_sep": ("pork_neck", "돼지 목심 (국내산 냉장, 도매)"),
    "pork_wholesale_항정살_sep": ("pork_jowl", "돼지 항정살 (국내산, 도매)"),
    "pork_wholesale_가브리살_sep": ("pork_gabri", "돼지 가브리살 (국내산, 도매)"),
    "pork_wholesale_갈매기살_sep": ("pork_galmaegi", "돼지 갈매기살 (국내산, 도매)"),
    "pork_wholesale_갈비_sep": ("pork_rib", "돼지 갈비 (국내산, 도매)"),
}

# 한국육류유통수출협회 수입 돼지고기 도매가 (문장 안의 이름 → id)
KMTA_IMPORT = [("스페인산 냉동 삼겹살", "pork_belly_import", "수입 냉동 삼겹살 (스페인산, 도매)"),
               ("미국산 목전지", "pork_neck_import", "수입 목전지 (미국산, 도매)")]

SOURCES = {
    "seoul_necessities": {"publisher": "서울특별시 (서울 열린데이터광장)", "title": "생필품 농수축산물 가격 정보 (전통시장·대형마트)",
                          "url": "https://data.seoul.go.kr/dataList/OA-1170/S/1/datasetView.do", "stage": "소매"},
    "kamis": {"publisher": "한국농수산식품유통공사 (KAMIS)", "title": "농산물 일별 소매가격 (서울)", "url": "https://www.kamis.or.kr",
              "stage": "소매"},
    "kape_wholesale": {"publisher": "축산물품질평가원 (축산유통정보)", "title": "돼지 부위별 도매 식육포장가격 (전국 평균, 월)",
                       "url": "https://www.ekapepia.com", "stage": "도매"},
    "kmta_import": {"publisher": "(사)한국육류유통수출협회", "title": "월간 육류유통 2026년 10월호, 수입 돼지고기 도매가",
                    "url": "https://www.kmta.or.kr", "stage": "도매"},
    "distributor": {"publisher": "식자재 유통 플랫폼 (식봄, 마켓보로 등)", "title": "B2B 식자재 납품가",
                    "url": None, "stage": "납품"},
    "assumed": {"publisher": "ChangeUp 가정", "title": "공개 자료가 없는 품목의 단가 (research/menus/ingredients_assumed.yaml)",
                "url": None, "stage": "가정"},
}


def _won(s: str) -> int:
    return int(s.replace(",", ""))


def _key(name: str) -> str | None:
    try:
        from .keys import key
        return key(name, fallback=None)
    except SystemExit:
        return None


def _mask(text: str, secret: str | None) -> str:
    return text.replace(secret, "<KEY>") if secret else text


# ------------------------------------------------------------------------------------------------- adapters
def seoul_necessities(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    """서울시 생필품 가격. 가장 최근 조사일의 행만 모아 품목별 중앙값. 키가 없으면 지난 스냅샷 값."""
    k = None if offline else (_key("SEOUL_OPEN_DATA_KEY") or os.environ.get("SEOUL_API_KEY"))
    if not k:
        old = [dict(v, id=i) for i, v in (previous.get("items") or {}).items() if v.get("source") == "seoul_necessities"]
        old += [dict(a, id=i, name=v["name"]) for i, v in (previous.get("items") or {}).items() for a in v.get("alt") or []
                if a.get("source") == "seoul_necessities"]
        d = max((x["date"] for x in old), default=None)
        return old, {"status": "cached" if old else "missing", "basis_date": d,
                     "note": "SEOUL_OPEN_DATA_KEY가 없어 지난 스냅샷 값을 씀" if old else "키도 지난 값도 없음"}
    rows: list[dict] = []
    latest = None
    for page in range(8):   # 최신 조사일부터 내려온다. 조사일이 바뀌면 멈춘다
        url = SEOUL_URL.format(key=k, a=page * 1000 + 1, b=page * 1000 + 1000)
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            body = r.json()["ListNecessariesPricesService"]
        except (requests.RequestException, KeyError, ValueError) as e:
            raise SystemExit(_mask(f"서울 생필품 가격 API 오류: {e}", k)) from None
        got = body.get("row") or []
        latest = latest or max(x["P_DATE"] for x in got)
        rows += [x for x in got if x["P_DATE"] == latest]
        if not got or any(x["P_DATE"] != latest for x in got):
            break
    by: dict[str, list[float]] = {}
    meta: dict[str, tuple[str, str]] = {}
    for x in rows:
        m = SEOUL_MAP.get(x["A_NAME"].strip())
        if not m:
            continue
        try:
            price = float(x["A_PRICE"])
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        iid, name, unit, mult = m
        by.setdefault(iid, []).append(price * mult)
        meta[iid] = (name, unit)
    items = [{"id": i, "name": meta[i][0], "unit": meta[i][1], "price": round(statistics.median(v)), "n": len(v),
              "source": "seoul_necessities", "date": latest, "stage": "소매",
              "note": f"서울 전통시장·대형마트 {len(v)}곳 중앙값"} for i, v in sorted(by.items())]
    return items, {"status": "ok", "basis_date": latest, "note": f"{latest} 조사 {len(rows)}행에서 {len(items)}개 품목"}


_KAMIS_RE = re.compile(r"(\d+)\s*(kg|g|개|포기)당 ([\d,]+)원")


def kamis(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    """KAMIS 서울 소매가격. 키가 있으면 pipelines.fetch_kamis로 kamis.json을 새로 받은 뒤 읽는다."""
    note = "KAMIS_API_KEY가 없어 저장된 kamis.json을 씀"
    if not offline and _key("KAMIS_API_KEY"):
        subprocess.run([sys.executable, "-m", "pipelines.fetch_kamis"], cwd=ROOT, check=True)
        note = "pipelines.fetch_kamis로 새로 받음"
    f = MOCK / "kamis.json"
    if not f.exists():
        return [], {"status": "missing", "basis_date": None, "note": "kamis.json 없음"}
    doc = json.loads(f.read_text(encoding="utf-8"))
    day = doc["_meta"].get("price_date")
    out = []
    for fact in doc["facts"]:
        m = KAMIS_MAP.get(fact["id"])
        hit = _KAMIS_RE.search(fact["text"]) if m else None
        if not hit:
            continue
        qty, u, price = int(hit.group(1)), hit.group(2), _won(hit.group(3))
        iid, name, unit = m
        per = price / qty if u in ("개", "포기") or unit != "kg" else price / (qty / 1000 if u == "g" else qty)
        out.append({"id": iid, "name": name, "unit": unit, "price": round(per), "source": "kamis", "date": day,
                    "stage": "소매", "note": f"KAMIS 문장 {fact['id']}"})
    return out, {"status": "cached" if "저장된" in note else "ok", "basis_date": day, "note": note}


def kape_wholesale(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    f = MOCK / "pork_kape_2026.json"
    doc = json.loads(f.read_text(encoding="utf-8"))
    out = []
    for fact in doc["facts"]:
        m = KAPE_MAP.get(fact["id"])
        if not m:
            continue
        price = re.search(r"전국 평균 ([\d,]+)원/kg", fact["text"])
        ym = re.search(r"(\d{4})년 (\d{1,2})월", fact["text"])
        if not price or not ym:
            raise SystemExit(f"KAPE 문장 형식이 바뀜: {fact['id']}")
        out.append({"id": m[0], "name": m[1], "unit": "kg", "price": _won(price.group(1)), "source": "kape_wholesale",
                    "date": f"{ym.group(1)}-{int(ym.group(2)):02d}", "stage": "도매", "note": "월평균, 2026-10-08 갱신 화면 캡처"})
    d = max((x["date"] for x in out), default=None)
    return out, {"status": "snapshot", "basis_date": d, "note": "KAPE 통계DB 화면 값을 옮긴 저장 자료 (자동 수집 API는 키 필요)"}


def kmta_import(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    doc = json.loads((MOCK / "kmta_2026_10.json").read_text(encoding="utf-8"))
    fact = next(x for x in doc["facts"] if x["id"] == "kmta_import_pork_sep")
    out = []
    for label, iid, name in KMTA_IMPORT:
        hit = re.search(re.escape(label) + r" 약 ([\d,]+)원/kg", fact["text"])
        if not hit:
            raise SystemExit(f"KMTA 문장 형식이 바뀜: {label}")
        out.append({"id": iid, "name": name, "unit": "kg", "price": _won(hit.group(1)), "source": "kmta_import",
                    "date": "2026-09", "stage": "도매", "note": "협회 9월 판매제시가격 (업계 자료)"})
    return out, {"status": "snapshot", "basis_date": "2026-09", "note": "월간 육류유통 2026년 10월호 (9월 자료)"}


def distributor(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    """유통업체 제휴 시 연결. 식봄·마켓보로 같은 B2B 플랫폼은 공개 API가 없어 지금은 아무 값도 내지 않는다.
    제휴로 납품가 API를 받으면 여기서 {id, name, unit, price, date, stage: '납품'}을 돌려주면 된다
    (같은 id면 기준일이 늦은 값이 쓰여서 소매·가정 값을 자동으로 대신한다)."""
    return [], {"status": "not_connected", "basis_date": None, "note": "공개 API 없음. 유통업체 제휴 시 연결"}


def assumed(previous: dict, offline: bool) -> tuple[list[dict], dict]:
    doc = yaml.safe_load(ASSUMED.read_text(encoding="utf-8"))
    out = [{"id": i, "name": v["name"], "unit": v["unit"], "price": int(v["price"]), "source": "assumed", "date": None,
            "stage": "가정", "note": v.get("note", "")} for i, v in doc.items()]
    return out, {"status": "ok", "basis_date": None, "note": "공개 자료 없음, 전부 가정"}


ADAPTERS = (seoul_necessities, kamis, kape_wholesale, kmta_import, distributor, assumed)


def _rank(x: dict) -> tuple:
    """같은 id 안에서 고르는 순서: 가정이 아닌 값 → 기준일이 늦은 값 → 표본이 많은 값."""
    return (x["stage"] != "가정", x.get("date") or "", x.get("n", 0))


def build(previous: dict | None = None, offline: bool = False) -> dict:
    previous = previous or {}
    cands: dict[str, list[dict]] = {}
    sources = []
    for ad in ADAPTERS:
        items, st = ad(previous, offline)
        sources.append({"id": ad.__name__, **SOURCES[ad.__name__], **st, "items": len(items)})
        for it in items:
            cands.setdefault(it["id"], []).append({k: v for k, v in it.items() if k != "id"})
    items = {}
    for iid, xs in sorted(cands.items()):
        xs = sorted(xs, key=_rank, reverse=True)
        best = dict(xs[0])
        alt = [{k: x[k] for k in ("price", "unit", "source", "date", "stage") if k in x} for x in xs[1:] if x["unit"] == best["unit"]]
        if alt:
            best["alt"] = alt
        items[iid] = best
    real = [s["basis_date"] for s in sources if s["basis_date"] and s["stage"] != "가정"]
    return {"_meta": {"basis_date": max(real) if real else None, "generated": date.today().isoformat(),
                      "method": "pipelines/fetch_ingredients.py",
                      "caveat": "소매가는 마트·시장 가격이라 식당 납품가와 다르다. 도매가는 월평균. 가정은 공개 자료가 없는 품목",
                      "sources": sources},
            "items": items}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="아무것도 받지 않고 저장된 자료로만 만든다")
    a = ap.parse_args()
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    doc = build(prev, offline=a.offline)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"기준일 {doc['_meta']['basis_date']}, 품목 {len(doc['items'])}개 → {OUT.relative_to(ROOT)}")
    for s in doc["_meta"]["sources"]:
        print(f"  {s['id']:18} {s['status']:13} {s['basis_date'] or '-':10} {s['items']:3}개  {s['note']}")


if __name__ == "__main__":
    main()
