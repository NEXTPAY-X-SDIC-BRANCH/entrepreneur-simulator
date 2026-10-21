"""API 키 읽기. 환경변수 우선, 없으면 저장소 루트 .env (저장소에 올리지 않는 파일).

키 값은 출력하지 않는다. 요청 URL이나 오류 문구에 키가 섞이면 mask()로 가린 뒤 보여 준다.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _env_file() -> dict[str, str]:
    out: dict[str, str] = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


_FILE = _env_file()

# 팀원마다 .env에 같은 키를 다른 이름으로 넣어 두었다. 코드가 읽는 이름이 비어 있으면 이 별칭도 본다.
ALIASES = {
    "SEOUL_OPEN_DATA_KEY": ["SEOUL_API_KEY"],
    "SBIZ_STORE_KEY": ["SBIZ_API_KEY"],
    "KOSIS_KEY": ["KOSIS_API_KEY"],
    "KMA_APIHUB_KEY": ["KMA_API_HUB_KEY"],
    "ASOS_HOURLY_KEY": ["KMA_ASOS_HOURLY_KEY"],
    "LIVESTOCK_AUCTION_KEY": ["MEAT_PRICE_API_KEY"],
}


def key(name: str, fallback: str | None = "DATA_GO_KR_KEY") -> str:
    v = os.environ.get(name) or _FILE.get(name)
    for alt in ALIASES.get(name, []):
        v = v or os.environ.get(alt) or _FILE.get(alt)
    if not v and fallback:
        v = os.environ.get(fallback) or _FILE.get(fallback)
    if not v:
        raise SystemExit(f"{name}가 없습니다. 환경변수나 저장소 루트 .env에 넣어 주세요 (.env.example 참고)")
    return v


def mask(text: str) -> str:
    for v in list(_FILE.values()) + [os.environ.get(k, "") for k in _FILE]:
        if v and len(v) > 8:
            text = text.replace(v, "<KEY>")
    return text
