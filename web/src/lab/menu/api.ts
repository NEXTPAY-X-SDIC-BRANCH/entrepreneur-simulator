// 메뉴판 API (lab:menu): 엔진 서버의 /lab/menu/* (api/lab_menu.py). 원가 계산은 서버(sim/menu.py)가 한다.
export type Kind = "main" | "side" | "drink";
export type Industry = "bbq" | "cafe";
export type CostLine = { ing: string; name: string; qty: number; unit: string; unit_price: number; amount: number; source: string; date: string | null; stage: string };
export type CostDetail = { unit_cost: number; raw: number; overhead: { value: number; tag: string; note: string; label?: string }; aged_mult: number; lines: CostLine[]; missing: string[]; assumed_share: number };
export type MenuItem = {
  id: string; name: string; kind: Kind; price: number; unit_cost: number; mix: number;
  recipe?: [string, number][]; alt_recipe?: Record<string, [string, number][]>; portion?: string;
  cost_source?: "data" | "가정" | "user"; cost_detail?: CostDetail;
};
export type TableSetting = { label: string; base_banchan: number; cost: number; cost_source: "data" | "user"; cost_detail: CostDetail };
export type Source = { id: string; publisher: string; title: string; url: string | null; stage: string; status: string; basis_date: string | null; note: string };
export type MenuDoc = {
  industry: Industry; items: MenuItem[]; scale: number;
  kinds: Record<string, { label: string; unit: string; per_cover: string }>;
  levels: Record<string, { price: number; cost_ratio: number; level: number }>;
  per_cover: { ticket: number; parts: Record<string, number>; table_cost: number; menu_cost_ratio: number; cost_ratio: number };
  table_setting: TableSetting | null;
  benchmark: { cost_ratio: number; label: string; source: string } | null;
  snapshot: { basis_date: string | null; generated: string | null; caveat: string | null; sources: Source[] };
};
// 엔진에 보내는 메뉴: 계산에 쓰는 값만
export type EngineMenuItem = Pick<MenuItem, "id" | "name" | "kind" | "price" | "unit_cost" | "mix">;
export const toEngine = (items: MenuItem[]): EngineMenuItem[] =>
  items.map(({ id, name, kind, price, unit_cost, mix }) => ({ id, name, kind, price, unit_cost, mix }));

async function call(url: string, init?: RequestInit): Promise<MenuDoc> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : `메뉴판 서버 오류 ${r.status}`);
  return j as MenuDoc;
}

export const fetchTemplate = (api: string, industry: Industry, grade = "domestic", district?: string) =>
  call(`${api}/lab/menu/template?${new URLSearchParams({ industry, grade, ...(district ? { district } : {}) })}`);

export const recompute = (api: string, industry: Industry, grade: string, menu: MenuItem[],
  opts: { district?: string; force?: boolean; table?: TableSetting | null } = {}) =>
  call(`${api}/lab/menu/recompute`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ industry, grade, menu: menu.map(({ cost_detail, ...x }) => x), district: opts.district, force: !!opts.force,
      table_setting: opts.table ? { cost: opts.table.cost, cost_source: opts.table.cost_source } : undefined }),
  });
