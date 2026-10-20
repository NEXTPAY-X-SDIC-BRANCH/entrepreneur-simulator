"""고깃집 기준을 '한식음식점'에서 '한식 육류 요리 전문점'으로 좁히는 데 쓰는 외식업체 경영실태조사 값을 만든다.

    python -m pipelines.build_gogi_krei <2025 외식업체 경영실태 통계보고서.pdf> <F&B 데이터 (로우데이터 포함).xlsx>

입력 (둘 다 공유받은 자료, 이 저장소 밖에 둔다)
  통계보고서 PDF   농림축산식품부·한국농촌경제연구원 [보고서 6] 2025 외식업체 경영실태 조사 통계보고서 (표본 3,138곳, 조사 2025.8~10).
                   표마다 '한식 육류 요리 전문점'(275곳) 행이 있다. PDF의 표에서 그 행을 그대로 읽는다.
  F&B 엑셀        같은 조사의 원자료(표본 시트). 한식(a3=1) 중 세분류 a3a=3이 한식 육류 요리 전문점 275곳이다.
                   가중치(WT)를 써서 평당 인테리어 비용 같은 값의 분위수를 직접 계산한다.
출력 web/public/mock/gogi_krei.json
값은 원문 그대로 옮기고 반올림만 한다. 전국 값이고 서울만 따로 뽑을 수 있는 표는 없다.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pymupdf

MOCK = Path(__file__).resolve().parents[1] / "web" / "public" / "mock"
LABEL = "한식 육류 요리 전문점"
BASE = "한식 일반음식점업"   # 지금 고깃집 화면이 쓰는 '한식음식점'에 가장 가까운 세분류 (한식 안에서 육류·면·해산물을 뺀 나머지)
NUM = re.compile(r"^-?[\d,]+(\.\d+)?$")

# 표 번호 -> (키, 설명, 열 이름들). 열 이름은 PDF 머리글 순서. 마지막이 '평균'인 표가 많다.
BAND5 = ["1천 미만", "1천~2천 미만", "2천~5천 미만", "5천~1억 미만", "1억 이상"]
SPEC = {
    12: ("area_m2", "사업장 신고 면적(㎡)", ["30 미만", "30~50 미만", "50~100 미만", "100~300 미만", "300 이상", "평균"]),
    19: ("deposit", "임차보증금(만원)", BAND5 + ["평균"]),
    20: ("rent_month", "월세(만원)", ["100 미만", "100~300 미만", "300~500 미만", "500~800 미만", "800 이상", "평균"]),
    22: ("key_money", "임차권리금(만원)", BAND5 + ["평균"]),
    24: ("hours_day", "1일 영업시간", ["12시간 미만", "12시간", "12시간 초과", "평균"]),
    25: ("days_month", "한 달 영업일수", ["24일 이하", "25~26일", "27~28일", "29~30일", "평균"]),
    28: ("tables", "테이블 수", ["5개 미만", "5~10 미만", "10~20 미만", "20 이상", "평균"]),
    29: ("seats", "전체 좌석 수", ["9석 이하", "10~19", "20~29", "30~39", "40~49", "50~59", "60~99", "100 이상", "평균"]),
    31: ("invest", "개업 시 투자 비용(만원)", BAND5 + ["모름", "평균"]),
    32: ("invest_interior", "투자 비용 중 인테리어(만원)", BAND5 + ["모름", "평균"]),
    33: ("invest_kitchen", "투자 비용 중 주방(만원)", BAND5 + ["모름", "평균"]),
    34: ("invest_hall", "투자 비용 중 홀(만원)", BAND5 + ["모름", "평균"]),
    58: ("channel_share", "매출 비중(%)", ["음식점 내", "배달", "테이크아웃"]),
    60: ("visitors_day", "1일 평균 방문 고객 수(명)", ["20 미만", "20~30 미만", "30~50 미만", "50~100 미만", "100 이상", "평균"]),
    65: ("inflow", "주요 유입 고객(%)", ["개인", "2~5인", "단체(6인 이상)"]),
    66: ("weekday_weekend", "요일별 매출 비중(%)", ["평일(월~목)", "주말(금~일)"]),
    67: ("ticket", "평균 객단가(원)", ["5천 미만", "5천~1만 미만", "1만~2만 미만", "2만~3만 미만", "3만 이상", "평균"]),
    95: ("pl_sales", "연 매출액(만원)", ["5천 미만", "5천~1억 미만", "1억~5억 미만", "5억 이상", "평균"]),
    96: ("pl_cost", "연 영업비용(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    97: ("pl_food", "연 식재료비(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    98: ("pl_labor_hired", "연 고용인 인건비(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    99: ("pl_rent", "연 임차료(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    100: ("pl_tax", "연 세금과 공과(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    101: ("pl_labor_family", "연 가족 종사자 인건비(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    102: ("pl_labor_owner", "연 대표자 인건비(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    103: ("pl_other", "연 기타비용(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    104: ("pl_profit", "연 영업이익(만원)", ["2천 미만", "2천~5천 미만", "5천~1억 미만", "1억~2억 미만", "2억 이상", "평균"]),
    105: ("food_mix", "품목별 식재료비 비중(%)", ["쌀", "곡류(쌀 제외)", "채소", "과일", "육류", "수산물", "가공식품", "기타", "주류"]),
    115: ("workers", "근로자 수(명)", ["내국 상용(대표자 포함)", "내국 임시", "내국 일용", "외국 상용", "외국 임시", "외국 일용", "무급 가족", "전체"]),
    163: ("sales_change", "전년 대비 매출 증감", ["줄었음(%)", "감소 비율(%)", "비슷함(%)", "늘었음(%)", "증가 비율(%)"]),
    133: ("hard_food", "어려움 점수: 식재료비 상승", None),
    134: ("hard_rent", "어려움 점수: 임차료 상승", None),
    135: ("hard_wage", "어려움 점수: 인건비 상승", None),
    136: ("hard_rival", "어려움 점수: 경쟁 심화", None),
}


def table_starts(lines: list[str]) -> dict[int, int]:
    out: dict[int, int] = {}
    for i, l in enumerate(lines):
        m = re.match(r"<표 (\d+)>", l)
        if m and "계속" not in l and "···" not in l and int(m.group(1)) not in out:
            out[int(m.group(1))] = i
    return out


def row_values(seg: list[str], label: str):
    parts = label.split(" ")
    s = [x.strip() for x in seg]
    for i in range(len(s)):
        if s[i] == label or s[i:i + len(parts)] == parts:
            j = i + (1 if s[i] == label else len(parts))
            vals = []
            while j < len(s) and NUM.match(s[j]):
                vals.append(float(s[j].replace(",", "")))
                j += 1
            return vals
    return None


def row_values_seq(seg: list[str], parts: list[str]):
    s = [x.strip() for x in seg]
    for i in range(len(s)):
        if s[i:i + len(parts)] == parts:
            j, vals = i + len(parts), []
            while j < len(s) and NUM.match(s[j]):
                vals.append(float(s[j].replace(",", "")))
                j += 1
            return vals
    return None


def pdf_tables(pdf: Path) -> dict:
    doc = pymupdf.open(pdf)
    lines = "\n".join(p.get_text() for p in doc).split("\n")
    starts = table_starts(lines)
    nums = sorted(starts)
    out = {}
    for n, (key, title, cols) in SPEC.items():
        i = starts[n]
        j = starts[nums[nums.index(n) + 1]] if nums.index(n) + 1 < len(nums) else len(lines)
        seg = lines[i:j]
        entry = {"table": n, "title": title}
        for tag, lab in (("meat", LABEL), ("hansik", BASE)):
            v = row_values(seg, lab)
            if v is None:
                continue
            e = {"n": int(v[0])}
            vals = v[1:]
            if cols:
                e["values"] = dict(zip(cols, vals))
            else:
                e["values"] = vals                 # 7점 척도 응답 분포 + 마지막이 7점 평균
                e["mean7"] = vals[-1]
            entry[tag] = e
        # 한식 전체(1,091곳): '음식점 업종' 목록의 첫 줄. 서울시 상권분석서비스의 '한식음식점'과 같은 범위다.
        v = row_values(seg, "음식점 업종 한식") or row_values_seq(seg, ["음식점", "업종", "한식"])
        if v is not None:
            e = {"n": int(v[0])}
            e["values"] = dict(zip(cols, v[1:])) if cols else v[1:]
            entry["hansik_all"] = e
        tot = row_values(seg, "■ 전체 ■")
        if tot and cols:
            entry["all"] = {"n": int(tot[0]), "values": dict(zip(cols, tot[1:]))}
        out[key] = entry
    return out


def wq(x: pd.Series, w: pd.Series, qs=(0.25, 0.5, 0.75)):
    d = pd.DataFrame({"x": x, "w": w}).dropna()
    d = d[d.x > 0].sort_values("x")
    if len(d) == 0:
        return None
    cw = d.w.cumsum() / d.w.sum()
    return {"n": int(len(d)), **{f"p{int(q * 100)}": float(np.interp(q, cw, d.x)) for q in qs}}


def micro(xlsx: Path) -> dict:
    df = pd.read_excel(xlsx, sheet_name="국내 F&B 업장 RAW DATA (표본)", header=1)
    g = df[(df.a3 == 1) & (df.a3a == 3)].copy()
    g["pyeong"] = g.b3a1 / 3.3058
    g["int_pp"] = g.b14aet / g.pyeong          # 평당 인테리어
    g["kit"] = g.b14bet
    g["hall"] = g.b14cet
    g["rent_pp"] = g.b7a2et / g.pyeong          # 평당 월세 (현금 월세 만원)
    g["recent"] = g.b1a1 >= 2019                # 최근 개업(공사비가 오른 뒤)
    out = {"n": int(len(g)), "pop_weight": float(g.WT.sum()),
           "note": "한식(a3=1) 중 a3a=3. 가중치 WT 적용. 값이 있는 응답만 센다(없음·모름 제외)."}
    for key, col in (("pyeong", "pyeong"), ("interior_total", "b14aet"), ("interior_per_pyeong", "int_pp"), ("kitchen", "kit"),
                     ("hall", "hall"), ("invest_total", "b14et"), ("deposit", "b7a1et"), ("rent_month", "b7a2et"),
                     ("rent_per_pyeong", "rent_pp"), ("key_money", "b8"), ("seats", "b12"), ("tables", "b11")):
        out[key] = wq(g[col], g.WT)
    r = g[g.recent]
    out["recent_since"] = 2019
    out["recent_n"] = int(len(r))
    for key, col in (("interior_per_pyeong", "int_pp"), ("interior_total", "b14aet"), ("kitchen", "kit"), ("hall", "hall"), ("invest_total", "b14et")):
        out[f"recent_{key}"] = wq(r[col], r.WT)
    # 평당 인테리어를 규모별로: 우리 화면은 12~30평
    mid = g[(g.pyeong >= 12) & (g.pyeong <= 40)]
    out["mid_size_12_40"] = {"n": int(len(mid)), "interior_per_pyeong": wq(mid.int_pp, mid.WT), "rent_per_pyeong": wq(mid.rent_pp, mid.WT)}
    return out


def main() -> None:
    pdf, xlsx = Path(sys.argv[1]), Path(sys.argv[2])
    obj = {"_meta": {"source": "2025 외식업체 경영실태조사 (농림축산식품부·한국농촌경제연구원, 조사 2025.8~10, 표본 3,138곳). 통계보고서 표와 원자료를 공유받아 사용.",
                     "files": [pdf.name, xlsx.name], "label": LABEL, "base_label": BASE,
                     "caveat": ["전국 값이다. 서울만 따로 뽑은 표는 없다",
                                "한식 육류 요리 전문점에는 삼겹살집 외에 갈비·불고기·족발·보쌈 같은 육류 요리 가게가 함께 들어 있다",
                                "투자 비용은 응답자의 절반 가까이가 '모름'이고, 값이 있는 응답은 개업 시기가 제각각이라 공사비 물가가 섞여 있다",
                                "매출·비용은 연 단위, 점포당 평균이다. 소상공인 필터를 걸지 않은 표본 전체(5인 이상 포함)다"]},
           "tables": pdf_tables(pdf), "micro": micro(xlsx)}
    (MOCK / "gogi_krei.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    t = obj["tables"]
    print("tables", len(t), "micro n", obj["micro"]["n"])
    for k in ("pl_sales", "pl_food", "pl_profit", "invest_interior"):
        print(k, t[k]["meat"]["values"].get("평균"), t[k].get("hansik", {}).get("values", {}).get("평균"), t[k].get("hansik_all", {}).get("values", {}).get("평균"))
    print(json.dumps(obj["micro"]["interior_per_pyeong"]), json.dumps(obj["micro"]["recent_interior_per_pyeong"]))


if __name__ == "__main__":
    main()
