"""챗봇 근거 문장 (소상공인365·은행연합회·시세 검증) -> web/public/mock/facts_sbiz365.json

    python -m pipelines.build_facts_sbiz365

입력 (이미 만든 파일): sbiz_delivery.json (배달분석), sbiz_sns.json (SNS 분석), bank_rates.json (은행별 금리),
price_backtest.json (원가 시세 검증), chicken_dong_stats.json·bunsik_dong_stats.json (치킨·분식 행정동).
문장 id 접두사: sbizdlvy_ (배달), sns_ (SNS), bank_ (은행 금리), backtest_ (시세 검증), qfdong_ (치킨·분식 동네)
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "facts_sbiz365.json"
NAME = {"chicken": "치킨집", "bunsik": "분식집", "cafe": "카페", "bbq": "고깃집(고기·구이)", "apparel": "옷가게"}
SOURCES = {
    "sbiz365_delivery": {"publisher": "소상공인시장진흥공단", "title": "소상공인365 배달분석 (행정동별 점포당 월평균 배달 매출·주문 건수)", "api": "소상공인365 오픈API 배달분석",
                         "url": "https://bigdata.sbiz.or.kr", "period": "2020년~2026년 7월"},
    "sbiz365_sns": {"publisher": "소상공인시장진흥공단", "title": "소상공인365 SNS 분석 (키워드 언급 수와 연관어)", "api": "소상공인365 오픈API SNS 분석",
                    "url": "https://bigdata.sbiz.or.kr", "period": "최근 12개월"},
    "kfb_rates": {"publisher": "전국은행연합회", "title": "중소기업대출금리 은행별 비교공시 (개인사업자, 신규취급액 기준)", "api": "소비자포털 비교공시",
                  "url": "https://portal.kfb.or.kr/compare/loan_snmindustry.php", "period": "최근 공시월"},
    "price_backtest": {"publisher": "ChangeUp", "title": "원가 시세 예측 검증 (KOSIS 생활물가지수 서울·제주 돼지 경락가 롤링 백테스트)", "api": "pipelines/backtest_prices.py",
                       "url": "https://kosis.kr", "period": "2021년~2026년"},
    "seoul_sales": {"publisher": "서울특별시 / 서울신용보증재단", "title": "상권분석서비스 추정매출-행정동 (치킨전문점 CS100007, 분식전문점 CS100008)", "api": "VwsmAdstrdSelngW",
                    "url": "https://data.seoul.go.kr", "period": "2025년"},
}


def load(name: str):
    p = MOCK / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def build() -> list[dict]:
    facts: list[dict] = []
    add = lambda id_, tags, text, src: facts.append({"id": id_, "tags": tags, "text": text, "sources": src})  # noqa: E731

    d = load("sbiz_delivery.json")
    if d:
        for ind, x in d["inds"].items():
            nm, sv = NAME[ind], x["seoul"]
            ym = f"{x['ym'][:4]}년 {int(x['ym'][4:])}월"
            add(f"sbizdlvy_seoul_{ind}", [nm, "배달", "서울", "주문", "배달 매출"],
                f"서울 {nm} 한 곳은 {ym}에 배달 주문을 한 달 {sv['orders']:,}건(가운데값), 배달 매출 {round(sv['sales'] / 1e4):,}만원을 받았어요. 배달 한 건은 평균 {sv['ticket']:,}원이에요 (소상공인365 배달분석).",
                ["sbiz365_delivery"])
            tr = x.get("trend_orders") or {}
            jul = {k: v for k, v in tr.items() if k.endswith("07")}
            if len(jul) >= 2:
                ks = sorted(jul)
                add(f"sbizdlvy_trend_{ind}", [nm, "배달", "추세", "늘었", "줄었"],
                    f"서울 {nm} 한 곳의 7월 배달 주문은 {ks[0][:4]}년 {jul[ks[0]]}건에서 {ks[-1][:4]}년 {jul[ks[-1]]}건으로 바뀌었어요 (소상공인365 배달분석, 점포당 가운데값).",
                    ["sbiz365_delivery"])
            for gu, g in x["gu"].items():
                top = sorted(g["dongs"].values(), key=lambda v: -v["orders"])[:3]
                add(f"sbizdlvy_{ind}_{gu}", [gu, nm, "배달", "동네", "주문"],
                    f"{gu} {nm} 한 곳은 한 달에 배달 주문 {g['orders']:,}건(서울 가운데값의 {g['index']:.2f}배), 배달 매출 {round(g['sales'] / 1e4):,}만원을 받아요. "
                    "배달 주문이 많은 동네는 " + ", ".join("%s %s건" % (t["name"], format(t["orders"], ",")) for t in top) + f"이에요 ({ym}, 소상공인365 배달분석).",
                    ["sbiz365_delivery"])

    s = load("sbiz_sns.json")
    if s:
        for ind, x in s["inds"].items():
            nm, si = NAME[ind], x["season_index"]
            hi = max(si, key=si.get); lo = min(si, key=si.get)
            words = ", ".join(r["word"] for r in x["related"][:8])
            add(f"sns_{ind}", [nm, "SNS", "인스타", "홍보", "마케팅", "언급", "연관어", "관심"],
                f"SNS에서 '{x['keyword']}' 언급은 최근 12개월 {x['total']:,}번이에요. {int(hi)}월에 가장 많고(평균의 {si[hi]:.2f}배) {int(lo)}월에 가장 적어요(평균의 {si[lo]:.2f}배). "
                f"함께 많이 나오는 말은 {words}이에요 (소상공인365 SNS 분석, {s.get('period', '')}). 시뮬레이터는 SNS 홍보 효과에 그 달 관심도를 곱해요.",
                ["sbiz365_sns"])

    b = load("bank_rates.json")
    if b and b.get("banks"):
        rows = sorted(((n, v["보증서담보대출"]["avg"]) for n, v in b["banks"].items() if v.get("보증서담보대출")), key=lambda t: t[1])
        ym = f"{b['ym'][:4]}년 {int(b['ym'][4:])}월"
        add("bank_guarantee_rank", ["은행", "대출", "금리", "보증서", "개인사업자", "싼", "낮은"],
            f"{ym} 공시 기준 개인사업자 보증서담보대출 평균 금리가 낮은 은행은 {', '.join(f'{n} 연 {r:.2f}%' for n, r in rows[:4])}이에요. 높은 쪽은 {', '.join(f'{n} 연 {r:.2f}%' for n, r in rows[-2:])}예요 (은행연합회 비교공시).",
            ["kfb_rates"])
        for n, v in b["banks"].items():
            g, c = v.get("보증서담보대출"), v.get("신용대출")
            if g:
                add(f"bank_{n}", [n, "은행", "대출", "금리", "개인사업자"],
                    f"{n} 개인사업자 대출 평균 금리는 보증서담보 연 {g['avg']:.2f}%" + (f", 신용대출 연 {c['avg']:.2f}%" if c else "") + f"예요 ({ym} 공시, 신규취급액 기준, 은행연합회).",
                    ["kfb_rates"])

    t = load("price_backtest.json")
    if t:
        for name, x in t["series"].items():
            h6 = x["horizon"].get("6")
            if not h6:
                continue
            better = "계절 평균이 더 잘 맞아요" if h6["seasonal_better"] else "지금 값을 그대로 두는 쪽이 더 잘 맞아요"
            add(f"backtest_{name.split(' ')[0]}", [name.split(" ")[0], "시세", "예측", "원가", "가격", "오를", "내릴"],
                f"{name}를 과거 자료로 6개월 앞을 맞혀 보면 계절 평균은 평균 {h6['seasonal_mape']}%, '그대로 유지'는 {h6['naive_mape']}% 틀렸어요. {better}. "
                f"과거 같은 시기 범위 안에 실제 값이 든 비율은 {round((h6['range_coverage'] or 0) * 100)}%예요 (ChangeUp 시세 검증).", ["price_backtest"])

    for ind in ("chicken", "bunsik"):
        dd = load(f"{ind}_dong_stats.json")
        if not dd:
            continue
        for gu, lst in dd["gu"].items():
            rel = [x for x in lst if x.get("rel")]
            if len(rel) < 3:
                continue
            hi = sorted(rel, key=lambda x: -x["rel"])[:3]
            many = sorted(lst, key=lambda x: -x["stores"])[:3]
            add(f"qfdong_{ind}_{gu}", [gu, NAME[ind], "동네", "행정동", "매출", "경쟁", "가게 수"],
                f"{gu}에서 {NAME[ind]} 한 곳의 매출이 높은 동네는 " + ", ".join("%s(구 평균의 %d%%)" % (x["name"], round(x["rel"] * 100)) for x in hi) + "이고, "
                f"{NAME[ind]}이 많은 동네는 " + ", ".join("%s %d곳" % (x["name"], x["stores"]) for x in many) + "이에요 (서울시 상권분석서비스 2025년, 상가정보).",
                ["seoul_sales"])
    return facts


def main() -> None:
    facts = build()
    OUT.write_bytes(json.dumps({"sources": SOURCES, "facts": facts}, ensure_ascii=False, indent=1).encode("utf-8"))
    by: dict[str, int] = {}
    for f in facts:
        by[f["id"].split("_")[0]] = by.get(f["id"].split("_")[0], 0) + 1
    print(f"facts_sbiz365.json: {len(facts)}개", by)


if __name__ == "__main__":
    main()
