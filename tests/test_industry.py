"""새 업종 엔진 (lab:industry): 파라미터 출처, 경영실태조사 범위, 6개월 시즌, API."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.changeup import app
from sim.generic import model as gm
from sim.generic import params as gp
from sim.generic import season as gs
from sim.generic.registry import IDS

ROOT = Path(__file__).resolve().parents[1]
KREI = json.loads((ROOT / "research" / "industries" / "krei.json").read_text(encoding="utf-8"))["groups"]
client = TestClient(app)


def _avg_gu(ind: str) -> str:
    """서울 평균에 가장 가까운 구 (구 지수 ≈ 1)."""
    gd = gp.gu_data()[ind]
    return min(gd["gu"], key=lambda g: abs(gd["gu"][g]["sales_per_store_month"] / gd["seoul"]["sales_per_store_month"] - 1))


# ---------------------------------------------------------------------------------------------- 파라미터 출처

@pytest.mark.parametrize("ind", IDS)
def test_every_value_has_grade_and_source(ind):
    for sec in ("demand", "cost", "capex"):
        for k, e in gp.industry(ind)[sec].items():
            assert e["grade"] in ("H", "M", "L", "가정"), (ind, sec, k)
            assert e["source"], (ind, sec, k)
    for sec, block in gp.common().items():
        for k, e in block.items():
            assert e["grade"] in ("H", "M", "L", "가정") and e["source"], (sec, k)


@pytest.mark.parametrize("ind", IDS)
def test_yaml_matches_survey_extract(ind):
    g, d, c = KREI[ind], gp.industry(ind)["demand"], gp.industry(ind)["cost"]
    assert d["annual_sales_mean_man"]["value"] == g["pl_mean_man"]["sales"]
    assert d["annual_sales_p50_man"]["value"] == g["values"]["sales"]["p50"]
    assert d["ticket_krw"]["value"] == round(g["values"]["ticket"]["mean"])
    assert c["food_share"]["value"] == g["pl_share"]["food"]
    assert c["tax_share"]["value"] == g["pl_share"]["tax"]
    assert abs(sum(d["channel_share"]["value"].values()) - 1) < 0.01


def test_survey_extract_matches_published_table_95():
    """원자료 가중 평균이 통계보고서 표 95 매출액 평균과 같다 (build_industry_krei --pdf 검산 결과)."""
    checked = [k for k, g in KREI.items() if "pdf_check" in g]
    assert len(checked) >= 4 and all(KREI[k]["pdf_check"]["ok"] for k in checked)


# ---------------------------------------------------------------------------------------------- 경영실태조사 범위

@pytest.mark.parametrize("ind", IDS)
def test_settled_month_within_survey_ranges(ind):
    gu = _avg_gu(ind)
    p = gm.preview({"industry": ind, "gu": gu})
    rev = p["rough_month"]["revenue_krw"]
    lo = gp.iv(ind, "demand", "annual_sales_p25_man") * 1e4 / 12
    hi = gp.iv(ind, "demand", "annual_sales_p75_man") * 1e4 / 12 * gp.cv("demand", "seoul_uplift") * 1.3
    assert lo <= rev <= hi, (ind, rev, lo, hi)
    # 월세를 조사의 임차료 비중에 맞추면 감가상각 전 이익률(사장님 몫 빼기 전)이 조사의 영업이익 + 대표자·가족 인건비와 5%p 안
    rent = gp.iv(ind, "cost", "rent_share_survey") * rev / p["input"]["pyeong"] / 1e4
    q = gm.preview({"industry": ind, "gu": gu, "rent_man_per_pyeong": rent})
    r = q["rough_month"]
    dep = next(x["krw"] for x in r["lines"] if x["key"] == "depreciation")
    margin = (r["op_krw"] + dep) / r["revenue_krw"]
    target = gp.iv(ind, "cost", "op_share_survey") + gp.iv(ind, "cost", "owner_family_share_survey")
    # 베이커리는 고용인 수가 두 갈래(평균 2.31명, 중앙값 1명)라, 중앙값 가게(직원 1명)의 인건비 비중이 조사 평균 금액 비중(17%)보다 작다.
    # 직원 2명이면 반대로 6%p 낮아진다. 중앙값끼리 맞춘 기준점(2026-10-22)을 지키고 허용 폭만 넓힌다
    tol = 0.06 if ind == "bakery" else 0.05
    assert abs(margin - target) < tol, (ind, margin, target)


@pytest.mark.parametrize("ind", IDS)
def test_more_staff_never_serves_fewer(ind):
    gu = _avg_gu(ind)
    served = [gm.preview({"industry": ind, "gu": gu, "staff": n, "pyeong": 12})["rough_month"]["covers"] for n in range(0, 5)]
    assert served == sorted(served)


def test_delivery_off_moves_part_to_takeout():
    ctx = gm.context(gm.normalize({"industry": "chicken", "gu": "마포구"}))
    on = gm.evaluate(ctx, gm.factors(season=1.0))
    off = gm.evaluate(ctx, gm.factors(season=1.0, delivery=False))
    assert off["delivery_revenue"] == 0 and off["lines"]["delivery"] == 0
    assert off["takeout_units"] > on["takeout_units"] and off["revenue"] < on["revenue"]


# ---------------------------------------------------------------------------------------------- 6개월 시즌

@pytest.mark.parametrize("ind", IDS)
def test_six_month_season_runs_and_replays(ind):
    body = {"industry": ind, "gu": _avg_gu(ind), "seed": 11, "own_capital_krw": 100_000_000}
    run = gs.start(body)
    sent = []
    while not run["state"]["closed"] and len(run["months"]) < run["months_total"]:
        d = {"choice": gs.event_for(run, len(run["months"]))["options"][-1]["id"]}
        sent.append(d)
        run, mo = gs.play_month(run, d)
        assert mo["kpi"]["revenue_krw"] > 0 and abs(mo["kpi"]["op_krw"]) < mo["kpi"]["revenue_krw"] * 3
    assert len(run["months"]) == 6 or run["state"]["closed"]
    again = gs.replay(body, sent)
    assert [m["kpi"] for m in again["months"]] == [m["kpi"] for m in run["months"]]
    s = gs.report(run)["season_summary"]
    assert s["industry"] == ind and len(s["months"]) == len(run["months"])
    for line in s["months"]:
        assert {"month", "revenue", "op", "covers", "cogs", "labor", "rent", "mgmt", "fees", "cash_after"} <= set(line)
        assert line["revenue"] - (line["cogs"] + line["labor"] + line["rent"] + line["mgmt"] + line["fees"]) >= line["op"] - 1  # 감가상각만큼 차이


def test_events_do_not_repeat_back_to_back():
    for ind in IDS:
        for seed in range(5):
            run = gs.start({"industry": ind, "gu": "마포구", "seed": seed})
            ids = [gs.event_for(run, i)["id"] for i in range(6)]
            assert all(a != b for a, b in zip(ids, ids[1:])), (ind, seed, ids)


def test_cash_rule_closes_store():
    run = gs.start({"industry": "hansik", "gu": "관악구", "seed": 0, "own_capital_krw": 0, "extra_loan_krw": 0, "pyeong": 40,
                    "staff": 6, "rent_man_per_pyeong": 40})
    while not run["state"]["closed"] and len(run["months"]) < 6:
        run, _ = gs.play_month(run, {})
    assert run["state"]["closed"] and len(run["months"]) == 2


# ---------------------------------------------------------------------------------------------- API

def test_api_flow():
    lst = client.get("/lab/industry/list").json()["industries"]
    assert [x["id"] for x in lst] == list(IDS)
    assert client.post("/lab/industry/preview", json={"industry": "cafe", "gu": "마포구"}).status_code == 422
    assert client.post("/lab/industry/preview", json={"industry": "pub", "gu": "없는구"}).status_code == 422
    s = client.post("/lab/industry/season", json={"industry": "bunsik", "gu": "마포구", "seed": 2}).json()
    tok = s["state_token"]
    assert s["next_event"]["options"]
    first = client.post("/lab/industry/season/month", json={"state_token": tok, "month_index": 0, "choice": s["next_event"]["default"]}).json()
    again = client.post("/lab/industry/season/month", json={"state_token": tok, "month_index": 0, "choice": s["next_event"]["default"]}).json()
    assert first["kpi"] == again["kpi"]
    bad = client.post("/lab/industry/season/month", json={"state_token": tok, "choice": "nope"})
    assert bad.status_code == 400
    assert client.post("/lab/industry/season/month", json={"state_token": tok[:-3] + "AAA"}).status_code == 400
    tok = first["state_token"]
    for i in range(1, 6):
        tok = client.post("/lab/industry/season/month", json={"state_token": tok, "month_index": i}).json()["state_token"]
    assert client.post("/lab/industry/season/month", json={"state_token": tok}).status_code == 409
    rep = client.post("/lab/industry/season/report", json={"state_token": tok}).json()
    assert rep["months_played"] == 6 and rep["season_summary"]["industry"] == "bunsik"


def test_default_layout_fits_every_size():
    """기본 테이블 수면 10~40평 어디서나 3D 배치에 못 놓는 것(빨간 반투명)이 없다."""
    for ind in IDS:
        for py in range(10, 41, 3):
            p = gm.preview({"industry": ind, "gu": "마포구", "pyeong": py})
            assert p["room"] is not None and all(x["fits"] for x in p["layout"]), (ind, py)
            assert p["seats"]["total"] == sum(1 for x in p["layout"] if x["type"] == "chair")


# ---------------------------------------------------------------------------------------------- 결정의 방향 (돌연변이 테스트용)

def _ctx(ind: str = "hansik"):
    ctx = gm.context(gm.normalize({"industry": ind, "gu": _avg_gu(ind), "pyeong": 30, "tables": 14, "staff": 4}))
    ctx["dep_krw"] = 0
    return ctx


@pytest.mark.parametrize("ind", IDS)
def test_levers_move_the_right_way(ind):
    ctx = _ctx(ind)
    base = gm.evaluate(ctx, gm.factors(season=1.0))
    up = gm.evaluate(ctx, gm.factors(season=1.0, price=1.1))
    assert up["covers"] < base["covers"] and up["ticket"] > base["ticket"]               # 가격을 올리면 손님은 줄고 객단가는 는다
    low = gm.evaluate(ctx, gm.factors(season=1.0, rating=3.0))
    assert low["covers"] < base["covers"]                                                   # 별점이 낮으면 손님이 준다
    mk = gm.evaluate(ctx, gm.factors(season=1.0, marketing=1_000_000))
    assert mk["covers"] > base["covers"] and mk["lines"]["marketing"] == 1_000_000          # 마케팅은 손님을 늘리고 비용이 든다
    short = gm.evaluate(ctx, gm.factors(season=1.0, hours="short"))
    assert short["lines"]["labor"] < base["lines"]["labor"] and short["covers"] <= base["covers"]  # 짧게 열면 인건비와 손님이 준다
    rival = gm.evaluate(ctx, gm.factors(season=1.0, rival=0.93))
    assert rival["covers"] < base["covers"]


def test_walkaways_hurt_rating():
    run = gs.start({"industry": "bunsik", "gu": "강남구", "seed": 0, "staff": 0, "pyeong": 10, "tables": 1})
    run, mo = gs.play_month(run, {})
    assert mo["kpi"]["walkaway_share"] > 0.05 and mo["kpi"]["rating"] < 4.0


def test_invest_ref_matches_survey():
    """화면(industries.ts INVEST)의 개업 투자 분위수가 krei.json과 같다."""
    import re
    ts = (ROOT / "web" / "src" / "lab" / "industry" / "industries.ts").read_text(encoding="utf-8")
    for ind in IDS:
        m = re.search(ind + r": \{ p25: (\d+), p50: (\d+), p75: (\d+), n: (\d+)", ts)
        v = KREI[ind]["values"]["invest"]
        assert m and [int(x) for x in m.groups()] == [round(v["p25"]), round(v["p50"]), round(v["p75"]), v["n"]], ind


def test_month_retry_returns_same_month_and_token():
    s = client.post("/lab/industry/season", json={"industry": "pub", "gu": "마포구", "seed": 4}).json()
    a = client.post("/lab/industry/season/month", json={"state_token": s["state_token"], "month_index": 0}).json()
    b = client.post("/lab/industry/season/month", json={"state_token": a["state_token"], "month_index": 0}).json()
    assert a["kpi"] == b["kpi"] and a["state_token"] == b["state_token"]


def test_season_uses_chosen_loan_rate_and_extra_loan():
    # lab:merge 가게 꾸미기에서 고른 금리와 운전자금이 새 업종 시즌에 들어간다 (고깃집·카페와 같게). 안 보내면 예전 그대로
    base = {"industry": "hansik", "gu": "마포구", "seed": 3, "own_capital_krw": 50_000_000}
    a = client.post("/lab/industry/season", json=base).json()
    b = client.post("/lab/industry/season", json={**base, "loan_rate": 0.031, "extra_loan_krw": 0}).json()
    assert a["loan"]["rate"] != 0.031 and b["loan"]["rate"] == 0.031 and b["loan"]["rate_source"] == "가게 꾸미기에서 고른 금리"
    assert b["loan"]["extra_krw"] == 0 and b["loan"]["principal_krw"] == a["capex"]["loan_needed_krw"]
    assert b["loan"]["monthly_payment_krw"] < a["loan"]["monthly_payment_krw"]   # 운전자금을 안 빌리고 금리도 낮으니 덜 갚는다
    assert client.post("/lab/industry/season", json={**base, "loan_rate": 0.5}).status_code == 422
