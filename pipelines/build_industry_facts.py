"""새 업종 챗봇 근거 문장 -> web/public/mock/facts_industry.json.  python -m pipelines.build_industry_facts  (lab:industry)

api/ask_ext.py가 facts.json, facts_changeup.json과 함께 읽는다. 문장은 모델이 만들지 않고 아래 틀에 숫자만 넣는다.
입력: research/industries/<id>.yaml, krei.json, rank.json, web/public/mock/industry_gu.json (모두 저장소 안 파일, 네트워크 없음)
id는 모두 ind_<업종>_... 이라 ask_ext의 'industry' 주제로만 묶인다.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from sim.generic.registry import INDUSTRIES

REPO = Path(__file__).resolve().parents[1]
DIR = REPO / "research" / "industries"
OUT = REPO / "web" / "public" / "mock" / "facts_industry.json"
# 질문에 나올 만한 말 (태그). ask_ext.IND_Q와 같은 말을 쓴다.
WORDS = {
    "hansik": ["백반", "백반집", "한식", "밥집", "식당", "찌개", "국밥", "한정식"],
    "pub": ["호프", "주점", "술집", "맥주", "포차", "이자카야", "생맥주"],
    "bunsik": ["분식", "분식집", "김밥", "떡볶이", "라면"],
    "bakery": ["베이커리", "빵집", "제과", "제과점", "빵"],
    "chicken": ["치킨", "치킨집", "통닭", "닭강정"],
}
SOURCES = {
    "krei_raw": {"title": "2025 외식업체 경영실태 조사 (원자료, 가중치 적용)", "publisher": "농림축산식품부·한국농촌경제연구원", "period": "2024년 실적 (조사 2025.8~10)",
                 "url": "https://www.mafra.go.kr/bbs/home/798/595247/download.do", "api": "통계보고서 PDF와 원자료 엑셀 (pipelines/build_industry_krei.py)"},
    "seoul_store": {"title": "서울시 상권분석서비스 점포·추정매출 (상권, 행정동)", "publisher": "서울특별시", "period": "2025년 1~4분기",
                    "url": "https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do", "api": "OA-15577, OA-15572, VwsmAdstrdStorW"},
    "sbiz_store": {"title": "소상공인시장진흥공단 상가(상권)정보", "publisher": "소상공인시장진흥공단", "period": "2026년 6월",
                   "url": "https://www.data.go.kr/data/15083033/fileData.do", "api": "data.go.kr 15083033"},
}


def man(v: float) -> str:
    v = round(v)
    if v >= 10000:
        eok, rest = divmod(v, 10000)
        return f"{eok}억 {rest:,}만원" if rest else f"{eok}억원"
    return f"{v:,}만원"


def _batchim(word: str) -> bool:
    ch = word[-1]
    return "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 != 0


def josa(word: str, pair: str) -> str:
    """josa('베이커리', '은는') -> '베이커리는', josa('치킨집', '을를') -> '치킨집을'."""
    return word + (pair[0] if _batchim(word) else pair[1])


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def build() -> dict:
    krei = json.loads((DIR / "krei.json").read_text(encoding="utf-8"))["groups"]
    rank = json.loads((DIR / "rank.json").read_text(encoding="utf-8"))
    gu = json.loads((REPO / "web" / "public" / "mock" / "industry_gu.json").read_text(encoding="utf-8"))
    facts: list[dict] = []
    for ind, k in INDUSTRIES.items():
        y = yaml.safe_load((DIR / f"{ind}.yaml").read_text(encoding="utf-8"))
        g = krei[ind]
        v, sh = g["values"], g["pl_share"]
        name, lab = k["name"], k["krei_label"]
        w = WORDS[ind]
        ch = y["demand"]["channel_share"]["value"]
        add = lambda key, tags, text, src: facts.append({"id": f"ind_{ind}_{key}", "tags": w + tags, "text": text, "sources": src})  # noqa: E731
        add("sales", ["매출", "월매출", "연매출", "평균", "중앙값"],
            f"{name}({lab})의 연 매출은 평균 {man(g['pl_mean_man']['sales'])}, 중앙값 {man(v['sales']['p50'])}이에요. "
            f"4분의 1은 {man(v['sales']['p25'])} 아래, 4분의 1은 {man(v['sales']['p75'])} 위예요 (경영실태조사 2025, 전국 {g['n']}곳).", ["krei_raw"])
        add("ticket", ["객단가", "가격", "1인"], f"{name}의 평균 객단가는 1인 {round(v['ticket']['mean']):,}원이에요 (경영실태조사 2025, 전국).", ["krei_raw"])
        add("cost", ["식재료비", "원가율", "인건비", "임차료", "비용 구조", "비율", "영업이익률", "마진", "%"],
            f"{josa(name, '은는')} 매출 중 식재료비 {pct(sh['food'])}, 고용인 인건비 {pct(sh['labor_hired'])}, 임차료 {pct(sh['rent'])}, 세금과 공과 {pct(sh['tax'])}, "
            f"기타 {pct(sh['other'])}를 쓰고, 대표자 인건비 {pct(sh['labor_owner'])}를 뺀 영업이익은 {pct(sh['profit'])}예요 (경영실태조사 2025, 전국 평균).", ["krei_raw"])
        add("channel", ["배달", "포장", "테이크아웃", "홀", "비중"],
            f"{name} 매출은 홀 {pct(ch['hall'])}, 배달 {pct(ch['delivery'])}, 포장 {pct(ch['takeout'])}로 나뉘어요. "
            f"배달 비용(대행 + 배달앱)은 배달 매출의 약 {pct(y['cost']['delivery_cost_of_delivery_revenue']['value'])}예요 (경영실태조사 2025로 계산).", ["krei_raw"])
        o, c = y["demand"]["hours"]["value"]
        add("ops", ["영업시간", "몇 시", "영업일", "직원", "좌석", "평수", "면적", "테이블", "몇 평", "몇 명"],
            f"보통의 {josa(name, '은는')} {o}시에 열어 {c % 24 if c >= 24 else c}시{'(다음 날)' if c > 24 else ''}에 닫고 한 달 {y['demand']['days_month']['value']:.0f}일 일해요. "
            f"면적 중앙값 {v['area_pyeong']['p50']:.0f}평, 좌석 {v['seats']['p50']:.0f}석, 사장님 포함 {v['workers']['p50']:.0f}명이 일해요 (경영실태조사 2025, 중앙값).", ["krei_raw"])
        add("invest", ["창업", "창업 비용", "비용", "투자", "인테리어", "주방", "권리금", "보증금", "여는 데", "얼마 들"],
            f"{josa(name, '을를')} 열 때 시설 투자(보증금·권리금 빼고) 중앙값은 {man(v['invest']['p50'])}이에요 (4분의 1~4분의 3: {man(v['invest']['p25'])}~{man(v['invest']['p75'])}). "
            f"권리금을 낸 곳의 중앙값은 {man(v['key_money']['p50'])}, 보증금 중앙값은 {man(v['deposit']['p50'])}이에요 (경영실태조사 2025, 전국).", ["krei_raw"])
        s = gu[ind]["seoul"]
        row = next(r for r in rank["services"] if r["code"] == k["service"])
        add("seoul", ["서울", "가게 수", "몇 곳", "점포 수", "폐업률", "개업", "경쟁"],
            f"서울의 {name}({k['sbiz_label']}){josa(name, '은는')[len(name):]} {s['count']:,}곳이에요 (소상공인 상가정보 2026년 6월). "
            f"상권분석서비스 {k['base']} 기준 2025년 한 해 {row['opened_year']:,}곳이 새로 열고 {row['closed_year']:,}곳이 닫아 개업률 {pct(row['open_rate'])}, 폐업률 {pct(row['close_rate'])}예요"
            f"{' (한식음식점 전체 값)' if ind == 'hansik' else ''}.", ["sbiz_store", "seoul_store"])
        top = sorted(gu[ind]["gu"].items(), key=lambda kv: -kv[1]["demand_index"])[:3]
        add("top_gu", ["어느 구", "가장", "매출이 높은", "잘 되는", "추천"],
            f"{name} 점포당 매출이 서울 평균보다 높은 구는 " + ", ".join(f"{n}({r['demand_index']:.2f}배)" for n, r in top)
            + f" 순이에요. 카드 추정 매출이라 배달 비중이 큰 업종은 낮게 잡혀요 (서울시 상권분석서비스 2025, {k['base']}).", ["seoul_store"])
        add("why", ["왜", "고른", "추가", "업종", "청년"],
            f"{josa(name, '은는')} 서울에서 가게가 많고 새로 여는 곳이 많은 업종이라 넣었어요. 2021년 이후 연 가게 중 {pct(rank['krei']['recent'][row['name'] if ind != 'hansik' else '백반·한식 일반'])}, "
            f"40세 미만이 연 가게 중 {pct(rank['krei']['young'][row['name'] if ind != 'hansik' else '백반·한식 일반'])}가 이 업종이에요 (경영실태조사 2025 원자료, 전국).", ["krei_raw"])
        for gname, r in gu[ind]["gu"].items():
            facts.append({"id": f"ind_{ind}_gu_{gname}", "gu": gname, "tags": w + [gname, gname[:-1], "가게 수", "몇 곳", "폐업률", "매출", "경쟁"],
                          "text": f"{gname}의 {josa(name, '은는')} {r['count']:,}곳이에요 (소상공인 상가정보). 상권 안 {k['base']}의 1년 폐업률은 {pct(r['closure_rate'])}, "
                                  f"개업률은 {pct(r['opening_rate'])}이고, 점포당 카드 매출은 서울 평균의 {r['demand_index']:.2f}배예요 (서울시 상권분석서비스 2025).",
                          "sources": ["sbiz_store", "seoul_store"]})
    return {"_meta": {"method": "pipelines/build_industry_facts.py", "count": len(facts)}, "sources": SOURCES, "facts": facts}


if __name__ == "__main__":
    d = build()
    OUT.write_text(json.dumps(d, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"{OUT.name}: {len(d['facts'])}개")
