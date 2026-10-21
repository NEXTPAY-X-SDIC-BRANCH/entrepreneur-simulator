"""업종별 가게 운영 값 -> research/industries/krei.json.  (lab:industry)

    python -m pipelines.build_industry_krei "<2025 외식업체 경영실태 조사 원자료.xlsx>" [--pdf <통계보고서.pdf>]

입력 (공유받은 자료, 저장소 밖에 둔다. 출력에는 가중 요약값만 들어간다)
  원자료 엑셀  농식품부·농경연 2025 외식업체 경영실태 조사 (조사 2025.8~10, 2024년 실적, 표본 3,138곳) 'Data' 시트.
              업종 a3 (1 한식 .. 8 제과 .. 10 치킨 전문점, 11 김밥 및 기타 간이음식점업, 15 생맥주 전문점, 16 기타 주점업, 17 커피 전문점),
              한식 세분류 a3a (1 일반, 2 면, 3 육류, 4 해산물). 코드표는 통계보고서 표 1의 업종 순서와 표본 수로 맞췄다
              (예: a3=10 표본 172 = 보고서 '치킨 전문점' 172, a3=17 표본 261 = '커피 전문점' 261).
  --pdf (선택) 같은 조사의 통계보고서(mafra.go.kr). 표 95 매출액 평균을 읽어 원자료 가중 평균과 1% 안에서 맞는지 검산한다.
출력 research/industries/krei.json: 업종 id마다 표본 수, 서울 표본 수, 값마다 가중 평균(mean)과 25·50·75 분위(p25..p75).
  비용 비중(식재료비 ÷ 매출 등)은 보고서 표 96~104처럼 '평균 금액 ÷ 평균 매출'로 낸다.
읽기 전에
  - 전국 값이고 프랜차이즈 가맹점(업종마다 비중을 같이 적는다)이 섞여 있다. 서울만 뽑으면 업종마다 표본이 20~60곳이라 참고로만 쓴다.
  - 응답이 비었거나 0인 값(테이블 0개, 배달 없음 등)은 그 값에서만 뺀다(값마다 n이 다르다). 비중(배달 %, 주말 %)은 0도 센다.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "research" / "industries" / "krei.json"

GROUPS = {   # id -> ([(a3, a3a)], 보고서 업종 이름)
    "hansik": ([(1, 1)], "한식 일반음식점업"),
    "pub": ([(15, None), (16, None)], "생맥주 전문점 + 기타 주점업"),
    "bunsik": ([(11, None)], "김밥 및 기타 간이음식점업"),
    "bakery": ([(8, None)], "제과"),
    "chicken": ([(10, None)], "치킨 전문점"),
    "bbq_ref": ([(1, 3)], "한식 육류 요리 전문점 (기존 고깃집 기준, 비교용)"),
    "cafe_ref": ([(17, None)], "커피 전문점 (기존 카페 기준, 비교용)"),
}
PDF_ROWS = {"bakery": "제과", "chicken": "치킨 전문점", "bunsik": "김밥 및 기타 간이음식점업", "hansik": "한식 일반음식점업"}

# 값: (열, 설명, 0 포함 여부)
AMOUNTS = {   # 만원/년
    "sales": ("c1a1", "연 매출액(만원)"), "cost": ("c1a2", "연 영업비용(만원)"), "food": ("c1a3", "식재료비(만원)"),
    "labor_hired": ("c1a4", "고용인 인건비(만원)"), "rent": ("c1a5", "임차료(만원)"), "tax": ("c1a6", "세금과 공과(만원)"),
    "labor_family": ("c1a7", "가족 종사자 인건비(만원)"), "labor_owner": ("c1a8", "대표자 인건비(만원)"),
    "other": ("c1a9", "기타비용(만원)"), "profit": ("c1a10", "영업이익(만원)"),
}
VALUES = {   # 열, 설명, 0을 값으로 셀지
    "sales": ("c1a1", "연 매출액(만원)", False),
    "ticket": ("b26", "평균 객단가(원)", False), "visitors_day": ("b24", "1일 평균 방문 고객 수(명)", True),
    "delivery_day": ("b22", "1일 평균 배달 수(인분)", True), "takeout_day": ("b23", "1일 평균 테이크아웃 수(인분)", True),
    "days_month": ("b10", "한 달 영업일수", False), "hours_day": ("b9a1", "1일 영업시간", False),
    "open_hour": ("b9a2", "영업 시작 시각", False), "close_hour": ("b9a3", "영업 종료 시각", False),
    "area_pyeong": ("b3a2", "사업장 신고 면적(평)", False), "tables": ("b11", "테이블 수", False), "seats": ("b12", "전체 좌석 수", False),
    "hall_pct": ("b20a1", "매출 비중 홀(%)", True), "delivery_pct": ("b20a2", "매출 비중 배달(%)", True),
    "takeout_pct": ("b20a3", "매출 비중 테이크아웃(%)", True), "weekend_pct": ("b25a2", "주말 매출 비중(%)", True),
    "deposit": ("b7a1et", "임차보증금(만원)", False), "rent_month": ("b7a2et", "월세(만원)", False), "key_money": ("b8", "권리금(만원)", False),
    "invest": ("b14et", "개업 시 투자 비용(만원)", False), "invest_interior": ("b14aet", "인테리어(만원)", False),
    "invest_kitchen": ("b14bet", "주방(만원)", False), "invest_hall": ("b14cet", "홀(만원)", False),
    "delivery_agency_month": ("b19a", "배달 대행 월 비용(원)", False), "delivery_agency_count": ("b19b", "배달 대행 월 건수(건)", False),
    "delivery_app_month": ("b18c", "배달앱 월 비용(원)", False),
    "workers": ("d1a9", "근로자 수 전체(명, 대표자 포함)", False), "owner_hours": ("d1b1", "대표자 하루 근로시간", False),
    "temp_pay": ("d1d4", "임시직 1인 월 인건비(만원)", False), "regular_pay": ("d1d2", "상용직 1인 월 인건비(만원)", False),
    "owner_age": ("a5", "대표자 연령", False), "food_waste_cost": ("b28a2", "음식물 쓰레기 처리비(만원/월)", True),
}


def wq(x: np.ndarray, w: np.ndarray, q: float) -> float:
    o = np.argsort(x)
    x, w = x[o], w[o]
    c = np.cumsum(w) / w.sum()
    return float(x[np.searchsorted(c, q)])


def summarize(d: pd.DataFrame, col: str, zero_ok: bool) -> dict | None:
    x = pd.to_numeric(d[col], errors="coerce")
    m = x.notna() & (x >= 0 if zero_ok else x > 0)
    if m.sum() < 5:
        return None
    xv, wv = x[m].to_numpy(float), d.loc[m, "WT"].to_numpy(float)
    return {"n": int(m.sum()), "mean": round(float(np.average(xv, weights=wv)), 1),
            "p25": round(wq(xv, wv, 0.25), 1), "p50": round(wq(xv, wv, 0.5), 1), "p75": round(wq(xv, wv, 0.75), 1)}


def pick(df: pd.DataFrame, keys: list[tuple[int, int | None]]) -> pd.DataFrame:
    m = pd.Series(False, index=df.index)
    for a3, a3a in keys:
        m |= (df["a3"] == a3) & ((df["a3a"] == a3a) if a3a else True)
    return df[m]


def pdf_sales(pdf: str) -> dict[str, float]:
    import pymupdf
    text = "".join(p.get_text() for p in pymupdf.open(pdf))
    i = text.index("<표 95> 매출액\n(단위")
    block = text[i:i + 6000].replace("\n", "|")
    out = {}
    for gid, label in PDF_ROWS.items():
        m = re.search(re.escape(label) + r"\|(\d[\d,]*)\|([\d.]+\|){4}([\d,]+\.\d)", block)
        if m:
            out[gid] = float(m.group(3).replace(",", ""))
    return out


def derived(d: pd.DataFrame) -> dict:
    """원자료에서 직접 낸 운영 지표 (등급 L: 공식 원자료에서 우리가 계산한 값).
    area_elasticity  log(매출) ~ log(면적) 가중 회귀 기울기: 면적이 1% 크면 매출이 몇 % 큰가 (인과가 아니라 단면 관계)
    orders_per_worker 하루 (방문 + 배달 + 포장) ÷ 근로자 수(대표자 포함): 한 사람이 하루에 처리하는 주문
    seat_turn        하루 방문 고객 ÷ 좌석 수: 좌석 한 개가 하루에 받는 손님"""
    num = lambda c: pd.to_numeric(d[c], errors="coerce")  # noqa: E731
    out: dict = {}
    m = (num("c1a1") > 0) & (num("b3a2") > 0)
    x, y, w = np.log(num("b3a2")[m]), np.log(num("c1a1")[m]), d.loc[m, "WT"]
    xm, ym = np.average(x, weights=w), np.average(y, weights=w)
    out["area_elasticity"] = {"n": int(m.sum()), "value": round(float(np.sum(w * (x - xm) * (y - ym)) / np.sum(w * (x - xm) ** 2)), 3)}
    m = num("d1a9") > 0
    orders = num("b24").fillna(0) + num("b22").fillna(0) + num("b23").fillna(0)
    opw = (orders / num("d1a9"))[m]
    out["orders_per_worker"] = {"n": int(m.sum()), **{f"p{q}": round(wq(opw.to_numpy(float), d.loc[m, "WT"].to_numpy(float), q / 100), 1) for q in (50, 75, 90)}}
    m = num("b12") > 0
    turn = (num("b24") / num("b12"))[m]
    out["seat_turn"] = {"n": int(m.sum()), **{f"p{q}": round(wq(turn.to_numpy(float), d.loc[m, "WT"].to_numpy(float), q / 100), 2) for q in (50, 75, 90)}}
    # 고용인 1명당 월 인건비: 고용인 인건비 합 ÷ 유급 고용인 수 합 (상용·임시·일용, 내국·외국; 대표자와 무급 가족 제외)
    hired = sum(num(c).fillna(0) for c in ("d1a2", "d1a3", "d1a4", "d1a5", "d1a6", "d1a7"))
    w = d["WT"]
    out["pay_per_hired_month_man"] = {"n": int((hired > 0).sum()),
                                      "value": round(float((num("c1a4").fillna(0) * w).sum() / (hired * w).sum() / 12), 1),
                                      "hired_mean": round(float(np.average(hired, weights=w)), 2),
                                      "hired_p50": wq(hired.to_numpy(float), w.to_numpy(float), 0.5)}
    # 배달 비용: 배달 대행 + 배달앱 월 비용 ÷ 배달 대행 건수 (대행을 쓰는 가게), 매출 대비 비중 (전체 가게)
    m = num("b19b") > 0
    cost = num("b19a").fillna(0) + num("b18c").fillna(0)
    out["delivery_cost_per_order_krw"] = {"n": int(m.sum()), "value": round(float((cost[m] * w[m]).sum() / (num("b19b")[m] * w[m]).sum()))}
    out["delivery_cost_share"] = {"n": int(len(d)), "value": round(float((cost * 12 / 1e4 * w).sum() / (num("c1a1").fillna(0) * w).sum()), 4)}
    return out


def build(xlsx: str, pdf: str | None) -> dict:
    df = pd.read_excel(xlsx, sheet_name="Data", header=1)
    for c in ("a3", "a3a", "WT", "b13"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    out: dict = {"_meta": {"source": "농식품부·농경연 「2025 외식업체 경영실태 조사」 원자료 (조사 2025.8~10, 2024년 실적, 전국 3,138곳, 가중치 WT)",
                           "method": "pipelines/build_industry_krei.py", "unit": "금액 만원 (객단가·배달 비용은 원)"}, "groups": {}}
    checks = pdf_sales(pdf) if pdf else {}
    for gid, (keys, label) in GROUPS.items():
        d = pick(df, keys)
        g: dict = {"label": label, "n": int(len(d)), "n_seoul": int((d["a4a1"] == "서울").sum()),
                   "franchise_share": round(float(d.loc[d["b13"] >= 2, "WT"].sum() / d["WT"].sum()), 3)}
        am = {}
        for k, (col, _) in AMOUNTS.items():
            x = pd.to_numeric(d[col], errors="coerce").fillna(0)
            am[k] = float(np.average(x, weights=d["WT"]))
        g["pl_mean_man"] = {k: round(v, 1) for k, v in am.items()}
        g["pl_share"] = {k: round(am[k] / am["sales"], 4) for k in am if k != "sales"}
        g["values"] = {k: s for k, (col, _, z) in VALUES.items() if (s := summarize(d, col, z))}
        g["derived"] = derived(d)
        seoul = d[d["a4a1"] == "서울"]
        if len(seoul) >= 10:
            g["seoul_sales_mean_man"] = round(float(np.average(pd.to_numeric(seoul["c1a1"], errors="coerce").fillna(0), weights=seoul["WT"])), 1)
        if gid in checks:
            g["pdf_check"] = {"table95_sales_mean": checks[gid], "ok": abs(am["sales"] / checks[gid] - 1) < 0.01}
        out["groups"][gid] = g
    sales = pd.to_numeric(df["c1a1"], errors="coerce").fillna(0)
    se = df["a4a1"] == "서울"
    out["_meta"]["seoul_uplift"] = {"value": round(float(np.average(sales[se], weights=df.loc[se, "WT"]) / np.average(sales, weights=df["WT"])), 3),
                                    "n_seoul": int(se.sum()), "note": "전 업종 서울 표본 가중 평균 매출 ÷ 전국 가중 평균 매출"}
    out["_meta"]["labels"] = {k: v[1] for k, v in {**AMOUNTS, **{a: (b[0], b[1]) for a, b in VALUES.items()}}.items()}
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--pdf", default=None)
    a = ap.parse_args()
    data = build(a.xlsx, a.pdf)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for gid, g in data["groups"].items():
        print(gid, g["n"], g["pl_mean_man"]["sales"], g.get("pdf_check"), {k: g["pl_share"][k] for k in ("food", "labor_hired", "rent", "profit")})
