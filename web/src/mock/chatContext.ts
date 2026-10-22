// 시뮬레이션 화면이 계산한 결과를 챗봇(Chat.tsx)에 넘기는 얇은 저장소.
// 서버(api/ask_ext.py)는 이 값으로 "내 가게는 몇 달째부터 남아요?" 같은 질문의 근거 문장을 즉석에서 만든다.
// 금액은 원 단위이고, 값이 없으면 시뮬레이션을 아직 돌리지 않은 것이다.
export type EngineMonth = {
  month: number; revenue: number; cogs: number; labor: number; rent: number; mgmt: number; fees: number;
  covers: number; op: number; open_days: number; cash_end: number;
};
export type EngineCtx = {
  start_month: number; months: EngineMonth[]; closed: boolean; finished: boolean; cash_now: number;
  payback?: { month: number | null; estimated: boolean; reason: string };
  end_cash?: number; lowest_cash?: number; spent?: number;
  // 고깃집이 아닌 업종: 기준이 달라 같이 보낸다. owner_fixed는 손익분기 계산에 고정비로 더할 사장님 몫(원/월),
  // owner_note는 그 기준을 말하는 문장, unit은 손님 대신 결제 건수를 세는 업종(옷가게)일 때 "건".
  owner_fixed?: number; owner_note?: string; unit?: "명" | "건";
  opening?: OpeningCtx;
};
export type OpeningCtx = { total: number; lines: { label: string; amount: number }[] }; // 만원

/** 투자금 회수 (sim/venture.py와 같은 규칙): 보증금을 뺀 쓴 돈을 달마다의 영업 현금(사장님 몫과 이자를 뺀 뒤)으로 되찾는 달.
 *  6개월 안에 못 되찾으면 마지막 3개월 평균으로 이어 붙이고(추정), 10년 안에 안 되면 못 되찾는다. 금액은 원. */
export function paybackOf(spent: number, cashOps: number[], horizon = 120): NonNullable<EngineCtx["payback"]> {
  if (spent <= 0) return { month: 0, estimated: false, reason: "쓴 돈이 없어 되찾을 것이 없음" };
  let cum = 0;
  for (let i = 0; i < cashOps.length; i++) { cum += cashOps[i]; if (cum >= spent) return { month: i + 1, estimated: false, reason: "" }; }
  const tail = cashOps.slice(-3);
  const run = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  if (run <= 0) return { month: null, estimated: true, reason: "마지막 3개월 평균이 적자라 이 속도로는 되찾지 못함" };
  const m = cashOps.length + Math.ceil((spent - cum) / run);
  return m <= horizon ? { month: m, estimated: true, reason: "" } : { month: null, estimated: true, reason: `${horizon}개월 안에 되찾지 못함` };
}

// 가게 꾸미기 화면이 미리보기로 계산한 가게 값 (lab 새 업종 IndustryBuild). 금액은 만원. 화면이 바뀌어도 업종이 같을 때만 쓴다
export type ShopCtx = { industry: string; pyeong: number; staff: number; tables?: number; seats?: number; loan: number; cost: { total: number; lines: { key?: string; label: string; amount: number }[] } };
let shop: ShopCtx | null = null;
export const setShopCtx = (s: ShopCtx | null) => { shop = s; };
export const getShopCtx = (industry: string) => (shop && shop.industry === industry ? shop : null);

let current: EngineCtx | null = null;
export const setEngineCtx = (e: EngineCtx | null) => { current = e; };
export const getEngineCtx = () => current;
