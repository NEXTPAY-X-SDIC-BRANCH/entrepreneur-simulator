// 카페의 3단계. 고깃집 가게 꾸미기(Builder.tsx)와 같은 틀: 전체 폭 3D 무대(왼쪽 위 가게 크기·마감·직원, 오른쪽 위 현금), 아래 물건 쟁반, 그 아래 열기 전 점검.
// 3D는 엔진(/cafe/preview)이 준 배치를 상자로만 그린 목업이고, 실제 3D 장면이 이 자리를 대체한다. 물건은 고깃집처럼 놓는 게 아니라 개수로 정한다.
import { useEffect, useMemo, useState } from "react";
import { Mark } from "./Checks";
import { CAFE_GRADES, CAFE_ITEM_GRADE, CAFE_ITEM_PRICE, CAFE_PYEONG, cafeEstimate, cafeOpeningCost } from "./cafe";
import { cafeChecks, cafeLayoutOf, type CafeCfg } from "./cafeChecks";
import CafeRoom3D, { type CafeEdit } from "./CafeRoom3D";
import { useCafePreview } from "./useCafePreview";
import { ItemIcon } from "./ItemTray";
import { STATUS_LABEL, guStat, man, type Grade, type Profile } from "./model";

type Layout = ReturnType<typeof cafeLayoutOf>;
type Item = { key: keyof Layout; name: string; note: string; min: number; max: number; need?: boolean };
const CATS: { key: string; label: string; items: Item[] }[] = [
  { key: "seat", label: "좌석", items: [
    { key: "tables", name: "테이블", note: "2~4인용", min: 0, max: 40 },
    { key: "chairs", name: "의자", note: "테이블에 붙는 자리", min: 0, max: 160 },
    { key: "bar", name: "바 좌석", note: "카운터 앞 자리", min: 0, max: 30 },
  ] },
  { key: "machine", label: "카운터와 머신", items: [
    { key: "groups", name: "에스프레소 머신 그룹", note: "그룹이 많을수록 동시에 뽑아요", min: 0, max: 4, need: true },
    { key: "kiosks", name: "키오스크", note: "주문 줄을 나눠 줘요", min: 0, max: 3 },
    { key: "pos", name: "계산대(POS)", note: "주문·결제 받는 곳", min: 0, max: 3, need: true },
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
  // 고깃집처럼 빈 가게에서 시작해 물건을 골라 채운다 (머신과 계산대는 꼭 있어야 열 수 있다)
  const EMPTY = { tables: 0, chairs: 0, bar: 0, groups: 0, showcase: 0, oven: 0, kiosks: 0, pos: 0 };
  useEffect(() => { if (!cfgIn || cfgIn.tables === undefined) setCfgOut({ ...cfg, ...EMPTY }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 3D에서 테이블(의자째)·키오스크를 누르고 바닥을 누르면 옮긴다. 엔진의 좌석 수 계산은 그대로
  const [sel, setSel] = useState<string | null>(null);
  const edit: CafeEdit = { sel, pick: setSel, move: (id, x, z) => { set({ moves: { ...(cfg.moves ?? {}), [id]: [Math.round(x * 10) / 10, Math.round(z * 10) / 10] } }); setSel(null); } };
  const missing = CATS.flatMap((c) => c.items).filter((it) => it.need && (lay[it.key] as number) < 1).map((it) => it.name);
  const open = cafeOpeningCost(cfg.pyeong, cfg.grade, profile.gu, profile.keyMoney ?? 0, lay, cfg.doors);
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
          {d ? <CafeRoom3D room={d.room} layout={d.layout} roster={d.staff.roster} height="fill" doors={cfg.doors} moves={cfg.moves} edit={edit} /> : <p className="m-loading">엔진을 부르는 중이에요</p>}
        </div>

        <div className="m-room">
          <div className="m-stepper">
            <span id="py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={cfg.pyeong <= 10} onClick={() => set({ pyeong: cfg.pyeong - 1 })}>−</button>
            <output aria-labelledby="py">{cfg.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={cfg.pyeong >= 80} onClick={() => set({ pyeong: cfg.pyeong + 1 })}>+</button>
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
          <div className="m-layout-row">
            <span id="cf-shape">가게 모양</span>
            <div className="m-seg" role="group" aria-labelledby="cf-shape">
              {([["wide", "가로로 긴"], ["square", "정사각"], ["deep", "세로로 긴"]] as const).map(([k, l]) => (
                <button type="button" key={k} aria-pressed={(cfg.shape ?? "wide") === k} onClick={() => set({ shape: k })}>{l}</button>
              ))}
            </div>
          </div>
          <div className="m-layout-row">
            <span id="cf-door">출입문</span>
            <div className="m-seg" role="group" aria-labelledby="cf-door">
              {([["left", "왼쪽"], ["right", "오른쪽"]] as const).map(([k, l]) => (
                <button type="button" key={k} aria-pressed={(cfg.door ?? "right") === k} onClick={() => set({ door: k })}>{l}</button>
              ))}
            </div>
          </div>
          <div className="m-stepper">
            <span id="cf-doors">출입문 수</span>
            <button type="button" aria-label="출입문 1개 빼기" disabled={(cfg.doors ?? 1) <= 1} onClick={() => ((n: number) => set({ doors: n }))((cfg.doors ?? 1) - 1)}>−</button>
            <output aria-labelledby="cf-doors">{(cfg.doors ?? 1)}개 · {man(150 * (cfg.doors ?? 1))}</output>
            <button type="button" aria-label="출입문 1개 더 달기" disabled={(cfg.doors ?? 1) >= 3} onClick={() => ((n: number) => set({ doors: n }))((cfg.doors ?? 1) + 1)}>+</button>
          </div>
          <p>테이블 {lay.tables}개, {seats}석</p>
          <button type="button" className="m-btn m-btn-quiet m-recbtn"
            onClick={() => setCfgOut({ pyeong: est.pyeong, grade: est.grade, staff: 1, doors: cfg.doors })}>추천 배치</button>
          <small className="it-place2">{sel ? "놓을 바닥을 누르세요." : "3D에서 테이블·키오스크를 누르고 바닥을 누르면 옮겨져요."}</small>
        </div>

        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{man(Math.abs(left))}</strong></p>
          <small>가진 돈 {man(profile.capital)} 중 {man(open.total)}을 썼어요.</small>
          {left < 0 && <p className="m-warn">가진 돈보다 여는 비용이 커요. 시뮬레이션에서는 모자란 만큼을 대출로 계산해요. 평수나 마감을 낮추면 줄어요.</p>}
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
                <div className="cs-card it-card">
                  <ItemIcon k={it.key} />
                  <span>{it.name}</span>
                  <small>{man(Math.round(CAFE_ITEM_PRICE[it.key] * CAFE_ITEM_GRADE[cfg.grade]))}/개{it.note ? `, ${it.note}` : ""}{it.need ? " · 꼭 필요" : ""}</small>
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
          {missing.length > 0 && <p className="m-warn it-need">꼭 필요한 물건을 아직 안 놓았어요: {missing.join(", ")} <button type="button" className="it-needbtn" onClick={() => set({ groups: Math.max(1, lay.groups), pos: Math.max(1, lay.pos) })}>한 번에 놓기</button></p>}
          <button type="button" className="m-btn" disabled={seats === 0 || missing.length > 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <section className="m-checks" aria-labelledby="checks-h">
        <p className="m-eyebrow" id="checks-h">열기 전 점검</p>
        <h1>{headline}</h1>
        <p className="m-sub">{profile.gu}, {cfg.pyeong}평, {seats}석, 직원 {cfg.staff}명 기준이에요. 여는 데 {man(open.total)}이 들어요(보증금 {man(open.lines.find((l) => l.key === "deposit")?.amount ?? 0)} 포함). 바꾸면 바로 다시 계산해요.</p>
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
