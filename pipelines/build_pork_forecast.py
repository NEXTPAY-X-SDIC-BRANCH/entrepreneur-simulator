"""돼지고기 도매가 6개월 예측 + 근거(시기·질병·날씨·공급) → web/public/mock/pork_forecast.json

    python -m pipelines.build_pork_forecast                 # 저장된 자료로 만든다 (키·네트워크 불필요)
    python -m pipelines.build_pork_forecast --fetch-weather # 서울 월별 기온·강수(Open-Meteo, 키 불필요)를 새로 받은 뒤 만든다
    (가격 원자료 갱신: python -m pipelines.fetch_kape_pig)

입력 (모두 저장소 안):
  web/public/mock/kape_pig_monthly.json   축산물품질평가원 경락가(2016.01~)·부위별 도매(2018.10~), fetch_kape_pig.py
  web/public/mock/kosis_pork.json         KOSIS 생활물가지수 돼지고기 (2021.01~)
  web/public/mock/kmta_2026_10.json       한국육류유통수출협회 월간 육류유통 10월호 (업계 전망, 비교용)
  web/public/mock/pig_2026.json           가축동향조사 사육두수 (2026 1·2분기)
  web/public/mock/weather_seoul_monthly.json  서울 월별 기온·강수 (Open-Meteo ERA5 재분석)

예측 대상: 삼겹살 도매 식육포장가격 (전국 평균, 원/kg). 고깃집이 사는 단계의 값이다.
비교 대상: 돼지 지육 경락가격 (전국·제주 제외·등외 제외, 원/kg). 협회·KREI 전망이 쓰는 기준이다.

방법 (둘 다 그 시점까지의 자료만 쓴다):
  (a) 대표님 방식: 작년 같은 달 값 × (1 + 지난 1년 상승률). 상승률 = 최근 12개월 평균 ÷ 그 전 12개월 평균 − 1
      (a') 같은 식에 상승률만 KOSIS 돼지고기 생활물가지수로 바꾼 것 (참고)
  (b) 계절지수 × 추세: 12개월 중심이동평균 대비 달별 비율(계절지수), 최근 3개월 계절조정 평균(수준),
      최근 12개월 ÷ 그 전 12개월 계절조정 평균으로 월 추세
  (n) 기준: 마지막 달 값이 그대로 간다 (비교용)
백테스트: 최근 24개월(그리고 12개월) 각 달을 1~12개월 앞에서 맞혀 본 MAPE. 더 낮은 (a)/(b)를 보여 준다.
범위: 고른 방법의 백테스트 오차(실제 ÷ 예측의 로그) 10~90% 분위 → 80% 범위.
주의: 방법은 오차를 잰 그 24개월로 고른다(화면에 표시). 생활물가지수 t월은 t월 경락가가 닫힌 며칠 뒤 공표되므로,
      기준 달 다음 달 초에 돌리면 미래 정보 없이 같은 계산이 된다.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics as st
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "pork_forecast.json"
WEATHER = MOCK / "weather_seoul_monthly.json"
HORIZON = 12          # 엔진 배수용으로 12개월까지 만든다. 화면은 6개월을 보여 준다
SHOW = 6
BACKTEST_MONTHS = 24

SRC = {
    "kape_auction": {"title": "돼지 경락가격 기간별 (탕박, 등급별)", "publisher": "축산물품질평가원 축산유통정보",
                     "url": "https://www.ekapepia.com/v3/price/auction/period/pig/auctionPrice.do"},
    "kape_part": {"title": "돼지 부위별 도매 식육포장가격 (월별)", "publisher": "축산물품질평가원 축산유통정보",
                  "url": "https://www.ekapepia.com/v3/price/livestock/pig/wholesale/partPrice.do"},
    "kosis_cpi": {"title": "소비자물가조사 생활물가지수 돼지고기 (DT_1J22005)", "publisher": "국가데이터처 KOSIS",
                  "url": "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_1J22005"},
    "kmta": {"title": "월간 육류유통 2026년 10월호 (Vol.135)", "publisher": "(사)한국육류유통수출협회", "url": None},
    "pig_herd": {"title": "가축동향조사 돼지 사육 마릿수 (2026.07.28 갱신)", "publisher": "국가데이터처 · 축산물품질평가원 통계DB",
                 "url": "https://www.ekapepia.com/v3/supplyTrend/productTrend/breedingCount/pig.do"},
    "open_meteo": {"title": "Historical Weather API (ERA5 재분석), 서울 37.57N 126.97E", "publisher": "Open-Meteo",
                   "url": "https://open-meteo.com/en/docs/historical-weather-api"},
    "kasi": {"title": "특일 정보 (설·추석 날짜)", "publisher": "한국천문연구원 (data.go.kr 15012690)",
             "url": "https://www.data.go.kr/data/15012690/openapi.do"},
}

# 질병 사건: 날짜와 출처 링크를 확인한 것만 (2026-10-21 curl 확인). 예측에는 넣지 않고 과거 가격 움직임만 보여 준다.
EVENTS = [
    {"date": "2019-09-17", "kind": "ASF", "species": "돼지", "label": "아프리카돼지열병 국내 첫 발생 (경기 파주 양돈농장)",
     "note": "발생 직후 전국 돼지 일시이동중지 48시간",
     "source": {"title": "국내 첫 돼지열병 발생 농장·가족 농장 등 4700마리 살처분", "publisher": "뉴시스 (2019.09.17)",
                "url": "https://www.newsis.com/view/NISX20190917_0000771365"}},
    {"date": "2023-05-10", "kind": "FMD", "species": "한우", "label": "구제역 4년 만에 발생 (충북 청주 한우농장)",
     "note": "돼지 농장 발생은 아님. 전국 우제류 일시이동중지 48시간",
     "source": {"title": "4년 만에 한우 구제역 발생", "publisher": "서울신문 (2023.05.11)",
                "url": "https://m.seoul.co.kr/news/2023/05/11/20230511500173"}},
    {"date": "2025-01-28", "kind": "ASF", "species": "돼지", "label": "아프리카돼지열병 양돈농장 발생 (경기 양주)",
     "note": "2025년 1~3월 양주에서 양돈농장 발생이 이어짐",
     "source": {"title": "경기 양주 양돈농장 아프리카돼지열병 발생", "publisher": "농림축산식품부 (2025.01.28)",
                "url": "https://mafra.go.kr/bbs/FMD-AI2/425/573127/artclView.do"}},
    {"date": "2025-03-14", "kind": "FMD", "species": "한우", "label": "구제역 발생 (전남 영암 한우농장, 1년 10개월 만)",
     "note": "돼지 농장 발생은 아님. 영암·무안 10건까지 늘어남",
     "source": {"title": "전남 영암군 한우 농장 구제역 발생", "publisher": "농림축산식품부 (2025.03.14)",
                "url": "https://www.mafra.go.kr/bbs/FMD-AI2/395/573546/artclView.do"}},
    {"date": "2025-07-16", "kind": "ASF", "species": "돼지", "label": "아프리카돼지열병 양돈농장 발생 (경기 파주)",
     "note": "",
     "source": {"title": "경기 파주 양돈농장 아프리카돼지열병 발생", "publisher": "농림축산식품부 (2025.07.16)",
                "url": "https://mafra.go.kr/bbs/FMD-AI2/425/574656/artclView.do"}},
    {"date": "2025-09-14", "kind": "ASF", "species": "돼지", "label": "아프리카돼지열병 양돈농장 발생 (경기 연천)",
     "note": "",
     "source": {"title": "경기 연천 양돈농장 아프리카돼지열병 발생", "publisher": "농림축산식품부 (2025.09.15)",
                "url": "https://www.mafra.go.kr/bbs/FMD-AI2/425/575079/artclView.do"}},
    {"date": "2026-01-31", "kind": "FMD", "species": "소", "label": "구제역 발생 (인천 강화 소 농장, 2026년 첫 발생)",
     "note": "돼지 농장 발생은 아님",
     "source": {"title": "인천 강화 소 농장에서 올해 첫 구제역 발생에 따라 방역 강화", "publisher": "농림축산식품부 (2026.01.31)",
                "url": "https://www.mafra.go.kr/bbs/FMD-AI2/395/576765/artclView.do"}},
    {"date": "2026-07-06", "kind": "FMD", "species": "돼지·소", "label": "구제역 발생 (경북 예천 돼지·소 농장, 2026년 첫 돼지농장 발생)",
     "note": "",
     "source": {"title": "경북서 11년 만에 구제역 발생…예천 돼지·소 농장서 양성 확인", "publisher": "쿠키뉴스 (2026.07.06)",
                "url": "https://www.kukinews.com/article/view/kuk202607060015"}},
]

# 추석·설 (본날). 2026~2027은 한국천문연구원 특일 정보(holidays.json)와 같다. 그 전 해는 같은 기관 발표 날짜.
CHUSEOK = {2016: "09-15", 2017: "10-04", 2018: "09-24", 2019: "09-13", 2020: "10-01", 2021: "09-21",
           2022: "09-10", 2023: "09-29", 2024: "09-17", 2025: "10-06", 2026: "09-25", 2027: "09-15"}
SEOLLAL = {2016: "02-08", 2017: "01-28", 2018: "02-16", 2019: "02-05", 2020: "01-25", 2021: "02-12",
           2022: "02-01", 2023: "01-22", 2024: "02-10", 2025: "01-29", 2026: "02-17", 2027: "02-07"}


# --- month arithmetic ---------------------------------------------------------------------------------------
def ym_add(ym: str, k: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    t = y * 12 + (m - 1) + k
    return f"{t // 12}-{t % 12 + 1:02d}"


def ym_key(ym: str) -> str:
    return ym.replace("-", "")


def contiguous(series: dict[str, float]) -> list[tuple[str, float]]:
    """가장 긴 끝쪽 연속 구간 (빈 달이 있으면 그 뒤부터)."""
    ks = sorted(series)
    out = [(ks[-1], series[ks[-1]])]
    for k in reversed(ks[:-1]):
        if ym_add(k, 1) != out[-1][0]:
            break
        out.append((k, series[k]))
    return list(reversed(out))


# --- methods: each takes the values up to the origin (inclusive) and returns forecasts for h = 1..H ------------
def seasonal_index(vals: list[float], months: list[int]) -> dict[int, float]:
    """2x12 중심이동평균 대비 비율의 달별 평균, 평균 1로 맞춤. 자료 24개월 이상 필요."""
    ratios: dict[int, list[float]] = {m: [] for m in range(1, 13)}
    n = len(vals)
    for i in range(6, n - 6):
        ma = (sum(vals[i - 6:i + 6]) + sum(vals[i - 5:i + 7])) / 24.0
        ratios[months[i]].append(vals[i] / ma)
    idx = {m: (st.mean(r) if r else 1.0) for m, r in ratios.items()}
    mean = st.mean(idx.values())
    return {m: v / mean for m, v in idx.items()}


def f_naive(vals: list[float], months: list[int], H: int, **_) -> list[float]:
    return [vals[-1]] * H


def f_ceo(vals: list[float], months: list[int], H: int, infl: float | None = None, **_) -> list[float]:
    """작년 같은 달 × (1 + 지난 1년 상승률). infl이 주어지면 그 상승률(예: 생활물가지수)을 쓴다."""
    if infl is None:
        infl = st.mean(vals[-12:]) / st.mean(vals[-24:-12]) - 1
    return [vals[-12 + h - 1] * (1 + infl) for h in range(1, H + 1)]


def f_seasonal(vals: list[float], months: list[int], H: int, **_) -> list[float]:
    s = seasonal_index(vals, months)
    de = [v / s[m] for v, m in zip(vals, months)]
    level = st.mean(de[-3:])                                  # 가운데가 마지막 달 1개월 전
    g = (st.mean(de[-12:]) / st.mean(de[-24:-12])) ** (1 / 12)
    out = []
    for h in range(1, H + 1):
        m = (months[-1] - 1 + h) % 12 + 1
        out.append(level * g ** (h + 1) * s[m])
    return out


METHODS = {"ceo": f_ceo, "seasonal": f_seasonal, "naive": f_naive}
CANDIDATES = ("ceo", "ceo_cpi", "seasonal")   # 보여 줄 예측 후보. naive는 비교 기준으로만 쓴다


def predict(method: str, vals: list[float], months: list[int], H: int, origin: str,
            cpi_yoy: dict[str, float] | None = None) -> list[float] | None:
    """ceo_cpi = 대표님 방식에서 상승률만 KOSIS 돼지고기 생활물가지수(그 달까지 12개월 ÷ 그 전 12개월)로 바꾼 것."""
    if method == "ceo_cpi":
        infl = (cpi_yoy or {}).get(origin)
        return None if infl is None else f_ceo(vals, months, H, infl=infl)
    return METHODS[method](vals, months, H)
MIN_TRAIN = 36   # 계절지수(중심이동평균 양끝 6개월 제외)와 24개월 상승률을 함께 쓰려면 3년은 있어야 한다


def backtest(points: list[tuple[str, float]], method: str, *, H: int = HORIZON, last: int = BACKTEST_MONTHS,
             cpi_yoy: dict[str, float] | None = None) -> dict:
    """최근 `last`개월 각 달 t를 h개월 앞(t-h 시점까지의 자료만)에서 예측해 본다."""
    yms = [p[0] for p in points]
    vals = [p[1] for p in points]
    months = [int(p[0][5:7]) for p in points]
    n = len(points)
    errs: dict[int, list[float]] = {h: [] for h in range(1, H + 1)}
    logres: dict[int, list[float]] = {h: [] for h in range(1, H + 1)}
    rows = []
    for ti in range(n - last, n):
        for h in range(1, H + 1):
            oi = ti - h
            if oi + 1 < MIN_TRAIN:
                continue
            fc = predict(method, vals[:oi + 1], months[:oi + 1], h, yms[oi], cpi_yoy)
            if fc is None:
                continue
            f = fc[h - 1]
            a = vals[ti]
            errs[h].append(abs(a - f) / a)
            logres[h].append(math.log(a / f))
            rows.append((yms[ti], h, f))
    def mape(hs, only_last=None):
        e = []
        for h in hs:
            xs = errs[h] if only_last is None else errs[h][-only_last:]
            e += xs
        return round(100 * st.mean(e), 2) if e else None
    return {"method": method, "n": sum(len(v) for v in errs.values()),
            "mape_1_6": mape(range(1, SHOW + 1)), "mape_1_12": mape(range(1, H + 1)),
            "mape_1_6_last12": mape(range(1, SHOW + 1), only_last=12),
            "by_h": {h: (round(100 * st.mean(errs[h]), 2) if errs[h] else None) for h in errs},
            "_logres": logres}


def quantile(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    if not xs:
        return 0.0
    pos = (len(xs) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def forecast_band(points: list[tuple[str, float]], method: str, logres: dict[int, list[float]],
                  cpi_yoy: dict[str, float] | None = None) -> dict[str, dict]:
    vals = [p[1] for p in points]
    months = [int(p[0][5:7]) for p in points]
    mids = predict(method, vals, months, HORIZON, points[-1][0], cpi_yoy)
    if mids is None:
        raise SystemExit(f"{method}: 기준 달 {points[-1][0]}의 물가 자료가 없어요")
    out = {}
    for h, mid in enumerate(mids, start=1):
        r = logres.get(h) or []
        lo_q, hi_q = quantile(r, 0.10), quantile(r, 0.90)
        out[ym_key(ym_add(points[-1][0], h))] = {"mid": round(mid), "lo": round(mid * math.exp(min(lo_q, 0.0))),
                                                  "hi": round(mid * math.exp(max(hi_q, 0.0))), "h": h}
    return out


def evaluate(points: list[tuple[str, float]], cpi_yoy: dict[str, float] | None, force: str | None = None) -> dict:
    cpi_yoy = cpi_yoy or {}
    res = {m: backtest(points, m, cpi_yoy=cpi_yoy) for m in ("ceo", "ceo_cpi", "seasonal", "naive")}
    cands = [m for m in CANDIDATES if m in res and res[m]["mape_1_6"] is not None
             and (m != "ceo_cpi" or cpi_yoy.get(points[-1][0]) is not None)]
    pick = force if force in cands else min(cands, key=lambda m: res[m]["mape_1_6"])
    band = forecast_band(points, pick, res[pick]["_logres"], cpi_yoy)
    vals = [p[1] for p in points]
    months = [int(p[0][5:7]) for p in points]
    alts = {}
    for m in cands:
        if m != pick:
            fc = predict(m, vals, months, HORIZON, points[-1][0], cpi_yoy) or []
            alts[m] = {ym_key(ym_add(points[-1][0], h)): round(v) for h, v in enumerate(fc, 1)}
    for r in res.values():
        r.pop("_logres", None)
    return {"pick": pick, "backtest": res, "forecast": band, "forecast_other": alts}


# --- inputs ------------------------------------------------------------------------------------------------
def load(name: str) -> dict:
    return json.loads((MOCK / name).read_text(encoding="utf-8"))


def cpi_yoy_by_month() -> dict[str, float]:
    """KOSIS 돼지고기 생활물가지수(전국): 최근 12개월 평균 ÷ 그 전 12개월 평균 − 1, 'YYYY-MM' 기준."""
    s = load("kosis_pork.json")["series"]["돼지고기|전국"]
    ks = sorted(s)
    out = {}
    for i in range(23, len(ks)):
        a = st.mean(s[k] for k in ks[i - 11:i + 1])
        b = st.mean(s[k] for k in ks[i - 23:i - 11])
        out[f"{ks[i][:4]}-{ks[i][4:]}"] = a / b - 1
    return out


def fetch_weather() -> None:
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude=37.5714&longitude=126.9658&start_date=2016-01-01"
           f"&end_date={date.today().isoformat()}&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum&timezone=Asia%2FSeoul")
    d = json.loads(urllib.request.urlopen(url, timeout=120).read().decode("utf-8"))["daily"]
    acc: dict[str, dict[str, list[float]]] = {}
    for t, tm, tx, pr in zip(d["time"], d["temperature_2m_mean"], d["temperature_2m_max"], d["precipitation_sum"]):
        if tm is None:
            continue
        a = acc.setdefault(t[:7], {"t": [], "x": [], "p": []})
        a["t"].append(tm); a["x"].append(tx); a["p"].append(pr or 0.0)
    months = {k: {"t_mean": round(st.mean(v["t"]), 2), "hot_days": sum(1 for x in v["x"] if x >= 33.0),
                  "rain_mm": round(sum(v["p"]), 1), "days": len(v["t"])}
              for k, v in sorted(acc.items()) if len(v["t"]) >= 28}
    WEATHER.write_text(json.dumps({"_meta": {"source": SRC["open_meteo"], "generated": date.today().isoformat(),
                                             "note": "ERA5 재분석 일자료를 달별로 묶음. 폭염일 = 최고기온 33도 이상. 기상청 관측값과 조금 다를 수 있다"},
                                   "months": months}, ensure_ascii=False, indent=1), encoding="utf-8")


def corr(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 8:
        return None
    mx, my = st.mean(xs), st.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy), 2) if sx and sy else None


def deseason_resid(points: list[tuple[str, float]]) -> dict[str, float]:
    """가격의 '계절·추세 밖' 움직임: log(값 ÷ 2x12 중심이동평균) − 그 달 계절 로그지수."""
    vals = [p[1] for p in points]; months = [int(p[0][5:7]) for p in points]
    s = seasonal_index(vals, months)
    out = {}
    for i in range(6, len(vals) - 6):
        ma = (sum(vals[i - 6:i + 6]) + sum(vals[i - 5:i + 7])) / 24.0
        out[points[i][0]] = math.log(vals[i] / ma) - math.log(s[months[i]])
    return out


def pct(a: float, b: float) -> float:
    return round(100 * (a / b - 1), 1)


def won(x: float) -> str:
    return f"{round(x):,}원"


# --- build -------------------------------------------------------------------------------------------------
def build() -> dict:
    raw = load("kape_pig_monthly.json")
    parts = raw["parts"]
    belly = contiguous({k: float(v) for k, v in parts["삼겹살"].items()})
    carcass = [(r["month"], float(r["exj_ex_out"])) for r in raw["series"] if r.get("exj_ex_out")]
    heads = {r["month"]: float(r["exj_ex_out_n"]) for r in raw["series"] if r.get("exj_ex_out_n")}
    cpi = cpi_yoy_by_month()
    basis = belly[-1][0]

    ev_b = evaluate(belly, cpi)
    ev_c = evaluate(carcass, cpi, force=ev_b["pick"])   # 화면에는 방법 하나만: 지육도 삼겹에서 고른 방법으로
    latest = raw.get("latest") or {}
    mtd = latest.get("carcass_mtd") if (latest.get("carcass_mtd") or {}).get("exj_ex_out") else None

    # 시기: 계절지수 (삼겹 도매, 지육)
    s_b = seasonal_index([p[1] for p in belly], [int(p[0][5:7]) for p in belly])
    s_c = seasonal_index([p[1] for p in carcass], [int(p[0][5:7]) for p in carcass])
    hi_m = max(s_b, key=s_b.get); lo_m = min(s_b, key=s_b.get)
    summer = st.mean(s_b[m] for m in (5, 6, 7, 8)); winter = st.mean(s_b[m] for m in (12, 1, 2))
    # 추석: 출하가 몰리는 '추석 앞 달'(추석이 10일 이전이면 전달) 지육가를 그 전달과 비교. 대부분 9월이라 대조군은 없다
    cmap = dict(carcass)
    holi = []
    for y, md in CHUSEOK.items():
        mm, dd = int(md[:2]), int(md[3:])
        buy = f"{y}-{mm:02d}" if dd > 10 else ym_add(f"{y}-{mm:02d}", -1)
        prev = ym_add(buy, -1)
        if buy in cmap and prev in cmap:
            holi.append({"year": y, "chuseok": f"{y}-{md}", "month": buy, "change_pct": pct(cmap[buy], cmap[prev])})
    holi_avg = round(st.mean(h["change_pct"] for h in holi), 1) if holi else None
    holi_up = sum(1 for h in holi if h["change_pct"] > 0)

    # 질병: 발생 달 기준 전후 지육가 (기록만)
    resid = deseason_resid(carcass)
    events = []
    for e in EVENTS:
        m0 = e["date"][:7]
        before, after = ym_add(m0, -1), ym_add(m0, 2)
        row = dict(e)
        if before in cmap and after in cmap:
            row["price_before"] = round(cmap[before]); row["price_after"] = round(cmap[after])
            row["change_pct"] = pct(cmap[after], cmap[before])
            row["window"] = f"{before} → {after}"
            if before in resid and after in resid:
                row["deseason_change_pct"] = round(100 * (math.exp(resid[after] - resid[before]) - 1), 1)
        events.append(row)

    # 날씨: 서울 월평균기온 편차(2016~2025 같은 달 평균 대비) vs 지육가 계절·추세 밖 움직임
    weather_ev = None
    if WEATHER.exists():
        w = json.loads(WEATHER.read_text(encoding="utf-8"))["months"]
        clim = {m: st.mean(v["t_mean"] for k, v in w.items() if int(k[5:]) == m and k < "2026") for m in range(1, 13)}
        hot_clim = {m: st.mean(v["hot_days"] for k, v in w.items() if int(k[5:]) == m and k < "2026") for m in range(1, 13)}
        out = {}
        for lag in (0, 1, 2):
            xs, ys = [], []
            for k, v in w.items():
                t = ym_add(k, lag)
                if t in resid:
                    xs.append(v["t_mean"] - clim[int(k[5:])]); ys.append(resid[t])
            out[lag] = (corr(xs, ys), len(xs))
        xs, ys = [], []
        for k, v in w.items():
            if int(k[5:]) in (6, 7, 8, 9):
                t = ym_add(k, 1)
                if t in resid:
                    xs.append(v["hot_days"] - hot_clim[int(k[5:])]); ys.append(resid[t])
        hot = (corr(xs, ys), len(xs))
        weather_ev = {"temp_anom_corr": {str(l): {"r": r, "n": n} for l, (r, n) in out.items()},
                      "hot_days_next_month_corr": {"r": hot[0], "n": hot[1]}}

    # 공급: 경락두수(제주 제외, 등외 제외) 계절·추세 밖 움직임 vs 가격
    hpts = sorted(heads.items())
    hres = deseason_resid(hpts)
    common = [k for k in resid if k in hres]
    supply_r = corr([hres[k] for k in common], [resid[k] for k in common])
    herd = {f["id"]: f["text"] for f in load("pig_2026.json")["facts"] if f["id"].startswith("pig_national")}
    kmta = {f["id"]: f for f in load("kmta_2026_10.json")["facts"]}

    # 부위별 시세
    parts_out = {}
    for name, ser in parts.items():
        ks = sorted(ser)
        last, prev = ks[-1], ks[-2]
        yo = ym_add(last, -12)
        parts_out[name] = {"latest": ser[last], "month": last, "mom_pct": pct(ser[last], ser[prev]),
                           "yoy_pct": pct(ser[last], ser[yo]) if yo in ser else None,
                           "history": {ym_key(k): ser[k] for k in ks[-25:]}}

    # 엔진 배수: 달(1~12) → 기준 달 값 대비 예측 중간값 (기준 = 마지막 실제 달 삼겹 도매가)
    base = belly[-1][1]
    mult = {}
    for k, f in ev_b["forecast"].items():
        mult[str(int(k[4:]))] = round(f["mid"] / base, 4)

    pick_label = PICK_LABEL
    bb = ev_b["backtest"]
    c = ev_c["forecast"]
    oct_key = ym_key(ym_add(carcass[-1][0], 1))
    kmta_fc = kmta.get("kmta_pork_carcass_forecast_oct")
    drivers = [
        {"kind": "season", "label": "시기: 여름에 비싸고 겨울에 싸요",
         "summary": f"삼겹살 도매가는 {hi_m}월에 연중 평균보다 {round(100 * (s_b[hi_m] - 1))}% 비싸고, {lo_m}월에 {round(100 * (1 - s_b[lo_m]))}% 싸요.",
         "evidence": (f"삼겹살 도매가 계절지수(1.00 = 연중 평균)는 {hi_m}월이 가장 높고({s_b[hi_m]:.2f}) {lo_m}월이 가장 낮아요({s_b[lo_m]:.2f}). "
                      f"5~8월 평균 {summer:.2f}, 12~2월 평균 {winter:.2f}. 여름 휴가·캠핑 수요 때문이라는 설명은 가정이에요(이 화면에서 따로 재지 않음). "
                      f"지육은 추석 앞 달(출하가 몰리는 달)에 전달보다 평균 {holi_avg:+.1f}% 움직였어요 "
                      f"({len(holi)}해 중 {holi_up}해 상승). 해마다 차이가 커서 추석만으로 값이 오른다고 보기는 어려워요."),
         "data": {"seasonal_index_belly": {str(m): round(v, 3) for m, v in s_b.items()},
                  "seasonal_index_carcass": {str(m): round(v, 3) for m, v in s_c.items()},
                  "chuseok": holi, "chuseok_avg_pct": holi_avg, "chuseok_up_years": holi_up},
         "basis": "공공 통계에서 계산",
         "sources": [SRC["kape_part"], SRC["kape_auction"], SRC["kasi"]]},
        {"kind": "disease", "label": "질병: 예측에 넣지 않고 지난 기록만 보여 줘요",
         "summary": "ASF·구제역은 언제 올지 알 수 없어서 예측에 넣지 않았어요. 아래는 발생 전후 지육가 기록이에요.",
         "evidence": ("ASF·구제역 같은 사건은 언제 올지 미리 알 수 없어서 예측에는 넣지 않았어요. "
                      "아래는 발생 전달과 2개월 뒤 지육가를 비교한 기록이에요. 같은 시기 계절·수요 변화가 섞여 있어 질병 때문이라고 단정할 수 없어요."),
         "data": {"events": events},
         "basis": "공공 통계 + 정부 발표·보도",
         "sources": [SRC["kape_auction"]] + [e["source"] for e in EVENTS]},
        {"kind": "weather", "label": _weather_label(weather_ev),
         "summary": _weather_summary(weather_ev),
         "evidence": (_weather_text(weather_ev) if weather_ev else "날씨 자료가 없어 계산하지 못했어요."),
         "data": weather_ev, "basis": "재분석 기상자료 + 공공 통계에서 계산",
         "sources": [SRC["open_meteo"], SRC["kape_auction"]]},
        {"kind": "supply", "label": f"공급: 출하 마릿수와 값, 관련이 {'약해요' if abs(supply_r or 0) < 0.3 else '조금 있어요'}",
         "summary": f"출하 마릿수가 평소보다 많은 달은 지육가가 조금 낮았지만 관련은 약해요 (r = {supply_r}).",
         "evidence": (f"계절·추세를 뺀 경락 마릿수와 지육가의 상관계수 r = {supply_r} (같은 달, {len(common)}개월, "
                      f"{_strength(supply_r)}). "
                      f"{herd.get('pig_national_change_q1_q2', '')}"),
         "data": {"heads_price_corr": supply_r, "n": len(common), "herd": herd},
         "basis": "공공 통계에서 계산",
         "sources": [SRC["kape_auction"], SRC["pig_herd"]]},
    ]
    if kmta_fc:
        drivers.append({"kind": "outlook", "label": "업계 전망·이번 달 실제와 비교",
                        "summary": _outlook_summary(c[oct_key], mtd, oct_key),
                        "evidence": (f"같은 지육 기준(전국, 제주·등외 제외), 같은 방법({PICK_LABEL[ev_b['pick']]})으로 낸 10월 예측은 "
                                     f"{won(c[oct_key]['mid'])} (80% 범위 {won(c[oct_key]['lo'])}~{won(c[oct_key]['hi'])})예요. "
                                     f"협회 자료: {kmta_fc['text']} "
                                     + (f"이번 달 실제({mtd['from'][5:].replace('-', '.')}~{mtd['to'][5:].replace('-', '.')}) 평균은 {won(mtd['exj_ex_out'])}이에요. " if mtd else "")
                                     + f"{kmta.get('kmta_pork_2026_forecast', {}).get('text', '')}"),
                        "data": {"kmta_oct": kmta_fc["text"], "ours_oct": c.get(oct_key), "carcass_mtd": mtd},
                        "basis": "업계 자료 + 공공 통계",
                        "sources": [{**SRC["kmta"], "page": kmta_fc.get("page")}, SRC["kape_auction"]]})

    return {
        "_meta": {
            "source": "축산물품질평가원 축산유통정보 돼지 부위별 도매 식육포장가격(삼겹살, 전국 평균, 월별)",
            "unit": "원/kg",
            "series": "삼겹살 도매 (식육포장)",
            "method": pick_label[ev_b["pick"]],
            "method_key": ev_b["pick"],
            "backtest_mape": bb[ev_b["pick"]]["mape_1_6"],
            "backtest_note": f"최근 {BACKTEST_MONTHS}개월 각 달을 1~6개월 앞에서 맞혀 본 평균 절대 오차율(%)",
            "interval": "백테스트 오차 10~90% 분위 (80% 범위)",
            "selection_note": ("방법은 오차를 잰 그 24개월로 골랐어요. 그래서 이 오차는 앞으로 실제로 나올 오차보다 조금 낙관적이에요."),
            "basis_date": basis,
            "generated": date.today().isoformat(),
            "history_from": belly[0][0],
            "pipeline": "pipelines/fetch_kape_pig.py → pipelines/build_pork_forecast.py",
            "label": "공공 통계 + 계산 (예측값은 모형 추정이에요)",
        },
        "history": {ym_key(k): round(v) for k, v in belly},
        "forecast": {k: v for k, v in ev_b["forecast"].items() if v["h"] <= SHOW},
        "forecast_12": ev_b["forecast"],
        "forecast_other": {m: {"method": PICK_LABEL[m], "values": v} for m, v in ev_b["forecast_other"].items()},
        "backtest": bb,
        "carcass": {"series": "돼지 지육 경락가 (전국, 제주·등외 제외)", "unit": "원/kg",
                    "history": {ym_key(k): round(v) for k, v in carcass},
                    "forecast": {k: v for k, v in c.items() if v["h"] <= SHOW},
                    "method_key": ev_c["pick"], "backtest": ev_c["backtest"], "source": SRC["kape_auction"]},
        "parts": parts_out,
        "parts_source": SRC["kape_part"],
        "cost_mult": {"base_month": basis, "base_value": round(base), "by_month": mult,
                      "next6_mean": round(st.mean(f["mid"] for f in ev_b["forecast"].values() if f["h"] <= SHOW) / base, 3),
                      "last_year_next6_mean": _last_year_ratio(dict(belly), basis),
                      "note": ("가정: 엔진의 국산 삼겹 1인분 원가(4,500원/200g = 22,500원/kg)를 기준 달 도매가와 같은 수준으로 보고 비율을 곱한다. "
                               "기준 달(9월)은 연중 비싼 달이라 켜면 다음 6개월 고기 원가가 평균적으로 낮아진다")},
        "latest": _latest_block(latest, ev_b["forecast"]),
        "drivers": drivers,
    }


PICK_LABEL = {"ceo": "대표님 방식 변형 (작년 같은 달 × 도매가 상승률)",
              "ceo_cpi": "대표님 방식 (작년 같은 달 × 물가 상승률)",
              "seasonal": "계절지수 × 추세", "naive": "지난달 값 그대로 (비교 기준)"}


KMTA_OCT = (5900, 6100)   # kmta_2026_10.json kmta_pork_carcass_forecast_oct (p.57)


def _last_year_ratio(series: dict[str, float], basis: str) -> float | None:
    """작년 같은 기준 달 대비 그 뒤 6개월 실제 평균 (켰을 때 원가가 낮아지는 폭이 과거에도 있었는지 보는 근거)."""
    b = ym_add(basis, -12)
    nxt = [series.get(ym_add(b, h)) for h in range(1, SHOW + 1)]
    if b not in series or any(v is None for v in nxt):
        return None
    return round(st.mean(nxt) / series[b], 3)


def _latest_block(latest: dict, fc: dict[str, dict]) -> dict:
    """가장 최근 주의 삼겹 도매 실제 값과, 그 주가 속한 달 예측 범위의 비교. 화면 '최근 실제' 줄."""
    weeks = latest.get("belly_weeks") or []
    out: dict = {"fetched": latest.get("fetched"), "belly_weeks": weeks, "carcass_mtd": latest.get("carcass_mtd")}
    if weeks:
        w = weeks[0]
        # 주 범위 끝 날짜의 달 (예: "9/28 ~ 10/4" → 10월)
        end_m = int(w["range"].split("~")[-1].strip().split("/")[0]) if "~" in w["range"] else None
        key = next((k for k in fc if end_m and int(k[4:]) == end_m), None)
        if key:
            f = fc[key]
            out["belly_vs"] = {"month": key, "lo": f["lo"], "hi": f["hi"], "mid": f["mid"],
                               "where": "in" if f["lo"] <= w["belly"] <= f["hi"] else ("above" if w["belly"] > f["hi"] else "below")}
    return out


def _vs(f: dict, rng: tuple[int, int]) -> str:
    if f["hi"] < rng[0]:
        return "협회 전망보다 낮아요"
    if f["lo"] > rng[1]:
        return "협회 전망보다 높아요"
    if f["mid"] < rng[0]:
        return "가운데 값은 협회 전망보다 낮고 범위는 겹쳐요"
    if f["mid"] > rng[1]:
        return "가운데 값은 협회 전망보다 높고 범위는 겹쳐요"
    return "협회 전망 범위 안이에요"


def _outlook_summary(f: dict, mtd: dict | None, key: str) -> str:
    s = f"10월 지육: 협회 전망 {KMTA_OCT[0]:,}~{KMTA_OCT[1]:,}원, 이 화면 예측 {won(f['mid'])}({_vs(f, KMTA_OCT)})."
    if mtd and mtd["month"].replace("-", "") == key:
        a = mtd["exj_ex_out"]
        where = "예측 범위 안" if f["lo"] <= a <= f["hi"] else ("예측 범위보다 높아요" if a > f["hi"] else "예측 범위보다 낮아요")
        s += f" 10월 1~{int(mtd['to'][8:])}일 실제는 {won(a)}으로 {where}{'' if where.endswith('요') else '이에요'}."
    return s


def _strength(r: float | None) -> str:
    a = abs(r or 0)
    return "관련 거의 없음" if a < 0.1 else "약함" if a < 0.3 else "중간" if a < 0.5 else "강함"


def _weather_label(w: dict | None) -> str:
    if not w:
        return "날씨: 자료 없음"
    h = w["hot_days_next_month_corr"]["r"] or 0
    t = max(abs(v["r"] or 0) for v in w["temp_anom_corr"].values())
    if t < 0.3 and h >= 0.3:
        return "날씨: 관련이 약해요 (폭염 다음 달만 조금)"
    return "날씨: 관련이 약해요" if max(t, abs(h)) < 0.3 else "날씨: 기온과 조금 관련 있어요"


def _weather_summary(w: dict | None) -> str:
    if not w:
        return "날씨 자료가 없어요."
    h = w["hot_days_next_month_corr"]
    return (f"기온 자체와 도매가의 관련은 약하고, 폭염일이 많았던 여름 다음 달에 지육가가 조금 높았어요 "
            f"(r = {h['r']}, {h['n']}개월). 예측에는 넣지 않았어요.")


def _weather_text(w: dict) -> str:
    t = w["temp_anom_corr"]; h = w["hot_days_next_month_corr"]
    return (f"서울 월평균기온 편차(평년 대비)와 계절·추세를 뺀 지육가 움직임의 상관계수 r: "
            f"같은 달 {t['0']['r']}, 1개월 뒤 {t['1']['r']}, 2개월 뒤 {t['2']['r']} ({t['0']['n']}개월, 약함). "
            f"여름(6~9월) 폭염일 편차와 다음 달 움직임 r = {h['r']} ({h['n']}개월, {_strength(h['r'])}). "
            f"더위에 돼지가 덜 자라 출하가 줄어든다는 설명은 가정이고, 네 가지를 재 본 결과라 우연일 수도 있어요. "
            f"그래서 예측에는 넣지 않았어요. 계절에 섞인 날씨 효과(여름 더위·캠핑 수요)는 '시기'에 이미 들어 있어요.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch-weather", action="store_true")
    a = ap.parse_args()
    if a.fetch_weather or not WEATHER.exists():
        fetch_weather()
    doc = build()
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    bt = doc["backtest"]
    print("기준 달", doc["_meta"]["basis_date"], "| 고른 방법", doc["_meta"]["method_key"])
    for k, r in bt.items():
        print(f"  삼겹 {k:9s} MAPE 1~6개월 {r['mape_1_6']}% (최근12 {r['mape_1_6_last12']}%), 1~12 {r['mape_1_12']}%, n={r['n']}")
    for k, r in doc["carcass"]["backtest"].items():
        print(f"  지육 {k:9s} MAPE 1~6개월 {r['mape_1_6']}% (최근12 {r['mape_1_6_last12']}%), 1~12 {r['mape_1_12']}%")
    print("  예측", {k: v["mid"] for k, v in doc["forecast"].items()})
    print("  배수", doc["cost_mult"]["by_month"])


if __name__ == "__main__":
    main()
