"""소상공인시장진흥공단 상가(상권)정보 (data.go.kr 15083033) -> data/processed/stores_sbiz.csv

National quarterly zip (~350 MB, one CSV per 시도, UTF-8 BOM), no key. We read the Seoul CSV, keep
한식 (I201*) rows, and point-in-polygon them (WGS84 -> EPSG:5181) against the configured 상권.
"""
from __future__ import annotations

import argparse
import re
import zipfile

import pandas as pd
import requests

from .common import PROCESSED, RAW, load_config, load_polygons, log, assign_trdar, transformer, write_csv

PAGE_URL = "https://www.data.go.kr/data/{id}/fileData.do"
META_URL = "https://www.data.go.kr/tcs/dss/selectFileDataDownload.do"
FILE_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do"

COLS = {
    "상가업소번호": "store_id", "상호명": "name", "지점명": "branch_name",
    "상권업종소분류코드": "class_code", "상권업종소분류명": "class_name",
    "표준산업분류코드": "ksic_code", "시군구명": "sigungu_name", "행정동코드": "adong_code",
    "행정동명": "adong_name", "법정동명": "ldong_name", "지번주소": "jibun_addr", "도로명주소": "road_addr",
    "건물관리번호": "building_mgmt_no", "건물명": "building_name", "층정보": "floor",
    "경도": "lon", "위도": "lat",
}


def download(dataset_id: str, refresh: bool = False):
    """Resolve the current file through the portal's own JSON endpoint, then download once."""
    ref = PAGE_URL.format(id=dataset_id)
    page = requests.get(ref, timeout=60).text
    detail_pk = re.search(r'name="publicDataDetailPk" value="([^"]+)"', page).group(1)
    meta = requests.get(META_URL, params={"publicDataPk": dataset_id, "publicDataDetailPk": detail_pk,
                                          "fileDetailSn": 1}, headers={"Referer": ref}, timeout=60).json()
    atch = meta["atchFileId"]
    fname = meta["fileDataRegistVO"]["orginlFileNm"] if meta.get("fileDataRegistVO") else ""
    snap = (re.search(r"_(\d{8})\.zip", fname or "") or re.search(r"(\d{8})", page)).group(1)
    path = RAW / "sbiz" / f"sbiz_{snap}.zip"
    if path.exists() and not refresh:
        return path, snap
    log(f"  downloading sbiz {snap} (~350 MB)")
    path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(FILE_URL, params={"atchFileId": atch, "fileDetailSn": 1}, headers={"Referer": ref},
                      stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.rename(path)
    return path, snap


def read_sido(path, sido_token: str, prefix: str) -> pd.DataFrame:
    z = zipfile.ZipFile(path, metadata_encoding="cp949")  # member names are cp949 without the UTF-8 flag
    name = next(n for n in z.namelist() if sido_token in n and n.endswith(".csv"))
    df = pd.read_csv(z.open(name), dtype=str, usecols=list(COLS), encoding="utf-8-sig", keep_default_na=False)
    log(f"  {name}: {len(df):,} rows")
    return df[df["상권업종소분류코드"].str.startswith(prefix)].rename(columns=COLS)


def run(cfg: dict, out_dir=PROCESSED, trdars=None, refresh=False) -> pd.DataFrame:
    s = cfg["sbiz"]
    path, snap = download(s["dataset_id"], refresh)
    df = read_sido(path, s["sido_token"], s["context_prefix"])
    seoul_counts = {c: int((df["class_code"] == c).sum()) for c in s["primary_codes"] + s["comparison_codes"]}
    log(f"  Seoul-wide counts: {seoul_counts}")

    polys = load_polygons(trdars or cfg["trdar"]["all"])
    x, y = transformer("EPSG:4326").transform(df["lon"].astype(float).values, df["lat"].astype(float).values)
    df = df.assign(x_5181=x.round(2), y_5181=y.round(2), trdar_code=assign_trdar(x, y, polys))
    df = df[df["trdar_code"].notna()].copy()
    df["trdar_name"] = df["trdar_code"].map({k: v["trdar_name"] for k, v in polys.items()})
    df["role"] = "context"
    df.loc[df["class_code"].isin(s["comparison_codes"]), "role"] = "comparison"
    df.loc[df["class_code"].isin(s["primary_codes"]), "role"] = "primary"
    # 지점명 non-empty is the only franchise hint in this file. It over-flags (e.g. "본점") and misses
    # chains that register without a branch name; treat it as a flag, not a label.
    df["franchise_flag"] = (df["branch_name"].str.strip() != "").astype(int)
    df["snapshot"] = snap
    df = df.sort_values(["trdar_code", "role", "class_code", "name"]).reset_index(drop=True)
    write_csv(df, out_dir / "stores_sbiz.csv")
    return df


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--industry", default=None)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    run(load_config(a.industry), refresh=a.refresh)
