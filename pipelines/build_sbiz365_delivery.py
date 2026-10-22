"""data/raw/sbiz365/delivery_dong.csv (fetch_sbiz365_delivery.py) -> web/public/mock/sbiz_delivery.json

업종마다: 가장 최근 달의 서울 중앙값과 구별·행정동별 '점포당 월평균 배달 주문 건수·배달 매출', 해마다 같은 달 서울 중앙값(추세).
값이 0인 행정동(배달 매출이 잡히지 않음)은 중앙값에서 뺀다. 시뮬레이터는 구 값 ÷ 서울 값을 구별 배달 수요 배수로 쓴다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "raw" / "sbiz365" / "delivery_dong.csv"
OUT = ROOT / "web" / "public" / "mock" / "sbiz_delivery.json"


def main() -> None:
    d = pd.read_csv(SRC, dtype={"ym": str, "admi_cd": str})
    d = d[(d.orders_per_store > 0) & (d.sales_per_store > 0)]
    out: dict = {"src": "소상공인365 배달분석 (오픈API, 행정동별 점포당 월평균 배달 매출·주문 건수)", "inds": {}}
    for ind, g in d.groupby("ind"):
        last = g.ym.max()
        cur = g[g.ym == last]
        seoul = {"orders": float(cur.orders_per_store.median()), "sales": float(cur.sales_per_store.median())}
        seoul["ticket"] = round(seoul["sales"] / seoul["orders"])
        gu = {}
        for name, x in cur.groupby("gu"):
            o, s = float(x.orders_per_store.median()), float(x.sales_per_store.median())
            gu[name] = {"cd": str(x.admi_cd.iloc[0])[:5], "orders": round(o), "sales": round(s), "ticket": round(s / o), "index": round(o / seoul["orders"], 3),
                        "dongs": {r.admi_cd: {"name": r.dong, "orders": round(r.orders_per_store), "sales": round(r.sales_per_store)} for r in x.itertuples()}}
        trend = {ym: round(float(x.orders_per_store.median())) for ym, x in g.groupby("ym")}
        out["inds"][ind] = {"ym": last, "seoul": {k: round(v) for k, v in seoul.items()}, "gu": gu, "trend_orders": trend}
        print(ind, last, seoul, len(gu), "구", trend)
    OUT.write_bytes(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    print("->", OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
