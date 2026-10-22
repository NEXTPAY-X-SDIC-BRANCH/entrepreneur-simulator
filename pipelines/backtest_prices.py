"""원가 시세 예측 검증 (롤링 백테스트). 시뮬레이터는 원가를 '계절 기준선(달별 배수) + 과거 범위'로 움직인다.
그 방식이 '지금 값 그대로'(단순 유지)보다 1·3·6개월 앞을 더 잘 맞히는지, 과거 범위가 실제 값을 얼마나 담는지 본다.

자료: KOSIS 생활물가지수 서울 (돼지고기, 삼겹살 외식, 닭고기, 쌀, 달걀, 식용유, 우유; 2021-01~), 제주 돼지 경락가 (2023-01~).
방법: 각 시점 t에서 t까지의 자료만으로 달별 계절 배수를 다시 구해 t+h를 맞힌다 (미래 자료를 쓰지 않음). 최소 24개월 학습.
  - 단순 유지: ŷ = y_t
  - 계절 기준선: ŷ = y_t × SI[t+h의 달] ÷ SI[t의 달]   (SI = 해마다 그해 평균으로 나눈 값의 달별 평균)
  - 과거 범위: 학습 기간의 같은 달 쌍(t의 달 → t+h의 달) 변화율의 최소~최대. 실제 변화가 그 안에 들어온 비율
제주 경락가가 소비자물가(돼지고기)보다 먼저 움직이는지 0~3개월 시차 상관도 본다.
  python -m pipelines.backtest_prices -> research/backtest/price_backtest.json, web/public/mock/price_backtest.json
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
H = (1, 3, 6)


def series() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    k = json.loads((MOCK / "kosis_pork.json").read_text(encoding="utf-8"))["series"]
    out["돼지고기 (소비자물가, 서울)"] = k["돼지고기|서울특별시"]
    out["삼겹살 외식 (소비자물가, 서울)"] = k["삼겹살(외식)|서울특별시"]
    f = json.loads((MOCK / "food_cost.json").read_text(encoding="utf-8"))["items"]
    for key in ("chicken", "rice", "egg", "oil", "milk"):
        if key in f and f[key].get("cpi"):
            out[f"{f[key]['label']} (소비자물가, 서울)"] = f[key]["cpi"]
    j = json.loads((MOCK / "jeju_pork.json").read_text(encoding="utf-8"))["series"]
    out["돼지 경락가 (제주, 원/kg)"] = {r["month"].replace("-", ""): r["won_per_kg"] for r in j}
    return {n: {k: float(v) for k, v in sorted(s.items())} for n, s in out.items()}


def seasonal_index(ys: list[float], ms: list[int]) -> dict[int, float]:
    """해마다(12개월 묶음) 그해 평균으로 나눈 뒤 달별 평균. 자료가 없는 달은 1."""
    by_year: dict[int, list[tuple[int, float]]] = {}
    for i, (m, y) in enumerate(zip(ms, ys)):
        by_year.setdefault(i // 12, []).append((m, y))
    acc: dict[int, list[float]] = {}
    for rows in by_year.values():
        if len(rows) < 12:
            continue
        mean = sum(y for _, y in rows) / len(rows)
        for m, y in rows:
            acc.setdefault(m, []).append(y / mean)
    return {m: (sum(acc[m]) / len(acc[m]) if m in acc else 1.0) for m in range(1, 13)}


def backtest(s: dict[str, float]) -> dict:
    keys = list(s)
    ys = [s[k] for k in keys]
    ms = [int(k[4:6]) for k in keys]
    res = {}
    for h in H:
        e_naive, e_seas, inside, n = [], [], 0, 0
        for t in range(24, len(ys) - h):
            si = seasonal_index(ys[: t + 1], ms[: t + 1])
            yt, act = ys[t], ys[t + h]
            p_seas = yt * si[ms[t + h]] / si[ms[t]]
            e_naive.append(abs(act - yt) / act)
            e_seas.append(abs(act - p_seas) / act)
            # 과거 범위: 학습 기간 안의 같은 달 쌍 변화율
            ch = [ys[i + h] / ys[i] for i in range(0, t - h + 1) if ms[i] == ms[t]]
            if ch:
                lo, hi = min(ch), max(ch)
                inside += lo <= act / yt <= hi
                n += 1
        if not e_naive:
            continue
        mape = lambda e: round(100 * sum(e) / len(e), 2)  # noqa: E731
        res[str(h)] = {"n": len(e_naive), "naive_mape": mape(e_naive), "seasonal_mape": mape(e_seas),
                       "seasonal_better": mape(e_seas) < mape(e_naive), "range_coverage": round(inside / n, 2) if n else None}
    return res


def corr(a: list[float], b: list[float]) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    sa = math.sqrt(sum((x - ma) ** 2 for x in a)); sb = math.sqrt(sum((x - mb) ** 2 for x in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) if sa and sb else 0.0


def lead_lag(whole: dict[str, float], cpi: dict[str, float]) -> dict:
    common = sorted(set(whole) & set(cpi))
    dw = {common[i]: whole[common[i]] / whole[common[i - 1]] - 1 for i in range(1, len(common))}
    dc = {common[i]: cpi[common[i]] / cpi[common[i - 1]] - 1 for i in range(1, len(common))}
    ks = sorted(dw)
    out = {}
    for lag in range(0, 4):  # 경락가 변화가 lag달 뒤 소비자물가 변화와 얼마나 같이 움직이나
        a = [dw[ks[i]] for i in range(len(ks) - lag)]
        b = [dc[ks[i + lag]] for i in range(len(ks) - lag)]
        out[str(lag)] = round(corr(a, b), 2)
    return {"months": len(common), "corr_by_lag": out}


def main() -> None:
    ss = series()
    out = {"_meta": {"method": __doc__.strip().split("\n\n")[1], "horizons": list(H)}, "series": {}}
    for name, s in ss.items():
        out["series"][name] = {"from": min(s), "to": max(s), "months": len(s), "horizon": backtest(s)}
        print(name, len(s), {h: (v["naive_mape"], v["seasonal_mape"], v["range_coverage"]) for h, v in out["series"][name]["horizon"].items()})
    out["lead_lag"] = lead_lag(ss["돼지 경락가 (제주, 원/kg)"], ss["돼지고기 (소비자물가, 서울)"])
    print("lead", out["lead_lag"])
    for p in (ROOT / "research" / "backtest" / "price_backtest.json", MOCK / "price_backtest.json"):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))


if __name__ == "__main__":
    main()
