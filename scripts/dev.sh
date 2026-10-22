#!/usr/bin/env bash
# ChangeUp 한 번에 켜기: 시뮬레이션 엔진 API, 챗봇 근거 API, 웹 화면(Vite)을 함께 켜고 Ctrl+C 한 번으로 셋 다 끈다.
#   bash scripts/dev.sh            (또는 make dev)
# 포트를 바꾸려면: ENGINE_PORT=8110 CITE_PORT=8100 WEB_PORT=5180 bash scripts/dev.sh
# 웹은 VITE_ENGINE_API / VITE_CITE_API 로 두 API 주소를 받는다 (기본 8010 / 8000). 두 API의 CORS는 127.0.0.1·localhost의 모든 포트를 허용한다.
set -u
cd "$(dirname "$0")/.."

ENGINE_PORT="${ENGINE_PORT:-8010}"
CITE_PORT="${CITE_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"

if [ -x .venv/bin/python ]; then PY=.venv/bin/python
elif [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe
else
  echo "파이썬 가상환경(.venv)이 없어요. 먼저: make setup  (또는 python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)" >&2
  exit 1
fi
if [ ! -d web/node_modules ]; then
  echo "웹 패키지가 없어요. 먼저: cd web && npm ci" >&2
  exit 1
fi
if ! "$PY" -c "import fastapi, uvicorn, simpy, yaml" 2>/dev/null; then
  echo "파이썬 패키지가 빠져 있어요. 먼저: $PY -m pip install -r requirements.txt" >&2
  exit 1
fi
busy() { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for p in "$ENGINE_PORT" "$CITE_PORT" "$WEB_PORT"; do
  if busy "$p"; then
    echo "포트 $p 를 이미 다른 프로그램이 쓰고 있어요. 그 프로그램을 끄거나 ENGINE_PORT / CITE_PORT / WEB_PORT 로 다른 포트를 주세요." >&2
    exit 1
  fi
done

PIDS=()
stop() {
  trap - INT TERM EXIT
  echo
  echo "끄는 중이에요..."
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  exit 0
}
trap stop INT TERM EXIT

"$PY" -m uvicorn api.changeup:app --host 127.0.0.1 --port "$ENGINE_PORT" --log-level warning &
PIDS+=($!)
"$PY" -m uvicorn api.cite_api:app --host 127.0.0.1 --port "$CITE_PORT" --log-level warning &
PIDS+=($!)
(
  cd web
  VITE_ENGINE_API="http://127.0.0.1:$ENGINE_PORT" VITE_CITE_API="http://127.0.0.1:$CITE_PORT" PORT="$WEB_PORT" \
    exec ./node_modules/.bin/vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort --clearScreen false
) &
PIDS+=($!)

# 엔진이 뜰 때까지 기다린다 (처음에는 몇 초 걸린다)
for _ in $(seq 1 60); do
  "$PY" -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:$ENGINE_PORT/health', timeout=1)" 2>/dev/null && break
  sleep 1
done

echo
echo "  ChangeUp 실행 중"
echo "  웹 화면    http://127.0.0.1:$WEB_PORT"
echo "  엔진 API   http://127.0.0.1:$ENGINE_PORT  (api/changeup.py)"
echo "  챗봇 API   http://127.0.0.1:$CITE_PORT  (api/cite_api.py)"
echo "  끄려면 Ctrl+C"
echo

# 셋 중 하나라도 멈추면 나머지도 끈다
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then echo "서버 하나가 멈췄어요 (pid $pid). 나머지도 끕니다." >&2; stop; fi
  done
  sleep 2
done
