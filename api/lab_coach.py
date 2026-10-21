"""AI 진단 (lab:score). 성적표의 숫자만 보고 근본 원인 2~3개와 다음 판에 할 일을 쓴다.

    POST /coach {summary, llm?: true}  ->  {source: "llm"|"rule", causes: [{id, title, evidence, why}],
                                          next: [{id, lever, text, expected, how}], total, band, version}

순서: 로컬 Ollama qwen3.6:35b (http://127.0.0.1:11434) → 규칙 문장. 유료 API는 쓰지 않는다.
- 프롬프트에는 sim.score.facts가 만든 숫자와 이 파일이 만든 문장만 들어간다. 닉네임, 반 코드, inputs의 글자는 넣지 않는다
  (요청처럼 보이는 입력이 모델에 닿지 않게).
- 원인 제목·근거 숫자와 다음 판 레버는 규칙이 만든 후보다. 모델은 후보 id를 고르고 설명(why/how)만 쓴다.
- 모델 출력은 후보 id, 길이, 한글 여부, 금지 패턴, 숫자 근거(프롬프트에 있던 숫자만)를 검사하고, 하나라도 어긋나면 규칙 문장을 쓴다.
- 숫자 없는 주장도 본다 (claim_errors): "인건비가 높아요"·"월세가 낮아요"·"적자였어요"처럼 facts와 방향이 반대이거나,
  규칙 후보에 없는 비용 영역을 원인으로 대면 거절하고 규칙 문장을 쓴다.
- 점수는 요청의 score를 믿지 않고 summary로 다시 계산한다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import urllib.request
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from sim.score import _r, facts as score_facts, man, pct, score as score_fn

router = APIRouter()

OLLAMA = os.environ.get("LAB_OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("LAB_COACH_MODEL", "qwen3.6:35b")
TIMEOUT = float(os.environ.get("LAB_COACH_TIMEOUT", "60"))
VERSION = "coach-v2"   # v2: 방향·비교 주장 검사 (claim_errors)
_CACHE: dict[str, dict] = {}
_SEM = threading.Semaphore(1)   # 로컬 모델은 한 번에 하나. 같은 판의 중복 요청은 기다렸다가 캐시를 받는다
BUSY_WAIT = float(os.environ.get("LAB_COACH_BUSY_WAIT", "20"))
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
    adj = " (사장 인건비를 뺀 뒤)" if F["owner_wage_month"] else ""
    L = [
        f"업종: {'카페' if F['industry'] == 'cafe' else '고깃집' if F['industry'] == 'bbq' else '음식점'}",
        f"진행한 달: {F['months']}개월" + (" (중간에 폐업)" if F["closed"] else " (끝까지 영업)"),
        f"총점: {sc['total']}점 / 100점 ({sc['band_label']})",
        f"{F['months']}개월 매출: {man(F['revenue'])}",
        f"{F['months']}개월 영업이익률{adj}: {pct(F['margin'])} (업계 {pct(b['margin'])})",
        f"첫 두 달 이익률{adj}: {pct(F['margin_first2'])}, 마지막 두 달 이익률: {pct(F['margin_last2'])}",
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
    kind = F["industry"] if F["industry"] in ("bbq", "cafe") else "generic"
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
            {"cafe": "인건비는 손님이 적은 시간에도 그대로 나가요. 손님이 몰리는 시간에 맞춰 직원 운영과 영업시간을 정해야 해요.",
             "bbq": "인건비는 손님이 적은 날에도 그대로 나가요. 교대 인원과 마감 시간을 실제 손님 수에 맞춰야 해요."}.get(
                kind, "인건비는 손님이 적은 날에도 그대로 나가요. 직원 수와 영업시간을 실제 손님 수에 맞춰야 해요."))
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
            f"{F['months']}개월 영업이익률 {pct(F['margin'])}, 업계 {pct(b['margin'])}",
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


# ---------------------------------------------------------------- claim guard (숫자 없는 방향·비교 주장)
# 숫자 검사는 '37%' 같은 지어낸 수를 막지만, "인건비가 높아요"처럼 숫자 없이 사실과 반대로 말하는 문장은 못 막는다.
# 그래서 문장에서 주제어(재료비·인건비·월세…)를 찾고, 그 뒤 첫 방향어(높/많/크 ↔ 낮/적/작/부족, 늘/줄)를 facts의 실제 방향과
# 맞춰 본다. 확실히 어긋날 때만 거절한다 (가정문 '높으면', 부정 '높지 않아요', 추천 '낮은 자리로'는 주장으로 보지 않는다).
_TOPICS = {
    "cogs": r"재료비|원가|식자재", "labor": r"인건비", "staff": r"직원|알바|일손|인원|인력",
    "rent": r"임차료|임대료|월세", "other_cost": r"관리비|광고비|마케팅비|수수료|배달비",
    "customer": r"손님|고객|매출|방문객", "profit": r"영업이익률|이익률|영업이익|이익|마진",
    "cash": r"운영\s?자금|현금", "loan": r"대출", "rating": r"평점|별점|만족도|만족",
}
_TOPIC_RE = re.compile("|".join(f"(?P<{k}>{v})" for k, v in _TOPICS.items()))
_COMPARATOR = re.compile(r"(?:이나|와|과)?(?:\s*수)?\s*(?:에\s*비해|에\s*비하면|보다|대비)")   # "손님 수에 비해", "재료비보다": 비교 기준일 뿐
_STOP = re.compile(r"[.!?;](?!\d)|,(?!\d)|\n")
_UP_TREND = re.compile(r"늘었|늘어|증가|올랐|올라|상승|회복")
_DOWN_TREND = re.compile(r"줄었|줄어|감소|떨어|하락|빠졌")
_UP_LEVEL = re.compile(r"높(?![여이였])|많(?!이)|크(?!기)|커(?!피)|컸|비싸|과하|과다|넉넉|충분|좋")
_DOWN_LEVEL = re.compile(r"낮(?![추춰])|적(?![자정용절극])|작(?:아|은|고|다|게|았|지|네)|부족|모자|저렴|나빠|나쁘")
_NEG_AFTER = re.compile(r"^\S*\s*(?:않|아니|못|안\s)|^\S*(?:지않|진않|지못)")
_NEG_BEFORE = re.compile(r"(?:안|못|덜)\s*$")
_ADVICE_NOUN = re.compile(r"^\s*(?:곳|자리|매장|가게|동네|쪽|메뉴|시간대|상권)")
_LOSS_CLAIM = re.compile(r"적자(?:였|였어|예요|입니다|이에요|가\s*났|를\s*냈|를\s*봤|가\s*이어|가\s*계속|로\s*끝|로\s*돌|\s*상태|인\s*가게|가\s*심|가\s*컸|를\s*기록)")
_ALL_LOSS = re.compile(r"(?:매달|매월|계속|내내|모든\s*달|줄곧)\s*적자")
_PROFIT_CLAIM = re.compile(r"흑자(?:였|예요|입니다|이에요|를\s*냈|를\s*기록|로\s*끝|로\s*돌|를\s*유지)")
_CLOSED_CLAIM = re.compile(r"폐업(?:했|해서|하고|한\s*것|으로\s*끝|하게\s*됐|을\s*했)|문을\s*닫았")


def _direction(seg: str) -> str | None:
    """주제어 뒤 구간에서 첫 방향어 → 'up' | 'down' | None (방향 없음, 부정, 가정, 추천 수식)."""
    hits = []
    for rx, d, trend in ((_UP_TREND, "up", 1), (_DOWN_TREND, "down", 1), (_UP_LEVEL, "up", 0), (_DOWN_LEVEL, "down", 0)):
        m = rx.search(seg)
        if m:
            hits.append((m.start(), -trend, d, m))
    if not hits:
        return None
    trend_hits = [h for h in hits if h[1] == -1]
    _, neg_trend, d, m = min(trend_hits or hits)   # '많이 줄었어요'처럼 정도어가 앞서면 추세어를 따른다
    word_end = re.search(r"[\s.,!?]|$", seg[m.end():]).start() + m.end()
    word, rest = seg[m.start():word_end], seg[word_end:]
    if (word.endswith("면") and not word.endswith("면서")) or word.endswith(("수록", "라도", "다면", "어도", "아도", "해도")):
        return None   # 가정·양보: "월세가 높으면 …", "손님이 늘어도 …"
    if _NEG_AFTER.search(seg[m.end():][:12]) or _NEG_BEFORE.search(seg[:m.start()][-3:]):
        # "높지 않아요"는 낮다는 주장으로 본다. 추세 부정("안 늘었어요")은 '그대로'일 수 있어 주장으로 보지 않는다
        return None if neg_trend else ("down" if d == "up" else "up")
    if _ADVICE_NOUN.search(rest):
        return None   # "월세가 낮은 자리로 옮겨요"는 이 가게에 대한 주장이 아니다
    return d


def _segments(text: str):
    """(주제, 주제어 뒤 문장 구간). 비교 기준('…보다', '…에 비해')인 주제어는 건너뛰고 앞 주제에 붙인다."""
    ms = [m for m in _TOPIC_RE.finditer(text) if not _COMPARATOR.match(text, m.end())]
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        stop = _STOP.search(text, m.end(), end)
        yield m.lastgroup, text[m.end():stop.start() if stop else end]


def claim_errors(text: str, F: dict, cand_ids: set[str], *, topics: bool = True) -> list[str]:
    """문장 하나가 facts와 반대로 말하는 곳. 빈 리스트면 통과. topics=False면 판 전체 주장(적자·흑자·폐업)만 본다."""
    b, errs = F["bench"], []
    if F["loss_months"] == 0 and not F["closed"] and _LOSS_CLAIM.search(text):
        errs.append("적자가 없던 판을 적자라고 함")
    if 0 < F["months"] and F["loss_months"] < F["months"] and _ALL_LOSS.search(text):
        errs.append("흑자인 달이 있는데 계속 적자라고 함")
    if F["loss_months"] == F["months"] and _PROFIT_CLAIM.search(text):
        errs.append("모든 달이 적자인데 흑자라고 함")
    if not F["closed"] and _CLOSED_CLAIM.search(text):
        errs.append("폐업하지 않은 판을 폐업했다고 함")
    if not topics:
        return errs
    gap = {"cogs": F["cogs_ratio"] - b["cogs"], "labor": F["labor_ratio"] - b["labor"], "rent": F["rent_ratio"] - b["rent"]}
    for topic, seg in _segments(text):
        d = _direction(seg)
        if d is None:
            continue
        bad = False
        if topic in gap:
            # 높다: 규칙 후보이거나 업계보다 2%p 넘게 클 때만 (후보에 없는 비용 영역을 원인으로 대는 것도 여기서 막힌다)
            # 낮다: 업계보다 실제로 낮거나 같을 때만
            g = gap[topic]
            bad = (not (topic in cand_ids or g > 0.02 or ("weak_cost" in cand_ids and g > 0.005))) if d == "up" else g > 0.005
        elif topic == "staff":
            bad = d == "up" and not ("labor" in cand_ids or gap["labor"] > 0.02)   # 직원이 '모자라다'는 바쁜 시간 얘기일 수 있어 보지 않는다
        elif topic == "other_cost":
            bad = True   # facts에 없는 비용 영역
        elif topic == "customer":
            if _UP_TREND.search(seg) or _DOWN_TREND.search(seg):   # 손님 수준(많다·적다)은 상대적이라 추세만 본다
                bad = (d == "down" and F["covers_trend"] > 0.05) or (d == "up" and F["covers_trend"] < -0.05)
        elif topic == "profit":
            if _UP_TREND.search(seg) or _DOWN_TREND.search(seg):
                t = F["margin_last2"] - F["margin_first2"]
                bad = (d == "down" and t > 0.005) or (d == "up" and t < -0.005)
            else:
                bad = (d == "down" and F["margin"] > b["margin"] + 0.005) or (d == "up" and F["margin"] < b["margin"] - 0.005)
        elif topic == "cash":
            short = "cash" in cand_ids or F["closed"] or F["cash_months"] < 3
            bad = (d == "down" and not short) or (d == "up" and short)
        elif topic == "loan":
            bad = (d == "up" and F["loan_share"] < 0.3) or (d == "down" and F["loan_share"] > 0.4)
        elif topic == "rating":
            r = F["rating_end"]
            bad = r is None or (d == "down" and r >= 4.0) or (d == "up" and r < 3.8)
        if bad:
            errs.append(f"{topic} {d}: {seg.strip()[:30]}")
    return errs


def validate(out: Any, lines: list[str], cands: list[dict], fixes: list[dict], F: dict | None = None) -> dict:
    """모델 출력 검사: 후보 id만, 중복 없이, 길이·한글·금지 패턴·숫자 근거, 그리고 F가 있으면 방향·비교 주장(claim_errors).
    통과하면 화면용 dict, 아니면 ValueError."""
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
        why = _check_text(c.get("why"), 10, 160, ok)
        if F is not None and (errs := claim_errors(why, F, set(by_c))):
            raise ValueError(f"사실과 다른 주장 {errs[:2]}")
        res_c.append({"id": cd["id"], "title": cd["title"], "evidence": cd["evidence"], "why": why})
    if len(res_c) < min(2, len(cands)):
        raise ValueError("원인 id")
    seen = set()
    for n in nxt:
        if not isinstance(n, dict) or n.get("id") not in by_f or n["id"] in seen:
            continue
        seen.add(n["id"])
        fx = by_f[n["id"]]
        how = _check_text(n.get("how"), 6, 120, ok)
        # 다음 판 문장은 명령형("월세가 낮은 자리로")이라 주제 방향은 보지 않고, 판 전체 주장(적자·폐업)만 본다
        if F is not None and (errs := claim_errors(how, F, set(by_c), topics=False)):
            raise ValueError(f"사실과 다른 주장 {errs[:2]}")
        res_n.append({"id": fx["key"], "lever": fx["lever"], "text": fx["text"], "expected": fx["expected"], "how": how})
    # 다음 판 문장은 덧붙임일 뿐이라, 모델이 맞는 id를 하나도 못 골라도 원인 진단은 살린다 (레버는 규칙 것을 그대로 쓴다)
    # 모델이 고르지 않은 레버도 빠뜨리지 않는다: 규칙 순서대로 전부, 모델 문장은 고른 것에만
    how = {n["id"]: n["how"] for n in res_n}
    res_n = [{"id": f["key"], "lever": f["lever"], "text": f["text"], "expected": f["expected"], "how": how.get(f["key"], "")}
             for f in fixes[:3]]
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
    F = score_facts(summary)
    base = {"total": sc["total"], "band": sc["band"], "version": VERSION}
    rule = {**base, "source": "rule", **rule_text(cands, fixes)}
    if not llm:
        return rule
    msgs = _prompt(lines, cands, fixes)
    key = hashlib.sha256((json.dumps(msgs, ensure_ascii=False) + MODEL).encode()).hexdigest()
    if call is None and key in _CACHE:
        return _CACHE[key]
    if call is None and not _SEM.acquire(timeout=BUSY_WAIT):
        return {**rule, "fallback_reason": "busy: 다른 진단을 계산 중"}
    try:
        if call is None and key in _CACHE:
            return _CACHE[key]
        return _run(msgs, key, base, rule, lines, cands, fixes, call, F)
    finally:
        if call is None:
            _SEM.release()


def _run(msgs, key, base, rule, lines, cands, fixes, call, F=None) -> dict:
    raw: Any = None
    try:
        raw = (call or _ollama)(msgs)
        res = {**base, "source": "llm", "model": MODEL, **validate(raw, lines, cands, fixes, F)}
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
