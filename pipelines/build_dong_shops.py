"""동네 경쟁 탭용 가게 목록: 한식 소분류 구성, 고깃집 상호, 카페 브랜드, 주변 음식점 구성 -> dong_shops.json

    python -m pipelines.build_dong_shops [상가정보 zip] [점포-행정동 csv]

입력 (원본은 용량이 커서 저장소에 넣지 않는다. 기본 위치는 data/raw/)
  data/raw/sbiz/소상공인시장진흥공단_상가(상권)정보_20260630.zip   상가정보 2026년 6월, 안의 서울 파일(utf-8-sig)만 읽는다
  data/raw/seoul_extra/store_dong.csv                              서울시 상권분석서비스 점포-행정동 (cp949)
출력 web/public/mock/dong_shops.json, 동은 dong_profile.json의 행정동 코드(8자리)로 묶는다
  hansik      한식(I201) 소분류명별 가게 수
  pork        고깃집(I20107 돼지고기 구이/찜) 상호. 상호명과 지점명이 같은 줄은 한 번만
  cafe_brands 카페(I212) 중 아래 브랜드 사전에 걸린 곳: 브랜드, 저가 여부, 지점 수, 지점 이름. 같은 지점 중복 등록은 한 번만
  cafe_floor  층 정보가 있는 카페 수와 그중 1층
  mix         주변 음식점 9종(CS100001~CS100009) 점포 수, 최근 분기
읽기 전에
  - 브랜드 사전은 상호명 앞부분으로 찾는 규칙이다. 프랜차이즈·저가 '개수'는 화면에서 서울 행정동 카페 지표 엑셀 값(cafe_dong.json)을 쓰고,
    이 파일의 브랜드는 이름을 보여 주는 데만 쓴다. 그래서 두 숫자가 조금 다를 수 있다.
  - 상가정보는 신고 기반이라 폐업한 곳이 남아 있거나 같은 가게가 두 번 등록된 경우가 있다.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
ZIP = ROOT / "data" / "raw" / "sbiz" / "소상공인시장진흥공단_상가(상권)정보_20260630.zip"
STORE_DONG = ROOT / "data" / "raw" / "seoul_extra" / "store_dong.csv"

# 상호명(공백 없앰, 영문 대문자)이 이 말로 시작하면 그 브랜드. 저가는 아메리카노 1,500~2,000원대 브랜드.
LOW = {
    "메가MGC커피": ["메가엠지씨커피", "메가MGC커피", "메가커피"], "컴포즈커피": ["컴포즈커피"], "빽다방": ["빽다방"],
    "매머드커피": ["매머드커피익스프레스", "매머드익스프레스", "매머드커피", "메머드익스프레스"], "더벤티": ["더벤티"], "바나프레소": ["바나프레소"],
    "하삼동커피": ["하삼동커피"], "감성커피": ["감성커피"], "백억커피": ["백억커피"], "커스텀커피": ["커스텀커피"],
    "만랩커피": ["만랩커피"], "우지커피": ["우지커피"], "데이롱카페": ["데이롱카페"], "벤티프레소": ["벤티프레소"], "달리는커피": ["달리는커피"],
}
OTHER = {
    "스타벅스": ["스타벅스"], "투썸플레이스": ["투썸플레이스", "투썸"], "이디야커피": ["이디야커피", "이디야"], "할리스": ["할리스커피", "할리스"],
    "커피빈": ["커피빈코리아", "커피빈"], "폴바셋": ["폴바셋"], "파스쿠찌": ["파스쿠찌"], "엔제리너스": ["엔제리너스"], "탐앤탐스": ["탐앤탐스"],
    "커피베이": ["커피베이"], "요거프레소": ["요거프레소"], "텐퍼센트커피": ["텐퍼센트스페셜티커피", "텐퍼센트커피", "텐퍼센트"], "공차": ["공차"], "쥬씨": ["쥬씨&차얌", "쥬씨"],
    "커피에반하다": ["커피에반하다"], "디저트39": ["디저트39"], "설빙": ["설빙"], "커피니": ["커피니"], "셀렉토커피": ["셀렉토커피"],
    "커피스미스": ["커피스미스"], "아마스빈": ["아마스빈"], "드롭탑": ["드롭탑", "카페드롭탑"], "블루보틀": ["블루보틀"],
    "토프레소": ["토프레소"], "카페요아정": ["카페요아정", "요아정"], "읍천리382": ["읍천리382"], "하이오커피": ["하이오커피"],
    "커피사피엔스": ["커피사피엔스"], "더리터": ["더리터"], "카페게이트": ["카페게이트"], "포트캔커피": ["포트캔커피"],
    "해머스미스커피": ["해머스미스"], "카페인중독": ["카페인중독"], "플러스82": ["플러스82"], "과일에반하다": ["과일에반하다"],
    "나이스카페인클럽": ["나이스카페인클럽"], "바나타이거": ["바나타이거"], "트리플에이커피": ["트리플에이커피"], "에그카페24": ["에그카페24"],
    "커피마마": ["커피마마"], "빙동댕": ["빙동댕"],
}
PATTERNS = sorted(((p.upper(), b, b in LOW) for d in (LOW, OTHER) for b, ps in d.items() for p in ps), key=lambda x: -len(x[0]))
FOOD9 = [f"CS10000{i}" for i in range(1, 10)]  # 한식 ~ 호프-간이주점 (커피-음료 CS100010은 뺀다)


def norm(s) -> str:
    return re.sub(r"\s+", "", str(s or "")).upper()


def brand_of(name: str):
    n = norm(name)
    for p, b, low in PATTERNS:
        if n.startswith(p):
            return b, low, n[len(p):]
    return None


def clean(s) -> str | None:
    return None if s is None or (isinstance(s, float) and pd.isna(s)) or str(s).strip() in ("", "nan") else str(s).strip()


def main() -> None:
    zpath = Path(sys.argv[1]) if len(sys.argv) > 1 else ZIP
    spath = Path(sys.argv[2]) if len(sys.argv) > 2 else STORE_DONG
    z = zipfile.ZipFile(zpath)
    name = next(i.filename for i in z.infolist() if "서울" in i.filename)
    cols = ["상호명", "지점명", "상권업종중분류코드", "상권업종소분류코드", "상권업종소분류명", "시군구명", "행정동코드", "행정동명", "층정보"]
    df = pd.read_csv(z.open(name), usecols=cols, dtype=str, encoding="utf-8-sig")
    df = df[df["상권업종중분류코드"].isin(["I201", "I212"])]

    prof = json.loads((MOCK / "dong_profile.json").read_text(encoding="utf-8"))["dong"]
    by_code = {g: x for g, x in df.groupby("행정동코드")}
    by_name = {g: x for g, x in df.groupby(["시군구명", "행정동명"])}

    hansik_all = df[df["상권업종중분류코드"] == "I201"]
    seoul = (hansik_all["상권업종소분류명"].value_counts() / len(hansik_all)).round(4).to_dict()

    st = pd.read_csv(spath, encoding="cp949", dtype={"행정동_코드": str})
    q = st["기준_년분기_코드"].max()
    st = st[(st["기준_년분기_코드"] == q) & st["서비스_업종_코드"].isin(FOOD9)]
    mix = {c: dict(zip(g["서비스_업종_코드_명"], g["전체_점포_수"].astype(int))) for c, g in st.groupby("행정동_코드")}
    labels = st.drop_duplicates("서비스_업종_코드").set_index("서비스_업종_코드")["서비스_업종_코드_명"].reindex(FOOD9).tolist()

    out, miss = {}, []
    for p in prof:
        g = by_code.get(p["code"])
        if g is None:
            g = by_name.get((p["gu"], p["name"]))
        if g is None:
            miss.append(f'{p["gu"]} {p["name"]}')
            continue
        h = g[g["상권업종중분류코드"] == "I201"]
        pork = g[g["상권업종소분류코드"] == "I20107"]
        names = list(dict.fromkeys(" ".join(x for x in (clean(r.상호명), clean(r.지점명)) if x) for r in pork.itertuples()))
        cafes = g[g["상권업종중분류코드"] == "I212"]
        brands: dict[str, dict] = {}
        seen = set()
        for r in cafes.itertuples():
            hit = brand_of(r.상호명)
            if not hit:
                continue
            b, low, rest = hit
            key = (b, norm(r.상호명), clean(r.지점명))
            if key in seen:  # 같은 지점 중복 등록은 한 번만
                continue
            seen.add(key)
            e = brands.setdefault(b, {"b": b, "low": low, "n": 0, "branches": []})
            e["n"] += 1
            # 지점 이름이 상호명 뒤와 지점명 칸에 나뉘어 있는 경우가 많아 이어 붙인다 ("투썸플레이스홍대" + "거리점")
            br = re.sub(r"코리아$", "", rest + (clean(r.지점명) or "")) or None
            if br and (len(br) < 2 or br[0] in "&(-"):
                br = None
            if br and br not in e["branches"]:
                e["branches"].append(br)
        floor = cafes["층정보"].map(clean)
        out[p["code"]] = {
            "hansik": dict(Counter(h["상권업종소분류명"]).most_common()),
            "pork": names,
            "cafe_brands": sorted(brands.values(), key=lambda e: (-e["n"], e["b"])),
            "cafe_floor": {"known": int(floor.notna().sum()), "f1": int((floor == "1").sum())},
            "mix": mix.get(p["code"], {}),
        }

    meta = {
        "generated": pd.Timestamp.now().strftime("%Y-%m-%d"),
        "sources": {"shops": "소상공인시장진흥공단 상가(상권)정보 2026년 6월 (서울)", "mix": f"서울시 상권분석서비스 점포-행정동 {q}"},
        "mix_quarter": str(q), "mix_labels": labels, "seoul_hansik_share": seoul,
        "brands": {"low": list(LOW), "other": list(OTHER)},
        "caveats": ["브랜드는 상호명 앞부분으로 찾은 것이라 프랜차이즈·저가 개수(지표 엑셀)와 조금 다를 수 있음",
                    "상가정보는 신고 기반이라 폐업한 곳이나 중복 등록이 남아 있을 수 있음"],
    }
    (MOCK / "dong_shops.json").write_text(json.dumps({"_meta": meta, "dong": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"dong_shops.json 동 {len(out)}곳, 못 찾은 동 {len(miss)}: {miss[:10]}")


if __name__ == "__main__":
    main()
