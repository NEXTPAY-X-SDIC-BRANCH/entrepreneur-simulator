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
};

let current: EngineCtx | null = null;
export const setEngineCtx = (e: EngineCtx | null) => { current = e; };
export const getEngineCtx = () => current;
