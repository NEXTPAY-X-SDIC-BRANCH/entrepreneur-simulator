// 열기 전 점검의 "자리가 잡히면 한 달에 ○○ 남아요" 밑에 붙는 비용 쌓기: 그 숫자가 어떤 비용을 다 뺀 값인지 보여 준다.
// 고깃집은 model.ts simulate()의 6개월째, 카페는 cafeChecks.ts cafeRun()의 보통 카페 값과 같은 식으로 다시 나눈다.
import { C, VAR_SHARE, areaFx, cafeRun, type CafeCfg } from "../../mock/cafeChecks";
import { FEE_SHARE, FOOD_SHARE, LOAN_RATE, OTHER_OPEX, OWNER_DRAW, UTIL_PER_PYEONG, mgmtOf, guStat, settledNet, simulate, staffPay, type Levers, type Profile, type Store } from "../../mock/model";
import CostStack from "./CostStack";
import { VAT_NOTE, type Stack } from "./stackModel";

const W = 1e4; // 만원 → 원

export function bbqSettled(profile: Profile, store: Store, lv: Levers): Stack {
  const st = guStat(profile.gu);
  const run = simulate(profile, store, lv, []);
  const rev = run.rows[5].revenue;
  const food = FOOD_SHARE * (19000 / lv.price);
  const interest = (store.loan * LOAN_RATE) / 12;
  const rows = [
    { key: "cogs", label: "재료비", amount: rev * food * W, hint: `매출의 ${Math.round(food * 100)}%` },
    { key: "hired", label: "인건비 · 알바", amount: staffPay(lv.staff, lv.days) * W, hint: `직원 ${lv.staff}명` },
    { key: "owner", label: "인건비 · 사장", amount: OWNER_DRAW * W, hint: `사장 생활비 월 ${OWNER_DRAW}만원`, tag: "가정" as const },
    { key: "rent", label: "임차료", amount: st.rent * store.pyeong * W, hint: `평당 ${st.rent}만원 × ${store.pyeong}평` },
    { key: "mgmt", label: "매장 운영비", amount: mgmtOf(store.pyeong) * W, tag: "가정" as const, hint: "공과금·소모품·수선·보험·통신·세무",
      kids: [{ label: `공과금 (평당 ${UTIL_PER_PYEONG}만원 × ${store.pyeong}평)`, amount: UTIL_PER_PYEONG * store.pyeong * W },
        { label: "소모품·수선·보험·통신·세무 등", amount: OTHER_OPEX * W }] },
    { key: "fees", label: "카드 수수료", amount: rev * FEE_SHARE * W },
    ...(interest > 0 ? [{ key: "interest", label: "대출 이자", amount: interest * W, hint: `연 ${(LOAN_RATE * 100).toFixed(2)}%` }] : []),
  ];
  return { revenue: rev * W, rows, op: settledNet(run, store) * W, opLabel: "한 달에 남는 돈" };
}

export function cafeSettled(profile: Profile, cfg: CafeCfg): Stack {
  const st = guStat(profile.gu);
  const run = cafeRun(profile, cfg, st.sales);
  const rev = st.sales * areaFx(cfg.pyeong);
  const pctTxt = (x: number) => `매출의 ${(x * 100).toFixed(1)}%`;
  const rows = [
    { key: "cogs", label: "재료비", amount: rev * C.FOOD * W, hint: pctTxt(C.FOOD), tag: "조사" as const },
    { key: "hired", label: "인건비 · 알바", amount: run.labor * W, hint: `직원 ${cfg.staff}명 × 월 ${C.PART}만원` },
    { key: "owner", label: "인건비 · 사장", amount: C.OWNER * W, hint: `대표자 인건비 평균 월 ${C.OWNER}만원`, tag: "조사" as const },
    { key: "rent", label: "임차료", amount: run.rent * W, hint: `평당 ${st.rent}만원 × ${cfg.pyeong}평` },
    { key: "mgmt", label: "매장 운영비", amount: rev * (C.TAX + C.OTHER) * W, hint: pctTxt(C.TAX + C.OTHER), tag: "조사" as const,
      kids: [{ label: "세금과 공과 (공과금 포함 추정)", amount: rev * C.TAX * W }, { label: "기타 (홍보비·소모품·수선 등)", amount: rev * C.OTHER * W }] },
    { key: "fees", label: "카드 수수료", amount: rev * C.CARD * W },
  ];
  // cafeRun의 settled와 같은 값 (매출 × (1 − 비율 비용) − 고정비)
  return { revenue: rev * W, rows, op: (rev * (1 - VAR_SHARE) - run.fixed) * W, opLabel: "한 달에 남는 돈" };
}

export default function SettledStack({ stack, note }: { stack: Stack; note: string }) {
  return (
    <div className="cst-check">
      <CostStack stack={stack} head="자리 잡힌 달, 한 달 장부" foot={<>{note} {VAT_NOTE}</>} />
    </div>
  );
}
