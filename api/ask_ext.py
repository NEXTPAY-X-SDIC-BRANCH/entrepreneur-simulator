"""챗봇 /ask 확장: 우리 사실 합치기, 주제 필터, 화면이 보낸 점포 값(ctx)으로 즉석 문장 만들기.

api/cite_api.py의 검색 점수 계산(_rank_facts)과 근거 파일(facts.json)은 그대로 쓰고, 그 앞뒤만 바꾼다.
cite_api.py 끝에서 install(app)을 한 번 부르면 /ask 가 이 모듈의 것으로 바뀐다.

하는 일
  1. 근거 합치기   facts.json (API 자료) + facts_changeup.json (월세, 동네, 경영 지표) + ctx 로 만든 문장
  2. 주제 필터     질문에서 주제를 먼저 알아내고, 그 주제의 근거 문장만 후보로 남긴다. 모델은 쓰지 않는다.
  3. 범위 밖 질문  로또, 주식, 세금처럼 이 서비스가 다루지 않는 질문은 억지로 답하지 않는다.
  4. 모를 때       맞는 근거가 없으면 없다고 말한다 (다른 주제의 문장을 대신 붙이지 않는다).
LLM 이나 임베딩을 쓰지 않으므로 답은 근거 문장 그대로이고 비용이 들지 않는다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOCK = ROOT / "web" / "public" / "mock"

# ---------------------------------------------------------------- 주제 (질문 정규식 -> 근거 문장 id 접두사)
FAMILIES: dict[str, tuple[str, ...]] = {
    "weather": ("weather", "hourly_rain"),
    "holiday": ("holiday",),
    "rent": ("rent_", "premium", "kosis_cost_임차료", "live_rent", "live_deposit", "cafe_rent"),
    "competition": ("pork", "dong_", "live_shop", "cafe_competition", "qfdong_"),
    "sales": ("hansik", "cafe", "dong_", "cafe_sales", "survival_", "qfdong_"),
    "neighborhood": ("dong_", "rent_dong_", "cafe_dong"),
    "meat_price": ("price_", "kmta_pork", "kmta_import", "kmta_retail_pork", "kmta_market_pork", "pork_retail", "pork_import",
                   "pork_wholesale", "pork_margin", "pork_stock", "pig_auction", "food_pork", "food_chicken", "costidx_pork", "backtest_"),
    "food_price": ("kamis_", "food_", "costidx_veg", "backtest_"),  # 채소·곡물·식재료 가격 (KAMIS, 서울 생활물가지수 food_cost.json)
    "livestock": ("kape_", "pig_", "kmta_hanwoo", "kmta_pork_grading", "kmta_pork_consumption"),
    "cafe": ("cafe_", "coffee_", "dessert_", "beverage_", "sns_cafe", "sbizdlvy_seoul_cafe", "sbizdlvy_cafe_"),
    "cafe_cost": ("cafe_cost_", "cafe_startup", "cafe_investment"),
    "cafe_menu_price": ("cafe_menu_price",),  # 카페 메뉴 가격
    "cost": ("kosis_", "cafe_cost_"),
    "myshop": ("live_", "cafe_myshop"),
    "flow": ("flow_", "live_flow", "live_type"),
    "loan": ("ecos_", "live_loan", "bank_"),       # 은행 대출 금리 (pipelines/fetch_ecos.py) + 은행별 개인사업자 금리 (pipelines/fetch_kfb_rates.py)
    "support": ("kstartup_",),            # 창업 지원사업 공고 (pipelines/fetch_kstartup.py)
    "apparel": ("apparel_", "fashion_", "ftc_interior_apparel", "sns_apparel"),  # 옷가게: 상권분석·도소매업조사·생존율 + 패션 소비 실태조사·수입 원가·재고 논문
    "chicken": ("chicken_", "food_chicken", "food_oil", "delivery_", "sbizdlvy_seoul_chicken", "sbizdlvy_trend_chicken", "sbizdlvy_chicken_", "qfdong_chicken_", "sns_chicken"),  # 치킨집: 경영실태조사·상권분석 치킨전문점·닭고기·식용유 시세
    "bunsik": ("bunsik_", "food_rice", "food_tteok", "food_fishcake", "food_egg", "delivery_", "sbizdlvy_seoul_bunsik", "sbizdlvy_trend_bunsik", "sbizdlvy_bunsik_", "qfdong_bunsik_", "sns_bunsik"),  # 분식집: 경영실태조사·상권분석 분식전문점·쌀·떡·어묵·달걀
    "interior": ("ftc_interior_", "cafe_cost_"),  # 가맹점 평당 인테리어 (공정위 정보공개서)
    "delivery": ("delivery_", "sbizdlvy_"),           # 배달 시장·수수료 + 소상공인365 배달분석 (구·동네별 점포당 배달 주문)
    "sns": ("sns_",),                     # 소상공인365 SNS 분석 (업종 키워드 언급 수·연관어)
    # 배달 (pipelines/fetch_kosis_delivery.py, season_params.yaml delivery)
}
TOPIC_RE: list[tuple[str, re.Pattern]] = [
    ("weather", re.compile(r"날씨|기온|장마|강수|소나기|비가|비 ?(오|와|온|올|내)|눈이|눈 ?(오|와|온)|더위|추위|한파|폭염")),
    ("holiday", re.compile(r"공휴일|휴일|연휴|명절|설날|추석|쉬는 ?날")),
    ("rent", re.compile(r"월세|임대|임차|보증금|권리금|평당")),
    # 카페 관련: café_cost > café > café 가격
    ("cafe_cost", re.compile(r"카페 ?창업|카페 ?오픈|카페 ?비용|카페 ?투자|카페 ?인테리어|카페 ?장비|에스프레소 ?머신|커피 ?머신|그라인더|쇼케이스|원두 ?가격|원두 ?구매|커피 ?원두|원두|식재료비|인건비|보증금|권리금|아메리카노 ?가격|라떼 ?가격|카페 ?메뉴 ?가격|음료 ?가격")),
    ("cafe", re.compile(r"카페 ?(동네|분석|특성|환경|입지|위치)|커피 ?(전문|가게)|디저트|베이커리|음료 ?(가게|점포)|아메리카노|라떼|에스프레소|카푸치노")),
    # 고깃집 관련: competition > livestock > meat_price (고기만)
    ("competition", re.compile(r"경쟁|몇 ?곳|몇 ?군데|가게 ?수|점포 ?수|고깃집 ?수|고깃집이 ?몇|몇 ?개|가장 많은 ?(구|동)|새로 ?생기|카페 ?수|카페가 ?몇")),
    ("livestock", re.compile(r"사육|마릿수|마리|두수|농장|농가|출하|도축|자돈|젖소|한우|육우|송아지")),
    # 고기 가격과 채소 가격 분리
    ("meat_price", re.compile(r"삼겹|목살|목심|항정|kg|지육|원육|고기 ?값|도매 ?가|소매 ?가|경락|시세|소비자가|돼지|소고기|닭고기")),
    ("food_price", re.compile(r"상추|깻잎|당근|배추|양배추|양파|감자|고구마|대파|쪽파|마늘|고추|오이|호박|버섯|시금치|토마토|부추|미나리|"
                              r"생강|브로콜리|파프리카|피망|열무|채소|야채|쌀|현미|콩|팥|녹두|밀가루|식용유|설탕|계란|달걀")),
    ("sales", re.compile(r"매출|객단가|폐업|생존|문 ?닫|결제|한식음식점")),
    ("flow", re.compile(r"유동|지나가|지나다|인구|직장인|일하러|상주|거주|주민|사는 ?사람|연령|나이대|성별|남성|여성|남자|여자|[1-6]0대|시간대|요일|붐비|북적")),
    ("loan", re.compile(r"금리|이자|기준금리|대출|정책 ?자금|융자")),
    ("support", re.compile(r"지원 ?사업|공고|창업 ?교육|컨설팅|멘토링|보육|입주|지원금|[Kk]-?스타트업|케이스타트업")),
    ("delivery", re.compile(r"배달|배민|쿠팡 ?이츠|요기요|중개 ?수수료")),
    ("sns", re.compile(r"SNS|sns|에스엔에스|인스타|블로그|언급|연관어|해시태그|반응|입소문|화제")),
    ("apparel", re.compile(r"옷가게|옷 ?가게|의류|옷 ?장사|패션|보세|옷을 ?팔")),
    ("chicken", re.compile(r"치킨|통닭|닭집|프라이드|양념 ?치킨")),
    ("bunsik", re.compile(r"분식|떡볶이|김밥|순대|튀김 ?가게")),
    ("interior", re.compile(r"인테리어|공사비|가맹점|프랜차이즈|정보공개서")),
    ("neighborhood", re.compile(r"동네|행정동|유형")),
    ("cost", re.compile(r"영업이익률|원가율|마진|비용 ?구조|비율|퍼센트|몇 ?%|몇 ?프로")),
    ("myshop", re.compile(r"이 ?(동네|구|지역)|내 ?(가게|점포|조건)|제 ?가게|우리 ?가게|입력한|내가|제가|본전|회수|되찾|흑자|적자|몇 ?달|개월|영업이익(?!률)|"
                          r"현금|잔고|여는 ?데|창업 ?비용|들어요|드는|투자|대출|직원|알바|테이블|평수|몇 ?평|좌석|몇 ?석|시뮬레이션|"
                          r"하루에 ?몇|몇 ?명|남기|남아요|남나요")),
]
OWN = re.compile(r"내 ?(가게|점포|조건|월세)|제 ?가게|우리 ?가게|입력한|내가|제가|지금 ?(내|제)|이 ?(동네|구|지역)|여기")
OFFTOPIC = re.compile(r"로또|비트코인|코인|주식|펀드|환율|대통령|선거|축구|야구|연애|영화|숙제|세금|세무|부가세|법률|소송|"
                      r"(내일|오늘|모레|이번 ?주).{0,6}(날씨|비)|맛집 ?추천|번호 ?알려")
PORK_PRICE = re.compile(r"^pork_(retail|import|wholesale|margin|stock)")
RULEQ = re.compile(r"어떻게 ?(나눠|분류|정해|구분|나누)|분류 ?(기준|방법)|기준이 ?뭐|규칙")
SNOW = re.compile(r"눈 ?(이|도)? ?(오|와|온|올|내)|폭설|적설")
# 서울 25개 구 이름 (조사가 붙어도: "동작구에", "마포구는"). 긴 이름을 먼저 (동대문구가 중구보다 앞)
GU = re.compile(r"(?<![가-힣])(강남구|강동구|강북구|강서구|관악구|광진구|구로구|금천구|노원구|도봉구|동대문구|동작구|마포구|서대문구|서초구|성동구|성북구|송파구|양천구|영등포구|용산구|은평구|종로구|중랑구|중구)")
PER_GU = re.compile(r"^(hansik_(?!seoul)|cafe_(?!seoul)|pork_(?!top|retail|import|wholesale|margin|stock)|chicken_gu_|bunsik_gu_|delivery_gu_)")
EFFECT = re.compile(r"줄어|늘어|영향|효과|떨어|오르면|내리면|올리면|때문에|손님이 ?(줄|늘)")

# 가격을 물을 수 있는 품목. 질문에 품목이 나오면 그 품목 이름이 들어간 근거만 답에 쓴다 (다른 품목으로 대신하지 않는다).
ITEMS: list[tuple[str, re.Pattern]] = [
    ("상추", re.compile(r"상추")), ("깻잎", re.compile(r"깻잎")), ("당근", re.compile(r"당근")),
    ("배추", re.compile(r"(?<!양)배추")), ("양배추", re.compile(r"양배추")), ("양파", re.compile(r"양파")),
    ("감자", re.compile(r"감자")), ("대파", re.compile(r"대파|쪽파")), ("마늘", re.compile(r"마늘")),
    ("고추", re.compile(r"고추")), ("오이", re.compile(r"오이")), ("호박", re.compile(r"호박")),
    ("버섯", re.compile(r"버섯")), ("쌀", re.compile(r"쌀(?!국수)")), ("고구마", re.compile(r"고구마")),
    ("시금치", re.compile(r"시금치")), ("토마토", re.compile(r"토마토")), ("부추", re.compile(r"부추")),
    ("미나리", re.compile(r"미나리")), ("생강", re.compile(r"생강")), ("브로콜리", re.compile(r"브로콜리")),
    ("파프리카", re.compile(r"파프리카|피망")), ("열무", re.compile(r"열무")), ("현미", re.compile(r"현미")),
    ("팥", re.compile(r"팥")), ("녹두", re.compile(r"녹두")), ("떡", re.compile(r"(?<!볶)떡(?!볶)")), ("어묵", re.compile(r"어묵|오뎅")),
    ("밀가루", re.compile(r"밀가루")), ("식용유", re.compile(r"식용유")), ("설탕", re.compile(r"설탕")),
    ("계란", re.compile(r"계란|달걀")), ("우유", re.compile(r"우유")),
    ("원두", re.compile(r"원두|커피 ?콩")),
    ("삼겹살", re.compile(r"삼겹")), ("목살", re.compile(r"목살|목심")), ("갈비", re.compile(r"갈비")),
    ("항정살", re.compile(r"항정")), ("소고기", re.compile(r"소고기|쇠고기|한우")), ("닭고기", re.compile(r"닭")),
    ("돼지고기", re.compile(r"돼지")),
]
PRICE_Q = re.compile(r"가격|얼마|시세|값|단가|비싸|싸[요나니게]|올랐|내렸|오르|내리|물가")
PRICE_WORD = re.compile(r"가격|물가|시세|원/|원이에요|원이고")
HAVE_PRICES = ("지금 가격 자료가 있는 품목은 돼지고기(삼겹살·목심·갈비 등) 소비자가격과 물가지수, "
               "서울 채소·곡물 소매가격(KAMIS: 상추, 깻잎, 양파, 대파, 마늘, 고추, 쌀 등), 카페 원두 구매량·구매 금액, "
               "서울 생활물가지수(닭고기·달걀·우유·쌀·식용유·떡·어묵·커피)예요. 닭고기 도매가(생계·도계)는 아직 없어요.")

NONE_MESSAGE = ("죄송해요, 그 질문에 맞는 근거 자료를 찾지 못했어요.\n"
                "이런 질문에는 자료를 바탕으로 답할 수 있어요.\n"
                "• 월세, 보증금, 권리금 (지역별)\n"
                "• 카페 창업 비용: 인테리어, 장비, 원두 구매량, 식재료비\n"
                "• 카페·고깃집 경쟁: 지역별 가게 수, 폐업률, 매출\n"
                "• 동네 분석: 유동인구, 직장인구, 동네 유형\n"
                "• 고기 가격: 돼지고기 소비자가격, 물가지수\n"
                "• 채소·곡물 가격: 서울 소매가격 (상추, 양파, 대파, 마늘, 쌀 등)\n"
                "• 대출 금리 (은행 평균, 기준금리), 창업 지원사업 공고\n"
                "• 배달 시장 규모, 배달앱 수수료, 신생 가게 생존율\n"
                "• 날씨, 공휴일")
OFF_MESSAGE = "죄송해요, 그건 이 서비스 범위를 벗어나요. 🙅\n이 서비스는 가게를 열 때 필요한 숫자(동네 분석, 월세, 창업 비용, 재료비, 메뉴 가격, 시뮬레이션)만 다뤄요.\n세금, 법률, 투자 상품, 주식 같은 질문은 전문가 상담을 받아보세요."


# 업종 구분: 카페를 물으면 고깃집·한식 근거를, 고깃집을 물으면 카페 근거를 빼다
CAFE_Q = re.compile(r"카페|커피|원두|음료|디저트|베이커리|아메리카노|라떼|에스프레소")
MEAT_Q = re.compile(r"고깃집|고기|삼겹|목살|목심|갈비|항정|돼지|소고기|한우|닭|한식|육류|정육")
MEAT_ID = re.compile(r"^(hansik|pork|kmta|kape|pig_|price_)")
MEAT_TEXT = re.compile(r"한식음식점|고깃집|돼지|삼겹|육류")
CAFE_ID = re.compile(r"^(cafe|coffee_|dessert_|beverage_)")


def yeyo(s: str) -> str:
    """'40kg/월' -> '40kg/월이에요', '12.7%' -> '12.7%예요' (받침에 맞춰 이에요/예요)."""
    ch = s.rstrip()[-1:] or "요"
    if "가" <= ch <= "힣":
        batchim = (ord(ch) - 0xAC00) % 28 != 0
    else:
        batchim = ch in "013678" or ch.isalpha() and ch.lower() in "glmn"
    return s + ("이에요" if batchim else "예요")


# ---------------------------------------------------------------- 근거 읽기
_CACHE: dict[str, tuple[tuple, dict]] = {}


def _load(name: str) -> dict:
    p = MOCK / name
    if not p.exists():
        return {"sources": {}, "facts": []}
    stamp = (p.stat().st_mtime_ns, p.stat().st_size)
    hit = _CACHE.get(name)
    if hit and hit[0] == stamp:
        return hit[1]
    d = json.loads(p.read_text(encoding="utf-8"))
    _CACHE[name] = (stamp, d)
    return d


def static_facts() -> tuple[list[dict], dict]:
    a = _load("facts.json")
    b = _load("facts_changeup.json")
    c = _load("cafe_gu.json")
    d = _load("cafe_dong.json")
    e = _load("cafe_cost.json")
    f = _load("kamis.json")  # 서울 채소·곡물 소매가격 (pipelines/fetch_kamis.py)
    x = _load("facts_extra.json")  # 식재료 시세·치킨·분식·패션·가맹 인테리어 (pipelines/build_facts_extra.py)
    y = _load("facts_sbiz365.json")  # 소상공인365 배달·SNS, 은행별 금리, 시세 검증, 치킨·분식 동네 (pipelines/build_facts_sbiz365.py)

    facts = a["facts"] + b["facts"] + f.get("facts", []) + x.get("facts", []) + y.get("facts", [])
    # 카페 JSON을 facts 형태로 변환
    if c.get("facts"):
        facts.extend([{
            "id": f"cafe_gu_{k}",
            "tags": ["카페", "구", "지표"],
            "text": f"서울 {k}: {v}",
            "sources": ["cafe_gu"]
        } for k, v in c.items() if isinstance(v, dict)])
    if d.get("facts"):
        facts.extend(d["facts"])

    # cafe_cost.json의 창업조건·비용을 facts로 변환 (출처는 항목마다 다르다)
    cafe_srcs: dict[str, dict] = {}
    if e.get("start"):
        for item in e["start"]:
            cost_id = item.get("id", "")
            name = item.get("name", "")
            unit = item.get("unit", "")
            low, base, high = item.get("low"), item.get("base"), item.get("high")
            note = item.get("note", "")

            # 낮음/기본/높음은 매장 분포의 25·50·75% 분위수다
            def fmt(v):
                if unit == "비율":
                    return f"{v * 100:.1f}%"
                if unit.startswith("만원") and v >= 10000:
                    eok, rest = divmod(round(v), 10000)
                    return f"{eok}억" + (f" {rest:,}만원" if rest else "원") + unit[2:]
                return f"{v:,}{unit}" if isinstance(v, int) else f"{v:,.1f}{unit}"

            if low is not None or base is not None or high is not None:
                if low is not None and low == high:
                    text = f"{name}: {yeyo(fmt(low))}."
                elif base is not None and low is not None and high is not None:
                    text = f"{name}: 보통 {yeyo(fmt(base))}. 4곳 중 1곳은 {fmt(low)} 이하, 4곳 중 1곳은 {fmt(high)} 이상이에요."
                elif base is not None:
                    text = f"{name}: 보통 {yeyo(fmt(base))}."
                else:
                    text = f"{name}: {yeyo((fmt(low) if low is not None else '') + '~' + (fmt(high) if high is not None else ''))}."
                if note:
                    text += f" 참고로 {note}."

                # 주제 태그: 검색 가능하게 카테고리화
                tags = ["카페", "비용"]
                if "원두" in name or "커피" in name or "빈" in name:
                    tags.extend(["원두", "커피", "재료비", "식재료"])
                if "보증금" in name:
                    tags.append("보증금")
                if "권리금" in name:
                    tags.append("권리금")
                if "월세" in name or "임차료" in name:
                    tags.append("월세")
                if "인건비" in name:
                    tags.append("인건비")
                if "인테리어" in name:
                    tags.append("인테리어")

                facts.append({
                    "id": f"cafe_cost_{cost_id}",
                    "tags": tags,
                    "text": text,
                    "sources": [f"cafe_cost:{item.get('source') or '외식업체 경영실태조사'}"]
                })
                src = item.get("source") or "외식업체 경영실태조사"
                cafe_srcs[f"cafe_cost:{src}"] = {
                    "publisher": "농림축산식품부·한국농촌경제연구원" if "경영실태조사" in src else "언론·업계 자료",
                    "title": src, "api": "카페 리서치 정리본 (cafe_cost.json)", "url": "", "period": "2025~2026년"}

    more, more_src = money_facts()
    facts += more

    sources = {**a["sources"], **b["sources"], **more_src}
    sources[FLOW_SRC] = {"title": "서울시 상권분석서비스 길단위인구·상주인구·직장인구 (행정동, 자치구)", "publisher": "서울특별시 열린데이터광장",
                         "period": "2026년 2분기", "url": "https://data.seoul.go.kr/", "api": "VwsmAdstrdFlpopW, VwsmAdstrdRepopW, VwsmAdstrdWrcPopltnW, VwsmSignguFlpopW"}
    if c.get("sources"):
        sources.update(c["sources"])
    if d.get("sources"):
        sources.update(d["sources"])
    sources.update(cafe_srcs)
    if f.get("sources"):
        sources.update(f["sources"])
    if x.get("sources"):
        sources.update(x["sources"])
    if y.get("sources"):
        sources.update(y["sources"])

    return facts, sources


def _ym(ym: str) -> str:
    return f"{ym[:4]}년 {int(ym[4:6])}월"


def _eok(v: float) -> str:
    """억원 -> '3조 9,677억 원'"""
    jo, rest = divmod(round(v), 10000)
    return (f"{jo}조 " if jo else "") + f"{rest:,}억 원"


def money_facts() -> tuple[list[dict], dict]:
    """대출 금리, 생존율, 배달 시장·수수료, 지원사업 공고를 근거 문장으로. 파일이 없으면 그 묶음만 빠진다."""
    facts: list[dict] = []
    src: dict[str, dict] = {}

    ecos = _load("ecos_rates.json").get("latest")  # pipelines/fetch_ecos.py
    if ecos and ecos.get("loan_sme"):
        sme, base = ecos["loan_sme"], ecos.get("base_rate")
        others = ", ".join(f"{n} 연 {ecos[k]['rate']}%" for k, n in (("loan_corp", "기업대출"), ("loan_avg", "대출 평균")) if ecos.get(k))
        facts.append({"id": "ecos_loan", "tags": ["대출", "금리", "이자", "은행", "중소기업", "사업자"],
                      "text": f"은행에서 새로 받는 중소기업대출 평균 금리는 연 {yeyo(str(sme['rate']) + '%')} ({_ym(sme['month'])})."
                              + (f" 같은 달 {others}예요." if others else "")
                              + " 정책자금이 아니라 은행 평균이라, 실제 금리는 신용과 상품에 따라 달라요."})
        if base:
            facts.append({"id": "ecos_base", "tags": ["기준금리", "금리", "한국은행", "변동금리"],
                          "text": f"한국은행 기준금리는 연 {yeyo(str(base['rate']) + '%')} ({_ym(base['month'])}). 변동금리 정책자금은 이 값을 따라 움직여요."})
        for f in facts[-2:]:
            f["sources"] = ["ecos"]
        src["ecos"] = {"publisher": "한국은행", "title": "경제통계시스템 기준금리·예금은행 대출금리(신규취급액)", "api": "ECOS 722Y001, 121Y006",
                       "url": "https://ecos.bok.or.kr", "period": _ym(sme["month"])}

    sv = _load("survival_kosis.json")  # pipelines/fetch_kosis_survival.py
    if sv.get("region"):
        y = sv["_meta"]["latest"]
        sf, ka = sv["region"]["seoul_food"][y], sv["region"]["korea_all"][y]
        facts.append({"id": "survival_seoul_food", "tags": ["생존율", "폐업", "생존", "음식점", "서울", "신생", "몇 년"],
                      "text": f"서울에서 새로 문을 연 숙박·음식점업 가게는 1년 뒤 {sf['1']}%, 3년 뒤 {sf['3']}%, 5년 뒤 {sf['5']}%가 살아남아요 ({y}년 기준). "
                              f"전국 전 업종은 1년 {ka['1']}%, 3년 {ka['3']}%, 5년 {ka['5']}%예요.", "sources": ["kosis_survival"]})
        ages = ", ".join(f"{a} {v[y]['3']}%" for a, v in sv["age"].items() if v.get(y))
        facts.append({"id": "survival_age", "tags": ["생존율", "폐업", "생존", "나이", "연령", "20대", "30대", "40대", "50대", "대표자"],
                      "text": f"대표자 나이대별 3년 생존율은 {ages}예요 (전 업종, {y}년 기준). 음식점업만 따로 본 나이대별 값은 없어요.",
                      "sources": ["kosis_survival"]})
        src["kosis_survival"] = {"publisher": "통계청", "title": "기업생멸행정통계 신생기업 생존율", "api": "KOSIS DT_6BD1109, DT_2BD1104",
                                 "url": "https://kosis.kr", "period": f"{y}년"}

    dm = _load("delivery_market.json")  # pipelines/fetch_kosis_delivery.py
    if dm.get("latest"):
        lt, mi = dm["latest"], {int(k): x for k, x in dm["month_index"].items()}
        hi, lo = max(mi, key=mi.get), min(mi, key=mi.get)
        facts.append({"id": "delivery_market", "tags": ["배달", "배달앱", "시장", "거래액", "온라인", "주문"],
                      "text": f"배달앱 같은 온라인 음식 주문 거래액은 {_ym(lt['month'])} 한 달 {_eok(lt['amount'])}으로, 1년 전보다 {lt['yoy']}% {'늘었' if lt['yoy'] >= 0 else '줄었'}어요. "
                              f"한 해 중 {hi}월이 가장 많고(평소의 {mi[hi]:.2f}배) {lo}월이 가장 적어요({mi[lo]:.2f}배).", "sources": ["kosis_delivery"]})
        src["kosis_delivery"] = {"publisher": "통계청", "title": "온라인쇼핑동향 상품군별 거래액 (음식서비스)", "api": "KOSIS DT_1KE10071",
                                 "url": "https://kosis.kr", "period": _ym(lt["month"])}
    try:
        import yaml
        dl = yaml.safe_load((ROOT / "research" / "season_params.yaml").read_text(encoding="utf-8"))["delivery"]
        tiers = "; ".join(f"{t['label']}는 중개수수료 {t['commission'] * 100:.1f}%에 배달비 건당 {t['rider_fee']:,}원"
                          for t in reversed(list(dl["tier"].values())))
        facts.append({"id": "delivery_fee", "tags": ["배달", "수수료", "중개", "배달비", "배민", "쿠팡이츠", "비용", "구간", "요금제"],
                      "text": f"배달앱 상생 요금제는 앱 안 매출 순위에 따라 달라요. {tiers}이에요 (서울, 부가세 별도). "
                              "결제대행 수수료는 따로 붙지만 영세·중소 가게는 카드 우대수수료율만큼만 내고 차액을 돌려받아요. 시뮬레이션에서는 포장재도 빼는데, 건당 800원은 출처 없는 가정이에요.",
                      "sources": ["delivery_baemin", "delivery_coupang"]})
        src["delivery_coupang"] = {"publisher": "쿠팡이츠", "title": "쿠팡이츠 상생 요금제 (중개 이용료·배달비 구간표)", "api": "쿠팡이츠 파트너스 공지",
                                   "url": "https://partners.coupangeats.com/news/notice/2480/", "period": "2025년 4월 1일 시행"}
        src["delivery_baemin"] = {"publisher": "우아한형제들 (배달의민족)", "title": "배민배달 상생 요금제 (배달비)", "api": "배민 사장님광장 안내",
                                  "url": "https://ceo.baemin.com/guide/13419", "period": "2025년 2월 26일 적용"}
        # 업종 필터(MEAT_TEXT)가 문장 단위로 걸러서, 고깃집과 카페 문장을 나눠 둔다
        facts.append({"id": "delivery_share_bbq", "tags": ["배달", "비중", "매장", "포장", "채널", "고깃집"],
                      "text": "고깃집(한식 육류) 매출 중 배달은 평균 5.2%이고, 배달앱을 쓰는 가게는 14.5%예요.",
                      "sources": ["delivery_research"]})
        facts.append({"id": "delivery_share_cafe", "tags": ["배달", "비중", "매장", "포장", "채널", "카페", "커피"],
                      "text": "커피전문점은 매출의 8.8%가 배달이고, 테이크아웃이 26.4%, 매장이 64.8%예요.",
                      "sources": ["delivery_research"]})
        src["delivery_research"] = {"publisher": "농림축산식품부·한국농촌경제연구원, 배달앱 상생안", "title": "외식업체 경영실태조사 판매 채널(표58), 배달앱 수수료 정리",
                                    "api": "외식업체 경영실태조사 2025 판매 채널 표 정리", "url": "", "period": "2024~2025년"}
    except (OSError, KeyError):
        pass

    gs = _load("gu_stats.json").get("apparel")  # pipelines/build_gu_stats.py (일반의류 CS300011)
    ak = _load("apparel_kosis.json")             # pipelines/build_apparel_data.py
    if gs:
        se = gs["seoul"]
        facts.append({"id": "apparel_seoul", "tags": ["옷가게", "의류", "서울", "매출", "가게 수", "폐업"],
                      "text": f"서울 상권 안 옷가게(일반의류)는 약 {se['stores']:,}곳이고, 한 곳당 한 달 매출은 약 {se['sales_per_store_month']:,}만원이에요 (카드 추정, 2025년). "
                              f"한 번에 평균 {se['ticket']:,}원을 결제하고, 1년에 {round(se['closure_rate'] * 100, 1)}%가 문을 닫아요.", "sources": ["seoul_apparel"]})
        for gu, v in gs["gu"].items():
            facts.append({"id": f"apparel_gu_{gu}", "gu": None, "tags": ["옷가게", "의류", gu, "매출", "가게 수", "폐업"],
                          "text": f"{gu} 옷가게(일반의류)는 상권 안에 약 {v['stores']:,}곳, 한 곳당 한 달 매출 약 {v['sales_per_store_month']:,}만원(서울 평균의 {v['demand_index']}배), "
                                  f"1년 폐업률 {round(v['closure_rate'] * 100, 1)}%예요 (2025년).", "sources": ["seoul_apparel"]})
        src["seoul_apparel"] = {"publisher": "서울특별시", "title": "서울시 상권분석서비스 추정매출·점포 (일반의류 CS300011)", "api": "OA-15572, OA-15577",
                                "url": "https://data.seoul.go.kr/", "period": "2025년"}
    if ak.get("bands"):
        b = next((x for x in ak["bands"] if x["band"].startswith("100~500")), None)
        if b:
            facts.append({"id": "apparel_cost", "tags": ["옷가게", "의류", "원가", "원가율", "비용", "이익률", "마진"],
                          "text": f"서울 의복 소매업 중 연매출 1억~5억 가게는 매출의 {round(b['cogs_ratio'] * 100, 1)}%가 옷을 사 온 원가, {round(b['labor_ratio'] * 100, 1)}%가 인건비, "
                                  f"{round(b['rent_ratio'] * 100, 1)}%가 임차료, {round(b['other_ratio'] * 100, 1)}%가 기타경비이고 영업이익은 {round(b['op_ratio'] * 100, 1)}%예요 (2024년).",
                          "sources": ["kosis_apparel"]})
        sv = ak.get("survival_seoul_retail_2023") or {}
        if sv:
            facts.append({"id": "apparel_survival", "tags": ["옷가게", "의류", "도소매", "생존율", "폐업", "생존"],
                          "text": f"서울에서 새로 연 도소매업 가게는 1년 뒤 {sv.get('1년 생존율')}%, 3년 뒤 {sv.get('3년 생존율')}%, 5년 뒤 {sv.get('5년 생존율')}%가 살아남아요 (2023년 기준). 음식점보다 낮아요.",
                          "sources": ["kosis_apparel"]})
        src["kosis_apparel"] = {"publisher": "통계청", "title": "도소매업조사 (서울 의복 소매업 4741), 기업생멸행정통계 (서울 도소매업)", "api": "KOSIS DT_3KB9003, DT_6BD1109",
                                "url": "https://kosis.kr", "period": "2024년 / 2023년"}

    ks = _load("kstartup.json")  # pipelines/fetch_kstartup.py
    if ks.get("items"):
        import time
        today = time.strftime("%Y%m%d")
        for x in (x for x in ks["items"] if x["end"] >= today):
            where = x["gu"] or ("서울" if x["seoul"] else "전국")
            facts.append({"id": f"kstartup_{x['id']}", "gu": x["gu"], "end": x["end"],
                          "tags": [where, x["kind"], "지원사업", "공고", "창업", "예비창업자", *(["소상공인", "외식"] if x["food"] else [])],
                          "text": f"{x['name']}: {x['org']}, {x['kind']}, {where} 대상, {int(x['end'][4:6])}월 {int(x['end'][6:])}일 마감이에요."
                                  + (f" 신청: {x['url']}" if x.get("url") else ""),
                          "sources": ["kstartup"]})
        src["kstartup"] = {"publisher": "창업진흥원", "title": "K-Startup 사업공고 (예비창업자 대상, 접수 중)", "api": "data.go.kr 15125364",
                           "url": "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do", "period": ks["_meta"]["fetched_at"][:10]}
    return facts, src


def dong_names() -> set[str]:
    return {f["tags"][0] for f in _load("facts_changeup.json")["facts"] if f["id"].startswith("dong_") and f["id"] != "dong_type_rule"}


# ---------------------------------------------------------------- 동네 사람 (dong_flow.json, pipelines/build_dong_flow.py)
FLOW_DAYS = 91   # 길단위인구는 분기 값이라 하루 값은 ÷91로 어림한다 (화면 area.ts 와 같다)
FLOW_SRC = "seoul_flow"


def _people(n: float) -> str:
    n = round(n)
    return f"{round(n / 1000) / 10:g}만 명" if n >= 10000 else f"{n:,}명"


def _flow_facts(key: str, name: str, row: dict, meta: dict) -> list[dict]:
    """한 동(또는 구)의 사람 근거 문장. 지나가는 사람 / 사는 사람 / 일하러 오는 사람을 따로 만들어 질문이 맞는 것만 골라지게 한다."""
    out: list[dict] = []
    f = row.get("flow") or row
    ages, bands, dows = meta["age"], meta["band"], meta["dow"]
    top = lambda v, labels: labels[max(range(len(v)), key=v.__getitem__)]
    if f.get("tot"):
        t = f"{name}의 유동인구는 하루 약 {_people(f['tot'] / FLOW_DAYS)}이에요(서울시 길단위인구 {meta['quarter'][:4]}년 {meta['quarter'][4]}분기로 어림한 추정이고, 같은 사람이 여러 번 세어질 수 있어요)."
        if f.get("male") is not None:
            t += f" 남성 {round(f['male'] * 100)}%, 여성 {round((1 - f['male']) * 100)}%예요."
        if f.get("age"):
            t += f" 가장 많은 연령대는 {yeyo(top(f['age'], ages))}."
        if f.get("band"):
            t += f" 가장 붐비는 시간대는 {top(f['band'], bands)}시, 요일은 {top(f['dow'], dows)}요일이에요." if f.get("dow") else f" 가장 붐비는 시간대는 {top(f['band'], bands)}시예요."
        out.append({"id": f"flow_{key}", "tags": [name, "유동인구", "유동", "지나가는", "지나가는 사람", "인구", "길단위", "성별", "연령", "시간대", "요일", "하루"],
                    "text": t, "sources": [FLOW_SRC]})
    for kind, label, tags in (("resi", "거주민", ["상주인구", "거주민", "사는", "주민", "거주"]), ("work", "직장인", ["직장인구", "직장인", "일하는", "일하러", "출근"])):
        b = row.get(kind)
        if b and b.get("tot"):
            t = f"{name}의 {label}(" + ("상주인구" if kind == "resi" else "직장인구") + f")은 약 {_people(b['tot'])}이에요."
            if b.get("male") is not None:
                t += f" 남성 {round(b['male'] * 100)}%, 여성 {round((1 - b['male']) * 100)}%예요."
            if b.get("age"):
                t += f" 가장 많은 연령대는 {yeyo(top(b['age'], ages))}."
            out.append({"id": f"flow_{kind}_{key}", "tags": [name, "인구", *tags], "text": t, "sources": [FLOW_SRC]})
    return out


def flow_named(q: str, ctx: dict | None) -> list[dict]:
    """질문에 이름이 나온 동·구의 사람 근거. 같은 이름의 동이 여럿이면 화면에서 고른 동을 먼저 둔다."""
    d = _load("dong_flow.json")
    if not d.get("dong"):
        return []
    meta, out = d["_meta"], []
    code = (ctx or {}).get("dong_code")
    for c, row in d["dong"].items():
        nm = row["name"]
        if nm in q or (re.sub(r"[0-9·.]+", "", nm) in q and re.search(r"[가-힣]{2,}동", nm) and len(re.sub(r"[0-9·.]+", "", nm)) >= 3):
            if c == code or not code or d["dong"].get(code, {}).get("name") != nm:
                out += _flow_facts(c, nm, row, meta)
    for g, row in d.get("gu", {}).items():
        if g in q:
            out += _flow_facts(f"gu_{g}", g, {"flow": row}, meta)
    return out


def flow_here(ctx: dict | None) -> list[dict]:
    """화면의 동네(ctx.dong_code, 없으면 구)의 사람. '이 동네 직장인구는?' 같은 질문용."""
    if not ctx:
        return []
    d = _load("dong_flow.json")
    if not d.get("dong"):
        return []
    code, gu = ctx.get("dong_code"), ctx.get("gu")
    if code and code in d["dong"]:
        facts = _flow_facts(code, d["dong"][code]["name"], d["dong"][code], d["_meta"])
    elif gu and gu in d.get("gu", {}):
        facts = _flow_facts(f"gu_{gu}", gu, {"flow": d["gu"][gu]}, d["_meta"])
    else:
        return []
    return [{**f, "id": "live_" + f["id"], "tags": [*f["tags"], "이 동네", "동네", "내가게"]} for f in facts]


# ---------------------------------------------------------------- 화면이 보낸 값으로 만드는 문장
def man(v: float) -> str:
    """만원 단위 숫자 -> '7,383만원', 1억 이상은 '1억 2,000만원' (화면의 man()과 같다)."""
    v = round(v)
    sign = "−" if v < 0 else ""
    v = abs(v)
    if v >= 10000:
        eok, rest = divmod(v, 10000)
        return f"{sign}{eok}억" + (f" {rest:,}만원" if rest else "원")
    return f"{sign}{v:,}만원"


def won(v: float) -> str:
    return man(v / 1e4)


def signed(v: float) -> str:
    s = won(v)
    return s if v < 0 else f"+{s}"


def live_facts(ctx: dict | None) -> list[dict]:
    if not ctx:
        return []
    out: list[dict] = []

    def add(fid: str, tags: list[str], text: str) -> None:
        out.append({"id": f"live_{fid}", "tags": ["내가게", "내", "가게", *tags], "text": text, "sources": ["app"]})

    where = f"{ctx.get('gu', '')}{' ' + ctx['dong'] if ctx.get('dong') else ''}".strip()
    p = ctx.get("pyeong")
    if p:
        add("shop", ["점포", "직원", "알바", "인원", "평수", "테이블", "좌석", "규모", "몇 명", "몇 평"],
            f"지금 입력한 가게는 {where}에 {p}평, 테이블 {ctx.get('tables', '?')}개({ctx.get('seats', '?')}석), 직원 {ctx.get('staff', '?')}명이에요."
            + (f" 동네 유형은 {ctx['area_type']}이에요." if ctx.get("area_type") else ""))
    if ctx.get("area_type"):
        add("type", ["유형", "동네 유형", "동네", "이 동네", "특성", "성격"],
            f"{where or '이 동네'}의 유형은 {yeyo(ctx['area_type'])}.")
    if ctx.get("pork_area") is not None or ctx.get("pork_gu") is not None:
        n = ctx.get("pork_area") if ctx.get("pork_area") is not None else ctx.get("pork_gu")
        st = f", 한식음식점 {ctx['stores_area']:,}곳" if ctx.get("stores_area") else ""
        add("area", ["경쟁", "점포", "고깃집", "돼지고기", "동네", "몇 곳", "이 동네", "가게 수"],
            f"{where or ctx.get('gu', '')}에는 돼지고기 구이·찜 가게가 {n:,}곳{st} 있어요." + (f" 서울 25개 구 중 {ctx['pork_rank']}번째로 많은 구예요." if ctx.get("pork_rank") else ""))
    if ctx.get("rent") is not None and p:
        add("rent", ["월세", "임대", "평당", "임대료"],
            f"월세는 평당 약 {ctx['rent']}만원({ctx.get('rent_src', '입력')})으로 잡았어요. {p}평이면 한 달 약 {man(ctx['rent'] * p)}이에요.")
    total = ctx.get("opening_total")
    if total is not None:
        lines = sorted(ctx.get("lines") or [], key=lambda x: -x.get("amount", 0))[:3]
        top = ", ".join(f"{x['label']} {man(x['amount'])}" for x in lines)
        add("opening", ["여는", "비용", "창업", "투자", "개업", "드는", "돈", "인테리어", "설비", "얼마"],
            f"여는 데 드는 돈은 {man(total)}이에요." + (f" 가장 큰 항목은 {top}이에요." if top else ""))
    if ctx.get("deposit") is not None:
        add("deposit", ["보증금", "월세", "임대", "돌려"],
            f"보증금은 {man(ctx['deposit'])}이고 가게를 닫을 때 돌려받는 돈이에요.")
    if ctx.get("cash_left") is not None:
        loan = f" + 대출 {man(ctx['loan'])}" if ctx.get("loan") else ""
        add("cash", ["현금", "잔고", "남", "자금", "가진", "운영자금", "통장"],
            f"가진 돈 {man(ctx.get('capital', 0))}{loan}에서 여는 데 {man(total or 0)}을 쓰고 {man(ctx['cash_left'])}이 남아요.")
        sme = (_load("ecos_rates.json").get("latest") or {}).get("loan_sme")
        rate = f"은행 중소기업대출 평균 연 {sme['rate']}%" if sme else "연 6%"
        add("loan", ["대출", "이자", "빚"],
            f"대출은 {man(ctx['loan'])}이고 이자만 매달 낸다고 가정했어요({rate}, 한 달 약 {man(ctx['loan'] * (sme['rate'] if sme else 6) / 100 / 12)})."
            if ctx.get("loan") else "대출은 받지 않았어요.")

    eng = ctx.get("engine")
    if not eng or not eng.get("months"):
        add("sim_none", ["본전", "회수", "되찾", "몇 달", "개월", "흑자", "남기", "시작", "시뮬레이션", "영업이익", "투자금", "하루", "몇 명"],
            "아직 시뮬레이션을 돌리지 않았어요. 시뮬레이션 탭에서 6개월을 돌리면 몇 달째부터 남는지, 투자금을 언제 되찾는지 알려 드릴 수 있어요.")
        return out
    for m in eng["months"]:
        add(f"month_{m['month']}", [f"{m['month']}월", "영업이익", "매출", "손님", "시뮬레이션", "결과", "이번 달", "지난달"],
            f"시뮬레이션 {m['month']}월은 매출 {won(m['revenue'])}, 영업이익 {signed(m['op'])}이었어요. 손님은 {round(m['covers']):,}명이에요.")
    n = len(eng["months"])
    if eng.get("finished"):
        pb = eng.get("payback") or {}
        spent = eng.get("spent")
        tags = ["본전", "회수", "되찾", "몇 달", "개월", "흑자", "남기", "시작", "투자금", "시뮬레이션"]
        if pb.get("month"):
            add("payback", tags, f"쓴 돈 {won(spent)}은 {pb['month']}개월째에 되찾아요"
                + (" (6개월 뒤는 마지막 석 달 평균으로 이어 붙인 추정이에요)." if pb.get("estimated") else "."))
        else:
            add("payback", tags, f"쓴 돈 {won(spent or 0)}은 이 속도로는 되찾지 못해요" + (f" ({pb['reason']})." if pb.get("reason") else "."))
        add("end", ["현금", "6개월", "뒤", "잔고", "최저", "시뮬레이션", "남아"],
            f"{n}개월 뒤 현금은 {won(eng.get('end_cash', 0))}이고, 가장 낮았던 때는 {won(eng.get('lowest_cash', 0))}이에요."
            + (" 가게를 닫게 됐어요." if eng.get("closed") else ""))
    else:
        add("progress", ["본전", "회수", "되찾", "몇 달", "개월", "흑자", "남기", "시작", "투자금", "현금", "잔고", "시뮬레이션"],
            f"시뮬레이션은 {n}개월째까지 진행했고 지금 현금은 {won(eng.get('cash_now', 0))}이에요. 6개월을 끝까지 돌리면 투자금을 언제 되찾는지 알려 드릴 수 있어요.")
    last = next((m for m in reversed(eng["months"]) if m.get("covers")), None)
    if last:
        contrib = (last["revenue"] - last["cogs"] - last["fees"]) / last["covers"]
        fixed = last["labor"] + last["rent"] + last["mgmt"]
        if contrib > 0:
            per_month = fixed / contrib
            days = last.get("open_days") or 26
            add("breakeven", ["본전", "하루", "몇 명", "손님", "손익분기", "받아야", "시뮬레이션"],
                f"{last['month']}월 비용 기준으로 영업이익이 0이 되려면 한 달 약 {round(per_month):,}명, 하루 약 {round(per_month / days):,}명이 와야 해요 "
                f"(사장 가상 급여 300만원 포함). 그달에는 하루 평균 {round(last['covers'] / days):,}명이 왔어요.")
    return out


# ---------------------------------------------------------------- 주제 판별과 선택
def match_dongs(q: str, dongs: set[str]) -> set[str]:
    """질문에 나온 동 이름. 정확히 같거나, '망원동'처럼 어간이 같은 동(망원1동, 망원2동)."""
    found = {d for d in dongs if d in q}
    for tok in re.findall(r"([가-힣]{2,5})동(?![가-힣])", q):
        found |= {d for d in dongs if d.startswith(tok) and d.endswith("동")} if len(tok) >= 2 else set()
    return found


def topics(q: str, dongs: set[str]) -> set[str]:
    t = {name for name, rx in TOPIC_RE if rx.search(q)}
    if match_dongs(q, dongs):
        t.add("neighborhood")
    return t


def allowed_ids(fid: str, tps: set[str], q: str) -> bool:
    if not tps:
        return True
    pre: list[str] = []
    for t in tps:
        pre += FAMILIES[t]
    if fid.startswith(tuple(pre)):
        if PORK_PRICE.match(fid) and "meat_price" not in tps:
            return False   # pork_retail_*, pork_wholesale_* 는 가격 주제에서만 (고깃집 점포 수 질문에 끼지 않게)
        return True
    return False


GENERIC = ("동네", "가게", "점포", "우리", "내가", "제가", "내가게", "이번", "지금", "현재", "여기", "알려", "얼마", "어때", "어떤", "어떻", "어디", "무엇", "뭐",
           "많이", "제일", "가장", "얼마나", "있어", "있나", "인가", "이에", "예요", "해줘", "좀", "그리고", "그럼", "그러면", "하면", "되나", "될까", "시작",
           "남기", "남아", "남나", "달째", "개월", "부터", "몇", "정도", "대비", "기준", "비교", "해서", "하는", "하고", "한테", "에서", "으로", "에게", "때문", "경우", "이후", "이전")


def specific_words(q: str, near: set[str]) -> list[str]:
    """질문에서 '이 동네' 같은 흔한 말과 동 이름을 빼고 남은 핵심 낱말(조사 뗀 앞 2글자 이상)."""
    out = []
    for t in re.findall(r"[0-9A-Za-z가-힣]+", q):
        if len(t) < 2 or t.startswith(GENERIC) or any(t.startswith(d[:2]) and d in q for d in near):
            continue
        if re.search(r"\d", t) or re.fullmatch(r"[가-힣]{1,3}구", t) or re.fullmatch(r"[가-힣]{2,5}동", t):
            continue
        out.append(t)
    return out


def covers(f: dict, keys: list[str]) -> bool:
    """근거의 문장·태그에 핵심 낱말(또는 앞 2글자)이 하나라도 있는가."""
    hay = f["text"] + " " + " ".join(f.get("tags", []))
    return any(k in hay or k[:2] in hay for k in keys)


def run(q: str, ctx: dict | None = None, k: int = 3) -> dict:
    from api import cite_api as C   # 늦게 불러서 순환 import를 피한다

    if OFFTOPIC.search(q) and not OWN.search(q):
        return {"answer": None, "facts": [], "citations": [], "message": OFF_MESSAGE}
    stat, sources = static_facts()
    live = live_facts(ctx)
    sources = {**sources, **({"app": _load("facts_changeup.json")["sources"].get("app")} if live else {})}
    dongs = dong_names()
    tps = topics(q, dongs)
    # 업종 말 없이 '이 동네 경쟁·매출'을 물으면 화면의 업종(치킨·분식·옷가게·카페)을 주제에 더해 그 업종의 구 근거를 쓴다
    _ci = (ctx or {}).get("industry")
    if _ci in ("chicken", "bunsik", "apparel", "cafe") and not tps & {"chicken", "bunsik", "apparel", "cafe"} and not MEAT_Q.search(q)             and tps & {"competition", "sales", "neighborhood", "myshop"}:
        tps.add(_ci)
    ind_added = _ci in tps and not re.search(r"치킨|분식|떡볶이|옷가게|의류|카페|커피", q)
    near = match_dongs(q, dongs)
    named_dong = bool(near)
    if near:
        tps.add("neighborhood")
        q = q + " " + " ".join(sorted(near)[:6])   # 어간으로 찾은 동 이름을 질문에 보태 같은 이름의 문장을 찾게 한다
    if SNOW.search(q):
        return {"answer": None, "facts": [], "citations": [], "message": "눈이 오는 날에 대한 자료는 없어요. 비가 온 시간의 비율은 있으니 날씨 질문으로 물어봐 주세요."}

    if not re.search(r"\d", q):
        for pat, ask_back in C.CLARIFY:
            if pat.search(q) and "cost" not in tps and not re.search(r"요즘|최근|지금|현재|시세|올랐|내렸|오를|얼마예요|얼마에요", q):
                return {"answer": None, "facts": [], "citations": [], "message": ask_back}

    pool = stat + live
    if "flow" in tps:
        pool = pool + flow_named(q, ctx) + flow_here(ctx)
    if not named_dong and "neighborhood" not in tps:
        pool = [f for f in pool if not f["id"].startswith(("dong_", "rent_dong_"))]
    pool = [f for f in pool if allowed_ids(f["id"], tps, q) or f["id"].startswith("live_") and "myshop" in tps]
    # 지원사업 공고: 다른 구 공고는 그 구 주민만 받는 경우가 많아 뺀다. 물은 구(없으면 화면에서 고른 구) 공고는 위로 올린다.
    want_gu = (GU.search(q).group() if GU.search(q) else None) or (ctx or {}).get("gu")
    if "support" in tps:
        pool = [f for f in pool if not f["id"].startswith("kstartup_") or f.get("gu") in (None, want_gu)]
        k = max(k, 5)
    # 업종별 문장(SNS·배달분석·동네): 질문에 다른 업종 말이 없으면 지금 화면의 업종 것만, 구별 배달 문장은 물은(고른) 구 것만
    named_inds = {t for t in tps if t in ("apparel", "chicken", "bunsik", "cafe")} | ({"bbq"} if MEAT_Q.search(q) else set())
    cur_ind = (ctx or {}).get("industry")
    keep_inds = named_inds or ({cur_ind} if cur_ind else set())
    def _ind_ok(fid: str) -> bool:
        m = re.match(r"^(?:sns|sbizdlvy_seoul|sbizdlvy_trend|sbizdlvy|qfdong)_(chicken|bunsik|cafe|bbq|apparel)(?:_(.+))?$", fid)
        if not m:
            return True
        if keep_inds and m.group(1) not in keep_inds:
            return False
        gu_part = m.group(2)
        return not (gu_part and want_gu and fid.startswith(("sbizdlvy_", "qfdong_")) and gu_part != want_gu)
    pool = [f for f in pool if _ind_ok(f["id"])]
    if "apparel" in tps:
        # 옷가게를 물으면 옷가게 근거만. 구를 말했으면(또는 화면에서 고른 구가 있으면) 그 구 값, 아니면 서울 값과 비용·생존율만
        g = GU.search(q).group() if GU.search(q) else (ctx or {}).get("gu") if (ctx or {}).get("industry") == "apparel" else None
        pool = [f for f in pool if (f["id"].startswith(("apparel_", "sns_apparel")) or (ind_added and f["id"].startswith("live_"))) and (not f["id"].startswith("apparel_gu_") or (g and f["id"] == f"apparel_gu_{g}"))]
    # '30대 생존율', '20대 대출'처럼 나이대가 나와도 생존율·대출·지원사업·배달을 묻는 질문은 인구 질문이 아니다
    if "flow" in tps and not re.search(r"생존|폐업", q) and not tps & {"loan", "support", "delivery"}:
        # 사람 수 질문은 사람 근거만 쓴다. 이름이 나온 동이 없고 화면의 동네도 모르면 다른 주제의 문장으로 대신하지 않는다.
        pool = [f for f in pool if f["id"].startswith(("flow_", "live_flow_"))]
        if not pool:
            return {"answer": None, "facts": [], "citations": [], "message": "어느 동네의 인구인지 알려 주세요. 예: \"망원동 직장인구는?\" 또는 동네 분석에서 동네를 고른 뒤 \"이 동네 직장인구는?\" 이라고 물어 주세요."}
        if OWN.search(q):
            here = [f for f in pool if f["id"].startswith("live_")]
            pool = here or pool
    cafe_q, meat_q = bool(CAFE_Q.search(q)), bool(MEAT_Q.search(q))
    # 질문에 업종 말이 없으면 지금 화면의 업종(ctx.industry)으로 거른다: 옷가게·치킨·분식에서 고깃집·카페 문장이 섞이지 않게
    ind = (ctx or {}).get("industry")
    if not cafe_q and not meat_q and ind:
        cafe_q, meat_q = ind == "cafe", ind == "bbq"
        if ind in ("apparel", "chicken", "bunsik"):
            pool = [f for f in pool if not MEAT_ID.match(f["id"]) and not MEAT_TEXT.search(f["text"]) and not CAFE_ID.match(f["id"])]
            if ind == "apparel":
                pool = [f for f in pool if not re.match(r"^(chicken|bunsik|food_|delivery_|costidx_)", f["id"])]
            else:
                other = "bunsik" if ind == "chicken" else "chicken"
                pool = [f for f in pool if not f["id"].startswith(("fashion_", "apparel_", f"{other}_"))]
    if cafe_q and not meat_q:
        pool = [f for f in pool if not MEAT_ID.match(f["id"]) and not MEAT_TEXT.search(f["text"])]
    elif meat_q and not cafe_q:
        pool = [f for f in pool if not CAFE_ID.match(f["id"])]

    # 품목 가격 질문: 물은 품목이 문장에 들어간 근거만 남긴다. 없으면 다른 품목으로 대신하지 않고 없다고 말한다.
    asked = [(name, rx) for name, rx in ITEMS if rx.search(q)]
    price_q = bool(asked) and PRICE_Q.search(q) and not tps & {"sales", "rent", "competition", "neighborhood", "myshop"}
    if price_q:
        pool = [f for f in pool if any(rx.search(f["text"]) for _, rx in asked)]
        if not pool:
            names = "·".join(n for n, _ in asked)
            return {"answer": None, "facts": [], "citations": [],
                    "message": f"현재 보유한 데이터에서는 {names} 가격을 확인할 수 없어요.\n{HAVE_PRICES}"}

    if not pool:
        return {"answer": None, "facts": [], "citations": [], "message": NONE_MESSAGE}
    if not GU.search(q) and not named_dong and not (OWN.search(q) and want_gu) and tps & {"sales", "competition"} and "rent" not in tps:
        seoul = [f for f in pool if not PER_GU.match(f["id"])]
        pool = seoul or pool
    if OWN.search(q) and live and not tps & {"delivery", "sns"} and not (ind_added and tps & {"competition", "sales"}):   # '이 동네 배달·SNS'는 화면 값(live_)에 없어 업종·구 문장으로 답한다
        own = [f for f in pool if f["id"].startswith("live_")]
        pool = own or pool
    # 은행끼리 비교하는 질문(어느 은행, 제일 낮은 등)은 은행 순위 문장으로. 은행 이름을 말했으면 그 은행 문장
    if "loan" in tps and re.search(r"어느 ?은행|은행별|은행 ?중|낮은|싼|비교|제일|가장|높은|순위", q):
        named_bank = [f for f in pool if f["id"].startswith("bank_") and f["id"] != "bank_guarantee_rank" and f["id"][5:].split("(")[0][:2] in q]
        rank = [f for f in pool if f["id"] == "bank_guarantee_rank"]
        pool = named_bank or rank or pool

    if "neighborhood" in tps and RULEQ.search(q) and not named_dong:
        rule = [f for f in stat if f["id"] == "dong_type_rule"]
        pool = rule or pool

    # 생존율 질문: 생존율 근거는 업종을 나누지 않은 값이라 업종 말('고깃집')이 문장에 없어도 그 근거로 답한다
    surv_q = bool(re.search(r"생존|살아남", q))
    if surv_q:
        surv = [f for f in pool if f["id"].startswith("survival_")]
        if not re.search(r"[1-6]0대|나이", q):   # 나이를 묻지 않았으면 업종 생존율 문장을 쓴다
            surv = [f for f in surv if "나이대" not in f["text"]] or surv
        pool = surv or pool
    # 구 이름을 말한 경쟁·매출 질문은 그 구 문장을 먼저 (서울 1·꼴찌 구 문장이 끼지 않게)
    gu_hit = False
    gq = GU.search(q)
    g_name = gq.group() if gq else (want_gu if OWN.search(q) else None)   # '이 동네·우리 구'는 화면에서 고른 구
    if g_name and tps & {"competition", "sales"} and not surv_q:
        if "delivery" not in tps:   # 경쟁·매출 질문에 배달 문장이 끼지 않게
            pool = [f for f in pool if not f["id"].startswith("sbizdlvy_")] or pool
        own_gu = [f for f in pool if f["id"].endswith("_" + g_name) or f.get("gu") == g_name]
        gu_hit = bool(own_gu)
        pool = own_gu or pool
    ranked = C._rank_facts(q, pool)
    # 화면이 보낸 값은 지금 사용자가 보고 있는 가게의 값이라 같은 점수면 먼저 보여 준다
    ranked = sorted(((s * (1.25 if f["id"].startswith("live_") or (want_gu and f.get("gu") == want_gu) else 1.0), f) for s, f in ranked),
                    key=lambda x: -x[0])
    top = ranked[0][0] if ranked else 0.0
    # 주제가 명확히 인식된 경우 임계값을 더 높게 (엉뚱한 답을 피하기 위해)
    threshold = 0.0 if price_q or surv_q or (gu_hit and ind_added) else 0.25 if tps else 0.20   # 품목 가격·생존율 질문은 이미 근거를 골라 뒀다
    if top < threshold:
        # 범위 밖 질문이면 명확하게 답변
        if OFFTOPIC.search(q):
            return {"answer": None, "facts": [], "citations": [], "message": OFF_MESSAGE}
        return {"answer": None, "facts": [], "citations": [], "message": NONE_MESSAGE}
    # 질문의 핵심 낱말(직장인구, 유형 등)이 고른 근거 어디에도 없으면, '이 동네' 같은 말만 겹친 것이라 답하지 않는다.
    keys = [w for w in specific_words(q, near) if not w.startswith(("고깃집", "치킨집", "분식집", "카페", "옷가게"))] if surv_q else specific_words(q, near)
    if ind_added and tps & {"competition", "sales"}:   # 화면 업종으로 답하는 '이 동네 경쟁·매출'은 '경쟁' 같은 말이 문장에 없어도 된다
        keys = [w for w in keys if not w.startswith(("경쟁", "매출"))]
    if keys and not any(covers(f, keys) for _, f in ranked[:k]) and not surv_q:
        return {"answer": None, "facts": [], "citations": [], "message": NONE_MESSAGE}
    hits, seen = [], set()
    for sim, f in ranked:
        if sim < max(threshold, 0.7 * top) or f["text"] in seen:
            continue
        seen.add(f["text"])
        hits.append((sim, f))
        if len(hits) == k:
            break
    facts_out, used = [], []
    for sim, f in hits:
        for sid in f["sources"]:
            if sid not in used:
                used.append(sid)
        facts_out.append({"text": f["text"], "source_ids": f["sources"], "similarity": round(sim, 3)})
    cites = []
    for sid in used:
        s = sources.get(sid)
        if not s:
            continue
        cites.append({"id": sid, "title": s["title"], "publisher": s["publisher"], "year": s["period"],
                      "type": "화면 계산" if sid == "app" else "공공 API", "url": s["url"], "note": f"호출 식별자: {s['api']}"})
    if price_q and not all(any(rx.search(f["text"]) for _, rx in asked) for f in facts_out):
        return {"answer": None, "facts": [], "citations": [],
                "message": f"현재 보유한 데이터에서는 {'·'.join(n for n, _ in asked)} 가격을 확인할 수 없어요.\n{HAVE_PRICES}"}
    answer = facts_out[0]["text"] if len(facts_out) == 1 else "\n".join(f"• {f['text']}" for f in facts_out)
    if price_q and not any(PRICE_WORD.search(f["text"]) for f in facts_out):
        answer = f"{'·'.join(n for n, _ in asked)}의 단위 가격(1kg당 시세 같은) 자료는 없어요. 대신 가게들이 실제로 쓰는 양과 돈을 알려 드려요.\n" + answer
    if EFFECT.search(q) and tps and "myshop" not in tps:
        answer = "이 일이 손님 수나 매출에 얼마나 영향을 주는지 직접 잰 자료는 없어요. 대신 관련 자료를 보여 드려요.\n" + answer
    return {"answer": answer, "facts": facts_out, "citations": cites}


def install(app) -> None:
    """cite_api 의 GET /ask 를 이 모듈의 것으로 바꾸고, ctx 를 받는 POST /ask 를 추가한다."""
    from fastapi import Body, Query

    app.router.routes = [r for r in app.router.routes if not (getattr(r, "path", "") == "/ask")]

    @app.get("/ask")
    def ask_get(q: str = Query(..., min_length=1, max_length=300), k: int = Query(3, ge=1, le=6)):
        return run(q, None, k)

    @app.post("/ask")
    def ask_post(body: dict = Body(...)):
        q = str(body.get("q", ""))[:300]
        if not q.strip():
            return {"answer": None, "facts": [], "citations": [], "message": "질문을 적어 주세요."}
        ctx = body.get("ctx") if isinstance(body.get("ctx"), dict) else None
        return run(q, ctx, max(1, min(6, int(body.get("k", 3)))))
