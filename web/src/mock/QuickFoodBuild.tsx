// 치킨집·분식집 가게 꾸미기: 평수·마감·알바·대출을 정하고, 여는 돈과 한 달 예상, 열기 전 점검을 본다 (quickfood.ts).
// 옷가게와 같은 틀(m-build)을 쓰고, 3D 대신 평면 그림을 그린다.
import { Mark } from "./Checks";
import Assume from "./Assume";
import LayoutPicker from "./LayoutPicker";
import ItemTray from "./ItemTray";
import { missingItems, withNeeded } from "./shopItems";
import { useEffect, useState } from "react";
import ShopRoom3D, { shopPlan, type ShopEdit } from "./ShopRoom3D";
import { ASSUME } from "./assumptions";
import { OWNER_DRAW, STATUS_LABEL, guStat, man, type Grade, type Profile } from "./model";
import { AD_COST, DEFAULT_PLAN, GRADE_LABEL, QF_NAME, derived, expectedSales, qfOpeningCost, type QfCfg } from "./quickfood";

const LOAN_STEP = 500;

// people: 시뮬레이션에서 가게 안 손님 수 (점으로 그린다). riders: 그날 배달 주문 (문 밖 점)
export function QfFloorPlan({ cfg, people = 0, riders = 0 }: { cfg: QfCfg; people?: number; riders?: number }) {
  // 평면: 1평 = 3.3㎡. 가로:세로 = 1.6:1 (모양은 가정, 넓이만 맞춘다). 뒤쪽 3분의 1이 주방
  const m2 = cfg.pyeong * 3.3058, w = Math.sqrt(m2 * 1.6), d = m2 / w, s = 300 / Math.max(w, d * 1.6);
  const W = w * s, D = d * s, K = D * 0.34;
  const tables = Math.max(1, Math.floor((cfg.pyeong - 5) / 2.5)); // 주방·포장대를 빼고 2.5평에 4인 테이블 하나 (가정)
  const cols = Math.ceil(tables / 2);
  return (
    <svg viewBox={`-10 -10 ${W + 20} ${D + 40}`} className="ap-plan" role="img" aria-label={`${cfg.pyeong}평 ${QF_NAME[cfg.ind]} 평면, 테이블 ${tables}개`}>
      <rect x={0} y={0} width={W} height={D} rx={6} className="ap-floor" />
      <rect x={0} y={0} width={W} height={K} rx={6} className="ap-fit" />
      <text x={W / 2} y={K / 2 + 4} className="ap-label" textAnchor="middle">주방 · {cfg.ind === "chicken" ? "튀김기" : "조리대"}</text>
      {Array.from({ length: tables }, (_, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = 16 + (c * (W - 110)) / Math.max(1, cols), y = K + 16 + r * ((D - K - 40) / 2);
        return <rect key={i} x={x} y={y} width={Math.min(54, (W - 130) / cols)} height={(D - K - 60) / 2.4} rx={4} className="ap-rack" />;
      })}
      <rect x={W - 74} y={K + 14} width={56} height={30} rx={4} className="ap-counter" />
      <text x={W - 46} y={K + 33} className="ap-label" textAnchor="middle">포장대</text>
      {Array.from({ length: Math.min(30, people) }, (_, i) => {
        const rx = ((i * 7919) % 97) / 97, ry = ((i * 104729) % 89) / 89;
        return <circle key={`p${i}`} cx={20 + rx * (W - 120)} cy={K + 20 + ry * (D - K - 50)} r={5} className="ap-person" />;
      })}
      {Array.from({ length: Math.min(8, riders) }, (_, i) => <circle key={`r${i}`} cx={W / 2 + 40 + i * 12} cy={D + 10} r={4} className="ap-rider" />)}
      <rect x={W / 2 - 30} y={D - 4} width={60} height={8} className="ap-door" />
      <text x={W / 2} y={D + 26} className="ap-label" textAnchor="middle">출입문 · {cfg.pyeong}평 ({Math.round(m2)}㎡) · 테이블 {tables}개</text>
    </svg>
  );
}

export default function QuickFoodBuild({ profile, cfg, setCfg, onNext }: { profile: Profile; cfg: QfCfg; setCfg: (c: QfCfg) => void; onNext: () => void }) {
  const set = (p: Partial<QfCfg>) => setCfg({ ...cfg, ...p });
  const kind = cfg.ind === "chicken" ? "chicken" : "bunsik";
  // 고깃집처럼 빈 가게(주방·벽만)에서 시작해 물건을 골라 채운다
  useEffect(() => { if (!cfg.layout) set({ layout: { blank: true } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const lay = cfg.layout ?? { blank: true };
  const missing = missingItems(kind, cfg.pyeong, lay);
  // 3D에서 물건을 누르고 바닥을 누르면 그 자리로 옮긴다 (고깃집 가게 꾸미기처럼)
  const [sel, setSel] = useState<string | null>(null);
  const edit: ShopEdit = { sel, pick: setSel, move: (id, x, z) => { set({ layout: { ...lay, moves: { ...(lay.moves ?? {}), [id]: [Math.round(x * 10) / 10, Math.round(z * 10) / 10] } } }); setSel(null); } };
  const st = guStat(profile.gu), dv = derived(cfg.ind), name = QF_NAME[cfg.ind];
  const open = qfOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const left = profile.capital + cfg.loan - open.total;
  const sales = Math.round(expectedSales(cfg, profile.gu));
  const rent = Math.round(st.rent * cfg.pyeong);
  const staff = Math.round(dv.wage * cfg.staff);
  // 매출 1원에서 식재료·기타경비·배달 수수료를 빼고 남는 몫 (배달 수수료는 배달 매출 비중만큼)
  const fees = dv.share.delivery * ((dv.appFee + dv.agencyFee) * 1e4) / dv.ticket;
  const margin = 1 - dv.foodRatio - 0.05 - fees;
  const fixed = rent + staff + OWNER_DRAW + AD_COST[DEFAULT_PLAN.ad];
  const breakeven = Math.round(fixed / margin);
  const settled = Math.round(sales * margin - fixed);
  const firstMonth = Math.round(sales * 0.6 * margin - fixed);
  const capacity = Math.round(dv.perWorker * 1.4 * (1 + cfg.staff));
  const checks = [
    { title: "자리 잡은 뒤 한 달", assume: `기타경비 5%, 배달앱 광고 기본 ${AD_COST[DEFAULT_PLAN.ad]}만원`, ok: settled >= 0, line: `매출 ${man(sales)}이면 식재료(${Math.round(dv.foodRatio * 100)}%)·배달 수수료·월세·알바·사장 생활비를 빼고 ${settled >= 0 ? "+" : "−"}${man(Math.abs(settled))}이에요.` },
    { title: "본전 매출", ok: sales >= breakeven, line: `한 달에 ${man(breakeven)}은 팔아야 0원이에요. 이 구 ${name} 평균(${man(st.sales)})의 ${Math.round((breakeven / Math.max(1, st.sales)) * 100)}%예요.` },
    { title: "첫 달 (손님이 아직 적을 때)", assume: "새 가게 인지도 0.6 (고깃집 엔진과 같은 가정)", ok: firstMonth >= 0, line: `새 가게는 알려지기 전이라 손님이 60%쯤이에요. 첫 달은 ${firstMonth >= 0 ? "+" : "−"}${man(Math.abs(firstMonth))}이에요.` },
    { title: "일손", assume: "종사원 1명당 평균 매출 × 1.4를 감당 수준으로 봄", ok: capacity >= sales, line: `사장 + 알바 ${cfg.staff}명이 넉넉히 받을 수 있는 매출은 월 ${man(capacity)}쯤이에요. ${capacity >= sales ? "예상 매출을 받을 수 있어요." : "몰리는 날에는 주문을 놓쳐요."}` },
    { title: "버틸 돈", ok: left >= fixed * 3, line: `남는 현금 ${man(Math.max(0, left))}은 한 달 고정 지출(${man(fixed)})의 ${(Math.max(0, left) / fixed).toFixed(1)}개월치예요. 이 시뮬레이터는 3개월치를 기준으로 봐요.`, assume: "버틸 돈 기준 3개월치" },
  ];
  // 추천 배치: 자리만큼 채우되, 여는 돈을 내고도 석 달 고정비가 남도록 테이블를 줄인다 (최소 2개)
  const recommendLayout = () => {
    const l0 = { shape: lay.shape, door: lay.door, pos: lay.pos, doors: lay.doors };
    let n = shopPlan(kind, cfg.pyeong, l0).tables.length;
    const leftWith = (k: number) => profile.capital + cfg.loan - qfOpeningCost({ ...cfg, layout: { ...l0, tables: k } }, profile.gu, profile.keyMoney ?? 0).total;
    while (n > 2 && leftWith(n) < fixed * 3) n--;
    set({ layout: { ...l0, tables: n } });
  };
  return (
    <main className="m-build">
      <div className="m-stage">
        <div className="m-canvas"><ShopRoom3D kind={kind} pyeong={cfg.pyeong} layout={lay} height="fill" flow edit={edit} />
          <p className="m-msg it-place" role="status">{sel ? "놓을 바닥을 누르세요. 같은 물건을 다시 누르면 그만둬요." : "3D에서 테이블·계산대·행거 같은 물건을 누르고, 놓을 바닥을 누르면 옮겨져요."}</p></div>
        <div className="m-room">
          <div className="m-stepper">
            <span id="qf-py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={cfg.pyeong <= 7} onClick={() => set({ pyeong: cfg.pyeong - 1 })}>−</button>
            <output aria-labelledby="qf-py">{cfg.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={cfg.pyeong >= 80} onClick={() => set({ pyeong: cfg.pyeong + 1 })}>+</button>
          </div>
          <div className="m-seg" role="group" aria-label="마감 수준">
            {(["basic", "mid", "high"] as Grade[]).map((g) => (
              <button type="button" key={g} aria-pressed={cfg.grade === g} onClick={() => set({ grade: g })}>{GRADE_LABEL[g]}</button>
            ))}
          </div>
          <div className="m-stepper">
            <span id="qf-staff">직원 수</span>
            <button type="button" aria-label="알바 1명 줄이기" disabled={cfg.staff <= 0} onClick={() => set({ staff: cfg.staff - 1 })}>−</button>
            <output aria-labelledby="qf-staff">{cfg.staff}명</output>
            <button type="button" aria-label="알바 1명 늘리기" disabled={cfg.staff >= 3} onClick={() => set({ staff: cfg.staff + 1 })}>+</button>
          </div>
          <LayoutPicker kind={kind} pyeong={cfg.pyeong} layout={lay} set={(l) => set({ layout: l })} />
          <button type="button" className="m-btn m-btn-quiet m-recbtn" onClick={recommendLayout}>추천 배치</button>
          <p>조사한 {name}은 평균 {Math.round(dv.areaPy)}평에 사장 포함 {(1 + dv.hired).toFixed(1)}명(가족 제외)이 일해요. 주문의 {Math.round(dv.share.delivery * 100)}%가 배달, {Math.round(dv.share.takeout * 100)}%가 포장이에요 (외식업체 경영실태조사).</p>
        </div>
        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{man(Math.abs(left))}</strong></p>
          <small>가진 돈 {man(profile.capital)}{cfg.loan > 0 ? ` + 대출 ${man(cfg.loan)}` : ""} 중 {man(open.total)}을 썼어요.</small>
          <div className="m-stepper">
            <span id="qf-loan">대출</span>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 줄이기`} disabled={cfg.loan <= 0} onClick={() => set({ loan: cfg.loan - LOAN_STEP })}>−</button>
            <output aria-labelledby="qf-loan">{man(cfg.loan)}</output>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 늘리기`} disabled={cfg.loan >= 20000} onClick={() => set({ loan: cfg.loan + LOAN_STEP })}>+</button>
          </div>
          {left < 0 && <p className="m-warn">이대로는 가게를 열 수 없어요. 평수·마감을 줄이거나 대출을 받으세요.</p>}
        </div>
      </div>

      <div className="m-tray">
        <dl className="m-spent">
          {open.lines.map((l) => <div key={l.key}><dt>{l.label}{(l.basis.includes("가정") || `open_${l.key}` in ASSUME) && <Assume id={`open_${l.key}` in ASSUME ? `open_${l.key}` : undefined} what={`open_${l.key}` in ASSUME ? undefined : `${l.label}: ${l.basis}`} />}</dt><dd>{man(l.amount)}</dd></div>)}
        </dl>
        <ItemTray kind={kind} pyeong={cfg.pyeong} layout={lay} set={(l) => set({ layout: l })} />
        <div className="m-tray-go">
          {missing.length > 0 && <p className="m-warn it-need">꼭 필요한 물건을 아직 안 놓았어요: {missing.join(", ")} <button type="button" className="it-needbtn" onClick={() => set({ layout: withNeeded(kind, cfg.pyeong, lay) })}>한 번에 놓기</button></p>}
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          <button type="button" className="m-btn" disabled={left < 0 || missing.length > 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <section className="m-checks" aria-labelledby="qf-checks-h">
        <p className="m-eyebrow" id="qf-checks-h">열기 전 점검</p>
        <p className="m-sub">{profile.gu}, {cfg.pyeong}평, 알바 {cfg.staff}명 기준이에요. 바꾸면 바로 다시 계산해요.</p>
        <ul className="m-checklist">
          {checks.map((c) => (
            <li key={c.title}>
              <Mark s={c.ok ? "ok" : "weak"} />
              <div>
                <h2>{c.title}<span className={`m-status is-${c.ok ? "ok" : "weak"}`}>{STATUS_LABEL[c.ok ? "ok" : "weak"]}</span>{"assume" in c && c.assume && <Assume what={c.assume} />}</h2>
                <p>{c.line}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="m-aside">
          매출은 서울시 상권분석서비스 2025년 {profile.gu} {cfg.ind === "chicken" ? "치킨전문점" : "분식전문점"} 점포당 월매출(카드 추정)을 배달 비중만큼 보정하고 평수로 조금 조정한 값이에요.
          식재료비율 {Math.round(dv.foodRatio * 100)}%, 배달 한 건당 배달앱 {Math.round(dv.appFee * 1e4).toLocaleString("ko-KR")}원·배달대행 {Math.round(dv.agencyFee * 1e4).toLocaleString("ko-KR")}원, 알바 한 명 월 {man(Math.round(dv.wage))}은
          외식업체 경영실태조사 2025(전국) {cfg.ind === "chicken" ? "치킨전문점" : "김밥 및 기타 간이 음식점업"} 값으로 계산했어요. 사장 생활비 {man(OWNER_DRAW)}은 가정이에요.
        </p>
      </section>
    </main>
  );
}
