// lab:modes — 이지 모드: 업종, 동네, 가진 돈(평수)만 받고 나머지는 자료로 채워 6개월을 한 번에 돌린다 (sim/easy.py).
// 결과 → 성적표 → 다음 판 입력 고치기 → 다시 해보기. 판 기록은 attempts.ts (이 브라우저 탭에만).
import { useEffect, useRef, useState } from "react";
import { dongsOf, man, type Gu, type Profile } from "../../mock/model";
import { PICKER, type LabIndustry } from "../industry/industries";
import { easyRun, netErr, type EasyInputs, type EasyRes, type Overrides } from "./api";
import { addAttempt, nextAttemptNo, useAttempts, type Attempt } from "./attempts";
import Compare, { AttemptLine, Parts, controlOf, manWon, signedMan } from "./Compare";
import { scoreOf } from "./scoreStub";
import { bbqSummary, cafeSummary, easyInputsOf, genericSummary } from "./summary";
import "./modes.css";

const PRESETS = [3000, 5000, 10000, 20000];
const nextMonth = () => (new Date().getMonth() + 1) % 12 + 1;
const IND_KO = (id: string) => PICKER.find((p) => p.id === id)?.name ?? id;
type Kind = "bbq" | "cafe" | "generic";
const kindOf = (id: string): Kind => (id === "bbq" ? "bbq" : id === "cafe" ? "cafe" : "generic");

export type HardSeed = { industry: "bbq" | "cafe" | LabIndustry; pyeong: number; tables: number; staff: number; price: number; loan_man: number; dong: string | null };

type Ctl = { key: keyof Overrides | "loan"; label: string; min: number; max: number; step: number; fmt: (v: number) => string };
const CTLS: Record<Kind, Ctl[]> = {
  bbq: [
    { key: "pyeong", label: "평수", min: 10, max: 40, step: 1, fmt: (v) => `${v}평` },
    { key: "tables", label: "4인 테이블", min: 1, max: 20, step: 1, fmt: (v) => `${v}개` },
    { key: "staff", label: "교대당 알바", min: 0, max: 4, step: 1, fmt: (v) => `${v}명` },
    { key: "price", label: "삼겹살 1인분", min: 15000, max: 25000, step: 1000, fmt: (v) => `${v.toLocaleString("ko-KR")}원` },
    { key: "loan", label: "대출", min: 0, max: 50000, step: 500, fmt: (v) => man(v) },
  ],
  cafe: [
    { key: "pyeong", label: "평수", min: 10, max: 40, step: 1, fmt: (v) => `${v}평` },
    { key: "staff", label: "바쁜 시간 직원 (사장님 빼고)", min: 0, max: 7, step: 1, fmt: (v) => `${v}명` },
    { key: "loan", label: "운전자금 대출 (가게 비용 대출 외)", min: 0, max: 50000, step: 500, fmt: (v) => man(v) },
  ],
  generic: [
    { key: "pyeong", label: "평수", min: 10, max: 40, step: 1, fmt: (v) => `${v}평` },
    { key: "tables", label: "테이블", min: 0, max: 40, step: 1, fmt: (v) => `${v}개` },
    { key: "staff", label: "직원 (사장님 빼고)", min: 0, max: 8, step: 1, fmt: (v) => `${v}명` },
    { key: "loan", label: "운전자금 대출 (가게 비용 대출 외)", min: 0, max: 50000, step: 500, fmt: (v) => man(v) },
  ],
};

// ---- 돈이 모자란 판, 현금이 영업이익과 다르게 움직이는 이유 (엔진 응답에 이미 있는 값만 읽는다) ----------------------------
const man0 = (v: number) => (Math.round(v) === 0 ? "0원" : man(v));
type Funding = { own: number; opening: number; loan: number; share: number }; // 원
function fundingOf(res: EasyRes, s: { opening_cost: number; loan: number }): Funding {
  const own = res.inputs.capital_man * 1e4;
  let opening = s.opening_cost, loan = s.loan;
  if (res.generic) {
    const st = res.generic.start as unknown as { capex?: { total_krw: number } };
    opening = st.capex?.total_krw ?? opening;
    loan = res.generic.start.loan.principal_krw;
  }
  return { own, opening, loan, share: own + loan > 0 ? loan / (own + loan) : 0 };
}

type Move = { label: string; won: number };
type CashBits = { depreciation_addback_krw?: number; owner_pay_addback_krw?: number; loan_interest_krw?: number; loan_principal_krw?: number; vat_refund_krw?: number };
/** i번째 달에 영업이익 말고 현금을 움직인 것 (원). 엔진이 주는 항목으로 설명이 안 되는 차이는 '그 밖의 현금 움직임'으로 남긴다. */
function movesOf(res: EasyRes, i: number, op: number, delta: number): Move[] {
  const out: Move[] = [];
  if (res.bbq) {
    const r = res.bbq.ledger.rows[i] as { interest?: number; principal?: number } | undefined;
    const debt = (r?.interest ?? 0) + (r?.principal ?? 0);
    if (debt) out.push({ label: r?.principal ? "대출 원리금" : "대출 이자", won: -debt });
  } else {
    const c = ((res.cafe ?? res.generic)?.months[i] as unknown as { cash?: CashBits } | undefined)?.cash ?? {};
    if (c.vat_refund_krw) out.push({ label: "부가세 환급", won: c.vat_refund_krw });
    if (c.owner_pay_addback_krw) out.push({ label: "사장님 몫 되돌림", won: c.owner_pay_addback_krw });
    if (c.depreciation_addback_krw) out.push({ label: "감가상각 되돌림", won: c.depreciation_addback_krw });
    const debt = (c.loan_interest_krw ?? 0) + (c.loan_principal_krw ?? 0);
    if (debt) out.push({ label: "대출 원리금", won: -debt });
  }
  const rest = delta - op - out.reduce((a, m) => a + m.won, 0);
  if (Math.abs(rest) >= 1e4) out.push({ label: "그 밖의 현금 움직임", won: rest });
  return out;
}

/** 6개월 흐름 표 밑 설명: 업종 엔진마다 남은 현금을 계산하는 방식이 달라서 나눠 쓴다 */
function cashNote(res: EasyRes): string {
  const m0 = (k: keyof CashBits) => {
    const c = ((res.cafe ?? res.generic)?.months[0] as unknown as { cash?: CashBits } | undefined)?.cash ?? {};
    return c[k] ?? 0;
  };
  if (res.bbq) {
    const r = res.bbq.ledger.rows[0] as { interest?: number; principal?: number } | undefined;
    const owner = (res.bbq.months[0]?.kpis.labor_owner as number | undefined) ?? 0;
    const debt = r ? (r.interest ?? 0) + (r.principal ?? 0) : 0;
    return `남은 현금은 영업이익에서 ${debt ? `대출 ${r?.principal ? "원리금" : "이자"}(월 ${manWon(debt)})만 더 뺀 값이에요` : "더하거나 뺀 것 없이 그대로 쌓은 값이에요"}.`
      + (owner ? ` 사장님 생활비 월 ${manWon(owner)}은 영업이익의 인건비에서 이미 뺐어요 (가정).` : "");
  }
  const parts: string[] = [];
  const dep = m0("depreciation_addback_krw"), own = m0("owner_pay_addback_krw");
  const debt = m0("loan_interest_krw") + m0("loan_principal_krw");
  if (dep) parts.push(`감가상각(월 ${manWon(dep)})은 실제로 나가는 돈이 아니라서 되돌려 더해요`);
  if (own) parts.push(`사장님 몫(월 ${manWon(own)})은 영업이익에서는 비용으로 뺐지만 현금에서는 빼지 않았어요 (생활비는 가게 돈에서 쓰지 않는다고 봄, 가정)`);
  if (debt) parts.push(`대출 원리금(월 ${manWon(debt)})은 빼요`);
  const months = (res.cafe ?? res.generic)?.months ?? [];
  const vi = months.findIndex((m) => ((m as unknown as { cash?: CashBits }).cash?.vat_refund_krw ?? 0) > 0);
  if (vi >= 0) {
    const m = months[vi];
    parts.push(`${m.calendar_month}월에는 가게를 열 때 낸 부가세 ${manWon((m as unknown as { cash: CashBits }).cash.vat_refund_krw ?? 0)}을 돌려받아요`);
  }
  if (!own) parts.push("사장님 생활비는 영업이익에서도 남은 현금에서도 빼지 않았어요 (가정)");
  return `남은 현금은 영업이익과 똑같이 움직이지 않아요. ${parts.join(". ")}.`;
}

function valuesOf(i: EasyInputs): Record<string, number | undefined> {
  if (kindOf(i.industry) === "generic") return { pyeong: i.pyeong, tables: i.tables, staff: i.staff, loan: undefined };
  return i.industry === "cafe"
    ? { pyeong: i.pyeong, staff: i.staff, loan: undefined }
    : { pyeong: i.store?.pyeong, tables: i.store?.tables, staff: i.staff, price: i.price, loan: undefined };
}

export default function Easy({ profile, setProfile, gus, onHard, onModes }: {
  profile: Profile; setProfile: (p: Profile) => void; gus: Gu[]; onHard: (seed: HardSeed) => void; onModes: () => void;
}) {
  const ind = profile.industry;
  const kind = kindOf(ind);
  const [pyeong, setPyeong] = useState<number | null>(null);
  const [phase, setPhase] = useState<"form" | "run" | "result">("form");
  const [err, setErr] = useState("");
  const [res, setRes] = useState<EasyRes | null>(null);
  const [cur, setCur] = useState<Attempt | null>(null);
  const [next, setNext] = useState<Record<string, number | undefined>>({});
  const [flash, setFlash] = useState("");
  const startMonth = useRef(nextMonth());
  const list = useAttempts(ind);
  const prev = cur ? list.filter((a) => a.n < cur.n).at(-1) : undefined;
  const set = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch });
  const dong = profile.dong && profile.dong.gu === profile.gu ? profile.dong.name : null;
  const dongs = dongsOf(profile.gu);

  useEffect(() => { if (flash) { const t = setTimeout(() => setFlash(""), 1600); return () => clearTimeout(t); } }, [flash]);

  const run = async (overrides?: Overrides) => {
    setErr(""); setPhase("run");
    try {
      const r = await easyRun({ industry: ind, gu: profile.gu, dong, capital_man: profile.capital, pyeong, start_month: startMonth.current, overrides });
      const n = nextAttemptNo(ind);
      const inputs = easyInputsOf(r.inputs, r.generic);
      const summary = r.bbq
        ? bbqSummary(r.bbq, r.inputs.run.invest, r.inputs.run.loan, inputs, "easy", n)
        : r.generic ? genericSummary(r.generic, inputs, "easy", n)
        : cafeSummary(r.cafe!, inputs, "easy", n);
      const scored = await scoreOf(summary);
      const a = addAttempt(summary, scored);
      if (r.inputs.dong && r.inputs.dong !== dong) set({ dong: { gu: profile.gu, name: r.inputs.dong } }); // 카페: 자동으로 고른 동을 하드 모드로 넘긴다
      setRes(r); setCur(a); setNext(valuesOf(r.inputs)); setPhase("result");
      scrollTo({ top: 0 });
    } catch (e) { setErr(netErr(e)); setPhase(res ? "result" : "form"); }
  };

  const again = () => {
    const ov: Overrides = { pyeong: next.pyeong, staff: next.staff };
    if (kind === "bbq") { ov.tables = next.tables; ov.price = next.price; }
    if (kind === "generic") ov.tables = next.tables;
    if (next.loan !== undefined) ov.loan_man = next.loan;
    run(ov);
  };

  const focusCtl = (key: string) => {
    const el = document.getElementById(`lm-ctl-${key}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(key);
    (el.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  };

  if (phase === "form" || (phase === "run" && !res)) {
    const busy = phase === "run";
    return (
      <main className="m-profile lm-easy">
        <p className="m-progress"><button type="button" onClick={onModes}>연습 방식 다시 고르기</button><span>이지 모드</span></p>
        <form className="m-q" onSubmit={(e) => { e.preventDefault(); if (profile.capital >= 500) run(); }}>
          <h1 className="lm-h1">세 가지만 알려 주세요</h1>
          <p className="m-help">나머지(평수, 테이블, 직원, 가격, 월세)는 서울 상권 자료, 외식업 실태조사와 추천 규칙으로 채워요. 채운 값과 근거는 결과 화면에 다 보여 드려요.</p>
          <div className="lm-form">
            <fieldset>
              <legend>어떤 가게</legend>
              <div className="m-seg lm-inds" role="group" aria-label="업종">
                {PICKER.map((p) => (
                  <button key={p.id} type="button" aria-pressed={ind === p.id} onClick={() => set({ industry: p.id as Profile["industry"], dong: undefined })}>{p.name}</button>
                ))}
              </div>
            </fieldset>
            <label className="lm-field">
              <span>어느 구</span>
              <select value={profile.gu} onChange={(e) => set({ gu: e.target.value, dong: undefined })}>
                {(gus.length ? gus.map((g) => g.name) : [profile.gu]).map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label className="lm-field">
              <span>동네 <small>선택</small></span>
              <select value={dong ?? ""} onChange={(e) => set({ dong: e.target.value ? { gu: profile.gu, name: e.target.value } : undefined })}>
                <option value="">{kind === "cafe" ? "고르지 않음 (구 평균에 가까운 동)" : "고르지 않음 (구 전체)"}</option>
                {dongs.map((d) => <option key={d.code} value={d.name}>{d.name}</option>)}
              </select>
            </label>
            <div className="lm-field">
              <label htmlFor="lm-cap">가진 돈 (대출 빼고)</label>
              <div className="lm-money"><input id="lm-cap" type="number" inputMode="numeric" min={500} step={100} value={profile.capital || ""}
                onChange={(e) => set({ capital: Math.max(0, Number(e.target.value)) })} /><span>만원</span></div>
              <small>{profile.capital >= 500 ? man(profile.capital) : "500만원 이상을 적어 주세요"}</small>
              <div className="m-presets">{PRESETS.map((p) => <button type="button" key={p} onClick={() => set({ capital: p })}>{man(p)}</button>)}</div>
            </div>
            <div className="lm-field">
              <span id="lm-py">평수 <small>선택</small></span>
              <div className="m-stepper" aria-labelledby="lm-py">
                <span>{pyeong ? `${pyeong}평` : kind === "generic" ? "업종 보통 크기로 골라요" : "가진 돈에 맞춰 골라요"}</span>
                <button type="button" aria-label="평수 줄이기" disabled={pyeong !== null && pyeong <= 10} onClick={() => setPyeong(Math.max(10, (pyeong ?? 20) - 1))}>−</button>
                <button type="button" aria-label="평수 늘리기" disabled={pyeong !== null && pyeong >= 40} onClick={() => setPyeong(Math.min(40, (pyeong ?? 19) + 1))}>+</button>
                {pyeong !== null && <button type="button" className="m-link lm-auto" onClick={() => setPyeong(null)}>자동</button>}
              </div>
            </div>
          </div>
          {err && <p className="lm-err" role="alert">{err}</p>}
          <div className="m-actions">
            <button type="submit" className="m-btn" disabled={busy || profile.capital < 500}>{busy ? "6개월을 돌리는 중이에요" : "6개월 돌려 보기"}</button>
          </div>
          {kind === "bbq" && <p className="lm-quiet lm-center">고깃집은 동네마다 처음 한 번 손님 흐름을 계산해서 15초쯤 걸려요. 같은 동네 다음 판은 바로 나와요.</p>}
        </form>
      </main>
    );
  }

  if (!res || !cur) return null;
  const inp = res.inputs;
  const s = cur.summary;
  const ctls = CTLS[kind];
  // 성적표가 고른 고칠 점(fixes.lever)이 가리키는 입력 칸을 미리 표시한다 (값은 학습자가 정한다)
  const suggested: Record<string, string> = {};
  for (const f of cur.scored.score.fixes) { const c = controlOf(f.lever); if (c && !suggested[c]) suggested[c] = f.text; }
  const changedNext = Object.entries(valuesOf(inp)).some(([k, v]) => next[k] !== v) || next.loan !== undefined;
  // 카페·새 업종의 대출 칸은 가게 비용 대출 외 운전자금이라 자동값도 운전자금만 보여 준다 (전체 대출을 보여 주면 + 한 번에 대출이 두 배가 된다)
  const autoLoanWon = res.cafe ? ((res.cafe.start.start as { extra_loan_krw?: number }).extra_loan_krw ?? 0)
    : res.generic ? ((res.generic.start.loan as { extra_krw?: number }).extra_krw ?? 0) : s.loan ?? 0;
  const loanAuto = kind === "bbq" ? inp.shown.find((x) => x.key === "loan")?.src !== "입력" : inp.run.extra_loan_krw === undefined;
  const fund = fundingOf(res, s);
  const short = fund.opening - fund.own;
  const pyeongAuto = inp.shown.find((x) => x.key === "pyeong")?.src !== "입력";
  const basisOf = (x: EasyInputs["shown"][number]) => {
    if (x.key !== "pyeong" || !pyeongAuto) return x.basis;
    if (kind === "bbq" && inp.fits_capital === false)
      return `가진 돈으로 열 수 있는 크기가 없어서 가장 작은 가게(${inp.store?.pyeong}평, 테이블 ${inp.store?.tables}개)로 정하고, 모자란 돈은 빌린다고 봤어요`;
    if (kind === "bbq" && inp.safe_by_rule === false)
      return "가진 돈으로 열 수 있는 크기 중 손님이 20% 적어도 6개월을 버티는 크기는 없어서, 그때 6개월 끝 현금이 가장 많이 남는 크기를 골랐어요";
    if (kind === "cafe" && short > 0)
      return "독립 카페 면적 중앙값 20평에서 시작해 여는 비용 + 석 달 운영비(1,650만원, 가정)에 맞춰 줄였는데, 가장 작은 10평도 가진 돈으로는 모자라서 모자란 돈은 빌린다고 봤어요";
    return x.basis;
  };
  return (
    <main className="lm-result">
      <header className="lm-head">
        <h1 className="lm-h1">{cur.n}판째 결과예요</h1>
        <p className="lm-sub">{IND_KO(ind)}, {inp.gu}{inp.dong ? ` ${inp.dong}` : ""}, 가진 돈 {man(inp.capital_man)}, {s.months[0]?.month}월에 열어 6개월</p>
      </header>
      {short > 0 && (
        <aside className="lm-short" role="note" aria-label="가진 돈으로는 열 수 없는 계획">
          <b>가진 돈으로는 이 가게를 열 수 없어요</b>
          <p>가진 돈 {man0(inp.capital_man)}으로는 여는 비용 {manWon(fund.opening)}을 낼 수 없어서, {manWon(fund.loan)}(창업 자금의 {Math.round(fund.share * 100)}%)을 빌린다고 보고 돌렸어요.
            {kind === "bbq" ? " 하드 모드에서는 대출을 직접 정해야 문을 열 수 있어요." : " 하드 모드에서도 모자란 돈은 대출로 계산해요."}
            {" "}빌린 돈이 클수록 다달이 나가는 {kind === "bbq" ? "이자가" : "원리금이"} 커져요. 가진 돈을 바꿔 보려면 맨 아래 조건부터 다시 정하기를 눌러 주세요.</p>
        </aside>
      )}
      <Compare prev={prev} cur={cur} onFix={focusCtl} derived={loanAuto ? ["loan_man"] : []} />
      <AttemptLine list={list} />

      <section className="lm-sec">
        <h2>6개월 흐름</h2>
        <table className="lm-tbl lm-months">
          <thead><tr><th scope="col">달</th><th scope="col">매출</th><th scope="col">영업이익</th><th scope="col">남은 현금</th></tr></thead>
          <tbody>
            <tr><th scope="row">문 열 때<small>여는 비용 {manWon(s.opening_cost)}{s.loan > 0 ? `, 대출 ${manWon(s.loan)}` : ""}</small></th><td></td><td></td><td>{manWon(s.start_cash)}</td></tr>
            {s.months.map((m, i) => {
              const delta = m.cash_after - (i ? s.months[i - 1].cash_after : s.start_cash);
              const o = Math.round(m.op / 1e4), d = Math.round(delta / 1e4);
              const opposite = o !== 0 && Math.sign(o) !== Math.sign(d);
              const moves = opposite ? movesOf(res, i, m.op, delta) : [];
              return [
                <tr key={i} className={opposite ? "has-why" : ""}><th scope="row">{m.month}월</th><td>{manWon(m.revenue)}</td><td className={m.op < 0 ? "is-neg" : ""}>{signedMan(m.op)}</td>
                  <td className={m.cash_after < 0 ? "is-neg" : ""}>{manWon(m.cash_after)}</td></tr>,
                opposite && (
                  <tr key={`${i}-why`} className="lm-why"><td colSpan={4}>
                    <small>{o < 0 ? `영업이익은 ${signedMan(m.op)}인데 현금은 ${manWon(delta)} 늘었어요` : `영업이익은 ${signedMan(m.op)}인데 현금은 ${manWon(-delta)} 줄었어요`}. 현금 변화 이유: {moves.map((x) => `${x.label} ${signedMan(x.won)}`).join(", ")}</small>
                  </td></tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {s.closed && <p className="lm-closed">{s.months.length}개월째 문을 닫았어요. {s.closed_reason ?? ""}</p>}
        <small className="lm-cashnote">{cashNote(res)}</small>
      </section>

      {prev && <div className="lm-two"><Parts cur={cur} /><div /></div>}

      <section className="lm-sec">
        <h2>이번 판에 채운 값과 근거</h2>
        <table className="lm-tbl lm-shown">
          <tbody>
            {inp.shown.map((x) => (
              <tr key={x.key}>
                <th scope="row">{x.label}</th>
                <td>{typeof x.value === "number" ? (x.value === 0 && x.unit === "만원" ? "0원" : `${x.value.toLocaleString("ko-KR")}${x.unit}`) : `${x.value}${x.unit}`}</td>
                <td><span className={`lm-src lm-src-${x.src === "가정" ? "a" : x.src === "입력" ? "i" : "d"}`}>{x.src}</span></td>
                <td><small>{basisOf(x)}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="lm-sec lm-next" aria-labelledby="lm-next-h">
        <h2 id="lm-next-h">{cur.n + 1}판 입력</h2>
        <small>업종, 동네, 가진 돈은 그대로예요. 아래 값만 바꿔서 다시 돌려요. 시드가 같아서 점수가 바뀌면 그건 바꾼 값 때문이에요.</small>
        <div className="lm-ctls">
          {ctls.map((c) => {
            const k = c.key as string;
            const v = next[k];
            const auto = k === "loan" && v === undefined;
            const base = k === "loan" ? Math.round(autoLoanWon / 1e4) : (v ?? c.min);
            const cur0 = auto ? base : (v as number);
            return (
              <div key={k} id={`lm-ctl-${k}`} className={`lm-ctl${flash === k ? " is-flash" : ""}${suggested[k] ? " is-suggested" : ""}`} data-suggested={suggested[k] ? "1" : undefined}>
                <span className="lm-ctl-l">{c.label}</span>
                {suggested[k] && <small className="lm-sugg">성적표 제안: {suggested[k]}</small>}
                <div className="m-stepper">
                  <output>{auto ? `자동 (${man0(base)})` : c.key === "loan" ? man0(cur0) : c.fmt(cur0)}</output>
                  <button type="button" aria-label={`${c.label} 줄이기`} disabled={cur0 - c.step < c.min} onClick={() => setNext({ ...next, [k]: Math.max(c.min, cur0 - c.step) })}>−</button>
                  <button type="button" aria-label={`${c.label} 늘리기`} disabled={cur0 + c.step > c.max} onClick={() => setNext({ ...next, [k]: Math.min(c.max, cur0 + c.step) })}>+</button>
                </div>
                {k === "loan" && !auto && <button type="button" className="m-link" onClick={() => setNext({ ...next, loan: undefined })}>자동으로</button>}
                {k === "loan" && auto && <small>{kind === "bbq" ? "모자란 돈 + 석 달 고정비만큼 (가정)" : "석 달 고정비만큼 (가정). 가게 비용 대출은 따로 자동으로 정해요"}</small>}
              </div>
            );
          })}
        </div>
        {err && <p className="lm-err" role="alert">{err}</p>}
        <div className="lm-actions">
          <button type="button" className="m-btn" disabled={phase === "run"} onClick={again}>
            {phase === "run" ? "돌리는 중이에요" : `${cur.n + 1}판 돌려 보기${changedNext ? "" : " (같은 입력)"}`}
          </button>
          <button type="button" className="m-btn m-btn-quiet" onClick={() => onHard({
            industry: ind, pyeong: inp.store?.pyeong ?? inp.pyeong ?? 20, tables: inp.store?.tables ?? inp.tables ?? 0, staff: inp.staff,
            price: inp.price ?? 19000, loan_man: inp.loan_man ?? 0, dong: inp.dong,
          })}>하드 모드로 이어서 하기</button>
          <button type="button" className="m-link" onClick={() => { setPhase("form"); setRes(null); setCur(null); scrollTo({ top: 0 }); }}>조건부터 다시 정하기</button>
        </div>
      </section>
    </main>
  );
}
