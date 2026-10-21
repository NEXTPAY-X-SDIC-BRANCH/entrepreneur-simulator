"""성적표·클래스 랭킹 (lab:score). api/changeup.py가 include_router 한 줄로 붙인다.

    POST /score                 SeasonSummary → 점수 (sim.score)
    POST /score/submit          {nickname, class_code, summary} → 점수를 서버에서 다시 계산해 저장, 반 순위 돌려줌
    GET  /score/rank            ?class_code=&industry= → 반 랭킹 (사람마다 최고 점수, 같은 점수면 먼저 낸 사람)
    GET  /score/me              ?class_code=&nickname= → 내 기록 (회차별)
    GET  /score/admin           ?class_code= → 관리자 보기 (반 목록, 반별 학습자·시도·최고 점수)

시연용 예시 반: `python -m api.lab_score --seed-demo` 가 반 코드 DEMO 에 예시 기록(demo=1)을 넣는다. 예시 줄은 응답에
demo: true 로 표시되고 화면에 '예시' 꼬리표가 붙는다. 실제 제출(demo=0)과 섞여도 구분된다.

로그인은 모의: 닉네임 + 반 코드만. 비밀번호와 개인정보는 받지 않는다. 저장은 data/lab/scores.sqlite (gitignore).
점수는 요청에 실린 값을 믿지 않고 summary로 다시 계산한다.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

from sim.score import score as score_fn

router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]
_LOCK = threading.Lock()
CLASS_RE = re.compile(r"^[A-Z0-9-]{3,16}$")
MAX_MONTHS = 24


def db_path() -> Path:
    return Path(os.environ.get("LAB_SCORE_DB") or ROOT / "data" / "lab" / "scores.sqlite")


def _conn() -> sqlite3.Connection:
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(p)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_code TEXT NOT NULL, nickname TEXT NOT NULL, industry TEXT NOT NULL,
        mode TEXT NOT NULL, attempt INTEGER, total INTEGER NOT NULL, band TEXT NOT NULL, parts TEXT NOT NULL,
        created_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0)""")
    if "demo" not in {r[1] for r in c.execute("PRAGMA table_info(attempts)")}:   # 이전 파일 호환
        c.execute("ALTER TABLE attempts ADD COLUMN demo INTEGER NOT NULL DEFAULT 0")
    c.execute("CREATE INDEX IF NOT EXISTS attempts_class ON attempts(class_code, industry)")
    return c


# ---------------------------------------------------------------- input checks
def clean_nickname(x: Any) -> str:
    if not isinstance(x, str):
        raise HTTPException(422, "닉네임이 필요해요")
    s = unicodedata.normalize("NFC", "".join(ch for ch in x if unicodedata.category(ch)[0] != "C")).strip()
    s = " ".join(s.split())
    if not 1 <= len(s) <= 16:
        raise HTTPException(422, "닉네임은 1~16자예요")
    if re.search(r"[<>{}\\/@]", s) or re.search(r"\d{6,}", s):
        raise HTTPException(422, "닉네임에 쓸 수 없는 글자가 있어요 (이메일·전화번호 같은 개인정보는 넣지 마세요)")
    return s


def clean_class(x: Any) -> str:
    s = str(x or "").strip().upper()
    if not CLASS_RE.match(s):
        raise HTTPException(422, "반 코드는 영문·숫자·- 3~16자예요")
    return s


def clean_summary(x: Any) -> dict:
    if not isinstance(x, dict) or not isinstance(x.get("months"), list) or not x["months"]:
        raise HTTPException(422, "summary.months가 필요해요")
    if len(x["months"]) > MAX_MONTHS:
        raise HTTPException(422, f"months는 {MAX_MONTHS}개까지예요")
    return x


def _score(summary: dict) -> dict:
    try:
        return score_fn(summary)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


# ---------------------------------------------------------------- ranking
def ranking(c: sqlite3.Connection, class_code: str, industry: str | None) -> list[dict]:
    """사람(닉네임)마다 최고 점수 한 줄. 같은 최고 점수면 그 점수를 먼저 낸 사람이 위. 순위는 같은 점수면 같은 등수."""
    q = "SELECT * FROM attempts WHERE class_code = ?" + (" AND industry = ?" if industry else "") + " ORDER BY id"
    rows = c.execute(q, (class_code, industry) if industry else (class_code,)).fetchall()
    people: dict[str, dict] = {}
    for r in rows:
        p = people.setdefault(r["nickname"], {"nickname": r["nickname"], "best": -1, "best_id": 0, "attempts": 0,
                                              "last": 0, "first": None, "industry": r["industry"], "band": r["band"],
                                              "demo": bool(r["demo"])})
        p["attempts"] += 1
        p["last"] = r["total"]
        p["first"] = r["total"] if p["first"] is None else p["first"]
        if r["total"] > p["best"]:
            p.update(best=r["total"], best_id=r["id"], band=r["band"], industry=r["industry"], best_at=r["created_at"])
    out = sorted(people.values(), key=lambda p: (-p["best"], p["best_id"]))
    rank, prev = 0, None
    for i, p in enumerate(out):
        if p["best"] != prev:
            rank, prev = i + 1, p["best"]
        p["rank"] = rank
        p["gain"] = p["best"] - p["first"]
        p.pop("best_id")
    return out


# ---------------------------------------------------------------- routes
@router.post("/score")
def score_api(body: dict[str, Any] = Body(...)) -> dict:
    return _score(clean_summary(body))


@router.post("/score/submit")
def submit(body: dict[str, Any] = Body(...)) -> dict:
    nick, cls = clean_nickname(body.get("nickname")), clean_class(body.get("class_code"))
    summary = clean_summary(body.get("summary"))
    sc = _score(summary)
    industry = str(summary.get("industry") or "bbq")[:20]
    mode = str(summary.get("mode") or "free")[:10]
    att = summary.get("attempt")
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT INTO attempts (class_code, nickname, industry, mode, attempt, total, band, parts, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (cls, nick, industry, mode, int(att) if isinstance(att, (int, float)) else None, sc["total"], sc["band"],
             json.dumps({p["key"]: p["score"] for p in sc["parts"]}), datetime.now(timezone.utc).isoformat(timespec="seconds")))
        rank = ranking(c, cls, industry)
        n_mine = c.execute("SELECT COUNT(*) FROM attempts WHERE class_code=? AND nickname=? AND industry=?",
                           (cls, nick, industry)).fetchone()[0]
        _ = cur.lastrowid
    me = next(p for p in rank if p["nickname"] == nick)
    return {"score": sc, "me": {**me, "attempts": n_mine, "is_best": me["best"] == sc["total"]},
            "class_size": len(rank), "rank": rank[:20], "class_code": cls, "industry": industry}


@router.get("/score/rank")
def rank_api(class_code: str = Query(...), industry: str | None = Query(None)) -> dict:
    cls = clean_class(class_code)
    with _conn() as c:
        rows = ranking(c, cls, industry)
    return {"class_code": cls, "industry": industry, "class_size": len(rows), "rank": rows[:50]}


@router.get("/score/me")
def me_api(class_code: str = Query(...), nickname: str = Query(...), industry: str | None = Query(None)) -> dict:
    cls, nick = clean_class(class_code), clean_nickname(nickname)
    q = "SELECT attempt, industry, mode, total, band, parts, created_at FROM attempts WHERE class_code=? AND nickname=?"
    args: tuple = (cls, nick)
    if industry:
        q, args = q + " AND industry=?", args + (industry,)
    with _conn() as c:
        rows = [dict(r) | {"parts": json.loads(r["parts"])} for r in c.execute(q + " ORDER BY id", args)]
    return {"class_code": cls, "nickname": nick, "attempts": rows, "best": max((r["total"] for r in rows), default=None)}


@router.get("/score/admin")
def admin_api(class_code: str | None = Query(None)) -> dict:
    """관리자 보기 (모의, 읽기 전용). 닉네임과 점수만 있고 개인정보는 없다."""
    with _conn() as c:
        if not class_code:
            rows = c.execute("""SELECT class_code, COUNT(DISTINCT nickname) learners, COUNT(*) attempts, MAX(total) best,
                                 ROUND(AVG(total), 1) avg, MAX(created_at) last_at FROM attempts GROUP BY class_code
                                 ORDER BY last_at DESC""").fetchall()
            return {"classes": [dict(r) for r in rows]}
        cls = clean_class(class_code)
        rank = ranking(c, cls, None)
        bands = {b: sum(1 for p in rank if p["band"] == b) for b in ("fit", "train", "rethink")}
        weak = c.execute("SELECT parts FROM attempts WHERE class_code=?", (cls,)).fetchall()
    # 반 전체에서 가장 많이 잃은 부분 (가르칠 곳)
    maxes = {"profit": 25, "survival": 20, "cash": 15, "customer": 15, "cost": 15, "risk": 10}
    lost = {k: 0.0 for k in maxes}
    for r in weak:
        for k, v in json.loads(r["parts"]).items():
            if k in maxes:
                lost[k] += (maxes[k] - v) / maxes[k]
    n = max(1, len(weak))
    return {"class_code": cls, "learners": rank, "bands": bands,
            "weakest": sorted(({"key": k, "lost_share": round(v / n, 3)} for k, v in lost.items()), key=lambda x: -x["lost_share"])}


# ---------------------------------------------------------------- 시연용 예시 반
DEMO_CLASS = "DEMO"
DEMO_ROWS = [  # (닉네임, 업종, [회차별 총점]) 예시 값. 실제 학습자 기록이 아니다.
    ("예시 고깃집A", "bbq", [48, 71, 93]), ("예시 고깃집B", "bbq", [62, 77]), ("예시 고깃집C", "bbq", [41, 58]),
    ("예시 고깃집D", "bbq", [84]), ("예시 카페A", "cafe", [55, 66, 88]), ("예시 카페B", "cafe", [91]),
]


def seed_demo() -> int:
    from sim.score import band_for
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    n = 0
    with _LOCK, _conn() as c:
        c.execute("DELETE FROM attempts WHERE class_code = ? AND demo = 1", (DEMO_CLASS,))   # 예시 줄만 다시 넣는다
        for nick, ind, totals in DEMO_ROWS:
            for i, t in enumerate(totals, 1):
                c.execute("INSERT INTO attempts (class_code, nickname, industry, mode, attempt, total, band, parts, created_at, demo) "
                          "VALUES (?,?,?,?,?,?,?,?,?,1)", (DEMO_CLASS, nick, ind, "free", i, t, band_for(t)[0], "{}", now))
                n += 1
    return n


if __name__ == "__main__":
    import sys
    if "--seed-demo" in sys.argv:
        print(f"{db_path()}: DEMO 반에 예시 기록 {seed_demo()}줄")
