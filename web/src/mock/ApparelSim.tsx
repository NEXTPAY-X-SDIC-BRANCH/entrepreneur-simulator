// 옷가게 6개월 시뮬레이션. 화면 틀은 고깃집 시뮬레이션(SimulateEngine.tsx)과 같다:
// 가게(평면)가 화면 전체, 위에 지표 줄, 왼쪽에 현금 그래프와 이달 계획, 오른쪽에 날짜별 영수증, 아래에 재생 막대,
// 운영 계획 → 이달의 사건 → (하루씩 재생) → 정산 → 6개월 성적표는 팝업으로 뜬다.
// 계산은 apparel.ts playMonth (달 단위, 서버 없음). 날짜별 값은 그달 결과를 이 구 옷가게의 요일별 매출 비중(상권분석서비스)으로 나눈 것이다.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  DEFAULT_PLAN, KOSIS, PLAN_TEXT, apStrategies, apparelOpeningCost, eventOf, playMonth, startState,
  type ApMonth, type ApPlan, type ApState, type ApStratId, type ApparelCfg,
} from "./apparel";
import { FloorPlan } from "./ApparelBuild";
import Assume from "./Assume";
import { LOAN_RATE, guStat, man, type Profile } from "./model";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import { CashChart, IconCal, IconCash, IconStar, Metric } from "./SimulateEngine";
import "./simulate-engine.css";

const TURNS = 6;
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
type View = "intro" | "plan" | "scenario" | "settle" | "report" | null;
type Tick = { label: string; amount: number }; // 만원
type Day = { date: Date; tx: number; revenue: number; cogs: number; other: number; ticks: Tick[]; notes: string[]; fixedShare: number; cash: number };
type Done = { m: ApMonth; days: Day[] };
const w = (x: number) => Math.round(x); // 만원
const signed = (x: number) => (w(x) === 0 ? "0원" : `${x > 0 ? "+" : "−"}${man(Math.abs(w(x)))}`);
const tone = (x: number) => (w(x) > 0 ? "pos" : w(x) < 0 ? "neg" : "");

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const IconBox = () => <svg {...ico}><path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z" /><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8" /></svg>;
const IconTrophy = () => <svg {...ico}><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6" /></svg>;

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}

// 한 달 결과를 날짜로 나눈다. 매출·원가·기타경비는 요일 비중대로, 매입·월세·홍보는 1일, 알바 급여는 10일, 생활비·이자는 25일 (고깃집과 같은 날짜)
function buildDays(m: ApMonth, year: number, cashStart: number, dow: number[]): Day[] {
  const n = new Date(year, m.month, 0).getDate();
  const dates = Array.from({ length: n }, (_, i) => new Date(year, m.month - 1, i + 1));
  const wt = (d: Date) => dow[(d.getDay() + 6) % 7] ?? 1 / 7; // dow는 월..일
  const sum = dates.reduce((a, d) => a + wt(d), 0) || 1;
  const fixed = m.rent + m.staffPay + m.draw + m.interest + m.marketing + m.eventCost;
  let cash = cashStart;
  return dates.map((date, i) => {
    const f = wt(date) / sum;
    const revenue = m.revenue * f, cogs = m.cogs * f, other = m.other * f;
    const ticks: Tick[] = [{ label: "매출", amount: revenue }, { label: "기타경비", amount: -other }];
    const notes: string[] = [];
    if (i === 0) {
      if (m.purchase > 0) ticks.push({ label: "옷 매입", amount: -m.purchase });
      ticks.push({ label: "월세", amount: -m.rent });
      if (m.marketing + m.eventCost > 0) ticks.push({ label: "홍보·사건 대응", amount: -(m.marketing + m.eventCost) });
      notes.push(`이달의 사건 · ${m.event} · ${m.choice}`);
    }
    if (i === 9 && m.staffPay > 0) ticks.push({ label: "알바 급여", amount: -m.staffPay });
    if (i === 24) {
      ticks.push({ label: "사장 생활비", amount: -m.draw });
      if (m.interest > 0) ticks.push({ label: "대출 이자", amount: -m.interest });
    }
    cash += ticks.reduce((a, t) => a + t.amount, 0);
    return { date, tx: (revenue * 1e4) / m.ticket, revenue, cogs, other, ticks, notes, fixedShare: fixed / n, cash };
  });
}

export default function ApparelSim({ profile, cfg, onBack }: { profile: Profile; cfg: ApparelCfg; onBack: () => void }) {
  const now = new Date();
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1);
  const [mode, setMode] = useState<"easy" | "hard">("easy");
  const [view, setView] = useState<View>("intro");
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [state, setState] = useState<ApState>(() => startState(profile, cfg));
  const [done, setDone] = useState<Done[]>([]);
  const [plan, setPlan] = useState<ApPlan>({ ...DEFAULT_PLAN, staff: cfg.staff });
  const [strat, setStrat] = useState<ApStratId>("rec");
  const [choice, setChoice] = useState("");
  const [dayIdx, setDayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const [receipt, setReceipt] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  const [top, setTop] = useState(108);
  const st = guStat(profile.gu);
  const open = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const start = useMemo(() => startState(profile, cfg), [profile, cfg]);
  const monthSeq = Array.from({ length: TURNS }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
  const year0 = now.getFullYear() + (startMonth < now.getMonth() + 1 ? 1 : 0);
  const yearOf = (i: number) => year0 + (monthSeq[i] < startMonth ? 1 : 0);
  const months = done.map((x) => x.m);
  const idx = done.length;
  const cur = done.at(-1);
  const m = monthSeq[Math.min(idx, TURNS - 1)];
  const ev = eventOf(m, seed + idx);
  const dep = open.lines.filter((l) => ["interior", "seat", "sign"].includes(l.key)).reduce((a, l) => a + l.amount, 0) / 60; // 5년 감가상각
  const strats = apStrategies(cur?.m, plan);
  const curDay = cur ? cur.days[Math.min(dayIdx, cur.days.length - 1)] : null;

  // 화면을 머리글 아래부터 끝까지 쓴다 (고깃집과 같다)
  useLayoutEffect(() => {
    const measure = () => { const el = document.querySelector(".m-mocknote") ?? document.querySelector(".m-top"); setTop(Math.round(el ? el.getBoundingClientRect().bottom : 108)); };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // 재생: 하루씩, 끝나면 정산
  useEffect(() => {
    if (view !== null || !playing || !cur) return;
    if (dayIdx >= cur.days.length - 1) { setPlaying(false); setView("settle"); return; }
    const t = setTimeout(() => setDayIdx((i) => i + 1), fast ? 60 : 350);
    return () => clearTimeout(t);
  }, [view, playing, fast, dayIdx, cur]);

  const monthlyOut = (ms: ApMonth[]) => ms.reduce((a, x) => a + x.rent + x.staffPay + x.draw + x.interest, 0) / Math.max(1, ms.length);
  const scoreMonths = (ms: ApMonth[]): ScoreMonth[] => ms.map((x) => ({
    month: x.month, revenue: x.revenue * 1e4, op: x.op * 1e4, cogs: x.cogs * 1e4, labor: x.staffPay * 1e4, rent: x.rent * 1e4, mgmt: x.other * 1e4, fees: 0,
    covers: x.tx, walkaways: (x.lost * 1e4) / x.ticket, util: x.sellThrough, fatigue: x.load * 100, closed: x.closed,
    decisions: [{ title: x.event, chosen_label: x.choice, vs_default_op: 0 }],
  }));
  const lowest = () => Math.min(start.cash, ...done.flatMap((x) => x.days.map((d) => d.cash)));
  const score = (ms: ApMonth[]) => scoreOf(scoreMonths(ms), start.cash * 1e4, lowest() * 1e4, (ms.at(-1)?.cash ?? start.cash) * 1e4, monthlyOut(ms) * 1e4, "retail");

  const restart = () => { setState(startState(profile, cfg)); setDone([]); setPlan({ ...DEFAULT_PLAN, staff: cfg.staff }); setSeed(Math.floor(Math.random() * 1000)); setView("intro"); };
  const toScenario = () => {
    const p = mode === "easy" ? strats.find((x) => x.id === strat)!.plan : plan;
    setPlan(p);
    setChoice(ev.options[ev.options.length - 1].id);
    setView("scenario");
  };
  const play = () => {
    const opt = ev.options.find((o) => o.id === choice) ?? ev.options[0];
    const r = playMonth(profile, cfg, state, m, plan, ev, opt);
    const days = buildDays(r.month, yearOf(idx), state.cash, st.dow);
    setDone((d) => [...d, { m: r.month, days }]);
    setState(r.next);
    setDayIdx(0); setPlaying(true); setView(null);
  };
  const skip = () => { if (cur) { setDayIdx(cur.days.length - 1); setPlaying(false); setView("settle"); } };
  const next = () => {
    if (state.closed || done.length >= TURNS) { setView("report"); return; }
    setStrat("rec");
    setView("plan");
  };
  const redo = () => { // 이 달을 계획을 바꿔 다시: 달이 시작될 때의 상태로 돌아간다
    const rest = done.slice(0, -1), prev = rest.at(-1)?.m;
    setDone(rest);
    setState(prev ? { cash: prev.cash, stock: prev.stockEnd, old: prev.oldEnd, awareness: prev.awareness, negMonths: prev.cash < 0 ? 1 : 0, closed: false } : start);
    setView("plan");
  };

  const cashNow = view === null || view === "settle" || view === "report" ? curDay?.cash ?? state.cash : state.cash;
  const people = curDay && view === null ? Math.round(curDay.tx / 2) : 0; // 가게 안 손님 점: 하루 결제 건수의 절반 (그림용)
  const receiptDays = done.flatMap((x, mi) => (mi === done.length - 1 ? x.days.slice(0, dayIdx + 1) : x.days).map((d) => ({ ...d, mi })));
  const sc = months.length ? score(months) : null;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas ap-stage"><FloorPlan pyeong={cfg.pyeong} people={people} /></div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 옷 매입과 월세는 1일, 알바 급여는 10일, 생활비·이자는 25일에 한꺼번에 나가요.</>}>{man(w(cashNow))}</Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 6개월을 한 달씩 진행해요.</>}>
          {view === "intro" ? `${startMonth}월 시작` : `${view === null || view === "settle" || view === "report" ? cur?.m.month ?? m : m}월 · ${Math.min(view === null || view === "settle" || view === "report" ? idx : idx + 1, TURNS)}/${TURNS}`}
        </Metric>
        <Metric icon={<IconBox />} label="재고 (원가)" tip={<>선반 위 옷을 산 값이에요. 많을수록 현금이 묶여요. 시즌이 바뀌면 일부가 철 지난 옷이 돼요<Assume what="시즌마다 재고의 40%가 철 지난 옷" />.</>}>
          {man(w(state.stock))}
        </Metric>
        <Metric icon={<IconStar />} label="인지도" tip={<>1.00이 동네에서 평소 알려진 수준이에요. 새 가게는 0.60에서 시작해 매달 1.00 쪽으로 15%씩 다가가요<Assume what="새 가게 인지도 0.6, 매달 15% 회복 (고깃집 엔진과 같은 가정)" />.</>}>
          {state.awareness.toFixed(2)}
        </Metric>
        <Metric icon={<IconTrophy />} label="지금까지 점수" tip={<>정산마다 다시 매기는 점수예요. 6개월이 끝나면 성적표가 나와요.</>}>
          {sc ? `${sc.total}점` : "-"}
        </Metric>
      </header>

      <button type="button" className="sx-ctoggle" aria-expanded={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? "현금 그래프 접기" : "현금 그래프 펴기"}</button>
      <div className="sx-leftcol">
        {chartOpen && (
          <aside className="sx-chartpanel" aria-label="남은 현금 그래프">
            <p className="sx-panel-h"><span>남은 현금</span><b>{man(w(cashNow))}</b></p>
            <CashChart compact start={start.cash * 1e4} labels={monthSeq}
              months={done.map((x, i) => ({ days: (i === done.length - 1 ? x.days.slice(0, dayIdx + 1) : x.days).map((d) => ({ cash: d.cash * 1e4 })) }))} />
            <small>점선은 문 연 날의 현금, 빨간 선은 0원이에요.</small>
          </aside>
        )}
        {cur && (view === null || view === "settle") && (
          <aside className="sx-planpanel" aria-label={`${cur.m.month}월 운영 계획`}>
            <p className="sx-panel-h"><span>{cur.m.month}월 운영 계획</span></p>
            <dl>
              {(Object.keys(PLAN_TEXT) as (keyof ApPlan)[]).map((k) => {
                const before = done.length > 1 ? done[done.length - 2].m.plan : null;
                return <div key={k} className={before && PLAN_TEXT[k].text(before) !== PLAN_TEXT[k].text(cur.m.plan) ? "is-changed" : undefined}><dt>{PLAN_TEXT[k].label}</dt><dd>{PLAN_TEXT[k].text(cur.m.plan)}</dd></div>;
              })}
              <div><dt>이달의 사건</dt><dd>{cur.m.choice}</dd></div>
            </dl>
            {done.length > 1 && <small><i aria-hidden="true" />파란색은 지난달과 달라진 조건이에요.</small>}
          </aside>
        )}
      </div>

      <button type="button" className="sx-rtoggle" aria-expanded={receipt} onClick={() => setReceipt((v) => !v)}>{receipt ? "현금 흐름 기록 접기" : "현금 흐름 기록 펴기"}</button>
      {receipt && (
        <aside className="sx-receipt" aria-label="현금 흐름 기록">
          <div className="sx-paper">
            <p className="sx-r-title">현금 흐름 영수증</p>
            <p className="sx-r-sub">{profile.gu} 옷가게 · 시작 현금 {man(w(start.cash))}</p>
            <p className="sx-r-acc">회색 줄은 현금이 아니라 이익 계산이에요. '판 옷의 원가'는 미리 사 둔 옷이 팔린 몫, '오늘 몫 고정비'는 월세·급여·생활비 등을 날짜로 나눈 몫이에요. 매일 연다고 봤어요<Assume what="옷가게는 매일 영업" />.</p>
            {receiptDays.length === 0 && <p className="sx-r-empty">아직 찍힌 내역이 없어요. 첫 달이 시작되면 하루씩 쌓여요.</p>}
            {receiptDays.map((x, i) => {
              const dayProfit = x.revenue - x.cogs - x.other - x.fixedShare;
              return (
                <section key={`${x.mi}-${i}`} className="sx-r-day">
                  {(i === 0 || receiptDays[i - 1].mi !== x.mi) && <p className="sx-r-month">{done[x.mi].m.month}월</p>}
                  <p className="sx-r-head"><b>{x.date.getMonth() + 1}/{x.date.getDate()} ({DOW_KO[x.date.getDay()]})</b><span>결제 {Math.round(x.tx)}건</span></p>
                  {x.notes.map((n) => <p key={n} className="sx-r-note">{n}</p>)}
                  <ul>
                    {x.ticks.map((t) => <li key={t.label} className={t.amount >= 0 ? "in" : "out"}><span>{t.label}</span><b>{signed(t.amount)}</b></li>)}
                    <li className="acc"><span>판 옷의 원가</span><b>{signed(-x.cogs)}</b></li>
                    <li className="acc"><span>오늘 몫 고정비</span><b>{signed(-x.fixedShare)}</b></li>
                    <li className={`acc-sum ${dayProfit >= 0 ? "in" : "out"}`}><span>오늘 이익</span><b>{signed(dayProfit)}</b></li>
                  </ul>
                  <p className="sx-r-sum"><span>남은 현금</span><b>{man(w(x.cash))}</b></p>
                </section>
              );
            })}
          </div>
        </aside>
      )}

      {view === null && cur && curDay && (
        <div className="sx-bar" role="toolbar" aria-label="재생 조작">
          <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "멈춤" : "재생"}</button>
          <button type="button" onClick={() => setFast((f) => !f)} aria-pressed={fast}>빠르게</button>
          <button type="button" onClick={skip}>이 달 끝으로</button>
          <span>{cur.m.month}월 {curDay.date.getDate()}일 ({DOW_KO[curDay.date.getDay()]}) · 결제 {Math.round(curDay.tx)}건 · 매출 {man(w(curDay.revenue))}</span>
        </div>
      )}

      {view !== null && (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <div className={`sx-pop sx-pop-${view}`}>

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
                    <h2>이렇게 진행돼요</h2>
                    <ol className="sx-flow">
                      <li><b>운영 계획</b><span>달마다 매입량·할인·알바·홍보를 정해요.</span></li>
                      <li><b>이달의 사건</b><span>시즌 오프, 장마, 경쟁 매장처럼 달력에 맞는 일이 생겨요. 대응을 골라요.</span></li>
                      <li><b>영업</b><span>그달을 하루씩 보여 주고, 영수증에 돈이 들고 나는 게 찍혀요.</span></li>
                      <li><b>정산</b><span>이익과 현금이 왜 다른지, 재고가 얼마나 남았는지 확인해요.</span></li>
                    </ol>
                    <p className="sx-note"><b>옷가게는 재고가 현금을 묶어요.</b> 많이 사 두면 물건은 안 떨어지지만 돈이 선반에 묶이고, 적게 사면 손님을 놓쳐요.
                      {" "}{profile.gu} 일반의류 가게는 1년에 10곳 중 {(st.closure / 10).toFixed(1)}곳이 문을 닫아요 (2025년).</p>
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
                      <h2>{cur ? `${cur.m.month}월 결과` : "처음 여는 달이에요"}</h2>
                      {cur ? (
                        <Kpis items={[
                          { label: "영업이익", value: signed(cur.m.op), tone: tone(cur.m.op), main: true },
                          { label: "매출", value: man(w(cur.m.revenue)) },
                          { label: "놓친 매출", value: man(w(cur.m.lost)) },
                          { label: "남은 재고", value: man(w(cur.m.stockEnd)) },
                        ]} />
                      ) : <p className="sx-note">새 가게라 아직 덜 알려졌어요 (인지도 0.60). 첫 재고 {cfg.stockMonths}개월치 {man(w(state.stock))}로 시작해요.</p>}
                      {cur && <p className="sx-note">{cur.m.lost > cur.m.demand * 0.1 ? `물건이나 일손이 모자라 ${man(w(cur.m.lost))}어치를 못 팔았어요.` : cur.m.stockEnd > cur.m.revenue * KOSIS.cogs * 2 ? "재고가 두 달치 넘게 쌓여 현금이 묶여 있어요." : "재고와 판매가 잘 맞았어요."}</p>}
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
                        <p className="sx-note">자세히 모드에서는 매입량·할인·알바·홍보비를 하나씩 정할 수 있어요.</p>
                      </section>
                    ) : (
                      <section className="sx-right" aria-label="이번 달 운영 계획">
                        <h2>{m}월에 이렇게 할게요</h2>
                        <div className="sx-steps">
                          {([["buy", 0.7, 1.5, 0.1], ["discount", 0, 0.3, 0.05], ["staff", 0, 2, 1], ["marketing", 0, 100, 25]] as [keyof ApPlan, number, number, number][]).map(([k, lo, hi, step]) => {
                            const before = cur?.m.plan;
                            const changed = before && PLAN_TEXT[k].text(before) !== PLAN_TEXT[k].text(plan);
                            return (
                              <div key={k} className={`sx-step${changed ? " is-changed" : ""}`}>
                                <div className="sx-step-t">
                                  <span className="sx-step-l">{PLAN_TEXT[k].label}{PLAN_TEXT[k].hint.includes("가정") && <Assume what={PLAN_TEXT[k].hint} />}</span>
                                  <small>{PLAN_TEXT[k].hint}</small>
                                  {changed && <small className="sx-step-prev">지난달 {PLAN_TEXT[k].text(before!)}</small>}
                                </div>
                                <div className="sx-step-c">
                                  <button type="button" aria-label={`${PLAN_TEXT[k].label} 낮추기`} disabled={plan[k] - step < lo - 1e-9} onClick={() => setPlan({ ...plan, [k]: +(plan[k] - step).toFixed(2) })}>−</button>
                                  <output>{PLAN_TEXT[k].text(plan)}</output>
                                  <button type="button" aria-label={`${PLAN_TEXT[k].label} 높이기`} disabled={plan[k] + step > hi + 1e-9} onClick={() => setPlan({ ...plan, [k]: +(plan[k] + step).toFixed(2) })}>+</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}
                  </div>
                </div>
                <footer className="sx-foot"><button type="button" className="se-btn" onClick={toScenario}>{m}월 시작</button></footer>
              </>
            )}

            {view === "scenario" && (
              <>
                <div className="sx-scroll">
                  <h1>{m}월에 생길 일</h1>
                  <section className="sx-evbox"><h2>이번 달 사건</h2><ul><li><b>{ev.title}</b><span>{ev.prompt}</span></li></ul></section>
                  <section className="sx-sec">
                    <h2>이달의 사건, 어떻게 대응할까요?</h2>
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
              const c = cur.m;
              const gross = c.revenue - c.cogs;
              const pre = c.op - dep - c.interest;
              const why = w(c.op) >= 0 ? (c.lost > c.demand * 0.1 ? "더 팔 수 있었는데 물건이나 일손이 모자랐어요" : "재고와 판매가 잘 맞았어요")
                : c.writeOff > 0 ? "철 지난 옷의 값이 떨어졌어요" : c.revenue < (c.rent + c.staffPay) / (1 - KOSIS.cogs - KOSIS.other) ? "매출이 고정비를 덮지 못했어요" : "할인과 비용이 이익을 깎았어요";
              return (
                <>
                  <div className="sx-scroll">
                    <h1>{c.month}월 정산</h1>
                    <div className={`sc-hero ${w(c.op) >= 0 ? "" : "is-bad"}`}>
                      <h2>{w(c.op) === 0 ? "본전" : c.op > 0 ? "흑자" : "적자"} {signed(c.op)}</h2>
                      <p>{why}.{sc ? ` 지금까지 ${sc.total}점 · ${SCORE_GRADES.find((g) => sc.total >= g.min)!.label}` : ""}</p>
                    </div>
                    <Kpis items={[
                      { label: "매출", value: man(w(c.revenue)) },
                      { label: "옷을 사는 데 쓴 돈", value: man(w(c.purchase)) },
                      { label: "남은 재고 (원가)", value: man(w(c.stockEnd)) },
                      { label: "월말 현금", value: man(w(c.cash)), main: true },
                    ]} />
                    {c.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}
                    <div className="sx-settle">
                      <section className="sx-sec">
                        <h2>정산표</h2>
                        <table className="sx-table"><tbody>
                          <tr><th>매출</th><td>{man(w(c.revenue))}</td><td>결제 약 {Math.round(c.tx).toLocaleString("ko-KR")}건, 한 건 {c.ticket.toLocaleString("ko-KR")}원<Assume what="평수 효과(13평 기준 제곱근), 새 가게 인지도" /></td></tr>
                          <tr><th>매출원가</th><td>−{man(w(c.cogs))}</td><td>판 옷의 원가 (원가율 {Math.round(KOSIS.cogs * 100)}%{c.plan.discount ? `, ${Math.round(c.plan.discount * 100)}% 할인` : ""})</td></tr>
                          <tr className="sub"><th>매출총이익</th><td>{signed(gross)}</td><td /></tr>
                          <tr><th>인건비</th><td>{c.staffPay ? `−${man(w(c.staffPay))}` : "0원"}</td><td>알바 {c.plan.staff}명 (사장 인건비 제외)</td></tr>
                          <tr><th>월세</th><td>−{man(w(c.rent))}</td><td /></tr>
                          <tr><th>기타경비</th><td>−{man(w(c.other))}</td><td>카드 수수료·공과금·포장 등, 매출의 {Math.round(KOSIS.other * 100)}% (도소매업조사)</td></tr>
                          {c.marketing + c.eventCost > 0 && <tr><th>홍보·사건 대응</th><td>−{man(w(c.marketing + c.eventCost))}</td><td /></tr>}
                          {c.writeOff > 0 && <tr><th>재고 평가손</th><td>−{man(w(c.writeOff))}</td><td>철 지난 옷 값이 떨어졌어요<Assume what="철 지난 옷 값 하락 20%" /></td></tr>}
                          <tr className="sum"><th>영업이익</th><td>{signed(c.op)}</td><td>감가상각 전</td></tr>
                          <tr><th>감가상각비</th><td>−{man(w(dep))}</td><td>인테리어·집기·간판을 5년에 나눈 몫. 현금은 안 나가요</td></tr>
                          {c.interest > 0 && <tr><th>이자비용</th><td>−{man(w(c.interest))}</td><td>연 {+(LOAN_RATE * 100).toFixed(2)}%</td></tr>}
                          <tr className="sum"><th>세전이익</th><td>{signed(pre)}</td><td>부가세·소득세는 아직 계산하지 않아요</td></tr>
                        </tbody></table>
                      </section>
                      <section className="sx-sec">
                        <h2>이익과 현금이 다른 이유</h2>
                        <p className="sx-note">이번 달 옷을 사는 데 <b>{man(w(c.purchase))}</b>을 썼지만, 팔린 만큼의 원가 <b>{man(w(c.cogs))}</b>만 비용이 돼요.
                          나머지는 선반 위 재고({man(w(c.stockEnd))})로 남아 현금이 묶여 있어요. 사장 생활비 {man(w(c.draw))}도 현금에서 빠져요.</p>
                        <h2>이번 달 사건</h2>
                        <ul className="sx-evs"><li><b>{c.event}</b><span>고른 대응: {c.choice}</span></li></ul>
                      </section>
                    </div>
                  </div>
                  <footer className="sx-foot">
                    <button type="button" className="se-btn" onClick={next}>{c.closed || done.length >= TURNS ? "6개월 결과 보기" : `${monthSeq[done.length]}월 운영 계획`}</button>
                    <button type="button" className="se-link" onClick={redo}>이 달을 계획을 바꿔 다시</button>
                  </footer>
                </>
              );
            })()}

            {view === "report" && (
              <>
                <div className="sx-scroll">
                  <h1>{done.length}개월 결과</h1>
                  <Scorecard
                    months={scoreMonths(months)} startCash={start.cash * 1e4} lowestCash={lowest() * 1e4}
                    endCash={(months.at(-1)?.cash ?? start.cash) * 1e4} monthlyCashOut={monthlyOut(months) * 1e4} gu={profile.gu} mode={mode} kind="retail" shop="옷가게" seed={seed}
                    benchmark={`참고로 서울에서 새로 연 도소매업 가게는 1년 뒤 ${KOSIS.survival1}%, 3년 뒤 ${KOSIS.survival3}%만 남아요 (통계청 기업생멸행정통계 2023년).`}
                  />
                  <section className="sx-sec"><h2>남은 현금</h2>
                    <CashChart start={start.cash * 1e4} labels={monthSeq} months={done.map((x) => ({ days: x.days.map((d) => ({ cash: d.cash * 1e4 })) }))} />
                  </section>
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
        </div>
      )}
    </div>
  );
}
