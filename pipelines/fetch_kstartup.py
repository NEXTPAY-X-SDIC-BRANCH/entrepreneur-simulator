"""창업진흥원 K-Startup 사업공고(data.go.kr)에서 지금 모집 중이고 예비창업자가 신청할 수 있는 공고를 받는다.

    python -m pipelines.fetch_kstartup

키: KSTARTUP_API_KEY (data.go.kr 일반 인증키, Decoding). 키는 출력하지 않는다.
출력: web/public/mock/kstartup.json
거르는 기준: 모집 중(rcrt_prgs_yn=Y, 서버에서 거름), 대상 업력에 '예비창업자', 지역이 서울 또는 전국(지방 기관 공고는 뺌),
접수 마감이 오늘 이후, 지원 분야가 KINDS 안. 이름·대상·내용에 FOOD_WORDS가 있으면 food=True.
공고에 서울 구 이름이 나오면 gu에 적는다. 화면은 고른 구 공고 → 서울 공통 → 전국 순으로 보여 준다.
공고는 매일 바뀌므로 데모 전에 다시 돌린다.
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "kstartup.json"
URL = "https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01"
PER_PAGE = 100
# 행사·네트워크, 글로벌, 판로·해외진출, R&D, 인력은 동네 가게 예비 창업자와 멀어서 뺀다.
KINDS = {"사업화", "멘토링ㆍ컨설팅ㆍ교육", "창업교육", "융자ㆍ보증", "시설ㆍ공간ㆍ보육"}
FOOD_WORDS = re.compile("소상공인|자영업|외식|음식|요식|식당|카페|커피|식품|푸드|상권|골목|로컬")
# 지역이 '전국'이어도 지방 기관이 자기 지역 사람만 뽑는 공고가 섞여 있다. 이름이나 기관에 다른 시도·시가 보이면 뺀다 (완벽하지 않음).
OTHER_PLACES = re.compile("부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청|전북|전남|전라|경북|경남|경상|제주"
                          "|고양|수원|성남|용인|화성|안산|안양|부천|청주|천안|창원|포항|전주|김해|구미|아산")
# 서울 25개 구. 공고 이름·기관·대상에 나오면 그 구 공고로 본다. '중구'만 두 글자라 '구'까지 붙여 찾는다.
SEOUL_GU = ["강남구", "강동구", "강북구", "강서구", "관악구", "광진구", "구로구", "금천구", "노원구", "도봉구", "동대문구", "동작구", "마포구",
            "서대문구", "서초구", "성동구", "성북구", "송파구", "양천구", "영등포구", "용산구", "은평구", "종로구", "중구", "중랑구"]
GU_RE = re.compile("|".join(sorted((g if g == "중구" else g[:-1] for g in SEOUL_GU), key=len, reverse=True)))
GU_FULL = {g if g == "중구" else g[:-1]: g for g in SEOUL_GU}


def fetch_page(api_key: str, page: int) -> dict:
    q = urllib.parse.urlencode({"serviceKey": api_key, "page": page, "perPage": PER_PAGE, "returnType": "json",
                                "cond[rcrt_prgs_yn::EQ]": "Y"})
    try:
        with urllib.request.urlopen(f"{URL}?{q}", timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
        raise RuntimeError(mask(f"K-Startup page {page}: {e}")) from None


def keep(row: dict, today: str) -> bool:
    region = row.get("supt_regin") or ""
    who = html.unescape(f"{row.get('biz_pbanc_nm') or ''} {row.get('pbanc_ntrp_nm') or ''}")
    return (html.unescape(row.get("supt_biz_clsfc") or "") in KINDS
            and "예비창업자" in (row.get("biz_enyy") or "")
            and ("서울" in region or ("전국" in region and not OTHER_PLACES.search(who)))
            and (row.get("pbanc_rcpt_end_dt") or "") >= today)


def slim(row: dict) -> dict:
    t = lambda k: html.unescape(row.get(k) or "").strip()  # noqa: E731  (&amp; &apos; 같은 기호가 섞여 온다)
    url = row.get("detl_pg_url") or row.get("biz_aply_url") or row.get("aply_mthd_onli_rcpt_istc")
    return {
        "id": row["pbanc_sn"], "name": t("biz_pbanc_nm"), "org": t("pbanc_ntrp_nm"),
        "kind": t("supt_biz_clsfc"), "region": t("supt_regin"), "age": t("biz_trgt_age"),
        "start": row.get("pbanc_rcpt_bgng_dt"), "end": row.get("pbanc_rcpt_end_dt"), "url": url,
        "public": row.get("sprv_inst") != "민간",  # 공공기관 공고인지 (민간 주관은 False)
        "food": bool(FOOD_WORDS.search(" ".join(t(k) for k in ("biz_pbanc_nm", "aply_trgt_ctnt", "pbanc_ctnt")))),
        "seoul": "서울" in t("supt_regin"),  # False면 전국 단위 공고
        "gu": gu_of(" ".join(t(k) for k in ("biz_pbanc_nm", "pbanc_ntrp_nm", "aply_trgt_ctnt"))),
    }


def gu_of(text: str) -> str | None:
    m = GU_RE.search(text)
    return GU_FULL[m.group()] if m else None


def main() -> None:
    api_key = key("KSTARTUP_API_KEY", fallback=None)
    today = time.strftime("%Y%m%d")
    rows, page = [], 1
    while True:
        d = fetch_page(api_key, page)
        rows += d.get("data", [])
        if page * PER_PAGE >= d.get("matchCount", 0):
            break
        page += 1
        time.sleep(0.3)
    kept = sorted((slim(r) for r in rows if keep(r, today)), key=lambda x: (not x["food"], x["end"]))
    OUT.write_text(json.dumps({
        "_meta": {"source": "창업진흥원 K-Startup 사업공고 조회서비스 (data.go.kr)", "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "filter": "모집 중, 예비창업자 대상, 전국·서울, 마감 전, 사업화·교육·융자·공간 분야", "recruiting": len(rows), "kept": len(kept)},
        "items": kept,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    kinds: dict[str, int] = {}
    for x in kept:
        kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
    print(f"모집 중 {len(rows)}건 중 {len(kept)}건 저장 (업종 관련 {sum(x['food'] for x in kept)}건):", kinds)


if __name__ == "__main__":
    main()
