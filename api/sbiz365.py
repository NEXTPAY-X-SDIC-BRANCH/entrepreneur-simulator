"""소상공인365 오픈API 연결 (/sbiz365). 소상공인365 오픈API는 인증키(certKey)를 붙인 분석 화면을 우리 서비스 안에 넣어 쓰는 방식이다.

키는 저장소 루트 .env의 SBIZ365_*_KEY에만 있다 (pipelines/keys.py). 화면은 이 서버의 /sbiz365/{이름} 을 iframe으로 열고,
서버가 키를 붙인 소상공인365 주소로 넘겨 준다. 그래서 키가 웹 코드나 GitHub에 들어가지 않는다.
각 키가 여는 화면 경로는 소상공인365의 키 확인 API(/pub/api/apics/checkApiCertVl)가 돌려준 값이다 (2026-10-22 확인).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from pipelines.keys import sbiz365_keys

router = APIRouter(prefix="/sbiz365", tags=["sbiz365"])

BASE = "https://bigdata.sbiz.or.kr"
# 이름 -> (.env 키 이름, 화면 경로, 한국어 이름, 우리 프로그램에서 쓰는 곳)
APIS: dict[str, tuple[str, str, str, str]] = {
    "simple": ("SBIZ365_SIMPLE_KEY", "simple", "간단분석", "동네 분석 > 소상공인365"),
    "detail": ("SBIZ365_DETAIL_KEY", "detail", "상세분석", "동네 분석 > 소상공인365"),
    "competition": ("SBIZ365_COMPETITION_KEY", "cmpetAnls", "경쟁분석", "동네 분석 > 소상공인365"),
    "location": ("SBIZ365_LOCATION_KEY", "locAnls", "입지분석", "동네 분석 > 소상공인365"),
    "industry": ("SBIZ365_INDUSTRY_KEY", "tpbizAnls", "업종분석", "동네 분석 > 소상공인365"),
    "delivery": ("SBIZ365_DELIVERY_KEY", "delivery", "배달분석", "동네 분석 > 소상공인365, 시뮬레이터 배달 배수(sbiz_delivery.json)"),
    "map": ("SBIZ365_MAP_KEY", "startupPublic", "상권지도", "동네 분석 > 소상공인365"),
    "theme": ("SBIZ365_THEME_KEY", "hpReport", "테마상권 분석", "동네 분석 > 소상공인365"),
    "festival": ("SBIZ365_FESTIVAL_KEY", "tour", "관광 축제 정보", "동네 분석 > 소상공인365"),
    "sns": ("SBIZ365_SNS_KEY", "snsAnaly", "SNS 분석", "동네 분석 > 소상공인365"),
    "main_stats": ("SBIZ365_MAIN_STATS_KEY", "dashboardSttus", "주요통계", "동네 분석 > 소상공인365"),
    "sales": ("SBIZ365_SALES_KEY", "dashboardSelng", "매출통계", "동네 분석 > 소상공인365"),
    "store_stats": ("SBIZ365_STORE_STATS_KEY", "dashboardStore", "업소통계", "동네 분석 > 소상공인365"),
    "population": ("SBIZ365_POPULATION_KEY", "dashboardStats", "인구통계", "동네 분석 > 소상공인365"),
}


@router.get("")
def list_apis() -> list[dict]:
    """화면에 보여 줄 목록. 키가 .env에 있는지만 알려 주고 키 값은 내보내지 않는다."""
    have = sbiz365_keys()
    return [{"id": k, "name_ko": v[2], "used_in": v[3], "ready": v[0] in have} for k, v in APIS.items()]


@router.get("/{name}")
def open_api(name: str):
    if name not in APIS:
        raise HTTPException(404, "모르는 소상공인365 API예요")
    env, path, _, _ = APIS[name]
    key = sbiz365_keys().get(env)
    if not key:
        raise HTTPException(503, f"{env}가 .env에 없어요")
    return RedirectResponse(f"{BASE}/#/openApi/{path}?certKey={key}", status_code=302)
