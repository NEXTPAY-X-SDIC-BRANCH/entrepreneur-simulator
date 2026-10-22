"""은행연합회 소비자포털 '중소기업대출금리 은행별 비교공시'에서 개인사업자 대출 금리(신규취급액 기준)를 은행별로 받는다.

페이지(loan_snmindustry.php)의 조회 버튼이 부르는 loan_snmindustry_search_result_cur.php 에 같은 값을 보낸다.
대출 종류: 1 보증서담보대출, 3 신용대출 (개인사업자가 처음 받는 대출은 대부분 지역신용보증재단 보증서 담보).
  python -m pipelines.fetch_kfb_rates  ->  web/public/mock/bank_rates.json
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path

import requests
from urllib.parse import unquote_plus

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "bank_rates.json"
BASE = "https://portal.kfb.or.kr/compare"
KINDS = {"1": "보증서담보대출", "3": "신용대출"}
UA = {"User-Agent": "Mozilla/5.0 (changeup-simulator research)", "Referer": f"{BASE}/loan_snmindustry.php"}


def banks(s: requests.Session) -> list[tuple[str, str]]:
    t = s.get(f"{BASE}/loan_snmindustry.php", timeout=30).content.decode("euc-kr", "replace")
    # 값은 은행 이름을 EUC-KR로 퍼센트 인코딩한 것 (페이지가 그대로 보낸다)
    vals = re.findall(r'<input[^>]*name="BankName"[^>]*>', t)
    out = []
    for tag in vals:
        v = re.search(r'value="([^"]+)"', tag)
        if v:
            out.append((v.group(1), unquote_plus(v.group(1), encoding="euc-kr")))
    return list(dict.fromkeys(out))


def cells(html: str) -> list[list[str]]:
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S):
        cs = [re.sub(r"<[^>]+>|&nbsp;", " ", c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, flags=re.S)]
        cs = [re.sub(r"\s+", " ", c).strip() for c in cs]
        if cs:
            rows.append(cs)
    return rows


def fetch(s: requests.Session, ym: str, kind: str, bank_str: str) -> list[list[str]]:
    r = s.post(f"{BASE}/loan_snmindustry_search_result_cur.php", timeout=60,
               data={"year": ym[:4], "month": ym[4:], "opt_0": "1", "opt_1": kind, "detail": "0", "select_new_balance": "1", "str": bank_str})
    return cells(r.content.decode("euc-kr", "replace"))


def main() -> None:
    s = requests.Session(); s.headers.update(UA)
    bl = banks(s)
    if not bl:
        raise SystemExit("은행 목록을 못 읽었어요")
    bank_str = "|".join(v for v, _ in bl)
    names = [n for _, n in bl]
    today = dt.date.today()
    out: dict = {"src": "은행연합회 소비자포털 중소기업대출금리 은행별 비교공시 (개인사업자, 신규취급액 기준)", "url": f"{BASE}/loan_snmindustry.php", "kinds": {}}
    for kind, label in KINDS.items():
        for back in range(0, 6):  # 가장 최근에 공시된 달부터
            y, m = today.year, today.month - back
            while m <= 0:
                y, m = y - 1, m + 12
            ym = f"{y}{m:02d}"
            rows = fetch(s, ym, kind, bank_str)
            data = [r for r in rows if r and r[0] in names]
            if data:
                head = next((r for r in rows if any("등급" in c or "평균" in c for c in r)), [])
                out["kinds"][label] = {"ym": ym, "head": head, "rows": {r[0]: r[1:] for r in data}}
                print(label, ym, len(data), "은행", head[:6])
                break
    # 화면용: 은행마다 대출 종류별 평균 금리와 구간별 금리 (값이 없는 은행은 뺀다)
    HEAD = {"보증서담보대출": ["보증 100%", "보증 90%", "보증 85%", "보증 80%", "보증 80% 미만"], "신용대출": ["1~3등급", "4등급", "5등급", "6등급", "7~10등급"]}
    num = lambda x: float(x) if re.fullmatch(r"\d+(\.\d+)?", x or "") else None
    bk: dict = {}
    for label, k in out["kinds"].items():
        for name, r in k["rows"].items():
            vals = [num(x) for x in r[1:7]]
            if vals[5] is None:
                continue
            e = bk.setdefault(name, {})
            e[label] = {"avg": vals[5], "by": {h: v for h, v in zip(HEAD[label], vals[:5]) if v is not None}}
            if r[7:] and r[7]:
                e["note"] = r[7]
    out["banks"] = bk
    out["ym"] = max(k["ym"] for k in out["kinds"].values())
    for k in out["kinds"].values():
        k.pop("rows", None); k.pop("head", None)
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    print("->", OUT)


if __name__ == "__main__":
    main()
