"""lab:finance + upstream — 은행별 개인사업자 대출 금리(은행연합회 비교공시 실제 값)와 정책자금 공고 금리를 한 파일로.

    python -m pipelines.fetch_kfb_rates          # 1) 은행연합회 비교공시 -> bank_rates.json 의 src·url·kinds·banks·ym
    python -m pipelines.build_bank_rates [--check]   # 2) 같은 파일에 lenders(고를 수 있는 목록)·_meta·compare_url 를 더한다

입력: web/public/mock/bank_rates.json 의 banks (pipelines/fetch_kfb_rates.py, 은행연합회 소비자포털 중소기업대출금리
      은행별 비교공시, 개인사업자, 신규취급액 기준), web/public/mock/ecos_rates.json (한국은행 평균, 비교 기준선)
출력: web/public/mock/bank_rates.json (한 파일이 두 화면을 먹인다: 은행 표/카드는 banks, 금리 고르기는 lenders)

은행 금리 = 비교공시의 보증서담보대출 평균 (처음 여는 가게는 보통 지역신용보증재단 보증서를 담보로 빌린다). 보증서담보
값이 없으면 신용대출 평균. 신규 취급을 멈춘 은행(공시 비고에 '신규 중단')은 고를 수 없게 뺀다. 예전의 은행별 '가상 차이'
(spread)는 쓰지 않는다. 고른 금리는 화면(web/src/lab/finance/finance.ts)이 대출 이자 계산에 그대로 쓴다.

정책자금은 공고 원문에서 확인한 금리만 숫자로 쓰고(공고 금리 + 적용일), 확인 못 한 것은 숫자 없이 링크만 둔다.
링크는 각 기관의 공식 홈페이지 첫 화면(확인한 9곳) 또는 은행연합회 비교공시. 신청이나 대출 연결은 하지 않는다.
--check: 모든 링크를 curl로 열어 응답 코드를 _meta.checked에 적는다 (200 또는 3xx만 통과, 아니면 종료 코드 1).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ECOS = ROOT / "web" / "public" / "mock" / "ecos_rates.json"
OUT = ROOT / "web" / "public" / "mock" / "bank_rates.json"
COMPARE_URL = "https://portal.kfb.or.kr/compare/loan_snmindustry.php"   # 2019년 7월 이후 은행별 비교공시 (2026-10-21 확인)

# 공식 홈페이지 (2026-10-21 curl 확인). 여기 없는 은행은 은행연합회 비교공시로 링크한다. id 는 화면 상태 키.
HOME = {
    "NH농협은행": ("nh", "https://banking.nonghyup.com/"), "신한은행": ("shinhan", "https://www.shinhan.com/"),
    "우리은행": ("woori", "https://www.wooribank.com/"), "하나은행": ("hana", "https://www.kebhana.com/"),
    "IBK기업은행": ("ibk", "https://www.ibk.co.kr/"), "KB국민은행": ("kb", "https://www.kbstar.com/"),
    "케이뱅크": ("kbank", "https://www.kbanknow.com/"), "카카오뱅크": ("kakao", "https://www.kakaobank.com/"),
    "토스뱅크": ("toss", "https://www.tossbank.com/"),
}
IDS = {"SC제일은행": "sc", "한국씨티은행": "citi", "Sh수협은행": "suhyup", "iM뱅크(구 대구은행)": "im", "BNK부산은행": "busan",
       "광주은행": "kjbank", "제주은행": "jeju", "전북은행": "jbbank", "BNK경남은행": "knbank"}
INTERNET = {"케이뱅크", "카카오뱅크", "토스뱅크"}

SEMAS_RATES = "https://ols.semas.or.kr/ols/man/SMAN019M/page.do"
SEMAS_SRC = "소상공인시장진흥공단 정책자금 누리집 금리안내, '26년 4/4분기 정책자금 금리 ('26. 10. 10.부터 적용)"
POLICY = [
    {"id": "semas_general", "name": "소상공인시장진흥공단 일반경영안정자금", "kind": "정책자금", "rate": 4.72,
     "label": "공고 금리", "as_of": "2026-10-10", "source": SEMAS_SRC + ", 기준금리 4.12% + 가산 0.6%P",
     "who": "사업자등록을 마친 소상공인 (대리대출, 분기마다 바뀌는 변동금리)", "url": SEMAS_RATES, "youth": False},
    {"id": "semas_youth", "name": "소상공인시장진흥공단 청년고용연계자금", "kind": "정책자금", "rate": 4.12,
     "label": "공고 금리", "as_of": "2026-10-10", "source": SEMAS_SRC + ", 기준금리 4.12% + 가산 0.0%P",
     "who": "만 39세 이하 청년 소상공인 등, 사업자등록 후", "url": SEMAS_RATES, "youth": True},
    {"id": "seoul_shinbo", "name": "서울신용보증재단 (서울시 중소기업육성자금)", "kind": "정책자금", "rate": None,
     "label": "금리 공고 확인 필요", "as_of": None, "source": None,
     "who": "서울에 사업장을 둔 소상공인. 자금마다 금리와 이자 지원이 달라 공고 원문을 봐야 해요",
     "url": "https://www.seoulshinbo.co.kr/", "youth": False},
]


def _ym(ym: str) -> str:
    return f"{ym[:4]}년 {int(ym[4:6])}월"


def bank_lenders(kfb: dict) -> list[dict]:
    """비교공시(banks) -> 고를 수 있는 은행 목록. 순서는 공시의 은행 목록 순서 (추천·순위가 아님)."""
    out = []
    for name, v in kfb["banks"].items():
        if "신규 중단" in (v.get("note") or ""):
            continue
        g, c = v.get("보증서담보대출"), v.get("신용대출")
        main = g or c
        if not main:
            continue
        kind = "보증서담보대출" if g else "신용대출"
        i, url = HOME.get(name, (IDS.get(name) or f"bank_{len(out)}", kfb.get("url") or COMPARE_URL))
        out.append({"id": i, "name": name, "kind": "인터넷은행" if name in INTERNET else "은행", "rate": main["avg"],
                    "rate_credit": c["avg"] if c else None, "label": "공시 평균", "as_of": kfb["kinds"][kind]["ym"],
                    "source": f"은행연합회 소비자포털 중소기업대출금리 은행별 비교공시, 개인사업자 {kind} 평균 ({_ym(kfb['kinds'][kind]['ym'])}, 신규취급액)",
                    "who": f"개인사업자 {kind} 평균 (신용과 보증비율에 따라 실제 금리는 달라져요)", "url": url})
    return out


def build(kfb: dict) -> dict:
    ecos = json.loads(ECOS.read_text(encoding="utf-8"))
    sme = ecos["latest"]["loan_sme"]
    a = float(sme["rate"])
    return {
        **{k: kfb[k] for k in ("src", "url", "kinds", "banks", "ym")},   # upstream 은행 표·카드용 (pipelines/fetch_kfb_rates.py)
        "_meta": {
            "anchor": {"rate": a, "month": sme["month"], "series": ecos["_meta"]["series"]["loan_sme"],
                       "source": ecos["_meta"]["source"]},
            "method": f"은행별 금리 = 은행연합회 비교공시 개인사업자 보증서담보대출 평균 ({_ym(kfb['ym'])}, 신규취급액). "
                      "보증서담보 값이 없으면 신용대출 평균. 한국은행 평균은 비교 기준선으로만 써요.",
            "order": "은행연합회 소비자포털 비교공시의 은행 목록 순서 (추천이나 순위가 아님)",
            "link_only": "각 기관 공식 홈페이지 또는 은행연합회 비교공시 링크만 보여 줘요. 신청이나 대출 연결은 하지 않아요.",
            "built": date.today().isoformat(),
        },
        "compare_url": COMPARE_URL,
        "lenders": bank_lenders(kfb) + POLICY,
    }


def check(d: dict) -> list[dict]:
    """curl로 연다 (리다이렉트 따라감). urllib는 중간 인증서를 빠뜨린 서버(서울신보)를 실패로 보지만 브라우저와 curl은 연다."""
    urls = [d["compare_url"]] + sorted({x["url"] for x in d["lenders"]})
    out = []
    for u in urls:
        try:
            r = subprocess.run(["curl", "-s", "-L", "-o", "/dev/null", "--max-time", "20", "-A", "Mozilla/5.0",
                                "-w", "%{http_code}", u], capture_output=True, text=True, timeout=30)
            code = int(r.stdout.strip() or 0)
        except (subprocess.SubprocessError, ValueError, OSError) as e:
            code = 0
            print(f"  {u}: {type(e).__name__}", file=sys.stderr)
        out.append({"url": u, "status": code})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="링크 응답 코드를 확인해 _meta.checked에 적는다")
    args = ap.parse_args()
    cur = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if not cur.get("banks"):
        print("bank_rates.json 에 banks 가 없어요. 먼저 python -m pipelines.fetch_kfb_rates", file=sys.stderr)
        return 1
    d = build(cur)
    bad = []
    if args.check:
        res = check(d)
        d["_meta"]["checked"] = {"at": datetime.now().isoformat(timespec="seconds"), "links": res}
        bad = [r for r in res if not (200 <= r["status"] < 400)]
    OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: 공시 {d['ym']}, 기준선 연 {d['_meta']['anchor']['rate']}% ({d['_meta']['anchor']['month']}), "
          f"{len(d['lenders'])}곳" + (f", 링크 실패 {len(bad)}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
