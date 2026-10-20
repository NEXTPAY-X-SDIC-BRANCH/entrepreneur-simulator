"""카페 동네 분석 보강: 상권변화지표와 소비 -> cafe_dong_profile.json에 필드를 더한다.   python -m pipelines.build_cafe_extra

입력 (서울시 상권분석서비스 2026년 2분기. data/raw/seoul_extra에 받아 둔 EUC-KR CSV):
  trdar_change_dong.csv  상권변화지표-행정동: 상권 변화 유형(LL 다이나믹, LH 상권확장, HL 상권축소, HH 정체), 운영·폐업 영업개월 평균, 서울 평균
  consume_dong.csv       소비-행정동: 지출 총액과 항목별 지출(분기, 원)
추가 필드
  life        운영 중인 가게의 평균 영업 개월 (오래 버티는 동네일수록 큼)
  close_life  최근 폐업한 가게가 문 닫기까지 평균 영업 개월 (작을수록 일찍 망하는 동네)
  s_life, s_close  같은 값의 서울 평균
  change      상권 변화 유형 이름 (서울시 분류)
  leisure     여가·문화 지출 ÷ 지출 총액
읽기 전에
  - 영업 개월은 업종 구분 없는 동 전체 값이다(카페만의 값이 아니다).
  - 소비는 서울시가 동 단위로 추정한 지출이다. 카페 매출의 원인이 아니라 동네 성격을 보여 주는 참고값이다.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "web" / "public" / "mock"
RAW = ROOT / "data" / "raw" / "seoul_extra"
Q = 20262


def main() -> None:
    ch = pd.read_csv(RAW / "trdar_change_dong.csv", encoding="cp949")
    co = pd.read_csv(RAW / "consume_dong.csv", encoding="cp949")
    ch = ch[ch["기준_년분기_코드"] == Q].set_index("행정동_코드")
    co = co[co["기준_년분기_코드"] == Q].set_index("행정동_코드")
    path = MOCK / "cafe_dong_profile.json"
    prof = json.loads(path.read_text(encoding="utf-8"))
    hit = 0
    for r in prof["dong"]:
        code = int(r["code"])
        c = ch.loc[code] if code in ch.index else None
        s = co.loc[code] if code in co.index else None
        r["life"] = int(c["운영_영업_개월_평균"]) if c is not None else None
        r["close_life"] = int(c["폐업_영업_개월_평균"]) if c is not None else None
        r["s_life"] = int(c["서울_운영_영업_개월_평균"]) if c is not None else None
        r["s_close"] = int(c["서울_폐업_영업_개월_평균"]) if c is not None else None
        r["change"] = str(c["상권_변화_지표_명"]).strip() if c is not None else None
        tot = float(s["지출_총금액"]) if s is not None else 0.0
        r["leisure"] = round(float(s["여가_문화_지출_총금액"]) / tot, 4) if s is not None and tot > 0 else None
        hit += c is not None
    col = lambda k: np.array([r[k] for r in prof["dong"] if r[k] is not None and not r["thin"]], float)
    cut = prof["_meta"]["cut"]
    cut["life"] = [float(np.quantile(col("life"), q)) for q in (1 / 3, 2 / 3)]
    cut["close_life"] = [float(np.quantile(col("close_life"), q)) for q in (1 / 3, 2 / 3)]
    cut["leisure_hi"] = float(np.quantile(col("leisure"), 0.75))
    prof["_meta"]["extra"] = {"quarter": Q, "source": "서울시 상권분석서비스 상권변화지표-행정동, 소비-행정동 "}
    path.write_text(json.dumps(prof, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    print(hit, "of", len(prof["dong"]), Counter(r["change"] for r in prof["dong"]))
    print({k: cut[k] for k in ("life", "close_life", "leisure_hi")})


if __name__ == "__main__":
    main()
