"""업종 파라미터 research/industries/<id>.yaml 생성.  python -m pipelines.build_industry_params  (lab:industry)

research/industries/krei.json (pipelines/build_industry_krei.py, 경영실태조사 2025 원자료 가중 요약)에서 엔진이 쓰는 값만 골라
값마다 {value, grade, source, note}를 붙여 쓴다. 사건(events.yaml)과 공통 값(common.yaml)은 손으로 고친다.
등급: H 공식 원자료·통계 그대로, L 공식 원자료에서 우리가 계산한 값, 가정 출처 없음 (research/industries/README.md).
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from sim.generic.registry import INDUSTRIES

REPO = Path(__file__).resolve().parents[1]
DIR = REPO / "research" / "industries"
SRC = "농식품부·농경연 「2025 외식업체 경영실태 조사」 원자료 (2024년 실적, 전국, 가중치 WT)"
HEAD = """# {name} ({id}) 엔진 파라미터. 생성 파일: python -m pipelines.build_industry_params (손으로 고치지 말 것)
# 값은 research/industries/krei.json ({label}, 표본 {n}곳, 서울 {n_seoul}곳, 프랜차이즈 {fr:.0%})에서 옮겼다.
# 등급 H = 원자료 가중 평균·분위수 그대로 (통계보고서 표와 같은 값), L = 원자료로 우리가 계산한 값.
"""


def ent(value, grade: str, source: str, note: str | None = None) -> dict:
    d = {"value": value, "grade": grade, "source": source}
    if note:
        d["note"] = note
    return d


def build_one(ind: str, g: dict) -> dict:
    v, pl, sh, dv = g["values"], g["pl_mean_man"], g["pl_share"], g["derived"]
    lab = g["label"]
    s = f"{SRC} {lab}"
    ch = {k: v[f"{k}_pct"]["mean"] for k in ("hall", "delivery", "takeout")}
    tot = sum(ch.values())
    dshare = dv["delivery_cost_share"]["value"]
    area = v["area_pyeong"]["p50"]
    per = lambda key, q: round(v[key][q] / area, 1)  # noqa: E731  만원/평
    return {
        "id": ind, "name_ko": INDUSTRIES[ind]["name"], "krei_group": ind,
        "demand": {
            "annual_sales_mean_man": ent(pl["sales"], "H", f"{s}, 연 매출액 가중 평균 (만원, 통계보고서 표 95와 같은 값)",
                                         f"수요 기준점 (카페 엔진처럼 업종 평균). 면적 평균 {v['area_pyeong']['mean']}평과 짝을 지어, 평수가 다르면 면적 탄력성으로 옮김. "
                                         f"중앙값 {v['sales']['p50']:,}만원, 4분의 1~4분의 3: {v['sales']['p25']:,}~{v['sales']['p75']:,}만원"),
            "area_pyeong_mean": ent(v["area_pyeong"]["mean"], "H", f"{s}, 사업장 신고 면적 가중 평균 (평)"),
            "annual_sales_p50_man": ent(v["sales"]["p50"], "H", f"{s}, 연 매출액 중앙값 (만원)"),
            "annual_sales_p25_man": ent(v["sales"]["p25"], "H", f"{s}, 연 매출액 25% 분위"),
            "annual_sales_p75_man": ent(v["sales"]["p75"], "H", f"{s}, 연 매출액 75% 분위"),
            "ticket_krw": ent(round(v["ticket"]["mean"]), "H", f"{s}, 평균 객단가 (1인)"),
            "area_pyeong_p50": ent(area, "H", f"{s}, 사업장 신고 면적 중앙값 (평)"),
            "area_elasticity": ent(dv["area_elasticity"]["value"], "L", f"{s}, log(매출)~log(면적) 가중 회귀 기울기 (n={dv['area_elasticity']['n']})",
                                   "면적이 1% 크면 매출이 몇 % 큰가. 단면 관계이고 인과가 아님"),
            "channel_share": ent({k: round(x / tot, 3) for k, x in ch.items()}, "H", f"{s}, 총 매출액 대비 판매유형별 비중 (홀 / 배달 / 테이크아웃) 평균"),
            "weekend_share": ent(round(v["weekend_pct"]["mean"] / 100, 3), "H", f"{s}, 요일별 매출 비중 주말(금~일) 평균"),
            "days_month": ent(v["days_month"]["p50"], "H", f"{s}, 한 달 영업일수 중앙값"),
            "hours": ent([int(v["open_hour"]["p50"]), int(v["close_hour"]["p50"])], "H", f"{s}, 영업 시작·종료 시각 중앙값",
                         "24 이상은 다음 날 새벽 (예: 26 = 새벽 2시)"),
            "seat_turn_max": ent(dv["seat_turn"]["p90"], "L", f"{s}, 하루 방문 고객 ÷ 좌석 수의 90% 분위 (n={dv['seat_turn']['n']})",
                                 f"좌석 한 개가 하루에 받을 수 있는 손님의 상한으로 씀. 중앙값 {dv['seat_turn']['p50']}"),
            "orders_per_worker_max": ent(dv["orders_per_worker"]["p90"], "L",
                                         f"{s}, 하루 (방문 + 배달 + 포장 인분) ÷ 근로자 수(대표자 포함)의 90% 분위 (n={dv['orders_per_worker']['n']})",
                                         f"한 사람이 하루에 감당하는 인분의 상한. 중앙값 {dv['orders_per_worker']['p50']}"),
            "seats_per_pyeong": ent(round(v["seats"]["p50"] / area, 2), "L", f"{s}, 좌석 수 중앙값 {v['seats']['p50']:.0f} ÷ 면적 중앙값 {area:.0f}평"),
            "seats_per_table": ent(round(v["seats"]["p50"] / v["tables"]["p50"], 1), "L", f"{s}, 좌석 수 중앙값 ÷ 테이블 수 중앙값 {v['tables']['p50']:.0f}"),
        },
        "cost": {
            "food_share": ent(sh["food"], "H", f"{s}, 식재료비 ÷ 매출액 (평균 금액끼리, 통계보고서 표 97 ÷ 표 95와 같은 방식)"),
            "tax_share": ent(sh["tax"], "H", f"{s}, 세금과 공과 ÷ 매출액", "공과금(전기·가스·수도)이 들어 있다고 보고 따로 더하지 않음"),
            "other_share": ent(round(max(0.01, sh["other"] - dshare), 4), "L",
                               f"{s}, 기타비용 ÷ 매출액 {sh['other']:.4f}에서 배달 비용 몫 {dshare:.4f}를 뺀 값",
                               "기타비용(홍보비·수수료·소모품)에 배달 대행·배달앱 비용이 들어 있어 배달을 따로 계산할 때 두 번 세지 않게 뺌"),
            "delivery_cost_of_delivery_revenue": ent(round(dshare / max(0.001, ch["delivery"] / 100), 3), "L",
                                                     f"{s}, (배달 대행 + 배달앱 월 비용) × 12 ÷ 매출액 {dshare:.4f}를 배달 매출 비중 {ch['delivery'] / 100:.3f}으로 나눈 값",
                                                     f"배달 매출 1원당 나가는 배달 비용. 대행 1건당 {dv['delivery_cost_per_order_krw']['value']:,}원"),
            "pay_per_staff_month_krw": ent(round(dv["pay_per_hired_month_man"]["value"] * 1e4 * 10320 / 9860), "L",
                                           f"{s}, 고용인 인건비 합 ÷ 유급 고용인 수 합 ÷ 12 = {dv['pay_per_hired_month_man']['value']}만원 (2024년)",
                                           "최저임금 2024년 9,860원 → 2026년 10,320원 (고용노동부 고시, H) 비율 1.047을 곱함. 상용·임시·일용이 섞인 평균 1명"),
            "default_staff": ent(max(0, int(round(v["workers"]["p50"])) - 1), "L", f"{s}, 근로자 수 중앙값 {v['workers']['p50']:.0f}명 (대표자 포함)에서 사장님을 뺀 수"),
            "owner_pay_month_krw": ent(round(pl["labor_owner"] / 12 * 1e4), "H", f"{s}, 대표자 인건비 연 {pl['labor_owner']:,}만원 ÷ 12",
                                       "영업이익에 넣지 않고 '사장님 몫 (참고)'로만 보임 (카페 엔진과 같음)"),
            "op_share_survey": ent(sh["profit"], "H", f"{s}, 영업이익 ÷ 매출액 (대표자·가족 인건비를 뺀 뒤)"),
            "owner_family_share_survey": ent(round(sh["labor_owner"] + sh["labor_family"], 4), "H", f"{s}, (대표자 + 가족 종사자 인건비) ÷ 매출액"),
            "rent_share_survey": ent(sh["rent"], "H", f"{s}, 임차료 ÷ 매출액 (비교용, 엔진은 R-ONE 월세를 씀)"),
        },
        "capex": {
            "interior_per_pyeong_man": ent({"basic": per("invest_interior", "p25"), "mid": per("invest_interior", "p50"), "high": per("invest_interior", "p75")}, "L",
                                           f"{s}, 개업 투자 중 인테리어 25·50·75% 분위 ÷ 면적 중앙값 {area:.0f}평 (응답 {v['invest_interior']['n']}곳)"),
            "kitchen_per_pyeong_man": ent({"basic": per("invest_kitchen", "p25"), "mid": per("invest_kitchen", "p50"), "high": per("invest_kitchen", "p75")}, "L",
                                          f"{s}, 개업 투자 중 주방 25·50·75% 분위 ÷ 면적 중앙값 (응답 {v['invest_kitchen']['n']}곳)"),
            "hall_per_pyeong_man": ent({"basic": per("invest_hall", "p25"), "mid": per("invest_hall", "p50"), "high": per("invest_hall", "p75")}, "L",
                                       f"{s}, 개업 투자 중 홀 25·50·75% 분위 ÷ 면적 중앙값 (응답 {v['invest_hall']['n']}곳)"),
            "invest_p50_man": ent(v["invest"]["p50"], "H", f"{s}, 개업 시 투자 비용 중앙값 (보증금·권리금 제외)"),
            "key_money_p50_man": ent(v["key_money"]["p50"], "H", f"{s}, 권리금을 낸 곳의 중앙값 (응답 {v['key_money']['n']}곳)"),
        },
    }


def main() -> None:
    k = json.loads((DIR / "krei.json").read_text(encoding="utf-8"))
    for ind in INDUSTRIES:
        g = k["groups"][ind]
        doc = build_one(ind, g)
        head = HEAD.format(name=INDUSTRIES[ind]["name"], id=ind, label=g["label"], n=g["n"], n_seoul=g["n_seoul"], fr=g["franchise_share"])
        text = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=None, width=200)
        (DIR / f"{ind}.yaml").write_text(head + text, encoding="utf-8")
        print(f"{ind}.yaml")


if __name__ == "__main__":
    main()
