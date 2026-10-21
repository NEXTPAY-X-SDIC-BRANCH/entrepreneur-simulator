"""챗봇 근거 문장(추가분): 이번에 넣은 데이터를 문장으로 만든다 -> web/public/mock/facts_extra.json

    python -m pipelines.build_facts_extra

입력 (이미 만든 파일): food_cost.json, cost_index.json, quickfood_krei.json, gu_stats.json(chicken·bunsik),
fashion_market.json, ftc_interior.json. 숫자가 있는 문장은 모두 여기서 만든다 (build_facts.py와 같은 규칙).
문장 id 접두사: food_ (식재료 시세), costidx_ (고깃집 달별 원가), chicken_ / bunsik_ (업종), fashion_ (옷가게 시장),
ftc_ (가맹 인테리어), apparel_stock_ (재고 논문)
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "facts_extra.json"

SOURCES = {
    "kosis_cpi_seoul": {"publisher": "국가데이터처 (KOSIS)", "title": "생활물가지수 품목별 (서울특별시, 2020=100)", "api": "KOSIS DT_1J22005",
                        "url": "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_1J22005", "period": "2021년 1월~최신"},
    "kamis_retail": {"publisher": "한국농수산식품유통공사 (KAMIS)", "title": "기간별 품목별 소매가격 (서울)", "api": "KAMIS periodProductList",
                     "url": "https://www.kamis.or.kr", "period": "최근 1년"},
    "kamis_wholesale_veg": {"publisher": "한국농수산식품유통공사 (KAMIS)", "title": "월별 도·소매가격 (서울 중도매인 판매가)", "api": "KAMIS monthlySalesList",
                            "url": "https://www.kamis.or.kr", "period": "2020~2026년"},
    "krei_survey": {"publisher": "농림축산식품부·한국농촌경제연구원", "title": "외식업체 경영실태조사 2025 (2024년 실적, 전국)", "api": "KOSIS orgId 114 DT_114054_*",
                    "url": "https://kosis.kr", "period": "2025년 조사"},
    "seoul_sales": {"publisher": "서울특별시 / 서울신용보증재단", "title": "상권분석서비스 추정매출·점포 (치킨전문점 CS100007, 분식전문점 CS100008)",
                    "api": "OA-15572, OA-15577", "url": "https://data.seoul.go.kr", "period": "2025년 1~4분기"},
    "kofoti_survey": {"publisher": "산업통상부·한국섬유산업연합회", "title": "2026년 SS시즌(3~8월) 패션 소비 실태조사", "api": "보고서 (fashionnet.or.kr)",
                      "url": "https://www.fashionnet.or.kr", "period": "2026년 3~8월"},
    "kofoti_trade": {"publisher": "한국섬유산업연합회", "title": "2026년 8월 섬유류 품목별 수출입실적 (확정치)", "api": "보고서",
                     "url": "https://www.kofoti.or.kr", "period": "2026년 1~8월"},
    "kofoti_indicators": {"publisher": "한국섬유산업연합회", "title": "섬유패션산업 주요 경기지표 (2026년 7월)", "api": "보고서",
                          "url": "https://www.kofoti.or.kr", "period": "2026년 1~7월"},
    "ftc_interior": {"publisher": "공정거래위원회", "title": "가맹정보 브랜드 가맹점 인테리어 비용 (2024 정보공개서)", "api": "data.go.kr 15125479",
                     "url": "https://www.data.go.kr/data/15125479/openapi.do", "period": "2024년"},
    "jang2001": {"publisher": "장은영 (복식 51(2))", "title": "국내 의류업체의 재고처리 및 재고감축실태 연구 (의류 브랜드 92곳)", "api": "논문",
                 "url": "https://www.koreascience.kr", "period": "2000년 조사"},
}


def load(name: str) -> dict:
    p = MOCK / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def pct(x: float) -> str:
    return f"{'+' if x >= 0 else '−'}{abs(x) * 100:.1f}%"


def man(v: float) -> str:
    v = round(v)
    return f"{v // 10000}억 {v % 10000:,}만원" if v >= 10000 else f"{v:,}만원"


def build() -> list[dict]:
    facts: list[dict] = []
    add = lambda fid, tags, text, src: facts.append({"id": fid, "tags": tags, "text": text, "sources": src})  # noqa: E731

    # 식재료 시세
    for k, v in (load("food_cost.json").get("items") or {}).items():
        lab = {"coffee": "커피(원두)", "egg": "달걀(계란)"}.get(k, v["label"])
        mi = v["month_index"]
        hi, lo = max(mi, key=mi.get), min(mi, key=mi.get)
        text = (f"서울 {lab} 소비자 물가는 최근 12개월 평균이 2024년보다 {pct(v['level_vs_2024'] - 1)}이고, 1년 전 같은 달보다 {pct(v['yoy'] or 0)}예요. "
                f"한 해 중 {hi}월이 가장 비싸고(평균의 {mi[hi]:.2f}배) {lo}월이 가장 싸요({mi[lo]:.2f}배, 2021~2025년 평균).")
        src = ["kosis_cpi_seoul"]
        if v.get("kamis"):
            text += f" 지금 서울 소매가는 {v['kamis']['unit']}에 {v['kamis']['latest_krw']:,}원쯤이에요."
            src.append("kamis_retail")
        add(f"food_{k}", [lab, "식재료", "원가", "가격", "시세", "물가"], text, src)

    # 고깃집 달별 원가 (10월 = 1)
    ci = load("cost_index.json")
    if ci:
        p, vg = ci["pork"], ci["veg"]
        add("costidx_pork", ["돼지고기", "삼겹", "시세", "원가", "계절", "고깃집"],
            f"서울 돼지고기 값은 지난 {len(p['seasons'])}시즌 모두 10월부터 3월까지 싸졌어요. 10월을 1로 놓으면 11월 {p['index']['11']}, 1월 {p['index']['1']}, 3월 {p['index']['3']}배예요. "
            f"고깃집 시뮬레이션은 이 평균을 그달 고기 원가에 곱해요.", ["kosis_cpi_seoul"])
        add("costidx_veg", ["상추", "깻잎", "쌈채소", "채소", "시세", "원가", "고깃집"],
            f"서울 쌈채소·양념 채소(상추·깻잎·풋고추·양파·대파) 도매가는 10월을 1로 놓으면 11월 {vg['index']['11']}, 12월 {vg['index']['12']}, 2월 {vg['index']['2']}배예요. "
            f"해마다 차이가 커서 가장 싼 해와 비싼 해의 2월 값이 {vg['low']['2']}~{vg['high']['2']}배로 벌어져요.", ["kamis_wholesale_veg"])

    # 치킨·분식: 경영실태조사
    q = load("quickfood_krei.json")
    for ind, name, word in (("chicken", "치킨집", "치킨"), ("bunsik", "분식집", "분식")):
        v = q.get(ind)
        if not v:
            continue
        orders = v["visit_per_day"] + v["delivery_per_day"] + v["takeout_per_day"]
        add(f"{ind}_survey", [name, word, "매출", "영업이익률", "객단가", "배달", "경영"],
            f"전국 {name}({v['name']})은 한 달에 평균 {man(v['sales_month_man'])}을 팔고 영업이익률은 {v['op_margin'] * 100:.1f}%예요(사장 인건비를 뺀 뒤). "
            f"객단가는 {round(v['ticket_krw']):,}원, 하루 방문 {v['visit_per_day']}명·배달 {v['delivery_per_day']}인분·포장 {v['takeout_per_day']}인분으로 주문의 {v['delivery_per_day'] / orders * 100:.0f}%가 배달이에요.",
            ["krei_survey"])
        deliv_orders = v["delivery_per_day"] * v["open_days"]
        add(f"{ind}_delivery_fee", [name, word, "배달", "수수료", "배달앱", "배달대행"],
            f"{name}은 배달앱에 한 달 평균 {round(v['delivery_app_fee_month_krw'] / 1e4):,}만원, 배달대행에 {round(v['delivery_agency_fee_month_krw'] / 1e4):,}만원을 내요(이용하는 가게 평균). "
            f"배달 한 건으로 나누면 배달앱 {round(v['delivery_app_fee_month_krw'] / deliv_orders):,}원, 배달대행 {round(v['delivery_agency_fee_month_krw'] / deliv_orders):,}원이에요.",
            ["krei_survey"])
        add(f"{ind}_cost", [name, word, "원가", "식재료", "인건비", "인테리어", "면적"],
            f"{name}의 식재료비와 인건비(사장 포함)를 합치면 매출의 {v['food_labor_ratio'] * 100:.1f}%예요. 평균 {v['area_m2']:.0f}㎡({v['area_m2'] / 3.3058:.0f}평)에 "
            f"일하는 사람은 {v['workers']}명, 개업 인테리어는 평균 {man(v['interior_total_man'])}이 들었어요.", ["krei_survey"])
    g = load("gu_stats.json")
    for ind, name in (("chicken", "치킨전문점"), ("bunsik", "분식전문점")):
        blk = g.get(ind)
        if not blk:
            continue
        s = blk["seoul"]
        add(f"{ind}_seoul", [name, "서울", "매출", "가게 수", "폐업"],
            f"서울 상권 안 {name}은 {s['stores']:,}곳이고, 한 곳당 카드 매출은 한 달 {s['sales_per_store_month']:,}만원, 1년 폐업률은 {s['closure_rate'] * 100:.1f}%예요. "
            f"카드 추정이라 배달앱 결제는 거의 빠진 값이에요.", ["seoul_sales"])
        for gu, r in blk["gu"].items():
            add(f"{ind}_gu_{gu}", [gu, name, "매출", "가게 수", "폐업"],
                f"{gu} {name}은 상권 안에 {r['stores']:,}곳, 한 곳당 카드 매출이 한 달 {r['sales_per_store_month']:,}만원(서울 평균의 {r['demand_index']}배), 1년 폐업률 {r['closure_rate'] * 100:.1f}%예요.",
                ["seoul_sales"])

    # 옷가게 시장
    fm = load("fashion_market.json")
    if fm:
        ic = fm["import_cost"]
        add("fashion_import", ["의류", "옷가게", "수입", "원가", "환율", "도매가"],
            f"2026년 1~8월 의류 수입 단가는 달러로 1년 전보다 {pct(ic['usd_yoy_1_8'])}인데, 같은 기간 원/달러가 {ic['fx_2025_1_8']:,.0f}원에서 {ic['fx_2026_1_8']:,.0f}원으로 올라 원화로는 {pct(ic['krw_yoy_1_8'])}예요(8월만 보면 {pct(ic['krw_yoy_aug'])}).",
            ["kofoti_trade"])
        fo = fm["fall_outlook"]
        add("fashion_consumer", ["의류", "옷가게", "패션", "온라인", "소비", "전망"],
            f"2026년 3~8월 패션 구매의 {fm['online_share'] * 100:.1f}%가 온라인이었고, 캐주얼 옷 구매의 {fm['spa_casual_share'] * 100:.0f}%가 유니클로·탑텐·자라였어요. "
            f"올가을 의복 소비 전망 지수는 {fo['index_apparel']}(100이 보합)로, 줄이겠다는 사람이 {fo['decrease']}%, 늘리겠다는 사람이 {fo['increase']}%예요.", ["kofoti_survey"])
        ind_ = fm["indicators"]
        add("fashion_market", ["의류", "옷가게", "판매", "재고", "경기"],
            f"2026년 1~7월 의복 판매액은 1년 전보다 {pct(ind_['apparel_retail_yoy_1_7'])} 늘었고, 의복 제조업 재고는 {pct(ind_['apparel_inventory_yoy_1_7'])}예요.", ["kofoti_indicators"])
        add("fashion_acc", ["의류", "옷가게", "잡화", "가방", "품목"],
            f"패션 구매 중 신발을 빼면 가방·지갑·잡화가 {fm['acc_share'] * 100:.1f}%예요. 옷가게 시뮬레이션은 이 비중으로 잡화 재고를 들여요.", ["kofoti_survey"])

    # 재고 논문
    add("apparel_stock_paper", ["의류", "옷가게", "재고", "세일", "할인", "재고율"],
        "의류 브랜드 92곳 조사에서 정가로 판 비율은 44.9%, 30% 세일 21.4%, 50% 세일 12.9%였고 시즌마다 28.8%가 재고로 남았어요. "
        "보통 1~2개월 정가로 판 뒤 20~30% 할인하고, 시즌을 넘기면 값이 30% 넘게 떨어져요. 사입(수주)은 위탁보다 30~40% 싸게 들여와요.", ["jang2001"])

    # 가맹 인테리어
    ftc = load("ftc_interior.json").get("summary") or {}
    names = {"cafe": "카페", "bbq": "고깃집", "apparel": "옷가게"}
    for k, v in ftc.items():
        add(f"ftc_interior_{k}", [names.get(k, k), "인테리어", "가맹", "프랜차이즈", "평당", "창업 비용"],
            f"가맹점 {names.get(k, k)}의 평당 인테리어 비용은 브랜드 {v['n']}개 중앙값 {v['median'] / 1e4:,.0f}만원이에요(4곳 중 1곳은 {v['p25'] / 1e4:,.0f}만원 아래, 4곳 중 1곳은 {v['p75'] / 1e4:,.0f}만원 위). "
            "정보공개서 값이라 개인 가게는 이보다 싼 경우가 많아요.", ["ftc_interior"])
    return facts


def main() -> None:
    facts = build()
    OUT.write_bytes(json.dumps({"sources": SOURCES, "facts": facts}, ensure_ascii=False, indent=1).encode("utf-8"))
    by: dict[str, int] = {}
    for f in facts:
        by[f["id"].split("_")[0]] = by.get(f["id"].split("_")[0], 0) + 1
    print(f"facts_extra.json: {len(facts)}개", by)


if __name__ == "__main__":
    main()
