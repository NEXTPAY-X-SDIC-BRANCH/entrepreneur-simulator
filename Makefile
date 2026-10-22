# make help
PY := .venv/bin/python

.PHONY: help setup dev api cite web test pipelines
help:       ## 목록
	@grep -E '^[a-z-]+:.*## ' Makefile | sed 's/:.*## /\t/'
setup:      ## .venv 만들고 패키지 설치 (Python 3.11 또는 3.12)
	test -x $(PY) || $$(command -v python3.12 || command -v python3.11 || command -v python3) -m venv .venv
	$(PY) -m pip install -q -r requirements.txt
dev:        ## 엔진 :8010 + 챗봇 :8000 + 웹 :5173 을 한 번에 (Ctrl+C로 셋 다 끔)
	bash scripts/dev.sh
api:        ## 시뮬레이션 엔진 서버 :8010
	$(PY) -m uvicorn api.changeup:app --host 127.0.0.1 --port 8010
cite:       ## 챗봇 근거 검색 서버 :8000
	$(PY) -m uvicorn api.cite_api:app --host 127.0.0.1 --port 8000
web:        ## 웹 개발 서버 :5173
	cd web && npm install && npm run dev
test:       ## 엔진과 API 테스트 (엔진 전체 시즌 테스트는 제외, 수십 분 걸림)
	$(PY) -m pytest tests sim/tests -q --deselect sim/tests/test_season.py
pipelines:  ## 공공데이터 갱신 (.env 의 키 필요)
	$(PY) -m pipelines.run_all
