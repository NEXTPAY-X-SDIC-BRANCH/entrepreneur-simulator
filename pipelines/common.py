"""Shared helpers: config, API key, Seoul OpenAPI paging with a raw cache, CRS, 상권 polygons."""
from __future__ import annotations

import io
import json
import os
import sys
import time
import zipfile
from datetime import date
from functools import lru_cache
from pathlib import Path

import pandas as pd
import requests
import yaml

REPO = Path(__file__).resolve().parents[1]
RAW = REPO / "data" / "raw"
PROCESSED = REPO / "data" / "processed"
DEFAULT_INDUSTRY = REPO / "industry" / "pork_bbq.yaml"

SEOUL_BASE = "http://openapi.seoul.go.kr:8088"
PAGE = 1000  # Seoul OpenAPI hard cap per call


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_config(path: str | Path | None = None) -> dict:
    cfg = yaml.safe_load(Path(path or DEFAULT_INDUSTRY).read_text(encoding="utf-8"))
    cfg["trdar"]["all"] = [str(c) for c in cfg["trdar"]["primary"] + cfg["trdar"]["fringe"]]
    return cfg


def quarters(cfg: dict) -> list[str]:
    start, end = cfg["seoul"]["quarters"]["start"], cfg["seoul"]["quarters"]["end"]
    out, y, q = [], int(start[:4]), int(start[4])
    while f"{y}{q}" <= end:
        out.append(f"{y}{q}")
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    return out


# --- API key: environment, then repo/.env, then the nearest parent .env. Never printed. ---

def _read_env_file(path: Path, name: str) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


@lru_cache(maxsize=None)
def seoul_key() -> str:
    key = os.environ.get("SEOUL_API_KEY")
    if key:
        return key
    for d in [REPO, *REPO.parents]:
        key = _read_env_file(d / ".env", "SEOUL_API_KEY")
        if key:
            return key
    raise SystemExit("SEOUL_API_KEY not found (env var, repo/.env, or a parent .env).")


class SeoulAPIError(RuntimeError):
    pass


def _scrub(text: str) -> str:
    try:
        return text.replace(seoul_key(), "<KEY>")
    except SystemExit:
        return text


def seoul_page(service: str, start: int, end: int, *params: str, retries: int = 4) -> dict:
    """One call. Returns {'total': int, 'rows': [...]}; total 0 on INFO-200 (no data)."""
    path = "/".join([seoul_key(), "json", service, str(start), str(end), *[str(p) for p in params]])
    url = f"{SEOUL_BASE}/{path}"
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=90)
            r.raise_for_status()
            d = r.json()
            body = d.get(service, d)
            code = body.get("RESULT", {}).get("CODE") or body.get("CODE")
            if code == "INFO-200":
                return {"total": 0, "rows": []}
            if code != "INFO-000":
                raise SeoulAPIError(f"{service}: {code} {body.get('RESULT', body).get('MESSAGE', '')}")
            return {"total": int(body["list_total_count"]), "rows": body.get("row", [])}
        except SeoulAPIError:
            raise
        except Exception as e:  # network / JSON; the message may contain the URL, so scrub it
            last = _scrub(f"{type(e).__name__}: {e}")
            time.sleep(min(60, 3 * 2 ** attempt))
    raise SeoulAPIError(f"{service} {start}-{end} failed after {retries} tries: {last}")


def seoul_all(service: str, *params: str, cache: Path | None = None, refresh: bool = False) -> pd.DataFrame:
    """Page through a whole result set (1000 rows per call). Cached as gzip CSV under data/raw."""
    if cache is not None and cache.exists() and not refresh:
        return pd.read_csv(cache, dtype=str, keep_default_na=False)
    first = seoul_page(service, 1, PAGE, *params)
    rows, total = list(first["rows"]), first["total"]
    for s in range(PAGE + 1, total + 1, PAGE):
        rows += seoul_page(service, s, min(s + PAGE - 1, total), *params)["rows"]
    if len(rows) != total:
        raise SeoulAPIError(f"{service} {params}: got {len(rows)} rows, API said {total}")
    df = pd.DataFrame(rows).astype(str) if rows else pd.DataFrame()
    df = df.apply(lambda c: c.str.strip()) if len(df) else df
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(cache, index=False)
    return df


# --- Column naming: Seoul API codes -> English snake_case ---

_ID_COLS = {
    "STDR_YYQU_CD": "quarter",
    "TRDAR_SE_CD": "trdar_type_code",
    "TRDAR_SE_CD_NM": "trdar_type_name",
    "TRDAR_CD": "trdar_code",
    "TRDAR_CD_NM": "trdar_name",
    "SVC_INDUTY_CD": "service_code",
    "SVC_INDUTY_CD_NM": "service_name",
}
_MEASURES = [  # (suffix, prefix in output)
    ("_SELNG_AMT", "sales_amt"),
    ("_SELNG_CO", "sales_cnt"),
    ("_FLPOP_CO", "flpop"),
    ("_WRC_POPLTN_CO", "workers"),
    ("_REPOP_CO", "residents"),
    ("_HSHLD_CO", "households"),
]
_SLICES = {
    "THSMON": "total", "TOT": "total", "MDWK": "weekday", "WKEND": "weekend",
    "MON": "mon", "TUES": "tue", "WED": "wed", "THUR": "thu", "FRI": "fri", "SAT": "sat", "SUN": "sun",
    "ML": "male", "FML": "female", "APT": "apt", "NON_APT": "non_apt",
}
_FIXED = {
    "SIMILR_INDUTY_STOR_CO": "stores_total",       # = non-franchise + franchise
    "STOR_CO": "stores_non_franchise",
    "FRC_STOR_CO": "stores_franchise",
    "OPBIZ_RT": "open_rate_pct",
    "OPBIZ_STOR_CO": "stores_opened",
    "CLSBIZ_RT": "close_rate_pct",
    "CLSBIZ_STOR_CO": "stores_closed",
    "VIATR_FCLTY_CO": "facilities_total", "PBLOFC_CO": "public_offices", "BANK_CO": "banks",
    "GEHSPT_CO": "general_hospitals", "GNRL_HSPTL_CO": "hospitals", "PARMACY_CO": "pharmacies",
    "KNDRGR_CO": "kindergartens", "ELESCH_CO": "elementary_schools", "MSKUL_CO": "middle_schools",
    "HGSCHL_CO": "high_schools", "UNIV_CO": "universities", "DRTS_CO": "department_stores",
    "SUPMK_CO": "supermarkets", "THEAT_CO": "theaters", "STAYNG_FCLTY_CO": "lodging",
    "ARPRT_CO": "airports", "RLROAD_STATN_CO": "rail_stations", "BUS_TRMINL_CO": "bus_terminals",
    "SUBWAY_STATN_CO": "subway_stations", "BUS_STTN_CO": "bus_stops",
}


def _slice(s: str) -> str:
    if s in _SLICES:
        return _SLICES[s]
    parts = s.split("_")
    if parts[0] == "TMZON":                       # TMZON_17_21 -> t17_21
        return f"t{parts[1]}_{parts[2]}"
    if parts[0] in ("AGRDE", "MAG", "FAG"):       # AGRDE_60_ABOVE -> age60plus, MAG_20 -> male_age20
        age = f"age{parts[1]}" + ("plus" if "ABOVE" in parts else "")
        return {"AGRDE": "", "MAG": "male_", "FAG": "female_"}[parts[0]] + age
    raise KeyError(s)


def snake_col(col: str) -> str:
    if col in _ID_COLS:
        return _ID_COLS[col]
    if col in _FIXED:
        return _FIXED[col]
    for suffix, prefix in _MEASURES:
        if col.endswith(suffix):
            return f"{prefix}_{_slice(col[: -len(suffix)])}"
    raise KeyError(f"no English name for column {col}")


def tidy_seoul(df: pd.DataFrame) -> pd.DataFrame:
    df = df.rename(columns=snake_col)
    for c in df.columns:
        if c not in _ID_COLS.values():
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


# --- CRS ---

# Localdata X/Y are 5174 (Korean 1985, Bessel, modified central belt). pyproj's EPSG:5174 picks a
# datum transformation on its own; this explicit towgs84 is the one Korean GIS practice uses for
# 행안부 localdata. fetch_license.py checks both against sbiz points and reports the offset.
EPSG5174_TOWGS84 = (
    "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel "
    "+units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43"
)


@lru_cache(maxsize=None)
def transformer(src: str, dst: str = "EPSG:5181"):
    from pyproj import Transformer
    return Transformer.from_crs(src, dst, always_xy=True)


# --- 상권 polygons (영역-상권, OA-15560) ---

RELM_ZIP = RAW / "seoul_trdar_relm_OA-15560.zip"


def download_relm(refresh: bool = False) -> Path:
    """The shapefile is only offered as a file download; the form posts to datafile.seoul.go.kr."""
    if RELM_ZIP.exists() and not refresh:
        return RELM_ZIP
    page = requests.get("https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do", timeout=60).text
    import re
    seq = re.search(r"downloadFile\('(\d+)'\)", page).group(1)
    # the page has several forms with an infSeq field; the file form is frmFile
    inf_seq = re.search(r'name="frmFile".*?name="infSeq" value="(\d+)"', page, re.S).group(1)
    r = requests.post(
        "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false",
        data={"infId": "OA-15560", "seqNo": "", "seq": seq, "infSeq": inf_seq},
        headers={"Referer": "https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do"},
        timeout=300,
    )
    r.raise_for_status()
    if not r.content.startswith(b"PK"):
        raise RuntimeError("영역-상권 download did not return a zip")
    RELM_ZIP.parent.mkdir(parents=True, exist_ok=True)
    RELM_ZIP.write_bytes(r.content)
    return RELM_ZIP


def load_polygons(codes: list[str] | None = None) -> dict:
    """{trdar_code: {'geom': shapely Polygon in EPSG:5181, **attributes}}"""
    import shapefile
    from shapely.geometry import shape

    z = zipfile.ZipFile(download_relm())
    ext = {n.rsplit(".", 1)[1].lower(): n for n in z.namelist()}
    prj = z.read(ext["prj"]).decode()
    assert "Korea_Central_Belt" in prj and "500000" in prj, "영역-상권 CRS is no longer EPSG:5181"
    r = shapefile.Reader(
        shp=io.BytesIO(z.read(ext["shp"])), shx=io.BytesIO(z.read(ext["shx"])),
        dbf=io.BytesIO(z.read(ext["dbf"])), encoding="utf-8",
    )
    out = {}
    for sr in r.iterShapeRecords():
        rec = sr.record.as_dict()
        code = str(rec["TRDAR_CD"])
        if codes is None or code in codes:
            out[code] = {
                "geom": shape(sr.shape.__geo_interface__),
                "trdar_name": rec["TRDAR_CD_N"], "trdar_type_name": rec["TRDAR_SE_1"],
                "signgu_code": rec["SIGNGU_CD"], "signgu_name": rec["SIGNGU_CD_"],
                "adstrd_code": rec["ADSTRD_CD"], "adstrd_name": rec["ADSTRD_CD_"],
                "area_m2": rec["RELM_AR"], "center_x": rec["XCNTS_VALU"], "center_y": rec["YDNTS_VALU"],
            }
    missing = set(codes or []) - set(out)
    if missing:
        log(f"WARNING: 상권 codes not in 영역-상권 shapefile, dropped: {sorted(missing)}")
    return out


def assign_trdar(x, y, polys: dict) -> list[str | None]:
    """Point-in-polygon (EPSG:5181). First polygon hit wins; the configured 상권 do not overlap (checked)."""
    import numpy as np
    from shapely import contains_xy

    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    out = np.full(len(x), None, dtype=object)
    for code, p in polys.items():
        hit = contains_xy(p["geom"], x, y) & np.equal(out, None)
        out[hit] = code
    return list(out)


def today() -> date:
    return date.fromisoformat(os.environ["RUN_DATE"]) if os.environ.get("RUN_DATE") else date.today()


def write_csv(df: pd.DataFrame, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8")
    log(f"  wrote {path.relative_to(REPO)} ({len(df)} rows)")
    return path


def write_json(obj, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    log(f"  wrote {path.relative_to(REPO)}")
    return path
