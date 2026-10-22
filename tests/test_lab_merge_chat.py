"""lab:merge 챗봇이 화면에서 고른 업종으로 답한다 (lab/apparel-3d 9d19028, 11ff4b4를 병합본에 옮긴 것)."""
from api import ask_ext as A


def ans(q, ctx):
    r = A.run(q, ctx)
    return r.get("answer") or r.get("message") or ""


def test_competition_sentence_uses_screen_industry():
    for ind, kind in (("cafe", "카페"), ("apparel", "옷가게"), ("chicken", "치킨집"), ("pub", "주점")):
        a = ans("이 동네 경쟁은 어때요?", {"gu": "마포구", "industry": ind, "kind": kind, "pork_gu": 321})
        assert kind in a and "돼지고기" not in a, (ind, a)
    a = ans("이 동네 경쟁은 어때요?", {"gu": "마포구", "pork_gu": 77})   # 업종을 안 보내는 옛 화면은 고깃집
    assert "돼지고기 구이·찜 가게" in a


def test_lab_industry_question_without_industry_word_uses_lab_facts():
    a = ans("매출은 어때요?", {"gu": "마포구", "industry": "chicken", "kind": "치킨집"})
    assert "치킨" in a and "한식음식점" not in a


def test_apparel_breakeven_counts_sales_and_owner_note():
    eng = {"start_month": 3, "closed": False, "finished": False, "cash_now": 1e7, "unit": "건", "owner_fixed": 3e6, "owner_note": "사장님 생활비 월 300만원 포함",
           "months": [{"month": 3, "revenue": 2e7, "cogs": 6e6, "fees": 1e6, "labor": 0, "rent": 3e6, "mgmt": 5e5, "covers": 300, "op": 9.5e6, "open_days": 30, "cash_end": 1e7}]}
    a = ans("하루에 몇 건 팔아야 본전이에요?", {"gu": "마포구", "industry": "apparel", "kind": "옷가게", "pyeong": 13, "staff": 0, "engine": eng})
    assert "건" in a and "사장님 생활비 월 300만원 포함" in a and "명이 와야" not in a
    # 고정비 (인건비 0 + 월세 3e6 + 운영비 5e5 + 사장님 몫 3e6) / 건당 남는 돈 ((2e7 - 6e6 - 1e6) / 300) = 150건/월
    assert "한 달 약 150건" in a


def test_shop_sentence_skips_tables_when_absent():
    facts = A.live_facts({"gu": "마포구", "industry": "apparel", "pyeong": 13, "staff": 1})
    shop = next(f for f in facts if f["id"] == "live_shop")
    assert "테이블" not in shop["text"] and "13평" in shop["text"]
