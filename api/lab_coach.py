"""AI 진단 (lab:score). 성적표의 숫자만 보고 근본 원인 2~3개와 다음 판에 할 일을 쓴다.

    POST /coach {summary, llm?: true}  ->  {source: "llm"|"rule", causes: [{id, title, evidence, why}],
                                          next: [{id, lever, text, expected, how}], total, band, version}

순서: 로컬 Ollama qwen3.6:35b (http://127.0.0.1:11434) → 규칙 문장. 유료 API는 쓰지 않는다.
- 프롬프트에는 sim.score.facts가 만든 숫자와 이 파일이 만든 문장만 들어간다. 닉네임, 반 코드, inputs의 글자는 넣지 않는다
  (요청처럼 보이는 입력이 모델에 닿지 않게).
- 원인 제목·근거 숫자와 다음 판 레버는 규칙이 만든 후보다. 모델은 후보 id를 고르고 설명(why/how)만 쓴다.
- 모델 출력은 후보 id, 길이, 한글 여부, 금지 패턴, 숫자 근거(프롬프트에 있던 숫자만)를 검사하고, 하나라도 어긋나면 규칙 문장을 쓴다.
- 점수는 요청의 score를 믿지 않고 summary로 다시 계산한다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import urllib.request
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from sim.score import _r, facts as score_facts, man, pct, score as score_fn

router = APIRouter()

OLLAMA = os.environ.get("LAB_OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("LAB_COACH_MODEL", "qwen3.6:35b")
TIMEOUT = float(os.environ.get("LAB_COACH_TIMEOUT", "60"))
VERSION = "coach-v1"
_CACHE: dict[str, dict] = {}
log = logging.getLogger("uvicorn.error")

SCHEMA = {
    "type": "object",
    "properties": {
        "causes": {"type": "array", "minItems": 2, "maxItems": 3, "items": {
            "type": "object", "properties": {"id": {"type": "string"}, "why": {"type": "string"}}, "required": ["id", "why"]}},
        "next": {"type": "array", "minItems": 1, "maxItems": 3, "items": {
            "type": "object", "properties": {"id": {"type": "string"}, "how": {"type": "string"}}, "required": ["id", "how"]}},
    },
    "required": ["causes", "next"],
}
BANNED = re.compile(r"https?:|www\.|```|<|>|\{|\}|ignore|instruction|system|prompt|assistant|anthropic|claude|openai|"
                    r"무시|지시|프롬프트|비밀번호|계좌", re.I)
MULTIPLE = re.compile(r"(\d+(?:\.\d+)?|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*배(?![달치민정송려분경너])")   # 배수 주장은 검증할 수 없어 받지 않는다
HANGUL = re.compile(r"[가-힣]")
NUM = re.compile(r"\d+(?:[.,]\d+)*")


def _gap(r: float, b: float) -> str:
    d = _r(r * 100) - _r(b * 100)
    return f"{'+' if d >= 0 else '−'}{abs(d)}%p"


# ---------------------------------------------------------------- facts → prompt lines (numbers only)
def fact_lines(F: dict, sc: dict) -> list[str]:
    b = F["bench"]
    L = [
        f"업종: {'카페' if F['industry'] == 'cafe' else '고깃집' if F['industry'] == 'bbq' else '음식점'}",
        f"진행한 달: {F['months']}개월" + (" (중간에 폐업)" if F["closed"] else " (끝까지 영업)"),
        f"총점: {sc['total']}점 / 100점 ({sc['band_label']})",
        f"6개월 매출: {man(F['revenue'])}",
        f"6개월 영업이익률: {pct(F['margin'])} (업계 {pct(b['margin'])})",
        f"첫 두 달 이익률: {pct(F['margin_first2'])}, 마지막 두 달 이익률: {pct(F['margin_last2'])}",
        f"적자인 달: {F['loss_months']}개월",
        f"재료비 비율: {pct(F['cogs_ratio'])} (업계 {pct(b['cogs'])}, {_gap(F['cogs_ratio'], b['cogs'])})",
        f"직원·알바 인건비 비율 (사장 몫 제외): {pct(F['labor_ratio'])} (업계 고용인 인건비 {pct(b['labor'])}, {_gap(F['labor_ratio'], b['labor'])})",
        f"임차료 비율: {pct(F['rent_ratio'])} (업계 {pct(b['rent'])}, {_gap(F['rent_ratio'], b['rent'])})",
        f"가장 낮았던 현금: {man(F['min_cash'])}, 월 고정비: {man(F['fixed_month'])} (고정비의 {max(0.0, F['cash_months']):.1f}개월치)",
        f"자리나 일손이 모자라 들어오지 못하고 돌아간 손님: {pct(F['walk_share'])}",
        f"창업 자금 중 대출 비중: {pct(F['loan_share'])}",
    ]
    if F["rating_end"] is not None:
        L.append(f"마지막 평점: {F['rating_end']:.2f}점 (시작 4.00점)")
    L.append("부분 점수: " + ", ".join(f"{p['label']} {p['score']}/{p['max']}" for p in sc["parts"]))
    return L


# ---------------------------------------------------------------- candidate causes (deterministic) + teaching text
def candidates(F: dict, sc: dict) -> list[dict]:
    """근본 원인 후보. 제목·근거는 숫자에서 만든 고정 문장이고, why는 규칙 설명(모델이 실패할 때 그대로 쓴다)."""
    b = F["bench"]
    parts = {p["key"]: p for p in sc["parts"]}
    lost = lambda k: parts[k]["max"] - parts[k]["score"]  # noqa: E731
    cafe = F["industry"] == "cafe"
    out: list[dict] = []
    add = lambda id_, w, title, evidence, why: out.append({"id": id_, "w": w, "title": title, "evidence": evidence, "why": why})  # noqa: E731
    if F["closed"]:
        reason = {"cash": "현금이 두 달 연속 바닥났어요", "revenue": "매출이 평소의 60% 아래로 두 달 이어졌어요"}.get(F["closed_reason"] or "", "가게를 닫았어요")
        add("closed", 100, f"{F['months']}개월째 폐업: {reason}",
            f"가장 낮았던 현금 {man(F['min_cash'])}, 적자인 달 {F['loss_months']}개월",
            "폐업은 한 달의 적자보다 적자를 버틸 현금이 먼저 떨어져서 생겨요. 적자 폭과 남은 현금을 함께 봐야 해요.")
    if F["labor_ratio"] - b["labor"] > 0.02:
        add("labor", (F["labor_ratio"] - b["labor"]) * 100, "손님 수에 비해 일손과 영업시간이 많아요",
            f"직원·알바 인건비가 매출의 {pct(F['labor_ratio'])}로 업계 고용인 인건비 {pct(b['labor'])}보다 커요",
            ("인건비는 손님이 적은 시간에도 그대로 나가요. 손님이 몰리는 시간에 맞춰 직원 운영과 영업시간을 정해야 해요." if cafe else
             "인건비는 손님이 적은 날에도 그대로 나가요. 교대 인원과 마감 시간을 실제 손님 수에 맞춰야 해요."))
    if F["rent_ratio"] - b["rent"] > 0.02:
        add("rent", (F["rent_ratio"] - b["rent"]) * 100, "매장 크기와 월세에 비해 매출이 작아요",
            f"임차료가 매출의 {pct(F['rent_ratio'])}로 업계 {pct(b['rent'])}보다 커요",
            "월세는 문을 연 순간부터 매달 고정으로 나가요. 이 동네에서 낼 수 있는 매출을 먼저 보고 평수와 자리를 골라야 해요.")
    if F["cogs_ratio"] - b["cogs"] > 0.02:
        add("cogs", (F["cogs_ratio"] - b["cogs"]) * 100, "가격에 비해 원가가 높아요",
            f"재료비가 매출의 {pct(F['cogs_ratio'])}로 업계 {pct(b['cogs'])}보다 커요",
            "재료비는 많이 팔수록 같이 늘어요. 한 그릇·한 잔에서 남는 돈이 적으면 손님이 늘어도 이익이 잘 안 늘어요.")
    if lost("cash") >= 5:
        add("cash", lost("cash") + 2, "문 열 때 남긴 운영자금이 적었어요",
            f"가장 낮을 때 현금 {man(F['min_cash'])}, 월 고정비 {man(F['fixed_month'])}",
            "처음 몇 달은 손님이 덜 쌓여 적자가 나기 쉬워요. 인테리어·보증금을 쓰고도 고정비 몇 달치를 남겨야 버틸 수 있어요.")
    if F["rating_end"] is not None and F["rating_end"] < 3.8:
        add("rating", (4.0 - F["rating_end"]) * 20, "가격과 품질에 비해 손님 만족이 낮아요",
            f"마지막 평점 {F['rating_end']:.2f}점 (시작 4.00점)",
            "평점이 떨어지면 다음 달 손님이 줄어요. 가격을 올리거나 품질을 낮춘 효과는 한두 달 뒤에 손님 수로 돌아와요.")
    if F["walk_share"] > 0.08:
        add("walk", F["walk_share"] * 100, "바쁜 시간에 손님을 다 받지 못했어요",
            f"자리나 일손이 모자라 돌아간 손님 {pct(F['walk_share'])}",
            "돌아간 손님은 이미 문 앞까지 온 매출이에요. 바쁜 시간대의 자리와 일손이 병목이에요.")
    if F["margin"] < b["margin"] and not out:
        add("demand", lost("profit") + 1, "비용은 업계 수준인데 손님이 부족해요",
            f"6개월 영업이익률 {pct(F['margin'])}, 업계 {pct(b['margin'])}",
            "비용 비율이 정상인데 이익이 작으면 매출 자체가 작은 거예요. 동네 수요와 가게 규모가 맞는지부터 봐야 해요.")
    if F["loan_share"] > 0.4:
        add("loan", F["loan_share"] * 10, "대출 비중이 커서 버틸 힘이 작아요",
            f"창업 자금 중 대출 {pct(F['loan_share'])}",
            "대출은 이자와 상환이 매달 나가서 적자인 달을 더 아프게 만들어요.")
    if len(out) < 2:   # 잘 된 판: 가장 약한 부분 두 개
        for p in sorted(sc["parts"], key=lambda p: p["score"] / p["max"]):
            if len(out) >= 2:
                break
            add(f"weak_{p['key']}", 0, f"{p['label']} {p['score']}/{p['max']}점이 가장 약해요",
                p["why"].split(". ")[0][:150], "가장 약한 부분 하나만 바꿔 다시 해 보면 무엇이 점수를 움직이는지 보여요.")
    out.sort(key=lambda x: -x["w"])
    return out[:5]


def _prompt(lines: list[str], cands: list[dict], fixes: list[dict]) -> list[dict]:
    sys_msg = ("너는 예비 창업자 교육 코치다. '시뮬레이션 결과'의 숫자만 근거로 쓴다. 목록에 없는 숫자, 제도, 프로그램 이름은 만들지 않는다. "
               "숫자는 목록에 적힌 그대로 쓰고 새로 계산하지 않는다. '배'라는 말(두 배, 3배)은 절대 쓰지 않고, 차이는 목록의 %p로 말한다. "
               "'원인 후보' 중 이 가게에 가장 중요한 2~3개를 id로 고르고, 각각 왜 그것이 근본 원인인지 한두 문장(존댓말, 120자 안)으로 설명한다. "
               "'다음 판 후보' 중 1~3개를 id로 고르고, 다음 판에 구체적으로 어떻게 바꿀지 한 문장(80자 안)으로 쓴다. "
               "출력은 JSON 하나: {\"causes\":[{\"id\",\"why\"}],\"next\":[{\"id\",\"how\"}]}.")
    user = ("시뮬레이션 결과\n" + "\n".join(f"- {x}" for x in lines)
            + "\n\n원인 후보\n" + "\n".join(f"- {c['id']}: {c['title']} ({c['evidence']})" for c in cands)
            + "\n\n다음 판 후보\n" + "\n".join(f"- {f['key']}: {f['text']} ({f['expected']})" for f in fixes))
    return [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- validation
def _nums(text: str) -> list[float]:
    out = []
    for t in NUM.findall(text):
        try:
            out.append(float(t.replace(",", "")))
        except ValueError:
            pass
    return out


def allowed_numbers(texts: list[str]) -> set[float]:
    ok = {float(x) for x in range(0, 7)} | {60.0, 90.0, 100.0}
    for ln in texts:
        ok.update(_nums(ln))
    return ok


def _grounded(x: float, ok: set[float]) -> bool:
    """작은 수(평점, 개월, 인원)는 그대로 같아야 하고, 큰 수(%·만원)는 반올림 차이(±0.5 또는 1%)만 허용한다."""
    if abs(x) < 10:
        return any(abs(x - a) <= 0.051 for a in ok)
    return any(abs(x - a) <= 0.51 or (a and abs(x - a) / abs(a) <= 0.01) for a in ok)


def _check_text(t: Any, lo: int, hi: int, ok: set[float]) -> str:
    if not isinstance(t, str):
        raise ValueError("문장 형식")
    t = " ".join(t.split())
    if not lo <= len(t) <= hi:
        raise ValueError(f"길이 {len(t)}")
    if not HANGUL.search(t):
        raise ValueError("한글 없음")
    if BANNED.search(t):
        raise ValueError("금지 패턴")
    if MULTIPLE.search(t):
        raise ValueError("배수 표현")
    bad = [x for x in _nums(t) if not _grounded(x, ok)]
    if bad:
        raise ValueError(f"근거 없는 숫자 {bad[:3]}")
    return t


def validate(out: Any, lines: list[str], cands: list[dict], fixes: list[dict]) -> dict:
    """모델 출력 검사: 후보 id만, 중복 없이, 길이·한글·금지 패턴·숫자 근거. 통과하면 화면용 dict, 아니면 ValueError."""
    if not isinstance(out, dict):
        raise ValueError("JSON 객체가 아님")
    causes, nxt = out.get("causes"), out.get("next")
    if not isinstance(causes, list) or not 2 <= len(causes) <= 3:
        raise ValueError("causes 개수")
    if not isinstance(nxt, list) or not 1 <= len(nxt) <= 3:
        raise ValueError("next 개수")
    by_c = {c["id"]: c for c in cands}
    by_f = {f["key"]: f for f in fixes}
    ok = allowed_numbers(lines + [c["title"] + " " + c["evidence"] for c in cands] + [f["text"] + " " + f["expected"] for f in fixes])
    # 후보에 없는 id나 중복은 버린다 (모델이 원인 id를 다음 판 칸에 쓰는 일이 있다). 남은 항목의 문장은 하나라도 어긋나면 전체 거절.
    res_c, res_n, seen = [], [], set()
    for c in causes:
        if not isinstance(c, dict) or c.get("id") not in by_c or c["id"] in seen:
            continue
        seen.add(c["id"])
        cd = by_c[c["id"]]
        res_c.append({"id": cd["id"], "title": cd["title"], "evidence": cd["evidence"], "why": _check_text(c.get("why"), 10, 160, ok)})
    if len(res_c) < min(2, len(cands)):
        raise ValueError("원인 id")
    seen = set()
    for n in nxt:
        if not isinstance(n, dict) or n.get("id") not in by_f or n["id"] in seen:
            continue
        seen.add(n["id"])
        fx = by_f[n["id"]]
        res_n.append({"id": fx["key"], "lever": fx["lever"], "text": fx["text"], "expected": fx["expected"],
                      "how": _check_text(n.get("how"), 6, 120, ok)})
    if fixes and not res_n:
        raise ValueError("다음 판 id")
    return {"causes": res_c, "next": res_n}


def rule_text(cands: list[dict], fixes: list[dict]) -> dict:
    return {"causes": [{k: c[k] for k in ("id", "title", "evidence", "why")} for c in cands[:3]],
            "next": [{"id": f["key"], "lever": f["lever"], "text": f["text"], "expected": f["expected"], "how": ""}
                     for f in fixes[:3]]}


# ---------------------------------------------------------------- LLM call
def _ollama(messages: list[dict]) -> dict:
    body = json.dumps({"model": MODEL, "stream": False, "think": False, "format": SCHEMA, "messages": messages,
                       "options": {"temperature": 0.2, "seed": 7, "num_predict": 700}}).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:   # noqa: S310 (local Ollama only)
        res = json.loads(r.read())
    return json.loads(res["message"]["content"])


def build(summary: dict) -> tuple[dict, list[str], list[dict], list[dict]]:
    sc = score_fn(summary)
    F = score_facts(summary)
    return sc, fact_lines(F, sc), candidates(F, sc), sc["fixes"]


def coach(summary: dict, *, llm: bool = True, call=None) -> dict:
    sc, lines, cands, fixes = build(summary)
    base = {"total": sc["total"], "band": sc["band"], "version": VERSION}
    rule = {**base, "source": "rule", **rule_text(cands, fixes)}
    if not llm:
        return rule
    msgs = _prompt(lines, cands, fixes)
    key = hashlib.sha256((json.dumps(msgs, ensure_ascii=False) + MODEL).encode()).hexdigest()
    if call is None and key in _CACHE:
        return _CACHE[key]
    raw: Any = None
    try:
        raw = (call or _ollama)(msgs)
        res = {**base, "source": "llm", "model": MODEL, **validate(raw, lines, cands, fixes)}
    except Exception as e:  # noqa: BLE001 — any failure (down, timeout, bad JSON, ungrounded) → rule text
        log.warning("coach fallback: %s: %s | raw=%s", type(e).__name__, str(e)[:120], json.dumps(raw, ensure_ascii=False)[:400])
        return {**rule, "fallback_reason": f"{type(e).__name__}: {str(e)[:120]}"}
    if call is None:
        _CACHE[key] = res
    return res


@router.post("/coach")
def coach_api(body: dict[str, Any] = Body(...)) -> dict:
    """body: {summary, llm?: bool (기본 true; false면 규칙 문장만 바로)}. 요청의 score는 쓰지 않고 다시 계산한다."""
    summary = body.get("summary")
    if not isinstance(summary, dict):
        raise HTTPException(422, "summary가 필요합니다")
    try:
        return coach(summary, llm=bool(body.get("llm", True)))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
