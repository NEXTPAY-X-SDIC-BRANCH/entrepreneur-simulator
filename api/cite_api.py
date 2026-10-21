"""출처 검색 API (목업 챗봇용). 실행: python -m uvicorn api.cite_api:app --port 8000

ontology/sources.csv 에서 공신력 있는 출처만 골라 질문과 가장 가까운 것을 돌려준다.
- 포함: 논문(paper), 공공데이터(public_data), 공공기관 보고서(report)
- 제외: 뉴스(news), 블로그(blog), 내부 문서(internal), 익명·미검증 표시가 있는 행
답변 문장은 모델이 만들지 않고, 출처 메모(reliability_note)를 그대로 옮긴다.
"""
from __future__ import annotations

import csv
import math
import re
from collections import Counter
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "ontology" / "sources.csv"
CREDIBLE_TYPES = {"paper", "public_data", "report"}
# 뉴스는 원자료를 만든 기관이 제목·발행처·메모에 명시된 경우만 쓴다 (예: "참가격", "국세청 2023").
PRIMARY_AGENCIES = (
    "참가격", "축산물품질평가원", "KAMIS", "국세청", "한국은행", "식약처", "식품의약품안전처", "KREI", "농촌경제연구원",
    "한국부동산원", "농림축산식품부", "중소벤처기업부", "국가데이터처", "통계청", "소상공인시장진흥공단",
    "금융위원회", "기상청", "서울특별시",
)
NEWS_EXCLUDE = ("anecdotal", "opinion", "vendor", "snippet", "scope unclear")  # 사례, 의견, 업체 추정, 검색 조각, 범위 불명
EXCLUDE_PREFIXES = ("UNVERIFIED",)              # whole source flagged by the research team
EXCLUDE_MARKERS = (                                 # only a summary, snippet or preprint was read, not the checked original
    "anonymous", "search snippet", "search summary", "not the paper", "preprint", "not opened",
)

app = FastAPI(title="출처 검색 (목업 챗봇)")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _load() -> list[dict]:
    rows = []
    with CSV.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            note = r.get("reliability_note", "") or ""
            if r.get("type") not in CREDIBLE_TYPES:
                if r.get("type") != "news":
                    continue
                named = " ".join([r["title"], r.get("publisher_author", ""), note])
                if not any(a in named for a in PRIMARY_AGENCIES):
                    continue
                if any(m in note.lower() for m in NEWS_EXCLUDE):
                    continue
            if note.upper().startswith(EXCLUDE_PREFIXES) or any(m in note.lower() for m in EXCLUDE_MARKERS):
                continue
            rows.append({
                "id": r["source_id"],
                "title": r["title"],
                "publisher": r.get("publisher_author", ""),
                "year": r.get("year", "") or "",
                "url": r.get("url", ""),
                "type": r["type"],
                "note": note,
            })
    return rows


SOURCES = _load()
TYPE_LABEL = {"paper": "논문", "public_data": "공공데이터", "report": "공공기관 보고서", "news": "언론 보도 (원자료 기관 명시)"}


def _grams(text: str) -> set[str]:
    t = re.sub(r"[^0-9A-Za-z가-힣]+", "", text.lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _score(q: set[str], s: dict) -> float:
    """Share of the question's two-character pieces that appear in the source's title, publisher or note."""
    doc = _grams(" ".join([s["title"], s["publisher"], s["note"]]))
    if not q or not doc:
        return 0.0
    overlap = len(q & doc)
    return overlap / len(q) if overlap >= 2 else 0.0


@app.get("/cite")
def cite(q: str = Query(..., min_length=1, max_length=300), k: int = Query(3, ge=1, le=5)):
    qg = _grams(q)
    ranked = sorted(((_score(qg, s), s) for s in SOURCES), key=lambda x: -x[0])
    hits = [s for sc, s in ranked if sc >= 0.15][:k]
    cites = [{
        "id": s["id"], "title": s["title"], "publisher": s["publisher"], "year": s["year"],
        "type": TYPE_LABEL[s["type"]], "url": s["url"], "note": s["note"],
    } for s in hits]
    if not cites:
        answer = "목업에서 쓰는 공신력 있는 출처 중에는 이 질문에 맞는 자료가 없어요. 출처 장부에서 전체 목록을 볼 수 있어요."
    else:
        answer = "공신력 있는 출처에서 찾은 내용이에요. 아래 자료 메모를 그대로 옮긴 것이라 숫자의 맥락은 원자료로 확인해 주세요."
    return {"answer": answer, "citations": cites, "credible_count": len(SOURCES)}


@app.get("/health")
def health():
    return {"ok": True, "credible_sources": len(SOURCES)}


# ---- 근거 항목 기반 답변 (pipelines/build_facts.py 가 만든 facts.json) ----
FACTS_PATH = ROOT / "web" / "public" / "mock" / "facts.json"


def _facts() -> dict:
    import json
    return json.loads(FACTS_PATH.read_text(encoding="utf-8"))


STOP = {"얼마예", "알려줘", "알려", "얼마", "얼마나", "몇", "어떻게", "있어요", "인가요", "예요", "이에요", "해줘", "좀", "그리고", "은", "는", "이", "가", "을", "를", "의", "에", "도", "요"}


def _query_tokens(q: str) -> list[str]:
    """질문을 낱말로 나누고 조사(가·는·을 등)를 떼어 낸다. 예: '돼지고기 소매가' -> ['돼지고기', '소매']."""
    out = []
    for t in re.findall(r"[0-9A-Za-z가-힣]+", q):
        if t in STOP or len(t) < 2:
            continue
        if len(t) > 2 and t[-1] in "가이은는을를의에도요":
            t = t[:-1]
        if len(t) >= 2 and t not in STOP:
            out.append(t)
    return out


def _vec(text: str) -> Counter:
    return Counter(_grams(text))


# 질문에 자주 쓰는 말을 근거 문장에 실제로 쓰이는 말로 넓힌다. 예: "동향"을 물으면 "추이", "올랐"이 있는 문장을 찾는다.
SYNONYMS = {
    "동향": ["추이", "추세", "올랐", "내렸", "변화"],
    "추세": ["추이", "동향", "변화"],
    "가격": ["원/kg", "원/100g", "경락가격", "도매가", "소비자가격"],
    "최근": ["9월", "8월", "2026"],
    "어때": ["추이", "올랐", "내렸"],
    # 소비자가(소매)와 도매가를 구분한다. 태그 이름에 맞춰 연결한다.
    "소비자": ["소비자가격", "소매"], "소비자가": ["소비자가격", "소매"], "소매가": ["소비자가격", "소매"], "소매": ["소비자가격"],
    "도매가": ["도매", "식육포장"], "도매": ["식육포장"],
}


def _rank_facts(q: str, facts: list[dict]) -> list[tuple[float, dict]]:
    """질문과 근거 항목의 문자 2-gram TF-IDF 코사인 유사도(0~1). 태그는 두 번 넣어 가중치를 준다."""
    docs = [_vec(" ".join(f.get("tags", [])) * 1 + " " + " ".join(f.get("tags", [])) + " " + f["text"]) for f in facts]
    df: Counter = Counter()
    for d in docs:
        df.update(d.keys())
    n = len(docs)
    idf = {g: math.log((n + 1) / (c + 1)) + 1 for g, c in df.items()}

    def weigh(v: Counter) -> dict[str, float]:
        w = {g: c * idf.get(g, math.log(n + 1) + 1) for g, c in v.items()}
        norm = math.sqrt(sum(x * x for x in w.values())) or 1.0
        return {g: x / norm for g, x in w.items()}

    # 자료 어디에도 없는 2-gram(예: '원가', '구입')은 질문 벡터에서 뺀다. 남겨 두면 유사도가 떨어진다.
    toks = _query_tokens(q)
    expanded = toks + [w for t in toks for w in SYNONYMS.get(t, [])]
    qgrams = Counter({g: c for g, c in _vec(" ".join(expanded) or q).items() if g in df})
    qv = weigh(qgrams)
    out = []
    for f, d in zip(facts, docs):
        dv = weigh(d)
        sim = sum(x * dv.get(g, 0.0) for g, x in qv.items())
        # 질문 낱말이 태그와 정확히 같으면 가산점 (예: '도매'는 도매 항목을 먼저 올린다).
        sim += 0.15 * sum(1 for t in expanded if t in f.get("tags", []))
        # 질문에 '수입'이 없으면 수입 돼지고기 항목은 국내산 질문의 답으로 보지 않는다.
        if "수입" not in q and "수입" in f.get("tags", []):
            sim *= 0.8
        out.append((sim, f))
    out.sort(key=lambda x: -x[0])
    return out


# 근거만으로는 답을 정할 수 없는 질문은 항목을 붙이지 않고, 필요한 정보를 되물어 본다.
# (키워드, 되물을 문장). 질문에 숫자가 이미 있으면 되묻지 않는다.
CLARIFY = [
    (re.compile(r"구입 ?비용|원가|예산|재료비|고기 ?값.*(잡|계획)"),
     "돼지고기 구입 비용은 한 달에 쓰는 양을 알아야 계산할 수 있어요. 한 달에 돼지고기를 몇 kg 정도 쓰시나요? 메뉴(삼겹살·목살 등)를 같이 알려 주시면 더 정확하게 계산해 드릴게요."),
]


@app.get("/ask")
def ask(q: str = Query(..., min_length=1, max_length=300), k: int = Query(3, ge=1, le=6)):
    data = _facts()
    if not re.search(r"\d", q):
        for pat, ask_back in CLARIFY:
            if pat.search(q):
                return {"answer": None, "facts": [], "citations": [], "message": ask_back}
    ranked = _rank_facts(q, data["facts"])
    # 유사도 0.15 미만은 무관한 것으로 보고 버린다. 최고 유사도의 70% 아래도 뺀다.
    top = ranked[0][0] if ranked else 0.0
    if top < 0.15:
        return {"answer": None, "facts": [], "citations": [],
                "message": "등록된 근거 자료에 없는 질문이에요. 화면의 숫자에 대한 질문이나 상권·상가·날씨·공휴일·축산물 가격에 대한 질문을 해 주세요."}
    hits, seen_text = [], set()
    for sim, f in ranked:
        if sim < max(0.15, 0.7 * top) or f["text"] in seen_text:
            continue
        seen_text.add(f["text"])
        hits.append((sim, f))
        if len(hits) == k:
            break
    used_ids: list[str] = []
    facts_out = []
    for sim, f in hits:
        for sid in f["sources"]:
            if sid not in used_ids:
                used_ids.append(sid)
        facts_out.append({"text": f["text"], "source_ids": f["sources"], "similarity": round(sim, 3)})
    citations = []
    for sid in used_ids:
        src = data["sources"][sid]
        citations.append({"id": sid, "title": src["title"], "publisher": src["publisher"], "year": src["period"],
                          "type": "공공 API", "url": src["url"], "note": f"호출 식별자: {src['api']}"})
    # 항목이 둘 이상이면 불릿으로 나눠 보여 준다.
    answer = facts_out[0]["text"] if len(facts_out) == 1 else "\n".join(f"• {f['text']}" for f in facts_out)
    return {"answer": answer, "facts": facts_out, "citations": citations}


# ---- ChangeUp 확장 (api/ask_ext.py): 우리 근거 합치기, 주제 필터, 화면 값(ctx)으로 즉석 문장, POST /ask ----
from api import ask_ext  # noqa: E402

ask_ext.install(app)
