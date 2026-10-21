"""이지 모드와 민감도 (lab:modes). 2026-10-20 대표님 피드백 4번(다시 해보기), 7번(이지/하드 모드).

이지 모드: 업종, 구(동), 자본금(선택: 평수)만 받고 나머지 입력을 앱이 이미 쓰는 자료로 채운 뒤 6개월을 한 번에 돌린다.
채우는 규칙은 화면(web/src/mock)의 계산을 그대로 옮겼다. 다른 값을 쓰면 하드 모드와 이지 모드 결과가 어긋나기 때문이다.

    고깃집  model.ts guStat (구·동 매출, R-ONE 월세, 분기 지수) + recommend (가진 돈으로 버틸 수 있는 평수·테이블·알바)
            + openingCost (보증금, 인테리어, 주방, 테이블, 간판, 첫 재료) -> /season/run 과 같은 몸통
    카페    model.ts guStat (카페 블록) + cafe.ts cafeEstimate (평수) + cafeChecks.ts engineBody (배치 어림)
            + CafeSim.tsx 의 손님 수 맞춤(daily_customers) -> sim.cafe.season 6개월

자료 파일은 화면과 같은 web/public/mock/*.json 이다. 모든 결과는 입력이 같으면 같다 (시드 고정, 날짜를 읽지 않음).

민감도: 같은 계획을 손님, 고깃값(카페는 재료비), 월세, 인건비를 ± 바꿔 여러 번 돌린다.
  고깃집  엔진(sim.season)의 한 달 설정(_setup)이 만든 값에 배율을 곱해 같은 시드로 다시 돈다 (점포 캐시를 새로 만들지 않아 빠름).
          손님 = drv_arrival_rate, 고깃값 = cst_meat_cost_per_portion, 월세 = drv_rent, 인건비 = sto_parttime_wage.
          엔진 전역 상태를 잠깐 바꾸므로 반드시 api.changeup._LOCK 안에서 부른다 (api/lab_modes.py가 그렇게 한다).
  카페    손님 = daily_customers 배율로 다시 돌리고, 재료비·월세·인건비는 그달 비용 줄에 배율을 곱해 현금과 폐업을 다시 계산한다
          (카페 엔진에서 이 셋은 손님과 별점에 되먹임되지 않아 사후 계산이 엔진 계산과 같다).
"""
from __future__ import annotations

import contextvars
import functools
import json
import math
from contextlib import contextmanager
from pathlib import Path

MOCK = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"

# ---- model.ts 상수 (같은 이름, 같은 값) ----------------------------------------------------------------
DEPOSIT_MONTHS = 12
PERSON_TICKET = 27000
OPEN_DAYS = 26
SIDE_TICKET = 8000
FOOD_SHARE = 0.31
STAFF_COST = 199          # 만원/월
UTIL_PER_PYEONG, OTHER_OPEX = 6.8, 150   # 만원/월, model.ts mgmtOf (lab:cost: 공과금은 평수 비례 + 기타 운영비 고정)
FEE_SHARE = 0.0084
OWNER_DRAW = 300          # 만원/월
OPEN_CURVE = [0.55, 0.7, 0.82, 0.9, 0.96, 1.0]
SEAT_TURN = 2.1           # model.ts (lab:cost 엔진에 맞춘 값)
COVERS_PER_STAFF = 34     # 사장님 포함 일하는 사람 1명당 하루 손님 (lab:cost)
SOFT_MIN_P = 2.3          # engineCovers 부드러운 최솟값 지수
DEMAND_FX = 0.92
LOW = 0.8
BASE_PRICE = 19000        # DEFAULT_LEVERS.price
SIGN, FIRST_STOCK = 250, 300
GRADE_BASIC = 45          # 만원/평, GRADES.basic.perPyeong
ITEMS = {"kitchen": (1500, 4.0, 2.5), "fridge": (180, 1.0, 1.0), "table4": (113, 1.5, 2.0)}  # 만원, w, d
CELL = 0.5
CAFE_MEDIAN_RATIO = 10740 / 13759
CAFE_GRADE_BASIC = (75, 40, 25)   # 인테리어, 머신·주방, 가구 (만원/평)
CAFE_PYEONG_MID = 20
CAFE_BURN = 3 * 550               # CafeBuild: cafeEstimate(profile, 3 * 550)
CAFE_DEFAULT_CODE = "3120012"
STAFF_MAX_ENGINE = 4              # 엔진 교대당 알바 상한 (SimulateEngine Plan과 같음)
WORKING_MONTHS = 3                # 모자란 돈을 빌릴 때 석 달 고정비를 더 빌린다 (가정, 카페 엔진의 운전자금 규칙과 같은 개월 수)
OV_BASIS = "직접 정한 값 (다시 해보기에서는 지난 판 값이 이어짐)"
EASY_SEED = 42                    # 이지 모드는 시드를 고정: 판마다 점수가 바뀌면 그건 입력을 바꿨기 때문이다
CAFE_SEED = 7                     # cafeChecks.engineBody 와 같음


def js_round(x: float) -> int:
    """JavaScript Math.round (0.5는 위로). 파이썬 round는 짝수 쪽으로 반올림해 화면 값과 어긋난다."""
    return math.floor(x + 0.5)


def round1(x: float) -> float:
    return js_round(x * 10) / 10


@functools.lru_cache(maxsize=None)
def _load(name: str):
    try:
        return json.loads((MOCK / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def _hash(s: str) -> float:
    """model.ts hash (FNV-1a over UTF-16 code units). 월세 자료가 없을 때의 예시값에만 쓴다."""
    h = 2166136261
    raw = s.encode("utf-16-le")
    for i in range(0, len(raw), 2):
        h = ((h ^ (raw[i] | raw[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return h / 4294967296


def _ecos_rate() -> float:
    e = _load("ecos_rates.json")
    sme = (e or {}).get("latest", {}).get("loan_sme")
    return sme["rate"] / 100 if sme else 0.06


# ---- 구·동 통계 (model.ts guStat 중 엔진 입력에 쓰는 값) ---------------------------------------------------
def _dongs(industry: str) -> dict:
    return _load("cafe_dong_stats.json" if industry == "cafe" else "dong_stats.json") or {"gu": {}, "_meta": {}}


def _profile_code(industry: str, gu: str, name: str) -> str | None:
    pf = _load("cafe_dong_profile.json" if industry == "cafe" else "dong_profile.json") or {"dong": []}
    hit = next((d for d in pf["dong"] if d["gu"] == gu and d["name"] == name), None)
    return str(hit["code"]) if hit else None


def gu_stat(industry: str, gu: str, dong: str | None = None) -> dict:
    gs = _load("gu_stats.json")
    if not gs or gu not in gs[industry]["gu"]:
        raise ValueError(f"구 자료가 없습니다: {gu}")
    g = gs[industry]["gu"][gu]
    rent_d = _load("rent_gu.json") or {}
    conv = rent_d.get("conv_seoul_pct") or 7
    cash = lambda all_: all_ / (1 + (DEPOSIT_MONTHS * (conv / 100)) / 12)  # noqa: E731
    rent, src = js_round(9 + _hash(gu + "r") * 20), "예시값"
    rr = (rent_d.get("gu") or {}).get(gu)
    if rr:
        rent, src = round1(cash(rr["rent_man_per_pyeong"])), ("R-ONE 채움" if rr["imputed"] else "R-ONE 근사")
    dg = next((d for d in _dongs(industry)["gu"].get(gu, []) if d["name"] == dong), None) if dong else None
    if dg:
        dr = (rent_d.get("dong") or {}).get(f"{gu}|{dg['name']}")
        if dr:
            rent, src = round1(cash(dr["rent_man_per_pyeong"])), "R-ONE 동네"
    sales_h = js_round(g["sales_per_store_month"] * min(2, max(0.4, dg["rel"]))) if dg and dg.get("rel") else g["sales_per_store_month"]
    if industry == "cafe":
        mult = (_dongs("cafe")["_meta"].get("adj") or 1.538) * CAFE_MEDIAN_RATIO
    else:
        k = _load("gogi_krei.json")
        try:
            mult = k["tables"]["pl_sales"]["meat"]["values"]["평균"] / k["tables"]["pl_sales"]["hansik_all"]["values"]["평균"]
        except (TypeError, KeyError, ZeroDivisionError):
            mult = 1.0
    code = _profile_code(industry, gu, dg["name"]) if dg else None
    return {"gu": gu, "dong": dg["name"] if dg else None, "dong_code": code, "rent": rent, "rent_src": src,
            "sales_hansik": sales_h, "sales": js_round(sales_h * mult), "qidx": dg["qidx"] if dg else g["quarter_index"],
            "area_type": dg.get("type") if dg else None}


def flow_shape(code: str | None, gu: str) -> dict | None:
    """area.ts flowShape: 동 코드가 있으면 그 동, 없으면 구의 길단위인구 요일·시간대·연령 비율."""
    fl = _load("dong_flow.json")
    if not fl:
        return None
    row = (fl["dong"].get(code) or {}).get("flow") if code else None
    row = row or fl["gu"].get(gu)
    return {"dow": row["dow"], "band": row["band"], "age": row["age"]} if row and row.get("dow") and row.get("band") else None


# ---- 고깃집 가게 배치 (model.ts roomSize, tableSlots, starterStore) -------------------------------------------
def room_size(pyeong: float) -> tuple[float, float]:
    area = pyeong * 3.3
    w = js_round(math.sqrt(area * 1.45) / CELL) * CELL
    return w, js_round(area / w / CELL) * CELL


def _snap(v: float, size: float) -> float:
    half = size / 2
    return js_round((v - half) / CELL) * CELL + half


def _kitchen_spot(pyeong: float) -> tuple[float, float]:
    w, d = room_size(pyeong)
    return -w / 2 + ITEMS["kitchen"][1] / 2, -d / 2 + ITEMS["kitchen"][2] / 2


def table_slots(pyeong: float) -> list[tuple[float, float]]:
    w, d = room_size(pyeong)
    kx, kz = _kitchen_spot(pyeong)
    kw, kd, tw, td, gap = ITEMS["kitchen"][1], ITEMS["kitchen"][2], ITEMS["table4"][1], ITEMS["table4"][2], 0.5
    cols = math.floor((w - gap) / (tw + gap))
    x0 = -((cols - 1) * (tw + gap)) / 2
    out = []
    z = d / 2 - gap - td / 2
    while z - td / 2 >= -d / 2 + gap - 1e-6:
        for i in range(cols):
            x = _snap(x0 + i * (tw + gap), tw)
            clear_k = abs(x - kx) >= (tw + kw) / 2 + gap - 1e-6 or abs(z - kz) >= (td + kd) / 2 + gap - 1e-6
            fx, fz = -w / 2 + kw + 0.5, -d / 2 + 0.5
            clear_f = abs(x - fx) >= (tw + 1) / 2 + gap - 1e-6 or abs(z - fz) >= (td + 1) / 2 + gap - 1e-6
            if clear_k and clear_f:
                out.append((x, _snap(z, td)))
        z -= td + gap
    return out


def _fits(items: list[tuple[str, float, float]], pyeong: float, cand: tuple[str, float, float]) -> bool:
    w, d = room_size(pyeong)
    _, cw, cd = ITEMS[cand[0]]
    x, z = cand[1], cand[2]
    if x - cw / 2 < -w / 2 - 1e-6 or x + cw / 2 > w / 2 + 1e-6 or z - cd / 2 < -d / 2 - 1e-6 or z + cd / 2 > d / 2 + 1e-6:
        return False
    for iid, ox, oz in items:
        _, gw, gd = ITEMS[iid]
        if not (abs(ox - x) >= (cw + gw) / 2 - 1e-6 or abs(oz - z) >= (cd + gd) / 2 - 1e-6):
            return False
    return True


def starter_store(pyeong: int, tables: int) -> dict:
    """주방 + 냉장고 1대 + 4인 테이블 `tables`개를 자동 배치한 가게의 개수 (엔진과 여는 비용에 쓰는 값만)."""
    w, d = room_size(pyeong)
    items = [("kitchen", *_kitchen_spot(pyeong))]
    fr = ("fridge", _snap(-w / 2 + ITEMS["kitchen"][1] + 0.5, 1), _snap(-d / 2 + 0.5, 1))
    if _fits(items, pyeong, fr):
        items.append(fr)
    for x, z in table_slots(pyeong)[:tables]:
        c = ("table4", x, z)
        if _fits(items, pyeong, c):
            items.append(c)
    n_tables = sum(1 for i in items if i[0] == "table4")
    return {"pyeong": pyeong, "grade": "basic", "tables": n_tables, "seats": n_tables * 4,
            "fridge": any(i[0] == "fridge" for i in items)}


def opening_cost(store: dict, rent: float, key_money: float = 0) -> list[dict]:
    """model.ts openingCost (만원). 키는 화면과 같다 (venture 장부의 invest 키)."""
    equip = ITEMS["kitchen"][0] + (ITEMS["fridge"][0] if store["fridge"] else 0)
    lines = [
        *([{"key": "keymoney", "label": "권리금", "amount": key_money, "src": "입력"}] if key_money > 0 else []),
        {"key": "deposit", "label": "보증금", "amount": rent * store["pyeong"] * DEPOSIT_MONTHS,
         "src": "가정", "basis": f"월세 {DEPOSIT_MONTHS}개월분 (서울시 상가임대차 실태조사 11~15개월)"},
        {"key": "interior", "label": "인테리어 공사", "amount": GRADE_BASIC * store["pyeong"],
         "src": "공공 통계", "basis": f"평당 {GRADE_BASIC}만원, 외식업체 경영실태조사 2025 육류 전문점 25분위"},
        {"key": "equip", "label": "주방과 설비", "amount": equip, "src": "공공 통계", "basis": "주방 1,500만원(경영실태조사 중앙값) + 냉장고"},
        {"key": "seat", "label": "테이블과 의자", "amount": ITEMS["table4"][0] * store["tables"], "src": "공공 통계",
         "basis": f"4인 테이블 {store['tables']}개 × 113만원 (경영실태조사 홀 비용 ÷ 테이블 수)"},
        {"key": "deco", "label": "꾸밈", "amount": 0, "src": "가정", "basis": "없음"},
        {"key": "sign", "label": "간판", "amount": SIGN, "src": "가정", "basis": "전면 간판 1개"},
        {"key": "stock", "label": "첫 재료와 소모품", "amount": FIRST_STOCK, "src": "가정", "basis": "고기, 주류, 반찬 재료"},
    ]
    return lines


def mgmt_of(pyeong: float) -> float:
    return UTIL_PER_PYEONG * pyeong + OTHER_OPEX


def engine_covers(demand: float, seats: int, staff: int) -> float:
    """model.ts engineCovers: 수요, 좌석, 일손 세 한계의 부드러운 최솟값 (엔진 6개월 평균에 맞춘 식, lab:cost)."""
    if demand <= 0 or seats <= 0:
        return 0.0
    p = SOFT_MIN_P
    return ((DEMAND_FX * demand) ** -p + (SEAT_TURN * seats) ** -p + (COVERS_PER_STAFF * (staff + 1)) ** -p) ** (-1 / p)


def _mock_season(st: dict, store: dict, staff: int, capital: float, demand_mult: float = 1.0) -> dict:
    """model.ts simulate (목업 공식, 대출 0): 추천 배치를 고를 때만 쓴다. 결과는 엔진이 다시 계산한다."""
    opening = sum(x["amount"] for x in opening_cost(store, st["rent"]))
    cash = capital - opening
    ticket = BASE_PRICE + SIDE_TICKET
    settled = (st["sales"] * 10000) / (PERSON_TICKET * OPEN_DAYS)
    rows = []
    for r in OPEN_CURVE:
        covers = engine_covers(settled * r * demand_mult, store["seats"], staff)
        revenue = covers * ticket * OPEN_DAYS / 10000
        cost = revenue * (FOOD_SHARE + FEE_SHARE) + staff * STAFF_COST + st["rent"] * store["pyeong"] + mgmt_of(store["pyeong"])
        op = revenue - cost
        cash += op - OWNER_DRAW
        rows.append({"op": op, "cash": cash})
    return {"rows": rows, "start": capital - opening}


def recommend(st: dict, capital: float, pyeong: int | None = None) -> dict:
    """model.ts recommend: 손님이 20% 적어도 6개월을 버티는 평수·테이블·알바 중 자리 잡은 달에 가장 많이 남기는 것.
    버티는 것이 없으면 6개월 끝 현금이 가장 많은 것. 평수를 주면 그 평수 안에서만 고른다."""
    best = None
    for p in ([int(pyeong)] if pyeong else range(12, 31)):
        slots = len(table_slots(p))
        for tables in range(2, slots + 1):
            store = starter_store(p, tables)
            if capital - sum(x["amount"] for x in opening_cost(store, st["rent"])) < 0:
                break
            for staff in range(1, 7):   # model.ts: 알바 1명부터 (lab:cost)
                low = _mock_season(st, store, staff, capital, LOW)
                safe = all(r["cash"] >= 0 for r in low["rows"])
                score = _mock_season(st, store, staff, capital)["rows"][5]["op"] - OWNER_DRAW if safe else low["rows"][5]["cash"]
                if best is None or (safe and not best["safe"]) or (safe == best["safe"] and score > best["score"] + 1e-6):
                    best = {"store": store, "staff": staff, "safe": safe, "score": score}
    if best is None:   # 가진 돈으로는 어떤 배치도 못 연다: 가장 작은 가게(또는 고른 평수에 테이블 2개)로 빌려서 연다
        return {"store": starter_store(int(pyeong) if pyeong else 12, 2), "staff": 1, "safe": False, "fits_capital": False}
    return {**best, "fits_capital": True}


def _fixed_month(st: dict, store: dict, staff: int) -> float:
    return st["rent"] * store["pyeong"] + mgmt_of(store["pyeong"]) + staff * STAFF_COST + OWNER_DRAW


GENERIC = ("hansik", "pub", "bunsik", "bakery", "chicken")   # lab:industry 새 업종 (sim/generic)
INDUSTRY_IDS = ("bbq", "cafe", *GENERIC)


def rent_row(value: float, src: str) -> dict:
    """월세 줄. R-ONE 근사/동네 = 공공 통계. R-ONE 채움(자료 없는 구를 비슷한 구로 채운 값)과 예시값 = 가정."""
    row = {"key": "rent", "label": "평당 월세 (보증금 빼고)", "value": value, "unit": "만원"}
    if src in ("R-ONE 근사", "R-ONE 동네"):
        return {**row, "src": "공공 통계", "basis": f"한국부동산원 상가 임대료 ({src}), 보증금 환산분을 뺀 현금 월세"}
    if src == "R-ONE 채움":
        return {**row, "src": "가정", "basis": "한국부동산원 자료가 없는 구라 비슷한 구 값으로 채운 월세"}
    if src == "입력":
        return {**row, "src": "입력", "basis": "직접 넣은 월세"}
    return {**row, "src": "가정", "basis": "이 구의 임대료 자료가 없어 넣은 예시값"}


ENGINE_MENU_KEYS = ("id", "name", "kind", "price", "unit_cost", "mix")   # web/src/lab/menu/api.ts toEngine


def default_menu(industry: str, price: int = BASE_PRICE, district: str | None = None) -> tuple[list[dict], float | None, dict]:
    """하드 모드와 같은 기본 메뉴판 (lab:menu, /lab/menu/template). 원가 = 오늘 시세(ingredients_today.json).
    고깃집: SimulateEngine처럼 삼겹살 가격이 19,000원이 아니면 주메뉴 가격만 같은 비율로 (100원 단위) 바꾸고 원가를 다시 계산,
    기본 상차림 원가(table_cost)를 함께 넘긴다. 카페: CafeSim처럼 상권 객단가에 맞춘 배율로 판매가를 맞춘다.
    돌려주는 값: (엔진에 넘길 메뉴, 상차림 원가 또는 None, 화면 요약)."""
    from sim import menu as M
    if industry == "bbq":
        items = M.template_menu("bbq", "domestic", 1.0)
        k = price / BASE_PRICE
        if abs(k - 1) > 1e-6:
            items = M.with_costs([{**x, "price": js_round(x["price"] * k / 100) * 100} if x["kind"] == "main" else x for x in items],
                                 "bbq", "domestic", 1.0)
        table = M.table_setting("bbq")
        tcost = float(table["cost"]) if table else None
    else:
        from sim.cafe.params import load_districts, v as cv
        d = load_districts()[district]
        scale = M.cafe_scale(d["ticket_krw"]["value"], cv("season", "dessert_share"), cv("demand", "cups_per_tx"))
        items, tcost = M.template_menu("cafe", "domestic", scale), None
    menu = [{k: x[k] for k in ENGINE_MENU_KEYS} for x in items]
    snap = M.snapshot()["_meta"].get("basis_date")
    return menu, tcost, {"n": len(menu), "basis_date": snap}


def _check(industry: str, capital_man: float, pyeong: float | None) -> None:
    if industry not in INDUSTRY_IDS:
        raise ValueError("업종을 확인해 주세요 (bbq, cafe, " + ", ".join(GENERIC) + ")")
    if not (500 <= float(capital_man) <= 200_000):
        raise ValueError("자본금은 500만원 이상 20억원 이하로 적어 주세요")
    if pyeong is not None and not (10 <= float(pyeong) <= 40):
        raise ValueError("평수는 10~40평입니다")


def easy_bbq(gu: str, capital_man: float, dong: str | None = None, pyeong: int | None = None, start_month: int = 3,
             overrides: dict | None = None) -> dict:
    """고깃집 이지 입력. 돌려주는 run 은 /season/run 몸통 그대로, inputs 는 화면에 보여 줄 값과 근거."""
    _check("bbq", capital_man, pyeong)
    ov = overrides or {}
    st = gu_stat("bbq", gu, dong)
    pyeong = int(ov.get("pyeong") or pyeong or 0) or None
    rec = recommend(st, float(capital_man), pyeong)
    store = rec["store"]
    if ov.get("tables"):
        store = starter_store(store["pyeong"], int(ov["tables"]))
    staff = int(ov["staff"]) if ov.get("staff") is not None else rec["staff"]
    staff = min(STAFF_MAX_ENGINE, max(0, staff))
    price = int(ov.get("price") or BASE_PRICE)
    lines = opening_cost(store, st["rent"])
    opening = sum(x["amount"] for x in lines)
    short = opening - float(capital_man)
    if ov.get("loan_man") is not None:
        loan = max(0.0, float(ov["loan_man"]))
        loan_src = "입력"
        if float(capital_man) + loan < opening:
            raise ValueError(f"가진 돈과 대출로는 가게를 열 수 없어요. 여는 비용 {opening:,.0f}만원에 "
                             f"{opening - float(capital_man) - loan:,.0f}만원이 모자라요. 대출을 늘리거나 평수를 줄여 보세요")
    else:
        loan = math.ceil((short + WORKING_MONTHS * _fixed_month(st, store, staff)) / 100) * 100 if short > 0 else 0.0
        loan_src = "가정"
    rate = _ecos_rate()
    code = st["dong_code"]
    spec = {"gu_sales_man": st["sales_hansik"], "pyeong": store["pyeong"], "tables": max(1, store["tables"]),
            "seats": store["seats"], "cash_rent_man_per_pyeong": st["rent"], "staff": staff, "price": price,
            "baseline_runs": 150, "quarter_index": st["qidx"], "area_type": st["area_type"] or "일반",
            "start_month": int(start_month), "flow": flow_shape(code, gu)}
    plan = {"meat_price": price, "staff_per_shift": staff, "close_hour": 24, "marketing_budget": 0,
            "meat_grade": "domestic", "banchan": 5, "delivery": "none"}
    menu, tcost, msum = default_menu("bbq", price)   # 하드 모드 시뮬레이션 첫 계획과 같은 메뉴판 + 기본 상차림
    plan["menu"] = menu
    if tcost is not None:
        plan["table_cost"] = tcost
    run = {"seed": EASY_SEED, "opening": True, "store": spec, "plan": plan,
           "invest": {x["key"]: x["amount"] * 1e4 for x in lines},
           "own_capital": float(capital_man) * 1e4, "owner_draw": OWNER_DRAW * 1e4,
           "loan": {"principal": loan * 1e4, "annual_rate": rate, "term_months": 60, "grace_months": 60} if loan > 0 else None,
           "band_runs": 10}
    shown = [
        {"key": "pyeong", "label": "평수", "value": store["pyeong"], "unit": "평",
         "src": "입력" if pyeong else "가정", "basis": OV_BASIS if pyeong else
         "가진 돈으로 열 수 있고 손님이 20% 적어도 6개월을 버티는 크기 중 가장 많이 남는 것 (화면의 추천 배치와 같은 규칙)"},
        {"key": "tables", "label": "4인 테이블", "value": store["tables"], "unit": "개", "src": "입력" if ov.get("tables") else "가정",
         "basis": OV_BASIS if ov.get("tables") else
         f"{store['pyeong']}평에 놓을 수 있는 자리 {len(table_slots(store['pyeong']))}곳 중 추천 규칙으로 고른 수"},
        {"key": "staff", "label": "교대당 알바", "value": staff, "unit": "명", "src": "입력" if ov.get("staff") is not None else "가정",
         "basis": OV_BASIS if ov.get("staff") is not None else "추천 규칙 (일하는 사람 1명이 하루 손님 34명쯤, 엔진에 맞춘 가정)"},
        {"key": "price", "label": "삼겹살 1인분", "value": price, "unit": "원", "src": "입력" if ov.get("price") else "업계 자료",
         "basis": OV_BASIS if ov.get("price") else "기준 고깃집(대학로) 가격, 팀 조사"},
        rent_row(st["rent"], st["rent_src"]),
        {"key": "sales", "label": "구 한식음식점 점포당 월매출", "value": st["sales_hansik"], "unit": "만원", "src": "공공 통계",
         "basis": "서울시 상권분석서비스 2025" + (f", {st['dong']} 상대 위치 반영" if st["dong"] else "")},
        {"key": "loan", "label": "대출", "value": loan, "unit": "만원", "src": loan_src,
         "basis": (f"모자란 {math.ceil(short):,}만원 + 석 달 고정비, 연 {rate * 100:.2f}% (한국은행 중소기업 대출금리) 이자만"
                   if loan_src == "가정" and loan > 0 else "직접 넣은 값" if loan_src == "입력" else "가진 돈으로 열 수 있어 빌리지 않음")},
        {"key": "start_month", "label": "여는 달", "value": int(start_month), "unit": "월", "src": "가정", "basis": "다음 달에 연다고 봄"},
        {"key": "plan", "label": "운영", "value": "밤 12시 마감, 반찬 5가지, 국내산, 배달 안 함", "unit": "", "src": "가정",
         "basis": "엔진의 기준 운영 (하드 모드 첫 달 계획과 같음)"},
        {"key": "menu", "label": "메뉴판", "value": f"기본 메뉴 {msum['n']}가지 + 기본 상차림", "unit": "", "src": "가정",
         "basis": f"하드 모드와 같은 기본 메뉴판, 원가는 {msum['basis_date'] or '최근'} 시세로 계산 (메뉴 구성과 판매가는 가정)"},
    ]
    return {"industry": "bbq", "gu": gu, "dong": st["dong"], "capital_man": float(capital_man), "store": store,
            "staff": staff, "price": price, "loan_man": loan, "loan_rate": rate, "opening": lines, "opening_total": opening,
            "safe_by_rule": rec["safe"], "fits_capital": rec["fits_capital"], "run": run, "shown": shown}


def _cafe_district(gu: str, dong: str | None) -> tuple[str, str | None, bool]:
    """카페 엔진은 행정동이 있어야 돈다. 동을 안 골랐으면 그 구에서 점포당 매출이 구 평균에 가장 가까운 동을 쓴다 (가정)."""
    from sim.cafe.params import load_districts
    known = load_districts()
    if dong:
        code = _profile_code("cafe", gu, dong)
        if code and code in known:
            return code, dong, False
    rows = [d for d in _dongs("cafe")["gu"].get(gu, []) if d.get("rel") and str(d["code"]) in known]
    if not rows:
        return CAFE_DEFAULT_CODE, None, True
    pick = min(rows, key=lambda d: (abs(d["rel"] - 1.0), str(d["code"])))
    return str(pick["code"]), pick["name"], True


def cafe_opening(pyeong: int, rent: float) -> list[dict]:
    i, k, h = CAFE_GRADE_BASIC
    return [
        {"key": "deposit", "label": "보증금", "amount": js_round(rent * pyeong * DEPOSIT_MONTHS), "src": "가정"},
        {"key": "interior", "label": "인테리어 공사", "amount": i * pyeong, "src": "공공 통계"},
        {"key": "equip", "label": "머신과 주방 설비", "amount": k * pyeong, "src": "공공 통계"},
        {"key": "seat", "label": "가구와 집기", "amount": h * pyeong, "src": "공공 통계"},
        {"key": "sign", "label": "간판", "amount": SIGN, "src": "가정"},
        {"key": "stock", "label": "첫 재료와 소모품", "amount": FIRST_STOCK, "src": "가정"},
    ]


def easy_cafe(gu: str, capital_man: float, dong: str | None = None, pyeong: int | None = None, start_month: int = 3,
              overrides: dict | None = None) -> dict:
    """카페 이지 입력. run 은 sim.cafe.season.start 에 넣을 몸통 (daily_customers 까지 채움)."""
    from sim import cafe as cafe_model
    _check("cafe", capital_man, pyeong)
    ov = overrides or {}
    code, dname, auto_dong = _cafe_district(gu, dong)
    st = gu_stat("cafe", gu, dname)
    p = int(ov.get("pyeong") or pyeong or 0)
    if not p:
        p = CAFE_PYEONG_MID
        while p > 10 and sum(x["amount"] for x in cafe_opening(p, st["rent"])) + CAFE_BURN > float(capital_man):
            p -= 1
    staff = int(ov["staff"]) if ov.get("staff") is not None else 1
    staff = min(7, max(0, staff))
    body = {"district": code, "size_pyeong": p, "tables": max(1, js_round(p * 0.36)), "chairs": max(2, js_round(p * 1.27)),
            "bar_seats": 0, "espresso_groups": 2, "showcase": 1, "oven": 0, "kiosks": 0, "pos": 1,
            "own_capital_krw": js_round(float(capital_man) * 10000), "staff_peak": staff + 1, "seed": CAFE_SEED,
            "start_month": int(start_month)}
    if ov.get("loan_man") is not None:
        body["extra_loan_krw"] = max(0, js_round(float(ov["loan_man"]) * 10000))
    area_fx = 0.89 if p < 10 else 1.0 if p < 30 else 1.37
    pv = cafe_model.preview({k: x for k, x in body.items() if k not in ("seed", "start_month", "extra_loan_krw")})
    ratio = (st["sales"] * area_fx * 10000) / pv["rough_month"]["revenue_krw"] if pv["rough_month"]["revenue_krw"] else 1.0
    body["daily_customers"] = min(600, max(10, js_round(pv["demand"]["default_daily_customers"] * ratio)))
    menu, _, msum = default_menu("cafe", district=code)   # CafeSim과 같은 기본 메뉴판 (상권 가격에 맞춤)
    body["menu"] = menu
    shown = [
        {"key": "dong", "label": "동네", "value": dname or "대학로 기준 상권", "unit": "", "src": "가정" if auto_dong else "입력",
         "basis": "동을 안 골라 구 안에서 점포당 매출이 구 평균에 가장 가까운 동을 씀" if auto_dong else "직접 고른 동"},
        {"key": "pyeong", "label": "평수", "value": p, "unit": "평", "src": "입력" if (ov.get("pyeong") or pyeong) else "업계 자료",
         "basis": OV_BASIS if (ov.get("pyeong") or pyeong) else
         "독립 카페 면적 중앙값 20평에서 시작, 여는 비용 + 석 달 운영비(1,650만원, 가정)를 못 맞추면 줄임"},
        {"key": "staff", "label": "바쁜 시간 직원 (사장님 빼고)", "value": staff, "unit": "명", "src": "입력" if ov.get("staff") is not None else "가정",
         "basis": OV_BASIS if ov.get("staff") is not None else "가게 꾸미기 화면의 기본값"},
        {"key": "seats", "label": "테이블 / 의자", "value": f"{body['tables']} / {body['chairs']}", "unit": "", "src": "업계 자료",
         "basis": "독립 카페 평당 테이블 0.36개, 좌석 1.27석"},
        rent_row(st["rent"], st["rent_src"]),
        {"key": "sales", "label": "이 동네 보통 카페 월매출", "value": st["sales"], "unit": "만원", "src": "가정",
         "basis": "서울시 상권분석서비스 카드 추정매출(공공 통계)에 보정 배율과 전국 독립 카페 중앙값/평균 비율을 곱한 추정"},
        {"key": "daily", "label": "바쁜 날 주문 수", "value": body["daily_customers"], "unit": "건", "src": "가정",
         "basis": "위 월매출에 맞춘 값 (카페 시뮬레이션 화면과 같은 규칙)"},
        {"key": "menu", "label": "메뉴판", "value": f"기본 메뉴 {msum['n']}가지", "unit": "", "src": "가정",
         "basis": f"하드 모드와 같은 기본 메뉴판(상권 가격에 맞춤), 원가는 {msum['basis_date'] or '최근'} 시세로 계산"},
        {"key": "start_month", "label": "여는 달", "value": int(start_month), "unit": "월", "src": "가정", "basis": "다음 달에 연다고 봄"},
    ]
    return {"industry": "cafe", "gu": gu, "dong": dname, "capital_man": float(capital_man), "pyeong": p, "staff": staff,
            "run": body, "shown": shown, "opening": cafe_opening(p, st["rent"])}


def easy_generic(industry: str, gu: str, capital_man: float, dong: str | None = None, pyeong: int | None = None,
                 start_month: int = 3, overrides: dict | None = None) -> dict:
    """새 업종 이지 입력 (lab:industry 엔진 sim/generic). 가게는 엔진의 업종 기본값 그대로다: 평수 = 경영실태조사 면적 중앙값,
    테이블 = 평당 좌석, 직원 = 업종 기본 인원. 하드 모드 가게 꾸미기(IndustryBuild)의 첫 화면과 같은 가게다.
    모자란 돈과 석 달 고정비는 엔진이 빌린다고 본다 (카페 엔진과 같은 규칙)."""
    from sim.generic import model as gm
    from sim.generic import params as gp
    from sim.generic.registry import INDUSTRIES
    _check(industry, capital_man, pyeong)
    if dong and not any(d["name"] == dong for d in ((gp.dong_data(industry) or {}).get("gu", {}).get(gu) or [])):
        raise ValueError(f"{gu}에 {dong} 자료가 없어요")
    ov = overrides or {}
    body = {"industry": industry, "gu": gu, "dong": dong or None, "grade": "basic", "delivery": True,
            "own_capital_krw": js_round(float(capital_man) * 10000), "seed": EASY_SEED, "start_month": int(start_month)}
    for k, x in (("pyeong", ov.get("pyeong") or pyeong), ("tables", ov.get("tables")), ("staff", ov.get("staff"))):
        if x is not None:
            body[k] = int(x)
    if ov.get("loan_man") is not None:
        body["extra_loan_krw"] = max(0, js_round(float(ov["loan_man"]) * 10000))
    try:
        pv = gm.preview({k: x for k, x in body.items() if k not in ("seed", "start_month", "extra_loan_krw")})
    except ValueError as e:
        raise ValueError(f"입력 오류: {e}") from e
    inp, k = pv["input"], INDUSTRIES[industry]
    body.update({"pyeong": inp["pyeong"], "tables": inp["tables"], "staff": inp["staff"]})
    given = lambda key: ov.get(key) is not None or (key == "pyeong" and pyeong)  # noqa: E731
    shown = [
        {"key": "pyeong", "label": "평수", "value": inp["pyeong"], "unit": "평", "src": "입력" if given("pyeong") else "업계 자료",
         "basis": OV_BASIS if given("pyeong") else f"경영실태조사 2025 {k['krei_label']} 매장 면적 중앙값"},
        {"key": "tables", "label": "테이블", "value": inp["tables"], "unit": "개", "src": "입력" if given("tables") else "업계 자료",
         "basis": OV_BASIS if given("tables") else f"평당 좌석 수로 어림 (경영실태조사), 테이블당 {pv['seats']['per_table']}석"},
        {"key": "staff", "label": "직원 (사장님 빼고)", "value": inp["staff"], "unit": "명", "src": "입력" if given("staff") else "업계 자료",
         "basis": OV_BASIS if given("staff") else "업종 기본 인원 (경영실태조사 종사자 수)"},
        rent_row(pv["rent"]["man_per_pyeong"], str(pv["rent"]["source"])),
        {"key": "sales", "label": "자리 잡힌 달 매출", "value": round(pv["demand"]["anchor_month_krw"] / 1e4), "unit": "만원", "src": "가정",
         "basis": "경영실태조사 연매출 중앙값(전국) × 서울 배율 × 구 매출 지수(서울시 상권분석서비스) × 면적 효과(탄력성 추정), 추정"},
        {"key": "ticket", "label": "객단가", "value": pv["demand"]["ticket_krw"], "unit": "원", "src": "업계 자료",
         "basis": "경영실태조사 2025 원자료 1인 평균"},
        {"key": "delivery", "label": "배달", "value": "함" if pv["demand"]["delivery_available"] else "거의 없음", "unit": "",
         "src": "업계 자료", "basis": f"매출 중 배달 {pv['demand']['channels']['delivery']:.0%} (경영실태조사)"},
        {"key": "loan", "label": "대출", "value": "모자란 돈 + 석 달 고정비" if ov.get("loan_man") is None else f"운전자금 {float(ov['loan_man']):,.0f}만원",
         "unit": "", "src": "가정" if ov.get("loan_man") is None else "입력", "basis": "5년 원리금 균등, 금리는 한국은행 중소기업 대출금리"},
        {"key": "start_month", "label": "여는 달", "value": int(start_month), "unit": "월", "src": "가정", "basis": "다음 달에 연다고 봄"},
    ]
    return {"industry": industry, "gu": gu, "dong": inp.get("dong"), "capital_man": float(capital_man), "pyeong": inp["pyeong"],
            "tables": inp["tables"], "staff": inp["staff"], "run": body, "shown": shown,
            "opening": [{"key": x["key"], "label": x["item_ko"], "amount": x["krw"] / 1e4} for x in pv["capex"]["lines"]]}


def easy_inputs(industry: str, gu: str, capital_man: float, **kw) -> dict:
    if industry not in INDUSTRY_IDS:
        raise ValueError("업종을 확인해 주세요 (bbq, cafe, " + ", ".join(GENERIC) + ")")
    if industry in GENERIC:
        return easy_generic(industry, gu, capital_man, **kw)
    return (easy_cafe if industry == "cafe" else easy_bbq)(gu, capital_man, **kw)


def _public(month: dict) -> dict:
    return {k: x for k, x in month.items() if not k.startswith("_")}


def run_generic(body: dict) -> dict:
    """새 업종 6개월을 기본 결정으로 (이달의 사건은 기본 대응). 결과의 report.season_summary 가 SeasonSummary 모양이다."""
    from sim.generic import season as gs
    run = gs.start(dict(body))
    start = gs.public_start(run)
    while not run["state"]["closed"] and len(run["months"]) < run["months_total"]:
        run, _ = gs.play_month(run, {})
    return {"start": start, "months": [_public(x) for x in run["months"]], "report": gs.report(run)}


def run_cafe(body: dict, months: int | None = None) -> dict:
    """카페 6개월을 기본 결정으로 돌린다 (CafeSim이 매달 아무것도 바꾸지 않았을 때와 같음)."""
    from sim.cafe import season as cs
    run = cs.start(dict(body))
    n = months or run["months_total"]
    out = []
    while not run["state"]["closed"] and len(run["months"]) < n:
        run, m = cs.play_month(run, {})
        out.append(cs.public_month(m))
    return {"start": cs.public_start(run), "months": out, "report": cs.report(run)}


# ---- 민감도 ---------------------------------------------------------------------------------------------
FACTORS = {
    "bbq": [("customers", "손님 수", "drv_arrival_rate"), ("meat", "고깃값", "cst_meat_cost_per_portion"),
            ("rent", "월세", "drv_rent"), ("labor", "인건비 (시급)", "sto_parttime_wage")],
    "cafe": [("customers", "손님 수", None), ("food", "재료비", "food"), ("rent", "월세", "rent"), ("labor", "인건비", "labor")],
    "generic": [("customers", "손님 수", None), ("food", "재료비", "food"), ("rent", "월세", "rent"), ("labor", "인건비", "labor")],
}
DEFAULT_RANGES = {"customers": 15, "meat": 20, "food": 20, "rent": 10, "labor": 10}
MAX_RANGE = 50


def clean_ranges(industry: str, ranges: dict | None) -> dict[str, float]:
    keys = [k for k, *_ in FACTORS[industry]]
    r = {k: DEFAULT_RANGES[k] for k in keys}
    for k, x in (ranges or {}).items():
        if k in r:
            r[k] = float(min(MAX_RANGE, max(0, float(x))))
    return r


@contextmanager
def _scaled(mult: dict[str, float]):
    """엔진 한 달 설정에 배율을 곱한다. 호출하는 쪽이 엔진 잠금(api.changeup._LOCK)을 잡고 있어야 한다."""
    from sim import season as S
    orig = S._setup
    if not any(abs(f - 1) > 1e-12 for f in mult.values()):
        yield
        return

    def patched(*a, **k):
        su = orig(*a, **k)
        for key, f in mult.items():
            su["params"][key] = su["params"][key] * f
        return su
    S._setup = patched
    try:
        yield
    finally:
        S._setup = orig


def _bbq_cell(spec: dict, plan: dict, start_cash: float, seed: int, mult: dict[str, float], ledger_args: dict) -> dict:
    from sim import season as S
    from sim.venture import venture_ledger
    state = S.new_season(seed, opening=True, cash=max(0.0, start_cash))
    ops, revs = [], []
    with _scaled(mult):
        for _ in range(len(S.months())):
            if state["closed"]:
                break
            r = S.play_month(state, plan, None, night=False, lean=True)
            state = r["state_after"]
            ops.append(float(r["draw"]["kpis"]["op"]))
            revs.append(float(r["draw"]["kpis"]["revenue"]))
    led = venture_ledger(ops, **ledger_args)
    return {"ops": [round(x) for x in ops], "revenue": round(sum(revs)), "cum_op": round(sum(ops)),
            "end_cash": round(led["end_cash"]), "lowest_cash": round(led["lowest_cash"]),
            "closed": bool(state["closed"]), "closed_month": len(ops) if state["closed"] else None}


def sensitivity_bbq(body: dict, ranges: dict | None = None) -> dict:
    """body = /season/run 몸통 (store, plan, invest, own_capital, loan, owner_draw, seed). 엔진 잠금 안에서 부른다."""
    from sim import season as S
    from sim.params import load_params
    from sim.store_input import from_changeup
    r = clean_ranges("bbq", ranges)
    spec = body["store"]
    store, patch = from_changeup(
        gu_sales_man=float(spec["gu_sales_man"]), pyeong=float(spec["pyeong"]), tables=int(spec["tables"]),
        seats=int(spec.get("seats", 0)), cash_rent_man_per_pyeong=float(spec["cash_rent_man_per_pyeong"]),
        staff=int(spec.get("staff", 3)), price=int(spec.get("price", BASE_PRICE)), baseline_runs=int(spec.get("baseline_runs", 150)),
        quarter_index=spec.get("quarter_index"), area_type=spec.get("area_type"), start_month=spec.get("start_month"),
        flow=spec.get("flow"))
    S.set_store(store)
    plan = {**S.base_plan(), **patch, **(body.get("plan") or {})}
    invest = body.get("invest") or {}
    own = float(body.get("own_capital", 0.0))
    loan = body.get("loan")
    start_cash = own + (float(loan["principal"]) if loan else 0.0) - sum(float(x) for x in invest.values())
    led = {"invest": invest, "loan": loan, "own_capital": own, "owner_draw": float(body.get("owner_draw", OWNER_DRAW * 1e4)),
           "imputed_owner_wage": float(load_params()["cst_owner_imputed_wage"])}
    seed = int(body.get("seed", EASY_SEED))
    param = {k: p for k, _, p in FACTORS["bbq"]}
    cell = lambda m: _bbq_cell(spec, plan, start_cash, seed, {param[k]: f for k, f in m.items()}, led)  # noqa: E731
    return _assemble("bbq", r, cell)


def _cafe_months(body: dict, customers_mult: float) -> tuple[dict, list[dict]]:
    """카페 6개월을 기본 결정으로, 엔진의 폐업 판정과 상관없이 끝까지 돈다 (현금과 폐업은 _cafe_cash가 다시 계산)."""
    from sim.cafe import season as cs
    b = dict(body)
    b["daily_customers"] = min(600, max(10, js_round(float(b.get("daily_customers") or 0) * customers_mult))) if b.get("daily_customers") else None
    if b["daily_customers"] is None and abs(customers_mult - 1) > 1e-9:
        raise ValueError("카페 민감도에는 daily_customers가 필요합니다")
    run = cs.start(b)
    months = []
    for _ in range(run["months_total"]):
        if run["state"]["closed"]:   # 비용 배율을 바꾼 경우와 비교하려고 끝까지 돈다. 손님·별점은 현금과 무관하다
            run = {**run, "state": {**run["state"], "closed": False, "negative_months": 0}}
        run, m = cs.play_month(run, {})
        months.append(m)
    return run, months


def _cafe_cash(run: dict, months: list[dict], mult: dict[str, float]) -> dict:
    """비용 줄(food, rent, labor)에 배율을 곱한 영업이익으로 현금과 폐업(현금 마이너스 연속 N달)을 다시 계산한다.
    현금 흐름은 엔진과 같다: 영업이익 + 감가상각(현금 아님) - 대출 이자와 원금 + 부가세 환급."""
    from sim.cafe.season import s as cs_s
    return _recash(run["start"]["cash_krw"], months, mult, cs_s("closure_negative_months"))


def _recash(start_cash: float, months: list[dict], mult: dict[str, float], closure_n: int) -> dict:
    """카페와 새 업종 공통: 그달 비용 줄에 배율을 곱하고 현금 장부와 폐업 규칙을 엔진 식 그대로 다시 돈다."""
    cash = low = start_cash
    neg, ops, rev, closed_at = 0, [], 0, None
    for m in months:
        lines = m.get("_lines_raw") or {x["key"]: x["krw"] for x in m["pnl"]["lines"]}
        op = m["kpi"]["op_krw"] - sum(lines.get(k, 0) * (f - 1) for k, f in mult.items())
        c = m["cash"]
        cash = (cash + op + c["depreciation_addback_krw"] + c.get("owner_pay_addback_krw", 0)  # integrate: lab:cost 사장 가상 급여는 현금 아님
                - c["loan_interest_krw"] - c["loan_principal_krw"] + c.get("vat_refund_krw", 0)
                + (c.get("rent_card") or {}).get("cash_delta", 0))  # integrate: lab:finance 월세 카드 할부
        low = min(low, cash)
        ops.append(round(op))
        rev += m["kpi"]["revenue_krw"]
        neg = neg + 1 if cash < 0 else 0
        if neg >= closure_n:
            closed_at = m["month"]
            break
    return {"ops": ops, "revenue": round(rev), "cum_op": round(sum(ops)), "end_cash": round(cash),
            "lowest_cash": round(low), "closed": closed_at is not None, "closed_month": closed_at}


def sensitivity_cafe(body: dict, ranges: dict | None = None) -> dict:
    """body = sim.cafe.season.start 몸통 (daily_customers 포함). 카페 엔진은 전역 상태가 없어 잠금이 필요 없다."""
    r = clean_ranges("cafe", ranges)
    runs: dict[float, tuple] = {}

    def cell(m: dict[str, float]) -> dict:
        cm = round(m.get("customers", 1.0), 6)
        if cm not in runs:
            runs[cm] = _cafe_months(body, cm)
        return _cafe_cash(*runs[cm], {k: f for k, f in m.items() if k != "customers"})
    return _assemble("cafe", r, cell)


# 새 업종 손님 배율: sim.generic.model.context 의 매출 기준(anchor_krw)에 곱한다. ContextVar라 요청(스레드)마다 따로이고,
# 값을 넣지 않은 다른 요청(하드 모드 시즌, 미리보기)에는 영향이 없다. 처음 쓸 때 한 번만 감싼다.
_GEN_DEMAND: contextvars.ContextVar[float] = contextvars.ContextVar("lab_modes_generic_demand", default=1.0)


def _generic_demand_hook() -> None:
    from sim.generic import model as gm
    if getattr(gm.context, "_lab_modes", False):
        return
    orig = gm.context

    def context(cfg: dict) -> dict:
        ctx = orig(cfg)
        f = _GEN_DEMAND.get()
        return {**ctx, "anchor_krw": ctx["anchor_krw"] * f} if f != 1.0 else ctx
    context._lab_modes = True  # type: ignore[attr-defined]
    context.__wrapped_orig__ = orig  # type: ignore[attr-defined]
    gm.context = context


def _generic_months(body: dict, customers_mult: float) -> tuple[dict, list[dict]]:
    """새 업종 6개월을 기본 결정으로, 엔진의 폐업 판정과 상관없이 끝까지 (현금과 폐업은 _recash가 다시 계산)."""
    from sim.generic import season as gs
    _generic_demand_hook()
    token = _GEN_DEMAND.set(float(customers_mult))
    try:
        run = gs.start(dict(body))
        for _ in range(run["months_total"]):
            if run["state"]["closed"]:
                run["state"].update({"closed": False, "closed_reason": None, "neg_months": 0})
            run, _m = gs.play_month(run, {})
    finally:
        _GEN_DEMAND.reset(token)
    return run, run["months"]


def sensitivity_generic(body: dict, ranges: dict | None = None) -> dict:
    """body = sim.generic.season.start 몸통. 손님은 다시 돌리고, 재료비·월세·인건비는 그달 비용 줄에 배율 (카페와 같은 방식)."""
    from sim.generic import params as gp
    r = clean_ranges("generic", ranges)
    runs: dict[float, tuple] = {}
    n = gp.cv("season", "closure_negative_months")

    def cell(m: dict[str, float]) -> dict:
        cm = round(m.get("customers", 1.0), 6)
        if cm not in runs:
            runs[cm] = _generic_months(body, cm)
        run, months = runs[cm]
        return _recash(run["start_cash_krw"], months, {k: f for k, f in m.items() if k != "customers"}, n)
    out = _assemble("generic", r, cell)
    return {**out, "industry": body.get("industry")}


def _assemble(industry: str, r: dict[str, float], cell) -> dict:
    """한 번에 하나씩 ±(토네이도) + 손님 × 두 번째 요인 3×3 격자. 같은 시드라 칸끼리 차이는 요인 차이다."""
    keys = [k for k, *_ in FACTORS[industry]]
    labels = {k: lab for k, lab, _ in FACTORS[industry]}
    cache: dict[tuple, dict] = {}

    def get(m: dict[str, float]) -> dict:
        key = tuple(round(m.get(k, 1.0), 6) for k in keys)
        if key not in cache:
            cache[key] = cell({k: v for k, v in zip(keys, key)})
        return cache[key]
    base = get({})
    factors = []
    for k in keys:
        pct = r[k]
        lo, hi = get({k: 1 - pct / 100}), get({k: 1 + pct / 100})
        # 좋은 쪽/나쁜 쪽: 손님은 많을수록, 비용은 적을수록 좋다
        good, bad = (hi, lo) if k == "customers" else (lo, hi)
        factors.append({"key": k, "label": labels[k], "pct": pct, "low": lo, "high": hi,
                        "good": "high" if k == "customers" else "low",
                        "swing": good["end_cash"] - bad["end_cash"]})
    y = keys[1]
    steps = lambda k: [1 - r[k] / 100, 1.0, 1 + r[k] / 100]  # noqa: E731
    grid = [[get({"customers": cx, y: cy}) for cx in steps("customers")] for cy in steps(y)]
    worst = get({k: (1 - r[k] / 100 if k == "customers" else 1 + r[k] / 100) for k in keys})
    best = get({k: (1 + r[k] / 100 if k == "customers" else 1 - r[k] / 100) for k in keys})
    return {"industry": industry, "ranges": r, "base": base, "factors": sorted(factors, key=lambda f: -abs(f["swing"])),
            "grid": {"x": {"key": "customers", "label": labels["customers"], "pct": r["customers"]},
                     "y": {"key": y, "label": labels[y], "pct": r[y]}, "cells": grid},
            "worst": worst, "best": best, "runs": len(cache),
            "note": "같은 계획, 같은 사건 순서(시드)로 한 요인씩 바꿔 돌린 값. 범위는 학습자가 정한 가정"}
