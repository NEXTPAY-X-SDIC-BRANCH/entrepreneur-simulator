"""소상공인365 배달분석 (오픈API 키 SBIZ365_DELIVERY_KEY로 여는 위젯이 쓰는 자료)을 서울 25개 구 × 업종 × 달로 모은다.

위젯 /gis/openApi/delivery?certKey=... 가 지도 클릭 위치(TM 좌표, EPSG:5181)로 /gis/delivery/getAdmAnlsByCty.json 을 부르면
그 구의 행정동마다 '점포당 월평균 배달 매출'(mmavgSlsAmt)과 '점포당 월평균 배달 주문 건수'(mmavgOrdrNocs)가 온다.
한 번 부르면 구 하나의 행정동이 모두 온다. 인증키는 위젯을 여는 데만 쓰이고, 값은 출력하지 않는다.

  python -m pipelines.fetch_sbiz365_delivery [--months 24] [--years]
  -> data/raw/sbiz365/delivery_dong.csv  (ym, ind, gu, admi_cd, dong, sales_per_store, orders_per_store)
"""
from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path

import requests
from pyproj import Transformer

from pipelines.keys import key, mask

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "sbiz365" / "delivery_dong.csv"
BASE = "https://bigdata.sbiz.or.kr"
# 위젯의 업종 이름 (upjong.json). 시뮬레이터 업종: 치킨, 분식, 카페, 고깃집(돼지고기 구이)
INDS = {"chicken": "치킨", "bunsik": "김밥/만두/분식", "cafe": "카페", "bbq": "돼지고기 구이/찜"}
# 구 안의 한 점 (구청 근처). 응답의 ctyNm으로 맞는 구인지 확인한다
GU_PT = {
    "종로구": (126.9790, 37.5735), "중구": (126.9977, 37.5641), "용산구": (126.9904, 37.5326), "성동구": (127.0369, 37.5634),
    "광진구": (127.0823, 37.5385), "동대문구": (127.0398, 37.5744), "중랑구": (127.0927, 37.6066), "성북구": (127.0167, 37.5894),
    "강북구": (127.0255, 37.6396), "도봉구": (127.0471, 37.6688), "노원구": (127.0563, 37.6542), "은평구": (126.9288, 37.6027),
    "서대문구": (126.9368, 37.5791), "마포구": (126.9087, 37.5663), "양천구": (126.8665, 37.5170), "강서구": (126.8495, 37.5509),
    "구로구": (126.8874, 37.4954), "금천구": (126.8956, 37.4569), "영등포구": (126.8963, 37.5264), "동작구": (126.9393, 37.5124),
    "관악구": (126.9516, 37.4784), "서초구": (127.0324, 37.4837), "강남구": (127.0473, 37.5172), "송파구": (127.1059, 37.5145),
    "강동구": (127.1238, 37.5301),
}
TM = Transformer.from_crs("EPSG:4326", "EPSG:5181", always_xy=True)
num = lambda s: float(str(s).replace(",", "").replace("원", "").replace("건", "") or 0)


def months(s: requests.Session, n: int, years: bool) -> list[str]:
    all_ym = [d["crtrYm"] for d in s.get(f"{BASE}/gis/delivery/getDate.json", timeout=30).json()]
    pick = all_ym[-n:]
    if years:  # 해마다 같은 달 (추세 보기)
        last = all_ym[-1][4:]
        pick = sorted(set(pick) | {y for y in all_ym if y[4:] == last})
    return pick


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--years", action="store_true")
    a = ap.parse_args()
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (changeup-simulator research)"
    r = s.get(f"{BASE}/gis/openApi/delivery", params={"certKey": key("SBIZ365_DELIVERY_KEY", fallback=None)}, timeout=30)
    if r.status_code != 200 or "403" in r.text[:200]:
        raise SystemExit(mask(f"위젯을 열지 못했어요: {r.status_code} {r.text[:120]}"))
    yms = months(s, a.months, a.years)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    done: set[tuple[str, str, str]] = set()
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            done = {(row["ym"], row["ind"], row["gu"]) for row in csv.DictReader(f)}
    new = not OUT.exists()
    with OUT.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["ym", "ind", "gu", "admi_cd", "dong", "sales_per_store", "orders_per_store"])
        n = 0
        for ym in yms:
            for ind, nm in INDS.items():
                for gu, (lng, lat) in GU_PT.items():
                    if (ym, ind, gu) in done:
                        continue
                    x, y = TM.transform(lng, lat)
                    for attempt in range(3):
                        try:
                            d = s.get(f"{BASE}/gis/delivery/getAdmAnlsByCty.json", params={"x": x, "y": y, "tpbizNm": nm, "crtrYm": ym}, timeout=30).json()
                            break
                        except Exception as e:  # 잠깐 쉬고 다시
                            print(mask(f"  retry {ym} {ind} {gu}: {e}"))
                            time.sleep(2 + attempt * 3)
                    else:
                        continue
                    rows = [x_ for x_ in d if x_.get("ctyNm") == gu]
                    if d and not rows:
                        print(f"  {gu}: 다른 구가 왔어요 ({d[0].get('ctyNm')})")
                    for x_ in rows:
                        w.writerow([ym, ind, gu, x_["admiCd"], x_["admiNm"], num(x_["mmavgSlsAmt"]), num(x_["mmavgOrdrNocs"])])
                    n += 1
                    time.sleep(1.0)  # 사이트에 부담을 주지 않게 (빠르게 부르면 연결을 끊는다)
            f.flush()
            print(f"{ym} 끝 (요청 {n}건)")


if __name__ == "__main__":
    main()
