# Cafe 창업 시뮬레이터: store-setup preview and month-by-month API

Python is the brain; the Unity configurator (and any web client) only renders. Code: `sim/cafe/` (pure, deterministic:
same input, same output), router `api/cafe.py` mounted in `api/main.py`. Inputs: `research/cafe/params.yaml`
(hand-curated, every value graded and sourced) and `research/cafe/districts.yaml` (generated from the cached Seoul
상권 file by `python -m sim.cafe.build_districts`; no network). Research behind every number:
`research/2026-10-13-seoul-independent-cafe-unit-economics.md` in the MCP_Agentic_AI repo.

Run: `LLM_BACKEND=mock REPORT_WARM=0 RAG_EMBEDDER=hash .venv/bin/uvicorn api.main:app --port 8630`, or
`scripts/cafe_api.sh` / `scripts/cafe_api.ps1` (installs everything; guide in `docs/CAFE-QUICKSTART.md`). Tests:
`pytest tests/test_cafe.py tests/test_cafe_season.py`.

## Grades

`H` official / primary data, `M` trade press or agreeing vendors, `L` one anecdote or our own derivation, `가정` no
source at all (a research GAP turned into an explicit constant). A block grade is its weakest input, with `가정` rolled
up as `L`; single capex lines keep `가정` so the UI can tag them.

## `GET /cafe/districts`

List of `{code, name_ko, trdar_name, context_ko, rent_per_pyeong_krw, sales_per_store_month_krw, tx_per_store_day,
ticket_krw, stores, peak_band, grade}` for 대학로 3120012, 신촌 3120094, 성수동카페거리 3110131.

## `POST /cafe/preview`

Body (422 outside these ranges):

| Field | Range | Default |
|---|---|---|
| `district` | "3120012" / "3120094" / "3110131" | required |
| `size_pyeong` | 10..40 | required |
| `tables` | 0..40 | required |
| `chairs` | 0..160 | required |
| `bar_seats` | 0..30 | 0 |
| `espresso_groups` | 1..4 (4 = two 2-group machines) | 2 |
| `showcase`, `oven` | 0/1 | 0 |
| `kiosks` | 0..3 | 0 |
| `pos` | 1..3 | 1 |
| `own_capital_krw` | >= 0 | 80,000,000 |
| `daily_customers` | 10..600, orders on the peak day | null = data default |
| `peak_day` | "weekday" / "weekend" | the district's busier day type |
| `staff_peak` | 1..8, people at the peak incl. 사장님 | null = `staff.recommended_peak` |

Response blocks (all money KRW, all lengths metres):

- `input`: the normalized request.
- `demand`: `daily_customers`, `default_daily_customers`, `source` ("data" / "user"), `peak_day`,
  `peak_orders_per_h`, `grade` (L for the data default, 가정 for a user value), `range_hint_ko`.
- `room`: `area_m2` (평 x 3.3058), `width_m`, `depth_m` (fixed aspect 1.6), `door {x (centre), z, w}`,
  `counter_zone {x, z (min corner), w, d}`, `grade`.
- `layout[]`: `{id, type, x, z, rot_deg, fits, parent, w, d}` plus `unassigned: true` on spare chairs and
  `seats_max` (2 or 4) on tables. Types: table,
  chair, bar_seat, bar_counter, espresso, grinder, showcase, oven, kiosk, pos, fridge, ice_maker, sink. `w`/`d` are the
  footprint (along x / along z before rotation); `parent` = table id for a chair, `bar_counter_1` for a bar seat.
- `space`: `used_m2`, `use_pct`, `table_slots`, `bar_capacity`, `overflow[{type, count}]`, `fix[{label_ko, patch}]`,
  `grade`. Applying a `patch` to the request clears that problem.
- `seats`: `total`, `table`, `bar`, `unassigned_chairs`, `demand_peak_seats`, `grade`.
- `throughput` (drinks per hour): `demand_peak_cups_per_h`; what the peak crew delivers: `espresso_cph`,
  `ordering_cph`, `seating_cph`, `staff_cph` (= their min); what the equipment allows with every station staffed:
  `espresso_equipment_cph`, `ordering_equipment_cph`, `seating_equipment_cph`; `note_ko`, `grade`.
- `bottleneck[]`: `{key (espresso|ordering|seating|staff), label_ko, ratio (capacity ÷ peak demand), note_ko, grade}`.
  espresso / ordering / seating use the equipment capacity; `staff` (label 인력) uses the crew's `staff_cph`. Sorted
  ascending, except that `staff` goes last unless the crew loses sales the equipment would have served (crew below
  min(peak demand, equipment)). `[0]` is what runs out first.
- `suggestion`: `{label_ko, patch, effect_ko, grade}`: the single change that relieves `bottleneck[0]`; `effect_ko` comes
  from re-running the model with the patch. `patch: {}` when nothing is left to raise. For `staff` the patch is
  `{staff_peak: n}` with n = the fewest people who cover the peak (at least one more than now).
- `capex`: `lines[{item_ko, qty, unit_krw, subtotal_krw, grade, source}]`, `total_krw`, `own_capital_krw`,
  `loan_needed_krw`, `grade`. 부가세, 보증금 and 권리금 are separate lines.
- `monthly_fixed`: `rent_krw`, `labor_krw`, `other_krw`, `total_krw`, `owner_ref_krw`,
  `lines[{item_ko, krw, in_total, grade, note_ko?}]`, `grade`, `note_ko`. The line "사장님 인건비 (참고)" has
  `in_total: false`: it is not in `total_krw` or in `rough_month.op_krw`.
- `staff`: `peak`, `base` (max / min of the schedule), `staff_peak` (the crew used), `recommended_peak`, `user_peak`
  (null unless sent), `source` ("recommended" / "user"), `stations` (people the setup can put to work at once),
  `roles {barista, cashier, floor}`, `roster[{id, role, label_ko, station_id, x, z, rot_deg, fits}]`,
  `schedule_day`, `schedule[{hour, orders, staff, need, short}]` for each opening hour of `schedule_day`,
  `short_hours`, `paid_hours_month`, `note_ko`, `grade`. Every count includes 사장님. `need` = people that hour wants;
  `short: true` = need > staff_peak (the hour runs with staff_peak and loses what they cannot serve).
  - Roster positions (same frame as `layout`): a barista stands in the work aisle behind their espresso machine
    (z = counter zone middle; a second barista on a machine 0.45 m to its left), a cashier behind their POS, floor
    people in the queue band in front of the counter (z = counter zone z − 0.6), the first at the dessert showcase
    (`station_id: "showcase_1"`, else the pickup end, `station_id: "floor"`), then 1.0 m apart to the left. All
    `rot_deg: 180` (facing the customers). `fits` copies the station's (a ghost machine gives a ghost barista).
- `rough_month`: `revenue_krw`, `op_before_depreciation_krw`, `depreciation_krw`, `op_krw`, `op_margin`,
  `card_fee_rate`, `lines[{item_ko, krw, grade, note_ko}]` (식재료비, 카드수수료, 포장재, 수선 소모품 마케팅, 월 고정비,
  감가상각), `grade: L`, `note_ko` ("빠른 추정 ..."), and `benchmark {industry_op_margin, model_op_margin,
  model_op_margin_with_owner_pay, revenue_vs_industry_avg, gap_note_ko, source, grade}`: shown for comparison, never fitted.
- `district`: `code`, `name_ko`, `context_ko`, `rent_per_pyeong_krw`, `sales_per_store_month_krw`, `peak_band`, `grade`.

## Coordinate frame and layout rules

Origin = room corner, `+x` along the front wall (window + door), `+z` into the room; front wall z = 0, back wall
z = depth. Item `x`/`z` = footprint centre. `rot_deg` = yaw about +y, clockwise seen from above, 0 = the item's front
faces +z (90 faces +x, 180 faces the window). This is Unity's Euler y.

- **Entry path**: `x >= width - 1.5` kept clear from the door (front wall, right end) to the counter.
- **Counter** (back-right): front line faces customers (POS, espresso + grinder per machine, showcase, pickup gap), back
  line against the back wall (sink, ice maker, fridge, oven). Both lines have `rot_deg: 180`: the front line faces the
  customers, the back line faces the barista aisle (its back is to the wall at z = depth). Fridge, ice maker and sink are always there. A 1.2 m queue
  band and 0.6 m side access in front of / beside it stay clear.
- **Window band**: kiosks just left of the entry path, then a bar counter with stools at 0.6 m pitch from the left
  wall. Bar seats past the wall length overflow.
- **Tables** (`sim/cafe/seating.py`): the free region (room minus window band, entry path and counter block) is a
  rectangle or an L, cut into rectangles four ways (vertical cut, horizontal cut, or either arm alone). Each rectangle
  is filled with rows along x or along z:
  - a standard band is 1.6 m deep (chair 0.45 + table 0.7 + chair 0.45); bands are 0.6 m apart chair back to chair
    back (table edges 1.5 m apart, above the 0.9~1.2 m in research §2.3); tables in a band are 0.5 m apart;
  - a 2-top takes 0.7 m of band length (chairs across the band), a 4-top 1.6 m (two more chairs at its ends);
  - a wall band (0.7 m deep, against a wall) holds 2-tops turned along the wall, 1.6 m each, 0.3 m apart;
  - bands along z that start at the front wall keep a 0.9 m cross aisle there.
  The search tries both orientations, both stacking directions, a leading or trailing wall band, guillotine splits
  (k bands one way, the leftover strip the other way). Every rectangle is
  scored once for the most tables and once for the most seats. `table_slots` = the most tables any candidate holds as
  2-tops. For a request, the candidate that seats the most of the requested chairs with every table placed wins
  (ties: more slots, then first found), and a DP decides 4-tops vs 2-tops per row. All zones are anchored to walls,
  so `table_slots` never drops as 평 grows; it rises within every 3평 and within 2평 almost everywhere.
- **Chairs**: round-robin over tables (every table gets its 1st chair, then its 2nd, ...) up to each table's
  `seats_max`; a ghost table counts as a 4-top. Chairs past every table's capacity are `unassigned` (parent null,
  fits false, placed in the ghost zone) and are not counted as `overflow`. 4-tops are chosen so plain round-robin
  holds where space allows (a table that would get a 3rd chair becomes a 4-top).
- **Overflow**: anything that does not fit gets `fits: false` and sits in a ghost zone right of the room (x > width),
  one 1.8 m cell per item, a ghost table carrying its chairs. `fix` offers the smallest 평 that fits everything, tables
  reduced to `table_slots`, bar seats reduced to `bar_capacity`, chairs reduced to what the tables can seat.
- **Space use**: `used_m2` counts each placed thing with its clearance (counter block incl. queue, entry strip, window
  band incl. aisle, each table's band share incl. its gaps), so a full room reads near 100%.

## Peak-hour capacity model

- `daily_customers` (orders on the peak day). Data default (2026-10-14, Keonhee's call, replaces the 0.55
  independent scale, L): anchor month = industry average 비알코올 음료점 sales ₩190.33M/yr ÷ 12 (농경연 2024, national,
  franchise included, M) x demand index (상권 sales per store ÷ Seoul sales per store, same quarter and file, so the
  units cancel, H; Seoul mean in districts.yaml `seoul`, ₩11.64M/month for 2026Q2). Average-day orders = anchor month ÷
  상권 ticket ÷ 91/3 days; x day factor (weekend-day or weekday-day tx ÷ average-day tx). Grade M. A user value
  replaces it.
- Peak demand (drinks/h) = daily_customers x the busiest opening hour's share (band share ÷ band hours, renormalized
  over 10~22 like the schedule) x surge 1.3 x drinks per tx 1.6. The table's raw peak-hour share is over 24h.
- Equipment capacity (every station staffed): espresso = min(machine cap by groups, baristas by groups x 45/h);
  ordering = (kiosks x 3600/48.9 s + POS x 3600/58.7 s) x drinks per tx; seating = seats ÷ dwell 1.1 h ÷ dine-in
  share 0.494 (takeout skips seats). Stations = baristas by groups + one cashier per POS + one floor person per 40
  seats (rounded up).
- People (`staff_peak`, 사장님 included). Roles in a fixed order: one barista per espresso machine; a cashier if the
  kiosks cannot take the peak's orders; one floor person if there are seats; the rest of the baristas the machines can
  use; a cashier at the POS if there is none yet (kiosks cover ordering: with seats that is the person after the
  baristas and one floor person, e.g. the 4th of 2 baristas + 1 floor); more cashiers while ordering still falls short; the rest of the floor slots; anyone left is floor. One more
  person only ever adds a role, so capacity never drops as people are added (tested).
- Crew capacity: espresso = min(machine cap, baristas x 45/h); ordering = kiosks + POS lanes with a cashier. With no
  cashier and kiosks short, a barista takes orders: that lane runs at 0.5x and the barista pulls drinks 60% of the
  time (가정). Seating loses 15% of its turnover (dirty tables, 가정) in the share of seats no floor person covers (one
  per 40 seats). `staff_cph` = the min of the three.
- Recommended crew = max(busiest hour of the peak day's schedule, fewest people whose `staff_cph` reaches min(peak
  demand, equipment)). At the default the crew never limits sales below the equipment.
- Staffing schedule (cost side), per opening hour 10~22 (가정): orders = day's customers x 상권 band share ÷ band
  hours, renormalized over opening hours. Workload = orders x 1.6 drinks x surge 1.3 ÷ 45 drinks/h + orders x 30 s
  support (+ 58.7 s order taking when there is no kiosk). Need = max(1, ceil(workload ÷ 0.7 utilization) capped at the
  stations, fewest people who cover that hour's drinks); staff = min(need, staff_peak), `short` when need is larger.
  Computed for a weekend day and a weekday (day factors applied to the average day). Fewer people cost less and lose
  sales; more people cost more.
- Labor = (Σ staff-hours − owner's 9.3 h/day slot, M) over 8 weekend + 20 weekday days x minimum wage 10,320 x
  (1 + 10.8274% employer insurance, H) x 1.2 주휴 (H by law; applying both to every paid hour is 가정). The owner's
  slot is shown separately as "사장님 인건비 (참고)" = `owner_pay_krw` 211만/month (농경연 2025 커피 전문점 대표자
  인건비, M), outside the total and OP.
- Rough month revenue = (daily_customers ÷ day factor) x 상권 ticket x 91/3 days x min(1, bottleneck ratio), which
  equals the anchor month (industry average x 상권 index) at the data default.
- Costs: 식재료비 38.9% (M); 카드수수료 at the 금융위 credit-card rate for the annual-sales band (0.40% to 3억, 1.00% to
  5억, 1.15% to 10억, 1.45% to 30억; H), applied to all sales (가정, conservative); 포장재 = takeout 50.6% (M) x drinks
  x ₩100 (M, 다나와 cup + lid + straw + sleeve); 수선 1% + 소모품 1.5% + 마케팅 2% of sales (가정); monthly fixed (rent, scheduled labor, modelled
  electricity, 관리비, 수도 가스, 통신 보험 세무); 감가상각 = equipment, furniture, interior and 전기 증설 ÷ 5 years
  straight line (M; interior life is contested). VAT, 보증금 and 권리금 are not depreciated. OP excludes owner pay.
- Electricity = (0.1 kW/평 + 0.6 kW per espresso group) x opening hours + (showcase 0.4 + fridge 0.3 + ice maker 0.4
  kW) x 24 h + oven 1.0 kW x 4 h, x ₩150/kWh (all 가정). The 20평 sample gives 1,979 kWh = ₩297k, in line with the one
  20평 anchor of about ₩300k (L).
- Benchmark: 농경연 외식업체 경영실태조사 2024, 비알코올 음료점 non-franchise operating margin 9.8% (all stores 9.1%; M).
  Not KOSIS. Whether it includes owner pay is not stated; Seoul's 2024 franchise survey (coffee 9.5%) excludes it.

Benchmark check (20평 sample config, 대학로 / 신촌 / 성수동카페거리): at the industry-average revenue of ₩190.3M/yr
(₩15.9M/month; 66 / 77 / 56 customers on the peak day) the model's OP margin is 11.0% / 18.5% / 9.5% against the 9.8%
benchmark. Margins far above it at 250/day (about 35%) come from volume: 250/day is about ₩680M/yr, 3.6x the
industry-average store, so fixed costs are spread thin. At the data defaults (since 2026-10-14 anchored to that same
industry average x the 상권 index: 대학로 1.64, 신촌 1.08, 성수동카페거리 0.84) the 20평 sample makes ₩26.0M / ₩17.2M / ₩13.4M
a month at 27.6% / 21.5% / 0.9% OP margin; before the anchor (상권 mean x 0.55) the margins were negative.

Reading the numbers: at the data default the 20평 sample sees about 23 / 15 / 11 drinks in its peak hour
(대학로 / 신촌 / 성수동카페거리), so capacity does not bind yet (seating is first at 2.4x for 대학로). `daily_customers` is the lever: 대학로 at 250/day (weekend) gives 52.5
drinks/h and seating binds on the 20평 sample; the schedule then needs 2~3 people from 11 to 21시 (2 baristas + 1 floor at the peak) and labor is ₩5.29M. Every capacity is demand-independent, so all ratios scale by the same
1/demand: the order of `bottleneck[]` is set by the store setup, and demand decides whether the top one binds.
`peak_day` defaults to the busier day type: weekend for 대학로 and 신촌, weekday for 성수동카페거리 (1.10 vs 0.75).

## Step 3 월별 운영: `/cafe/season`

Code: `sim/cafe/season.py` (pure; a run is a JSON-able dict), routes in `api/cafe.py`. A run plays 6 months (`season.months`, 원안 12개월에서 고깃집과 맞춰 2026-10-20에 줄임) of the store
from step 2. Same body + same `seed` + same month decisions = the same months, byte for byte. Events are drawn per
(seed, month, event), so a decision never changes which events happen, only what they do (the one exception: a bigger
marketing budget raises the odds of the SNS event). Runs live in the API process memory: a restart forgets them, and
past 500 runs the oldest is dropped.

### `POST /cafe/season`

Body = the `/cafe/preview` body (same fields, ranges and 422s) plus:

| Field | Range | Default |
|---|---|---|
| `own_capital_krw` | >= 0 | 80,000,000 (as in preview) |
| `seed` | 0..2147483647 | 0 |
| `start_month` | 1..12, calendar month of month 1 | `season.start_month` (3) |
| `extra_loan_krw` | 0..500,000,000, 운전자금 borrowed on top of the CAPEX gap | null = enough to open with `working_capital_months` (3) of monthly fixed costs in cash |

Starting cash = `own_capital_krw` + loan − CAPEX total, with loan = `capex.loan_needed_krw` + `extra_loan_krw`. The
default 운전자금 tops starting cash up to 3 months of `monthly_fixed.total_krw` (가정): extra = max(0, 3 x fixed −
max(0, own capital − CAPEX)), so an owner with spare capital borrows nothing extra. Send `extra_loan_krw: 0` to open
with only what is left after CAPEX (with a loan, that is 0 and the first loss-making month puts cash below zero).
The 20평 sample at the data default demand and ₩80M capital closes in month 7 with the reserve (month 2 without).

Response:

```
{season_id: "c1e642bcc78a", seed, start_month, months_total: 12, status: "open",
 start: {own_capital_krw, capex_krw, loan_krw, extra_loan_krw, working_capital_target_krw, working_capital_note_ko,
        cash_krw, vat_refund_krw, vat_refund_month},
 loan: {principal_krw, rate, term_months, monthly_payment_krw, grade, note_ko},
 baseline: {revenue_krw, op_krw, customers, walkaways, preview_revenue_krw, preview_op_krw, grade, note_ko},
 decisions: {price_change_pct: 0.0, hours: "standard", staff_policy: "standard", marketing_krw: 0, dessert: true},
 options: {price_change_pct: {min, max, level_min, level_max},
           hours: [{key, label_ko, open_hour, close_hour}] (short / standard / long),
           staff_policy: [{key, label_ko}] (lean / standard / generous),
           marketing_krw: {min, max}, dessert: [true, false]},
 assumptions: [{key, value, grade, source, note_ko}]}
```

`baseline` is a mature month (all regulars built up, season index 1.0, no event, opening decisions). It is the reference
for month 1's waterfall and for the report. It can sit below step 2's `rough_month` (`preview_op_krw`): the month model
adds dessert waste and dessert prep hours and loses customers to queues (step 2 uses `min(1, bottleneck ratio)`). With
dessert on, a showcase and no queue, both give the same revenue (tested).

### `POST /cafe/season/{id}/month`

Body (every field optional; an empty body or no body plays the month with last month's choices):

| Field | Range | Meaning |
|---|---|---|
| `price_change_pct` | -20..30 | One-time menu price change this month, compounding on the current level; the level stays in 0.7..1.5 of the opening price |
| `hours` | "short" 11~20 / "standard" 10~22 / "long" 8~23 | Kept until changed |
| `staff_policy` | "lean" / "standard" / "generous" | Kept until changed |
| `marketing_krw` | 0..5,000,000 per month | Kept until changed |
| `dessert` | true / false | Kept until changed; default true |
| `month_index` | 0-based month this request is for | Optional. A repeat of a played month with the same decisions returns that month again (a retry after a timeout); any other mismatch is 409 `{error: "month_mismatch", month_index, months_played}` |

409 `{error: "season_over", detail, months_played}` once the run is closed or all months (6) are played. 404 for an
unknown id. 422 outside the ranges.

Response (all money KRW):

```
{month: 9, calendar_month: 11, months_total: 12, status: "open" | "closed" | "finished",
 decisions: {price_change_pct, hours, staff_policy, marketing_krw, dessert, price_level, open_hour, close_hour},
 kpi: {revenue_krw, op_krw, op_margin, cash_krw, customers, walkaways, walkaway_share, ticket_krw,
       rating, rating_delta, regulars, regulars_delta, loan_payment_krw},
 kpi_grades: {revenue_krw: "L", op_krw: "L", cash_krw: "L", customers: "L", walkaways: "L",
              rating: "가정", regulars: "가정", loan_payment_krw: "가정"},
 pnl: {revenue_krw, dessert_revenue_krw, lines: [{key, item_ko, krw, grade, note_ko}],
       op_before_depreciation_krw, depreciation_krw, op_krw, grade},
 cash: {start_krw, op_krw, depreciation_addback_krw, loan_interest_krw, loan_principal_krw, vat_refund_krw,
        end_krw, loan_balance_krw, negative_months, grade},
 drivers: {season_index, maturity, rating_mult, price_mult, hours_coverage, marketing_lift, rival_mult, viral_mult,
           satisfaction, bottleneck ("espresso" | "ordering" | "seating"), bottleneck_label_ko, peak_util, grade},
 events: [{key ("rival" | "rent_hike" | "breakdown" | "viral"), label_ko, p, effect_ko, grade, source}],
 waterfall: {vs: "baseline" (month 1) | "prev_month", from_op_krw, to_op_krw,
             steps: [{key, label_ko, krw}] (11 steps, always in the same order), grade, note_ko},
 owner_note_ko: "줄이 길어서 손님 700명이 그냥 돌아갔어요, 좌석 쪽이 모자라요",
 closure: {closed, reason_ko}}
```

- `pnl.lines[].key`: `food` 식재료비, `card` 카드수수료, `packaging` 포장재, `shares` 수선 소모품 기본 마케팅,
  `marketing` 추가 마케팅, `dessert_waste` 디저트 폐기, `rent` 임대료, `labor` 인건비, `utilities` 전기 관리비 수도 통신,
  `repair` 설비 수리. Lines that do not apply this month are 0, never missing.
- `waterfall.steps[].key` in order: `season`, `reputation` (rating + regulars), `price`, `hours`, `staff`, `marketing`,
  `dessert`, `rival`, `viral`, `breakdown`, `rent`. Each step switches that factor from the reference month to this
  month and re-runs the month, so the steps add up exactly to `to_op_krw − from_op_krw`. The order matters a little
  (an interaction lands on the later step); it is fixed so months compare.
- Against the baseline (month 1's waterfall, the report's `drivers`) the `reputation` step is labelled
  "개업 초기 효과 (별점, 단골)" and carries `note_ko`: the baseline is a settled store, so a new store's ramp shows as a
  loss that shrinks as regulars build. Month over month the same step is "별점과 단골" and is positive while regulars
  grow (tested). Month 1's `owner_note_ko` says it compares with a settled store.
- Korean text: every amount of 1만원 or more in a `*_ko` string is written with 만/억 (`sim/cafe/ko.py` `won()`:
  9,772원, 1만 320원, 41만원, 1억 6,759만원; 10만 and up round to 만). Numeric fields stay raw KRW. Tested over preview,
  season and report text.
- `kpi.cash_krw` = `cash.end_krw`. `kpi.op_krw` is after depreciation and before loan interest, as in step 2. Owner
  pay is not a cost (see step 2) and no living-cost draw leaves the business.
- `rating` and `regulars` are the end-of-month values; the month itself was played with last month's.

### `GET /cafe/season/{id}/report`

```
{season_id, months_played, months_total, status, survived, closed_month,
 cumulative_op_krw, cumulative_revenue_krw, end_cash_krw,
 best_month: {month, calendar_month, op_krw}, worst_month: {...},
 baseline, baseline_cumulative_op_krw,
 drivers: [{key, label_ko, krw}] (sorted by |krw|; sums to cumulative_op_krw − baseline_cumulative_op_krw),
 events: [{month, key, label_ko, p, effect_ko, grade, source}],
 months: [{month, calendar_month, revenue_krw, op_krw, cash_krw, customers, walkaways, rating, regulars}],
 summary_ko, grade}
```

Works mid-season too (`status: "open"`). `drivers` is every month's waterfall against the baseline, summed.

### Stateless seasons: `state_token` (web, serverless)

A season is its start body plus the decisions sent so far, and the model is deterministic, so every call can rebuild
it. `POST /cafe/season` also returns `state_token`; the web client keeps only that string.

- `POST /cafe/season/month` body = the month body above + `state_token`. Returns the month + the next `state_token`.
  `month_index` works the same way (a retry with the old or the new token returns the played month and the same token).
- `POST /cafe/season/report` body `{state_token}`. Same report as `GET /cafe/season/{id}/report` with `season_id: null`.
- Token = base64url(zlib(JSON `{v: 1, pv, b, d}`)) + "." + base64url(HMAC-SHA256 truncated to 16 bytes). `b` = the
  start body, `d` = the decision bodies sent, `pv` = hash of params.yaml + districts.yaml. About 300 characters at the
  start and after the last month. Not encrypted: it carries only the store setup and decisions.
- Key: env `CAFE_TOKEN_KEY` (a dev default otherwise; set a real one on any deployment). A token that fails the
  signature, the shape or decoding is 400 `{error: "bad_state_token"}`; a token made before the model inputs changed is
  409 `{error: "model_changed"}` (start a new season).
- Cost: month n replays n−1 months. Measured on an M-series Mac through the API: 11 ms for month 1 up to 72 ms for
  month 12 (0.48 s for all 12 calls); the report is 68 ms.
- The `season_id` endpoints keep the same `{v, pv, b, d}` state in process memory and replay it the same way; their
  month responses also carry `state_token`, so a desktop client can switch over.

### Hosted web build (`api/cafe_app.py`, `scripts/build_cafe_web.sh`)

- `api/cafe_app.py`: FastAPI with only the cafe router, under `/api/cafe/...`, plus `GET /api/health` (`{ok,
  model_version, token_key: "env" | "dev default"}`). No DB, RAG or LLM import; imports in about 0.3 s. The desktop
  app keeps `api.main` and `/cafe/...` unchanged. `CAFE_CORS_ORIGINS` only for a dev split-origin setup.
- `requirements-cafe-web.txt`: fastapi, pydantic, PyYAML (no numpy needed). Installed: 12 distributions, 10 MB.
- `bash scripts/build_cafe_web.sh` writes `deploy/cafe-web/` (gitignored): `api/index.py` (the one Python function,
  exports `app`), `cafe_api/` (copies of api/cafe.py and api/cafe_app.py, kept out of `api/` so Vercel makes no extra
  functions), `sim/cafe/`, `research/cafe/`, `requirements.txt`, `.python-version` (3.12), `vercel.json` and
  `public/`. `public/` is copied from `engines/cafe-unity/CafeUnity/Build/WebGL` (or `WEBGL_DIR`) when it has an
  `index.html`; otherwise a placeholder page. The Unity WebGL client calls the same origin: `/api/cafe/...`.
- `vercel.json`: `/api/(.*)` rewritten to `/api/index` (FastAPI routes on the original path), static output from
  `public/`, `Cache-Control` no-store for the API, must-revalidate for `/` and `index.html`, 1 h for `Build/`, 1 day
  for `TemplateData/`.
- Local check (what was run): `cd deploy/cafe-web && uvicorn api.index:app --port 8633` with a venv from its
  requirements.txt, `python -m http.server 8634 --directory public`; districts, preview, a 12-month token season,
  the 13th month (409), the report and a tampered token (400) all answered as expected. Never deployed from here.

### Month model

- **Demand.** Average-day orders from step 2 (`avg_day_customers`) x season index (quarter, H) x maturity x rating
  multiplier x price^(−elasticity) x (1 + marketing lift) x rival x viral x hours coverage. Maturity = 0.7 + 0.3 x
  regulars index; the index starts at 0 and moves 15%/month (more with marketing) toward a target set by satisfaction.
- **Hours coverage.** Hours outside the opening hours lose their 상권 share of the day, except `hours_shift_share` of it
  that shifts into open hours; relative to the standard 10~22 (= 1.0).
- **Walk-aways.** For a weekend and a weekday, each opening hour's drinks (with the in-hour surge) meet the binding
  capacity from step 2 for that hour's people (the day schedule, capped at `staff_peak`; lean staffing adds nobody to
  cover a rush). Above capacity the excess is lost; on
  top, a logistic share balks at the queue (max 10% from Lu et al. 2013 at long queues; midpoint at 95% utilization;
  x1.5 lean, x0.5 generous). Customers = served orders; walk-aways = demand − served.
- **Ticket.** 상권 ticket with desserts at their 18.5% share (M); without desserts the drink ticket only; without a
  showcase desserts sell half. x price level.
- **Costs.** Food at cost per unit sold (a price rise does not raise it): drinks at the share that keeps the blend at
  38.9%, desserts at 40% (L). Card, packaging, the % lines and fixed costs as step 2. Labor = step 2's schedule for
  this month's demand, with the chosen hours and the staff policy's utilization (lean 0.85, standard 0.7, generous
  0.55; lean adds nobody to cover a rush), capped at `staff_peak` (사장님 included), owner's 10 h unpaid, plus 2 h/day dessert prep. Electricity scales with opening hours. Dessert waste 10% of
  dessert sales + ₩300k minimum spoilage.
- **Satisfaction** = −3 x walk-away share − 1 x (price level − 1) + staff (lean −0.05, generous +0.1) + dessert 0.05
  − breakdown 0.1. Rating moves 35%/month toward 4.0 + 0.8 x satisfaction (3.0..4.9); regulars toward 1 + satisfaction
  (0.3..1.3).
- **Events** (each at most what is listed): rival nearby, once, monthly p = 1 − exp(−상권 opens per year x 0.1 ÷ 12)
  (대학로 8.8%, 신촌 11.8%, 성수동카페거리 5.7%): customers x0.92 and elasticity +0.3 for the rest of the season. Rent hike,
  once, p 3%: +5% (법정 상한, H). Breakdown, p 3%: ₩800k repair and 2 days closed. Viral SNS post, p 3% (about 8.5% at
  ₩5M marketing): customers x1.3 this month, x1.1 the next.
- **Cash.** End = start + OP + depreciation − loan interest − principal + VAT refund. Loan: 4.5% (가정; the research
  file has no 정책자금 rate), 60-month equal payments, no grace period. The CAPEX VAT comes back in month 2 (조기환급;
  timing 가정). 보증금 stays locked; 권리금 is sunk. No income tax.
- **Closure.** Cash below zero at the end of 2 months in a row closes the store; the month that closes it has
  `status: "closed"` and later months are 409.

What each decision costs (12-month OP against keeping the defaults, `tests/test_cafe_season.py`
`test_no_single_decision_dominates`): every lever loses money in at least one of 7 scenarios, and every lever except a
₩3M/month marketing budget also wins in one. Price up pays when queues bind and costs regulars when they do not; a
price cut pays only after a rival opens at low demand; short hours pay at low demand; long hours, when capacity is
spare in the shoulders; lean staff saves at mid-high demand and loses customers when capacity binds; generous staff
helps when queues bind, or when the store is so quiet that one person covers every hour anyway; ₩1M marketing pays at 120~250/day; no dessert pays at low demand (waste and prep exceed the
dessert margin).

## Assumptions table (generated from research/cafe/params.yaml)

| Section | Key | Value | Grade | Source / note |
|---|---|---|---|---|
| demand | `cups_per_tx` | 1.6 | M | 서울 카페 결제 1건 금액 7,987원 (서울시 상권분석서비스 2025, H) × 음료 몫 (1 − 18.5%) ÷ 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 표85 커피 전문점 대표메뉴 '커피' 평균 4,118원 (n=530) = 1.58잔; 결제 1건을 커피 한 잔 값으로 나눈 대리 계산. 커피 전문점 평균 객단가 5,703.6원 (표67, 1인당)으로 나누면 결제 1건 1.4명이라 1.4~1.6잔. 전국 가격으로 서울 결제를 나눠서 서울에서는 조금 높게 나올 수 있음 |
| demand | `peak_surge` | 1.3 | 가정 | none; 피크 시간 안에서도 15~30분 몰림, 시간 평균 대비 배수 |
| demand | `dine_in_share` | 0.494 | M | 오픈서베이 카페 트렌드 2023 p.11 매장 49.4% / 테이크아웃 50.6% (지출 기준), research §1.5 |
| demand | `dwell_h` | 1.1 | M | 프랜차이즈 카페 이용자 500명 조사 (식품외식경제 2012-06-11, thinkfood.co.kr 48662): 1회 이용시간 30분~1시간 44.6%, 1~2시간 35.8%; 한국소비문화학회 2013 학술대회 (n=1,030): 사회적·개인적 목적 100여 분, 구매 목적 34분; 구간 가운데값으로 (0.75 × 44.6 + 1.5 × 35.8) ÷ 80.4 = 1.08시간. 오래된 자기응답 조사라 M, 실측 체류시간은 없음 |
| demand | `persons_per_cup` | 1.0 | 가정 | none; 매장 이용 1인당 음료 1잔 |
| capacity | `machine_cph_by_groups` | 1: 30, 2: 60, 3: 95, 4: 120 | L | research §2.1 sim suggestion (1G 30, 2G 60, 3G 95; vendors and forum) |
| capacity | `baristas_by_groups` | 1: 1, 2: 2, 3: 2, 4: 3 | 가정 | none; 그룹 수별 피크 바리스타 수 |
| capacity | `barista_cph` | 45 | M | Scott Rao 매장 2명이 라테 시간당 100잔 (Decent Espresso 블로그, 바리스타 1명 10분 8잔 = 48잔); World Barista Championship 15분에 12잔 = 48잔; Starbucks 음료 한 잔 30초~1분 (Seattle Met 2010); 세 출처가 시간당 45~50잔 근처에서 맞음. 모두 해외 자료라 M |
| capacity | `kiosk_order_s` | 48.9 | M | Torres 2019 UNT thesis, kiosk 평균 주문시간, research §2.2 |
| capacity | `cashier_order_s` | 58.7 | M | Torres 2019 UNT thesis, cashier 평균 주문시간, research §2.2 |
| capacity | `floor_staff_seat_threshold` | 40 | 가정 | none; 홀 직원 한 명이 치울 수 있는 좌석 수 (홀 자리 = 좌석 ÷ 이 값, 올림) |
| capacity | `staff_peak_range` | [1, 8] | 가정 | none; 피크 인원 입력 범위, 사장님 포함 |
| capacity | `barista_on_pos_order_factor` | 0.5 | 가정 | none; 계산 담당이 없어 바리스타가 주문을 받을 때 POS 처리 속도 배수 |
| capacity | `barista_on_pos_drink_share` | 0.6 | 가정 | none; 그 바리스타가 음료에 쓰는 시간 비율 |
| capacity | `dirty_table_block_share` | 0.15 | 가정 | none; 치우지 않은 테이블 때문에 못 쓰는 좌석 회전 비율 (홀 인원이 맡지 못한 좌석 몫만큼) |
| opex | `min_wage` | 10320 | H | 고용노동부 고시 제2025-47호 2026 최저임금, research §4 |
| opex | `employer_insurance` | 0.108274 | H | 2026 사업주 요율: 국민연금 4.75% (nps.or.kr), 건강 3.595%와 장기요양 0.4724% (edi.nhis.or.kr), 고용 0.9% + 0.25% (고용보험법 시행령 제12조), 산재 0.8% + 출퇴근 0.06% (고용노동부고시 제2025-91호); 합 10.8274%, ChangeUp params.json hourly_cost와 같은 값. 모든 유급 시간에 붙인 것은 가정 (월 60시간 미만은 국민연금·건강보험 제외, 두루누리 지원 미반영). 이전 값 0.112 (블로그 값) |
| opex | `weekly_holiday_factor` | 1.2 | H | 근로기준법 제55조, 시행령 제30조: 주 40시간 기준 48 ÷ 40; 주 15시간 이상 근무자 기준. 모든 유급 시간에 붙인 것은 가정 (주 15시간 미만은 주휴 없음) |
| opex | `open_hour` | 10 | 가정 | research §2.3 손익분기 계산의 12h/일 가정; 10시 오픈 |
| opex | `close_hour` | 22 | 가정 | research §2.3 손익분기 계산의 12h/일 가정; 22시 마감, 영업시간 밖 수요는 영업시간 비중대로 재배분 |
| opex | `days_per_month` | 28 | 가정 | research §2.3 손익분기 계산의 28일 가정; 주말 8일 + 주중 20일 |
| opex | `owner_hours_per_day` | 9.3 | M | 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 표120 근로형태별 근로시간, 상용근로자(대표자 포함) 커피 전문점 하루 9.3시간, https://www.mafra.go.kr/bbs/home/798/595247/download.do; 사장만의 시간은 조사에 없어 대표자를 포함한 상용근로자 평균으로 대신함 (대리 지표). 같은 조사 표124 근로일수 26.3일. 가장 바쁜 시간부터 맡음. 이전 값 10시간 (가정) |
| opex | `owner_pay_krw` | 2110000 | M | 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 표102 대표자 인건비, 커피 전문점 평균 연 2,533.1만원, https://www.mafra.go.kr/bbs/home/798/595247/download.do; 2,533.1 ÷ 12 = 211만원, 사장이 스스로에게 준다고 답한 값 (전국, 프랜차이즈 포함). 같은 조사에서 영업이익 1,748.8만원은 이 인건비를 뺀 뒤의 값이라 두 번 세지 않음. 서울권(전 업종)은 4,241.2만원이라 서울 카페에는 낮게 잡힌 값일 수 있음. 이전 값 289만원은 하루 10시간 × 28일 × 최저임금 사장님 인건비 (참고) 줄에 쓰고 합계와 영업이익에는 넣지 않음 |
| opex | `staff_utilization` | 0.7 | 가정 | none; 한 사람이 음료와 응대에 쓸 수 있는 시간 비율, 나머지는 설거지 정리 휴식 |
| opex | `support_s_per_order` | 30 | 가정 | none; 주문 1건당 픽업 안내, 테이블 정리, 디저트 담기 |
| opex | `electricity_anchor_20py_krw` | 300000 | L | 세계일보 2024-08-10 20평 카페 월 약 30만원 (폭염 달 57만원), research §4; 아래 kW 가정의 검산용, 계산에는 직접 쓰지 않음 |
| opex | `electricity_krw_per_kwh` | 150 | 가정 | none; 일반용 요금 + 기본료를 kWh당으로 뭉뚱그린 값 |
| opex | `base_kw_per_pyeong` | 0.1 | 가정 | none; 조명 냉난방, 영업시간 동안 |
| opex | `espresso_kw_per_group` | 0.6 | 가정 | none; 보일러 유지 평균, 영업시간 동안 |
| opex | `oven_kw` | 1.0 | 가정 | none; 하루 4시간 가동 |
| opex | `oven_hours` | 4 | 가정 | none |
| opex | `showcase_kw` | 0.4 | 가정 | none; 24시간 |
| opex | `fridge_kw` | 0.3 | 가정 | none; 24시간 |
| opex | `ice_maker_kw` | 0.4 | 가정 | none; 24시간 |
| opex | `maintenance_per_m2` | 1409 | M | 배라 rent workstream 서울 1층 관리비 중앙값 ₩1,409/㎡, research §4 |
| opex | `misc_krw` | 400000 | 가정 | none; 통신, 보험, 세무, 소모품 |
| opex | `water_gas_krw` | 100000 | 가정 | GAP (research §7-7) |
| opex | `food_cost_share` | 0.389 | M | 농경연 2024 비알코올 음료점 식재료비 38.9%, research §4 |
| opex | `card_fee_bands` | [[300000000, 0.004], [500000000, 0.01], [1000000000, 0.0115], [3000000000, 0.0145]] | H | 금융위원회 우대수수료율 2025-02-14 시행 (H2 2026 유지), 신용카드 연매출 3억 이하 0.40%, 3~5억 1.00%, 5~10억 1.15%, 10~30억 1.45%, research §4 |
| opex | `card_share` | 1.0 | 가정 | none; 전 매출에 신용카드 요율 적용, 체크카드(0.15~1.15%)와 현금은 더 낮아 보수적 |
| opex | `takeout_share` | 0.506 | M | 오픈서베이 카페 트렌드 2023 테이크아웃 50.6% (지출 기준), research §1.5 |
| opex | `packaging_per_takeout_cup` | 125 | M | 배민상회 쿠폰가 개당 (2026-10-21 조회, S98): 아이스 한 잔 = 컵 44 + 뚜껑 17 + 빨대 5 + 홀더 29 + 1구 캐리어 35 = 130원, 뜨거운 한 잔 = 컵 34 + 뚜껑 23 + 홀더 29 + 캐리어 35 = 121원, 평균 약 125원. 다나와 최저가 (2026-10-14)는 96원·88원 |
| opex | `repairs_share` | 0.01 | 가정 | none; 수선유지비, 매출 대비 |
| opex | `supplies_share` | 0.015 | 가정 | none; 냅킨 세제 등 소모품, 매출 대비 |
| opex | `marketing_share` | 0.02 | 가정 | none; 광고 판촉, 매출 대비 |
| opex | `depreciation_years_equipment` | 5 | M | 법인세법 시행규칙 별표5 기구 및 비품 기준내용연수 5년, research §3.3 |
| opex | `depreciation_years_interior` | 5 | M | research §3.3: 비품 시설장치로 보면 5년, 세무서가 건물 부속설비로 보면 더 길어짐 (다툼 있음) |
| opex | `depreciation_years_furniture` | 5 | M | 법인세법 시행규칙 별표5 기구 및 비품 기준내용연수 5년, research §3.3 |
| opex | `industry_avg_sales_krw` | 190330000 | M | 농경연 외식업체 경영실태조사 2024 비알코올 음료점 점포당 연매출 ₩190.33M via 이투데이 2026-08-11, research §1.4; 수요 기준점: ÷ 12 x 상권 매출 지수 = 기본 월매출 (M), 벤치마크 마진이 나온 매출 규모이기도 함 |
| opex | `industry_op_margin` | 0.098 | M | 농경연 외식업체 경영실태조사 2024 비알코올 음료점 비프랜차이즈 영업이익률 9.8% (전체 9.1%) via 이투데이 2026-08-11, research §1.4; 사장님 인건비 포함 여부는 기사에 없음. 서울시 2024 프랜차이즈 실태조사 커피 9.5%는 사장님 인건비 제외 |
| capex | `espresso_1g` | 3500000 | M | 다나와 1그룹 중간대 ₩3.1~4.3M, research §3.1 |
| capex | `espresso_2g` | 6000000 | M | 다나와 2그룹 중간대 ₩5.1~7.9M, research §3.1 |
| capex | `espresso_3g` | 11000000 | M | 다나와 3그룹 중간대 ₩9.1~13.2M, research §3.1 |
| capex | `grinder` | 2500000 | M | 다나와 Mahlkönig E65S ₩2.48~2.65M, research §3.1 |
| capex | `showcase` | 1400000 | M | 다나와 케이크 쇼케이스 900~1200mm ₩1.2~1.74M, research §3.1 |
| capex | `oven` | 2000000 | M | 다나와 Unox 3~4단 ₩1.82~2.28M, research §3.1 |
| capex | `kiosk` | 1700000 | M | 다나와 카드 전용 21인치 ₩1.6~1.76M, research §3.1; 스마트상점 보조금(50%) 미반영 |
| capex | `pos` | 390000 | M | 다나와 검색 (2026-10-14 조회) '포스기': 오케이포스 ZED-2 48만, 이지체크 TS-194N 29.2만, 이지체크 EK-192 25만, 이지체크 EK192 63.8만; POS 본체 4개 목록의 중앙값 38.6만원. VAN 계약 시 무상인 경우가 많아 높게 잡힌 값일 수 있음. 이전 값 30만원 (가정) |
| capex | `ice_maker` | 1200000 | M | 다나와 50~110kg ₩0.86~1.5M, research §3.1 |
| capex | `fridge` | 1150000 | M | 다나와 검색 (2026-10-14 조회) '업소용 냉장고 25박스' 냉장전용 6개: 키스템 KIS-PD25R 75만, 그랜드우성 CWSM-630R 80.1만, 스타리온 SR-E25BAR 87.5만, 라셀르 LS-515R 143만, 스타리온 SRS-B25ESI 159만, 삼성 CRF-0620 169만; 중앙값 115만원. 카운터 줄에 0.7m 폭으로 놓이는 25박스 기준 (45박스 중앙값은 약 174만원, 테이블냉장고 14개 중앙값은 약 89만원). 이전 값 150만원 (가정) |
| capex | `sink` | 190000 | M | 다나와 검색 (2026-10-14 조회) '업소용 싱크대 2조' 상위 12개 목록: 8.4만~27.4만원; 12개 중앙값 18.8만원. 배관 설치비는 빠짐. 이전 값 40만원 (가정) |
| capex | `table` | 60000 | M | 다나와 검색 (2026-10-14 조회) '카페 테이블 2인' 2인 테이블 8개: 2.99만~16.9만원 (위드퍼니처 700×600 4.8만, 더조아 마블 6.49만 등); 4인 1200×700 6.9만~7.8만원; 2인 중앙값 5.6만원, 4인 약 7만원이라 둘을 합쳐 6만원. 가정용과 겸하는 상품이 많아 업소용 제작 테이블보다 쌈. 이전 값 15만원 (가정) |
| capex | `chair` | 50000 | M | 다나와 검색 (2026-10-14 조회) '업소용 의자', '업소용 카페의자': 3.58만, 4.08만(체어센스 기원), 4.19만(체어센스 비앙카), 5.15만(베노띠), 8.8만, 9.77만(인터데코 HW136); 중앙값 약 4.7만원을 5만원으로 둠. 광고 목록이 섞여 있음. 이전 값 6만원 (가정) |
| capex | `bar_seat` | 50000 | M | 다나와 검색 (2026-10-14 조회) '바스툴' 바 의자 10개: 1.78만(이케아 STIG)~19.8만(이케아 JANINGE); 중앙값 4.95만원. 가정용 등급이 많음. 이전 값 8만원 (가정) |
| capex | `bar_counter_per_m` | 300000 | 가정 | none |
| capex | `interior_per_pyeong` | 2090000 | M | 공정위 가맹사업 정보공개서 (franchise.ftc.go.kr) 커피 16개 브랜드의 3.3㎡당 인테리어 비용 중앙값 209만원 (2026-10-14 조회); 브랜드별 3.3㎡당 만원: 감성커피 143.8, 메가엠지씨 165, 빽다방 167.2, 더벤티 176, 투썸 192.2, 엔제리너스 198, 할리스 200, 이디야 209, 커피베이 209, 탐앤탐스 220, 요거프레소 220, 텐퍼센트 242, 파스쿠찌 247.5, 컴포즈 291.5, 매머드 295.6, 하삼동 297. 프랜차이즈 값을 개인카페에 쓴 대리 지표이고 철거·전기·설비는 빠진 경우가 많음. 교차 확인: 농경연 2025 표32 커피 전문점 인테리어 평균 4,295.2만원 ÷ 표12 평균 면적 78.9㎡(23.9평) = 180만원/평. 이전 값 250만원 (업체 블로그) 슬라이더로 바꿀 가정 |
| capex | `electrical` | 2000000 | L | research §3.2 전기 증설 ₩1.5~3M |
| capex | `vat_rate` | 0.1 | H | 부가가치세법 10%, 인테리어와 설비에 선지급 후 환급, research §3.2 |
| layout | `aspect` | 1.6 | 가정 | none; 가로 ÷ 세로, 출입문은 앞쪽 긴 벽 |
| layout | `wall_margin` | 0.05 | 가정 | none |
| layout | `door_w` | 0.9 | 가정 | none |
| layout | `entry_w` | 1.5 | 가정 | none; 출입문에서 카운터까지 비워 두는 통로 폭 |
| layout | `table_w` | 0.7 | 가정 | none |
| layout | `chair_zone` | 0.45 | 가정 | none; 테이블 가장자리에서 의자 뒤까지, 줄 폭 = 0.45 + 0.7 + 0.45 |
| layout | `row_gap` | 0.6 | 가정 | none; 테이블 줄 사이 의자 등과 등 간격, 테이블 끝끼리는 1.5m라 AJD 가이드 90~120cm(research §2.3) 이상 |
| layout | `table_gap` | 0.5 | 가정 | none; 같은 줄 안 테이블 사이 |
| layout | `wall_table_gap` | 0.3 | 가정 | none; 벽붙이 2인 테이블 사이 의자 등과 등 간격 |
| layout | `aisle` | 0.9 | L | AJD 인테리어 가이드 테이블 간격 90~120cm, research §2.3; 주 통로 (창가 바 뒤, 앞벽에서 시작하는 세로 줄 앞) |
| layout | `max_chairs_per_table` | 4 | 가정 | none |
| layout | `bar_pitch` | 0.6 | 가정 | none; 바 좌석 간격 |
| layout | `bar_counter_d` | 0.45 | 가정 | none |
| layout | `bar_band_d` | 1.05 | 가정 | none; 창가 바 테이블 + 스툴 깊이 |
| layout | `kiosk_w` | 0.7 | 가정 | none |
| layout | `counter_d` | 2.2 | 가정 | none; 뒤쪽 설비 0.65 + 작업 통로 0.9 + 앞 카운터 0.65 |
| layout | `counter_line_d` | 0.65 | 가정 | none |
| layout | `counter_side_access` | 0.6 | 가정 | none; 카운터 안쪽 출입 공간 |
| layout | `queue_d` | 1.2 | 가정 | none; 주문 대기 줄과 픽업 공간 |
| layout | `item_w` | espresso_1: 0.55, espresso_2: 0.8, espresso_3: 1.05, grinder: 0.3, showcase: 1.0, pos: 0.5, pickup: 0.5, oven: 0.7, fridge: 0.7, ice_maker: 0.55, sink: 0.6 | 가정 | none |
| layout | `staff_floor_gap` | 1.0 | 가정 | none; 홀 직원이 카운터 앞 대기 줄 구역에 서는 간격, 직원 위치 표시용 |
| layout | `ghost_cell` | 1.8 | 가정 | none; 공간 부족 항목을 방 밖에 늘어놓는 칸 크기 |
| district 3120012 대학로 | `stores` | 122 | H | VwsmTrdarStorQq 20262 (83 개인 + 39 프랜차이즈), research §0 |
| district 3120012 대학로 | `rent_per_pyeong_krw` | 198348 | H | R-ONE 소규모상가 1층 환산임대료 2026Q2 혜화동 60.0천원/㎡ x 3.3058, research §4 |
| district 3120012 대학로 | `deposit_per_pyeong_krw` | 3081000 | M | 서울시 「2023년 서울시 상가임대차 실태조사」 상권별 1층 보증금/㎡ 혜화역 93.21만원 x 3.3058 (S99); 2023년 1층 상가 1:1 면접 조사 |
| district 3120012 대학로 | `key_money_krw` | 45200000 | M | 배라 rent model 혜화역 권리금 prior 중앙값, research §3.3 |
| district 3120094 신촌 | `stores` | 144 | H | VwsmTrdarStorQq 20262 (110 개인 + 34 프랜차이즈), research §0 |
| district 3120094 신촌 | `rent_per_pyeong_krw` | 134877 | H | R-ONE 소규모상가 1층 환산임대료 2026Q2 신촌/이대 40.8천원/㎡ x 3.3058, research §4 |
| district 3120094 신촌 | `deposit_per_pyeong_krw` | 2956000 | M | 서울시 「2023년 서울시 상가임대차 실태조사」 상권별 1층 보증금/㎡ 신촌역(신촌로터리) 89.41만원 x 3.3058 (S99); 2023년 1층 상가 1:1 면접 조사 |
| district 3120094 신촌 | `key_money_krw` | 39900000 | M | 한국부동산원 상업용부동산 임대동향 권리금 조사 2025, 서울 숙박·음식점업 중앙값 3,990만원 (R-ONE). 교차 확인: 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 표22 사업장 임차권리금, 커피 전문점 평균 3,828.6만원 (권리금을 낸 102곳); 두 공식 자료가 4% 안에서 맞음. 업종은 숙박·음식점 전체(R-ONE)이거나 지역이 전국(농경연)이라 M, 입지별 값 없음 |
| district 3110131 성수동카페거리 | `stores` | 51 | H | VwsmTrdarStorQq 20262 (43 개인 + 8 프랜차이즈), research §1.2 |
| district 3110131 성수동카페거리 | `rent_per_pyeong_krw` | 214877 | H | R-ONE 소규모상가 1층 환산임대료 2026Q2 뚝섬 65.0천원/㎡ x 3.3058, research §4 |
| district 3110131 성수동카페거리 | `deposit_per_pyeong_krw` | 2097000 | M | 서울시 「2023년 서울시 상가임대차 실태조사」 상권별 1층 보증금/㎡ 성수동 카페거리 63.44만원 x 3.3058 (S99); 2023년 1층 상가 1:1 면접 조사 |
| district 3110131 성수동카페거리 | `key_money_krw` | 39900000 | M | 한국부동산원 상업용부동산 임대동향 권리금 조사 2025, 서울 숙박·음식점업 중앙값 3,990만원 (R-ONE). 교차 확인: 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 표22 사업장 임차권리금, 커피 전문점 평균 3,828.6만원 (권리금을 낸 102곳); 두 공식 자료가 4% 안에서 맞음. 업종은 숙박·음식점 전체(R-ONE)이거나 지역이 전국(농경연)이라 M, 입지별 값 없음 |

| season | `months` | 6 | 가정 | none; 한 시즌 = 6개월 (고깃집 시즌과 맞춤, 2026-10-20 결정). 원안은 12개월 |
| season | `start_month` | 3 | 가정 | none; 기본 오픈 달 3월 (대학가 개강), 요청에서 바꿀 수 있음 |
| season | `seasonality_by_quarter` | 1: 0.92, 2: 1.02, 3: 1.07, 4: 1.0 | H | 서울 상권 커피-음료 분기 매출 2025 Q1 6,325억 Q2 7,046 Q3 7,347 Q4 6,864 ÷ 2025 평균 6,896억, research §1.3; 분기 지수에 `month_in_quarter`를 곱한다 |
| season | `month_in_quarter` | 1: 0.953, 2: 0.996, 3: 1.051, 4: 0.969, 5: 1.009, 6: 1.022, 7: 0.996, 8: 1.014, 9: 0.989, 10: 1.022, 11: 0.975, 12: 1.003 | M | S96 통계청 서비스업생산지수 커피 등 비알코올 음료점업 (KOSIS DT_1KC2020 I5622) 불변지수, 하루당, 2023~2025 평균; 분기 평균 1, 전국 값이라 대학가 방학은 없다 |
| season | `launch_share` | 0.7 | 가정 | none; 새 매장은 성숙 매장 손님의 70%에서 시작, 단골이 쌓이며 100%로 다가감 |
| season | `regulars_speed` | 0.15 | 가정 | none; 단골 지수가 목표값에 다가가는 한 달 비율 |
| season | `regulars_speed_marketing` | 0.15 | 가정 | none; 마케팅 효과가 최대일 때 더해지는 속도 |
| season | `regulars_target_per_satisfaction` | 1.0 | 가정 | none; 단골 목표 = 1 + 만족도 x 이 값 |
| season | `regulars_target_range` | [0.3, 1.3] | 가정 | none |
| season | `regular_share` | 0.3 | 가정 | none; 성숙 매장 주문 중 단골 몫 |
| season | `regular_visits_per_month` | 6 | 가정 | none; 단골 한 명이 한 달에 오는 횟수, 단골 수 표시용 |
| season | `rating_start` | 4.0 | 가정 | none; 오픈 때 별점 |
| season | `rating_range` | [3.0, 4.9] | 가정 | none |
| season | `rating_speed` | 0.35 | 가정 | none; 별점이 목표값에 다가가는 한 달 비율 |
| season | `rating_per_satisfaction` | 0.8 | 가정 | none; 별점 목표 = 시작 별점 + 만족도 x 이 값 |
| season | `rating_demand_per_star` | 0.15 | 가정 | none; 별점 1점 차이 = 손님 15% 차이 |
| season | `satisfaction_walkaway` | -3.0 | 가정 | none; 돌아간 손님 비율 x 이 값 |
| season | `satisfaction_price` | -1.0 | 가정 | none; 가격 수준이 처음보다 높은 만큼 x 이 값 (10% 인상 = -0.1) |
| season | `satisfaction_staff` | lean: -0.05, standard: 0.0, generous: 0.1 | 가정 | none |
| season | `satisfaction_dessert` | 0.05 | 가정 | none |
| season | `satisfaction_breakdown` | -0.1 | 가정 | none |
| season | `price_elasticity` | 1.5 | 가정 | GAP (개인카페 가격 탄력성 자료 없음); 가격 1% 인상 = 주문 1.5% 감소, 대학로 1km²당 카페 475곳처럼 대체재가 많아 1보다 크게 둠 (밀도는 research §5, H) |
| season | `price_change_pct_range` | [-20, 30] | 가정 | none; 한 달에 바꿀 수 있는 가격 폭 (%) |
| season | `price_level_range` | [0.7, 1.5] | 가정 | none; 처음 가격 대비 누적 범위 |
| season | `hours` | short: [11, 20], standard: [10, 22], long: [8, 23] | 가정 | none; 영업시간 선택지 (시작, 끝), standard = opex open_hour close_hour |
| season | `hours_shift_share` | 0.5 | 가정 | none; 문을 닫은 시간의 손님 중 영업시간으로 옮겨 오는 비율 |
| season | `staff_utilization` | lean: 0.85, standard: 0.7, generous: 0.55 | 가정 | none; 직원 운영 방식별 여유율, standard = opex staff_utilization |
| season | `staff_cover` | lean: False, standard: True, generous: True | 가정 | none; 그 시간 손님을 놓치지 않을 만큼 사람을 더 넣는지, 빠듯하게는 일의 양만큼만 |
| season | `staff_balk_mult` | lean: 1.5, standard: 1.0, generous: 0.5 | 가정 | none; 줄 보고 돌아가는 비율 배수 |
| season | `balk_max` | 0.1 | L | Lu, Musalem, Olivares & Schilkrut 2013 Management Science 59(8): 줄 15명 이상이면 구매 30%에서 27% (10% 감소), research §6; 델리 매장 자료를 카페에 옮긴 값, 카페 실측은 GAP |
| season | `balk_mid_util` | 0.95 | 가정 | none; 피크 수요 ÷ 처리량이 이 값일 때 돌아가는 비율이 절반 (로지스틱, research §6 형태) |
| season | `balk_width` | 0.05 | 가정 | none |
| season | `marketing_max_lift` | 0.15 | 가정 | none; 마케팅으로 늘릴 수 있는 손님 최대 15% |
| season | `marketing_half_krw` | 2000000 | 가정 | none; 효과 = 최대 x (1 - exp(-예산 ÷ 이 값)) |
| season | `marketing_max_krw` | 5000000 | 가정 | none; 한 달 추가 마케팅 예산 상한 |
| season | `dessert_share` | 0.185 | M | 엠브레인 구매딥데이터 2025 주요 카페 사이드 메뉴 매출 비중 18.5% via 세계일보 2026-03-22, research §1.6; 디저트를 팔면 상권 객단가 그대로, 안 팔면 객단가에서 이 몫이 빠짐 |
| season | `dessert_food_cost_share` | 0.4 | M | 농식품부·농경연 「2025 외식업체 경영실태 조사 통계보고서」 (2025.8~10 방문 면접, 2024년 실적, 커피 전문점 n=261) 제과 (n=166): 표97 식재료비 10,254.1만원 ÷ 표95 매출액 25,843.4만원 = 39.7%, https://www.mafra.go.kr/bbs/home/798/595247/download.do; 직접 굽는 제과점 값을 카페 디저트에 쓴 대리 지표 (완제품을 사 오면 원가율이 더 높을 수 있음). 업체 블로그 35~45%와도 맞음 |
| season | `dessert_waste_share` | 0.1 | 가정 | none; 디저트 매출 대비 폐기 |
| season | `dessert_min_spoilage_krw` | 300000 | 가정 | none; 쇼케이스를 채워 두는 최소 재고의 월 폐기 |
| season | `dessert_prep_hours_per_day` | 2 | 가정 | none; 디저트 준비 유급 시간 |
| season | `dessert_no_showcase_factor` | 0.5 | 가정 | none; 쇼케이스가 없으면 포장 디저트만, 디저트 매출 절반 |
| season | `loan_rate` | 0.045 | M | 한국은행 「2026년 8월 금융기관 가중평균금리」 예금은행 신규취급액 중소기업 대출 4.38% (2026-09-30 공보); 소상공인시장진흥공단 2026년 4/4분기 정책자금 금리 일반경영안정자금 연 4.72% (기준 4.12% + 0.6%P, ols.semas.or.kr); 연 4.5%, 원리금 균등 상환. 4.5%는 은행 중소기업 대출 4.38%와 정책자금 4.72% 사이, 개인사업자 신규 창업 대출만의 금리는 따로 없어 M |
| season | `loan_term_months` | 60 | 가정 | none; 5년 원리금 균등, 거치 기간 없음 (보수적) |
| season | `working_capital_months` | 3 | 가정 | none; 운전자금 기본값: 문을 열 때 통장에 월 고정비 3개월치가 있도록 모자란 만큼 빌림, extra_loan_krw로 바꿀 수 있음 |
| season | `vat_refund_month` | 2 | L | 부가가치세법 조기환급 (사업 설비 신설 취득), research §3.2 부가세 선지급 후 환급; 환급이 들어오는 달은 가정 |
| season | `scenario_points` | 2개 상황 | 가정 | none; 매달 두 가지 상황(주말 줄, 평일 낮)에서 대응을 고름. 효과 크기는 모두 가정 (한 달 1사건 방식으로 바뀔 예정) |
| season | `closure_negative_months` | 2 | 가정 | none; 현금이 두 달 연속 마이너스면 폐업 |
| season | `rival_nearby_share` | 0.1 | 가정 | none; 상권 연간 개업 수 (district_meta opens_per_year, H) 중 우리 가게 바로 옆에 생기는 비율, 월 확률 = 1 - exp(-개업 x 이 값 ÷ 12) |
| season | `rival_demand_mult` | 0.92 | 가정 | none; 근처 경쟁 카페가 생기면 손님 8% 감소, 시즌 끝까지 |
| season | `rival_elasticity_add` | 0.3 | 가정 | none; 경쟁 카페가 생기면 가격에 더 민감해짐 |
| season | `rent_hike_p` | 0.03 | 가정 | none; 갱신 때 임대료를 올리는 달의 확률, 시즌에 한 번까지 |
| season | `rent_hike_pct` | 0.05 | H | 상가건물 임대차보호법 시행령 제4조 차임 증액 상한 5%; 상한까지 올린다고 가정 |
| season | `breakdown_p` | 0.03 | 가정 | none; 한 달에 설비가 고장 날 확률 |
| season | `breakdown_repair_krw` | 800000 | 가정 | none; 수리비 |
| season | `breakdown_down_days` | 2 | 가정 | none; 수리 동안 문을 닫는 날 |
| season | `viral_p` | 0.03 | 가정 | none; SNS 게시물이 화제가 될 한 달 확률 |
| season | `viral_marketing_boost` | 2.0 | 가정 | none; 마케팅 효과가 최대일 때 확률 배수 (1 + 이 값 x 효과 비율) |
| season | `viral_demand_mult` | 1.3 | 가정 | none; 화제가 된 달 손님 30% 증가 |
| season | `viral_carry_mult` | 1.1 | 가정 | none; 다음 달에 남는 효과 |
| district 3120012 대학로 | `opens_per_year` | 11 | H | VwsmTrdarStorQq 25Q3~26Q2 개업 11곳 (평균 점포의 8.8%), research §5 |
| district 3120094 신촌 | `opens_per_year` | 15 | H | VwsmTrdarStorQq 25Q3~26Q2 개업 15곳 (평균 점포의 10.6%), research §5 |
| district 3110131 성수동카페거리 | `opens_per_year` | 7 | H | VwsmTrdarStorQq 25Q3~26Q2 개업 7곳 (평균 점포의 14.1%), research §5 |

District demand (`districts.yaml`, all H, Seoul 상권분석서비스 VwsmTrdarSelngQq 2026Q2 CS100010):

| District | Sales / store / month | Tx / store / day | Ticket | Peak band | Peak-hour share | Weekend / weekday day factor |
|---|---|---|---|---|---|---|
| 3120012 대학로(혜화역) | 19,096,864 | 64.43 | 9,772 | 14~17 | 0.1009 | 1.242 / 0.903 |
| 3120094 신촌역(신촌역, 신촌로터리) | 12,575,252 | 57.9 | 7,161 | 14~17 | 0.0835 | 1.061 / 0.976 |
| 3110131 성수동카페거리 | 9,808,908 | 31.38 | 10,305 | 11~14 | 0.1096 | 0.751 / 1.099 |
