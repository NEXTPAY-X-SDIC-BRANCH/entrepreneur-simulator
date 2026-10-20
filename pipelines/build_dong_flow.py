"""서울시 상권분석서비스의 행정동·자치구 단위 인구(길단위·상주·직장) -> web/public/mock/dong_flow.json
   python -m pipelines.build_dong_flow

서비스 (data.seoul.go.kr, 키: .env 의 SEOUL_API_KEY 또는 SEOUL_OPEN_DATA_KEY)
  VwsmAdstrdFlpopW      길단위인구-행정동   (분기, 총·성별·연령대·시간대·요일)
  VwsmAdstrdRepopW      상주인구-행정동
  VwsmAdstrdWrcPopltnW  직장인구-행정동
  VwsmSignguFlpopW      길단위인구-자치구
원자료는 data/raw/seoul_flow/ 에 캐시(gitignore)한다. 분기 값의 단위(분기 합계인지 일평균인지)는 서울시가 명시하지 않아 확정하지 못했다.
화면은 '이 동네 지나가는 사람'이라고만 적고, 비율(성별·연령·시간대·요일)을 중심으로 쓴다.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "seoul_flow"
OUT = ROOT / "web" / "public" / "mock" / "dong_flow.json"
AGES = ["10", "20", "30", "40", "50", "60_ABOVE"]
BANDS = ["00_06", "06_11", "11_14", "14_17", "17_21", "21_24"]
DOWS = ["MON", "TUES", "WED", "THUR", "FRI", "SAT", "SUN"]


def _key() -> str:
    for n in ("SEOUL_API_KEY", "SEOUL_OPEN_DATA_KEY"):
        if os.environ.get(n):
            return os.environ[n]
    env = (ROOT / ".env").read_text(encoding="utf-8")
    for n in ("SEOUL_API_KEY", "SEOUL_OPEN_DATA_KEY"):
        m = re.search(rf"^{n}=(.*)$", env, re.M)
        if m and m.group(1).strip().strip("\"'"):
            return m.group(1).strip().strip("\"'")
    raise SystemExit("서울 열린데이터광장 키가 없습니다 (.env 의 SEOUL_API_KEY 또는 SEOUL_OPEN_DATA_KEY)")


def fetch(svc: str, refresh: bool = False) -> list[dict]:
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / f"{svc}.json"
    if f.exists() and not refresh:
        return json.loads(f.read_text(encoding="utf-8"))
    key, rows, start = _key(), [], 1
    while True:
        url = f"http://openapi.seoul.go.kr:8088/{key}/json/{svc}/{start}/{start + 999}/"
        j = json.loads(urllib.request.urlopen(url, timeout=60).read().decode("utf-8"))
        body = j.get(svc)
        if not body:
            raise SystemExit(f"{svc}: {str(j)[:200].replace(key, '<KEY>')}")
        rows += body["row"]
        if len(rows) >= int(body["list_total_count"]):
            break
        start += 1000
    f.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


def _shares(r: dict, names: list[str], fmt: str) -> list[float]:
    v = [float(r.get(fmt.format(n)) or 0) for n in names]
    s = sum(v) or 1.0
    return [round(x / s, 4) for x in v]


def _pack(r: dict, tot: str, ml: str, fml: str, age: str, extra: dict | None = None) -> dict:
    t = float(r[tot] or 0)
    d = {"tot": round(t), "male": round(float(r[ml] or 0) / t, 4) if t else None, "age": _shares(r, AGES, age)}
    d.update(extra or {})
    return d


def latest(rows: list[dict]) -> dict[str, dict]:
    """코드별 가장 최근 분기 행."""
    out: dict[str, dict] = {}
    for r in rows:
        c = r.get("ADSTRD_CD") or r.get("SIGNGU_CD")
        if c not in out or r["STDR_YYQU_CD"] > out[c]["STDR_YYQU_CD"]:
            out[c] = r
    return out


def main() -> None:
    flp, rep, wrc, gu = (fetch(s) for s in ("VwsmAdstrdFlpopW", "VwsmAdstrdRepopW", "VwsmAdstrdWrcPopltnW", "VwsmSignguFlpopW"))
    qs = sorted({r["STDR_YYQU_CD"] for r in flp})
    last_q = qs[-1]
    print("길단위인구-행정동 분기:", qs[0], "~", last_q, "분기별 동 수:", {q: sum(1 for r in flp if r["STDR_YYQU_CD"] == q) for q in qs[-3:]})

    def flow(r: dict) -> dict:
        return _pack(r, "TOT_FLPOP_CO", "ML_FLPOP_CO", "FML_FLPOP_CO", "AGRDE_{}_FLPOP_CO", {
            "band": _shares(r, BANDS, "TMZON_{}_FLPOP_CO"), "dow": _shares(r, DOWS, "{}_FLPOP_CO"), "q": r["STDR_YYQU_CD"]})

    dong: dict[str, dict] = {}
    for c, r in latest(flp).items():
        dong[c] = {"name": r["ADSTRD_CD_NM"], "flow": flow(r)}
    for c, r in latest(rep).items():
        if c in dong:
            dong[c]["resi"] = _pack(r, "TOT_REPOP_CO", "ML_REPOP_CO", "FML_REPOP_CO", "AGRDE_{}_REPOP_CO")
    for c, r in latest(wrc).items():
        if c in dong:
            dong[c]["work"] = _pack(r, "TOT_WRC_POPLTN_CO", "ML_WRC_POPLTN_CO", "FML_WRC_POPLTN_CO", "AGRDE_{}_WRC_POPLTN_CO", {"q": r["STDR_YYQU_CD"]})
    guo = {r["SIGNGU_CD_NM"]: flow(r) for r in latest(gu).values()}
    OUT.write_text(json.dumps({"_meta": {"source": "서울시 상권분석서비스 길단위인구·상주인구·직장인구 (행정동, 자치구)", "quarter": last_q,
                                         "age": ["10대", "20대", "30대", "40대", "50대", "60대 이상"],
                                         "band": ["00~06", "06~11", "11~14", "14~17", "17~21", "21~24"], "dow": ["월", "화", "수", "목", "금", "토", "일"],
                                         "note": "분기 값의 단위(합계/일평균)는 확정하지 못함. 비율 중심으로 쓴다."},
                               "dong": dong, "gu": guo}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("dong_flow.json: 동", len(dong), "구", len(guo), "크기", OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
