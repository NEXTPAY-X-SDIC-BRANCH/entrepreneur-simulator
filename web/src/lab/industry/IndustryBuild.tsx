// lab:industry 3단계 가게 꾸미기 (새 업종). 카페 화면(CafeBuild.tsx)과 같은 틀: 전체 폭 3D 무대(왼쪽 위 가게 구성, 오른쪽 위 현금),
// 아래 쟁반(드는 돈과 카운터 조각 이름), 그 아래 열기 전 점검. 3D는 카페 3D(CafeRoom3D)를 그대로 쓰고 카운터 조각을 업종 이름으로 읽는다.
// 치킨·분식은 이수빈 ShopRoom3D(튀김기·주방·포장대)로 그리고, 가게 모양과 출입문을 고른다 (화면용).
// 숫자는 모두 엔진(/lab/industry/preview)이 계산한다.
import { Mark } from "../../mock/Checks";
import CafeRoom3D from "../../mock/CafeRoom3D";
import ShopRoom3D, { DOOR_LABEL, SHAPE_LABEL, type DoorSpot, type RoomShape } from "../../mock/ShopRoom3D";
import { STATUS_LABEL, man, type Grade, type Profile, type Status } from "../../mock/model";
import { pct, sgn, shopKind, shopLayout, usePreview, wman, type IndustryCfg, type Preview } from "./api";
import { LAB_TXT, type LabIndustry } from "./industries";
import "../../mock/cafe-sim.css";
import "./industry.css";
import FinanceBox from "../finance/FinanceBox"; // lab:merge 수빈 10/23: 고깃집·카페처럼 대출 금리 고르기

const GRADE_KO: Record<Grade, string> = { basic: "기본", mid: "중급", high: "고급" };
type Item = { key: string; title: string; status: Status; line: string; todo?: string; rule: string };
const months = (n: number) => (n >= 12 ? `${Math.floor(n / 12)}년${n % 12 ? ` ${n % 12}개월` : ""}` : `${n}개월`);

function checks(p: Preview, shop: string): Item[] {
  const r = p.rough_month, c = p.capacity, rev = r.revenue_krw;
  const rent = p.monthly_fixed.rent_krw;
  const sunk = p.capex.total_krw - (p.capex.lines.find((l) => l.key === "deposit")?.krw ?? 0);
  const be = p.breakeven_units_day;
  const survey = p.benchmark.op_share_survey + p.benchmark.owner_family_share_survey;
  const margin = r.op_margin ?? 0;
  const rentShare = rev > 0 ? rent / rev : 1;
  return [
    {
      key: "breakeven", title: "하루에 몇 인분을 팔아야 본전인가요?",
      status: be == null ? "weak" : c.demand_units_day >= be * 1.1 ? "ok" : c.demand_units_day >= be ? "warn" : "weak",
      line: be == null ? "한 인분을 팔아도 남는 돈이 없어요." : `하루 ${be}인분이에요. 이 동네에서 자리 잡힌 ${shop}에는 하루 ${c.demand_units_day}인분쯤 주문이 와요.`,
      todo: be != null && c.demand_units_day < be ? `${Math.ceil(be - c.demand_units_day)}인분이 모자라요. 평수를 줄이거나 직원을 줄여 고정비를 낮춰 보세요.` : undefined,
      rule: `월세 ${wman(rent)}, 인건비 ${wman(p.monthly_fixed.labor_krw)}, 감가상각 ${wman(p.monthly_fixed.depreciation_krw)}을 한 인분이 남기는 돈(객단가 ${p.demand.ticket_krw.toLocaleString("ko-KR")}원에서 식재료·세금과 공과·기타·카드·배달 비용을 뺀 값)으로 나누고 한 달 ${p.demand.days_month}일로 나눴어요. 비율은 경영실태조사 2025 업종 평균이에요.`,
    },
    {
      key: "capacity", title: "좌석과 일손이 손님을 다 받을 수 있나요?",
      status: c.walk_share >= 0.1 ? "weak" : c.walk_share > 0.01 ? "warn" : "ok",
      line: c.bottleneck ? `${c.bottleneck === "seats" ? "좌석" : "일손"}이 먼저 막혀서 주문의 ${pct(c.walk_share)}를 못 받아요.` : `좌석은 하루 ${c.seat_units_day}명, 일손은 하루 ${c.crew_units_day}인분까지 받아요. 주문 ${c.demand_units_day}인분을 다 받을 수 있어요.`,
      todo: c.bottleneck === "seats" ? "테이블을 늘리거나 평수를 키워 보세요." : c.bottleneck === "staff" ? "직원을 한 명 늘려 보세요." : undefined,
      rule: p.capacity.note_ko + " 배달과 포장은 좌석이 필요 없고 일손만 써요.",
    },
    {
      key: "rent", title: "월세가 매출에 비해 무겁지 않나요?",
      status: rentShare <= 0.1 ? "ok" : rentShare <= 0.15 ? "warn" : "weak",
      line: `월세가 자리 잡힌 달 매출의 ${pct(rentShare)}예요. 같은 업종 가게들은 평균 매출의 ${pct(p.benchmark.rent_share_survey, 1)}를 임차료로 내요.`,
      todo: rentShare > 0.15 ? "월세가 싼 동네를 고르거나 평수를 줄여 보세요." : undefined,
      rule: `월세는 평당 ${p.rent.man_per_pyeong}만원(${p.rent.source}) × ${p.input.pyeong}평이에요. 한국부동산원 값은 상권 1층 기준이라 골목 안쪽 가게보다 비싸게 나올 수 있어요. 동네 분석에서 찾아 둔 매물의 월세를 넣으면 그 값으로 계산해요.`,
    },
    {
      key: "payback", title: "들인 돈은 언제 돌아오나요?",
      status: r.op_krw <= 0 ? "weak" : sunk / r.op_krw <= 36 ? "ok" : sunk / r.op_krw <= 60 ? "warn" : "weak",
      line: r.op_krw <= 0 ? `자리가 잡힌 뒤에도 한 달에 ${wman(-r.op_krw)}씩 줄어요. 이 구성으로는 돌아오지 않아요.` : `자리가 잡히면 한 달에 ${wman(r.op_krw)}이 남아요(사장님 몫 빼기 전). 들인 돈 ${wman(sunk)}은 약 ${months(Math.ceil(sunk / r.op_krw))} 뒤에 돌아와요.`,
      rule: `들인 돈은 보증금을 뺀 인테리어, 주방, 홀, 간판, 첫 재료 값이에요. 사장님 인건비(같은 업종 평균 월 ${wman(r.owner_pay_ref_krw)})를 가져가면 더 늦어져요.`,
    },
    {
      key: "survey", title: "같은 업종 가게들과 견주면 어떤가요?",
      status: margin >= survey - 0.05 ? "ok" : margin >= survey - 0.15 ? "warn" : "weak",
      line: `이 가게는 매출의 ${pct(margin)}를 남겨요. 경영실태조사의 같은 업종은 사장님·가족 몫까지 합쳐 ${pct(survey)}를 남겨요.`,
      rule: p.benchmark.note_ko,
    },
  ];
}

export default function IndustryBuild({ profile, cfg: cfgIn, setCfg, onNext }: { profile: Profile; cfg: IndustryCfg | null; setCfg: (c: IndustryCfg) => void; onNext: () => void }) {
  const ind = profile.industry as LabIndustry;
  const cfg: IndustryCfg = cfgIn && cfgIn.industry === ind ? cfgIn : { industry: ind, grade: "basic", delivery: true };
  const pv = usePreview(profile, cfg);
  const p = pv.data;
  const t = LAB_TXT[ind];
  const kind = shopKind(ind);
  const set = (patch: Partial<IndustryCfg>) => setCfg({ ...cfg, ...(p ? { pyeong: p.input.pyeong, tables: p.input.tables, staff: p.input.staff } : {}), ...patch });
  const left = p ? profile.capital * 10000 - p.capex.total_krw : 0;
  const list = p ? checks(p, t.shop) : [];
  const counter = p ? Object.entries(p.furniture_ko).filter(([k]) => p.layout.some((x) => x.type === k)) : [];
  const msg = pv.err ? pv.err : !p ? "엔진에서 배치를 받아 오는 중이에요."
    : p.layout.some((x) => !x.fits) ? `공간이 모자라 못 놓은 테이블이 있어요${kind ? "" : " (빨간 반투명)"}. 테이블을 줄이거나 평수를 늘려 보세요.`
    : p.capacity.bottleneck ? `먼저 막히는 곳은 ${p.capacity.bottleneck === "seats" ? "좌석" : "일손"}이에요. 주문의 ${pct(p.capacity.walk_share)}를 못 받아요.`
    : `좌석 ${p.seats.total}석, 일손 ${p.input.staff + 1}명(사장님 포함)으로 이 동네 주문을 다 받을 수 있어요.`;

  return (
    <main className="m-build">
      <div className="m-stage">
        <div className="m-canvas">
          {kind && p ? <ShopRoom3D kind={kind} pyeong={p.input.pyeong} layout={shopLayout(kind, p, cfg.layout)} height="fill" flow />
            : p?.room ? <CafeRoom3D room={p.room} layout={p.layout} roster={p.roster} height="fill" /> : <p className="m-loading">{pv.err || "엔진을 부르는 중이에요"}</p>}
        </div>
        <div className="m-room">
          <div className="m-stepper">
            <span id="ib-py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={!p || p.input.pyeong <= 10} onClick={() => p && set({ pyeong: p.input.pyeong - 1, tables: undefined })}>−</button>
            <output aria-labelledby="ib-py">{p?.input.pyeong ?? "-"}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={!p || p.input.pyeong >= 40} onClick={() => p && set({ pyeong: p.input.pyeong + 1, tables: undefined })}>+</button>
          </div>
          <div className="m-seg" role="group" aria-label="마감 수준">
            {(Object.keys(GRADE_KO) as Grade[]).map((g) => <button type="button" key={g} aria-pressed={cfg.grade === g} onClick={() => set({ grade: g })}>{GRADE_KO[g]}</button>)}
          </div>
          <div className="m-stepper">
            <span id="ib-tb">테이블</span>
            <button type="button" aria-label="테이블 1개 줄이기" disabled={!p || p.input.tables <= 0} onClick={() => p && set({ tables: p.input.tables - 1 })}>−</button>
            <output aria-labelledby="ib-tb">{p?.input.tables ?? "-"}개</output>
            <button type="button" aria-label="테이블 1개 늘리기" disabled={!p || p.input.tables >= 40} onClick={() => p && set({ tables: p.input.tables + 1 })}>+</button>
          </div>
          <div className="m-stepper">
            <span id="ib-st">직원 수</span>
            <button type="button" aria-label="직원 1명 줄이기" disabled={!p || p.input.staff <= 0} onClick={() => p && set({ staff: p.input.staff - 1 })}>−</button>
            <output aria-labelledby="ib-st">{p?.input.staff ?? "-"}명</output>
            <button type="button" aria-label="직원 1명 늘리기" disabled={!p || p.input.staff >= 8} onClick={() => p && set({ staff: p.input.staff + 1 })}>+</button>
          </div>
          {p?.demand.delivery_available && (
            <label className="ib-toggle"><input type="checkbox" checked={cfg.delivery} onChange={(e) => set({ delivery: e.target.checked })} />배달도 받기 (매출의 {pct(p.demand.channels.delivery)})</label>
          )}
          {kind && (
            <div className="m-layout" role="group" aria-label="가게 배치">
              <b className="m-layout-h">가게 배치 <small>파란 화살표가 손님 동선이에요</small></b>
              <div className="m-layout-row">
                <span id="ib-shape">가게 모양</span>
                <div className="m-seg" role="group" aria-labelledby="ib-shape">
                  {(["wide", "square", "deep"] as RoomShape[]).map((x) => <button type="button" key={x} aria-pressed={(cfg.layout?.shape ?? "wide") === x} onClick={() => set({ layout: { ...cfg.layout, shape: x } })}>{SHAPE_LABEL[x]}</button>)}
                </div>
              </div>
              <div className="m-layout-row">
                <span id="ib-door">출입문</span>
                <div className="m-seg" role="group" aria-labelledby="ib-door">
                  {(["left", "center", "right"] as DoorSpot[]).map((x) => <button type="button" key={x} aria-pressed={(cfg.layout?.door ?? "right") === x} onClick={() => set({ layout: { ...cfg.layout, door: x } })}>{DOOR_LABEL[x]}</button>)}
                </div>
              </div>
              <small>모양과 문 자리는 3D 그림만 바꿔요. 매출과 비용 계산은 그대로예요.</small>
            </div>
          )}
          <p>{p ? `${p.seats.total}석, 사장님 포함 ${p.input.staff + 1}명` : ""}</p>
          <button type="button" className="m-btn m-btn-quiet m-recbtn" onClick={() => setCfg({ industry: ind, grade: "basic", delivery: true, layout: cfg.layout })}>추천 배치</button>
        </div>
        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{p ? wman(Math.abs(left)) : "-"}</strong></p>
          <small>가진 돈 {man(profile.capital)} 중 {p ? wman(p.capex.total_krw) : "-"}을 썼어요.</small>
          {left < 0 && <p className="m-warn">가진 돈보다 여는 비용이 커요. 시뮬레이션에서는 모자란 만큼을 대출로 계산해요. 평수나 마감을 낮추면 줄어요.</p>}
          {p && ( // lab:merge 운전자금 대출: 모자란 돈 말고 더 빌리는 돈. 비워 두면 엔진이 석 달 치 월세·인건비만큼 빌린다
            <>
              <div className="m-stepper ib-loan">
                <span id="ib-loan">운전자금 대출</span>
                <button type="button" aria-label="운전자금 대출 500만원 줄이기" disabled={cfg.extra_loan_man === 0}
                  onClick={() => set({ extra_loan_man: Math.max(0, (cfg.extra_loan_man ?? 500) - 500) })}>−</button>
                <output aria-labelledby="ib-loan">{cfg.extra_loan_man == null ? "자동" : man(cfg.extra_loan_man)}</output>
                <button type="button" aria-label="운전자금 대출 500만원 늘리기" disabled={(cfg.extra_loan_man ?? 0) >= 20000}
                  onClick={() => set({ extra_loan_man: (cfg.extra_loan_man ?? 0) + 500 })}>+</button>
              </div>
              <small>{p.capex.loan_needed_krw > 0 ? `대출은 모자란 ${wman(p.capex.loan_needed_krw)}에 운전자금` : "대출은 운전자금"}({cfg.extra_loan_man == null ? "석 달 치 월세·인건비, 엔진이 정함" : man(cfg.extra_loan_man)}){p.capex.loan_needed_krw > 0 ? "을 더한 돈이고" : "이고"}, 5년 동안 원리금을 나눠 갚아요.</small>
              <FinanceBox loanMan={Math.round(p.capex.loan_needed_krw / 1e4) + (cfg.extra_loan_man ?? 0)} rentMan={Math.round(p.rent.man_per_pyeong * p.input.pyeong)}
                young={profile.age === "20대" || profile.age === "30대"} noCard />
            </>
          )}
        </div>
        <p className="m-msg" role="status">{msg}</p>
      </div>

      <div className="m-tray">
        <dl className="m-spent">
          {p?.capex.lines.filter((l) => l.krw > 0).map((l) => <div key={l.key}><dt>{l.item_ko}</dt><dd>{wman(l.krw)}</dd></div>)}
        </dl>
        {!kind && counter.length > 0 && (
          <ul className="ib-legend" aria-label="카운터 조각 이름">
            {counter.map(([k, v]) => <li key={k}><b>{v}</b> 자리</li>)}
            <li>3D는 카페 가구 모양을 빌려 그렸어요</li>
          </ul>
        )}
        <div className="m-tray-go">
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          <button type="button" className="m-btn" disabled={!p} onClick={() => { if (p) setCfg({ ...cfg, pyeong: p.input.pyeong, tables: p.input.tables, staff: p.input.staff }); onNext(); }}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      {p && (
        <section className="m-checks" aria-labelledby="ib-checks-h">
          <p className="m-eyebrow" id="ib-checks-h">열기 전 점검</p>
          <h1>{p.rough_month.op_krw <= 0
            ? <>이 구성으로는 자리가 잡혀도 한 달에 <mark>{wman(-p.rough_month.op_krw)}씩 줄어요.</mark></>
            : <>자리가 잡히면 한 달에 <mark>{wman(p.rough_month.op_krw)}</mark>이 남아요.</>}</h1>
          <p className="m-sub">{profile.gu}{p.input.dong ? ` ${p.input.dong}` : ""}, {p.input.pyeong}평, {p.seats.total}석, 직원 {p.input.staff}명 기준이에요. 자리 잡힌 달 매출 {wman(p.rough_month.revenue_krw)}(같은 업종 전국 중앙값은 {wman(p.benchmark.sales_p50_month_krw)}, 평균은 {wman(p.benchmark.sales_mean_month_krw)}), 사장님 몫을 빼기 전 영업이익 {sgn(p.rough_month.op_krw)}. 바꾸면 바로 다시 계산해요.</p>
          <ul className="m-checklist">
            {list.map((c) => (
              <li key={c.key}>
                <Mark s={c.status} />
                <div>
                  <h2>{c.title}<span className={`m-status is-${c.status}`}>{STATUS_LABEL[c.status]}</span></h2>
                  <p>{c.line}</p>
                  {c.todo && <p className="m-todo">{c.todo}</p>}
                  <details><summary>이렇게 계산했어요</summary><p>{c.rule}</p></details>
                </div>
              </li>
            ))}
          </ul>
          <p className="m-aside">
            비용 비율, 객단가, 좌석과 일손 한도는 외식업체 경영실태조사 2025 {p.benchmark.krei_label} 전국 가게의 값이에요 (프랜차이즈 포함).
            매출은 업종 중앙값 가게를 {profile.gu}의 카드 매출 지수로 옮긴 엔진 추정이에요.{kind ? "" : " 3D 가구는 카페 가구 모양을 빌려 그렸어요."}
          </p>
        </section>
      )}
    </main>
  );
}
