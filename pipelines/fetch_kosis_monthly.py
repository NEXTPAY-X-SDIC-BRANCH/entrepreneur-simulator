"""KOSIS 월별 지수: 분기 안에서 달을 나누는 비율(업종별)과 배달 포장재 생산자물가 변화.

    python -m pipelines.fetch_kosis_monthly [--from 2023 --to 2025]

키: KOSIS_API_KEY. 키는 출력하지 않는다.
출력: web/public/mock/kosis_monthly.json
표:
  DT_1KC2020 (통계청 101) 산업별 서비스업생산지수 불변지수 (월): 한식 음식점업 I5611, 커피 등 비알코올 음료점업 I5622
  DT_1K41012 (통계청 101) 상품군별 소매판매액지수 불변지수 (월): 의복 G21
  DT_404Y016 (한국은행 301) 생산자물가지수 품목별 (월): 배달 포장에 들어가는 다섯 품목
달 비율 = (그달 지수 ÷ 그달 일수) ÷ 같은 분기 세 달 평균, 해마다 구해 평균. 하루 장사 기준이라 2월이 짧은 것은 빠진다.
월 매출 전체를 그대로 쓰는 엔진(옷가게)용으로 일수로 나누지 않은 비율(ratio_month_total)도 함께 낸다.
전국 값이라 대학로 방학 같은 동네 사정은 들어 있지 않다.
"""
from __future__ import annotations

import argparse
import calendar
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "kosis_monthly.json"
URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
SERIES = {"gogi": ("101", "DT_1KC2020", "I5611", "한식 음식점업 (서비스업생산지수)"),
          "cafe": ("101", "DT_1KC2020", "I5622", "커피 등 비알코올 음료점업 (서비스업생산지수)"),
          "apparel": ("101", "DT_1K41012", "G21", "의복 (소매판매액지수)")}
PACKAGING = {"30572201AA": "플라스틱 포대·봉투", "30572203AA": "플라스틱 뚜껑", "30323204AA": "식품용 종이용기",
             "30572401AA": "폴리스티렌 발포제품 (스티로폼)", "30571109AA": "플라스틱 필름·시트 (랩)"}


def fetch(api_key: str, org: str, tbl: str, itm: str, obj: str, start: str, end: str) -> list[dict]:
    q = urllib.parse.urlencode({"method": "getList", "apiKey": api_key, "format": "json", "jsonVD": "Y", "orgId": org,
                                "tblId": tbl, "itmId": itm, "prdSe": "M", "startPrdDe": start, "endPrdDe": end, "objL1": obj})
    try:
        with urllib.request.urlopen(f"{URL}?{q}", timeout=180) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"KOSIS {tbl}: {e}")) from None
    if not isinstance(data, list):
        raise RuntimeError(f"KOSIS {tbl}: {data.get('errMsg', data)}")
    return data


def month_split(index: dict[str, float], years: range, per_day: bool = True) -> dict[int, float]:
    acc: dict[int, list[float]] = {m: [] for m in range(1, 13)}
    for y in years:
        for q in range(4):
            ms = [q * 3 + i for i in (1, 2, 3)]
            if any(f"{y}{m:02d}" not in index for m in ms):
                continue
            val = {m: index[f"{y}{m:02d}"] / (calendar.monthrange(y, m)[1] if per_day else 1) for m in ms}
            mean = sum(val.values()) / 3
            for m in ms:
                acc[m].append(val[m] / mean)
    return {m: round(sum(v) / len(v), 3) for m, v in acc.items() if v}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=2023)
    ap.add_argument("--to", dest="end", type=int, default=2025)
    args = ap.parse_args()
    api_key = key("KOSIS_API_KEY", fallback=None)
    years = range(args.start, args.end + 1)

    split = {}
    for name, (org, tbl, code, label) in SERIES.items():
        rows = fetch(api_key, org, tbl, "T2", code, f"{args.start}01", f"{args.end}12")
        index = {r["PRD_DE"]: float(r["DT"]) for r in rows}
        split[name] = {"label": label, "table": tbl, "code": code, "ratio": month_split(index, years),
                       "ratio_month_total": month_split(index, years, per_day=False), "index": index}
        print(name, split[name]["ratio"])
        time.sleep(0.5)

    this_year = int(time.strftime("%Y"))
    rows = fetch(api_key, "301", "DT_404Y016", "13103134764999", "+".join(f"13102134764ACC_CD.{c}" for c in PACKAGING) + "+",
                 f"{this_year - 2}01", f"{this_year}12")
    ppi: dict = {}
    for r in rows:
        ppi.setdefault(r["C1"].rsplit(".", 1)[-1], {})[r["PRD_DE"]] = float(r["DT"])
    packaging = {}
    for code, series in ppi.items():
        last = max(series)
        prev = f"{int(last[:4]) - 1}{last[4:]}"
        packaging[code] = {"label": PACKAGING[code], "latest": last, "index": series[last],
                           "yoy": round(series[last] / series[prev] - 1, 4) if prev in series else None}
        print(PACKAGING[code], last, packaging[code]["yoy"])

    OUT.write_text(json.dumps({
        "_meta": {"source": "통계청 서비스업동향조사 (DT_1KC2020), 소매판매액지수 (DT_1K41012), 한국은행 생산자물가지수 (DT_404Y016)",
                  "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "years": [args.start, args.end],
                  "note": "ratio = 분기 안의 하루당 지수 비율, ratio_month_total = 일수로 나누지 않은 월 합계 비율 (둘 다 분기 평균 1). 불변지수, 전국. "
                          "packaging yoy = 최신 달의 1년 전 대비 변화. 포장재 단가(원)는 이 파일에 없다"},
        "month_split": split, "packaging_ppi": packaging,
    }, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
