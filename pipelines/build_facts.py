"""챗봇이 답할 때 근거로 쓰는 항목(facts)을 만든다.

    python -m pipelines.build_facts

입력은 이미 받아 둔 공공 API 결과물(web/public/mock/*.json)이고, 출력은 web/public/mock/facts.json 이다.
항목마다 문장(text), 태그(tags), 출처(sources)를 붙인다. 답변 문장은 이 문장을 그대로 쓴다.
모델이 숫자를 만들지 않도록, 숫자가 있는 문장은 모두 여기서 만든다.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "facts.json"

SOURCES = {
    "sbiz": {
        "publisher": "소상공인시장진흥공단", "title": "상가(상권)정보", "api": "data.go.kr 15083033",
        "url": "https://www.data.go.kr/data/15083033/openapi.do", "period": "2026.06.30 스냅샷",
    },
    "seoul_sales": {
        "publisher": "서울특별시 / 서울신용보증재단", "title": "상권분석서비스 추정매출·점포·영역 (상권 단위)",
        "api": "OA-15572, OA-15577, OA-15560", "url": "https://data.seoul.go.kr", "period": "2025년 1~4분기",
    },
    "kma_asos": {
        "publisher": "기상청", "title": "지상(종관, ASOS) 일자료 조회서비스 (서울 108)",
        "api": "data.go.kr 15059093", "url": "https://www.data.go.kr/data/15059093/openapi.do", "period": "2016~2025년",
    },
    "kosis_price": {
        "publisher": "국가데이터처 (KOSIS)", "title": "생활물가지수 (시도별 품목, 2020=100)",
        "api": "KOSIS DT_1J22005", "url": "https://kosis.kr", "period": "2021년 1월~2026년 9월",
    },
    "kma_asos_hourly": {
        "publisher": "기상청", "title": "지상(종관, ASOS) 시간자료 조회서비스 (서울 108)",
        "api": "data.go.kr 시간자료 (AsosHourlyInfoService)", "url": "https://www.data.go.kr",
        "period": "2016~2025년",
    },
    "kmta_2026_10": {
        "publisher": "한국육류유통수출협회", "title": "월간 육류유통 2026년 10월호 (Vol.135)",
        "api": "잡지 본문 (협회 자체 조사 + 정부 통계 인용)", "url": "", "period": "2026년 8~9월 자료, 10월 전망",
    },
    "kape": {
        "publisher": "축산물품질평가원·축산유통정보 (KAPE 통계DB) / 국가데이터처 가축동향조사",
        "title": "소 가축시장 산지가격, 축종별 시도별 농장수 및 마리수",
        "api": "KAPE 통계DB 화면 조회", "url": "", "period": "가격 2026년 7~9월, 농장 2026년 2분기",
    },
    "kape_pig": {
        "publisher": "국가데이터처 가축동향조사 (KAPE 통계DB)", "title": "돼지 시도 월령별·사육규모별 농장수 및 마리수",
        "api": "KAPE 통계DB 화면 조회", "url": "", "period": "2026년 1~2분기",
    },
    "kape_pork": {
        "publisher": "축산물품질평가원·축산유통정보 (KAPE 통계DB)", "title": "돼지고기 유통비용률, 부위별 소비자가격, 수입 소비자가격, 재고, 도매 식육포장가격",
        "api": "KAPE 통계DB 화면 조회", "url": "", "period": "2021~2026년 (자료별 기간 상이)",
    },
    "kape_auction": {
        "publisher": "축산물품질평가원 (KAPE 통계DB)", "title": "돼지 등급별 경락가격 (돈피·성별·등급)",
        "api": "KAPE 통계DB 화면 조회", "url": "", "period": "2026년 7~9월",
    },
    "kasi": {
        "publisher": "한국천문연구원", "title": "특일 정보 (공휴일)", "api": "data.go.kr 15012690",
        "url": "https://www.data.go.kr/data/15012690/openapi.do", "period": "2026~2027년",
    },
}

MONTH = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"]


def short_names(gu: str) -> list[str]:
    """'강남구' -> ['강남구', '강남'] (두 글자 이상일 때만 짧은 이름을 붙인다)."""
    stem = gu[:-1] if gu.endswith("구") else gu
    return [gu, stem] if len(stem) >= 2 and stem != gu else [gu]


def pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def build() -> list[dict]:
    facts: list[dict] = []
    gu_stats = json.loads((MOCK / "gu_stats.json").read_text(encoding="utf-8"))
    pork_gu = gu_stats["pork"]["gu"]
    hansik_gu = gu_stats["bbq"]["gu"]
    cafe_gu = gu_stats["cafe"]["gu"]
    seoul_bbq = gu_stats["bbq"]["seoul"]
    seoul_cafe = gu_stats["cafe"]["seoul"]

    # 1) 돼지고기 구이·찜 점포 수 (상가정보)
    ranked = sorted(pork_gu.items(), key=lambda kv: -kv[1]["pork"])
    for gu, v in ranked:
        facts.append({
            "id": f"pork_{gu}", "tags": [*short_names(gu), "고깃집", "돼지고기", "경쟁", "점포"],
            "text": f"{gu}에는 돼지고기 구이·찜 점포가 {v['pork']:,}곳 있어요. 서울 25개 구 중 {ranked.index((gu, v)) + 1}번째예요.",
            "sources": ["sbiz"],
        })
    facts.append({
        "id": "pork_top", "tags": ["고깃집", "돼지고기", "구"],
        "text": f"돼지고기 구이·찜 점포가 가장 많은 구는 {ranked[0][0]}({ranked[0][1]['pork']:,}곳)이고, 가장 적은 구는 {ranked[-1][0]}({ranked[-1][1]['pork']:,}곳)이에요.",
        "sources": ["sbiz"],
    })

    # 2) 한식음식점 상권 지표 (상권분석)
    for gu, v in hansik_gu.items():
        facts.append({
            "id": f"hansik_{gu}", "tags": [*short_names(gu), "한식", "매출", "폐업", "상권"],
            "text": (f"{gu} 상권의 한식음식점은 점포당 월매출이 약 {v['sales_per_store_month']:,}만원이고, 객단가는 약 {v['ticket']:,}원이에요. "
                     f"저녁(17~24시) 매출 비중은 {pct(v['evening_share'])}, 연간 폐업률은 {pct(v['closure_rate'])}예요."),
            "sources": ["seoul_sales"],
        })
    facts.append({
        "id": "hansik_seoul", "tags": ["서울", "한식", "매출", "평균"],
        "text": (f"서울 전체 한식음식점은 점포당 월매출이 약 {seoul_bbq['sales_per_store_month']:,}만원, 객단가 약 {seoul_bbq['ticket']:,}원, "
                 f"연간 폐업률 {pct(seoul_bbq['closure_rate'])}예요."),
        "sources": ["seoul_sales"],
    })

    # 3) 카페(커피-음료) 상권 지표
    for gu, v in cafe_gu.items():
        facts.append({
            "id": f"cafe_{gu}", "tags": [*short_names(gu), "카페", "커피", "매출", "폐업", "상권"],
            "text": (f"{gu} 상권의 커피-음료 점포는 점포당 월매출이 약 {v['sales_per_store_month']:,}만원이고, 객단가는 약 {v['ticket']:,}원이에요. "
                     f"연간 폐업률은 {pct(v['closure_rate'])}, 저녁(17~24시) 비중은 {pct(v['evening_share'])}예요."),
            "sources": ["seoul_sales"],
        })
    facts.append({
        "id": "cafe_seoul", "tags": ["서울", "카페", "커피", "평균"],
        "text": (f"서울 전체 커피-음료 점포는 점포당 월매출이 약 {seoul_cafe['sales_per_store_month']:,}만원, 객단가 약 {seoul_cafe['ticket']:,}원, "
                 f"연간 폐업률 {pct(seoul_cafe['closure_rate'])}예요."),
        "sources": ["seoul_sales"],
    })

    # 4) 월별 날씨 (기상청 ASOS, 서울 108, 2016~2025)
    weather = json.loads((MOCK / "weather_seoul.json").read_text(encoding="utf-8"))
    for m in weather["months"]:
        i = m["month"] - 1
        facts.append({
            "id": f"weather_{m['month']:02d}", "tags": [MONTH[i], "날씨", "비", "강수", "기온"],
            "text": (f"{MONTH[i]}에는 비 온 날이 전체의 {pct(m['rain_share'])}예요(하루 1mm 이상 기준). "
                     f"큰비(30mm 이상)는 {pct(m['heavy_rain_share'])}, 평균 기온은 {m['avg_temp']}도예요."),
            "sources": ["kma_asos"],
        })

    # 5) 공휴일 (특일 정보)
    days = json.loads((MOCK / "holidays.json").read_text(encoding="utf-8"))["days"]
    for year in (2026, 2027):
        n = sum(1 for d in days if d.startswith(str(year)))
        facts.append({
            "id": f"holiday_{year}", "tags": ["공휴일", "휴일", str(year)],
            "text": f"{year}년 공휴일은 모두 {n}일이에요.",
            "sources": ["kasi"],
        })
    # 6) 돼지고기·삼겹살(외식) 물가 지수 (KOSIS DT_1J22005)
    pork_path = MOCK / "kosis_pork.json"
    if pork_path.exists():
        series = json.loads(pork_path.read_text(encoding="utf-8"))["series"]
        region_tags = {"전국": ["전국"], "서울특별시": ["서울"], "강원특별자치도": ["강원"]}
        for key, vals in series.items():
            item, region = key.split("|")
            avg = lambda y: sum(v for p, v in vals.items() if p.startswith(str(y))) / 12
            a21, a25 = avg(2021), avg(2025)
            last_p = max(vals)
            last = vals[last_p]
            ym = f"{last_p[:4]}년 {int(last_p[4:])}월"
            facts.append({
                "id": f"price_{item}_{region}", "tags": [*region_tags[region], item.split("(")[0], "돼지고기", "삼겹살", "가격", "물가", "지수", "올랐"],
                "text": (f"{region}의 {item} 물가 지수는 2021년 평균 {a21:.1f}에서 2025년 평균 {a25:.1f}로 "
                         f"{(a25 / a21 - 1) * 100:+.1f}% 변했고, {ym}에는 {last:.1f}예요(2020년=100)."),
                "sources": ["kosis_price"],
            })
    # 7) 월별 저녁(17~23시) 비 온 시간 비율 (기상청 시간자료)
    hourly_path = MOCK / "asos_hourly.json"
    if hourly_path.exists():
        for m in json.loads(hourly_path.read_text(encoding="utf-8"))["months"]:
            i = m["month"] - 1
            facts.append({
                "id": f"hourly_rain_{m['month']:02d}", "tags": [MONTH[i], "저녁", "비", "강수", "시간", "장사"],
                "text": (f"{MONTH[i]} 저녁(17~23시)에는 시간의 {pct(m['evening_hour_rain_share'])}에 비가 왔어요. "
                         f"하루 전체로는 {pct(m['all_hour_rain_share'])}예요(2016~2025년 평균)."),
                "sources": ["kma_asos_hourly"],
            })
    # 8) 월간 육류유통 2026년 10월호 (가격·전망 표, 쪽 번호 포함)
    kmta_path = MOCK / "kmta_2026_10.json"
    if kmta_path.exists():
        for item in json.loads(kmta_path.read_text(encoding="utf-8"))["facts"]:
            facts.append({
                "id": item["id"], "tags": item["tags"],
                "text": item["text"],
                "sources": ["kmta_2026_10"],
            })
    # 9) KAPE 통계DB 화면 (소 가축시장 산지가격, 시도별 농장수·마리수)
    kape_path = MOCK / "kape_2026.json"
    if kape_path.exists():
        for item in json.loads(kape_path.read_text(encoding="utf-8"))["facts"]:
            facts.append({"id": item["id"], "tags": item["tags"], "text": item["text"], "sources": ["kape"]})
    # 10) 돼지 사육 두수 (KAPE 통계DB, 국가데이터처 가축동향조사)
    pig_path = MOCK / "pig_2026.json"
    if pig_path.exists():
        for item in json.loads(pig_path.read_text(encoding="utf-8"))["facts"]:
            facts.append({"id": item["id"], "tags": item["tags"], "text": item["text"], "sources": ["kape_pig"]})
    # 11) 돼지고기 유통·소비자가격·재고·도매 (KAPE 통계DB)
    pk_path = MOCK / "pork_kape_2026.json"
    if pk_path.exists():
        for item in json.loads(pk_path.read_text(encoding="utf-8"))["facts"]:
            facts.append({"id": item["id"], "tags": item["tags"], "text": item["text"], "sources": ["kape_pork"]})
    # 12) 돼지 등급별 경락가격 (축산물품질평가원, 2026년 7~9월, 전국 기준)
    au_path = MOCK / "pig_auction_2026.json"
    if au_path.exists():
        for item in json.loads(au_path.read_text(encoding="utf-8"))["facts"]:
            facts.append({"id": item["id"], "tags": item["tags"], "text": item["text"], "sources": ["kape_auction"]})
    return facts


def main() -> None:
    facts = build()
    OUT.write_text(json.dumps({"sources": SOURCES, "facts": facts}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(facts)} facts -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
