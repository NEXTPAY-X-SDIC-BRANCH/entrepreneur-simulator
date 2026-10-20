"""ChangeUp 챗봇 근거 문장 (정적 부분) -> web/public/mock/facts_changeup.json

    python -m pipelines.build_changeup_facts

pipelines/build_facts.py 가 만드는 facts.json 에는 우리가 받아 둔 월세, 행정동, 경영 지표가 없다.
이 스크립트는 같은 형식(sources, facts)으로 그 부분만 따로 만든다. facts.json 을 다시 만들어도 덮어쓰지 않도록
파일을 나눴고, api/ask_ext.py 가 두 파일을 합쳐 쓴다.

입력 (모두 web/public/mock/ 에 이미 있는 값이고, 숫자는 문장에 그대로 옮긴다)
  rent_gu.json     R-ONE 구별·동별 평당 월세, 권리금
  dong_stats.json  행정동별 점포 수, 유형, 점포당 매출의 구 안 상대값
  kosis_food.json  외식업체경영실태조사 비용 구성, 영업이익률
"""
from __future__ import annotations

import json
from pathlib import Path

MOCK = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
OUT = MOCK / "facts_changeup.json"

SOURCES = {
    "rone": {"title": "상업용부동산 임대동향조사 (소규모 상가 1층 임대료)", "publisher": "한국부동산원 R-ONE", "period": "2026년 2분기",
             "url": "https://www.reb.or.kr/r-one/", "api": "R-ONE 상업용부동산 임대동향조사"},
    "kosis_krei": {"title": "외식업체경영실태조사 (사업실적, 수익성)", "publisher": "한국농촌경제연구원 (KOSIS 114)",
                   "period": "2025년 조사 (2024년 실적)", "url": "https://kosis.kr/", "api": "KOSIS org 114 DT_114054_028, DT_114054_029"},
    "app": {"title": "내가 입력한 가게와 시뮬레이션 계산", "publisher": "ChangeUp (이 화면의 계산)", "period": "지금 화면 기준",
            "url": "", "api": "화면이 질문과 함께 보낸 값"},
}


def has_batchim(word: str) -> bool:
    c = word[-1]
    return "가" <= c <= "힣" and (ord(c) - 0xAC00) % 28 != 0


def eun(w: str) -> str:
    return w + ("은" if has_batchim(w) else "는")


def short_gu(gu: str) -> str:
    return gu[:-1] if gu.endswith("구") and len(gu) > 2 else gu


def num(v: float, d: int = 1) -> str:
    return f"{v:,.{d}f}".rstrip("0").rstrip(".") if d else f"{v:,.0f}"


def rent_facts() -> list[dict]:
    r = json.loads((MOCK / "rent_gu.json").read_text(encoding="utf-8"))
    conv = r["conv_seoul_pct"] / 100
    cash = lambda v: v / (1 + conv)  # noqa: E731 보증금 12개월 환산분을 뺀 현금 월세 (앱의 model.ts cashRent 와 같다)
    q = r["_meta"]["quarter"]
    when = f"{q[:4]}년 {int(q[4:])}분기"
    out: list[dict] = []
    avg = cash(r["seoul_avg"])
    base_tags = ["월세", "임대", "임대료", "보증금", "평당", "상가"]
    ranked = sorted(r["gu"].items(), key=lambda kv: -kv[1]["rent_man_per_pyeong"])
    for gu, v in r["gu"].items():
        c = cash(v["rent_man_per_pyeong"])
        note = ("이 구는 조사 상권이 없어 다른 구 값으로 채운 참고값이에요." if v.get("imputed")
                else f"조사 상권 {v['n_areas']}곳({', '.join(v['areas'])})을 평균낸 근사예요.")
        out.append({"id": f"rent_gu_{gu}", "tags": [gu, short_gu(gu), *base_tags],
                    "text": f"{eun(gu)} 평당 월세가 약 {num(c)}만원이에요. 한국부동산원 {when} 소규모 상가 1층 임대료에서 보증금 환산분을 뺀 "
                            f"현금 월세이고, 서울 평균은 {num(avg)}만원이에요. {note}",
                    "sources": ["rone"]})
    top, low = ranked[:3], ranked[-3:][::-1]
    out.append({"id": "rent_rank", "tags": ["월세", "임대", "임대료", "비싼", "싼", "가장", "순위", "구", "평당", "상가"],
                "text": "평당 월세가 가장 비싼 구는 " + ", ".join(f"{g}(약 {num(cash(x['rent_man_per_pyeong']))}만원)" for g, x in top)
                        + "이고, 가장 싼 구는 " + ", ".join(f"{g}(약 {num(cash(x['rent_man_per_pyeong']))}만원)" for g, x in low)
                        + f"예요. 한국부동산원 {when} 값이고 구 안에서도 골목마다 달라요.",
                "sources": ["rone"]})
    for key, v in r["dong"].items():
        gu, dong = key.split("|")
        out.append({"id": f"rent_dong_{key}", "tags": [dong, gu, short_gu(gu), "동네", *base_tags],
                    "text": f"{dong}({gu})의 평당 월세는 약 {num(cash(v['rent_man_per_pyeong']))}만원이에요. 한국부동산원 {when} "
                            f"{'·'.join(v['areas'])} 상권 값에서 보증금 환산분을 뺀 현금 월세예요. 상권 하나의 값이라 골목마다 달라요.",
                    "sources": ["rone"]})
    p = r.get("premium_seoul_food") or {}
    have, level = p.get("권리금 유 비율"), p.get("권리금 수준_평균")
    if have and level:
        out.append({"id": "premium_seoul", "tags": ["권리금", "임대", "상가", "보증금", "서울", "외식"],
                    "text": f"서울 외식업 사업장의 {num(have['v'])}%가 권리금이 있고, 권리금 수준은 평균 약 {num(level['v'], 0)}만원이에요 "
                            f"({have['year']}년, 한국부동산원 상업용부동산 임대동향조사).",
                    "sources": ["rone"]})
    return out


def dong_facts() -> list[dict]:
    d = json.loads((MOCK / "dong_stats.json").read_text(encoding="utf-8"))
    out: list[dict] = []
    counts: dict[str, int] = {}
    for gu, lst in d["gu"].items():
        for x in lst:
            counts[x["type"]] = counts.get(x["type"], 0) + 1
            rel = f" 점포당 한식 매출은 {gu} 평균의 {round(x['rel'] * 100)}%예요." if x.get("rel") else ""
            out.append({"id": f"dong_{gu}_{x['name']}",
                        "tags": [x["name"], gu, short_gu(gu), "동네", "유형", x["type"], "고깃집", "돼지고기", "점포", "경쟁", "한식"],
                        "text": f"{x['name']}({gu})은 {x['type']} 유형 동네예요. 돼지고기 구이·찜 {x['pork']}곳, 한식음식점 {x['stores']}곳이 있어요.{rel}",
                        "sources": ["sbiz", "seoul_sales"]})
    dist = ", ".join(f"{t} {n}곳" for t, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    out.append({"id": "dong_type_rule", "tags": ["동네", "유형", "분류", "규칙", "연령", "시간대", "비중", "대학", "청년", "오피스", "주거"],
                "text": "동네 유형은 서울시 상권분석서비스 행정동 매출의 비중으로 나눈 규칙 분류예요. 20대 매출 비중이 27% 이상이면 대학·청년, "
                        "점심 비중이 30% 이상이면서 주말 비중이 25% 이하면 오피스, 주말 비중이 36% 이상이면 주거, 나머지는 일반이에요. "
                        f"서울 행정동 {sum(counts.values())}곳은 {dist}이고, 현장 조사가 아니에요.",
                "sources": ["seoul_sales"]})
    return out


def kosis_facts() -> list[dict]:
    t = json.loads((MOCK / "kosis_food.json").read_text(encoding="utf-8"))["tables"]
    rows28 = [r for r in t["DT_114054_028"]["rows"] if r["y"] == "2025" and r["item"] == "비율"]
    get = lambda c1, c2: next((float(r["v"]) for r in rows28 if r["c1"] == c1 and r["c2"] == c2), None)  # noqa: E731
    out: list[dict] = []
    specs = [("식재료비", ["식재료비", "원가", "원가율", "재료"], "음식점 식재료비는 매출액의"),
             ("고용인 인건비", ["인건비", "직원", "알바", "급여"], "고용인 인건비는 매출액의"),
             ("임차료", ["임차료", "월세", "임대료"], "임차료는 매출액의")]
    for c1, tags, lead in specs:
        a, b = get(c1, "일반음식점업"), get(c1, "서울권")
        if a is None:
            continue
        seoul = f" 서울권 사업장은 {num(b)}%예요." if b is not None else ""
        out.append({"id": f"kosis_cost_{c1}", "tags": [*tags, "비용", "비율", "매출", "외식업", "경영"],
                    "text": f"{lead} {num(a)}%예요 (일반음식점업 평균).{seoul} 외식업체경영실태조사 2025년 조사(2024년 실적) 기준이에요.",
                    "sources": ["kosis_krei"]})
    marg = [r for r in t["DT_114054_029"]["rows"] if r["y"] == "2025" and "영업이익률" in r["item"] and r["c1"] == "전체"]
    if marg:
        out.append({"id": "kosis_margin", "tags": ["영업이익률", "이익", "마진", "수익성", "외식업", "경영", "비율"],
                    "text": f"외식업체의 매출액 대비 영업이익률은 {num(float(marg[0]['v']))}%예요. 외식업체경영실태조사 2025년 조사(2024년 실적) 기준이에요.",
                    "sources": ["kosis_krei"]})
    return out


def main() -> None:
    facts = rent_facts() + dong_facts() + kosis_facts()
    OUT.write_text(json.dumps({"sources": SOURCES, "facts": facts}, ensure_ascii=False, indent=1), encoding="utf-8")
    from collections import Counter
    print(f"저장: {OUT.name}, 근거 문장 {len(facts)}개", dict(Counter(f["id"].split("_")[0] for f in facts)))


if __name__ == "__main__":
    main()
