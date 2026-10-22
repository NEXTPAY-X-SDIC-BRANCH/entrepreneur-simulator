// 소상공인365 SNS 분석 (sbiz_sns.json, pipelines/fetch_sbiz365_sns.py): 업종 키워드의 달별 SNS 언급 수와 연관어.
// 달별 관심도(12개월 평균 = 1)를 SNS 홍보·신메뉴 효과에 곱한다. 관심이 많은 달에 홍보하면 더 많이 퍼진다고 본다 (가정)
export type SnsInd = { keyword: string; monthly: Record<string, number>; season_index: Record<string, number>; total: number; related: { word: string; freq: number }[] };
let SNS: { period?: string; inds: Record<string, SnsInd> } = { inds: {} };
export function setSns(d: typeof SNS | null) { if (d?.inds) SNS = d; }
export const snsOf = (ind: string) => SNS.inds[ind] ?? null;
export const snsPeriod = () => SNS.period ?? "";
// 이 달 관심도 (자료가 없으면 1). 너무 튀지 않게 0.7~1.4로 자른다
export const snsMonth = (ind: string, month: number) => Math.min(1.4, Math.max(0.7, SNS.inds[ind]?.season_index[String(month)] ?? 1));
