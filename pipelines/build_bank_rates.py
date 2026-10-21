"""lab:finance — 은행별 사업자 대출 '가상' 금리와 정책자금 공고 금리를 한 파일로.

    python -m pipelines.build_bank_rates [--check]

입력: web/public/mock/ecos_rates.json (pipelines/fetch_ecos.py, 한국은행 예금은행 신규 중소기업대출 금리 최신 달)
출력: web/public/mock/bank_rates.json

은행별 숫자는 실제 공시값이 아니다. ECOS 평균(기준점)에 은행마다 정한 가상의 차이(spread, ±0.3%p 안)를 더한
**가상 값**이고 화면에도 그렇게 적는다. 실제 은행별 금리는 은행연합회 소비자포털 중소기업(개인사업자) 대출금리
비교공시(COMPARE_URL)에 나온다 (화면은 표를 직접 읽지 않고 링크만 건다: 표가 스크립트로 채워져 자동 수집이 안 됨).

정책자금은 공고 원문에서 확인한 금리만 숫자로 쓰고(공고 금리 + 적용일), 확인 못 한 것은 숫자 없이 링크만 둔다.
링크는 각 기관의 공식 홈페이지 첫 화면이다. 신청이나 대출 연결은 하지 않는다 (그 이상은 대부 중개가 된다).
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

# 순서: 은행연합회 소비자포털 비교공시의 은행 목록 순서 (추천·순위가 아님). spread = 가정 (%p).
BANKS = [
    ("nh", "NH농협은행", "은행", +0.18, "https://banking.nonghyup.com/"),
    ("shinhan", "신한은행", "은행", +0.05, "https://www.shinhan.com/"),
    ("woori", "우리은행", "은행", +0.08, "https://www.wooribank.com/"),
    ("hana", "하나은행", "은행", +0.02, "https://www.kebhana.com/"),
    ("ibk", "IBK기업은행", "은행", -0.20, "https://www.ibk.co.kr/"),
    ("kb", "KB국민은행", "은행", +0.12, "https://www.kbstar.com/"),
    ("kbank", "케이뱅크", "인터넷은행", +0.10, "https://www.kbanknow.com/"),
    ("kakao", "카카오뱅크", "인터넷은행", -0.08, "https://www.kakaobank.com/"),
    ("toss", "토스뱅크", "인터넷은행", +0.25, "https://www.tossbank.com/"),
]

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


def build() -> dict:
    ecos = json.loads(ECOS.read_text(encoding="utf-8"))
    sme = ecos["latest"]["loan_sme"]
    a = float(sme["rate"])
    lenders = [{"id": i, "name": n, "kind": k, "spread": s, "rate": round(a + s, 2), "label": "가상 값",
                "who": "개인사업자 운전자금 (신용·담보에 따라 실제 금리는 달라져요)", "url": u}
               for i, n, k, s, u in BANKS] + POLICY
    return {
        "_meta": {
            "anchor": {"rate": a, "month": sme["month"], "series": ecos["_meta"]["series"]["loan_sme"],
                       "source": ecos["_meta"]["source"]},
            "method": "은행별 금리 = 한국은행 예금은행 신규 중소기업대출 평균 + 은행마다 정한 가상의 차이 (가정, ±0.3%p 안). "
                      "실제 공시값이 아니에요.",
            "order": "은행연합회 소비자포털 비교공시의 은행 목록 순서 (추천이나 순위가 아님)",
            "link_only": "각 기관 공식 홈페이지 링크만 보여 줘요. 신청이나 대출 연결은 하지 않아요.",
            "built": date.today().isoformat(),
        },
        "compare_url": COMPARE_URL,
        "lenders": lenders,
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
    d = build()
    bad = []
    if args.check:
        res = check(d)
        d["_meta"]["checked"] = {"at": datetime.now().isoformat(timespec="seconds"), "links": res}
        bad = [r for r in res if not (200 <= r["status"] < 400)]
    OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: 기준 연 {d['_meta']['anchor']['rate']}% ({d['_meta']['anchor']['month']}), "
          f"{len(d['lenders'])}곳" + (f", 링크 실패 {len(bad)}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
