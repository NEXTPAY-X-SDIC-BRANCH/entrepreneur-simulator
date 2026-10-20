"""KOSIS의 외식업체경영실태조사(KREI)와 한식산업실태조사를 받아 목업이 읽는 파일로 만든다.

    python -m pipelines.fetch_kosis

키: KOSIS_KEY (키 끝의 '=' 까지 그대로 넣어야 함). 키는 출력하지 않는다.
출력: web/public/mock/kosis_food.json
용도: 열기 전 점검(비용 구조), 동네 분석 > 드는 돈(투자비·보증금·권리금), 시뮬레이션 비용 검증.
한계: 손익·투자비는 '한식'과 '서울권'까지 나뉘고 '육류요리 전문점' 단독 행은 없다.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path
from urllib.parse import quote

import requests

from .keys import key, mask

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
ORG = "114"

# (표 ID, 이 표를 어디에 쓰는지)
TABLES = {
    "DT_114054_008": "사업장 임차현황 (보증금, 권리금, 계약기간)",
    "DT_114054_009": "영업시간, 월 영업일",
    "DT_114054_010": "테이블, 좌석 수",
    "DT_114054_012": "개업 시 인테리어 비용",
    "DT_114054_021": "매출액",
    "DT_114054_022": "객단가",
    "DT_114054_023": "1일 방문 고객",
    "DT_114054_024": "근로형태별 근로자, 인건비",
    "DT_114054_025": "경영상 애로사항",
    "DT_114054_028": "사업실적 (비용 구성)",
    "DT_114054_029": "수익성·생산성",
    "DT_114054_031": "식재료비 사용 비중",
    "DT_114054_072": "개업 시 투자 비용 (주방, 홀)",
    "DT_114054_078": "요일별 매출 비중",
    "DT_114058_2023_A002": "한식산업실태조사 사업장 업종 (육류요리 전문점 비중)",
    "DT_114058_2023_A007": "한식산업실태조사 월평균 영업 비용",
    "DT_114058_2023_B004": "한식산업실태조사 창업 소요 자금",
    "DT_114058_2023_C020": "한식산업실태조사 고객 재방문율",
}
# 목업이 쓰는 분류만 남긴다 (표 전체는 수천 행)
KEEP_C1 = {"전체", "일반음식점", "일반음식점업", "한식", "한식 음식점업", "서울권", "주점업", "프랜차이즈", "비프랜차이즈"}
KEEP_COST_C1 = {"매출액", "영업비용", "식재료비", "고용인 인건비", "임차료", "세금", "기타", "대표자 인건비", "가족 종사자 인건비", "영업이익"}


def fetch(k: str, tid: str, years: int = 3) -> list[dict]:
    last = ""
    for n_obj in (1, 2, 3):
        p = {"method": "getList", "apiKey": quote(k, safe=""), "format": "json", "jsonVD": "Y", "orgId": ORG,
             "tblId": tid, "prdSe": "Y", "newEstPrdCnt": str(years), "itmId": "ALL"}
        for i in range(1, n_obj + 1):
            p[f"objL{i}"] = "ALL"
        for attempt in range(3):
            # apiKey는 이미 인코딩했으므로 쿼리를 직접 만든다 (requests의 params로 넣으면 한 번 더 인코딩됨)
            q = "&".join(f"{a}={b}" for a, b in p.items())
            r = requests.get(f"{URL}?{q}", timeout=60)
            if r.status_code == 200:
                break
            time.sleep(2)
        try:
            d = r.json()
        except ValueError:
            raise SystemExit(f"{tid}: JSON이 아닌 응답 {mask(r.text[:150])}")
        if isinstance(d, list):
            return d
        last = str(d)
        if isinstance(d, dict) and d.get("err") == "20":  # 분류 축이 더 있다
            continue
        break
    raise SystemExit(f"{tid}: {mask(last[:200])}")


def trim(rows: list[dict], tid: str) -> list[dict]:
    out = []
    for r in rows:
        c1, c2 = r.get("C1_NM", ""), r.get("C2_NM", "")
        if tid == "DT_114054_028":  # 비용 구성: C1이 항목, C2가 분류
            if c1 not in KEEP_COST_C1 or c2 not in KEEP_C1:
                continue
        elif tid == "DT_114058_2023_A002":  # C1 규모/업종, C2 세부 업종
            if c1 not in KEEP_C1:
                continue
        elif c1 not in KEEP_C1:
            continue
        out.append({"y": r["PRD_DE"], "c1": c1, "c2": c2 or None, "c3": r.get("C3_NM") or None,
                    "item": r.get("ITM_NM"), "v": r.get("DT"), "unit": r.get("UNIT_NM") or None})
    return out


def main() -> None:
    k = key("KOSIS_KEY", fallback=None)
    tables = {}
    for tid, why in TABLES.items():
        rows = fetch(k, tid)
        kept = trim(rows, tid)
        tables[tid] = {"name": rows[0].get("TBL_NM"), "use": why, "rows": kept}
        print(f"{tid} {rows[0].get('TBL_NM')}: {len(rows)}행 → {len(kept)}행")
    OUT.mkdir(parents=True, exist_ok=True)
    doc = {
        "_meta": {
            "generated": date.today().isoformat(),
            "source": "KOSIS 국가통계포털 (농림수산식품교육문화정보원 외식업체경영실태조사, 한식산업실태조사)",
            "org_id": ORG,
            "method": "pipelines/fetch_kosis.py",
            "caveats": [
                "손익·투자비는 한식(일반음식점)과 서울권까지만 나뉘고 육류요리 전문점 단독 행은 없음",
                "투자비·인테리어 평균은 '모름' 응답이 절반 안팎이고 평균은 응답자 기준",
                "연 단위 조사이며 값은 전년도 기준 응답",
            ],
        },
        "tables": tables,
    }
    p = OUT / "kosis_food.json"
    p.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {p.name} ({p.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
