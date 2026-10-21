// 비용 쌓기 (cost lane, 10/20 피드백 9번 "인건비·매장 운영비가 빠져 매출이 높아 보임").
// 모든 돈 패널이 같은 순서와 같은 이름으로 비용을 보여 주도록, 엔진 값을 한 모양(Stack)으로 바꾼다. 단위는 원.
// 순서: 재료비 → 인건비 (알바·직원) → 인건비 (사장 가상 급여) → 임차료 → 매장 운영비 (내역) → 카드·배달 수수료 → 영업이익

export type StackKid = { label: string; amount: number };
export type StackRow = { key: string; label: string; amount: number; hint?: string; kids?: StackKid[]; tag?: "가정" | "조사" };
export type Stack = { revenue: number; rows: StackRow[]; op: number; opLabel?: string; extra?: StackRow[] };

export const VAT_NOTE = "매출은 부가세가 들어 있는 금액이에요. 분기마다 내는 부가세는 아직 계산에 넣지 않았어요 (가정).";

const kidsOf = (d?: Record<string, number> | null): StackKid[] | undefined =>
  d ? Object.entries(d).filter(([, v]) => Math.abs(v) >= 1).map(([label, amount]) => ({ label, amount })) : undefined;

// 고깃집 엔진 /season/play 의 kpis (원). labor_owner 가 없는 예전 응답은 imputed 로 나눈다.
export type BbqKpis = Record<string, number> & { opex_detail?: Record<string, number> };
export function bbqStack(k: BbqKpis, imputed: number): Stack {
  const owner = typeof k.labor_owner === "number" ? k.labor_owner : imputed;
  const delivery = k.delivery_fee ?? 0;
  const rows: StackRow[] = [
    { key: "cogs", label: "재료비", amount: k.cogs, hint: "고기·술·반찬" },
    { key: "hired", label: "인건비 · 알바", amount: Math.max(0, k.labor - owner), hint: "알바·직원 급여, 주휴수당 포함" },
    { key: "owner", label: "인건비 · 사장", amount: owner, hint: `사장 가상 급여 월 ${Math.round(owner / 1e4)}만원`, tag: "가정" },
    { key: "rent", label: "임차료", amount: k.rent, hint: "월세" },
    { key: "mgmt", label: "매장 운영비", amount: k.mgmt, hint: "공과금·소모품·수선·보험·통신·마케팅", kids: kidsOf(k.opex_detail) },
    { key: "fees", label: delivery > 0 ? "카드·배달 수수료" : "카드 수수료", amount: k.fees },
  ];
  return { revenue: k.revenue, rows, op: k.op };
}

// 카페 엔진 /cafe/season/month 의 month_line (sim/opex.py cafe_month_line). 감가상각은 현금이 안 나가는 비용이라 따로.
export type CafeLine = { revenue: number; op: number; covers: number; cogs: number; labor: number; rent: number; mgmt: number; fees: number;
  labor_owner: number; labor_hired: number; depreciation: number; opex_detail?: Record<string, number> };
export function cafeStack(m: CafeLine): Stack {
  return {
    revenue: m.revenue, op: m.op,
    rows: [
      { key: "cogs", label: "재료비", amount: m.cogs, hint: "원두·우유·디저트" },
      { key: "hired", label: "인건비 · 알바", amount: m.labor_hired, hint: "시간대별 필요 인원, 4대보험·주휴 포함" },
      { key: "owner", label: "인건비 · 사장", amount: m.labor_owner, hint: `사장 가상 급여 월 ${Math.round(m.labor_owner / 1e4)}만원 (커피 전문점 대표자 평균)`, tag: "조사" },
      { key: "rent", label: "임차료", amount: m.rent, hint: "월세" },
      { key: "mgmt", label: "매장 운영비", amount: m.mgmt, hint: "전기·관리비·소모품·포장재·수선·마케팅", kids: kidsOf(m.opex_detail) },
      { key: "fees", label: "카드 수수료", amount: m.fees },
      { key: "dep", label: "감가상각", amount: m.depreciation, hint: "설비·인테리어 값을 5년에 나눠 뺌, 현금은 안 나가요" },
    ],
  };
}

// 한 달 값의 일부만 지난 때 (재생 중): 매출에 따라 붙는 비용(재료비·수수료)은 매출 비율, 나머지는 지난 날 비율
export function prorate(s: Stack, revShare: number, timeShare: number, revenueNow?: number): Stack {
  const variable = new Set(["cogs", "fees"]);
  const rev = revenueNow ?? s.revenue * revShare;
  const rows = s.rows.map((r) => {
    const f = variable.has(r.key) ? revShare : timeShare;
    return { ...r, amount: r.amount * f, kids: r.kids?.map((x) => ({ ...x, amount: x.amount * f })) };
  });
  return { ...s, revenue: rev, rows, op: rev - rows.reduce((a, r) => a + r.amount, 0) };
}

export const COLORS: Record<string, string> = {
  cogs: "#c98a2b", hired: "#3d63ea", owner: "#9db3f5", rent: "#6b7684", mgmt: "#9a6fb0", fees: "#b8b4a4", dep: "#cdd3dc",
  interest: "#d08770", op: "#1b6e43",
};
