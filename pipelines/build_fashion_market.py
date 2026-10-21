"""옷가게용 시장 자료 -> web/public/mock/fashion_market.json.  python -m pipelines.build_fashion_market

입력 (사용자가 2026-10-21 받은 자료)
  research/fashion/global-statistics-monthly.csv  섬유패션 글로벌 통계 (환율, 원면·에틸렌글리콜·카프로락탐 시세)
  아래 PDF 숫자는 손으로 옮겨 적었다 (원본은 data/raw/fashion/, 저장소에는 올리지 않음)
    - 한국섬유산업연합회·산업통상부 「2026년 SS시즌(3~8월) 상반기 패션 소비 현황」 (패션 소비 실태조사, 3,500명 온라인 조사)
    - 「2026년 8월 섬유류 품목별 수출입실적(확정치)」 2쪽 수입: 의류
    - 한국섬유산업연합회 「섬유패션산업 주요 경기지표 ('26년 7월)」
계산
  - acc_share: 가방/지갑 + 기타잡화 ÷ (전체 − 신발). 옷가게는 신발을 팔지 않는다고 본다
  - import_cost_yoy_krw: 의류 수입단가($/kg) 1~8월 누계 증감 × 같은 기간 원/달러 평균 증감 → 원화 기준 수입 의류 값이 1년 새 오른 비율
  - materials_krw: 원면·에틸렌글리콜(폴리에스터 원료)·카프로락탐(나일론 원료) 달러 시세 × 환율, 2020년 평균 = 100
"""
from __future__ import annotations

import csv
import json
import statistics as st
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV = ROOT / "research" / "fashion" / "global-statistics-monthly.csv"
OUT = ROOT / "web" / "public" / "mock" / "fashion_market.json"

# 패션 소비 실태조사 2026 SS (조 원). 3쪽 복종별, 7쪽 월별, 12쪽 온/오프라인, 15쪽 브랜드, 16쪽 가을 전망
KOFOTI = {
    "total": 43.1, "by_category": {"남성복(정장)": 3.6, "여성복(정장)": 3.1, "캐주얼복": 13.1, "스포츠의류": 5.4, "골프웨어": 2.0, "아웃도어": 2.7,
                                   "이너웨어": 1.2, "유아동복": 1.0, "신발": 7.0, "가방/지갑": 3.6, "기타잡화": 0.4},
    "monthly_total": {"3": 8.5, "4": 7.2, "5": 9.1, "6": 7.4, "7": 5.8, "8": 5.0},
    "online_share": 0.523,
    "casual_brand_top": {"나이키": 13.6, "유니클로": 11.1, "탑텐": 5.6, "아디다스": 5.1, "자라": 4.5},
    "fall_outlook": {"index_apparel": 99.7, "decrease": 27.1, "same": 62.8, "increase": 10.1, "index_all": 99.5},
}
# 섬유류 품목별 수입실적 2026년 8월 (확정치), 의류
TRADE = {"import_unit_usd_kg": {"2025-08": 26.07, "2026-08": 27.41, "2025-01~08": 24.43, "2026-01~08": 24.50},
         "import_usd_mn_2026_1_8": 8384.4, "import_growth_1_8": 0.034}
# 섬유패션산업 주요 경기지표 2026년 7월: 의복 판매액·의복 제조 재고 (전년 같은 기간 대비)
INDICATORS = {"apparel_retail_yoy_1_7": 0.092, "apparel_retail_yoy_7": 0.039, "apparel_inventory_yoy_1_7": -0.073}


def main() -> None:
    rows = list(csv.DictReader(CSV.open(encoding="utf-8-sig")))
    ex = {r["period_label"]: float(r["value"]) for r in rows if r["metric"] == "exchange"}
    mats: dict[str, dict[str, float]] = {}
    for r in rows:
        if r["metric"] == "materials":
            mats.setdefault(r["series"], {})[r["period_label"]] = float(r["value"])
    avg = lambda ks: st.mean(ex[k] for k in ks)  # noqa: E731
    ex25 = avg([f"2025-{m:02d}" for m in range(1, 9)])
    ex26 = avg([f"2026-{m:02d}" for m in range(1, 9)])
    usd = TRADE["import_unit_usd_kg"]["2026-01~08"] / TRADE["import_unit_usd_kg"]["2025-01~08"]
    usd_aug = TRADE["import_unit_usd_kg"]["2026-08"] / TRADE["import_unit_usd_kg"]["2025-08"]
    krw_yoy = usd * ex26 / ex25 - 1
    krw_aug = usd_aug * ex["2026-08"] / ex["2025-08"] - 1
    # 원단 원료 원화 시세 지수 (2020년 평균 = 100), 세 원료를 같은 비중으로
    months = sorted(set.intersection(*(set(v) for v in mats.values())) & set(ex))
    base = {s: st.mean(v[m] * ex[m] for m in months if m.startswith("2020")) for s, v in mats.items()}
    mat_idx = {m: round(st.mean(v[m] * ex[m] / base[s] * 100 for s, v in mats.items()), 1) for m in months}
    no_shoes = KOFOTI["total"] - KOFOTI["by_category"]["신발"]
    out = {
        "_meta": {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "method": "pipelines/build_fashion_market.py",
                  "sources": {"kofoti": "산업통상부·한국섬유산업연합회 2026년 SS시즌 상반기 패션 소비 현황 (S105)",
                              "trade": "2026년 8월 섬유류 품목별 수출입실적 확정치 (S106)",
                              "indicators": "섬유패션산업 주요 경기지표 2026년 7월 (S107)",
                              "global": "섬유패션 글로벌 통계 월별 CSV: 환율·원면·에틸렌글리콜·카프로락탐 (S108)"}},
        "acc_share": round((KOFOTI["by_category"]["가방/지갑"] + KOFOTI["by_category"]["기타잡화"]) / no_shoes, 3),
        "online_share": KOFOTI["online_share"],
        "spa_casual_share": round((KOFOTI["casual_brand_top"]["유니클로"] + KOFOTI["casual_brand_top"]["탑텐"] + KOFOTI["casual_brand_top"]["자라"]) / 100, 3),
        "fall_outlook": KOFOTI["fall_outlook"],
        "import_cost": {"usd_yoy_1_8": round(usd - 1, 3), "krw_yoy_1_8": round(krw_yoy, 3), "krw_yoy_aug": round(krw_aug, 3),
                        "fx_2025_1_8": round(ex25, 1), "fx_2026_1_8": round(ex26, 1)},
        "indicators": INDICATORS,
        "materials_krw_index": mat_idx,
        "kofoti": KOFOTI, "trade": TRADE,
    }
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    print("잡화 비중", out["acc_share"], "| 수입 의류 원화 단가 1년 새", out["import_cost"], "| 원료 지수 최근", list(mat_idx.items())[-3:])


if __name__ == "__main__":
    main()
