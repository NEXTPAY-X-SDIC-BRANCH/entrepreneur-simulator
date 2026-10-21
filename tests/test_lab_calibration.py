"""lab:integrate 보정 검사 (census): 아무것도 안 고친 이지 기본 판이 '창업 적격'이면 엔진이나 점수 기준이 어긋난 것이다.

2026-10-22: 새 업종은 매출 기준점이 업종 평균(큰 가게에 끌려 올라감) × 평균끼리 서울 배율 1.217이었고, 점수는 사장님 몫이 든 이익률을
업계 이익률(대표자 인건비를 뺀 뒤)과 견줬다. 그래서 치킨집 마포구 이지 기본이 96점 적격, 4개 업종이 구 다섯 곳 중 넷에서 적격이었다.
화면은 멀쩡해 보여서 숫자로만 잡히는 결함이라, 기본 판의 점수 구간을 테스트로 묶어 둔다.
"""
import pytest

from sim import easy as E
from sim import score as SC

GUS = ["마포구", "강남구", "노원구", "종로구"]


def _summary(ind: str, gu: str) -> dict:
    """web/src/lab/modes/summary.ts genericSummary와 같은 변환: 감가상각을 운영비(mgmt)에 넣어 매출 − 비용 = 영업이익."""
    inp = E.easy_inputs(ind, gu, 12000, start_month=11)
    run = E.run_generic(inp["run"])
    ss = run["report"]["season_summary"]
    months = [{**m, "mgmt": m["mgmt"] + raw["cash"]["depreciation_addback_krw"]} for m, raw in zip(ss["months"], run["months"])]
    return {**ss, "months": months, "mode": "easy", "attempt": 1}


@pytest.mark.parametrize("ind", E.GENERIC)
@pytest.mark.parametrize("gu", GUS)
def test_easy_default_is_never_fit(ind, gu):
    out = SC.score(_summary(ind, gu))
    assert out["band"] != "fit", (ind, gu, out["total"])


@pytest.mark.parametrize("ind", E.GENERIC)
def test_new_industry_profit_is_compared_after_owner_pay(ind):
    b = SC.bench_for(ind)
    assert b["owner_wage_in_op"] is False and b["owner_wage_month"] > 1_000_000
    assert 0.05 < b["margin"] < 0.12   # 경영실태조사 업종 영업이익률 (대표자·가족 인건비를 뺀 뒤)
    out = SC.score(_summary(ind, "마포구"))
    profit = next(p for p in out["parts"] if p["key"] == "profit")
    assert "사장님 몫을 비용에 넣지 않아서" in profit["why"]
