"""구별 배달·포장 수요 지수 -> web/public/mock/delivery_gu.json.  python -m pipelines.build_delivery_index

입력
  research/delivery/최근+일주일간+배달+또는+포장+음식을+이용한+식사_*.txt
      서울서베이 2022 '최근 일주일간 배달 또는 포장 음식을 이용한 식사' (서울 열린데이터광장, 사용자가 2026-10-22 받은 표)
      연령·가구형태별 '집에서 배달 또는 포장음식' 주당 평균 횟수
  web/public/mock/dong_flow.json   행정동 상주인구 연령 구성 (서울시 상권분석서비스, resi.age)
  web/public/mock/dong_profile.json 행정동 코드 -> 구 이름
  data/raw/delivery/sbiz365_delivery.zip (있으면)  소상공인365 배달상권 경계 2024-01, 구별 개수·면적 (참고)
계산
  구 배달 지수 = Σ(그 구 상주인구 연령 비중 × 그 연령의 주당 배달·포장 횟수) ÷ 서울 전체 같은 값
  상주인구 연령 칸은 10대·20대·30대·40대·50대·60대 이상. 조사는 만 18~29세부터라 10대는 18~29세 값, 60대 이상은 60대와 70대 이상의
  가운데를 쓴다 (가정).
  가구형태도 본다: KOSIS 세대구성별 가구원 (DT_1JC1515, 2025, 시군구) 1인·부부·2세대 이상·기타 인원 × 서베이 가구형태별 횟수.
  최종 지수 = (연령 지수 + 가구 지수) ÷ 2. 연령과 가구형태는 겹치는 몫이 있어 곱하지 않고 평균한다 (가정).
  research/delivery/seongdong_public_delivery_20240829.csv  서울 성동구 공공배달앱 '배달특급' 가맹점 (2024-08-29, cp949).
      업종은 상호의 낱말로 나눈다 (가정, 상호만 있고 업종 칸이 없다). 같은 사업자번호의 가게 여러 개는 브랜드가 여럿인 '공유주방'이다
"""
from __future__ import annotations

import collections
import csv
import json
import struct
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from pipelines.keys import key

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
OUT = MOCK / "delivery_gu.json"


def survey() -> dict[str, float]:
    f = next((ROOT / "research" / "delivery").glob("최근*배달*포장*.txt"))
    rows = list(csv.reader(f.open(encoding="utf-8"), delimiter="\t"))
    out = {}
    for r in rows[3:]:
        if len(r) > 7 and r[0].strip('"') == "서울시":
            out[f"{r[1].strip()}|{r[2].strip()}"] = float(r[7])   # 집에서 배달 또는 포장음식 평균(회)
    return out


def delivery_areas() -> dict[str, dict]:
    z = ROOT / "data" / "raw" / "delivery" / "sbiz365_delivery.zip"
    if not z.exists():
        return {}
    zz = zipfile.ZipFile(z)
    b = zz.read(next(n for n in zz.namelist() if n.endswith(".dbf")))
    nrec, hlen, rlen = struct.unpack("<IHH", b[4:12])
    fields, off = [], 32
    while b[off] != 0x0D:
        fields.append((b[off:off + 11].split(b"\0")[0].decode(), b[off + 16])); off += 32
    agg: dict[str, dict] = collections.defaultdict(lambda: {"n": 0, "area_m2": 0.0})
    for i in range(nrec):
        rec, pos, r = b[hlen + i * rlen: hlen + (i + 1) * rlen], 1, {}
        for n, l in fields:
            r[n] = rec[pos:pos + l].decode("utf-8", "ignore").strip(); pos += l
        if r["SGG_CD"].startswith("11"):
            agg[r["SGG_CD"]]["n"] += 1
            agg[r["SGG_CD"]]["area_m2"] += float(r["ARA"] or 0)
    return agg


HH_ITEMS = {"1인 가구": ["T6020"], "부부 가구": ["T2022"], "2세대 이상 가구": ["T3012", "T4012", "T5020"], "기타 가구": ["T2012", "-T2022", "T7020"]}


def households() -> dict[str, dict[str, float]]:
    """구 이름 -> 가구형태별 가구원 수 (KOSIS DT_1JC1515 최신 연도)."""
    codes = sorted({c.lstrip("-") for v in HH_ITEMS.values() for c in v})
    p = {"method": "getList", "apiKey": key("KOSIS_API_KEY", fallback=None), "format": "json", "jsonVD": "Y", "orgId": "101", "tblId": "DT_1JC1515",
         "itmId": "+".join(codes) + "+", "objL1": "+".join(f"11{n:03d}" for n in range(10, 260, 10)) + "+", "prdSe": "Y", "newEstPrdCnt": "1"}
    with urllib.request.urlopen("https://kosis.kr/openapi/Param/statisticsParameterData.do?" + urllib.parse.urlencode(p), timeout=120) as r:
        d = json.loads(r.read().decode("utf-8"))
    raw: dict[str, dict[str, float]] = collections.defaultdict(dict)
    for row in d if isinstance(d, list) else []:
        raw[row["C1_NM"]][row["ITM_ID"]] = float(row["DT"])
    out = {}
    for gu, v in raw.items():
        out[gu] = {k: sum((-1 if c.startswith("-") else 1) * v.get(c.lstrip("-"), 0.0) for c in cs) for k, cs in HH_ITEMS.items()}
    return out


SD_KINDS = [("치킨", ["치킨", "통닭", "닭강정", "BBQ", "BHC", "교촌", "굽네", "60계", "처갓집", "호식이"]),
            ("카페·디저트", ["카페", "커피", "CAFE", "Cafe", "빵", "베이커리", "케이크", "디저트", "와플", "도넛", "아이스크림", "빙수", "마카롱"]),
            ("분식", ["분식", "떡볶이", "김밥", "순대", "튀김", "라면", "떡볶"]),
            ("피자·버거", ["피자", "파파존스", "버거", "롯데리아", "맘스터치", "KFC", "써브웨이", "서브웨이"]),
            ("족발·보쌈", ["족발", "보쌈"]), ("중식", ["짜장", "짬뽕", "중화", "마라", "탕수육", "반점"]),
            ("도시락·샐러드", ["도시락", "샐러드", "포케", "Salad", "salad", "포케올데이"])]


def seongdong() -> dict:
    f = ROOT / "research" / "delivery" / "seongdong_public_delivery_20240829.csv"
    if not f.exists():
        return {}
    rows = list(csv.reader(f.open(encoding="cp949", errors="ignore")))[1:]
    kinds = collections.Counter()
    for r in rows:
        name = r[1] if len(r) > 1 else ""
        kinds[next((k for k, ws in SD_KINDS if any(w in name for w in ws)), "그 밖의 음식점")] += 1
    return {"source": "서울특별시 성동구 공공배달앱 배달특급 가맹점 현황 (2024-08-29)", "stores": len(rows),
            "businesses": len({r[2] for r in rows if len(r) > 2}), "by_kind": dict(kinds.most_common()),
            "note": "업종은 상호 낱말로 나눔 (가정). 사업자번호 하나에 상호가 여럿이면 한 주방이 여러 브랜드로 배달하는 경우"}


def main() -> None:
    s = survey()
    f = {"10대": s["연령별|만 18~29세"], "20대": s["연령별|만 18~29세"], "30대": s["연령별|30대"], "40대": s["연령별|40대"],
         "50대": s["연령별|50대"], "60대 이상": (s["연령별|60대"] + s["연령별|70대 이상"]) / 2}
    flow = json.loads((MOCK / "dong_flow.json").read_text(encoding="utf-8"))
    ages = flow["_meta"]["age"]
    # 행정동 코드 앞 5자리 -> 구 이름 (dong_profile.json의 code·gu)
    gus = {d["code"][:5]: d["gu"] for d in json.loads((MOCK / "dong_profile.json").read_text(encoding="utf-8"))["dong"]}
    pop: dict[str, list[float]] = collections.defaultdict(lambda: [0.0] * len(ages))
    for code, d in flow["dong"].items():
        r = d.get("resi")
        if not r or not r.get("tot"):
            continue
        for i, a in enumerate(r["age"]):
            pop[code[:5]][i] += r["tot"] * a
    def weekly(v: list[float]) -> float:
        t = sum(v)
        return sum(v[i] / t * f[a] for i, a in enumerate(ages)) if t else 0.0
    seoul_v = [sum(p[i] for p in pop.values()) for i in range(len(ages))]
    base = weekly(seoul_v)
    areas = delivery_areas()
    hf = {k.split("|")[1].strip(): v for k, v in s.items() if k.startswith("가구형태")}
    try:
        hh = households()
    except Exception as e:  # noqa: BLE001  KOSIS가 안 되면 연령만 쓴다
        print("가구형태 건너뜀:", str(e)[:80]); hh = {}
    hh_w = lambda v: sum(v[k] * hf[k] for k in v) / max(1.0, sum(v.values()))  # noqa: E731
    hh_base = (sum(hh_w(v) * sum(v.values()) for v in hh.values()) / sum(sum(v.values()) for v in hh.values())) if hh else 1.0
    out_gu = {}
    for code, v in pop.items():
        name = gus.get(code)
        if not name:
            continue
        ar = areas.get(code[:4], {})
        age_idx = weekly(v) / base
        h = hh.get(name)
        hh_idx = hh_w(h) / hh_base if h else None
        out_gu[name] = {"index": round((age_idx + hh_idx) / 2 if hh_idx else age_idx, 3), "age_index": round(age_idx, 3),
                        "household_index": round(hh_idx, 3) if hh_idx else None,
                        "single_share": round(h["1인 가구"] / sum(h.values()), 3) if h else None,
                        "age_share": [round(x / sum(v), 3) for x in v], "delivery_areas": ar.get("n", 0)}
    out = {"_meta": {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "method": "pipelines/build_delivery_index.py",
                     "survey": "서울서베이 2022 최근 일주일간 배달 또는 포장 음식을 이용한 식사 (집에서, 주당 평균 회)",
                     "population": "서울시 상권분석서비스 행정동 상주인구 연령 (dong_flow.json resi)",
                     "areas": "소상공인365 배달상권 경계 2024-01 (구별 개수, 참고)",
                     "weekly_by_age": f, "seoul_weekly": round(base, 3), "seoul_survey_avg": s["소계|소계"],
                     "household": {k.split("|")[1].strip(): v for k, v in s.items() if k.startswith("가구형태")}},
           "gu": dict(sorted(out_gu.items(), key=lambda x: -x[1]["index"])), "seongdong_public_app": seongdong()}
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))
    top = list(out["gu"].items())
    print("서울 주당", round(base, 2), "| 높은 구", [(k, v["index"]) for k, v in top[:4]], "| 낮은 구", [(k, v["index"]) for k, v in top[-3:]])


if __name__ == "__main__":
    main()
