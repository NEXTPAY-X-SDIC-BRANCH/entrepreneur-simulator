// 카페의 3단계. 고깃집 가게 꾸미기(Builder.tsx)와 같은 틀: 전체 폭 3D 무대(왼쪽 위 가게 크기·마감·직원, 오른쪽 위 현금), 아래 물건 쟁반, 그 아래 열기 전 점검.
// 3D는 엔진(/cafe/preview)이 준 배치를 상자로만 그린 목업이고, 실제 3D 장면이 이 자리를 대체한다. 물건은 고깃집처럼 놓는 게 아니라 개수로 정한다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Mark } from "./Checks";
import SettledStack, { cafeSettled } from "../lab/cost/SettledStack"; // lab:cost
import { CAFE_PYEONG, cafeDistrictCode, cafeDong, cafeEstimate } from "./cafe";
import { cafeChecks, cafeDaily, cafeLayoutOf, cafeOpenFromEngine, engineBody, type CafeCfg, type CafeOpen } from "./cafeChecks";
import CafeRoom3D, { type CafeEdit } from "./CafeRoom3D";
import { ItemIcon } from "./ItemTray"; // lab:merge 수빈 물건 그림
import FinanceBox from "../lab/finance/FinanceBox"; // lab:finance
import { CAFE_DEFAULT_RATE } from "../lab/finance/finance"; // lab:finance
import { ENGINE, useCafePreview } from "./useCafePreview";
import { STATUS_LABEL, guStat, man, type Profile } from "./model";
// lab:layout: 문·창문 tab (가로:세로, 출입문, 창문), 손님 동선 from the engine's plan
import { setView } from "./Scene3D";
import { FlowCard, ShapePanel } from "../lab/layout/ShapePanel";
import { cafeDoorsFit, cafeFlow, cafeRatioOk, shapeFromRoom, type CafeItem, type CafeRoom } from "../lab/layout/cafeFlow";
import { CAFE_DOOR_MARGIN, CAFE_SHAPE, doorCount, type RoomShape } from "../lab/layout/shape";

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
  { key: "room", label: "문·창문", items: [] }, // lab:layout
];

export default function CafeBuild({ profile, cfg: cfgIn, setCfg: setCfgOut, onNext }: { profile: Profile; cfg: CafeCfg | null; setCfg: (c: CafeCfg) => void; onNext: () => void }) {
  const est = useMemo(() => cafeEstimate(profile, 3 * 550), [profile.gu, profile.capital, profile.keyMoney]); // eslint-disable-line react-hooks/exhaustive-deps
  const cfg: CafeCfg = cfgIn ?? { pyeong: est.pyeong, grade: est.grade, staff: 1 };
  // 아무것도 안 바꾸고 시뮬레이션으로 가도 이 화면의 구성(추천 평수)이 넘어가게 한다. 전에는 Mock의 기본값 20평이 넘어가
  // 가진 돈이 적을 때 가게 꾸미기(예: 10평)와 시뮬레이션(20평)의 여는 비용이 달랐다
  // lab:merge 수빈: 고깃집처럼 빈 가게에서 시작해 물건을 골라 채운다 (머신과 계산대는 꼭 있어야 열 수 있다). 여는 비용은 그대로 엔진 값
  const EMPTY = { tables: 0, chairs: 0, bar: 0, groups: 0, showcase: 0, oven: 0, kiosks: 0, pos: 0 };
  useEffect(() => { if (!cfgIn || cfgIn.tables === undefined) setCfgOut({ ...cfg, ...EMPTY }); }, []); // eslint-disable-line react-hooks/exhaustive-deps  (처음 열 때만: 추천 배치는 개수를 비워 추천값을 쓴다)
  const [cat, setCat] = useState(CATS[0].key);
  const pv = useCafePreview(profile, cfg);
  const lay = cafeLayoutOf(cfg);
  // 여는 비용과 대출은 엔진 값 하나만 쓴다: 시뮬레이션과 같은 손님 수(cafeDaily)로 미리보기를 한 번 더 불러 funding을 받는다.
  // 그래야 운전자금(월 고정비 3개월치, 인건비가 손님 수에 따라 달라짐)까지 시뮬레이션 시작 화면과 같은 값이 된다.
  const [eng, setEng] = useState<{ key: string; open: CafeOpen } | null>(null);
  const engKey = JSON.stringify([profile.gu, profile.dong, profile.capital, cfg]);
  useEffect(() => {
    const d = pv.data as unknown as Parameters<typeof cafeDaily>[0] | null;
    if (!d?.demand) return;
    let alive = true;
    const body = { ...engineBody(profile, cfg, cafeDistrictCode(profile)), daily_customers: cafeDaily(d, profile.gu, cfg.pyeong) };
    fetch(`${ENGINE}/cafe/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((j) => { if (alive && j?.capex?.lines && j.funding) setEng({ key: engKey, open: cafeOpenFromEngine(j.capex, j.funding) }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [pv.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = eng?.open ?? null;
  const fresh = !!eng && eng.key === engKey;
  const { list, settled } = useMemo(() => cafeChecks(profile, cfg, open), [profile, cfg, open]);
  const st = guStat(profile.gu);
  const noDong = !(profile.dong && profile.dong.gu === profile.gu);
  const dongPick = cafeDong(profile); // lab:merge 수빈: 구만 골라도 대표 동네로 시뮬
  const set = (p: Partial<CafeCfg>) => { setNote(""); setCfgOut({ ...cfg, ...p }); }; // lab:layout clears the shape note
  const seats = pv.data?.seats.total ?? 0;
  // lab:merge 수빈: 3D에서 테이블(의자째)·키오스크를 누르고 바닥을 누르면 옮긴다. 엔진의 좌석 수 계산은 그대로
  const [sel, setSel] = useState<string | null>(null);
  const edit: CafeEdit = { sel, pick: setSel, move: (id, x, z) => { set({ moves: { ...(cfg.moves ?? {}), [id]: [Math.round(x * 10) / 10, Math.round(z * 10) / 10] } }); setSel(null); } };
  const missing = CATS.flatMap((c) => c.items).filter((it) => it.need && (lay[it.key] as number) < 1).map((it) => it.name);
  // lab:layout: room shape, route, and a line saying what a shape change did once the engine answers
  const shape = cfg.shape ?? CAFE_SHAPE;
  const area = cfg.pyeong * 3.3058, rw = Math.sqrt(area * shape.ratio), rd = area / rw;
  const [flowOn, setFlowOn] = useState(false);
  const flow = useMemo(() => (pv.data ? cafeFlow(pv.data.room, pv.data.layout) : null), [pv.data]);
  const [note, setNote] = useState("");
  const pending = useRef<{ what: string; seats: number; tables: number; route: number } | null>(null);
  useEffect(() => {
    const p = pending.current, dd = pv.data;
    if (!p || !dd) return;
    const s = cafeLayoutOf(cfg), got = shapeFromRoom(dd.room as CafeRoom);
    if (got.door.wall !== shape.door.wall || Math.abs(got.door.pos - shape.door.pos) > 1e-3 || Math.abs(got.ratio - shape.ratio) > 0.01) return; // still the old answer
    pending.current = null;
    const tables = dd.layout.filter((i) => i.type === "table" && i.fits).length, route = flow ? Math.round(flow.total) : 0;
    const parts = [p.tables === tables ? `테이블 ${tables}개 그대로` : `테이블 ${p.tables}→${tables}개`, p.seats === dd.seats.total ? `${dd.seats.total}석 그대로` : `${p.seats}→${dd.seats.total}석`];
    if (p.route || route) parts.push(`손님 동선 ${p.route}m→${route}m`);
    const over = dd.space.overflow.length ? ` 공간이 모자라요: ${dd.space.overflow.map((o) => `${o.type} ${o.count}개`).join(", ")}.` : "";
    setNote(`${p.what} ${parts.join(", ")}.${tables < s.tables ? ` 테이블 ${s.tables - tables}개는 자리가 없어 가게 밖(빨간색)에 있어요.` : ""}${over}`);
  }, [pv.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // lab:merge 출입문 수: 엔진 배치가 문 앞을 막아 다 못 달면 달 수 있는 만큼으로 줄인다 (그림·여는 비용·엔진이 같은 수)
  useEffect(() => {
    const dd = pv.data;
    if (!dd || doorCount(shape) < 2) return;
    const n = cafeDoorsFit(dd.room as CafeRoom, dd.layout as CafeItem[], shape);
    if (n >= doorCount(shape)) return;
    setCfgOut({ ...cfg, shape: { ...shape, doors: n } });
    setNote(`문 앞 1.2m를 비울 자리가 모자라 출입문은 ${n}개까지 달 수 있어요. 테이블을 줄이면 더 달 수 있어요.`);
  }, [pv.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const onShape = (next: RoomShape, what: string) => {
    const dd = pv.data;
    const moved = next.ratio !== shape.ratio || next.door.wall !== shape.door.wall || next.door.pos !== shape.door.pos;
    pending.current = dd && moved ? { what, seats: dd.seats.total, tables: dd.layout.filter((i) => i.type === "table" && i.fits).length, route: flow ? Math.round(flow.total) : 0 } : null;
    setNote(what);
    setCfgOut({ ...cfg, shape: next });
  };
  const headline = settled <= 0
    ? <>보통 카페 기준으로는 자리가 잡혀도 한 달에 <mark>{man(-settled)}씩 줄어요.</mark></>
    : <>보통 카페 기준으로 자리가 잡히면 한 달에 <mark>{man(settled)}</mark>이 남아요.</>;

  const d = pv.data;
  const msg = pv.err ? pv.err
    : note ? note // lab:layout
    : !d ? "엔진에서 배치를 받아 오는 중이에요."
    : d.space.overflow.length > 0 ? `공간이 모자라요: ${d.space.overflow.map((o) => `${o.type} ${o.count}개`).join(", ")}. ${d.space.fix[0]?.label_ko ?? ""}`
    : `먼저 막히는 곳은 ${d.bottleneck[0].label_ko}이에요. ${d.suggestion.label_ko ? `제안: ${d.suggestion.label_ko} (${d.suggestion.effect_ko})` : ""}`;

  return (
    <main className="m-build">
      <div className="m-stage">
        <div className="m-canvas">
          {d ? <CafeRoom3D room={d.room} layout={d.layout} roster={d.staff.roster} height="fill" shape={shape} flow={flowOn ? flow : null} moves={cfg.moves} edit={edit} /> : <p className="m-loading">엔진을 부르는 중이에요</p>}
        </div>

        <div className="m-room">
          <div className="m-stepper">
            <span id="py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={cfg.pyeong <= 10} onClick={() => set({ pyeong: cfg.pyeong - 1, moves: undefined })}>−</button>
            <output aria-labelledby="py">{cfg.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={cfg.pyeong >= 80} onClick={() => set({ pyeong: cfg.pyeong + 1, moves: undefined })}>+</button>
          </div>
          <div className="m-stepper">
            <span id="st">직원 수</span>
            <button type="button" aria-label="직원 1명 줄이기" disabled={cfg.staff <= 0} onClick={() => set({ staff: cfg.staff - 1 })}>−</button>
            <output aria-labelledby="st">{cfg.staff}명</output>
            <button type="button" aria-label="직원 1명 늘리기" disabled={cfg.staff >= 3} onClick={() => set({ staff: cfg.staff + 1 })}>+</button>
          </div>
          <p>테이블 {lay.tables}개, {seats}석</p>
          <button type="button" className="m-btn m-btn-quiet m-recbtn"
            onClick={() => { setNote(""); setCfgOut({ pyeong: est.pyeong, grade: est.grade, staff: 1, shape: cfg.shape }); }}>추천 배치</button>
          <small className="it-place2">{sel ? "놓을 바닥을 누르세요." : "3D에서 테이블·키오스크를 누르고 바닥을 누르면 옮겨져요."}</small>
          {noDong && dongPick && <p className="m-aside m-dongwarn" role="note">동네를 아직 고르지 않아서 {profile.gu}의 대표 동네({dongPick.name}) 기준으로 계산해요. 동네 분석에서 고르면 그 동네로 바뀌어요.</p>}
        </div>

        <div className={`m-cash ${open && open.gap > 0 ? "is-short" : ""}${fresh ? "" : " is-stale"}`} aria-busy={!fresh}>
          {open ? (
            <>
              <p><span>{open.loan > 0 ? "문 열 때 현금 (대출 포함)" : "문 열 때 현금"}</span><strong>{man(open.cash)}</strong></p>
              <small>가진 돈 {man(profile.capital)}, 여는 데 {man(open.total)}{open.loan > 0 ? `, 대출 ${man(open.loan)}` : ""}</small>
              {open.gap > 0 && <p className="m-warn">여는 비용이 가진 돈보다 {man(open.gap)} 많아요. 시뮬레이션은 대출 {man(open.loan)}(모자란 {man(open.gap)} + 운전자금 {man(open.extra)})으로 시작하고, 다달이 원리금 {man(open.pay)}씩 갚아요(기본 금리 연 4.5%, 5년). 평수를 줄이면 대출이 줄어요.</p>}
              {open.gap === 0 && open.extra > 0 && <p className="m-warn">여는 비용은 가진 돈으로 내지만, 문 열 때 통장에 월 고정비 3개월치({man(open.reserve)})를 두려고 운전자금 {man(open.extra)}을 빌려요(다달이 원리금 {man(open.pay)}).</p>}
            </>
          ) : <p><span>문 열 때 현금</span><strong>계산 중</strong></p>}
          <FinanceBox loanMan={open?.loan ?? 0} rentMan={st.rent * cfg.pyeong} fallback={CAFE_DEFAULT_RATE} young={profile.age === "20대" || profile.age === "30대"} />{/* lab:finance 은행별 가상 금리, 월세 카드 할부 */}
        </div>

        {flowOn && flow && <FlowCard onTop={() => setView("top")} f={{ inLen: flow.inLen, outLen: flow.outLen, inLabel: "주문하고 가장 먼 자리까지", outLabel: "나가기", hints: flow.hints,
          note: `테이블 ${flow.tables}개 가운데 문에서 가장 먼 자리 기준이에요. 통로 폭과 동선은 엔진 배치도로 잰 값이고 매출 계산에는 들어가지 않아요. 좌석 수 변화는 엔진 계산에 들어가요. 문 폭과 주문 줄 깊이 1.2m는 엔진의 가정, 통로 권장 90~120cm는 업계 자료(AJD 인테리어 가이드)예요.` }} /> /* lab:layout */}
        <p className="m-msg" role="status">{msg}</p>
      </div>

      <div className="m-tray">
        <dl className="m-spent" aria-label="여는 비용 (엔진 계산)">
          {open ? <>
            {open.lines.filter((l) => l.amount > 0).map((l) => <div key={l.key} title={l.basis}><dt>{l.label}</dt><dd>{man(l.amount)}</dd></div>)}
            <div className="m-spent-total"><dt>여는 비용 합계</dt><dd>{man(open.total)}</dd></div>
          </> : <div><dt>여는 비용</dt><dd>계산 중</dd></div>}
        </dl>
        <div className="m-cats" role="tablist" aria-label="물건 종류">
          {CATS.map((c) => <button type="button" role="tab" key={c.key} aria-selected={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</button>)}
        </div>
        {cat === "room" ? ( // lab:layout
          <ShapePanel shape={shape} pyeong={cfg.pyeong} w={rw} d={rd} margin={CAFE_DOOR_MARGIN} defRatio={CAFE_SHAPE.ratio} flowOn={flowOn} setFlowOn={setFlowOn}
            ratioAllowed={(r) => cafeRatioOk(cfg.pyeong, r)} onShape={onShape} />
        ) : (
        <ul className="m-catalog">
          {CATS.find((c) => c.key === cat)!.items.map((it) => {
            const v = lay[it.key] as number;
            return (
              <li key={it.key}>
                <div className="cs-card it-card">
                  <ItemIcon k={it.key} />
                  <span>{it.name}</span>
                  <small>{it.note || " "}{it.need ? " · 꼭 필요" : ""}</small>
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
        )}
        <div className="m-tray-go">
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          {missing.length > 0 && <p className="m-warn it-need">꼭 필요한 물건을 아직 안 놓았어요: {missing.join(", ")} <button type="button" className="it-needbtn" onClick={() => set({ groups: Math.max(1, lay.groups), pos: Math.max(1, lay.pos) })}>한 번에 놓기</button></p>}
          <button type="button" className="m-btn" disabled={seats === 0 || missing.length > 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <section className="m-checks" aria-labelledby="checks-h">
        <p className="m-eyebrow" id="checks-h">열기 전 점검</p>
        <h1>{headline}</h1>
        <p className="m-sub">{profile.gu}, {cfg.pyeong}평, {seats}석, 직원 {cfg.staff}명 기준이에요. {open
          ? <>여는 데 {man(open.total)}이 들어요(보증금 {man(open.deposit)}, 권리금 {man(open.keyMoney)}, 부가세 선납 {man(open.vat)} 포함, 부가세는 개업 후 돌려받아요).{open.loan > 0 ? ` 가진 돈 ${man(profile.capital)}에 대출 ${man(open.loan)}을 더해 시작해요.` : ""} </>
          : "여는 비용은 엔진이 계산하는 중이에요. "}바꾸면 바로 다시 계산해요.</p>
        {(profile.keyMoney ?? 0) > 0 && open && <p className="m-aside">동네 분석에서 넣은 권리금 {man(profile.keyMoney ?? 0)}은 카페 엔진에 아직 들어가지 않아요. 여는 비용에는 이 동네 자료값 {man(open.keyMoney)}을 썼어요.</p>}
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
