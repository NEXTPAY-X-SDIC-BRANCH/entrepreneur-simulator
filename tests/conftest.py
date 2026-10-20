"""Shared fixtures: a temp SQLite DB loaded from the repo's real inputs, hash embedder, mock LLM."""
import os
import shutil
import stat
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def env(tmp_path_factory):
    d = tmp_path_factory.mktemp("twin")
    os.environ["DATABASE_URL"] = f"sqlite:///{d / 'test.db'}"
    os.environ["RAG_EMBEDDER"] = "hash"
    os.environ["LLM_BACKEND"] = "mock"
    os.environ["LLM_CACHE_DIR"] = str(d / "llm_cache")
    os.environ["REPORT_WARM"] = "0"          # the end-of-season report warm (process pool) is tested on its own
    for k in ("LLM_SESSION_CAP", "LLM_RATE_PER_MIN", "LLM_MODEL"):
        os.environ.pop(k, None)
    return d


@pytest.fixture(scope="session")
def loaded(env):
    from db.load import load_all
    from db.session import database_url, get_engine
    from rag.embed import get_embedder
    from rag.ingest import ingest
    eng = get_engine(database_url())
    counts = load_all(eng)
    ingest(eng, get_embedder("hash"))
    return {"engine": eng, "counts": counts, "dir": env}


@pytest.fixture
def fresh_llm(env, tmp_path, monkeypatch):
    """Clean guardrail state and an empty cache per test."""
    from agents import llm
    llm.reset_state()
    monkeypatch.setenv("LLM_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("LLM_BACKEND", "mock")
    monkeypatch.delenv("LLM_SESSION_CAP", raising=False)
    monkeypatch.setenv("LLM_RATE_PER_MIN", "1000")
    yield llm
    llm.reset_state()


REPO = Path(__file__).resolve().parents[1]


FAKE = """#!/bin/sh
# fake claude: log cwd, each argv item, one env var and stdin, answer with the model name
{{ echo "CWD=$(pwd -P)"; echo "SAFE=$CLAUDE_CODE_SAFE_MODE"; for a in "$@"; do echo "[$a]"; done; cat; echo; echo "---"; }} >> "{log}"
{body}
"""


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    def make(body='echo "FAKE-ANSWER model=$3"'):
        bindir = tmp_path / "bin"
        bindir.mkdir(exist_ok=True)
        log = tmp_path / "claude_calls.log"
        exe = bindir / "claude"
        exe.write_text(FAKE.format(log=log, body=body))
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
        monkeypatch.setenv("LLM_CLAUDE_CWD", str(tmp_path / "llm-cwd"))   # outside the repo, created on demand
        assert shutil.which("claude") == str(exe), "the fake must be the only claude on PATH"
        return log
    return make


