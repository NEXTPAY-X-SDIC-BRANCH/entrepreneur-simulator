# Data: public sources for the 대학로 pork BBQ twin

All counts below were observed on the run of 2026-09-30/10-01 (KST). Re-run with
`python -m pipelines.run_all`; `--selftest` runs a 1-quarter × 1-상권 slice and asserts shapes.

## How to run

```bash
python3.11 -m venv .venv            # or: uv venv --python 3.12
.venv/bin/pip install -r requirements.txt
echo 'SEOUL_API_KEY=...' > .env     # free key from data.seoul.go.kr; .env is gitignored
.venv/bin/python -m pipelines.run_all --selftest
.venv/bin/python -m pipelines.run_all
```

- The key is read from the environment, then `repo/.env`, then the nearest parent `.env`. It is never
  printed; network errors are scrubbed before logging, and the run asserts the key is not in any output.
- Everything the pipelines download is cached in `data/raw/` (gitignored, ~450 MB, mostly the 소상공인
  zip). A second run is offline except for two small page fetches that resolve download links.
  `--refresh` ignores the cache. A first full run takes ~600 Seoul API calls.
- The only 업종-specific file is `industry/pork_bbq.yaml` (codes, 상권, quarters, license service,
  name keywords, survival window). A cafe run copies it and changes the codes.

## Study area (config `trdar`)

| Code | Name | Type | 행정동 | Area m² | Role |
|---|---|---|---|---|---|
| 3120012 | 대학로(혜화역) | 발달상권 | 혜화동 | 256,888 | primary |
| 3110021 | 성균관대학교 | 골목상권 | 혜화동 | 77,655 | fringe |
| 3110024 | 혜회동주민센터 (sic, in the source) | 골목상권 | 혜화동 | 52,850 | fringe |
| 3110027 | 혜화역 1번 | 골목상권 | 이화동 | 117,673 | fringe |

All four codes exist in the shapefile and the API; all are in 종로구; the four polygons do not overlap.

## Datasets

### 1. 서울시 상권분석서비스 (data.seoul.go.kr), 공공누리 1유형

Endpoint `http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{start}/{end}/{params}`, 1,000 rows per
call. Served quarters: **20211–20262** (20204 returns INFO-200). Join key: `trdar_code` (+ `quarter`).

| Output | Dataset / service | Filters the API honours | Raw rows observed | Output rows |
|---|---|---|---|---|
| `seoul_sales.csv` | 추정매출-상권 [OA-15572](https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do) `VwsmTrdarSelngQq` | quarter only (상권 ignored) | 21,133–22,354 per quarter, 481,462 total | 88 (4 상권 × 22 q, 한식 CS100001) |
| `seoul_stores.csv` | 점포-상권 [OA-15577](https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do) `VwsmTrdarStorQq` | quarter + 상권 | ~76k per quarter; 78 per 상권-quarter | 88 |
| `seoul_flpop.csv` | 길단위인구-상권 [OA-15568](https://data.seoul.go.kr/dataList/OA-15568/S/1/datasetView.do) `VwsmTrdarFlpopQq` | quarter | 1,648–1,650 per quarter | 88 |
| `seoul_workers.csv` | 직장인구-상권 [OA-15569](https://data.seoul.go.kr/dataList/OA-15569/S/1/datasetView.do) `VwsmTrdarWrcPopltnQq` | none (quarter ignored) | 36,027 (all 22 quarters) | 88 |
| `seoul_residents.csv` | 상주인구-상권 [OA-15584](https://data.seoul.go.kr/dataList/OA-15584/S/1/datasetView.do) `VwsmTrdarRepopQq` | none | 35,908 | 88 |
| `seoul_facilities.csv` | 집객시설-상권 [OA-15580](https://data.seoul.go.kr/dataList/OA-15580/S/1/datasetView.do) `VwsmTrdarFcltyQq` | none | 34,716 | 88 |
| `seoul_trdar.csv`, `trdar_boundaries.geojson` | 영역-상권 [OA-15560](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do) shapefile | file download (POST to `datafile.seoul.go.kr`, scripted) | 1,650 polygons, EPSG:5181, file dated 2023-10-20 | 4 (GeoJSON in WGS84) |

Column names are English snake_case: `sales_amt_{total,weekday,weekend,mon..sun,t00_06..t21_24,male,female,age10..age60plus}`,
`sales_cnt_*` likewise, `stores_{total,non_franchise,franchise,opened,closed}`, `open_rate_pct`, `close_rate_pct`,
`flpop_*`, `workers_*` / `residents_*` (with `male_age20`-style splits), `households_*`, facility names
(`universities`, `subway_stations`, ...). Units per column group are in `data/processed/units.csv`.

**Pitfalls**
- `sales_amt_total` comes from `당월_매출_금액` / `THSMON_SELNG_AMT`, but it is the **quarter total**.
  Card-company estimate, scaled up.
- Age and sex splits exclude corporate cards: in 대학로 2025Q4 the age columns cover 84.8% of the total
  (`age_split_coverage` in the profile). Shares in the profile are normalised within each group.
- `stores_total` (`SIMILR_INDUTY_STOR_CO`) = `stores_non_franchise` (`STOR_CO`) + `stores_franchise`.
  The expected "160 + 31" is non-franchise + franchise = 191 total.
- No category finer than 한식 (CS100001). Pork demand is an allocation (e.g. I20107 share of stores).
- 직장, 상주, 집객 are refreshed yearly; within a year the quarters repeat the same value.
- 영역-상권 zip member names are cp949 bytes; the shapefile itself is UTF-8 (`.cpg`).

### 2. 소상공인시장진흥공단 상가(상권)정보 ([data.go.kr 15083033](https://www.data.go.kr/data/15083033/fileData.do)), 이용허락 제한 없음

- File: `소상공인시장진흥공단_상가(상권)정보_20260630.zip` (352.7 MB national zip, one UTF-8-BOM CSV per
  시도; member names are cp949). Downloaded without a key through the portal's own
  `selectFileDataDownload.do` → `fileDownload.do` endpoints. Next release announced for 2026-10-31.
- Seoul CSV: **554,092** rows. Seoul-wide I20107 = **7,834**, I20108 = 911, I20109 = 1,335.
- Processing: keep 소분류 `I201*` (all 한식), WGS84 → EPSG:5181, point-in-polygon.
- Output `stores_sbiz.csv` (**197** rows): `role` = primary (I20107) / comparison (I20108, I20109) /
  context (other I201), `franchise_flag` (지점명 non-empty), `trdar_code`, addresses, `x_5181/y_5181`.

| 상권 | I20107 (franchise_flag) | I20108 | I20109 | all I201 |
|---|---|---|---|---|
| 3120012 대학로 | **27 (6)** | 4 | 4 | 160 |
| 3110021 성균관대학교 | 1 (0) | 0 | 2 | 21 |
| 3110024 | 0 | 0 | 0 | 10 |
| 3110027 | 0 | 0 | 0 | 6 |

**Pitfalls**
- A snapshot of open stores only; closures come from 인허가.
- `franchise_flag` is a hint: 지점명 includes values like "본점", "전문점", "1호점", and chains
  without a branch name are missed.
- sbiz I201 in 대학로 (160) and the Seoul 점포 count (191) are different sources with different
  classification rules; they are not expected to agree.

### 3. 서울시 일반음식점 인허가 ([OA-16094](https://data.seoul.go.kr/dataList/OA-16094/S/1/datasetView.do)), 공공누리 1유형

- `LOCALDATA_072404` (Seoul-wide, **538,197** rows) only filters by 인허가일자 / 영업상태 / 사업장명, so the
  pipeline uses the per-구 service **`LOCALDATA_072404_JN` (종로구, 20,555 licenses)**; every row
  has `OPNSFTEAMCODE` 3000000. Status values in 종로구: 01 영업/정상 (6,627) and 03 폐업 (13,928);
  every 폐업 row has a 폐업일자.
- **Paging is unstable** (no stable sort on the server). One full page-through returns 20,555 rows
  but only ~16.3k–17.1k distinct 관리번호: duplicates come in and other rows are silently missed. The
  per-구 service ignores every filter parameter, so `fetch_converged` repeats full pulls (21 calls
  each) and unions by 관리번호 until the union reaches the API's row count. Observed 2026-10-01:
  16,740, then 19,830, 20,276, 20,482, 20,555 after 5 pulls. The first version of this pipeline
  (commit edbd5ae) used a single pull and lost ~17% of licenses; fixed in the next commit.
  The 상권분석 services were checked for the same problem: zero duplicate keys in all caches.
- Coordinates: X/Y are EPSG:5174. **5,652 of 20,555 rows (27%) have no X/Y** (1,541 of the 4,907
  licensed since 2015). Missing points are backfilled from the 소상공인 file by exact road address,
  then 지번 address (median point of the stores at that address) → `coord_source`
  = `localdata` / `sbiz_address_lookup`. After backfill, 54 post-2015 licenses remain unlocated.
- CRS check: against 11,691 licenses whose address also appears in the 소상공인 file, pyproj EPSG:5174
  gives a 5.15 m median offset and the explicit Bessel towgs84 string 5.13 m (p90 ~93 m, driven by
  address-lookup noise). The pipeline picks the smaller one on each run.
- Output `licenses.csv` (**2,232** rows inside the 4 상권, one per 관리번호; 2,061 localdata coords, 171 backfilled):
  `open_date`, `close_date`, `status`, `event` (폐업=1), `months_open` (to 폐업일자, else censored at run
  date), `closed_within_24m` (blank if open and younger than 24 months), `area_m2` (0 → blank; 25
  blank), `area_pyeong` = m² / 3.3058, `hansik` (업태 한식), `pork_name_hint`.
- 대학로 3120012: 1,782 licenses; 446 업태 한식 (174 open, 272 closed).

**Store ↔ license match** (`store_license_match.csv`, 38 rows = every primary + comparison sbiz store).
No shared ID. Candidates: same normalised road address or within 60 m. Name score (rapidfuzz, 0–100)
uses containment/ratio on the store's own name, never name+branch. Tiers:
`high` = score ≥ 80 and (same address or ≤ 20 m); `medium` = score ≥ 60 and (same address or ≤ 20 m);
`low` = score ≥ 60 within 60 m; `address_only` = an open license at the same address with a different
name (check by hand; often another business in the building); `none`.

| | high | address_only | none |
|---|---|---|---|
| 3120012 I20107 (27) | **22** | 4 | 1 |
| 3120012 comparison (8) | 6 | 2 | 0 |
| 3110021 (3) | 3 | 0 | 0 |

**Pitfalls**
- 업태 is inconsistent: among 2019–2026 licenses inside the four 상권, 업태 "기타" (cafes, 마라탕, some
  한식) outnumbers "한식" 123 to 67, so a 한식-업태 cohort undercounts 한식 openings.
- localdata.go.kr is gone (moved to data.go.kr APIs in January 2026); this Seoul mirror is the free route.

### 4. Wide survival sample (`survival_scope: wide`, decision 2.4 default, 2026-10-01)

대학로 alone has too few pork-grill closures for a stable curve, so `pipelines/survival_wide.py` (also run
by `run_all`) widens the label sample to **all of 종로구 plus 신촌역 상권 3120094**.

- Licenses: `LOCALDATA_072404_JN` (종로구, 20,555, all kept) and, for the 신촌역 polygon, which spans two
  구, `LOCALDATA_072404_SM` (서대문구, 18,317) + `LOCALDATA_072404_MP` (마포구, 29,943), kept only inside
  the polygon (3,931). Same repeat-and-union paging fix; both converged to the API row counts.
  Total **24,486** licenses (`licenses_wide.csv`).
- Stores: **362** sbiz I20107 stores (298 in 종로구, 64 in 3120094; `stores_wide_I20107.csv`), matched to
  licenses: 319 high, 11 medium, 8 low, 23 address_only, 1 none (`store_license_match_wide.csv`).
- Kaplan-Meier on licenses approved since 2015 (`survival_wide.json`, `/district` → `survival_wide`):

| Group | n | closed | S(24m) | S(60m) | median months |
|---|---|---|---|---|---|
| **pork, name keyword only** (primary: no survivor bias) | 119 | 35 | 0.859 | 0.708 | not reached |
| pork-like (name keyword or matched to a current I20107 store) | 182 | 37 | 0.908 | 0.813 | not reached |
| all 한식 (업태) | 1,915 | 709 | 0.835 | 0.645 | 104.5 |
| 한식 not pork-like | 1,772 | 681 | 0.829 | 0.631 | 100.1 |

- Log-rank, pork name-only vs other 한식: **p = 0.091** (not significant at 5%). The pork-like group's
  p = 2.2e-06 is an artefact: only open stores can be matched to I20107, so that group is survivor-biased.
  Use the name-only row when presenting.
- Caveats: name keywords (고기, 갈비, 숯불) also catch 소고기 places; 업태 drift (many recent 한식 places
  register as 기타) means "all 한식" undercounts; 종로구 includes tourist 상권 (종로3가, 인사동) with
  different survival dynamics from 대학로.

## Output: `district_profile.json`

- `trdar.{code}.quarters.{quarter}`: `hansik_sales_krw` (quarter), `hansik_sales_count`, `avg_ticket_krw`,
  `stores_total/independent/franchise/opened/closed`, `sales_per_store_month_krw` (= sales / stores_total / 3),
  `dow_share`, `timeband_share` (6 bands), `evening_share_17_24`, `lunch_share_11_14`, `weekend_share`,
  `age_share`, `sex_share`, `age_split_coverage`, `flpop_total` + age/time shares, `workers_total`,
  `residents_total`, `households_total`, `facilities` (non-zero counts).
- `trdar.{code}.annual.{year}`: sales sum, Q4 store counts, sales per store per month on Q4 stores.
- `trdar.{code}.sbiz_stores`, `.licenses`, `.store_license_match`: counts.
- `survival_scope` and `survival_wide`: see section 4 (present when the scope is wide).
- `survival`: Kaplan-Meier (lifelines 0.30.3) on licenses approved on/after 2015-01-01, at 6–120 months,
  with 95% CI, at-risk counts, median, and the share closed within 24 months.

| Cohort | n | closed | S(24m) | S(60m) | median months |
|---|---|---|---|---|---|
| all 업태, 대학로 | 349 | 110 | 0.906 | 0.676 | 110.1 |
| 한식 업태, 대학로 | 89 | 26 | 0.939 | 0.694 | 110.3 |
| 한식 업태, 대학로 + fringe | 108 | 36 | 0.900 | 0.641 | 110.3 |
| pork-like (name keyword or I20107 match), 대학로 + fringe | 12 | 3 | 0.917 | 0.917 | not reached |

The pork-like group is tiny and leans optimistic (current I20107 matches are survivors by construction);
state the N whenever it is shown.

## Spot checks (live, 2026-09-30)

| Check | Expected | Observed |
|---|---|---|
| 대학로 한식 sales, 2025 (4 quarters) | ~₩590.9억 | ₩590.9억 (59,087,346,627) |
| 대학로 한식 stores, 2025Q4 | 160 + 31 franchise | 160 + 31 (191) |
| I20107 stores inside 3120012 | ~27 | 27 (6 with 지점명) |
| Sanity: 2025 sales / Q4 stores / 12 | ~₩2,580만 | ₩2,578만 |
