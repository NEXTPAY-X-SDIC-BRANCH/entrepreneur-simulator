"""lab:standing — 상위 몇 %와 놓친 것 (sim/standing.py). 작은 가짜 기준 판으로 계산 규칙만 본다 (엔진 기준 판 전체를 만들지 않는다)."""
from __future__ import annotations

import pytest

from sim import standing as SD


def _rows(ind: str, totals: list[int], lv: dict) -> list[dict]:
    return [{"gu": "마포구", "capital_man": 6000, "levers": dict(lv), "total": t, "cum_op": 0, "closed": False} for t in totals]


def test_my_levers_reads_hard_and_easy_names():
    hard = {"industry": "bbq", "inputs": {"gu": "마포구", "capital": 60_000_000, "meat_price": 21000, "staff_per_shift": 1, "pyeong": 20}}
    ind, cap, lv = SD.my_levers(hard)
    assert (ind, cap) == ("bbq", 6000) and lv["price"] == 21000 and lv["staff"] == 1 and lv["pyeong"] == 20
    assert lv["close_hour"] == 24 and lv["delivery"] == "none"   # 화면이 안 보낸 값은 엔진 기본값
    easy = {"industry": "cafe", "inputs": {"gu": "마포구", "capital_man": 4000, "pyeong": 14, "staff": 1}}
    ind, cap, lv = SD.my_levers(easy)
    assert (ind, cap, lv["pyeong"], lv["dessert"]) == ("cafe", 4000, 14, True)


def test_percentile_and_histogram(monkeypatch):
    lv = {"pyeong": 20, "staff": 2, "price": 19000, "close_hour": 24, "marketing_budget": 0, "meat_grade": "domestic", "banchan": 5, "delivery": "none"}
    rows = _rows("bbq", list(range(0, 100, 5)), lv) + [{**_rows("bbq", [50], lv)[0], "capital_man": 20000}]   # 다른 돈 구간 1판은 빠진다
    monkeypatch.setattr(SD, "_BASE", {"rows": {"bbq": rows, "cafe": []}})
    monkeypatch.setattr(SD, "score", lambda s: {"total": 72})
    out = SD.standing({"industry": "bbq", "inputs": {"capital_man": 6000, **lv}, "months": [{}]})
    assert out["n"] == 20 and sum(out["hist"]) == 20
    assert out["top_pct"] == round(100 * (5 + 1) / 21)   # 75~95점 5판이 위
    assert out["missed"] == []   # 구를 안 보냈으면 다시 돌리지 않는다


def test_missed_ranks_by_rerun_gain(monkeypatch):
    mine = {"pyeong": 20, "staff": 3, "price": 17000, "close_hour": 24, "marketing_budget": 0, "meat_grade": "domestic", "banchan": 5, "delivery": "none"}
    top = {**mine, "staff": 1, "price": 20000, "banchan": 3}
    rows = _rows("bbq", [95] * 3, top) + _rows("bbq", [40] * 27, mine)
    monkeypatch.setattr(SD, "_BASE", {"rows": {"bbq": rows, "cafe": []}})
    gain = {"staff": (6, 2_000_000), "price": (9, 4_000_000), "banchan": (-1, -300_000)}

    def fake_run(ind, gu, cap, lv, seed=None):
        diff = [k for k in gain if lv[k] != mine[k]]
        d = gain[diff[0]] if diff else (0, 0)
        return {"months": [{"op": d[1]}], "_score": 50 + d[0]}
    monkeypatch.setattr(SD, "run_case", fake_run)
    monkeypatch.setattr(SD, "score", lambda s: {"total": s.get("_score", 50)})
    out = SD.standing({"industry": "bbq", "inputs": {"gu": "마포구", "capital_man": 6000, **mine}, "months": [{}]})
    assert [m["key"] for m in out["missed"]] == ["price", "staff"]   # 나빠지는 반찬은 빼고 점수가 더 오르는 것부터
    assert out["missed"][0]["mine"] == "17,000원" and out["missed"][0]["top"] == "20,000원" and out["missed"][0]["d_op_krw"] == 4_000_000


def test_unsupported_industry():
    with pytest.raises(ValueError):
        SD.standing({"industry": "pub", "inputs": {}, "months": [{}]})


def test_noisy_gain_is_dropped(monkeypatch):
    # 시드에 따라 좋아졌다 나빠졌다 하는 항목(5번 중 3번만 나아짐)은 평균이 플러스여도 놓친 것에 넣지 않는다
    mine = {"pyeong": 20, "staff": 2, "price": 19000, "close_hour": 24, "marketing_budget": 0, "meat_grade": "domestic", "banchan": 5, "delivery": "none"}
    top = {**mine, "banchan": 3, "meat_grade": "aged"}
    rows = _rows("bbq", [95] * 3, top) + _rows("bbq", [40] * 27, mine)
    monkeypatch.setattr(SD, "_BASE", {"rows": {"bbq": rows, "cafe": []}})
    noisy = dict(zip(SD.SEEDS, [5_000_000, 3_000_000, 1_000_000, -500_000, -600_000]))

    def fake_run(ind, gu, cap, lv, seed=None):
        op = noisy[seed] if lv["banchan"] != mine["banchan"] else 2_000_000 if lv["meat_grade"] != mine["meat_grade"] else 0
        return {"months": [{"op": op}], "_score": 50 + op // 1_000_000}
    monkeypatch.setattr(SD, "run_case", fake_run)
    monkeypatch.setattr(SD, "score", lambda s: {"total": s.get("_score", 50)})
    out = SD.standing({"industry": "bbq", "inputs": {"gu": "마포구", "capital_man": 6000, **mine}, "months": [{}]})
    assert [m["key"] for m in out["missed"]] == ["meat_grade"]
    assert out["missed"][0]["wins"] == 5 and out["missed"][0]["runs"] == len(SD.SEEDS)
