"""서울 행정동 경계 -> web/public/mock/seoul_dong.json (동네 고르기 지도).   python -m pipelines.build_seoul_dong <HangJeongDong geojson>

입력: vuski/admdongkor 행정동 경계 (https://github.com/vuski/admdongkor, ver20230701). 법정경계가 아니라 행정동 기준이다.
구 지도(seoul_gu.json)와 같은 좌표계로 옮긴다: x = 88.2088 * 경도 - 11201.45, y = 110.8565 * 위도 - 4164.63 (km 단위 평면, 구 경계의
외곽 상자를 맞춰 구한 값이라 두 지도 사이에 최대 0.25km 어긋남이 있다). 점은 Douglas-Peucker로 0.015km까지 줄이고 소수 둘째 자리로 반올림한다.
출력 (동마다): gu, name, code(adm_cd8), c(외곽 상자 중심), p·r(내접원 중심과 반지름: 글자를 놓는 자리), rings
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "mock" / "seoul_dong.json"
AX, BX, AY, BY = 88.20877177, -11201.45138299, 110.85648853, -4164.62835412
TOL = 0.015
MERGE_TO = {("강동구", "상일동"): {"상일제1동", "상일제2동"}}
MERGE = set().union(*MERGE_TO.values())


def dp(pts: np.ndarray, tol: float) -> np.ndarray:
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        d = b - a
        n = np.hypot(*d)
        seg = pts[i + 1:j]
        dist = np.hypot(*(seg - a).T) if n == 0 else np.abs(d[0] * (seg[:, 1] - a[1]) - d[1] * (seg[:, 0] - a[0])) / n
        k = int(dist.argmax())
        if dist[k] > tol:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return pts[keep]


def pole(ring: np.ndarray) -> tuple[float, float, float]:
    """폴리곤 안에서 경계까지 가장 먼 점(가장 큰 내접원의 중심)과 그 반지름. 동 이름을 동 면적 한가운데에 놓고 글자 크기를 정하는 데 쓴다."""
    a, b = ring, np.roll(ring, -1, axis=0)

    def depth(pts: np.ndarray) -> np.ndarray:
        # 안쪽이면 + 경계까지 거리, 바깥이면 -
        x, y = pts[:, 0][:, None], pts[:, 1][:, None]
        x1, y1, x2, y2 = a[:, 0][None], a[:, 1][None], b[:, 0][None], b[:, 1][None]
        inside = (((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / np.where(y2 == y1, 1e-12, y2 - y1) + x1)).sum(1) % 2 == 1
        dx, dy = x2 - x1, y2 - y1
        t = np.clip(((x - x1) * dx + (y - y1) * dy) / np.where(dx * dx + dy * dy == 0, 1e-12, dx * dx + dy * dy), 0, 1)
        d = np.hypot(x - (x1 + t * dx), y - (y1 + t * dy)).min(1)
        return np.where(inside, d, -d)

    lo, hi = ring.min(0), ring.max(0)
    best = None
    for step, span in ((40, None), (24, 0.12)):
        if best is None:
            xs, ys = np.linspace(lo[0], hi[0], step), np.linspace(lo[1], hi[1], step)
        else:
            w = max(hi[0] - lo[0], hi[1] - lo[1]) * span
            xs, ys = np.linspace(best[0] - w, best[0] + w, step), np.linspace(best[1] - w, best[1] + w, step)
        g = np.array([(x, y) for x in xs for y in ys])
        d = depth(g)
        k = int(d.argmax())
        best = (float(g[k, 0]), float(g[k, 1]), float(d[k]))
    return best


def main() -> None:
    geo = json.load(open(sys.argv[1], encoding="utf-8"))
    out = []
    for f in geo["features"]:
        p = f["properties"]
        if p["sido"] != "11":
            continue
        polys = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        rings, best, rings_np = [], None, []
        for poly in polys:
            ring = np.array(poly[0])
            xy = np.c_[ring[:, 0] * AX + BX, ring[:, 1] * AY + BY]
            s = dp(xy, TOL)
            if len(s) < 4:
                continue
            rings.append([[round(float(x), 2), round(float(y), 2)] for x, y in s])
            rings_np.append(s)
            area = abs(np.sum(xy[:-1, 0] * xy[1:, 1] - xy[1:, 0] * xy[:-1, 1])) / 2
            if best is None or area > best[0]:
                best = (area, (xy[:, 0].min() + xy[:, 0].max()) / 2, (xy[:, 1].min() + xy[:, 1].max()) / 2)
        if rings:
            out.append({"gu": p["sggnm"], "name": p["temp"].split(" ")[-1], "code": p["adm_cd8"], "c": [round(best[1], 2), round(best[2], 2)], "rings": rings, "_a": best[0], "_np": rings_np})
    # 상권분석서비스는 상일동 하나로 센다. 경계 파일에서 둘로 갈린 동을 다시 합친다.
    merged = [d for d in out if d["name"] not in MERGE]
    for new, olds in MERGE_TO.items():
        parts = [d for d in out if d["name"] in olds and d["gu"] == new[0]]
        if parts:
            top = max(parts, key=lambda d: d["_a"])
            merged.append({"gu": new[0], "name": new[1], "code": top["code"], "c": top["c"], "rings": [r for d in parts for r in d["rings"]], "_a": 0, "_np": [x for d in parts for x in d["_np"]]})
    out = merged
    for d in out:
        d.pop("_a", None)
        big = max(d.pop("_np", None) or [np.array(d["rings"][0])], key=lambda r: abs(np.sum(r[:-1, 0] * r[1:, 1] - r[1:, 0] * r[:-1, 1])))
        px, py, pr = pole(big)
        d["p"], d["r"] = [round(px, 2), round(py, 2)], round(pr, 2)
    doc = {"_meta": {"source": "vuski/admdongkor HangJeongDong_ver20230701 (행정동 경계)", "method": "pipelines/build_seoul_dong.py", "n": len(out),
                     "caveat": "구 지도와 좌표를 외곽 상자로 맞춰 최대 0.25km 어긋난다. 행정동 경계는 2023년 7월 기준"}, "dong": out}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(len(out), OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
