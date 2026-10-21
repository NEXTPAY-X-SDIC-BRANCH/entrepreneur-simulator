"""새 업종 목록 (lab:industry). 파이프라인, 엔진, API, 챗봇이 모두 이 표 하나를 읽는다.

순위 근거: research/industries/README.md (서울 개업 수·점포 수, 경영실태조사 최근 개업 비중).
service: 서울시 상권분석서비스 서비스 업종 코드. sbiz: 소상공인 상가정보 소분류 코드.
krei: research/industries/krei.json 의 그룹 id (경영실태조사 2025 원자료 업종).
"""
from __future__ import annotations

INDUSTRIES: dict[str, dict] = {
    "hansik": {"name": "한식 백반집", "short": "백반집", "base": "한식음식점", "service": "CS100001",
               "sbiz": ["I20101", "I20102", "I20104", "I20199"], "sbiz_label": "백반/한정식, 국/탕/찌개, 전, 기타 한식",
               "krei_label": "한식 일반음식점업", "desc": "백반, 찌개, 국밥 같은 식사 위주 한식"},
    "pub": {"name": "호프·주점", "short": "주점", "base": "호프-간이주점", "service": "CS100009",
            "sbiz": ["I21103", "I21104"], "sbiz_label": "생맥주 전문, 요리 주점",
            "krei_label": "생맥주 전문점 + 기타 주점업", "desc": "생맥주, 요리 주점, 포차처럼 저녁에 여는 술집"},
    "bunsik": {"name": "분식집", "short": "분식집", "base": "분식전문점", "service": "CS100008",
               "sbiz": ["I21007"], "sbiz_label": "김밥/만두/분식",
               "krei_label": "김밥 및 기타 간이음식점업", "desc": "김밥, 떡볶이, 라면처럼 빠르게 먹는 메뉴"},
    "bakery": {"name": "베이커리", "short": "빵집", "base": "제과점", "service": "CS100005",
               "sbiz": ["I21001"], "sbiz_label": "빵/도넛",
               "krei_label": "제과", "desc": "빵, 케이크, 구움과자를 굽고 파는 가게, 포장 손님이 많아요"},
    "chicken": {"name": "치킨집", "short": "치킨집", "base": "치킨전문점", "service": "CS100007",
                "sbiz": ["I21006"], "sbiz_label": "치킨",
                "krei_label": "치킨 전문점", "desc": "배달 비중이 큰 튀김·구이 치킨"},
}
IDS = tuple(INDUSTRIES)


def info(ind: str) -> dict:
    if ind not in INDUSTRIES:
        raise KeyError(f"unknown industry {ind}")
    return INDUSTRIES[ind]
