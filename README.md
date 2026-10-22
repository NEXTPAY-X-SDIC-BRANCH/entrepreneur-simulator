# ChangeUp: 예비 창업자 시뮬레이터

## 실행 방법

필요한 것: Python 3.11 또는 3.12, Node.js 20 이상. API 키는 없어도 됩니다.

처음 한 번만 설치합니다.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm ci && cd ..
```

켤 때는 명령 하나면 됩니다. 시뮬레이션 엔진, 챗봇, 웹 화면이 함께 켜집니다.

```bash
make dev          # make가 없으면 bash scripts/dev.sh
```

- 브라우저에서 http://127.0.0.1:5173 을 엽니다. 끌 때는 Ctrl+C 한 번이면 셋 다 꺼집니다.
- 기본 포트는 웹 5173, 엔진 API 8010, 챗봇 API 8000 입니다.
- 포트가 이미 쓰이고 있으면 다른 포트로 켭니다. 예: `ENGINE_PORT=8110 CITE_PORT=8100 WEB_PORT=5180 make dev`
- Windows에서는 Git Bash나 WSL에서 같은 명령을 씁니다.


가게를 열기 전에 "내 조건에서 몇 달 뒤 얼마가 남는가"를 미리 돌려 보는 시뮬레이터입니다.
업종은 **고깃집**과 **카페**이고, 서울 어느 동네에 열지부터 가게 구성, 6개월 운영까지 한 흐름으로 체험합니다.

```
내 조건 → 동네 분석 → 가게 꾸미기 → 시뮬레이션 (6개월, 매달 사건 하나에 대응)
```

| 단계 | 하는 일 | 쓰는 데이터 |
|---|---|---|
| 내 조건 | 업종, 구, 자본금, 나이대 입력 | 입력값 |
| 동네 분석 | 서울 25개 구와 행정동의 매출, 점포 수, 월세, 유동인구(추정), 거주민, 직장인, 동네 유형 | 서울시 상권분석서비스, 한국부동산원 R-ONE, 소상공인 상가정보 |
| 가게 꾸미기 | 평수, 테이블, 직원으로 여는 데 드는 돈과 3D 배치 | 외식업체 경영실태조사, 단가 자료 |
| 시뮬레이션 | 달마다 손님, 매출, 비용, 현금을 계산하고 "이달의 사건"에 대응 | 시즌 엔진, 날씨·공휴일, 동네 인구 분포 |

화면 오른쪽 위 "궁금한 것 물어보기"는 LLM 없이, 미리 정리한 근거 문장을 검색해 그대로 보여 줍니다.

## 서비스를 이루는 요소

- **시뮬레이션 엔진** (`sim/`)
  - 고깃집: 토요일 밤 한 번을 손님 도착, 좌석, 직원, 대기, 만족도 단위로 돌려 한 달로 환산합니다(`sim/engine.py`, `sim/season.py`, SimPy 이산사건).
  - 카페: 월 단위 결정론 모델(`sim/cafe/`). 손님 수, 객단가, 좌석, 직원 인력으로 한 달 결과를 계산합니다.
  - 달별 사건: 6개월 시즌의 매달 달력에 맞는 사건 하나(예: 3월 개강, 6월 장마)가 나오고, 선택지에 따라 그달 결과가 달라집니다.
  - 투자·대출 계층(`sim/venture.py`): 여는 데 드는 돈, 보증금 회수, 대출 이자, 본전 시점.
- **API 서버** (`api/`)
  - `api/changeup.py` (포트 8010): 고깃집·카페 엔진을 감싼 HTTP API. 카페는 `api/cafe.py`.
  - `api/cite_api.py` (포트 8000): 챗봇용 근거 검색. `api/ask_ext.py`가 질문 주제를 판별하고 화면의 값으로 즉석 문장을 만듭니다.
- **웹 화면** (`web/`): React와 three.js(R3F). 3D 가게는 엔진이 준 배치를 그립니다.
- **데이터 파이프라인** (`pipelines/`): 공공 API와 파일을 받아 `web/public/mock/*.json`으로 가공합니다.
- **연구 값** (`research/`, `industry/`): 엔진 입력(가상 매장 값, 시즌 파라미터, 사건, 달력, 충격)과 카페 파라미터. 값마다 근거 등급(H·M·L) 또는 "가정"이 붙어 있습니다.

더 자세한 구조는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 카페 엔진은 [docs/CAFE.md](docs/CAFE.md), 공공데이터는 [docs/DATA.md](docs/DATA.md)를 보세요.

## 실행

API 키 없이 실행됩니다. 화면에 쓰는 데이터는 이미 `web/public/mock/`에 가공되어 들어 있습니다.
키는 데이터를 새로 받을 때만 필요합니다(아래 "데이터 갱신").

필요한 것: Python 3.11 또는 3.12, Node.js 20 이상.

```bash
# 1. 파이썬 패키지
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip

# 2. 서버 두 개 (각각 터미널 하나씩)
python -m uvicorn api.changeup:app --host 127.0.0.1 --port 8010   # 시뮬레이션 엔진
python -m uvicorn api.cite_api:app --host 127.0.0.1 --port 8000   # 챗봇 근거 검색

# 3. 웹
cd web
npm install
npm run dev                                       # http://127.0.0.1:5173
```

시뮬레이션 단계와 챗봇은 위 두 서버가 켜져 있어야 합니다. 동네 분석까지는 서버 없이도 열립니다.

## 테스트

```bash
python -m pytest tests sim/tests -q       # 엔진, API, 챗봇 평가 질문 49개 포함
cd web && npx tsc --noEmit && npm run build
```

`sim/tests/test_season.py`는 엔진을 많이 돌려서 수십 분 걸립니다. 빠르게 보려면 이 파일을 빼고 실행하세요(`make test`가 그렇게 합니다).

## 데이터 갱신 (선택, 키 필요)

`.env.example`을 `.env`로 복사해 값을 채웁니다. 비워 둔 키는 해당 데이터만 건너뜁니다. `.env`는 저장소에 올라가지 않습니다.

```bash
python -m pipelines.run_all --selftest    # 1분기 × 1상권으로 형태 확인
python -m pipelines.run_all               # 서울 열린데이터광장 전체 (키: SEOUL_API_KEY)
```

그 밖의 `pipelines/build_*.py`, `fetch_*.py`는 파일 상단 설명에 입력과 필요한 키가 적혀 있습니다.
일부 가공 스크립트는 저장소 밖 파일(엑셀, PDF)을 입력으로 받으며, 가공 결과는 `web/public/mock/`에 들어 있습니다.

## 값의 신뢰도

화면과 엔진의 숫자는 세 가지로 나뉩니다. 공공 통계와 조사 원자료에서 온 값, 업계 자료를 옮긴 값, 근거 없이 둔 **가정**입니다.
사건 효과 크기와 여러 행동 값은 가정이고, 시뮬 결과는 예측이 아니라 비교용 체험입니다.
유동인구는 서울시 길단위인구 분기 값을 일수로 나눈 추정이라 "하루 약 n명(추정)"으로만 표시합니다.
