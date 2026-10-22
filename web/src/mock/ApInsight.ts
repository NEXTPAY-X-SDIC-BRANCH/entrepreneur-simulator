// 옷가게 달 정산의 '다음 달에 고칠 것': 이번 달과 같은 월초 상태·사건·대응에서 계획 한 가지만 바꿔 다시 계산한다
import type { Try } from "./Insight";
import type { Profile } from "./model";
import { CATS, ONLINE, mixAvg, mixOf, playMonth, type ApEvent, type ApMonth, type ApOption, type ApPlan, type ApState, type ApparelCfg } from "./apparel";

export function apTries(profile: Profile, cfg: ApparelCfg, s0: ApState, c: ApMonth, ev: ApEvent, opt: ApOption): Try<Partial<ApPlan>>[] {
  const p = c.plan;
  const run = (patch: Partial<ApPlan>) => playMonth(profile, cfg, s0, c.month, { ...p, ...patch }, ev, opt).month.op;
  const base = run({});
  const out: Omit<Try<Partial<ApPlan>>, "d">[] = [];
  const nx = (c.month % 12) + 1, avg = mixAvg();
  const hot = [...CATS].sort((a, b) => mixOf(nx)[b.id] / avg[b.id] - mixOf(nx)[a.id] / avg[a.id])[0];
  const cold = [...CATS].sort((a, b) => mixOf(nx)[a.id] / avg[a.id] - mixOf(nx)[b.id] / avg[b.id])[0];
  const bc = (k: string, d: number) => ({ ...(p.buyCat ?? {}), [k]: Math.max(0.5, Math.min(1.8, +((p.buyCat?.[k as keyof typeof p.buyCat] ?? 1) + d).toFixed(1))) });
  out.push({ title: `${hot.label} 매입 20% 늘리기`, why: `${nx}월에 ${hot.label} 수요가 늘어요 (1년 평균의 ${Math.round((mixOf(nx)[hot.id] / avg[hot.id]) * 100)}%).`, patch: { buyCat: bc(hot.id, 0.2) } });
  out.push({ title: `${cold.label} 매입 20% 줄이기`, why: `${nx}월에 ${cold.label}는 비수기라 재고가 오래 남아요.`, patch: { buyCat: bc(cold.id, -0.2) } });
  if (p.buy > 0.6) out.push({ title: "전체 매입 10% 줄이기", why: `남은 재고 ${Math.round(c.stockEnd)}만원어치가 현금을 묶고 있어요.`, patch: { buy: +(p.buy - 0.1).toFixed(1) } });
  out.push({ title: "전체 매입 10% 늘리기", why: c.lostStock > 0 ? `찾는 사이즈가 없어 놓친 매출이 ${Math.round(c.lostStock)}만원이에요.` : "결품을 더 줄여요.", patch: { buy: +(p.buy + 0.1).toFixed(1) } });
  if (p.markdownAge > 1) out.push({ title: `세일을 ${p.markdownAge - 1}달 지난 옷부터`, why: "오래된 옷이 값이 떨어지기 전에 빨리 팔아요.", patch: { markdownAge: p.markdownAge - 1 } });
  if (p.markdown < 0.5) out.push({ title: `세일 폭 ${Math.round((p.markdown + 0.1) * 100)}%로`, why: "세일 칸이 더 빨리 비어요.", patch: { markdown: +(p.markdown + 0.1).toFixed(1) } });
  if (p.discount > 0) out.push({ title: "상시 할인 5%p 줄이기", why: "한 벌에 남는 돈이 늘어요.", patch: { discount: +(p.discount - 0.05).toFixed(2) } });
  if (c.lostCap > 0 && p.staff < 3) out.push({ title: `알바 ${p.staff + 1}명으로`, why: `일손이 모자라 놓친 매출이 ${Math.round(c.lostCap)}만원이에요.`, patch: { staff: p.staff + 1 } });
  if (p.staff > 0) out.push({ title: `알바 ${p.staff - 1}명으로`, why: "인건비를 아껴요.", patch: { staff: p.staff - 1 } });
  if ((p.online ?? 0) < 2) out.push({ title: `${ONLINE[(p.online ?? 0) + 1].label}`, why: "같은 재고를 온라인으로도 팔아요.", patch: { online: (p.online ?? 0) + 1 } });
  if ((p.online ?? 0) > 0) {
    out.push({ title: "온라인 광고 20만원 더", why: "온라인 주문이 늘어요.", patch: { onlineAd: (p.onlineAd ?? 0) + 20 } });
    out.push({ title: p.freeShip === false ? "무료배송으로 바꾸기" : "배송비 고객 부담으로", why: p.freeShip === false ? "온라인 주문이 늘고 택배비를 가게가 내요." : "택배비를 아끼고 온라인 주문은 조금 줄어요.", patch: { freeShip: p.freeShip === false } });
  }
  if (p.marketing < 100) out.push({ title: `SNS 홍보 ${p.marketing + 25}만원`, why: "알려지면 다음 달부터 손님이 늘어요.", patch: { marketing: p.marketing + 25 } });
  return out.map((x) => ({ ...x, d: run(x.patch) - base })).filter((x) => x.d >= 3).sort((a, b) => b.d - a.d);
}
