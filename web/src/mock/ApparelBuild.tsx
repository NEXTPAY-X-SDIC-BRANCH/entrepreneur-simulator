// 옷가게 가게 꾸미기: 평수·마감·첫 재고·알바·대출을 정하고, 여는 돈과 한 달 예상, 열기 전 점검을 본다 (apparel.ts).
// 카페·고깃집과 같은 틀(m-build)을 쓰고, 3D 대신 평면 그림을 그린다.
import { DEFAULT_PLAN, KOSIS, STAFF_PAY, apparelOpeningCost, expectedSales, type ApparelCfg } from "./apparel";
import { Mark } from "./Checks";
import Assume from "./Assume";
import { GRADES, OWNER_DRAW, STATUS_LABEL, guStat, man, type Grade, type Profile } from "./model";

const LOAN_STEP = 500;

function FloorPlan({ pyeong }: { pyeong: number }) {
  // 평면: 1평 = 3.3㎡. 가로:세로 = 1.6:1 로 그린다 (모양은 가정, 넓이만 맞춘다)
  const m2 = pyeong * 3.3058, w = Math.sqrt(m2 * 1.6), d = m2 / w, s = 300 / Math.max(w, d * 1.6);
  const W = w * s, D = d * s;
  const racks = Math.max(2, Math.floor(pyeong / 3)); // 3평에 행거 하나 (가정)
  const cols = Math.ceil(racks / 2);
  return (
    <svg viewBox={`-10 -10 ${W + 20} ${D + 40}`} className="ap-plan" role="img" aria-label={`${pyeong}평 옷가게 평면, 행거 ${racks}개`}>
      <rect x={0} y={0} width={W} height={D} rx={6} className="ap-floor" />
      {Array.from({ length: racks }, (_, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = 20 + (c * (W - 120)) / Math.max(1, cols), y = r === 0 ? 18 : D - 40;
        return <rect key={i} x={x} y={y} width={Math.min(60, (W - 140) / cols)} height={14} rx={3} className="ap-rack" />;
      })}
      <rect x={W - 70} y={D / 2 - 40} width={50} height={26} rx={4} className="ap-counter" />
      <text x={W - 45} y={D / 2 - 22} className="ap-label" textAnchor="middle">계산대</text>
      <rect x={W - 70} y={D / 2 + 4} width={50} height={36} rx={4} className="ap-fit" />
      <text x={W - 45} y={D / 2 + 27} className="ap-label" textAnchor="middle">피팅룸</text>
      <rect x={W / 2 - 30} y={D - 4} width={60} height={8} className="ap-door" />
      <text x={W / 2} y={D + 24} className="ap-label" textAnchor="middle">출입문 · {pyeong}평 ({Math.round(m2)}㎡) · 행거 {racks}개</text>
    </svg>
  );
}

export default function ApparelBuild({ profile, cfg, setCfg, onNext }: { profile: Profile; cfg: ApparelCfg; setCfg: (c: ApparelCfg) => void; onNext: () => void }) {
  const set = (p: Partial<ApparelCfg>) => setCfg({ ...cfg, ...p });
  const st = guStat(profile.gu);
  const open = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const left = profile.capital + cfg.loan - open.total;
  const sales = Math.round(expectedSales(profile.gu, cfg.pyeong));
  const rent = Math.round(st.rent * cfg.pyeong);
  const staff = STAFF_PAY * cfg.staff;
  const margin = 1 - KOSIS.cogs - KOSIS.other; // 매출 1원에서 원가·기타경비를 빼고 남는 몫
  const fixed = rent + staff + OWNER_DRAW;
  const breakeven = Math.round(fixed / margin);
  const settled = Math.round(sales * margin - fixed);
  const firstMonth = Math.round(sales * 0.6 * margin - fixed); // 새 가게 인지도 0.6
  const checks = [
    { title: "자리 잡은 뒤 한 달", assume: "매출의 평수 효과 (13평 기준, 평수의 제곱근에 비례)", ok: settled >= 0, line: `매출 ${man(sales)}이면 원가(${Math.round(KOSIS.cogs * 100)}%)·기타경비(${Math.round(KOSIS.other * 100)}%)·월세·알바·사장 생활비를 빼고 ${settled >= 0 ? "+" : "−"}${man(Math.abs(settled))}이에요.` },
    { title: "본전 매출", ok: sales >= breakeven, line: `한 달에 ${man(breakeven)}은 팔아야 0원이에요. 이 구 옷가게 평균(${man(st.sales)})의 ${Math.round((breakeven / Math.max(1, st.sales)) * 100)}%예요.` },
    { title: "첫 달 (손님이 아직 적을 때)", assume: "새 가게 인지도 0.6 (고깃집 엔진과 같은 가정)", ok: firstMonth >= 0, line: `새 가게는 알려지기 전이라 손님이 60%쯤이에요. 첫 달은 ${firstMonth >= 0 ? "+" : "−"}${man(Math.abs(firstMonth))}이에요.` },
    { title: "버틸 돈", ok: left >= fixed * 3, line: `남는 현금 ${man(Math.max(0, left))}은 한 달 고정 지출(${man(fixed)})의 ${(Math.max(0, left) / fixed).toFixed(1)}개월치예요. 이 시뮬레이터는 3개월치를 기준으로 봐요.`, assume: "버틸 돈 기준 3개월치" },
  ];
  return (
    <main className="m-build">
      <div className="m-stage">
        <div className="m-canvas ap-canvas"><FloorPlan pyeong={cfg.pyeong} /></div>
        <div className="m-room">
          <div className="m-stepper">
            <span id="ap-py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={cfg.pyeong <= 7} onClick={() => set({ pyeong: cfg.pyeong - 1 })}>−</button>
            <output aria-labelledby="ap-py">{cfg.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={cfg.pyeong >= 30} onClick={() => set({ pyeong: cfg.pyeong + 1 })}>+</button>
          </div>
          <div className="m-seg" role="group" aria-label="마감 수준">
            {(Object.keys(GRADES) as Grade[]).map((g) => (
              <button type="button" key={g} aria-pressed={cfg.grade === g} onClick={() => set({ grade: g })}>{GRADES[g].label}</button>
            ))}
          </div>
          <div className="m-stepper">
            <span id="ap-stock">첫 재고</span>
            <button type="button" aria-label="첫 재고 줄이기" disabled={cfg.stockMonths <= 1} onClick={() => set({ stockMonths: cfg.stockMonths - 0.5 })}>−</button>
            <output aria-labelledby="ap-stock">{cfg.stockMonths}개월치</output>
            <button type="button" aria-label="첫 재고 늘리기" disabled={cfg.stockMonths >= 3} onClick={() => set({ stockMonths: cfg.stockMonths + 0.5 })}>+</button>
          </div>
          <div className="m-stepper">
            <span id="ap-staff">알바</span>
            <button type="button" aria-label="알바 1명 줄이기" disabled={cfg.staff <= 0} onClick={() => set({ staff: cfg.staff - 1 })}>−</button>
            <output aria-labelledby="ap-staff">{cfg.staff}명</output>
            <button type="button" aria-label="알바 1명 늘리기" disabled={cfg.staff >= 2} onClick={() => set({ staff: cfg.staff + 1 })}>+</button>
          </div>
          <p>첫 재고는 팔 옷을 미리 사 두는 돈이에요. 많을수록 물건이 안 떨어지지만 현금이 선반에 묶여요.</p>
        </div>
        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{man(Math.abs(left))}</strong></p>
          <small>가진 돈 {man(profile.capital)}{cfg.loan > 0 ? ` + 대출 ${man(cfg.loan)}` : ""} 중 {man(open.total)}을 썼어요.</small>
          <div className="m-stepper">
            <span id="ap-loan">대출</span>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 줄이기`} disabled={cfg.loan <= 0} onClick={() => set({ loan: cfg.loan - LOAN_STEP })}>−</button>
            <output aria-labelledby="ap-loan">{man(cfg.loan)}</output>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 늘리기`} disabled={cfg.loan >= 20000} onClick={() => set({ loan: cfg.loan + LOAN_STEP })}>+</button>
          </div>
          {left < 0 && <p className="m-warn">이대로는 가게를 열 수 없어요. 평수·마감·첫 재고를 줄이거나 대출을 받으세요.</p>}
        </div>
      </div>

      <div className="m-tray">
        <dl className="m-spent">
          {open.lines.map((l) => <div key={l.key}><dt>{l.label}{l.basis.includes("가정") && <Assume what={`${l.label}: ${l.basis}`} />}</dt><dd>{man(l.amount)}</dd></div>)}
        </dl>
        <div className="m-tray-go">
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          <button type="button" className="m-btn" disabled={left < 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <section className="m-checks" aria-labelledby="ap-checks-h">
        <p className="m-eyebrow" id="ap-checks-h">열기 전 점검</p>
        <p className="m-sub">{profile.gu}, {cfg.pyeong}평, 알바 {cfg.staff}명, 첫 재고 {cfg.stockMonths}개월치 기준이에요. 바꾸면 바로 다시 계산해요.</p>
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
          매출은 서울시 상권분석서비스 2025년 {profile.gu} 일반의류 점포당 월매출(카드 추정)을 평수로 조금 조정한 값이에요. 원가 {Math.round(KOSIS.cogs * 100)}%와 기타경비 {Math.round(KOSIS.other * 100)}%는
          통계청 도소매업조사 2024년 서울 의복 소매업 중 연매출 1억~5억 사업체 값이에요. 알바 한 명은 월 {man(STAFF_PAY)} (최저시급 × 주휴 배수), 사장 생활비 {man(OWNER_DRAW)}은 가정이에요.
          시뮬레이션은 매입 배수 {Math.round(DEFAULT_PLAN.buy * 100)}%, 할인 없음으로 시작해요.
        </p>
      </section>
    </main>
  );
}
