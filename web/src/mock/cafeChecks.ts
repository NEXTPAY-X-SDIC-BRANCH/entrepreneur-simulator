// 카페 열기 전 점검: 고깃집 checks()와 같은 다섯 질문, 숫자는 카페 자료로 계산한다.
// 매출은 동네 점포당 월매출의 중앙값(model.ts CAFE_MEDIAN)과 4분의 1·4분의 3 분위로 세 가지 경우를 본다.
// 비용 구조는 외식업체 경영실태조사 2025 커피전문점(전국, 프랜차이즈 포함, 2-2 정량 데이터 표 95~104·127)이고, 값마다 아래에 출처를 적었다.
import { CAFE_GRADES, CAFE_SIGN, cafeOpeningCost } from "./cafe";
import { cafeShapeBody } from "../lab/layout/cafeFlow"; // lab:layout
import type { RoomShape } from "../lab/layout/shape"; // lab:layout
import { guStat, man, type Check, type Grade, type Profile } from "./model";

export const C = {
  TICKET: 5704,        // 원, 1인 객단가 (표 67)
  DAYS: 26,            // 일/월, 독립 카페 영업일 중앙값 (지표 엑셀 sto_open_days)
  FOOD: 0.391,         // 식재료비 / 매출 (표 97)
  TAX: 0.06,           // 세금과 공과 / 매출 (표 100, 공과금 포함 추정)
  OTHER: 0.058,        // 기타비용 / 매출 (표 103, 홍보비·수수료·소모품)
  CARD: 0.004,         // 카드 수수료 (영세 신용 0.40%, 금융위 2025.8)
  PART: 158.1,         // 만원/월, 임시직 1인 인건비 (표 127)
  OWNER: 211,          // 만원/월, 대표자 인건비 (표 102). 영업이익 8.9%도 이 값을 뺀 뒤의 값
  OPEN_CURVE: [0.55, 0.7, 0.82, 0.9, 0.96, 1.0], // 오픈 곡선, 가정 (고깃집과 같은 값)
  LOW: 0.8,            // 손님이 20% 적은 경우, 가정
};
export const VAR_SHARE = C.FOOD + C.TAX + C.OTHER + C.CARD;
// 면적별 매출 차이 (지표 엑셀 drv_rev_by_area: 10평 미만 8,920 / 10~30평 약 10,000 / 30평 이상 13,776만원). 면적이 매출을 올린다는 인과는 아니다.
// 세 구간 값을 계단 대신 선으로 이었다 (가정): 10평 0.89, 20평 1.00, 35평부터 1.37. 계단이면 29평에서 30평으로 한 평 늘릴 때 매출이 37% 뛰었다.
// sim/easy.py cafe_area_fx와 같은 식이다.
export const areaFx = (p: number) => (p <= 10 ? 0.89 : p <= 20 ? 0.89 + (p - 10) * 0.011 : Math.min(1.37, 1 + (p - 20) * (0.37 / 15)));

// 가게 꾸미기 입력. 3D 목업의 배치 입력(tables~pos)은 비워 두면 평수에서 어림한 값(독립 카페 평당 테이블 0.36개, 좌석 1.27석)을 쓴다.
export type CafeCfg = { pyeong: number; grade: Grade; staff: number; tables?: number; chairs?: number; bar?: number; groups?: number; showcase?: number; oven?: number; kiosks?: number; pos?: number; shape?: RoomShape }; // lab:layout shape
export const cafeLayoutOf = (c: CafeCfg) => ({
  tables: c.tables ?? Math.max(1, Math.round(c.pyeong * 0.36)), chairs: c.chairs ?? Math.max(2, Math.round(c.pyeong * 1.27)), bar: c.bar ?? 0,
  groups: c.groups ?? 2, showcase: c.showcase ?? 1, oven: c.oven ?? 0, kiosks: c.kiosks ?? 0, pos: c.pos ?? 1,
});
// 엔진(/cafe/preview, /cafe/season) 요청. 동네(행정동 코드)를 안 골랐으면 배치 미리보기용으로 대학로 코드를 쓰고, 시뮬은 동네를 요구한다.
export const engineBody = (profile: Profile, c: CafeCfg, district: string) => {
  const l = cafeLayoutOf(c);
  return { district, size_pyeong: c.pyeong, tables: l.tables, chairs: l.chairs, bar_seats: l.bar, espresso_groups: l.groups, showcase: l.showcase, oven: l.oven,
    kiosks: l.kiosks, pos: l.pos, own_capital_krw: Math.round(profile.capital * 10000), staff_peak: c.staff + 1, seed: 7, ...cafeShapeBody(c.shape) }; // lab:layout
};

// ---- 여는 비용의 한 출처: 엔진(/cafe/preview)의 capex와 funding (lab 2026-10-22) ----
// 가게 꾸미기, 시뮬레이션 시작 화면, 이지 모드가 모두 이 값을 쓴다. 엔진은 권리금과 부가세 선납까지 넣고,
// 모자란 돈과 운전자금(월 고정비 3개월치)을 대출로 계산한다 (sim/cafe/model.py funding).
export type EngineCapexLine = { item_ko: string; qty: number; unit_krw: number; subtotal_krw: number; grade: string; source?: string };
export type EngineCapex = { lines: EngineCapexLine[]; total_krw: number };
export type EngineFunding = {
  capex_krw: number; own_capital_krw: number; capex_gap_krw: number; extra_loan_krw: number; loan_krw: number;
  working_capital_target_krw: number; cash_krw: number; loan_payment_krw: number; loan_rate: number; loan_term_months: number; working_capital_note_ko: string;
};
export type CafeOpen = {
  lines: { key: string; label: string; amount: number; basis: string }[]; // 만원, 묶은 줄
  total: number; deposit: number; vat: number; keyMoney: number; sunk: number; // 만원
  loan: number; gap: number; extra: number; cash: number; pay: number; reserve: number; // 만원 (pay = 기본 금리 월 상환액)
};
const GROUPS: { key: string; label: string; basis: string; test: (n: string) => boolean }[] = [
  { key: "interior", label: "인테리어와 전기 증설", basis: "평당 단가 × 평수 (커피 프랜차이즈 정보공개서 중앙값) + 전기 증설", test: (n) => n.startsWith("인테리어") || n.startsWith("전기") },
  { key: "furniture", label: "테이블과 의자", basis: "개수 × 다나와 시세", test: (n) => /테이블|의자|바 스툴/.test(n) },
  { key: "vat", label: "부가세 선납 (환급)", basis: "인테리어·설비·가구 값의 10%, 개업 후 환급", test: (n) => n.startsWith("부가세") },
  { key: "deposit", label: "보증금", basis: "이 동네 평당 보증금 × 평수, 나갈 때 돌려받아요", test: (n) => n.startsWith("보증금") },
  { key: "keymoney", label: "권리금", basis: "이 동네 자료값 (돌려받지 못하는 웃돈)", test: (n) => n.startsWith("권리금") },
  { key: "equip", label: "머신과 설비", basis: "에스프레소 머신, 그라인더, 냉장고, 제빙기 등 × 다나와 시세", test: () => true },
];
export function cafeOpenFromEngine(capex: EngineCapex, f: EngineFunding): CafeOpen {
  const sum: Record<string, number> = {};
  for (const l of capex.lines) { const g = GROUPS.find((x) => x.test(l.item_ko))!; sum[g.key] = (sum[g.key] ?? 0) + l.subtotal_krw; }
  const order = ["keymoney", "deposit", "interior", "equip", "furniture", "vat"];
  const lines = order.filter((k) => sum[k]).map((k) => { const g = GROUPS.find((x) => x.key === k)!; return { key: k, label: g.label, amount: sum[k] / 10000, basis: g.basis }; });
  const w = (k: string) => (sum[k] ?? 0) / 10000;
  const total = capex.total_krw / 10000;
  return { lines, total, deposit: w("deposit"), vat: w("vat"), keyMoney: w("keymoney"), sunk: total - w("deposit") - w("vat"),
    loan: f.loan_krw / 10000, gap: f.capex_gap_krw / 10000, extra: f.extra_loan_krw / 10000, cash: f.cash_krw / 10000,
    pay: f.loan_payment_krw / 10000, reserve: f.working_capital_target_krw / 10000 };
}
// 손님 수 맞춤: 이 동네 보통 카페 월매출 × 면적 차이에 맞춘 바쁜 날 주문 수 (sim/easy.py cafe_daily와 같은 식).
// p0 = daily_customers 없이 부른 미리보기. 처리 능력으로 깎기 전의 수요 매출로 나눈다 (깎인 매출로 나누면 작은 가게 손님이 부풀었다).
export function cafeDaily(p0: { demand: { default_daily_customers: number; revenue_uncapped_krw?: number }; rough_month: { revenue_krw: number } }, gu: string, pyeong: number): number {
  const base = p0.demand.revenue_uncapped_krw || p0.rough_month.revenue_krw;
  const ratio = base ? (guStat(gu).sales * areaFx(pyeong) * 10000) / base : 1;
  return Math.min(600, Math.max(10, Math.round(p0.demand.default_daily_customers * ratio)));
}

// eng = 엔진의 여는 비용과 대출. 없으면(엔진 응답 전, 비용 쌓기 그림) 화면 어림값으로 계산한다.
export function cafeRun(profile: Profile, cfg: CafeCfg, sales: number, shock: { food?: number; rent?: number; labor?: number; demand?: number } = {}, eng?: CafeOpen | null) {
  const st = guStat(profile.gu);
  const local = cafeOpeningCost(cfg.pyeong, cfg.grade, profile.gu, profile.keyMoney ?? 0);
  const open = eng ? { lines: eng.lines, total: eng.total } : local;
  const start = eng ? eng.cash : profile.capital - open.total;
  const pay = eng?.pay ?? 0;
  const rent = st.rent * cfg.pyeong * (1 + (shock.rent ?? 0));
  const labor = cfg.staff * C.PART * (1 + (shock.labor ?? 0));
  const fixed = rent + labor + C.OWNER;
  const v = VAR_SHARE + C.FOOD * (shock.food ?? 0);
  let cash = start;
  const rows = C.OPEN_CURVE.map((r, i) => {
    const revenue = sales * areaFx(cfg.pyeong) * r * (1 + (shock.demand ?? 0));
    const op = revenue * (1 - v) - fixed;
    cash += op - pay;
    return { m: i + 1, revenue, op, cash };
  });
  const settled = sales * areaFx(cfg.pyeong) * (1 + (shock.demand ?? 0)) * (1 - v) - fixed;
  return { start, open, rows, settled, fixed, rent, labor };
}

const months = (n: number) => (n >= 12 ? `${Math.floor(n / 12)}년${n % 12 ? ` ${n % 12}개월` : ""}` : `${n}개월`);

export function cafeChecks(profile: Profile, cfg: CafeCfg, eng?: CafeOpen | null): { list: Check[]; settled: number } {
  const st = guStat(profile.gu);
  const mid = st.sales, [lo, hi] = st.salesRange ?? [mid * 0.75, mid * 1.5];
  const run = cafeRun(profile, cfg, mid, {}, eng);
  const runLo = cafeRun(profile, cfg, lo, {}, eng), runHi = cafeRun(profile, cfg, hi, {}, eng);
  const low20 = cafeRun(profile, cfg, mid, { demand: -(1 - C.LOW) }, eng);
  const per = C.TICKET * (1 - VAR_SHARE);                      // 손님 한 명이 남기는 돈 (원)
  const need = Math.ceil((run.fixed * 10000) / (per * C.DAYS)); // 본전 손님 수 (하루)
  const want = Math.round((mid * areaFx(cfg.pyeong) * 10000) / (C.TICKET * C.DAYS)); // 동네 보통 가게의 하루 손님
  const neg = (r: ReturnType<typeof cafeRun>) => r.rows.find((x) => x.cash < 0)?.m ?? null;
  const sunk = eng ? eng.sunk : run.open.total - (run.open.lines.find((l) => l.key === "deposit")?.amount ?? 0);
  const fix = (n: number) => `${n > 0 ? "+" : "−"}${man(Math.abs(n))}`;

  // 평수를 줄이면 어떻게 되나 (월세와 면적별 매출 차이 반영)
  let best = { p: cfg.pyeong, v: run.settled };
  for (let p = 10; p <= 30; p++) { const s = cafeRun(profile, { ...cfg, pyeong: p }, mid).settled; if (s > best.v + 1) best = { p, v: s }; } // settled는 여는 비용과 무관
  const smaller = best.p < cfg.pyeong ? `${best.p}평으로 줄이면 자리가 잡힌 뒤 한 달 손익이 ${fix(best.v)}이 돼요(월세와 면적별 매출 차이 반영).` : undefined;

  const shocks: { label: string; r: ReturnType<typeof cafeRun> }[] = [
    { label: "원두·우유값이 10% 오른다", r: cafeRun(profile, cfg, mid, { food: 0.1 }, eng) },
    { label: "월세가 10% 오른다", r: cafeRun(profile, cfg, mid, { rent: 0.1 }, eng) },
    { label: "인건비가 10% 오른다", r: cafeRun(profile, cfg, mid, { labor: 0.1 }, eng) },
    { label: "근처에 카페가 새로 생긴다 (손님 10% 감소)", r: cafeRun(profile, cfg, mid, { demand: -0.1 }, eng) },
  ];
  const bad = shocks.filter((s) => s.r.rows[5].cash < 0).length;
  const base = run.rows[5].cash;
  const nm = neg(run), nl = neg(low20);

  const list: Check[] = [
    {
      key: "breakeven", title: "하루에 몇 명이 와야 본전인가요?",
      status: want >= need * 1.1 ? "ok" : want >= need ? "warn" : "weak",
      line: `하루 ${need}명이에요. ${profile.gu}의 보통 카페에는 하루 ${want}명쯤 와요.`,
      todo: want >= need ? undefined : `${need - want}명이 모자라요. ${smaller ?? `다달이 나가는 돈 ${man(run.fixed)}을 줄여야 해요.`}`,
      rule: `다달이 나가는 돈은 월세 ${man(run.rent)}(평당 ${st.rent}만원 × ${cfg.pyeong}평), 직원 ${cfg.staff}명 ${man(run.labor)}, 사장 생활비 ${man(C.OWNER)}로 모두 ${man(run.fixed)}이에요. 손님 한 명이 객단가 ${C.TICKET.toLocaleString("ko-KR")}원에서 재료비 ${(C.FOOD * 100).toFixed(1)}%, 세금·공과 ${C.TAX * 100}%, 기타 ${C.OTHER * 100}%, 카드 수수료 ${C.CARD * 100}%를 빼고 ${Math.round(per).toLocaleString("ko-KR")}원을 남겨요. 한 달 ${C.DAYS}일 영업이면 하루 ${need}명이에요.`,
    },
    {
      key: "range", title: "이 동네 카페들은 한 달에 얼마나 남기나요?",
      status: run.settled >= 0 ? (runLo.settled >= 0 ? "ok" : "warn") : runHi.settled >= 0 ? "warn" : "weak",
      line: `${profile.gu} 보통 카페(중앙값)는 자리가 잡힌 뒤 한 달에 ${fix(run.settled)}이에요. 매출이 상위 4분의 1이면 ${fix(runHi.settled)}, 하위 4분의 1이면 ${fix(runLo.settled)}이에요.`,
      todo: run.settled < 0 ? (smaller ?? "월세와 인건비를 먼저 줄여 보세요.") : undefined,
      rows: [
        { label: `상위 4분의 1 (월매출 ${man(hi)})`, value: fix(runHi.settled), ok: runHi.settled >= 0 },
        { label: `보통 (월매출 ${man(mid)})`, value: fix(run.settled), ok: run.settled >= 0 },
        { label: `하위 4분의 1 (월매출 ${man(lo)})`, value: fix(runLo.settled), ok: runLo.settled >= 0 },
      ],
      rule: `월매출 세 가지는 동네 점포당 매출의 중앙값과 4분의 1·4분의 3 분위예요(전국 독립 카페 분포를 서울 값에 옮긴 추정). 월 손익은 매출에서 재료비 등 비율 비용 ${(VAR_SHARE * 100).toFixed(1)}%와 월세, 직원, 사장 생활비를 뺀 값이에요. 사장 생활비를 비용으로 뺐기 때문에 0 이상이면 사장이 월급을 가져가고도 남는다는 뜻이에요.`,
    },
    {
      key: "runway", title: "현금은 언제까지 버티나요?",
      status: nl === null ? "ok" : nl <= 3 ? "weak" : "warn",
      line: (run.start < 0 ? `여는 데 드는 돈이 가진 돈보다 ${man(-run.start)} 많아요. `
        : eng && eng.gap > 0 ? `여는 데 드는 돈이 가진 돈보다 ${man(eng.gap)} 많아서 대출 ${man(eng.loan)}으로 시작해요. ` : "")
        + (nl ? `손님이 예상보다 20% 적으면 ${nl}개월째에 현금이 바닥나요.` : `손님이 예상보다 20% 적어도 6개월 뒤 ${man(low20.rows[5].cash)}이 남아요.`),
      todo: nl ? "새 가게는 첫 달에 자리 잡힌 뒤의 55%만 온다고 봤어요. 그동안 버틸 현금을 남겨 두세요." : undefined,
      rule: `가게를 열고 남는 현금 ${man(run.start)}에서 시작해요${eng && eng.loan > 0 ? `(대출 ${man(eng.loan)} 포함, 다달이 원리금 ${man(eng.pay)}씩 갚아요)` : ""}. 손님은 첫 달 55%에서 6개월째 100%로 늘어난다고 가정했어요(고깃집과 같은 가정값). 예상대로 오면 6개월 뒤 ${man(base)}${nm ? `, ${nm}개월째부터 현금이 바닥나요` : ""}이에요.`,
    },
    {
      key: "payback", title: "들인 돈은 언제 돌아오나요?",
      status: run.settled <= 0 ? "weak" : sunk / run.settled <= 36 ? "ok" : sunk / run.settled <= 60 ? "warn" : "weak",
      line: run.settled <= 0 ? `자리가 잡힌 뒤에도 한 달에 ${man(-run.settled)}씩 줄어요. 이 구성으로는 돌아오지 않아요.`
        : `자리가 잡히면 한 달에 ${man(run.settled)}이 남아요. 들인 돈 ${man(sunk)}은 약 ${months(Math.ceil(sunk / run.settled))} 뒤에 돌아와요.`,
      rule: eng ? `들인 돈은 여는 비용에서 보증금과 부가세 선납을 뺀 값이에요(권리금, 인테리어, 머신과 설비, 가구). 보증금은 나갈 때, 부가세는 개업 후에 돌려받아요. 한 달에 남는 돈은 위의 보통 카페 손익이에요.`
        : `들인 돈은 보증금을 뺀 인테리어, 머신과 설비, 가구, 간판 ${man(CAFE_SIGN)}, 첫 재료 값이에요(보증금은 나갈 때 돌려받아요). 한 달에 남는 돈은 위의 보통 카페 손익이에요.`,
    },
    {
      key: "shock", title: "오픈 이후 어떤 사건들이 생길까요?",
      status: bad === 0 ? "ok" : bad <= 2 ? "warn" : "weak",
      line: bad === 0 ? "아래 네 가지 사건 가운데 무엇이 하나 생겨도 6개월 뒤 현금이 남아요." : `아래 네 가지 사건 가운데 ${bad}가지는 하나만 생겨도 6개월 안에 현금이 바닥나요.`,
      rows: shocks.map((s) => ({ label: s.label, value: `${man(s.r.rows[5].cash)} (${fix(s.r.rows[5].cash - base)})`, ok: s.r.rows[5].cash >= 0 })),
      rule: "한 가지씩 따로 6개월 내내 이어진다고 보고 계산했어요. 괄호 안은 아무 일 없을 때와의 차이예요. 식재료비·월세·인건비 상승은 외식업 경영 애로 응답(식재료 91.4%, 월세 77.3%, 인건비 75.2%, 경영실태조사 2023)에서 골랐고, 10%라는 크기와 경쟁점 효과는 가정이에요.",
    },
  ];
  return { list, settled: run.settled };
}

export const GRADE_LABEL = (g: Grade) => CAFE_GRADES[g].label;
