"""챗봇 /ask 평가 세트(tests/ask_eval/questions.yaml)를 pytest로 돈다. 질문 하나가 테스트 하나다."""
import pytest

from tests.ask_eval import run as ev

CASES = ev.load()["questions"]


@pytest.fixture(scope="module")
def results():
    return {r["id"]: r for r in ev.run()}


@pytest.mark.parametrize("spec", CASES, ids=[c["id"] for c in CASES])
def test_question(results, spec):
    r = results[spec["id"]]
    assert r["ok"], f"{r['q']} -> {r['why']} | {r['answer']}"
