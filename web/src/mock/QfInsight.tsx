// 치킨·분식 달 정산의 '다음 달에 고칠 것'. 이번 달과 똑같은 조건(월초 상태·사건·대응)에서 계획 한 가지만 바꿔 다시 계산해,
// 영업이익이 가장 많이 늘어나는 것 세 개를 보여 준다. 모델이 결정적이라 같은 조건이면 같은 값이 나온다.
import { man, type Profile } from "./model";
import {
  EXTRAS, HOURS_DEFAULT, HOURS_RANGE, MAIN, clock, extraPrice, mainPrice, mixOf, mixStr, playMonth,
  type QfCfg, type QfEvent, type QfMonth, type QfOption, type QfPlan, type QfState,
} from "./quickfood";

type Try = { title: string; why: string; patch: Partial<QfPlan>; d: number };

export function qfTries(profile: Profile, cfg: QfCfg, s0: QfState, c: QfMonth, ev: QfEvent, opt: QfOption, seats: number): Try[] {
  const p = c.plan, ind = cfg.ind;
  const run = (patch: Partial<QfPlan>) => playMonth(profile, cfg, s0, c.month, { ...p, ...patch }, ev, opt, seats).month.op;
  const base = run({});
  const lostN = Math.round((c.lost * 1e4) / c.ticket);
  const out: Omit<Try, "d">[] = [];
  if (p.staff < 6) out.push({ title: `알바 ${p.staff + 1}명으로 늘리기`, why: lostN > 0 ? `일손이 모자라 주문 ${lostN}건을 놓쳤어요.` : "몰리는 날 주문을 더 받을 수 있어요.", patch: { staff: p.staff + 1 } });
  if (p.staff > 0) out.push({ title: `알바 ${p.staff - 1}명으로 줄이기`, why: `일손이 ${Math.round(c.load * 100)}%만 쓰였어요. 인건비를 아껴요.`, patch: { staff: p.staff - 1 } });
  const step = ind === "chicken" ? 1000 : 500, mp = mainPrice(ind, p);
  out.push({ title: `${MAIN[ind].name} ${(mp + step).toLocaleString("ko-KR")}원으로 올리기`, why: "한 건 값이 늘어요. 주문은 조금 줄어요.", patch: { price: +((mp + step) / MAIN[ind].p0).toFixed(4) } });
  if (mp - step > MAIN[ind].p0 * 0.5) out.push({ title: `${MAIN[ind].name} ${(mp - step).toLocaleString("ko-KR")}원으로 내리기`, why: "주문이 늘어요. 한 건에 남는 돈은 줄어요.", patch: { price: +((mp - step) / MAIN[ind].p0).toFixed(4) } });
  const mx = mixOf(ind, p);
  const fees = c.appFees + c.agencyFees;
  if (mx.delivery >= 10) {
    const n = { ...mx, delivery: mx.delivery - 10, takeout: mx.takeout + 10 };
    out.push({ title: `배달 비중 ${mx.delivery}% → ${n.delivery}%, 포장으로 돌리기`, why: `이번 달 배달 수수료로 ${man(Math.round(fees))}이 나갔어요. 포장은 수수료가 없어요.`, patch: { mix: mixStr(n) } });
  }
  if (mx.delivery <= 80) {
    const big = mx.visit >= mx.takeout ? "visit" : "takeout";
    const n = { ...mx, delivery: mx.delivery + 10, [big]: mx[big] - 10 };
    out.push({ title: `배달 비중 ${mx.delivery}% → ${n.delivery}%로 키우기`, why: "배달 주문을 더 받아요. 한 건마다 수수료는 빠져요.", patch: { mix: mixStr(n) } });
  }
  if (p.ad > 0) out.push({ title: "배달앱 광고 한 단계 줄이기", why: `광고비 ${man(c.adCost)}만큼 배달 주문이 늘었는지 봐요.`, patch: { ad: p.ad - 1 } });
  if (p.ad < 2) out.push({ title: "배달앱 광고 한 단계 늘리기", why: "배달 주문이 늘지만 광고비가 나가요.", patch: { ad: p.ad + 1 } });
  const close = p.close ?? HOURS_DEFAULT[ind].close, open = p.open ?? HOURS_DEFAULT[ind].open, R = HOURS_RANGE[ind];
  if (close + 1 <= R.close[1]) out.push({ title: `${clock(close + 1)}까지 열기`, why: ind === "chicken" ? "야식 주문을 더 받아요. 알바비·공과금이 늘어요." : "저녁 손님을 더 받아요. 알바비·공과금이 늘어요.", patch: { close: close + 1 } });
  if (close - 1 >= R.close[0] && close - 1 - open >= 6) out.push({ title: `${clock(close - 1)}에 닫기`, why: "손님이 적은 늦은 시간의 알바비·공과금을 아껴요.", patch: { close: close - 1 } });
  if ((p.pickup ?? 0) < 0.1) out.push({ title: "포장 손님 10% 할인", why: "배달 수수료가 없는 포장 주문이 늘어요.", patch: { pickup: 0.1 } });
  if (c.awareness < 1 && p.marketing < 100) out.push({ title: `SNS 홍보 ${p.marketing + 50}만원`, why: `아직 인지도가 ${c.awareness.toFixed(2)}이에요. 알려지면 다음 달부터 손님이 늘어요.`, patch: { marketing: p.marketing + 50 } });
  for (const e of EXTRAS[ind]) {
    const v = extraPrice(e, p);
    if (v > 0 && v + 500 <= e.max) out.push({ title: `${e.name.split(" (")[0]} ${(v + 500).toLocaleString("ko-KR")}원으로`, why: "곁들임 값을 조금 올려요. 같이 시키는 손님이 조금 줄어요.", patch: { extras: { ...(p.extras ?? {}), [e.key]: v + 500 } } });
  }
  return out.map((x) => ({ ...x, d: run(x.patch) - base })).filter((x) => x.d >= 3).sort((a, b) => b.d - a.d);
}

export default function QfInsight({ tries, onApply, last }: { tries: Try[]; onApply: (patch: Partial<QfPlan>) => void; last: boolean }) {
  const top = tries.slice(0, 3);
  return (
    <section className="ins" aria-labelledby="ins-h">
      <h2 id="ins-h">다음 달에 이렇게 바꿔 보세요</h2>
      <p className="ins-sub">이번 달과 같은 날씨·사건·손님 조건에서 한 가지만 바꿔 다시 계산했어요. 영업이익이 많이 느는 순서예요.</p>
      {top.length ? (
        <ol className="ins-list">
          {top.map((t, i) => (
            <li key={t.title} className="ins-card">
              <span className="ins-n" aria-hidden>{i + 1}</span>
              <div className="ins-b">
                <b>{t.title}</b>
                <small>{t.why}</small>
              </div>
              <strong className="ins-d">+{man(Math.round(t.d))}<small>/월</small></strong>
              {!last && <button type="button" className="ins-go" onClick={() => onApply(t.patch)}>다음 달에 적용</button>}
            </li>
          ))}
        </ol>
      ) : <p className="ins-none">한 가지만 바꿔서는 이번 달보다 나아지는 게 없었어요. 지금 계획이 이 조건에서 잘 맞아요.</p>}
    </section>
  );
}
