// 옷가게 6개월 시뮬레이션: 운영 계획(쉬운 모드는 방향 카드, 자세히 모드는 하나씩) → 이달의 사건 → 정산 → 6개월 성적표.
// 계산은 apparel.ts playMonth (달 단위, 서버 없음). 화면 모양은 고깃집 시뮬레이션(simulate-engine.css)의 팝업 카드를 쓴다.
import { useMemo, useState } from "react";
import {
  DEFAULT_PLAN, KOSIS, PLAN_TEXT, apStrategies, apparelOpeningCost, eventOf, playMonth, startState,
  type ApMonth, type ApPlan, type ApState, type ApStratId, type ApparelCfg,
} from "./apparel";
import { LOAN_RATE, guStat, man, type Profile } from "./model";
import Assume from "./Assume";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import "./simulate-engine.css";

const TURNS = 6;
type View = "intro" | "plan" | "event" | "settle" | "report";
const w = (x: number) => Math.round(x); // 만원
const signed = (x: number) => (w(x) === 0 ? "0원" : `${x > 0 ? "+" : "−"}${man(Math.abs(w(x)))}`);
const tone = (x: number) => (x > 0 ? "pos" : x < 0 ? "neg" : "");

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}

function CashBars({ start, months, labels }: { start: number; months: ApMonth[]; labels: number[] }) {
  const vals = [start, ...months.map((m) => m.cash)];
  const hi = Math.max(1, ...vals.map(Math.abs));
  return (
    <div className="ap-bars" role="img" aria-label="달마다 남은 현금">
      {vals.map((v, i) => (
        <div key={i} className="ap-bar">
          <span className={v < 0 ? "neg" : ""} style={{ height: `${(Math.abs(v) / hi) * 100}%` }} />
          <small>{i === 0 ? "시작" : `${labels[i - 1]}월`}</small>
          <b>{man(w(v))}</b>
        </div>
      ))}
    </div>
  );
}

export default function ApparelSim({ profile, cfg, onBack }: { profile: Profile; cfg: ApparelCfg; onBack: () => void }) {
  const now = new Date();
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1);
  const [mode, setMode] = useState<"easy" | "hard">("easy");
  const [view, setView] = useState<View>("intro");
  const [seed] = useState(() => Math.floor(Math.random() * 1000));
  const [state, setState] = useState<ApState>(() => startState(profile, cfg));
  const [months, setMonths] = useState<ApMonth[]>([]);
  const [plan, setPlan] = useState<ApPlan>({ ...DEFAULT_PLAN, staff: cfg.staff });
  const [strat, setStrat] = useState<ApStratId>("rec");
  const [choice, setChoice] = useState<string>("");
  const st = guStat(profile.gu);
  const open = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const start = useMemo(() => startState(profile, cfg), [profile, cfg]);
  const monthSeq = Array.from({ length: TURNS }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
  const idx = months.length;
  const cur = months.at(-1);
  const m = monthSeq[Math.min(idx, TURNS - 1)];
  const ev = eventOf(m, seed + idx);
  const dep = (open.lines.filter((l) => ["interior", "seat", "sign"].includes(l.key)).reduce((a, l) => a + l.amount, 0)) / 60; // 5년 감가상각
  const strats = apStrategies(cur, plan);
  const monthlyOut = (ms: ApMonth[]) => ms.reduce((a, x) => a + x.rent + x.staffPay + x.draw + x.interest, 0) / Math.max(1, ms.length);
  const scoreMonths = (ms: ApMonth[]): ScoreMonth[] => ms.map((x) => ({
    month: x.month, revenue: x.revenue * 1e4, op: x.op * 1e4, cogs: x.cogs * 1e4, labor: x.staffPay * 1e4, rent: x.rent * 1e4, mgmt: x.other * 1e4, fees: 0,
    covers: x.tx, walkaways: (x.lost * 1e4) / x.ticket, util: x.sellThrough, fatigue: x.load * 100, closed: x.closed,
    decisions: [{ title: x.event, chosen_label: x.choice, vs_default_op: 0 }],
  }));
  const score = (ms: ApMonth[]) => scoreOf(scoreMonths(ms), start.cash * 1e4, Math.min(start.cash, ...ms.map((x) => x.cash)) * 1e4, (ms.at(-1)?.cash ?? start.cash) * 1e4, monthlyOut(ms) * 1e4, "retail");

  const restart = () => { setState(startState(profile, cfg)); setMonths([]); setPlan({ ...DEFAULT_PLAN, staff: cfg.staff }); setView("intro"); };
  const toEvent = () => {
    const p = mode === "easy" ? strats.find((x) => x.id === strat)!.plan : plan;
    setPlan(p);
    setChoice(ev.options[ev.options.length - 1].id);
    setView("event");
  };
  const play = () => {
    const opt = ev.options.find((o) => o.id === choice) ?? ev.options[0];
    const r = playMonth(profile, cfg, state, m, plan, ev, opt);
    setMonths((ms) => [...ms, r.month]);
    setState(r.next);
    setView("settle");
  };
  const next = () => {
    if (state.closed || months.length >= TURNS) { setView("report"); return; }
    setStrat("rec");
    setView("plan");
  };

  const hud = (
    <dl className="sx-kpis ap-hud">
      <div className="main"><dt>현금</dt><dd className={state.cash < 0 ? "neg" : ""}>{man(w(state.cash))}</dd></div>
      <div><dt>달</dt><dd>{view === "intro" ? `${startMonth}월 시작` : `${view === "settle" || view === "report" ? cur?.month ?? m : m}월 · ${Math.min(view === "settle" || view === "report" ? idx : idx + 1, TURNS)}/${TURNS}`}</dd></div>
      <div><dt>재고 (원가)</dt><dd>{man(w(state.stock))}{state.old > 1 ? <small> 철 지난 {man(w(state.old))}</small> : null}</dd></div>
      <div><dt>인지도</dt><dd>{state.awareness.toFixed(2)}</dd></div>
      {months.length > 0 && (() => { const s = score(months); return <div><dt>지금까지 점수</dt><dd>{s.total}점 · {SCORE_GRADES.find((g) => s.total >= g.min)!.label}</dd></div>; })()}
    </dl>
  );

  return (
    <main className="ap-sim">
      {hud}
      <div className="sx-pop ap-card">
        {view === "intro" && (
          <>
            <div className="sx-scroll">
              <h1>{profile.gu}에서 옷가게 6개월</h1>
              <Kpis items={[
                { label: "가게", value: `${cfg.pyeong}평 · 알바 ${cfg.staff}명` },
                { label: "평당 월세", value: `${st.rent}만원` },
                { label: "여는 데 든 돈", value: man(open.total) },
                { label: "남은 운영자금", value: man(w(start.cash)), main: true },
              ]} />
              <section className="sx-sec">
                <h2>이 게임에서 배울 것</h2>
                <p className="sx-note"><b>옷가게는 재고가 현금을 묶어요.</b> 많이 사 두면 물건은 안 떨어지지만 돈이 선반에 묶이고, 적게 사면 손님을 놓쳐요.
                  계절이 바뀌면 남은 옷은 철 지난 옷이 되어 세일로 털어야 해요. 서울 일반의류 가게는 1년에 10곳 중 {(st.closure / 10).toFixed(1)}곳이 문을 닫아요 ({profile.gu}, 2025년).</p>
              </section>
              <fieldset className="sx-mode">
                <legend>어떻게 해 볼까요?</legend>
                <label className={mode === "easy" ? "on" : ""}>
                  <input type="radio" name="ap-mode" checked={mode === "easy"} onChange={() => setMode("easy")} />
                  <span><b>쉬운 모드</b><small>달마다 방향만 골라요: 추천대로 / 손님 늘리기 / 비용 아끼기. 이달의 사건 대응도 골라요.</small></span>
                </label>
                <label className={mode === "hard" ? "on" : ""}>
                  <input type="radio" name="ap-mode" checked={mode === "hard"} onChange={() => setMode("hard")} />
                  <span><b>자세히 모드</b><small>달마다 매입량·할인·알바·홍보비를 하나씩 정해요.</small></span>
                </label>
              </fieldset>
              <label className="sx-field">시작할 달
                <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((x) => <option key={x} value={x}>{x}월</option>)}
                </select>
                <small>계절 효과는 {profile.gu} 일반의류의 분기별 매출 지수(2025년)예요: {st.qidx.map((x, i) => `${i + 1}분기 ${x.toFixed(2)}`).join(" · ")}</small>
              </label>
            </div>
            <footer className="sx-foot">
              <button type="button" className="se-btn" onClick={() => setView("plan")}>문 열기</button>
              <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로 돌아가기</button>
            </footer>
          </>
        )}

        {view === "plan" && (
          <>
            <div className="sx-scroll">
              <h1>{m}월 운영 계획</h1>
              <div className="sx-split">
                <section className="sx-left" aria-label="지난달 결과">
                  <h2>{cur ? `${cur.month}월 결과` : "처음 여는 달이에요"}</h2>
                  {cur ? (
                    <Kpis items={[
                      { label: "영업이익", value: signed(cur.op), tone: tone(cur.op), main: true },
                      { label: "매출", value: man(w(cur.revenue)) },
                      { label: "놓친 매출", value: man(w(cur.lost)) },
                      { label: "남은 재고", value: man(w(cur.stockEnd)) },
                    ]} />
                  ) : <p className="sx-note">새 가게라 아직 덜 알려졌어요 (인지도 0.60). 첫 재고 {cfg.stockMonths}개월치 {man(w(state.stock))}로 시작해요.</p>}
                  {cur && <p className="sx-note">{cur.lost > cur.demand * 0.1 ? `물건이나 일손이 모자라 ${man(w(cur.lost))}어치를 못 팔았어요.` : cur.stockEnd > cur.revenue * KOSIS.cogs * 2 ? "재고가 두 달치 넘게 쌓여 현금이 묶여 있어요." : "재고와 판매가 잘 맞았어요."}</p>}
                </section>
                {mode === "easy" ? (
                  <section className="sx-right" aria-label="이번 달 방향">
                    <h2>{m}월, 어느 쪽으로 갈까요?</h2>
                    <div className="sx-strats" role="radiogroup">
                      {strats.map((x) => (
                        <label key={x.id} className={strat === x.id ? "on" : ""}>
                          <input type="radio" name="ap-strat" checked={strat === x.id} onChange={() => setStrat(x.id)} />
                          <span className="sx-strat"><b>{x.title}</b><small>{x.desc}</small><span className="sx-strat-chg">{x.changes.length ? x.changes.join(" · ") : "지난달과 같아요"}</span></span>
                        </label>
                      ))}
                    </div>
                  </section>
                ) : (
                  <section className="sx-right" aria-label="이번 달 운영 계획">
                    <h2>{m}월에 이렇게 할게요</h2>
                    <div className="sx-steps">
                      {([
                        ["buy", 0.7, 1.5, 0.1], ["discount", 0, 0.3, 0.05], ["staff", 0, 2, 1], ["marketing", 0, 100, 25],
                      ] as [keyof ApPlan, number, number, number][]).map(([k, lo, hi, step]) => (
                        <div key={k} className="sx-step">
                          <div className="sx-step-t"><span className="sx-step-l">{PLAN_TEXT[k].label}{PLAN_TEXT[k].hint.includes("가정") && <Assume what={PLAN_TEXT[k].hint} />}</span><small>{PLAN_TEXT[k].hint}</small></div>
                          <div className="sx-step-c">
                            <button type="button" aria-label={`${PLAN_TEXT[k].label} 낮추기`} disabled={plan[k] - step < lo - 1e-9} onClick={() => setPlan({ ...plan, [k]: +(plan[k] - step).toFixed(2) })}>−</button>
                            <output>{PLAN_TEXT[k].text(plan)}</output>
                            <button type="button" aria-label={`${PLAN_TEXT[k].label} 높이기`} disabled={plan[k] + step > hi + 1e-9} onClick={() => setPlan({ ...plan, [k]: +(plan[k] + step).toFixed(2) })}>+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
            <footer className="sx-foot"><button type="button" className="se-btn" onClick={toEvent}>{m}월 시작</button></footer>
          </>
        )}

        {view === "event" && (
          <>
            <div className="sx-scroll">
              <h1>{m}월에 생길 일</h1>
              <section className="sx-evbox"><h2>{ev.title}</h2><p className="sx-note">{ev.prompt}</p></section>
              <section className="sx-sec">
                <h2>어떻게 대응할까요?</h2>
                <p className="sx-note">사장님의 선택이 이번 달 이익과 재고를 바꿔요. 장점(+)과 단점(−)을 보고 하나를 골라 주세요. {ev.note}.<Assume what={`${ev.title}의 효과 크기 (${ev.note})`} /></p>
              </section>
              <div className="sx-dps is-single">
                <div className="sx-dp" role="radiogroup" aria-label={ev.title}>
                  <header className="sx-dp-h"><span className="sx-clock">{m}월</span><h3>{ev.title}</h3></header>
                  <div className="sx-dp-opts">
                    {ev.options.map((o) => (
                      <label key={o.id} className={choice === o.id ? "on" : ""}>
                        <input type="radio" name="ap-ev" checked={choice === o.id} onChange={() => setChoice(o.id)} />
                        <span className="sx-opt"><span className="sx-opt-h"><b>{o.label}</b></span><span className="sx-pro">{o.pro}</span><span className="sx-con">{o.con}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <footer className="sx-foot">
              <button type="button" className="se-btn" onClick={play}>{m}월 영업 시작</button>
              <button type="button" className="se-link" onClick={() => setView("plan")}>운영 계획으로 돌아가기</button>
            </footer>
          </>
        )}

        {view === "settle" && cur && (() => {
          const gross = cur.revenue - cur.cogs;
          const pre = cur.op - dep - cur.interest;
          const s = score(months);
          const why = cur.op >= 0 ? (cur.lost > cur.demand * 0.1 ? "더 팔 수 있었는데 물건이나 일손이 모자랐어요" : "재고와 판매가 잘 맞았어요")
            : cur.writeOff > 0 ? "철 지난 옷의 값이 떨어졌어요" : cur.revenue < (cur.rent + cur.staffPay) / (1 - KOSIS.cogs - KOSIS.other) ? "매출이 고정비를 덮지 못했어요" : "할인과 비용이 이익을 깎았어요";
          return (
            <>
              <div className="sx-scroll">
                <div className={`sc-hero ${w(cur.op) >= 0 ? "" : "is-bad"}`}>
                  <h2>{cur.month}월 {w(cur.op) === 0 ? "본전" : cur.op > 0 ? "흑자" : "적자"} {signed(cur.op)}</h2>
                  <p>{why}. 지금까지 {s.total}점 · {SCORE_GRADES.find((g) => s.total >= g.min)!.label}</p>
                </div>
                <Kpis items={[
                  { label: "매출", value: man(w(cur.revenue)) },
                  { label: "옷을 사는 데 쓴 돈", value: man(w(cur.purchase)) },
                  { label: "남은 재고 (원가)", value: man(w(cur.stockEnd)) },
                  { label: "월말 현금", value: man(w(cur.cash)), main: true },
                ]} />
                {cur.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}
                <div className="sx-settle">
                  <section className="sx-sec">
                    <h2>정산표 (손익계산서 순서)</h2>
                    <table className="sx-table"><tbody>
                      <tr><th>매출</th><td>{man(w(cur.revenue))}</td><td><Assume what="평수 효과(13평 기준 제곱근), 새 가게 인지도 0.6에서 매달 15%씩 회복" /> 결제 약 {Math.round(cur.tx).toLocaleString("ko-KR")}건, 한 건 {cur.ticket.toLocaleString("ko-KR")}원</td></tr>
                      <tr><th>매출원가</th><td>−{man(w(cur.cogs))}</td><td>판 옷의 원가 (원가율 {Math.round(KOSIS.cogs * 100)}%{cur.plan.discount ? `, ${Math.round(cur.plan.discount * 100)}% 할인` : ""})</td></tr>
                      <tr className="sub"><th>매출총이익</th><td>{signed(gross)}</td><td /></tr>
                      <tr><th>인건비</th><td>{cur.staffPay ? `−${man(w(cur.staffPay))}` : "0원"}</td><td>알바 {cur.plan.staff}명 (사장 인건비 제외)</td></tr>
                      <tr><th>월세</th><td>−{man(w(cur.rent))}</td><td /></tr>
                      <tr><th>기타경비</th><td>−{man(w(cur.other))}</td><td>카드 수수료·공과금·포장 등, 매출의 {Math.round(KOSIS.other * 100)}% (도소매업조사)</td></tr>
                      {cur.marketing + cur.eventCost > 0 && <tr><th>홍보·사건 대응</th><td>−{man(w(cur.marketing + cur.eventCost))}</td><td /></tr>}
                      {cur.writeOff > 0 && <tr><th>재고 평가손</th><td>−{man(w(cur.writeOff))}</td><td>철 지난 옷 값이 20% 떨어졌어요<Assume what="철 지난 옷 값 하락 20%, 시즌마다 재고의 40%가 철 지난 옷이 됨" /></td></tr>}
                      <tr className="sum"><th>영업이익</th><td>{signed(cur.op)}</td><td>감가상각 전</td></tr>
                      <tr><th>감가상각비</th><td>−{man(w(dep))}</td><td>인테리어·집기·간판을 5년에 나눈 몫. 현금은 안 나가요</td></tr>
                      {cur.interest > 0 && <tr><th>이자비용</th><td>−{man(w(cur.interest))}</td><td>연 {+(LOAN_RATE * 100).toFixed(2)}%</td></tr>}
                      <tr className="sum"><th>세전이익</th><td>{signed(pre)}</td><td>부가세·소득세는 아직 계산하지 않아요</td></tr>
                    </tbody></table>
                  </section>
                  <section className="sx-sec">
                    <h2>이익과 현금이 다른 이유</h2>
                    <p className="sx-note">이번 달 옷을 사는 데 <b>{man(w(cur.purchase))}</b>을 썼지만, 팔린 만큼의 원가 <b>{man(w(cur.cogs))}</b>만 비용이 돼요.
                      나머지는 선반 위 재고({man(w(cur.stockEnd))})로 남아 현금이 묶여 있어요. 사장 생활비 {man(w(cur.draw))}도 현금에서 빠져요.</p>
                    <h2>이번 달 사건</h2>
                    <p className="sx-note"><b>{cur.event}</b> · 고른 대응: {cur.choice}</p>
                  </section>
                </div>
                <section className="sx-sec"><h2>남은 현금</h2><CashBars start={start.cash} months={months} labels={monthSeq} /></section>
              </div>
              <footer className="sx-foot">
                <button type="button" className="se-btn" onClick={next}>{cur.closed || months.length >= TURNS ? "6개월 결과 보기" : `${monthSeq[months.length]}월 운영 계획`}</button>
              </footer>
            </>
          );
        })()}

        {view === "report" && (
          <>
            <div className="sx-scroll">
              <h1>{months.length}개월 결과</h1>
              <Scorecard
                months={scoreMonths(months)} startCash={start.cash * 1e4} lowestCash={Math.min(start.cash, ...months.map((x) => x.cash)) * 1e4}
                endCash={(months.at(-1)?.cash ?? start.cash) * 1e4} monthlyCashOut={monthlyOut(months) * 1e4} gu={profile.gu} mode={mode} kind="retail" shop="옷가게"
                benchmark={`참고로 서울에서 새로 연 도소매업 가게는 1년 뒤 ${KOSIS.survival1}%, 3년 뒤 ${KOSIS.survival3}%만 남아요 (통계청 기업생멸행정통계 2023년).`}
              />
              <section className="sx-sec"><h2>남은 현금</h2><CashBars start={start.cash} months={months} labels={monthSeq} /></section>
              <section className="sx-sec">
                <h2>달마다</h2>
                <table className="sx-table">
                  <thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>사건 · 대응</th><th>월말 재고</th><th>월말 현금</th></tr></thead>
                  <tbody>{months.map((x) => (
                    <tr key={x.month}><td>{x.month}월</td><td>{man(w(x.revenue))}</td><td className={tone(x.op)}>{signed(x.op)}</td><td>{x.event} · {x.choice}</td><td>{man(w(x.stockEnd))}</td><td>{man(w(x.cash))}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            </div>
            <footer className="sx-foot">
              <button type="button" className="se-btn" onClick={restart}>처음부터 다시</button>
              <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로</button>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
