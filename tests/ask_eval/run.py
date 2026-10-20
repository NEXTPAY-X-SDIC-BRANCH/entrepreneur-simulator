"""챗봇(/ask) 평가. 모델이 없으므로 서버 없이 FastAPI TestClient로 바로 돈다.

    python -m tests.ask_eval.run            # 전체와 실패 목록
    python -m tests.ask_eval.run --only q07_rain_customers
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def load() -> dict:
    return yaml.safe_load((HERE / "questions.yaml").read_text(encoding="utf-8"))


def ask(client, q: str, ctx: dict | None) -> dict:
    if ctx:
        return client.post("/ask", json={"q": q, "ctx": ctx}).json()
    return client.get("/ask", params={"q": q}).json()


def judge(spec: dict, r: dict) -> list[str]:
    answer = r.get("answer")
    why: list[str] = []
    if spec.get("none"):
        if answer:
            why.append(f"답이 없어야 하는데 답함: {answer[:60]}")
        return why
    if not answer:
        if spec.get("ok_none"):
            return []
        return ["답이 없음: " + (r.get("message") or "")[:60]]
    for pat in spec.get("expect", []):
        if not re.search(pat, answer):
            why.append(f"기대 문구 없음: {pat}")
    for pat in spec.get("forbid", []):
        if re.search(pat, answer):
            why.append(f"나오면 안 되는 문구: {pat}")
    got = {c["id"] for c in r.get("citations", [])}
    for sid in spec.get("cite", []):
        if sid not in got:
            why.append(f"출처 없음: {sid}")
    return why


def run(only: set[str] | None = None) -> list[dict]:
    from fastapi.testclient import TestClient

    sys.path.insert(0, str(HERE.parents[1]))
    from api.cite_api import app

    client = TestClient(app)
    cfg = load()
    out = []
    for spec in cfg["questions"]:
        if only and spec["id"] not in only:
            continue
        ctx = cfg["fixtures"].get(spec["ctx"]) if spec.get("ctx") else None
        r = ask(client, spec["q"], ctx)
        why = judge(spec, r)
        out.append({"id": spec["id"], "q": spec["q"], "ok": not why, "why": why,
                    "answer": (r.get("answer") or r.get("message") or "")[:140].replace("\n", " / ")})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    res = run(set(filter(None, a.only.split(","))) or None)
    for r in res:
        print(("통과 " if r["ok"] else "실패 ") + r["id"], "|", r["q"])
        if not r["ok"]:
            for w in r["why"]:
                print("      -", w)
            print("      답:", r["answer"])
    ok = sum(r["ok"] for r in res)
    print(f"\n{ok}/{len(res)} 통과")


if __name__ == "__main__":
    main()
