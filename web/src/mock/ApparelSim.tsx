// 옷가게 6개월 시뮬레이션. 화면 틀은 고깃집 시뮬레이션(SimulateEngine.tsx)과 같다:
// 가게(평면)가 화면 전체, 위에 지표 줄, 왼쪽에 현금 그래프와 이달 계획, 오른쪽에 날짜별 영수증, 아래에 재생 막대,
// 운영 계획 → 이달의 사건 → (하루씩 재생) → 정산 → 6개월 성적표는 팝업으로 뜬다.
// 계산은 apparel.ts playMonth (달 단위, 서버 없음). 날짜별 값은 그달 결과를 이 구 옷가게의 요일별 매출 비중(상권분석서비스)으로 나눈 것이다.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  BUY_MODES, CATS, MARKET, ONLINE, PAPER_SELL, DEFAULT_PLAN, KOSIS, OLD_AGE, PLAN_TEXT, apStrategies, apparelOpeningCost, eventOf, invOf, invTotal, mixOf,
  playMonth, startState, stateAfter, stockValue,
  type ApMonth, type ApPlan, type ApState, type ApStratId, type ApparelCfg, type Cat,
} from "./apparel";
import ShopRoom3D from "./ShopRoom3D";
import Assume from "./Assume";
import QuickPicks, { type Pick as QPick } from "./QuickPicks";
import { LOAN_RATE, guStat, man, type Profile } from "./model";
import ModeSwitch from "./ModeSwitch";
import CashFlow, { type CfMonth } from "./CashFlow";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import { CashChart, IconCal, IconCash, IconStar, Metric } from "./SimulateEngine";
import "./simulate-engine.css";

const TURNS = 6;
// easy 모드: 방향을 고른 뒤 버튼으로 바꾸는 세 가지
const PICKS: QPick<ApPlan>[] = [
  { key: "buy", label: "매입량", hint: "많이 사면 사이즈가 덜 빠지고, 적게 사면 현금이 남아요", opts: [{ label: "적게", value: 0.8 }, { label: "보통", value: 1 }, { label: "많이", value: 1.2 }] },
  { key: "markdownAge", label: "세일 시작", hint: "일찍 세일하면 돈이 빨리 돌고, 늦으면 정가로 더 팔아요", opts: [{ label: "2달 지나면", value: 2 }, { label: "3달", value: 3 }, { label: "4달", value: 4 }] },
  { key: "focus", label: "더 들일 품목", hint: "이번 시즌에 잘 나갈 품목을 더 사 둬요", opts: [{ label: "고르게", value: "none" }, ...CATS.map((c) => ({ label: c.label, value: c.id }))] },
  { key: "online", label: "온라인 판매", hint: "같은 재고를 온라인으로도 팔아요 (수수료·택배비)", opts: [{ label: "안 함", value: 0 }, { label: "스마트스토어", value: 1 }, { label: "플랫폼 입점", value: 2 }] },
  { key: "staff", label: "알바", hint: "손님이 몰리는 날 응대와 피팅을 도와요", opts: [0, 1, 2].map((n) => ({ label: n ? `${n}명` : "없이", value: n })) },
];
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
      if (m.purchase > 0) ticks.push({ label: m.ordered ? "옷 매입 (석 달치 선발주)" : "옷 매입", amount: -m.purchase });
      ticks.push({ label: "월세", amount: -m.rent });
      if (m.marketing + m.eventCost > 0) ticks.push({ label: "홍보·사건 대응", amount: -(m.marketing + m.eventCost) });
      if (m.onlineCost > 0) ticks.push({ label: "온라인 수수료·택배", amount: -m.onlineCost });
      notes.push(`이달의 사건 · ${m.event} · ${m.choice}`);
    }
    if (i === 9 && m.staffPay > 0) ticks.push({ label: "알바 급여", amount: -m.staffPay });
    if (i === 24) {
      if (m.settle > 0) ticks.push({ label: "위탁 옷값 정산", amount: -m.settle });
      ticks.push({ label: "사장 생활비", amount: -m.draw });
      if (m.interest > 0) ticks.push({ label: "대출 이자", amount: -m.interest });
    }
    cash += ticks.reduce((a, t) => a + t.amount, 0);
    return { date, tx: (revenue * 1e4) / m.ticket, revenue, cogs, other, ticks, notes, fixedShare: fixed / n, cash };
  });
}

// 월초 재고: 품목마다 새 옷과 석 달 넘은 옷, 이달 팔릴 비중. 금액은 원가 기준 (위탁은 도매상 옷값)
function InvTable({ state, month, cfg }: { state: ApState; month: number; cfg: ApparelCfg }) {
  const mix = mixOf(month), k = cfg.buyMode === "consign" ? BUY_MODES.consign.cost : state.costAvg;
  return (
    <table className="sx-table ap-inv">
      <thead><tr><th>{month}월 시작 재고</th><th>이달 비중</th><th>새 옷</th><th>석 달 넘은 옷</th></tr></thead>
      <tbody>{CATS.map((c) => {
        const fresh = invOf(state.inv, c.id, 0, OLD_AGE) * k, old = invOf(state.inv, c.id, OLD_AGE) * k;
        return <tr key={c.id}><th>{c.label}</th><td>{Math.round(mix[c.id] * 100)}%</td><td>{man(w(fresh))}</td><td className={old > 0 && old > fresh * 0.5 ? "neg" : ""}>{man(w(old))}</td></tr>;
      })}</tbody>
    </table>
  );
}
// 정산의 품목별 표: 찾는 사이즈가 있던 손님 비율, 정가·세일로 판 양, 결품으로 놓친 매출, 남은 재고
function CatTable({ c }: { c: ApMonth }) {
  const k = c.buyMode === "consign" ? BUY_MODES.consign.cost : c.costAvg;
  return (
    <>
      <table className="sx-table ap-inv">
        <thead><tr><th>품목</th><th>사이즈 맞은 손님</th><th>판 옷 (원가)</th><th>사이즈 없어 놓친 매출</th><th>남은 재고</th></tr></thead>
        <tbody>{CATS.map(({ id, label }) => {
          const x = c.cats[id];
          return (
            <tr key={id}><th>{label}</th><td>{Math.round(x.fill * 100)}%</td>
              <td>{man(w((x.sold + x.mdSold) * k))}{x.mdSold * k >= 1 ? ` (세일 ${man(w(x.mdSold * k))})` : ""}</td>
              <td className={x.lostStock > x.demand * 0.15 ? "neg" : ""}>{man(w(x.lostStock))}</td>
              <td>{man(w(x.stock * k))}{x.old * k >= 1 ? ` (석 달+ ${man(w(x.old * k))})` : ""}</td></tr>
          );
        })}</tbody>
      </table>
      <p className="sx-note">재고가 한 달 팔 양만큼 있어도 사이즈·색이 다 맞지는 않아 찾는 옷이 있는 손님은 86%예요. 1.5달치면 95%, 반 달치면 63%.<Assume id="stockout" />
        {" "}이달 있던 옷의 {Math.round(c.sellThrough * 100)}%를 팔았어요.</p>
    </>
  );
}

export default function ApparelSim({ profile, cfg, onBack }: { profile: Profile; cfg: ApparelCfg; onBack: () => void }) {
  const now = new Date();
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1);
  const [mode, setMode] = useState<"easy" | "hard">("easy");
  const [view, setView] = useState<View>("intro");
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [state, setState] = useState<ApState>(() => startState(profile, cfg, startMonth));
  const [done, setDone] = useState<Done[]>([]);
  const [plan, setPlan] = useState<ApPlan>({ ...DEFAULT_PLAN, staff: cfg.staff });
  const [strat, setStrat] = useState<ApStratId>("rec");
  const [tweak, setTweak] = useState<Partial<ApPlan>>({});
  const [choice, setChoice] = useState("");
  const [dayIdx, setDayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const [receipt, setReceipt] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  const [top, setTop] = useState(108);
  const st = guStat(profile.gu);
  const open = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const start = useMemo(() => startState(profile, cfg, startMonth), [profile, cfg, startMonth]);
  const consign = cfg.buyMode === "consign";
  const monthSeq = Array.from({ length: TURNS }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
  const year0 = now.getFullYear() + (startMonth < now.getMonth() + 1 ? 1 : 0);
  const yearOf = (i: number) => year0 + (monthSeq[i] < startMonth ? 1 : 0);
  const months = done.map((x) => x.m);
  const idx = done.length;
  const cur = done.at(-1);
  const m = monthSeq[Math.min(idx, TURNS - 1)];
  const ev = eventOf(m, seed + idx);
  const dep = open.lines.filter((l) => ["interior", "seat", "sign"].includes(l.key)).reduce((a, l) => a + l.amount, 0) / 60; // 5년 감가상각
  // 현금흐름표·영수증 (원). 엔진 현금 = 월초 + 매출 − 옷 산 돈 − 위탁 정산 − 비용 − 생활비 − 이자
  const cfMonths: CfMonth[] = months.map((c, i) => {
    const s0 = i ? months[i - 1].cash : start.cash, K = 1e4;
    return { month: c.month, start: s0 * K, end: c.cash * K, lines: [
      { label: "매출", amount: c.revenue * K }, { label: "옷을 사는 데 쓴 돈", amount: -c.purchase * K }, { label: "위탁 정산", amount: -c.settle * K },
      { label: "알바 인건비", amount: -c.staffPay * K }, { label: "월세", amount: -c.rent * K }, { label: "공과금·카드 수수료 등", amount: -c.other * K },
      { label: "온라인 판매 비용", amount: -c.onlineCost * K }, { label: "홍보·사건 대응", amount: -(c.marketing + c.eventCost) * K },
      { label: "사장 생활비", amount: -c.draw * K }, { label: "대출 이자", amount: -c.interest * K },
    ], tax: { revenue: c.revenue * K, taxableBuy: (c.purchase + c.settle + c.rent + c.other * 0.5 + c.onlineCost) * K, profit: (c.op - dep - c.interest) * K } };
  });
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

  const restart = () => { setState(startState(profile, cfg, startMonth)); setDone([]); setPlan({ ...DEFAULT_PLAN, staff: cfg.staff }); setSeed(Math.floor(Math.random() * 1000)); setView("intro"); };
  const toScenario = () => {
    const p = mode === "easy" ? { ...strats.find((x) => x.id === strat)!.plan, ...tweak } : plan;
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
    setTweak({});
    setView("plan");
  };
  const redo = () => { // 이 달을 계획을 바꿔 다시: 달이 시작될 때의 상태로 돌아간다
    const rest = done.slice(0, -1), prev = rest.at(-1)?.m;
    setDone(rest);
    setState(prev ? stateAfter(prev) : start);
    setView("plan");
  };

  const cashNow = view === null || view === "settle" || view === "report" ? curDay?.cash ?? state.cash : state.cash;
  const people = curDay && view === null ? Math.round(curDay.tx / 2) : 0; // 가게 안 손님 점: 하루 결제 건수의 절반 (그림용)
  const receiptDays = done.flatMap((x, mi) => (mi === done.length - 1 ? x.days.slice(0, dayIdx + 1) : x.days).map((d) => ({ ...d, mi })));
  const sc = months.length ? score(months) : null;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas"><ShopRoom3D kind="apparel" pyeong={cfg.pyeong} layout={cfg.layout} people={people} height="fill" /></div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 옷 매입과 월세는 1일, 알바 급여는 10일, 생활비·이자는 25일에 한꺼번에 나가요.</>}>{man(w(cashNow))}</Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 6개월을 한 달씩 진행해요.</>}>
          {view === "intro" ? `${startMonth}월 시작` : `${view === null || view === "settle" || view === "report" ? cur?.m.month ?? m : m}월 · ${Math.min(view === null || view === "settle" || view === "report" ? idx : idx + 1, TURNS)}/${TURNS}`}
        </Metric>
        <Metric icon={<IconBox />} label={consign ? "위탁 재고" : "재고 (원가)"} tip={consign
          ? <>선반의 옷은 도매상 것이라 내 현금이 묶이지 않아요. 팔린 만큼만 25일에 정산하고, 석 달 안 팔린 옷은 돌려보내요<Assume id="buyMode" />.</>
          : <>선반 위 옷을 산 값이에요. 많을수록 현금이 묶여요. 석 달 넘게 안 팔린 옷은 매달 값이 11%씩 떨어져요<Assume id="stockDecay" />.</>}>
          {man(w(consign ? invTotal(state.inv) * BUY_MODES.consign.cost : stockValue(state, cfg)))}
        </Metric>
        <Metric icon={<IconStar />} label="인지도" tip={<>1.00이 동네에서 평소 알려진 수준이에요. 새 가게는 0.60에서 시작해 매달 1.00 쪽으로 15%씩 다가가요<Assume id="awareness" />.</>}>
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
            <p className="sx-r-acc">회색 줄은 현금이 아니라 이익 계산이에요. '판 옷의 원가'는 미리 사 둔 옷이 팔린 몫, '오늘 몫 고정비'는 월세·급여·생활비 등을 날짜로 나눈 몫이에요. 매일 연다고 봤어요<Assume id="openDaily" />.</p>
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
                  <h1>{profile.gu}에서 옷가게 6개월<ModeSwitch mode={mode} set={setMode} /></h1>
                  <p className="sx-note sx-modenote">{mode === "easy" ? <><b>easy 모드</b> · 달마다 방향만 골라요: 추천대로 / 손님 늘리기 / 비용 아끼기. 이달의 사건 대응도 골라요.</> : <><b>hard 모드</b> · 달마다 매입량·할인·알바·홍보비를 하나씩 정해요.</>}</p>
                  <Kpis items={[
                    { label: "가게", value: `${cfg.pyeong}평 · 알바 ${cfg.staff}명` },
                    { label: "평당 월세", value: `${st.rent}만원` },
                    { label: "여는 데 든 돈", value: man(open.total) },
                    { label: "남은 운영자금", value: man(w(start.cash)), main: true },
                  ]} />
                  <section className="sx-sec">
                    <h2>이렇게 진행돼요</h2>
                    <ol className="sx-flow">
                      <li><b>운영 계획</b><span>달마다 매입량·더 들일 품목·세일·알바·홍보를 정해요.</span></li>
                      <li><b>이달의 사건</b><span>시즌 오프, 장마, 경쟁 매장처럼 달력에 맞는 일이 생겨요. 대응을 골라요.</span></li>
                      <li><b>영업</b><span>그달을 하루씩 보여 주고, 영수증에 돈이 들고 나는 게 찍혀요.</span></li>
                      <li><b>정산</b><span>이익과 현금이 왜 다른지, 재고가 얼마나 남았는지 확인해요.</span></li>
                    </ol>
                    <p className="sx-note"><b>옷가게는 재고가 현금을 묶어요.</b> 많이 사 두면 사이즈가 덜 빠지지만 돈이 선반에 묶이고, 적게 사면 찾는 사이즈가 없어 손님이 그냥 나가요.
                      {" "}재고는 상의·하의·아우터·잡화로 나뉘고, 계절마다 잘 팔리는 품목이 바뀌어요. 오래 둔 옷은 값이 떨어져요.
                      {" "}매입 방식은 <b>{BUY_MODES[cfg.buyMode].label}</b>이에요: {BUY_MODES[cfg.buyMode].desc}.<Assume id="buyMode" />
                      {" "}올해 패션 구매의 {Math.round(MARKET.online_share * 100)}%는 온라인이에요. 1~7월 의복 판매액은 1년 전보다 {(MARKET.indicators.apparel_retail_yoy_1_7 * 100).toFixed(1)}% 늘었고,
                      {monthSeq.some((x) => x >= 9 && x <= 11) ? ` 올가을 의복 소비 전망 지수는 ${MARKET.fall_outlook.index_apparel}(100이 보합)로 줄이겠다는 사람(${MARKET.fall_outlook.decrease}%)이 늘리겠다는 사람(${MARKET.fall_outlook.increase}%)보다 많아요.` : " 시뮬레이션의 매출은 2025년 카드 매출 기준이에요."}
                      {" "}(한국섬유산업연합회 패션 소비 실태조사·경기지표, 2026)
                      {" "}{profile.gu} 일반의류 가게는 1년에 10곳 중 {(st.closure / 10).toFixed(1)}곳이 문을 닫아요 (2025년).</p>
                  </section>
                  <label className="sx-field">시작할 달
                    <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((x) => <option key={x} value={x}>{x}월</option>)}
                    </select>
                    <small>계절 효과는 {profile.gu} 일반의류의 분기별 매출 지수(2025년)예요: {st.qidx.map((x, i) => `${i + 1}분기 ${x.toFixed(2)}`).join(" · ")}</small>
                  </label>
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={() => { setState(startState(profile, cfg, startMonth)); setView("plan"); }}>문 열기</button>
                  <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로 돌아가기</button>
                </footer>
              </>
            )}

            {view === "plan" && (
              <>
                <div className="sx-scroll">
                  <h1>{m}월 운영 계획<ModeSwitch mode={mode} set={setMode} /></h1>
                  <div className="sx-split">
                    <section className="sx-left" aria-label="지난달 결과">
                      <h2>{cur ? `${cur.m.month}월 결과` : "처음 여는 달이에요"}</h2>
                      {cur ? (
                        <Kpis items={[
                          { label: "영업이익", value: signed(cur.m.op), tone: tone(cur.m.op), main: true },
                          { label: "매출", value: man(w(cur.m.revenue)) },
                          { label: "사이즈가 없어 놓친 매출", value: man(w(cur.m.lostStock)) },
                          { label: consign ? "위탁 재고" : "남은 재고", value: man(w(consign ? cur.m.consigned : cur.m.stockEnd)) },
                        ]} />
                      ) : <p className="sx-note">새 가게라 아직 덜 알려졌어요 (인지도 0.60). 첫 재고 {cfg.stockMonths}개월치{consign ? "를 위탁으로 들여놓고" : ` ${man(w(stockValue(state, cfg)))}로`} 시작해요.</p>}
                      {cur && <p className="sx-note">{cur.m.lostCap > cur.m.demand * 0.1 ? `일손이 모자라 ${man(w(cur.m.lostCap))}어치를 못 팔았어요.`
                        : cur.m.lostStock > cur.m.demand * 0.15 ? `찾는 사이즈·색이 없어 ${man(w(cur.m.lostStock))}어치를 놓쳤어요.`
                        : cur.m.stockEnd > 0 && cur.m.oldEnd > cur.m.stockEnd * 0.3 ? "석 달 넘은 옷이 재고의 30%를 넘어요. 세일을 일찍 시작해 보세요."
                        : cur.m.stockEnd > cur.m.revenue * KOSIS.cogs * 2 ? "재고가 두 달치 넘게 쌓여 현금이 묶여 있어요." : "재고와 판매가 잘 맞았어요."}</p>}
                      <InvTable state={state} month={m} cfg={cfg} />
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
                        <QuickPicks picks={PICKS} base={strats.find((x) => x.id === strat)!.plan} tweak={tweak} setTweak={setTweak} />
                        <p className="sx-note">hard 모드에서는 매입량·더 들일 품목·상시 할인·세일 시작과 폭·알바·홍보비·온라인 판매를 숫자로 하나씩 정할 수 있어요.</p>
                      </section>
                    ) : (
                      <section className="sx-right" aria-label="이번 달 운영 계획">
                        <h2>{m}월에 이렇게 할게요</h2>
                        <div className="sx-steps">
                          <div className={`sx-step${cur && cur.m.plan.focus !== plan.focus ? " is-changed" : ""}`}>
                            <div className="sx-step-t">
                              <span className="sx-step-l">{PLAN_TEXT.focus.label}<Assume id="outerMix" /></span>
                              <small>{PLAN_TEXT.focus.hint}. {m}월 비중: {CATS.map((c) => `${c.label} ${Math.round(mixOf(m)[c.id] * 100)}%`).join(" · ")}</small>
                              {cur && cur.m.plan.focus !== plan.focus && <small className="sx-step-prev">지난달 {PLAN_TEXT.focus.text(cur.m.plan)}</small>}
                            </div>
                            <div className="sx-step-c">
                              <select aria-label={PLAN_TEXT.focus.label} value={plan.focus} onChange={(e) => setPlan({ ...plan, focus: e.target.value as Cat | "none" })}>
                                <option value="none">고르게</option>
                                {CATS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                              </select>
                            </div>
                          </div>
                          {([["buy", 0.7, 1.5, 0.1], ["discount", 0, 0.3, 0.05], ["markdownAge", 2, 4, 1], ["markdown", 0.1, 0.5, 0.1], ["staff", 0, 2, 1], ["marketing", 0, 100, 25], ["online", 0, 2, 1]] as [Exclude<keyof ApPlan, "focus">, number, number, number][]).map(([k, lo, hi, step]) => {
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
                    <p className="sx-note">사장님의 선택이 이번 달 이익과 재고를 바꿔요. 장점(+)과 단점(−)을 보고 하나를 골라 주세요. {ev.note}.<Assume id="eventEffect" what={`${ev.title}의 효과 크기 (${ev.note})`} /></p>
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
                      { label: consign ? "도매상에 정산한 돈" : "옷을 사는 데 쓴 돈", value: man(w(consign ? c.settle : c.purchase)) },
                      { label: consign ? "위탁 재고" : "남은 재고 (원가)", value: man(w(consign ? c.consigned : c.stockEnd)) },
                      { label: "월말 현금", value: man(w(c.cash)), main: true },
                    ]} />
                    {c.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}
                    <div className="sx-settle">
                      <section className="sx-sec">
                        <h2>정산표</h2>
                        <table className="sx-table"><tbody>
                          <tr><th>매출</th><td>{man(w(c.revenue))}</td><td>결제 약 {Math.round(c.tx).toLocaleString("ko-KR")}건, 한 건 {c.ticket.toLocaleString("ko-KR")}원<Assume id="sizeEffect" /></td></tr>
                          {c.mdRev + c.clearRev > 0 && <tr className="sub"><th>그중 세일 매출</th><td>{man(w(c.mdRev + c.clearRev))}</td><td>{c.plan.markdownAge}달 지난 옷 {Math.round(c.plan.markdown * 100)}% 세일{c.clearRev > 0 ? " + 정리 세일" : ""}<Assume id="markdownSell" /></td></tr>}
                          <tr><th>매출원가</th><td>−{man(w(c.cogs))}</td><td>판 옷의 원가 (원가율 {Math.round(KOSIS.cogs * 100)}% × {consign ? `위탁 ${BUY_MODES.consign.cost}` : c.costAvg.toFixed(2)}{c.plan.discount ? `, ${Math.round(c.plan.discount * 100)}% 할인` : ""})</td></tr>
                          <tr className="sub"><th>매출총이익</th><td>{signed(gross)}</td><td /></tr>
                          <tr><th>인건비</th><td>{c.staffPay ? `−${man(w(c.staffPay))}` : "0원"}</td><td>알바 {c.plan.staff}명 (사장 인건비 제외)</td></tr>
                          <tr><th>월세</th><td>−{man(w(c.rent))}</td><td /></tr>
                          <tr><th>기타경비</th><td>−{man(w(c.other))}</td><td>카드 수수료·공과금·포장 등, 매출의 {Math.round(KOSIS.other * 100)}% (도소매업조사)</td></tr>
                          {c.marketing + c.eventCost > 0 && <tr><th>홍보·사건 대응</th><td>−{man(w(c.marketing + c.eventCost))}</td><td /></tr>}
                          {c.onlineCost > 0 && <tr><th>온라인 판매 비용</th><td>−{man(w(c.onlineCost))}</td><td>{ONLINE[c.plan.online].label}: 온라인 매출 {man(w(c.onlineRev))} × 수수료 {Math.round(ONLINE[c.plan.online].fee * 1000) / 10}% + 택배 약 {Math.round(c.onlineOrders * 1.15).toLocaleString("ko-KR")}건 + 월 {ONLINE[c.plan.online].fixed}만원<Assume id="online" /></td></tr>}
                          {c.writeOff > 0 && <tr><th>재고 평가손</th><td>−{man(w(c.writeOff))}</td><td>석 달 넘은 옷 값이 떨어졌어요<Assume id="stockDecay" /></td></tr>}
                          <tr className="sum"><th>영업이익</th><td>{signed(c.op)}</td><td>감가상각 전</td></tr>
                          <tr><th>감가상각비</th><td>−{man(w(dep))}</td><td>인테리어·집기·간판을 5년에 나눈 몫. 현금은 안 나가요</td></tr>
                          {c.interest > 0 && <tr><th>이자비용</th><td>−{man(w(c.interest))}</td><td>연 {+(LOAN_RATE * 100).toFixed(2)}%</td></tr>}
                          <tr className="sum"><th>세전이익</th><td>{signed(pre)}</td><td>부가세·소득세는 아직 계산하지 않아요</td></tr>
                        </tbody></table>
                      </section>
                      <section className="sx-sec">
                        <h2>이익과 현금이 다른 이유</h2>
                        {consign
                          ? <p className="sx-note">위탁이라 옷을 미리 사지 않았어요. 팔린 옷값 <b>{man(w(c.settle))}</b>만 도매상에 정산해서 이익과 현금이 거의 같아요.
                              대신 원가가 {Math.round((BUY_MODES.consign.cost - 1) * 100)}% 비싸 한 벌에 남는 돈이 적어요.{c.returned > 0 ? ` 석 달 안 팔린 ${man(w(c.returned))}어치는 돌려보냈어요.` : ""} 사장 생활비 {man(w(c.draw))}도 현금에서 빠져요.</p>
                          : <p className="sx-note">이번 달 옷을 사는 데 <b>{man(w(c.purchase))}</b>을 썼지만{c.ordered ? " (석 달치 선발주)" : ""}, 팔린 만큼의 원가 <b>{man(w(c.cogs))}</b>만 비용이 돼요.
                              나머지는 선반 위 재고({man(w(c.stockEnd))})로 남아 현금이 묶여 있어요. 사장 생활비 {man(w(c.draw))}도 현금에서 빠져요.</p>}
                        <h2>품목별 재고</h2>
                        <CatTable c={c} />
                        <h2>이번 달 사건</h2>
                        <ul className="sx-evs"><li><b>{c.event}</b><span>고른 대응: {c.choice}</span></li></ul>
                      </section>
                    </div>
                    <CashFlow months={cfMonths} kind="retail" shop="옷가게" />
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
                  <CashFlow months={cfMonths} kind="retail" shop="옷가게" />
                  <section className="sx-sec">
                    {(() => {
                      // 팔린 옷(원가 기준) 중 정가로 판 몫과 세일로 판 몫, 논문의 의류업체 값과 비교
                      const full = months.reduce((a, x) => a + CATS.reduce((b, c) => b + x.cats[c.id].sold, 0), 0);
                      const md = months.reduce((a, x) => a + CATS.reduce((b, c) => b + x.cats[c.id].mdSold, 0), 0);
                      const tot = full + md;
                      if (tot <= 0) return null;
                      return (
                        <p className="sx-note">팔린 옷 중 <b>{Math.round((full / tot) * 100)}%</b>를 정가로, {Math.round((md / tot) * 100)}%를 세일로 팔았어요.
                          {" "}참고로 의류 브랜드 92곳은 정가 {Math.round(PAPER_SELL.full * 100)}%, 30% 세일 {Math.round(PAPER_SELL.sale30 * 100)}%, 50% 세일 {Math.round(PAPER_SELL.sale50 * 100)}%였고 시즌마다 {Math.round(PAPER_SELL.leftover * 100)}%가 재고로 남았어요
                          {" "}(장은영 2001, 백화점·대리점 브랜드 기준이라 작은 옷가게와는 달라요).</p>
                      );
                    })()}
                    <h2>달마다</h2>
                    <table className="sx-table">
                      <thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>사건 · 대응</th><th>사이즈 맞은 손님</th><th>월말 재고</th><th>월말 현금</th></tr></thead>
                      <tbody>{months.map((x) => (
                        <tr key={x.month}><td>{x.month}월</td><td>{man(w(x.revenue))}</td><td className={tone(x.op)}>{signed(x.op)}</td><td>{x.event} · {x.choice}</td><td>{Math.round(x.fill * 100)}%</td><td>{man(w(consign ? x.consigned : x.stockEnd))}</td><td>{man(w(x.cash))}</td></tr>
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
