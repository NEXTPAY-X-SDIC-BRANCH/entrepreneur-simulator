// lab:modes — 이지 모드: 업종, 동네, 가진 돈(평수)만 받고 나머지는 자료로 채워 6개월을 한 번에 돌린다 (sim/easy.py).
// 결과 → 성적표 → 다음 판 입력 고치기 → 다시 해보기. 판 기록은 attempts.ts (이 브라우저 탭에만).
import { useEffect, useRef, useState } from "react";
import { dongsOf, man, type Gu, type Profile } from "../../mock/model";
import { PICKER, type LabIndustry } from "../industry/industries";
import { easyRun, netErr, type EasyInputs, type EasyRes, type Overrides } from "./api";
import { addAttempt, nextAttemptNo, useAttempts, type Attempt } from "./attempts";
import Compare, { AttemptLine, Parts, manWon, signedMan } from "./Compare";
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
  const changedNext = Object.entries(valuesOf(inp)).some(([k, v]) => next[k] !== v) || next.loan !== undefined;
  return (
    <main className="lm-result">
      <header className="lm-head">
        <h1 className="lm-h1">{cur.n}판째 결과예요</h1>
        <p className="lm-sub">{IND_KO(ind)}, {inp.gu}{inp.dong ? ` ${inp.dong}` : ""}, 가진 돈 {man(inp.capital_man)}, {s.months[0]?.month}월에 열어 6개월</p>
      </header>
      <Compare prev={prev} cur={cur} onFix={focusCtl} />
      <AttemptLine list={list} />

      <section className="lm-sec">
        <h2>6개월 흐름</h2>
        <table className="lm-tbl lm-months">
          <thead><tr><th scope="col">달</th><th scope="col">매출</th><th scope="col">영업이익</th><th scope="col">남은 현금</th></tr></thead>
          <tbody>
            <tr><th scope="row">문 열 때<small>여는 비용 {manWon(s.opening_cost)}{s.loan > 0 ? `, 대출 ${manWon(s.loan)}` : ""}</small></th><td></td><td></td><td>{manWon(s.start_cash)}</td></tr>
            {s.months.map((m, i) => (
              <tr key={i}><th scope="row">{m.month}월</th><td>{manWon(m.revenue)}</td><td className={m.op < 0 ? "is-neg" : ""}>{signedMan(m.op)}</td>
                <td className={m.cash_after < 0 ? "is-neg" : ""}>{manWon(m.cash_after)}</td></tr>
            ))}
          </tbody>
        </table>
        {s.closed && <p className="lm-closed">{s.months.length}개월째 문을 닫았어요. {s.closed_reason ?? ""}</p>}
        {kind === "bbq" ? <small>남은 현금은 사장님 생활비 월 300만원과 대출 이자를 뺀 값이에요 (가정).</small>
          : <small>남은 현금은 대출 원리금을 뺀 값이고, 사장님 생활비는 빼지 않았어요 (고깃집과 다른 점, 가정).</small>}
      </section>

      {prev && <div className="lm-two"><Parts cur={cur} /><div /></div>}

      <section className="lm-sec">
        <h2>이번 판에 채운 값과 근거</h2>
        <table className="lm-tbl lm-shown">
          <tbody>
            {inp.shown.map((x) => (
              <tr key={x.key}>
                <th scope="row">{x.label}</th>
                <td>{typeof x.value === "number" ? `${x.value.toLocaleString("ko-KR")}${x.unit}` : `${x.value}${x.unit}`}</td>
                <td><span className={`lm-src lm-src-${x.src === "가정" ? "a" : x.src === "입력" ? "i" : "d"}`}>{x.src}</span></td>
                <td><small>{x.basis}</small></td>
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
            const base = k === "loan" ? Math.round((s.loan ?? 0) / 1e4) : (v ?? c.min);
            const cur0 = auto ? base : (v as number);
            return (
              <div key={k} id={`lm-ctl-${k}`} className={`lm-ctl${flash === k ? " is-flash" : ""}`}>
                <span className="lm-ctl-l">{c.label}</span>
                <div className="m-stepper">
                  <output>{auto ? `자동 (${man(base)})` : c.fmt(cur0)}</output>
                  <button type="button" aria-label={`${c.label} 줄이기`} disabled={cur0 - c.step < c.min} onClick={() => setNext({ ...next, [k]: Math.max(c.min, cur0 - c.step) })}>−</button>
                  <button type="button" aria-label={`${c.label} 늘리기`} disabled={cur0 + c.step > c.max} onClick={() => setNext({ ...next, [k]: Math.min(c.max, cur0 + c.step) })}>+</button>
                </div>
                {k === "loan" && !auto && <button type="button" className="m-link" onClick={() => setNext({ ...next, loan: undefined })}>자동으로</button>}
                {k === "loan" && auto && <small>모자란 돈 + 석 달 고정비만큼 (가정)</small>}
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
