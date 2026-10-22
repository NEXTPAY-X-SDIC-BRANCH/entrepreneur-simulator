"""공정위 가맹정보로 업종별 가맹점 인테리어 비용(평당)을 모은다 -> web/public/mock/ftc_interior.json

    python -m pipelines.fetch_ftc_interior [--year 2024]

키: FTC_FRANCHISE_INTERIOR_KEY (인테리어 비용), FTC_BRAND_LIST_KEY (브랜드 목록, 없으면 같은 키). 키는 출력하지 않는다.
API (공공데이터포털, 공정거래위원회 1130000)
  브랜드 목록   15125467 FftcBrandRlsInfo2_Service/getBrandinfo         -> 브랜드관리번호, 업종 분류
  인테리어 비용 15125479 FftcBrandFrcsIntInfo2_Service/getbrandFrcsBzmnIntrrctinfo
                요청 jngBizCrtraYr(기준년도), brandMnno(브랜드관리번호)
                응답 unitArIntrrAmtScopeVal(단위면적 인테리어 금액 범위), intrrAmtScopeVal(인테리어 금액 범위), storCrtraAr(점포 기준면적)
업종: 커피(카페), 의류·패션(옷가게)은 업종 이름으로 고른다. 고깃집은 업종 분류에 따로 없어서(한식에 섞여 있다)
한식 브랜드 중 브랜드명이나 주요 상품(majrGdsNm)에 고기 낱말이 들어간 곳을 고른다.
읽기 전에
  - 정보공개서 값이라 실제 지출보다 낮게 적힌 사례가 있다 (서울시 2017 점검: 가맹점주 20%가 실제가 더 많았다고 답함).
  - 범위 값("2000~2300")은 두 숫자의 가운데를 쓴다. 금액은 천원, 점포 기준면적(storCrtraAr)과 단위면적은 평(3.3㎡)이다
    (정보공개서 "단위면적(3.3㎡)당 인테리어 비용"). 예: 기준점포 10평, 평당 2,000~2,300천원, 총 20,000~23,000천원.
  - 금액을 공개하지 않은 브랜드는 응답이 비어 있다.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "mock" / "ftc_interior.json"
BRANDS = "https://apis.data.go.kr/1130000/FftcBrandRlsInfo2_Service/getBrandinfo"
INTERIOR = "https://apis.data.go.kr/1130000/FftcBrandFrcsIntInfo2_Service/getbrandFrcsBzmnIntrrctinfo"
# 구워 먹는 고깃집이 아닌 한식(생선·조개구이, 닭·오리, 국밥·찌개, 도시락)은 뺀다
NOT_BBQ = ["생선", "조개", "닭", "오리", "국밥", "찌개", "도시락", "덮밥", "찜", "해장", "볶음", "탕", "샤브", "떡갈비"]
GROUPS = {"cafe": ["커피", "카페"], "bbq": ["삼겹", "목살", "돼지고기", "소고기", "숯불", "정육", "차돌", "껍데기", "갈비"], "apparel": ["의류", "패션", "의복"]}
UNIT = 1_000  # 천원


def get(url: str, params: dict) -> dict:
    q = urllib.parse.urlencode({"pageNo": 1, "numOfRows": 1000, "resultType": "json", **params})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{url}?{q}", timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise SystemExit(f"403: 이 키로 {url.rsplit('/', 2)[-2]} 활용신청이 안 되어 있습니다 (공공데이터포털에서 신청)") from None
            last = mask(str(e))
        except Exception as e:  # 오류 문구에 키가 섞인 URL이 들어갈 수 있다
            last = mask(str(e))
        time.sleep(2 + attempt * 2)
    raise SystemExit(f"요청 실패: {last}")


def items(d: dict) -> list[dict]:
    it = d.get("items") or []
    if isinstance(it, dict):
        it = it.get("item") or []
    return [it] if isinstance(it, dict) else list(it)


def mid(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    nums = [float(x.replace(",", "")) for x in re.findall(r"\d[\d,]*\.?\d*", v or "")]
    return sum(nums[:2]) / len(nums[:2]) if nums else None


def group_of(row: dict) -> str | None:
    name = f"{row.get('indutyLclasNm', '')} {row.get('indutyMlsfcNm', '')}"
    if "한식" in name:
        menu = f"{row.get('brandNm', '')} {row.get('majrGdsNm', '')}"
        return "bbq" if any(w in menu for w in GROUPS["bbq"]) and not any(w in menu for w in NOT_BBQ) else None
    for g in ("cafe", "apparel"):
        if any(w in name for w in GROUPS[g]):
            return g
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default=str(int(time.strftime("%Y")) - 2))
    args = ap.parse_args()
    ik = key("FTC_FRANCHISE_INTERIOR_KEY", fallback=None)
    bk = key("FTC_BRAND_LIST_KEY", fallback="FTC_FRANCHISE_INTERIOR_KEY")

    brands, page = [], 1
    while True:
        d = get(BRANDS, {"serviceKey": bk, "jngBizCrtraYr": args.year, "pageNo": page})
        rows = items(d)
        brands += rows
        if not rows or page * 1000 >= int(d.get("totalCount") or 0):
            break
        page += 1
    picked = [(b, g) for b in brands if (g := group_of(b))]
    print(f"{args.year}년 브랜드 {len(brands)}개 중 카페·고깃집·옷가게 {len(picked)}개")

    rows: list[dict] = []
    for b, g in picked:
        for r in items(get(INTERIOR, {"serviceKey": ik, "jngBizCrtraYr": args.year, "brandMnno": b["brandMnno"]})):
            per_py = mid(r.get("unitArIntrrAmtScopeVal"))
            total = mid(r.get("intrrAmtScopeVal"))
            rows.append({"group": g, "brand": r.get("brandNm"), "induty": r.get("indutyMlsfcNm"),
                         "area_pyeong": mid(r.get("storCrtraAr")),
                         "per_pyeong_won": round(per_py * UNIT) if per_py else None,
                         "total_won": round(total * UNIT) if total else None})
        time.sleep(0.1)

    summary = {}
    for g in GROUPS:
        v = sorted(x["per_pyeong_won"] for x in rows if x["group"] == g and x["per_pyeong_won"])
        if v:
            q = statistics.quantiles(v, n=4) if len(v) >= 4 else [v[0], statistics.median(v), v[-1]]
            summary[g] = {"n": len(v), "p25": round(q[0]), "median": round(statistics.median(v)), "p75": round(q[-1])}
    OUT.write_text(json.dumps({
        "_meta": {"source": "공정거래위원회 가맹정보 (data.go.kr 15125467 브랜드 목록, 15125479 가맹점 인테리어 비용)",
                  "year": args.year, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                  "note": "정보공개서 값(범위의 가운데). 단위면적은 평(3.3㎡), 금액은 원으로 바꿈. 실제 지출보다 낮게 적힌 사례가 있다"},
        "summary": summary, "brands": rows,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for g, s in summary.items():
        print(f"{g}: 브랜드 {s['n']}개, 평당 인테리어 중앙값 {s['median'] / 1e4:.0f}만원 (25~75% {s['p25'] / 1e4:.0f}~{s['p75'] / 1e4:.0f}만원)")


if __name__ == "__main__":
    main()
