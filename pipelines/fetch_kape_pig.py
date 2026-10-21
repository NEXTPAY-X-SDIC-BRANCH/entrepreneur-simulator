"""축산물품질평가원 축산유통정보(ekapepia) 돼지 탕박 경락가격을 월별로 받는다. 키가 필요 없다.

    python -m pipelines.fetch_kape_pig [--from 2016-01] [--to 2026-09]

화면: https://www.ekapepia.com/v3/price/auction/period/pig/auctionPrice.do
  (가격정보 > 경락가격 > 기간별 > 돼지, 도체구분 탕박, 등급별 조회)
한 달씩 조회해 표의 '전국(제주 제외)'와 '전국' 열을 읽는다. 행: 1+, 1, 2, 등외, 등외제외, 모돈, 평균.
값 단위: 원/kg (지육), 괄호 안은 두수.

부위별 도매(식육포장) 월별 가격도 같은 기관 화면에서 받는다 (2018-10부터 있음):
  https://www.ekapepia.com/v3/price/livestock/pig/wholesale/partPrice.do?searchType=month

출력: web/public/mock/kape_pig_monthly.json  (series = 경락가, parts = 부위별 도매)
검증: 2026-09 전국 평균 6,616원/kg(67,848두)은 같은 기관 월별 가격동향 화면(trend.do)과
      pig_auction_2026.json(화면 캡처)의 값과 같다.
"""
from __future__ import annotations

import argparse
import calendar
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock" / "kape_pig_monthly.json"
URL = "https://www.ekapepia.com/v3/price/auction/period/pig/auctionPrice.do"
PAGE = "https://www.ekapepia.com/v3/price/auction/period/pig/auctionPrice.do"
ROWS = {"1+": "g1p", "1": "g1", "2": "g2", "등외": "out", "등외제외": "ex_out", "모돈": "sow", "평균": "avg"}
CELL = re.compile(r"([\d,]+)\s*\(([\d,]+)\)")


def _cells(tr: str) -> list[str]:
    raw = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, flags=re.S)
    return [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c)).strip() for c in raw]


def _val(cell: str) -> tuple[int | None, int]:
    m = CELL.search(cell)
    if not m:
        return None, 0
    return int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))


def parse(html: str) -> dict:
    """표 하나에서 {row_key: {exj: (price, heads), nat: (price, heads)}} 를 뽑는다."""
    tables = [t for t in re.findall(r"<table[^>]*>.*?</table>", html, flags=re.S) if "등외제외" in t]
    if not tables:
        return {}
    out: dict = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tables[0], flags=re.S):
        c = _cells(tr)
        if c and c[0] in ROWS and len(c) >= 3:
            out[ROWS[c[0]]] = {"exj": _val(c[1]), "nat": _val(c[-1])}
    return out


def fetch_month(y: int, m: int) -> dict:
    last = calendar.monthrange(y, m)[1]
    q = urllib.parse.urlencode({"searchStartDate": f"{y}-{m:02d}-01", "searchEndDate": f"{y}-{m:02d}-{last}",
                                "searchCondition": "2", "searchCondition1": "", "searchCondition2": "1"})
    err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(f"{URL}?{q}", headers={"User-Agent": "Mozilla/5.0 (changeup-lab research)"})
            html = urllib.request.urlopen(req, timeout=90).read().decode("utf-8", errors="ignore")
            rows = parse(html)
            if rows:
                return rows
            err = "표 없음"
        except Exception as e:  # noqa: BLE001 — 네트워크 오류는 재시도
            err = str(e)
        time.sleep(2 + attempt * 2)
    raise SystemExit(f"{y}-{m:02d}: {err}")


PART_URL = "https://www.ekapepia.com/v3/price/livestock/pig/wholesale/partPrice.do"
PARTS = {"part21": "안심", "part22": "등심", "part25": "앞다리", "part26": "뒷다리", "part27": "삼겹살",
         "part28": "갈비", "part29": "갈매기살", "part38": "항정살", "part65": "가브리살", "part68": "목심"}


def fetch_parts(start: str, end: str) -> dict[str, dict[str, int]]:
    """부위별 도매 식육포장 월별 가격 {부위: {YYYY-MM: 원/kg}}. 0은 값 없음으로 버린다."""
    q = urllib.parse.urlencode({"searchType": "month", "searchStartDate": start, "searchEndDate": end})
    req = urllib.request.Request(f"{PART_URL}?{q}", headers={"User-Agent": "Mozilla/5.0 (changeup-lab research)"})
    html = urllib.request.urlopen(req, timeout=120).read().decode("utf-8", errors="ignore")
    i = html.find("var chartData")
    seg = html[i:html.find("];", i)]
    out: dict[str, dict[str, int]] = {name: {} for name in PARTS.values()}
    for block in re.findall(r"\{(.*?)\}", seg, flags=re.S):
        t = re.search(r'Time:\s*"(\d{4})년 (\d{2})월"', block)
        if not t:
            continue
        ym = f"{t.group(1)}-{t.group(2)}"
        for code, val in re.findall(r'(part\d+)\s*:\s*"(\d+)"', block):
            if code in PARTS and int(val) > 0:
                out[PARTS[code]][ym] = int(val)
    if not out["삼겹살"]:
        raise SystemExit("부위별 도매 표를 읽지 못했어요")
    return {k: dict(sorted(v.items())) for k, v in out.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2016-01")
    ap.add_argument("--to", dest="end", default=None, help="마지막 달 (기본: 지난달)")
    ap.add_argument("--parts-only", action="store_true", help="경락가는 저장된 것을 두고 부위별 도매만 다시 받기")
    a = ap.parse_args()
    today = date.today()
    ey, em = map(int, a.end.split("-")) if a.end else ((today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12))
    if a.parts_only:
        doc = json.loads(OUT.read_text(encoding="utf-8"))
        doc["parts"] = fetch_parts("2018-01", f"{ey}-{em:02d}")
        doc["_meta"]["parts_url"] = PART_URL + "?searchType=month"
        doc["_meta"]["parts_generated"] = today.isoformat()
        OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print({k: len(v) for k, v in doc["parts"].items()})
        return
    y, m = map(int, a.start.split("-"))
    series = []
    while (y, m) <= (ey, em):
        rows = fetch_month(y, m)
        rec: dict = {"month": f"{y}-{m:02d}"}
        for k, v in rows.items():
            rec[f"nat_{k}"], rec[f"nat_{k}_n"] = v["nat"]
            rec[f"exj_{k}"], rec[f"exj_{k}_n"] = v["exj"]
        series.append(rec)
        print(rec["month"], rec.get("nat_avg"), rec.get("exj_ex_out"), flush=True)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        time.sleep(0.8)
    doc = {"_meta": {"generated": today.isoformat(),
                     "source": "축산물품질평가원 축산유통정보 돼지 경락가격 기간별 (탕박, 등급별 조회)",
                     "url": PAGE,
                     "method": "pipelines/fetch_kape_pig.py (한 달씩 조회해 표의 전국·전국(제주 제외) 열을 읽음, 키 불필요)",
                     "unit": "원/kg 지육, _n = 두수",
                     "fields": {"nat_*": "전국", "exj_*": "전국(제주 제외)", "avg": "평균(등외·모돈 포함)",
                                "ex_out": "등외제외", "g1p": "1+등급", "g1": "1등급", "g2": "2등급", "out": "등외", "sow": "모돈"},
                     "parts_url": PART_URL + "?searchType=month", "parts_unit": "원/kg, 도매 식육포장 전국 평균"},
           "series": series,
           "parts": fetch_parts("2018-01", f"{ey}-{em:02d}")}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(series)}개월 → {OUT}")


if __name__ == "__main__":
    main()
