// 치킨집·분식집 6개월 시뮬레이션. 화면 틀은 옷가게 시뮬레이션(ApparelSim.tsx)과 같다:
// 가게(평면)가 화면 전체, 위에 지표 줄, 왼쪽에 현금 그래프와 이달 계획, 오른쪽에 날짜별 영수증, 아래에 재생 막대,
// 운영 계획 → 이달의 사건 → (하루씩 재생) → 정산 → 6개월 성적표는 팝업으로 뜬다.
// 계산은 quickfood.ts playMonth (달 단위, 서버 없음). 날짜별 값은 그달 결과를 이 구 업종의 요일별 매출 비중(상권분석서비스)으로 나눈 것이다.
import { useEffect, useLayoutEffect, useMemo, useState, useRef } from "react";
import Assume from "./Assume";
import { guStat, man, type Profile } from "./model";
import {
  DEFAULT_PLAN, EXTRAS, HOURS_DEFAULT, HOURS_RANGE, MAIN, PLAN_KEYS, QF_NAME, PACK_KRW, clock, extraPrice, hoursText, mixOf, mixStr, planText, sbizDelivery, type PlanKey, deliveryGuInfo, derived, eventOf, playMonth, qfOpeningCost, startState,
  type QfCfg, type QfEvent, type QfMonth, type QfOption, type QfPlan, type QfState, type QfStratId,
} from "./quickfood";
import ShopRoom3D, { shopPlan } from "./ShopRoom3D";
import QuickPicks, { type Pick as QPick } from "./QuickPicks";
import ModeSwitch from "./ModeSwitch";
import CashFlow, { type CfMonth } from "./CashFlow";
import Insight from "./Insight";
import { qfTries } from "./QfInsight";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import { CashChart, IconCal, IconCash, IconStar, Metric } from "./SimulateEngine";
import "./simulate-engine.css";
import CostBar from "./CostBar";
import { isDepLine } from "./shopItems";

const TURNS = 6;
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
type View = "intro" | "plan" | "scenario" | "settle" | "report" | null;
type Tick = { label: string; amount: number }; // 만원
type Day = { date: Date; tx: number; delivery: number; revenue: number; ticks: Tick[]; notes: string[]; fixedShare: number; cash: number };
type Done = { m: QfMonth; days: Day[]; s0: QfState; ev: QfEvent; opt: QfOption };
const w = (x: number) => Math.round(x); // 만원
const signed = (x: number) => (w(x) === 0 ? "0원" : `${x > 0 ? "+" : "−"}${man(Math.abs(w(x)))}`);
const tone = (x: number) => (w(x) > 0 ? "pos" : w(x) < 0 ? "neg" : "");
const n0 = (x: number) => Math.round(x).toLocaleString("ko-KR");
// hard 모드 단계: [항목, 최소, 최대, 한 번에]. 가격은 대표 메뉴 500원씩, 넓게 열어 둔다 (너무 비싸거나 싸면 주문이 크게 줄거나 남는 게 없어요)
const stepsOf = (ind: "chicken" | "bunsik"): [Exclude<PlanKey, "mix">, number, number, number][] => [
  ["price", 0.5, 2, 500 / MAIN[ind].p0], ["staff", 0, 6, 1], ["ad", 0, 2, 1], ["marketing", 0, 300, 25],
  ["open", HOURS_RANGE[ind].open[0], HOURS_RANGE[ind].open[1], 1], ["close", HOURS_RANGE[ind].close[0], HOURS_RANGE[ind].close[1], 1], ["pickup", 0, 0.3, 0.05],
  ["review", 0, 1, 1], ["minOrder", 9000, 24000, 1000], ["radius", 0.5, 4, 0.5], ["newMenu", 0, 1, 1],
];
// easy 모드: 방향을 고른 뒤 버튼으로 바꾸는 세 가지
// easy 모드에서는 꼭 정해야 하는 것만: 대표 메뉴 가격, 알바, 배달앱 광고
const picksOf = (ind: "chicken" | "bunsik"): QPick<QfPlan>[] => [
  { key: "price", label: `${MAIN[ind].name} 가격`, hint: "대표 메뉴 값. 올리면 한 건 값이 늘고 주문이 줄어요",
    opts: [-2, -1, 0, 1, 2].map((d) => { const step = ind === "chicken" ? 1000 : 500, v = +((MAIN[ind].p0 + d * step) / MAIN[ind].p0).toFixed(4); return { label: `${(MAIN[ind].p0 + d * step).toLocaleString("ko-KR")}원`, value: v }; }) },
  { key: "mix", label: "주로 어떻게 팔까요?", hint: "배달은 주문이 늘지만 수수료가 빠지고, 홀은 앉을 자리만큼만 받아요",
    opts: [{ label: "조사 평균대로", value: mixStr(mixOf(ind, { ...DEFAULT_PLAN })) }, { label: "배달 위주", value: "15-15-70" }, { label: "홀·포장 위주", value: "55-35-10" }, { label: "배달 안 함", value: "65-35-0" }] },
  { key: "staff", label: "알바", hint: "바쁜 날 주문을 놓치지 않게", opts: [0, 1, 2, 3].map((n) => ({ label: n ? `${n}명` : "없이", value: n })) },
  { key: "ad", label: "배달앱 광고", hint: "배달 주문을 늘리지만 광고비가 들어요", opts: [{ label: "안 함", value: 0 }, { label: "기본", value: 1 }, { label: "적극", value: 2 }] },
  { key: "open", label: "몇 시에 열까요?", hint: ind === "chicken" ? "치킨은 저녁 장사라 일찍 열어도 주문이 조금만 늘어요" : "분식은 점심(11~13시) 주문이 많아요",
    opts: Array.from({ length: 13 }, (_, i) => 6 + i).map((h) => ({ label: clock(h), value: h })) },
  { key: "close", label: "몇 시에 닫을까요?", hint: ind === "chicken" ? "야식 주문은 밤 10시~새벽 1시에 몰려요" : "분식은 저녁 8시 뒤로 주문이 적어요",
    opts: Array.from({ length: HOURS_RANGE[ind].close[1] - HOURS_RANGE[ind].close[0] + 1 }, (_, i) => HOURS_RANGE[ind].close[0] + i).map((h) => ({ label: clock(h), value: h })) },
];

// 홀·포장·배달 비중 정하기 (hard 모드). 한 갈래를 5% 올리면 나머지 중 큰 쪽에서 5%를 가져온다
function MixPicker({ ind, plan, prev, set, seats, gu }: { ind: "chicken" | "bunsik"; plan: QfPlan; prev?: QfPlan; set: (p: QfPlan) => void; seats: number; gu: string }) {
  const mx = mixOf(ind, plan), base = mixOf(ind, { ...DEFAULT_PLAN }), sb = sbizDelivery(ind, gu);
  const keys = [["visit", "홀"], ["takeout", "포장"], ["delivery", "배달"]] as const;
  const move = (k: keyof typeof mx, d: number) => {
    const n = { ...mx };
    const others = keys.map(([x]) => x).filter((x) => x !== k).sort((a, b) => (d > 0 ? n[b] - n[a] : n[a] - n[b]));
    const from = others.find((x) => (d > 0 ? n[x] >= 5 : n[x] <= 95));
    if (!from) return;
    n[k] += d; n[from] -= d;
    set({ ...plan, mix: mixStr(n) });
  };
  const pm = prev ? mixOf(ind, prev) : null;
  return (
    <div className="sx-mix">
      <div className="sx-mix-h"><b>판매 비중</b><Assume id="qfMix" /><small>조사한 평균은 홀 {base.visit}% · 포장 {base.takeout}% · 배달 {base.delivery}%{seats ? ` · 홀 자리 ${seats}석` : ""}</small>
        {sb?.gu && <small className="sx-mix-src">{gu} {ind === "chicken" ? "치킨집" : "분식집"} 한 곳은 한 달에 배달 주문 <b>{sb.gu.orders.toLocaleString("ko-KR")}건</b>, 배달 매출 <b>{Math.round(sb.gu.sales / 1e4).toLocaleString("ko-KR")}만원</b>을 받아요 (서울 가운데값 {sb.seoul.orders.toLocaleString("ko-KR")}건, 배달 한 건 {sb.gu.ticket.toLocaleString("ko-KR")}원). 소상공인365 배달분석 {sb.ym.slice(0, 4)}년 {+sb.ym.slice(4)}월</small>}</div>
      <div className="sx-mix-bar" aria-hidden>{keys.map(([k, l]) => <span key={k} className={`is-${k}`} style={{ flexGrow: mx[k] || 0.001 }}>{mx[k] >= 12 ? `${l} ${mx[k]}%` : ""}</span>)}</div>
      <div className="sx-mix-c">
        {keys.map(([k, l]) => (
          <div key={k} className={`sx-mix-k is-${k}${pm && pm[k] !== mx[k] ? " is-changed" : ""}`}>
            <span>{l}</span>
            <button type="button" aria-label={`${l} 비중 5% 낮추기`} disabled={mx[k] < 5} onClick={() => move(k, -5)}>−</button>
            <output>{mx[k]}%</output>
            <button type="button" aria-label={`${l} 비중 5% 높이기`} disabled={mx[k] > 95} onClick={() => move(k, 5)}>+</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// 매출 100원이 어디로 갔나: 비용 항목과 남은 이익을 한 줄 막대로

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
// 홀·포장·배달을 갈래마다 카드 하나로: 주문·매출·빠지는 돈(식재료·수수료·용기)·한 건에 남는 돈. 색은 판매 비중 막대와 같다
function ChannelCards({ m, pack }: { m: QfMonth; pack: number }) {
  const fr = m.revenue > 0 ? m.food / m.revenue : 0;
  const rows: [string, string, number, number, number, number][] = [
    ["visit", "홀", m.orders.visit, m.ch.visit, 0, 0],
    ["takeout", "포장", m.orders.takeout, m.ch.takeout, 0, (m.orders.takeout * pack) / 1e4],
    ["delivery", "배달", m.orders.delivery, m.ch.delivery, m.appFees + m.agencyFees, (m.orders.delivery * pack) / 1e4],
  ];
  const per = (r: number, f: number, p: number, o: number) => ((r - r * fr - f - p) * 1e4) / Math.max(1, o);
  const best = Math.max(...rows.filter((x) => x[2] > 0).map(([, , o, r, f, p]) => per(r, f, p, o)));
  return (
    <div className="ch-cards">
      {rows.map(([k, l, o, r, f, p]) => {
        const left = r - r * fr - f - p, one = per(r, f, p, o);
        return (
          <article key={k} className={`ch-card is-${k}`}>
            <header><b>{l}</b>{o > 0 && one === best && <span className="ch-best">한 건에 가장 많이 남아요</span>}</header>
            <dl>
              <div><dt>주문</dt><dd>{n0(o)}건</dd></div>
              <div><dt>매출</dt><dd>{man(w(r))}</dd></div>
              <div><dt>식재료</dt><dd>−{man(w(r * fr))}</dd></div>
              <div><dt>배달 수수료</dt><dd>{f ? `−${man(w(f))}` : "없음"}</dd></div>
              <div><dt>용기</dt><dd>{p ? `−${man(w(p))}` : "없음"}</dd></div>
            </dl>
            <footer><span>남는 돈</span><strong>{man(w(left))}</strong><small>한 건 {n0(one)}원</small></footer>
          </article>
        );
      })}
    </div>
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
  const [plan, setPlan] = useState<QfPlan>({ ...DEFAULT_PLAN, ...HOURS_DEFAULT[cfg.ind], staff: cfg.staff });
  const PT = planText(cfg.ind), STEPS = stepsOf(cfg.ind), PICKS = picksOf(cfg.ind);
  // 계획 값이 비어 있으면 기본값 (영업 시각은 업종 기본, 나머지는 DEFAULT_PLAN)
  const cur0 = (k: Exclude<PlanKey, "mix">): number => (plan[k] as number | undefined) ?? (k === "open" || k === "close" ? HOURS_DEFAULT[cfg.ind][k] : (DEFAULT_PLAN[k] as number | undefined) ?? 0);
  const seats = useMemo(() => shopPlan(cfg.ind === "chicken" ? "chicken" : "bunsik", cfg.pyeong, cfg.layout).seats.length, [cfg]);
  const [, setStrat] = useState<QfStratId>("rec");
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
  const dep = open.lines.filter((l) => isDepLine(l.key)).reduce((a, l) => a + l.amount, 0) / 60; // 5년 감가상각
  // 현금흐름표·영수증 (원). 엔진 현금 = 월초 + 영업이익 − 생활비 − 이자
  const cfMonths: CfMonth[] = months.map((c, i) => {
    const s0 = i ? months[i - 1].cash : start.cash, K = 1e4;
    return { month: c.month, start: s0 * K, end: c.cash * K, lines: [
      { label: "매출 (홀·포장·배달)", amount: c.revenue * K }, { label: "식재료", amount: -c.food * K }, { label: "알바 인건비", amount: -c.staffPay * K },
      { label: "월세", amount: -c.rent * K }, { label: "공과금·카드 수수료 등", amount: -c.other * K },
      { label: "배달앱 중개수수료", amount: -c.appFees * K }, { label: "배달대행비", amount: -c.agencyFees * K }, { label: "배달·포장 용기", amount: -(c.packaging ?? 0) * K }, { label: "배달앱 광고", amount: -c.adCost * K },
      { label: "홍보·사건 대응", amount: -(c.marketing + c.eventCost) * K }, { label: "사장 생활비", amount: -c.draw * K }, { label: "대출 이자", amount: -c.interest * K },
    ], tax: { revenue: c.revenue * K, farmBuy: c.food * K, taxableBuy: (c.rent + c.other * 0.5 + c.appFees + c.agencyFees + c.adCost) * K, profit: (c.op - dep - c.interest) * K } };
  });
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
    setPlan(mode === "easy" ? { ...plan, ...tweak } : plan);
    setChoice(ev.options[ev.options.length - 1].id);
    setView("scenario");
  };
  const play = () => {
    const opt = ev.options.find((o) => o.id === choice) ?? ev.options[0];
    const r = playMonth(profile, cfg, state, m, plan, ev, opt, seats);
    setDone((d) => [...d, { m: r.month, days: buildDays(r.month, yearOf(idx), state.cash, st.dow), s0: state, ev, opt }]);
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
  const receiptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { receiptEnd.current?.scrollIntoView({ block: "end" }); }, [receiptDays.length, receipt]); // 새 날짜가 찍히면 영수증 끝으로
  const sc = months.length ? score(months) : null;
  const delivShare = cur ? cur.m.ch.delivery / Math.max(1, cur.m.revenue) : dv.share.delivery;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas"><ShopRoom3D kind={cfg.ind === "chicken" ? "chicken" : "bunsik"} pyeong={cfg.pyeong} layout={cfg.layout} people={people} riders={riders} height="fill" /></div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 식재료·배달 수수료는 그날그날, 월세·광고는 1일, 알바 급여는 10일, 생활비·이자는 25일에 나가요.</>}>{man(w(cashNow))}</Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 6개월을 한 달씩 진행해요.</>}>
          {view === "intro" ? `${startMonth}월 시작` : `${view === null || view === "settle" || view === "report" ? cur?.m.month ?? m : m}월 · ${Math.min(view === null || view === "settle" || view === "report" ? idx : idx + 1, TURNS)}/${TURNS}`}
        </Metric>
        <Metric icon={<IconBike />} label="배달 비중" tip={<>매출 중 배달 몫이에요. 배달은 한 건마다 배달앱 {n0(dv.appFee * 1e4)}원, 배달대행 {n0(dv.agencyFee * 1e4)}원이 빠져요 (경영실태조사 이용 가게 평균).</>}>
          {Math.round(delivShare * 100)}%
        </Metric>
        <Metric icon={<IconStar />} label="인지도" tip={<>1.00이 동네에서 평소 알려진 수준이에요. 새 가게는 0.60에서 시작해 매달 1.00 쪽으로 15%씩 다가가요<Assume id="awareness" />.</>}>
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
              {PLAN_KEYS.filter((k) => k !== "close").map((k) => {
                const before = done.length > 1 ? done[done.length - 2].m.plan : null;
                const tx = (p: QfPlan) => (k === "open" ? hoursText(cfg.ind, p) : PT[k].text(p));
                return <div key={k} className={before && tx(before) !== tx(cur.m.plan) ? "is-changed" : undefined}><dt>{k === "open" ? "영업시간" : PT[k].label}</dt><dd>{tx(cur.m.plan)}</dd></div>;
              })}
              {EXTRAS[cfg.ind].map((e) => { const v = extraPrice(e, cur.m.plan); return <div key={e.key}><dt>{e.name.split(" (")[0]}</dt><dd>{v ? `${v.toLocaleString("ko-KR")}원` : "안 팔아요"}</dd></div>; })}
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
            <p className="sx-r-acc">회색 줄은 현금이 아니라 이익 계산이에요. '오늘 몫 고정비'는 월세·급여·생활비 등을 날짜로 나눈 몫이에요. 한 달 {Math.round(dv.openDays)}일 연다는 조사값 대신 매일 연다고 봤어요<Assume id="openDaily" />.</p>
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
            <div ref={receiptEnd} />
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
                  <h1>{profile.gu}에서 {name} 6개월<ModeSwitch mode={mode} set={setMode} /></h1>
                  <p className="sx-note sx-modenote">{mode === "easy" ? <><b>easy 모드</b> · 달마다 방향만 골라요: 추천대로 / 주문 늘리기 / 비용 아끼기. 이달의 사건 대응도 골라요.</> : <><b>hard 모드</b> · 달마다 가격·알바·배달앱 광고·홍보비를 하나씩 정해요.</>}</p>
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
                  <h1>{m}월 운영 계획<ModeSwitch locked mode={mode} set={setMode} /></h1>
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
                      <section className="sx-right" aria-label="이번 달 운영 계획">
                        <h2>{m}월에 이렇게 할게요</h2>
                        <QuickPicks picks={PICKS} base={plan} prev={cur?.m.plan} tweak={tweak} setTweak={setTweak} />
                        <p className="sx-note">hard 모드에서는 여기에 더해 SNS 홍보비·여는 시각·닫는 시각·포장 할인과 사이드·음료·주류 같은 곁들임 메뉴 가격까지 하나씩 정해요.</p>
                      </section>
                    ) : (
                      <section className="sx-right" aria-label="이번 달 운영 계획">
                        <h2>{m}월에 이렇게 할게요</h2>
                        <MixPicker ind={cfg.ind} plan={plan} prev={cur?.m.plan} set={setPlan} seats={seats} gu={profile.gu} />
                        <div className="sx-steps">
                          {STEPS.map(([k, lo, hi, step]) => {
                            const before = cur?.m.plan;
                            const changed = before && PT[k].text(before) !== PT[k].text(plan);
                            return (
                              <div key={k} className={`sx-step${changed ? " is-changed" : ""}`}>
                                <div className="sx-step-t">
                                  <span className="sx-step-l">{PT[k].label}{PT[k].hint.includes("가정") && <Assume id={k === "ad" ? "adBoost" : k === "pickup" ? "pickup" : k === "price" ? "elastic" : k === "open" || k === "close" ? "qfHours" : undefined} what={PT[k].hint} />}</span>
                                  <small>{PT[k].hint}</small>
                                  {changed && <small className="sx-step-prev">지난달 {PT[k].text(before!)}</small>}
                                </div>
                                <div className="sx-step-c">
                                  <button type="button" aria-label={`${PT[k].label} 낮추기`} disabled={cur0(k) - step < lo - 1e-9} onClick={() => setPlan({ ...plan, [k]: +(cur0(k) - step).toFixed(4) })}>−</button>
                                  <output>{PT[k].text(plan)}</output>
                                  <button type="button" aria-label={`${PT[k].label} 높이기`} disabled={cur0(k) + step > hi + 1e-9} onClick={() => setPlan({ ...plan, [k]: +(cur0(k) + step).toFixed(4) })}>+</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <p className="sx-note">영업시간 {hoursText(cfg.ind, plan)}. 처음 가격 기준 주문 한 건 평균은 조사한 {name}의 객단가 {n0(dv.ticket)}원이에요 (곁들임 포함).</p>
                        <h3 className="sx-sub">곁들임 메뉴 가격 <Assume id="qfExtras" /></h3>
                        <div className="sx-steps">
                          {EXTRAS[cfg.ind].map((e) => {
                            const v = extraPrice(e, plan), set = (x: number) => setPlan({ ...plan, extras: { ...(plan.extras ?? {}), [e.key]: x } });
                            const bv = cur ? extraPrice(e, cur.m.plan) : v;
                            return (
                              <div key={e.key} className={`sx-step${bv !== v ? " is-changed" : ""}`}>
                                <div className="sx-step-t">
                                  <span className="sx-step-l">{e.name}</span>
                                  <small>처음 {e.p0.toLocaleString("ko-KR")}원 · 홀 주문 100건 중 {Math.round(e.a0.visit * 100)}건, 배달 100건 중 {Math.round(e.a0.delivery * 100)}건이 같이 시켜요. 원가율 {Math.round(e.cost * 100)}%</small>
                                  {bv !== v && <small className="sx-step-prev">지난달 {bv ? `${bv.toLocaleString("ko-KR")}원` : "안 팔아요"}</small>}
                                </div>
                                <div className="sx-step-c">
                                  <button type="button" aria-label={`${e.name} 가격 낮추기`} disabled={v <= 0} onClick={() => set(Math.max(0, v - 500))}>−</button>
                                  <output>{v ? `${v.toLocaleString("ko-KR")}원` : "안 팔아요"}</output>
                                  <button type="button" aria-label={`${e.name} 가격 높이기`} disabled={v + 500 > e.max} onClick={() => set(v + 500)}>+</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <p className="sx-note">가격을 0원까지 내리면 그 메뉴를 팔지 않아요. 곁들임은 대표 메뉴보다 가격에 민감하다고 봤어요.</p>
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
                    <p className="sx-note">사장님의 선택이 이번 달 주문과 이익을 바꿔요. 장점(+)과 단점(−)을 보고 하나를 골라 주세요. {ev.note}.<Assume id="eventEffect" what={`${ev.title}의 효과 크기 (${ev.note})`} /></p>
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
                      { label: "나간 돈", value: man(w(c.revenue - c.op)) },
                      { label: "영업이익", value: signed(c.op), tone: tone(c.op) },
                      { label: "월말 현금", value: man(w(c.cash)), main: true },
                    ]} />
                    {c.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}
                    <Insight tries={qfTries(profile, cfg, cur.s0, c, cur.ev, cur.opt, seats)} last={c.closed || done.length >= TURNS}
                      onApply={(patch) => { if (mode === "easy") setTweak(patch); else setPlan({ ...c.plan, ...patch }); next(); }} />
                    <CostBar items={[
                      ["식재료", c.food], ["배달 수수료", fees], ["포장 용기", c.packaging ?? 0], ["인건비", c.staffPay], ["월세", c.rent], ["기타", c.other], ["광고·홍보", c.adCost + c.marketing + c.eventCost],
                    ]} revenue={c.revenue} op={c.op} fmt={(x) => man(Math.round(x))} />
                    <CashFlow months={cfMonths} kind="food" shop={name} compact />
                    <details className="sx-more">
                      <summary>정산표와 홀·포장·배달별 자세히 보기</summary>
                      <section className="st-card">
                        <header className="st-h"><span className="st-ico" aria-hidden>₩</span><div><h2>정산표</h2><small>이번 달 매출에서 비용을 하나씩 뺀 계산이에요</small></div></header>
                        <table className="sx-table st-table"><tbody>
                          <tr><th>매출</th><td>{man(w(c.revenue))}</td><td>주문 약 {n0(c.tx)}건, 한 건 {n0(c.ticket)}원<Assume id="elastic" what="평수 효과(제곱근), 새 가게 인지도, 가격 탄력성 2" /></td></tr>
                          <tr><th>식재료비</th><td>−{man(w(c.food))}</td><td>매출의 {Math.round((c.food / Math.max(1, c.revenue)) * 100)}%, 이달 식재료 시세 {c.foodMult.toFixed(2)}배<Assume id="priceCheck" /></td></tr>
                          <tr><th>배달 수수료</th><td>−{man(w(fees))}</td><td>배달 {n0(c.orders.delivery)}건 × {n0(dv.appFee * 1e4 + dv.agencyFee * 1e4)}원</td></tr>
                          <tr><th>배달·포장 용기</th><td>−{man(w(c.packaging ?? 0))}</td><td>배달·포장 {n0(c.orders.delivery + c.orders.takeout)}건 × {PACK_KRW[cfg.ind]}원<Assume id="qfPacking" /></td></tr>
                          <tr><th>인건비</th><td>{c.staffPay ? `−${man(w(c.staffPay))}` : "0원"}</td><td>알바 {c.plan.staff}명</td></tr>
                          <tr><th>월세</th><td>−{man(w(c.rent))}</td><td /></tr>
                          <tr><th>기타경비</th><td>−{man(w(c.other))}</td><td>카드 수수료·가스·전기 등<Assume id="otherCost" /></td></tr>
                          {c.adCost + c.marketing + c.eventCost > 0 && <tr><th>광고·홍보·사건 대응</th><td>−{man(w(c.adCost + c.marketing + c.eventCost))}</td><td /></tr>}
                          <tr className="sum"><th>영업이익</th><td>{signed(c.op)}</td><td>조사한 {name} 평균 이익률 {Math.round(dv.opMargin * 1000) / 10}%</td></tr>
                          <tr><th>감가상각·이자</th><td>−{man(w(dep + c.interest))}</td><td>감가상각은 현금이 안 나가요</td></tr>
                          <tr className="sum"><th>세전이익</th><td>{signed(pre)}</td><td /></tr>
                        </tbody></table>
                      </section>
                      <section className="st-card">
                        <header className="st-h"><span className="st-ico is-ch" aria-hidden>⇄</span><div><h2>홀·포장·배달, 어디서 남았나</h2><small>같은 메뉴라도 배달은 한 건마다 수수료와 용기값이 빠져요. 월세·알바비는 갈래와 상관없이 나가요</small></div></header>
                        <ChannelCards m={c} pack={PACK_KRW[cfg.ind]} />
                        <div className="st-ev"><b>이번 달 사건</b><ul className="sx-evs"><li><b>{c.event}</b><span>고른 대응: {c.choice}</span></li></ul></div>
                      </section>
                    </details>
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
                    plans={months.map((x) => [PT.price.text(x.plan), PT.mix.text(x.plan), `알바 ${x.plan.staff}명`, hoursText(cfg.ind, x.plan)].join(" · "))}
                  />
                  <section className="sx-sec"><h2>남은 현금</h2>
                    <CashChart start={start.cash * 1e4} labels={monthSeq} months={done.map((x) => ({ days: x.days.map((d) => ({ cash: d.cash * 1e4 })) }))} />
                  </section>
                  <details className="sx-more sc-more rp-more"><summary>돈의 흐름 · 현금흐름표 · 달마다 기록 자세히 보기</summary>
                  <CashFlow months={cfMonths} kind="food" shop={name} />
                  <section className="sx-sec">
                    <h2>달마다</h2>
                    <table className="sx-table">
                      <thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>배달 비중</th><th>배달 수수료</th><th>사건 · 대응</th><th>월말 현금</th></tr></thead>
                      <tbody>{months.map((x) => (
                        <tr key={x.month}><td>{x.month}월</td><td>{man(w(x.revenue))}</td><td className={tone(x.op)}>{signed(x.op)}</td><td>{Math.round((x.ch.delivery / Math.max(1, x.revenue)) * 100)}%</td><td>{man(w(x.appFees + x.agencyFees))}</td><td>{x.event} · {x.choice}</td><td>{man(w(x.cash))}</td></tr>
                      ))}</tbody>
                    </table>
                  </section>
                  </details>
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
