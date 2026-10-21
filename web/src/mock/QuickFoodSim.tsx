// 치킨집·분식집 6개월 시뮬레이션. 화면 틀은 옷가게 시뮬레이션(ApparelSim.tsx)과 같다:
// 가게(평면)가 화면 전체, 위에 지표 줄, 왼쪽에 현금 그래프와 이달 계획, 오른쪽에 날짜별 영수증, 아래에 재생 막대,
// 운영 계획 → 이달의 사건 → (하루씩 재생) → 정산 → 6개월 성적표는 팝업으로 뜬다.
// 계산은 quickfood.ts playMonth (달 단위, 서버 없음). 날짜별 값은 그달 결과를 이 구 업종의 요일별 매출 비중(상권분석서비스)으로 나눈 것이다.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import Assume from "./Assume";
import { LOAN_RATE, guStat, man, type Profile } from "./model";
import {
  DEFAULT_PLAN, PLAN_TEXT, QF_NAME, deliveryGuInfo, derived, eventOf, foodMult, playMonth, qfOpeningCost, qfStrategies, startState,
  type QfCfg, type QfMonth, type QfPlan, type QfState, type QfStratId,
} from "./quickfood";
import { QfFloorPlan } from "./QuickFoodBuild";
import QuickPicks, { type Pick as QPick } from "./QuickPicks";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import { CashChart, IconCal, IconCash, IconStar, Metric } from "./SimulateEngine";
import "./simulate-engine.css";

const TURNS = 6;
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
type View = "intro" | "plan" | "scenario" | "settle" | "report" | null;
type Tick = { label: string; amount: number }; // 만원
type Day = { date: Date; tx: number; delivery: number; revenue: number; ticks: Tick[]; notes: string[]; fixedShare: number; cash: number };
type Done = { m: QfMonth; days: Day[] };
const w = (x: number) => Math.round(x); // 만원
const signed = (x: number) => (w(x) === 0 ? "0원" : `${x > 0 ? "+" : "−"}${man(Math.abs(w(x)))}`);
const tone = (x: number) => (w(x) > 0 ? "pos" : w(x) < 0 ? "neg" : "");
const n0 = (x: number) => Math.round(x).toLocaleString("ko-KR");
const STEPS: [keyof QfPlan, number, number, number][] = [["price", 0.85, 1.2, 0.05], ["staff", 0, 3, 1], ["ad", 0, 2, 1], ["marketing", 0, 100, 25], ["hours", 0, 2, 1], ["pickup", 0, 0.1, 0.1]];
// 쉬운 모드: 방향을 고른 뒤 버튼으로 바꾸는 세 가지
const PICKS: QPick<QfPlan>[] = [
  { key: "price", label: "가격", hint: "올리면 한 건 값이 늘고 주문이 줄어요", opts: [{ label: "5% 싸게", value: 0.95 }, { label: "그대로", value: 1 }, { label: "5% 비싸게", value: 1.05 }] },
  { key: "staff", label: "알바", hint: "바쁜 날 주문을 놓치지 않게", opts: [{ label: "없이", value: 0 }, { label: "1명", value: 1 }, { label: "2명", value: 2 }] },
  { key: "ad", label: "배달앱 광고", hint: "배달 주문을 늘리지만 광고비가 들어요", opts: [{ label: "안 함", value: 0 }, { label: "기본", value: 1 }, { label: "적극", value: 2 }] },
];

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const IconBike = () => <svg {...ico}><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="M6 17h4l3-6h3l2 6M13 11l-2-4H8" /></svg>;
const IconTrophy = () => <svg {...ico}><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6" /></svg>;

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}

// 한 달 결과를 날짜로 나눈다. 매출·식재료·배달 수수료·기타경비는 요일 비중대로 그날 나가고 들어온다고 본다.
// 월세·배달앱 광고·홍보는 1일, 알바 급여는 10일, 생활비·이자는 25일 (다른 업종과 같은 날짜)
function buildDays(m: QfMonth, year: number, cashStart: number, dow: number[]): Day[] {
  const n = new Date(year, m.month, 0).getDate();
  const dates = Array.from({ length: n }, (_, i) => new Date(year, m.month - 1, i + 1));
  const wt = (d: Date) => dow[(d.getDay() + 6) % 7] ?? 1 / 7; // dow는 월..일
  const sum = dates.reduce((a, d) => a + wt(d), 0) || 1;
  const fixed = m.rent + m.staffPay + m.draw + m.interest + m.marketing + m.adCost + m.eventCost;
  let cash = cashStart;
  return dates.map((date, i) => {
    const f = wt(date) / sum;
    const revenue = m.revenue * f;
    const ticks: Tick[] = [
      { label: "매출", amount: revenue }, { label: "식재료", amount: -m.food * f },
      { label: "배달 수수료", amount: -(m.appFees + m.agencyFees) * f }, { label: "기타경비", amount: -m.other * f },
    ];
    const notes: string[] = [];
    if (i === 0) {
      ticks.push({ label: "월세", amount: -m.rent });
      if (m.adCost + m.marketing + m.eventCost > 0) ticks.push({ label: "광고·홍보·사건 대응", amount: -(m.adCost + m.marketing + m.eventCost) });
      notes.push(`이달의 사건 · ${m.event} · ${m.choice}`);
    }
    if (i === 9 && m.staffPay > 0) ticks.push({ label: "알바 급여", amount: -m.staffPay });
    if (i === 24) {
      ticks.push({ label: "사장 생활비", amount: -m.draw });
      if (m.interest > 0) ticks.push({ label: "대출 이자", amount: -m.interest });
    }
    cash += ticks.reduce((a, t) => a + t.amount, 0);
    return { date, tx: m.tx * f, delivery: m.orders.delivery * f, revenue, ticks, notes, fixedShare: fixed / n, cash };
  });
}

// 정산의 갈래별 표: 홀·포장·배달마다 주문 수, 매출, 배달 수수료, 식재료를 빼고 남는 돈
function ChannelTable({ m }: { m: QfMonth }) {
  const fr = m.revenue > 0 ? m.food / m.revenue : 0;
  const rows: [string, number, number, number][] = [
    ["홀", m.orders.visit, m.ch.visit, 0], ["포장", m.orders.takeout, m.ch.takeout, 0], ["배달", m.orders.delivery, m.ch.delivery, m.appFees + m.agencyFees],
  ];
  return (
    <table className="sx-table">
      <thead><tr><th>갈래</th><th>주문</th><th>매출</th><th>배달 수수료</th><th>식재료 빼고 남는 돈</th></tr></thead>
      <tbody>{rows.map(([k, o, r, f]) => (
        <tr key={k}><th>{k}</th><td>{n0(o)}건</td><td>{man(w(r))}</td><td>{f ? `−${man(w(f))}` : "없음"}</td><td>{man(w(r - r * fr - f))} (한 건 {n0(((r - r * fr - f) * 1e4) / Math.max(1, o))}원)</td></tr>
      ))}</tbody>
    </table>
  );
}

export default function QuickFoodSim({ profile, cfg, onBack }: { profile: Profile; cfg: QfCfg; onBack: () => void }) {
  const now = new Date();
  const name = QF_NAME[cfg.ind];
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1);
  const [mode, setMode] = useState<"easy" | "hard">("easy");
  const [view, setView] = useState<View>("intro");
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [state, setState] = useState<QfState>(() => startState(profile, cfg));
  const [done, setDone] = useState<Done[]>([]);
  const [plan, setPlan] = useState<QfPlan>({ ...DEFAULT_PLAN, staff: cfg.staff });
  const [strat, setStrat] = useState<QfStratId>("rec");
  const [tweak, setTweak] = useState<Partial<QfPlan>>({});
  const [choice, setChoice] = useState("");
  const [dayIdx, setDayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const [receipt, setReceipt] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  const [top, setTop] = useState(108);
  const st = guStat(profile.gu), dv = derived(cfg.ind);
  const open = qfOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const start = useMemo(() => startState(profile, cfg), [profile, cfg]);
  const monthSeq = Array.from({ length: TURNS }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
  const year0 = now.getFullYear() + (startMonth < now.getMonth() + 1 ? 1 : 0);
  const yearOf = (i: number) => year0 + (monthSeq[i] < startMonth ? 1 : 0);
  const months = done.map((x) => x.m);
  const idx = done.length;
  const cur = done.at(-1);
  const m = monthSeq[Math.min(idx, TURNS - 1)];
  const ev = eventOf(cfg.ind, m, seed + idx);
  const dep = open.lines.filter((l) => ["interior", "equip", "sign"].includes(l.key)).reduce((a, l) => a + l.amount, 0) / 60; // 5년 감가상각
  const strats = qfStrategies(cur?.m, plan);
  const curDay = cur ? cur.days[Math.min(dayIdx, cur.days.length - 1)] : null;

  useLayoutEffect(() => {
    const measure = () => { const el = document.querySelector(".m-mocknote") ?? document.querySelector(".m-top"); setTop(Math.round(el ? el.getBoundingClientRect().bottom : 108)); };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  useEffect(() => {
    if (view !== null || !playing || !cur) return;
    if (dayIdx >= cur.days.length - 1) { setPlaying(false); setView("settle"); return; }
    const t = setTimeout(() => setDayIdx((i) => i + 1), fast ? 60 : 350);
    return () => clearTimeout(t);
  }, [view, playing, fast, dayIdx, cur]);

  const monthlyOut = (ms: QfMonth[]) => ms.reduce((a, x) => a + x.rent + x.staffPay + x.draw + x.interest, 0) / Math.max(1, ms.length);
  const scoreMonths = (ms: QfMonth[]): ScoreMonth[] => ms.map((x) => ({
    month: x.month, revenue: x.revenue * 1e4, op: x.op * 1e4, cogs: x.food * 1e4, labor: x.staffPay * 1e4, rent: x.rent * 1e4, mgmt: x.other * 1e4, fees: (x.appFees + x.agencyFees) * 1e4,
    covers: x.tx, walkaways: (x.lost * 1e4) / x.ticket, util: Math.min(1, x.load), fatigue: x.load * 100, closed: x.closed,
    decisions: [{ title: x.event, chosen_label: x.choice, vs_default_op: 0 }],
  }));
  const lowest = () => Math.min(start.cash, ...done.flatMap((x) => x.days.map((d) => d.cash)));
  const score = (ms: QfMonth[]) => scoreOf(scoreMonths(ms), start.cash * 1e4, lowest() * 1e4, (ms.at(-1)?.cash ?? start.cash) * 1e4, monthlyOut(ms) * 1e4, "food");

  const restart = () => { setState(startState(profile, cfg)); setDone([]); setPlan({ ...DEFAULT_PLAN, staff: cfg.staff }); setSeed(Math.floor(Math.random() * 1000)); setView("intro"); };
  const toScenario = () => {
    setPlan(mode === "easy" ? { ...strats.find((x) => x.id === strat)!.plan, ...tweak } : plan);
    setChoice(ev.options[ev.options.length - 1].id);
    setView("scenario");
  };
  const play = () => {
    const opt = ev.options.find((o) => o.id === choice) ?? ev.options[0];
    const r = playMonth(profile, cfg, state, m, plan, ev, opt);
    setDone((d) => [...d, { m: r.month, days: buildDays(r.month, yearOf(idx), state.cash, st.dow) }]);
    setState(r.next);
    setDayIdx(0); setPlaying(true); setView(null);
  };
  const skip = () => { if (cur) { setDayIdx(cur.days.length - 1); setPlaying(false); setView("settle"); } };
  const next = () => { if (state.closed || done.length >= TURNS) { setView("report"); return; } setStrat("rec"); setTweak({}); setView("plan"); };
  const redo = () => {
    const rest = done.slice(0, -1), prev = rest.at(-1)?.m;
    setDone(rest);
    setState(prev ? { cash: prev.cash, awareness: prev.awareness, negMonths: prev.cash < 0 ? 1 : 0, closed: false } : start);
    setView("plan");
  };

  const cashNow = view === null || view === "settle" || view === "report" ? curDay?.cash ?? state.cash : state.cash;
  const people = curDay && view === null ? Math.round((curDay.tx - curDay.delivery) / 3) : 0;
  const riders = curDay && view === null ? Math.round(curDay.delivery / 4) : 0;
  const receiptDays = done.flatMap((x, mi) => (mi === done.length - 1 ? x.days.slice(0, dayIdx + 1) : x.days).map((d) => ({ ...d, mi })));
  const sc = months.length ? score(months) : null;
  const delivShare = cur ? cur.m.ch.delivery / Math.max(1, cur.m.revenue) : dv.share.delivery;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas ap-stage"><QfFloorPlan cfg={cfg} people={people} riders={riders} /></div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 식재료·배달 수수료는 그날그날, 월세·광고는 1일, 알바 급여는 10일, 생활비·이자는 25일에 나가요.</>}>{man(w(cashNow))}</Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 6개월을 한 달씩 진행해요.</>}>
          {view === "intro" ? `${startMonth}월 시작` : `${view === null || view === "settle" || view === "report" ? cur?.m.month ?? m : m}월 · ${Math.min(view === null || view === "settle" || view === "report" ? idx : idx + 1, TURNS)}/${TURNS}`}
        </Metric>
        <Metric icon={<IconBike />} label="배달 비중" tip={<>매출 중 배달 몫이에요. 배달은 한 건마다 배달앱 {n0(dv.appFee * 1e4)}원, 배달대행 {n0(dv.agencyFee * 1e4)}원이 빠져요 (경영실태조사 이용 가게 평균).</>}>
          {Math.round(delivShare * 100)}%
        </Metric>
        <Metric icon={<IconStar />} label="인지도" tip={<>1.00이 동네에서 평소 알려진 수준이에요. 새 가게는 0.60에서 시작해 매달 1.00 쪽으로 15%씩 다가가요<Assume what="새 가게 인지도 0.6, 매달 15% 회복 (고깃집 엔진과 같은 가정)" />.</>}>
          {(view === "intro" ? start : state).awareness.toFixed(2)}
        </Metric>
        <Metric icon={<IconTrophy />} label="지금까지 점수" tip={<>정산마다 다시 매기는 점수예요. 6개월이 끝나면 성적표가 나와요.</>}>{sc ? `${sc.total}점` : "-"}</Metric>
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
              {(Object.keys(PLAN_TEXT) as (keyof QfPlan)[]).map((k) => {
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
            <p className="sx-r-sub">{profile.gu} {name} · 시작 현금 {man(w(start.cash))}</p>
            <p className="sx-r-acc">회색 줄은 현금이 아니라 이익 계산이에요. '오늘 몫 고정비'는 월세·급여·생활비 등을 날짜로 나눈 몫이에요. 한 달 {Math.round(dv.openDays)}일 연다는 조사값 대신 매일 연다고 봤어요<Assume what="매일 영업 (조사 평균 영업일수는 이보다 조금 적어요)" />.</p>
            {receiptDays.length === 0 && <p className="sx-r-empty">아직 찍힌 내역이 없어요. 첫 달이 시작되면 하루씩 쌓여요.</p>}
            {receiptDays.map((x, i) => {
              const dayProfit = x.ticks.filter((t) => !["월세", "알바 급여", "사장 생활비", "대출 이자", "광고·홍보·사건 대응"].includes(t.label)).reduce((a, t) => a + t.amount, 0) - x.fixedShare;
              return (
                <section key={`${x.mi}-${i}`} className="sx-r-day">
                  {(i === 0 || receiptDays[i - 1].mi !== x.mi) && <p className="sx-r-month">{done[x.mi].m.month}월</p>}
                  <p className="sx-r-head"><b>{x.date.getMonth() + 1}/{x.date.getDate()} ({DOW_KO[x.date.getDay()]})</b><span>주문 {Math.round(x.tx)}건 · 배달 {Math.round(x.delivery)}</span></p>
                  {x.notes.map((n) => <p key={n} className="sx-r-note">{n}</p>)}
                  <ul>
                    {x.ticks.map((t) => <li key={t.label} className={t.amount >= 0 ? "in" : "out"}><span>{t.label}</span><b>{signed(t.amount)}</b></li>)}
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
          <span>{cur.m.month}월 {curDay.date.getDate()}일 ({DOW_KO[curDay.date.getDay()]}) · 주문 {Math.round(curDay.tx)}건 · 매출 {man(w(curDay.revenue))}</span>
        </div>
      )}

      {view !== null && (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <div className={`sx-pop sx-pop-${view}`}>

            {view === "intro" && (
              <>
                <div className="sx-scroll">
                  <h1>{profile.gu}에서 {name} 6개월</h1>
                  <Kpis items={[
                    { label: "가게", value: `${cfg.pyeong}평 · 알바 ${cfg.staff}명` },
                    { label: "평당 월세", value: `${st.rent}만원` },
                    { label: "여는 데 든 돈", value: man(open.total) },
                    { label: "남은 운영자금", value: man(w(start.cash)), main: true },
                  ]} />
                  <section className="sx-sec">
                    <h2>이렇게 진행돼요</h2>
                    <ol className="sx-flow">
                      <li><b>운영 계획</b><span>달마다 가격·알바·배달앱 광고·홍보를 정해요.</span></li>
                      <li><b>이달의 사건</b><span>{cfg.ind === "chicken" ? "장마, 야구 시즌, 복날, 배달앱 무료배달 경쟁" : "개학과 방학, 장마, 쌀·떡값 상승, 배달앱 무료배달 경쟁"}처럼 달력에 맞는 일이 생겨요. 대응을 골라요.</span></li>
                      <li><b>영업</b><span>그달을 하루씩 보여 주고, 영수증에 돈이 들고 나는 게 찍혀요.</span></li>
                      <li><b>정산</b><span>홀·포장·배달 중 어디서 돈이 남는지, 배달 수수료가 얼마나 빠졌는지 확인해요.</span></li>
                    </ol>
                    <p className="sx-note"><b>{name}은 배달이 매출을 늘리지만 한 건마다 수수료가 빠져요.</b> 조사한 가게는 주문의 {Math.round(dv.share.delivery * 100)}%가 배달이고,
                      배달 한 건에 배달앱 {n0(dv.appFee * 1e4)}원과 배달대행 {n0(dv.agencyFee * 1e4)}원을 가게가 내요. 손님이 몰리는 달에 일손이 모자라면 주문을 놓쳐요.
                      {deliveryGuInfo(profile.gu) && ` ${profile.gu} 주민은 배달·포장 음식을 서울 평균의 ${deliveryGuInfo(profile.gu)!.index.toFixed(2)}배 먹어요 (1인 가구원 ${Math.round((deliveryGuInfo(profile.gu)!.single_share ?? 0) * 100)}%, 서울서베이 2022 × 주민 연령·가구 구성).`}
                      {" "}{profile.gu} {cfg.ind === "chicken" ? "치킨전문점" : "분식전문점"}은 1년에 10곳 중 {(st.closure / 10).toFixed(1)}곳이 문을 닫아요 (2025년).</p>
                  </section>
                  <fieldset className="sx-mode">
                    <legend>어떻게 해 볼까요?</legend>
                    <label className={mode === "easy" ? "on" : ""}>
                      <input type="radio" name="qf-mode" checked={mode === "easy"} onChange={() => setMode("easy")} />
                      <span><b>쉬운 모드</b><small>달마다 방향만 골라요: 추천대로 / 주문 늘리기 / 비용 아끼기. 이달의 사건 대응도 골라요.</small></span>
                    </label>
                    <label className={mode === "hard" ? "on" : ""}>
                      <input type="radio" name="qf-mode" checked={mode === "hard"} onChange={() => setMode("hard")} />
                      <span><b>자세히 모드</b><small>달마다 가격·알바·배달앱 광고·홍보비를 하나씩 정해요.</small></span>
                    </label>
                  </fieldset>
                  <label className="sx-field">시작할 달
                    <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((x) => <option key={x} value={x}>{x}월</option>)}
                    </select>
                    <small>계절 효과는 {profile.gu} {cfg.ind === "chicken" ? "치킨전문점" : "분식전문점"}의 분기별 매출 지수(2025년)와 통계청 음식 배달 거래액의 달별 배율이에요: {st.qidx.map((x, i) => `${i + 1}분기 ${x.toFixed(2)}`).join(" · ")}</small>
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
                          { label: "배달 수수료", value: man(w(cur.m.appFees + cur.m.agencyFees)) },
                          { label: "놓친 주문", value: `${n0((cur.m.lost * 1e4) / cur.m.ticket)}건` },
                        ]} />
                      ) : <p className="sx-note">새 가게라 아직 덜 알려졌어요 (인지도 0.60). 첫 달은 손님이 자리 잡은 가게의 60%쯤이에요.</p>}
                      {cur && <p className="sx-note">{cur.m.lost > cur.m.demand * 0.08 ? `일손이 모자라 몰리는 날 주문 ${n0((cur.m.lost * 1e4) / cur.m.ticket)}건을 놓쳤어요.` : cur.m.load < 0.55 ? "일손이 남았어요. 알바를 줄여도 될 만해요." : "주문과 일손이 잘 맞았어요."}</p>}
                    </section>
                    {mode === "easy" ? (
                      <section className="sx-right" aria-label="이번 달 방향">
                        <h2>{m}월, 어느 쪽으로 갈까요?</h2>
                        <div className="sx-strats" role="radiogroup">
                          {strats.map((x) => (
                            <label key={x.id} className={strat === x.id ? "on" : ""}>
                              <input type="radio" name="qf-strat" checked={strat === x.id} onChange={() => setStrat(x.id)} />
                              <span className="sx-strat"><b>{x.title}</b><small>{x.desc}</small><span className="sx-strat-chg">{x.changes.length ? x.changes.join(" · ") : "지난달과 같아요"}</span></span>
                            </label>
                          ))}
                        </div>
                        <QuickPicks picks={PICKS} base={strats.find((x) => x.id === strat)!.plan} tweak={tweak} setTweak={setTweak} />
                        <p className="sx-note">자세히 모드에서는 가격·알바·배달앱 광고·홍보비·영업시간·포장 할인을 숫자로 하나씩 정할 수 있어요.</p>
                      </section>
                    ) : (
                      <section className="sx-right" aria-label="이번 달 운영 계획">
                        <h2>{m}월에 이렇게 할게요</h2>
                        <div className="sx-steps">
                          {STEPS.map(([k, lo, hi, step]) => {
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
                        <p className="sx-note">처음 가격은 조사한 {name}의 객단가 {n0(dv.ticket)}원이에요. 지금 {n0(dv.ticket * plan.price)}원.</p>
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
                    <p className="sx-note">사장님의 선택이 이번 달 주문과 이익을 바꿔요. 장점(+)과 단점(−)을 보고 하나를 골라 주세요. {ev.note}.<Assume what={`${ev.title}의 효과 크기 (${ev.note})`} /></p>
                  </section>
                  <div className="sx-dps is-single">
                    <div className="sx-dp" role="radiogroup" aria-label={ev.title}>
                      <header className="sx-dp-h"><span className="sx-clock">{m}월</span><h3>{ev.title}</h3></header>
                      <div className="sx-dp-opts">
                        {ev.options.map((o) => (
                          <label key={o.id} className={choice === o.id ? "on" : ""}>
                            <input type="radio" name="qf-ev" checked={choice === o.id} onChange={() => setChoice(o.id)} />
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
              const fees = c.appFees + c.agencyFees;
              const pre = c.op - dep - c.interest;
              const why = w(c.op) >= 0
                ? (c.lost > c.demand * 0.08 ? "더 받을 수 있었는데 일손이 모자랐어요" : "주문과 비용이 잘 맞았어요")
                : fees + c.adCost > c.revenue * 0.15 ? "배달 수수료와 광고비가 이익을 깎았어요" : c.revenue < (c.rent + c.staffPay) * 2 ? "매출이 고정비를 덮지 못했어요" : "비용이 이익을 깎았어요";
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
                      { label: "주문", value: `${n0(c.tx)}건` },
                      { label: "배달 수수료", value: man(w(fees)) },
                      { label: "월말 현금", value: man(w(c.cash)), main: true },
                    ]} />
                    {c.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}
                    <div className="sx-settle">
                      <section className="sx-sec">
                        <h2>정산표</h2>
                        <table className="sx-table"><tbody>
                          <tr><th>매출</th><td>{man(w(c.revenue))}</td><td>주문 약 {n0(c.tx)}건, 한 건 {n0(c.ticket)}원<Assume what="평수 효과(조사 평균 면적 기준 제곱근), 새 가게 인지도, 가격 탄력 1.2" /></td></tr>
                          <tr><th>식재료비</th><td>−{man(w(c.food))}</td><td>처음 가격 기준 매출의 {Math.round(dv.foodRatio * 100)}% (2024년 경영실태조사) × 이달 식재료 시세 {c.foodMult.toFixed(3)}배: {foodMult(cfg.ind, c.month).parts.map((p) => `${p.items.join("·")} ${p.factor.toFixed(2)}배(식재료비의 ${Math.round(p.share * 100)}%)`).join(", ")} (생활물가지수, 2024년 대비)</td></tr>
                          <tr className="sub"><th>매출총이익</th><td>{signed(c.revenue - c.food)}</td><td /></tr>
                          <tr><th>배달 수수료</th><td>−{man(w(fees))}</td><td>배달 {n0(c.orders.delivery)}건 × (배달앱 {n0(dv.appFee * 1e4)}원 + 배달대행 {n0(dv.agencyFee * 1e4)}원)</td></tr>
                          <tr><th>인건비</th><td>{c.staffPay ? `−${man(w(c.staffPay))}` : "0원"}</td><td>알바 {c.plan.staff}명, 한 명 월 {man(Math.round(dv.wage))} (사장 인건비 제외)</td></tr>
                          <tr><th>월세</th><td>−{man(w(c.rent))}</td><td /></tr>
                          <tr><th>기타경비</th><td>−{man(w(c.other))}</td><td>카드 수수료·가스·전기 등, 매출의 5%<Assume what="기타경비 5%" /></td></tr>
                          {c.adCost + c.marketing + c.eventCost > 0 && <tr><th>광고·홍보·사건 대응</th><td>−{man(w(c.adCost + c.marketing + c.eventCost))}</td><td>배달앱 광고 {man(c.adCost)}, SNS {man(c.marketing)}, 사건 대응 {man(c.eventCost)}</td></tr>}
                          <tr className="sum"><th>영업이익</th><td>{signed(c.op)}</td><td>감가상각 전. 조사한 {name}의 영업이익률은 {Math.round(dv.opMargin * 1000) / 10}%</td></tr>
                          <tr><th>감가상각비</th><td>−{man(w(dep))}</td><td>인테리어·설비·간판을 5년에 나눈 몫. 현금은 안 나가요</td></tr>
                          {c.interest > 0 && <tr><th>이자비용</th><td>−{man(w(c.interest))}</td><td>연 {+(LOAN_RATE * 100).toFixed(2)}%</td></tr>}
                          <tr className="sum"><th>세전이익</th><td>{signed(pre)}</td><td>부가세·소득세는 아직 계산하지 않아요</td></tr>
                        </tbody></table>
                      </section>
                      <section className="sx-sec">
                        <h2>홀·포장·배달, 어디서 남았나</h2>
                        <ChannelTable m={c} />
                        <p className="sx-note">배달은 주문을 늘리지만 한 건마다 수수료가 빠져서, 같은 메뉴라도 홀·포장보다 한 건에 남는 돈이 적어요. 월세·알바비는 갈래와 상관없이 나가요.
                          {c.lost > 0 ? ` 일손이 모자라 받지 못한 주문은 약 ${n0((c.lost * 1e4) / c.ticket)}건이에요.` : ""}</p>
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
                    endCash={(months.at(-1)?.cash ?? start.cash) * 1e4} monthlyCashOut={monthlyOut(months) * 1e4} gu={profile.gu} mode={mode} kind="food" shop={name} seed={seed}
                  />
                  <section className="sx-sec"><h2>남은 현금</h2>
                    <CashChart start={start.cash * 1e4} labels={monthSeq} months={done.map((x) => ({ days: x.days.map((d) => ({ cash: d.cash * 1e4 })) }))} />
                  </section>
                  <section className="sx-sec">
                    <h2>달마다</h2>
                    <table className="sx-table">
                      <thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>배달 비중</th><th>배달 수수료</th><th>사건 · 대응</th><th>월말 현금</th></tr></thead>
                      <tbody>{months.map((x) => (
                        <tr key={x.month}><td>{x.month}월</td><td>{man(w(x.revenue))}</td><td className={tone(x.op)}>{signed(x.op)}</td><td>{Math.round((x.ch.delivery / Math.max(1, x.revenue)) * 100)}%</td><td>{man(w(x.appFees + x.agencyFees))}</td><td>{x.event} · {x.choice}</td><td>{man(w(x.cash))}</td></tr>
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
