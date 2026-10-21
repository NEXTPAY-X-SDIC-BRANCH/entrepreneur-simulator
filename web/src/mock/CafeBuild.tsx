// 카페의 3단계. 고깃집 가게 꾸미기(Builder.tsx)와 같은 틀: 전체 폭 3D 무대(왼쪽 위 가게 크기·마감·직원, 오른쪽 위 현금), 아래 물건 쟁반, 그 아래 열기 전 점검.
// 3D는 엔진(/cafe/preview)이 준 배치를 상자로만 그린 목업이고, 실제 3D 장면이 이 자리를 대체한다. 물건은 고깃집처럼 놓는 게 아니라 개수로 정한다.
import { useMemo, useState } from "react";
import { Mark } from "./Checks";
import SettledStack, { cafeSettled } from "../lab/cost/SettledStack"; // lab:cost
import { CAFE_GRADES, CAFE_PYEONG, cafeEstimate, cafeOpeningCost } from "./cafe";
import { cafeChecks, cafeLayoutOf, type CafeCfg } from "./cafeChecks";
import CafeRoom3D from "./CafeRoom3D";
import FinanceBox from "../lab/finance/FinanceBox"; // lab:finance
import { CAFE_DEFAULT_RATE } from "../lab/finance/finance"; // lab:finance
import { useCafePreview } from "./useCafePreview";
import { STATUS_LABEL, guStat, man, type Grade, type Profile } from "./model";

type Layout = ReturnType<typeof cafeLayoutOf>;
type Item = { key: keyof Layout; name: string; note: string; min: number; max: number };
const CATS: { key: string; label: string; items: Item[] }[] = [
  { key: "seat", label: "좌석", items: [
    { key: "tables", name: "테이블", note: "2~4인용", min: 0, max: 40 },
    { key: "chairs", name: "의자", note: "테이블에 붙는 자리", min: 0, max: 160 },
    { key: "bar", name: "바 좌석", note: "카운터 앞 자리", min: 0, max: 30 },
  ] },
  { key: "machine", label: "카운터와 머신", items: [
    { key: "groups", name: "에스프레소 머신 그룹", note: "그룹이 많을수록 동시에 뽑아요", min: 1, max: 4 },
    { key: "kiosks", name: "키오스크", note: "주문 줄을 나눠 줘요", min: 0, max: 3 },
    { key: "pos", name: "계산대(POS)", note: "", min: 1, max: 3 },
  ] },
  { key: "kitchen", label: "진열과 조리", items: [
    { key: "showcase", name: "디저트 진열장", note: "디저트를 팔려면 필요해요", min: 0, max: 1 },
    { key: "oven", name: "오븐", note: "구움 디저트용", min: 0, max: 1 },
  ] },
];

export default function CafeBuild({ profile, cfg: cfgIn, setCfg: setCfgOut, onNext }: { profile: Profile; cfg: CafeCfg | null; setCfg: (c: CafeCfg) => void; onNext: () => void }) {
  const est = useMemo(() => cafeEstimate(profile, 3 * 550), [profile.gu, profile.capital, profile.keyMoney]); // eslint-disable-line react-hooks/exhaustive-deps
  const cfg: CafeCfg = cfgIn ?? { pyeong: est.pyeong, grade: est.grade, staff: 1 };
  const [cat, setCat] = useState(CATS[0].key);
  const pv = useCafePreview(profile, cfg);
  const lay = cafeLayoutOf(cfg);
  const { list, settled } = useMemo(() => cafeChecks(profile, cfg), [profile, cfg]);
  const open = cafeOpeningCost(cfg.pyeong, cfg.grade, profile.gu, profile.keyMoney ?? 0);
  const st = guStat(profile.gu);
  const left = profile.capital - open.total;
  const set = (p: Partial<CafeCfg>) => setCfgOut({ ...cfg, ...p });
  const seats = pv.data?.seats.total ?? 0;
  const headline = settled <= 0
    ? <>보통 카페 기준으로는 자리가 잡혀도 한 달에 <mark>{man(-settled)}씩 줄어요.</mark></>
    : <>보통 카페 기준으로 자리가 잡히면 한 달에 <mark>{man(settled)}</mark>이 남아요.</>;

  const d = pv.data;
  const msg = pv.err ? pv.err
    : !d ? "엔진에서 배치를 받아 오는 중이에요."
    : d.space.overflow.length > 0 ? `공간이 모자라요: ${d.space.overflow.map((o) => `${o.type} ${o.count}개`).join(", ")}. ${d.space.fix[0]?.label_ko ?? ""}`
    : `먼저 막히는 곳은 ${d.bottleneck[0].label_ko}이에요. ${d.suggestion.label_ko ? `제안: ${d.suggestion.label_ko} (${d.suggestion.effect_ko})` : ""}`;

  return (
    <main className="m-build">
      <div className="m-stage">
        <div className="m-canvas">
          {d ? <CafeRoom3D room={d.room} layout={d.layout} roster={d.staff.roster} height="fill" /> : <p className="m-loading">엔진을 부르는 중이에요</p>}
        </div>

        <div className="m-room">
          <div className="m-stepper">
            <span id="py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={cfg.pyeong <= 10} onClick={() => set({ pyeong: cfg.pyeong - 1, tables: undefined, chairs: undefined })}>−</button>
            <output aria-labelledby="py">{cfg.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={cfg.pyeong >= 30} onClick={() => set({ pyeong: cfg.pyeong + 1, tables: undefined, chairs: undefined })}>+</button>
          </div>
          <div className="m-seg" role="group" aria-label="마감 수준">
            {(Object.keys(CAFE_GRADES) as Grade[]).map((g) => (
              <button type="button" key={g} aria-pressed={cfg.grade === g} onClick={() => set({ grade: g })}>{CAFE_GRADES[g].label}</button>
            ))}
          </div>
          <div className="m-stepper">
            <span id="st">직원 수</span>
            <button type="button" aria-label="직원 1명 줄이기" disabled={cfg.staff <= 0} onClick={() => set({ staff: cfg.staff - 1 })}>−</button>
            <output aria-labelledby="st">{cfg.staff}명</output>
            <button type="button" aria-label="직원 1명 늘리기" disabled={cfg.staff >= 3} onClick={() => set({ staff: cfg.staff + 1 })}>+</button>
          </div>
          <p>테이블 {lay.tables}개, {seats}석</p>
          <button type="button" className="m-btn m-btn-quiet m-recbtn"
            onClick={() => setCfgOut({ pyeong: est.pyeong, grade: est.grade, staff: 1 })}>추천 배치</button>
        </div>

        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{man(Math.abs(left))}</strong></p>
          <small>가진 돈 {man(profile.capital)} 중 {man(open.total)}을 썼어요.</small>
          {left < 0 && <p className="m-warn">가진 돈보다 여는 비용이 커요. 시뮬레이션에서는 모자란 만큼을 대출로 계산해요. 평수나 마감을 낮추면 줄어요.</p>}
          <FinanceBox loanMan={Math.max(0, -left)} rentMan={st.rent * cfg.pyeong} fallback={CAFE_DEFAULT_RATE} young={profile.age === "20대" || profile.age === "30대"} />{/* lab:finance 은행별 가상 금리, 월세 카드 할부 */}
        </div>

        <p className="m-msg" role="status">{msg}</p>
      </div>

      <div className="m-tray">
        <dl className="m-spent">
          {open.lines.filter((l) => l.amount > 0).map((l) => <div key={l.key}><dt>{l.label}</dt><dd>{man(l.amount)}</dd></div>)}
        </dl>
        <div className="m-cats" role="tablist" aria-label="물건 종류">
          {CATS.map((c) => <button type="button" role="tab" key={c.key} aria-selected={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</button>)}
        </div>
        <ul className="m-catalog">
          {CATS.find((c) => c.key === cat)!.items.map((it) => {
            const v = lay[it.key] as number;
            return (
              <li key={it.key}>
                <div className="cs-card">
                  <span>{it.name}</span>
                  <small>{it.note || " "}</small>
                  <div className="m-stepper">
                    <button type="button" aria-label={`${it.name} 줄이기`} disabled={v <= it.min} onClick={() => set({ [it.key]: v - 1 } as Partial<CafeCfg>)}>−</button>
                    <output>{v}</output>
                    <button type="button" aria-label={`${it.name} 늘리기`} disabled={v >= it.max} onClick={() => set({ [it.key]: v + 1 } as Partial<CafeCfg>)}>+</button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="m-tray-go">
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          <button type="button" className="m-btn" disabled={seats === 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <section className="m-checks" aria-labelledby="checks-h">
        <p className="m-eyebrow" id="checks-h">열기 전 점검</p>
        <h1>{headline}</h1>
        <p className="m-sub">{profile.gu}, {cfg.pyeong}평, {seats}석, 직원 {cfg.staff}명 기준이에요. 여는 데 {man(open.total)}이 들어요(보증금 {man(open.lines.find((l) => l.key === "deposit")?.amount ?? 0)} 포함). 바꾸면 바로 다시 계산해요.</p>
        <SettledStack stack={cafeSettled(profile, cfg)} note="헤드라인의 금액은 아래 비용을 모두 뺀 값이에요." />{/* lab:cost */}
        <ul className="m-checklist">
          {list.map((c) => (
            <li key={c.key}>
              <Mark s={c.status} />
              <div>
                <h2>{c.title}<span className={`m-status is-${c.status}`}>{STATUS_LABEL[c.status]}</span></h2>
                <p>{c.line}</p>
                {c.todo && <p className="m-todo">{c.todo}</p>}
                {c.rows && (
                  <ul className="m-shockrows">
                    {c.rows.map((r) => <li key={r.label} className={r.ok ? "is-ok" : "is-weak"}><span>{r.label}</span><b>{r.value}</b></li>)}
                  </ul>
                )}
                <details><summary>이렇게 계산했어요</summary><p>{c.rule}</p></details>
              </div>
            </li>
          ))}
        </ul>
        <p className="m-aside">
          비용 구조(식재료 39.1%, 세금·공과 6.0%, 기타 5.8%, 객단가 5,704원, 임시직 월 158만원, 대표자 월 211만원)는 외식업체 경영실태조사 2025의 커피전문점 전국 평균이에요.
          프랜차이즈가 섞여 있어서 독립 카페와 다를 수 있어요. 매출은 {profile.gu}의 보통 카페(중앙값) {man(st.sales)}이고, 사장 생활비를 비용으로 뺐어요.
          평수 {CAFE_PYEONG.low}~{CAFE_PYEONG.high}평은 독립 카페 면적의 중간 절반 범위예요.
        </p>
      </section>
    </main>
  );
}
