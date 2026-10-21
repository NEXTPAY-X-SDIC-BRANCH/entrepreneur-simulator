// lab:industry 4단계 시뮬레이션 (새 업종). 카페·고깃집 시뮬레이션과 같은 틀: 전체 화면 3D 위에 지표 줄, 왼쪽 현금 그래프와 운영 계획,
// 시작·운영 계획·정산·결과는 팝업. 엔진은 새 업종 월 모델(/lab/industry/season, sim/generic)이다.
// 한 달 = 운영 계획(가격·영업시간·직원·마케팅·배달) + 이달의 사건 대응 하나 -> 엔진이 그달 손익과 현금을 계산.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import CafeRoom3D from "../../mock/CafeRoom3D";
import { man, type Profile } from "../../mock/model";
import { IconCal, IconCash, IconHeart, IconStar, Metric, Q } from "../../mock/SimulateEngine";
import { engineBody, netErr, post, sgn, usePreview, wman, type IndustryCfg, type Month, type Start } from "./api";
import { LAB_TXT, type LabIndustry } from "./industries";
import "../../mock/simulate-engine.css";
import "../../mock/cafe-sim.css";
import "./industry.css";

type Hours = "short" | "standard" | "long";
type Plan = { price_change_pct: number; hours: Hours; staff: number; marketing_krw: number; delivery: boolean };
type View = "intro" | "plan" | "settle" | "report";
const HOURS_ORDER: Hours[] = ["short", "standard", "long"];
const HOURS_KO: Record<Hours, string> = { short: "짧게", standard: "기본", long: "길게" };
const tone = (v: number) => (v < 0 ? "neg" : "pos");
const minus = (krw: number) => (Math.round(krw / 10000) === 0 ? "0원" : `−${wman(krw)}`);
const clock = (h: number) => `${h % 24}시${h >= 24 ? "(새벽)" : ""}`;

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}
function Cash({ start, months, total }: { start: number; months: Month[]; total: number }) {
  const pts = [start, ...months.map((m) => m.kpi.cash_krw)];
  const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts), W = 340, H = 120;
  const x = (i: number) => 10 + (i * (W - 20)) / total, y = (v: number) => 8 + ((hi - v) / Math.max(1, hi - lo)) * (H - 22);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cs-chart" role="img" aria-label="남은 현금">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="cs-zero" />
      <polyline fill="none" className="cs-line" points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      {pts.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" className={v < 0 ? "cs-dot is-neg" : "cs-dot"} />)}
    </svg>
  );
}
function Row({ label, hint, value, minus, plus, canMinus, canPlus }: { label: string; hint: string; value: string; minus: () => void; plus: () => void; canMinus: boolean; canPlus: boolean }) {
  return (
    <div className="is-row">
      <span>{label}</span>
      <div className="m-stepper">
        <button type="button" aria-label={`${label} 낮추기`} disabled={!canMinus} onClick={minus}>−</button>
        <output>{value}</output>
        <button type="button" aria-label={`${label} 높이기`} disabled={!canPlus} onClick={plus}>+</button>
      </div>
      <small>{hint}</small>
    </div>
  );
}

export default function IndustrySim({ profile, cfg: cfgIn, onBack }: { profile: Profile; cfg: IndustryCfg | null; onBack: () => void }) {
  const ind = profile.industry as LabIndustry;
  const t = LAB_TXT[ind];
  const cfg: IndustryCfg = cfgIn && cfgIn.industry === ind ? cfgIn : { industry: ind, grade: "basic", delivery: true };
  const pv = usePreview(profile, cfg);
  const [top, setTop] = useState(108);
  const [view, setView] = useState<View>("intro");
  const [startMonth, setStartMonth] = useState(3);
  const [start, setStart] = useState<Start | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [token, setToken] = useState("");
  const [plan, setPlan] = useState<Plan>({ price_change_pct: 0, hours: "standard", staff: cfg.staff ?? 1, marketing_krw: 0, delivery: cfg.delivery });
  const [choice, setChoice] = useState("");
  const [report, setReport] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [chartOpen, setChartOpen] = useState(true);

  useLayoutEffect(() => {
    const measure = () => { const n = document.querySelector(".m-mocknote") ?? document.querySelector(".m-top"); setTop(Math.round(n ? n.getBoundingClientRect().bottom : 108)); };
    measure(); addEventListener("resize", measure); return () => removeEventListener("resize", measure);
  }, []);
  useEffect(() => { if (pv.data && !start) setPlan((p) => ({ ...p, staff: pv.data!.input.staff, delivery: pv.data!.input.delivery })); }, [pv.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = months[months.length - 1];
  const TOTAL = start?.months_total ?? 6;
  const ev = cur ? cur.next_event : start?.next_event;
  const nextMonth = cur ? cur.next_calendar_month ?? (cur.calendar_month % 12) + 1 : start?.start_month ?? startMonth;
  const over = !!cur && cur.status !== "open";
  const startCash = start?.start_cash_krw ?? 0;
  const p = pv.data;
  const hoursOf = (h: Hours) => (start?.options.hours ?? p?.hours.presets)?.[h];
  const occupancy = useMemo(() => {
    if (!cur) return 0;
    return Math.min(1, cur.kpi.hall_covers / Math.max(1, cur.drivers.days_open) / Math.max(1, cur.drivers.seat_units_day) * 1.6);
  }, [cur]);

  const begin = () => {
    if (!p) return;
    setBusy(true); setErr("");
    const seed = Math.floor(Math.random() * 1_000_000); // 판마다 무작위 사건(경쟁 가게, 고장)이 달라진다. 같은 판 안에서는 엔진이 시드로 고정
    const body = { ...engineBody(profile, { ...cfg, pyeong: p.input.pyeong, tables: p.input.tables, staff: p.input.staff }), seed, start_month: startMonth };
    post<Start>("/season", body).then((s) => {
      setStart(s); setToken(s.state_token); setMonths([]); setReport(null); setChoice(s.next_event.default);
      setPlan({ price_change_pct: 0, hours: "standard", staff: s.decisions.staff, marketing_krw: 0, delivery: s.decisions.delivery });
      setView("plan");
    }).catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  const play = () => {
    if (!ev) return;
    setBusy(true); setErr("");
    post<Month>("/season/month", { state_token: token, month_index: months.length, ...plan, choice: choice || ev.default })
      .then((m) => { setMonths([...months, m]); setToken(m.state_token); setPlan((x) => ({ ...x, price_change_pct: 0 })); if (m.next_event) setChoice(m.next_event.default); setView("settle"); })
      .catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  const toReport = () => {
    setBusy(true);
    post("/season/report", { state_token: token }).then((r) => { setReport(r); setView("report"); }).catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  const restart = () => { setStart(null); setMonths([]); setReport(null); setView("intro"); };

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas">
        {p?.room ? <CafeRoom3D room={p.room} layout={p.layout} roster={view === "settle" || view === "report" ? p.roster : []} occupancy={occupancy} height="fill" /> : <p className="m-loading">{pv.err || "엔진을 부르는 중이에요"}</p>}
      </div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 매달 영업이익이 더해지고 대출 이자와 원금이 빠져요.</>}>{wman(cur ? cur.kpi.cash_krw : startCash)}</Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 {TOTAL}개월을 한 달씩 진행해요.</>}>{cur ? `${cur.calendar_month}월 (${cur.month}/${TOTAL})` : `${start?.start_month ?? startMonth}월 시작`}</Metric>
        <Metric icon={<IconStar />} label="별점" tip={<>손님 만족에 따라 움직여요. 돌아간 손님이 많거나 가격을 올리면 내려가요. (가정)</>}>{cur ? `★ ${cur.kpi.rating.toFixed(1)}` : "★ 4.0"}</Metric>
        <Metric icon={<IconHeart />} label="못 받은 손님" tip={<>좌석이나 일손이 모자라 받지 못한 주문(인분)이에요.</>}>{cur ? `${cur.kpi.walkaways.toLocaleString("ko-KR")}인분` : "-"}</Metric>
      </header>

      <button type="button" className="sx-ctoggle" aria-expanded={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? "현금 그래프 접기" : "현금 그래프 펴기"}</button>
      <div className="sx-leftcol">
        {chartOpen && start && (
          <aside className="sx-chartpanel" aria-label="남은 현금 그래프">
            <p className="sx-panel-h"><span>남은 현금</span><b>{wman(cur ? cur.kpi.cash_krw : startCash)}</b></p>
            <Cash start={startCash} months={months} total={TOTAL} />
            <small>빨간 점선은 0원이에요. 점은 한 달이 끝난 때의 현금이에요.</small>
          </aside>
        )}
        {cur && (
          <aside className="sx-planpanel" aria-label={`${cur.calendar_month}월 운영 계획`}>
            <p className="sx-panel-h"><span>{cur.calendar_month}월 운영</span></p>
            <dl>
              <div><dt>가격</dt><dd>개업가의 {Math.round(cur.decisions.price_level * 100)}%</dd></div>
              <div><dt>영업시간</dt><dd>{HOURS_KO[cur.decisions.hours]}</dd></div>
              <div><dt>직원</dt><dd>{cur.decisions.staff}명</dd></div>
              <div><dt>마케팅</dt><dd>{cur.decisions.marketing_krw ? `월 ${wman(cur.decisions.marketing_krw)}` : "없음"}</dd></div>
              <div><dt>{cur.event.title}</dt><dd>{cur.event.choice_label}</dd></div>
            </dl>
          </aside>
        )}
      </div>

      <div className="sx-modal" role="dialog" aria-modal="true" aria-label={`${t.shop} 시뮬레이션`}>
        <div className={`sx-pop sx-pop-${view}`}>
          {view === "intro" && (
            <>
              <div className="sx-scroll">
                <h1>{profile.gu}{profile.dong && profile.dong.gu === profile.gu ? ` ${profile.dong.name}` : ""}에서 {t.shop} {TOTAL}개월</h1>
                <Kpis items={[
                  { label: "가게", value: p ? `${p.input.pyeong}평, ${p.seats.total}석` : "-" },
                  { label: "평당 월세", value: p ? `${p.rent.man_per_pyeong}만원` : "-" },
                  { label: "여는 데 드는 돈", value: p ? wman(p.capex.total_krw) : "-" },
                  { label: "가진 돈", value: man(profile.capital), main: true },
                ]} />
                <section className="sx-sec">
                  <h2>이렇게 진행돼요</h2>
                  <ol className="sx-flow">
                    <li><b>운영 계획</b><span>달마다 가격, 영업시간, 직원, 마케팅{p?.demand.delivery_available ? ", 배달" : ""}을 정해요.</span></li>
                    <li><b>이달의 사건</b><span>그 달에 맞는 {t.shop} 사건이 하나 생겨요. 어떻게 대응할지 골라요.</span></li>
                    <li><b>정산</b><span>엔진이 그달 손님, 매출, 비용, 현금을 계산해요.</span></li>
                  </ol>
                  <p className="sx-note">새로 연 가게라 첫 달은 자리 잡힌 가게 손님의 55%에서 시작해요 (가정). 자리 잡힌 달 기준 매출은 {p ? wman(p.rough_month.revenue_krw) : "-"}이에요.</p>
                </section>
                <label className="sx-field">시작할 달
                  <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}</select>
                </label>
                {err && <p className="se-err" role="alert">{err}</p>}
              </div>
              <footer className="sx-foot">
                <button type="button" className="se-btn" onClick={begin} disabled={busy || !p}>{busy ? "준비하는 중이에요" : "문 열기"}</button>
                <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로 돌아가기</button>
              </footer>
            </>
          )}

          {view === "plan" && start && ev && (
            <>
              <div className="sx-scroll">
                <h1>{nextMonth}월 운영 계획</h1>
                {start && !cur && <p className="sx-note">{start.loan.principal_krw > 0 ? `${wman(start.loan.principal_krw)}을 빌려 문을 열었어요. ${start.loan.note_ko} 매달 ${wman(start.loan.monthly_payment_krw)}씩 갚아요.` : "대출 없이 문을 열었어요."} 통장에 {wman(startCash)}이 남았어요.</p>}
                {cur && (
                  <Kpis items={[
                    { label: `${cur.calendar_month}월 영업이익`, value: sgn(cur.kpi.op_krw), tone: tone(cur.kpi.op_krw), main: true },
                    { label: "매출", value: wman(cur.kpi.revenue_krw) },
                    { label: "손님", value: `${cur.kpi.covers.toLocaleString("ko-KR")}인분` },
                    { label: "별점", value: `★ ${cur.kpi.rating.toFixed(1)}` },
                  ]} />
                )}
                <div className="sx-split">
                  <section className="sx-sec" aria-label="이번 달 운영 계획">
                    <h2>{nextMonth}월에 이렇게 할게요</h2>
                    <div className="is-levers">
                      <Row label="가격 조정" hint="이번 달에 메뉴 가격을 한 번 바꿔요. 올리면 손님이 줄어요." value={plan.price_change_pct === 0 ? "그대로" : `${plan.price_change_pct > 0 ? "+" : ""}${plan.price_change_pct}%`}
                        canMinus={plan.price_change_pct > -20} canPlus={plan.price_change_pct < 30}
                        minus={() => setPlan({ ...plan, price_change_pct: plan.price_change_pct - 5 })} plus={() => setPlan({ ...plan, price_change_pct: plan.price_change_pct + 5 })} />
                      <Row label="영업시간" hint={`${hoursOf(plan.hours) ? `${clock(hoursOf(plan.hours)![0])}~${clock(hoursOf(plan.hours)![1])}` : ""}. 길게 열면 손님이 늘지만 인건비도 늘어요.`} value={HOURS_KO[plan.hours]}
                        canMinus={plan.hours !== "short"} canPlus={plan.hours !== "long"}
                        minus={() => setPlan({ ...plan, hours: HOURS_ORDER[HOURS_ORDER.indexOf(plan.hours) - 1] })} plus={() => setPlan({ ...plan, hours: HOURS_ORDER[HOURS_ORDER.indexOf(plan.hours) + 1] })} />
                      <Row label="직원" hint={`사장님 빼고. 한 명 월 ${p ? wman(p.staff.pay_month_krw) : "-"} (같은 업종 평균)`} value={`${plan.staff}명`}
                        canMinus={plan.staff > 0} canPlus={plan.staff < 8}
                        minus={() => setPlan({ ...plan, staff: plan.staff - 1 })} plus={() => setPlan({ ...plan, staff: plan.staff + 1 })} />
                      <Row label="마케팅" hint="한 달 광고·SNS 비용이에요. 효과 크기는 가정이에요." value={plan.marketing_krw ? `월 ${wman(plan.marketing_krw)}` : "없음"}
                        canMinus={plan.marketing_krw > 0} canPlus={plan.marketing_krw < 3_000_000}
                        minus={() => setPlan({ ...plan, marketing_krw: plan.marketing_krw - 500_000 })} plus={() => setPlan({ ...plan, marketing_krw: plan.marketing_krw + 500_000 })} />
                      {start.options.delivery_available && (
                        <Row label="배달" hint="끄면 배달 수수료가 없어지지만 배달 손님 대부분을 잃어요." value={plan.delivery ? "받아요" : "안 받아요"}
                          canMinus={plan.delivery} canPlus={!plan.delivery}
                          minus={() => setPlan({ ...plan, delivery: false })} plus={() => setPlan({ ...plan, delivery: true })} />
                      )}
                    </div>
                  </section>
                  <section className="sx-sec" aria-labelledby="is-ev-h">
                    <h2 id="is-ev-h">이달의 사건</h2>
                    <div className="sx-dp is-dp" role="radiogroup" aria-labelledby="is-ev-t">
                      <header className="sx-dp-h"><h3 id="is-ev-t">{ev.title}</h3></header>
                      <div className="sx-dp-q"><p>{ev.prompt}</p>{ev.why && <small>{ev.why}. 대응의 효과 크기는 가정이에요.</small>}</div>
                      <div className="sx-dp-opts">
                        {ev.options.map((o) => (
                          <label key={o.id} className={(choice || ev.default) === o.id ? "on" : ""}>
                            <input type="radio" name="is-ev" checked={(choice || ev.default) === o.id} onChange={() => setChoice(o.id)} />
                            <span className="sx-opt">
                              <span className="sx-opt-h"><b>{o.label}</b>{o.id === ev.default && <span className="sx-chip">기본</span>}</span>
                              {o.hint && <span className="sx-pro">{o.hint}</span>}
                              {o.downside && <span className="sx-con">{o.downside}</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </section>
                </div>
                {err && <p className="se-err" role="alert">{err}</p>}
              </div>
              <footer className="sx-foot">
                <button type="button" className="se-btn" onClick={play} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${nextMonth}월 영업하기`}</button>
                <small>가격은 이번 달에 한 번 바꾸는 폭이고, 나머지는 바꾸기 전까지 이어져요.</small>
              </footer>
            </>
          )}

          {view === "settle" && cur && (
            <>
              <div className="sx-scroll">
                <h1>{cur.calendar_month}월 정산</h1>
                <Kpis items={[
                  { label: "영업이익", value: sgn(cur.kpi.op_krw), tone: tone(cur.kpi.op_krw), main: true },
                  { label: "매출", value: wman(cur.kpi.revenue_krw) },
                  { label: "월말 현금", value: wman(cur.kpi.cash_krw) },
                  { label: "못 받은 손님", value: `${cur.kpi.walkaways.toLocaleString("ko-KR")}인분 (${Math.round(cur.kpi.walkaway_share * 100)}%)` },
                ]} />
                <p className="sx-note">{cur.owner_note_ko}</p>
                <p className="sx-note"><b>{cur.event.title}:</b> {cur.event.choice_label}{cur.event.downside ? ` (${cur.event.downside})` : ""}</p>
                {cur.random_events.length > 0 && (
                  <section className="sx-evbox"><h2>이번 달에 생긴 일</h2>
                    <ul>{cur.random_events.map((e) => <li key={e.key}><b>{e.label_ko}</b><span>{e.effect_ko}</span></li>)}</ul>
                  </section>
                )}
                <div className="sx-split">
                  <section className="sx-sec"><h2>손익</h2>
                    <table className="sx-table"><tbody>
                      <tr><th>매출</th><td>{wman(cur.pnl.revenue_krw)}</td></tr>
                      {cur.pnl.lines.filter((l) => l.krw !== 0).map((l) => <tr key={l.key}><th>{l.item_ko}</th><td>{minus(l.krw)}</td></tr>)}
                      <tr className="sum"><th>영업이익</th><td className={tone(cur.pnl.op_krw)}>{sgn(cur.pnl.op_krw)}</td></tr>
                    </tbody></table>
                    <small>사장님 몫은 비용에 넣지 않았어요. 같은 업종 사장님은 평균 월 {wman(cur.kpi.owner_pay_ref_krw)}을 가져가요 (경영실태조사 2025).<Q>영업이익이 이 값보다 적으면 사장님 월급만큼도 못 버는 거예요.</Q></small>
                  </section>
                  <section className="sx-sec"><h2>현금</h2>
                    <table className="sx-table"><tbody>
                      <tr><th>월초 현금</th><td>{wman(cur.cash.start_krw)}</td></tr>
                      <tr><th>영업이익</th><td>{sgn(cur.cash.op_krw)}</td></tr>
                      <tr><th>감가상각 되돌림</th><td>+{wman(cur.cash.depreciation_addback_krw)}</td></tr>
                      <tr><th>대출 이자</th><td>{minus(cur.cash.loan_interest_krw)}</td></tr>
                      <tr><th>대출 원금</th><td>{minus(cur.cash.loan_principal_krw)}</td></tr>
                      <tr className="sum"><th>월말 현금</th><td className={tone(cur.cash.end_krw)}>{wman(cur.cash.end_krw)}</td></tr>
                    </tbody></table>
                    <small>좌석은 하루 {cur.drivers.seat_units_day}명, 일손은 하루 {cur.drivers.crew_units_day}인분까지 받았어요.</small>
                  </section>
                </div>
                {cur.closure.closed && <p className="se-err">가게를 닫았어요. {cur.closure.reason_ko}</p>}
              </div>
              <footer className="sx-foot">
                <button type="button" className="se-btn" disabled={busy} onClick={() => (over ? toReport() : setView("plan"))}>{over ? "전체 결과 보기" : `${nextMonth}월 운영 계획 정하기`}</button>
              </footer>
            </>
          )}

          {view === "report" && report && (
            <>
              <div className="sx-scroll">
                <h1>{report.months_played}개월 결과</h1>
                <Kpis items={[
                  { label: "마지막 현금", value: wman(report.end_cash_krw), main: true },
                  { label: "누적 영업이익", value: sgn(report.cumulative_op_krw), tone: tone(report.cumulative_op_krw) },
                  { label: "가장 좋았던 달", value: report.best_month ? `${report.best_month.calendar_month}월 ${sgn(report.best_month.op_krw)}` : "-" },
                  { label: "가장 나빴던 달", value: report.worst_month ? `${report.worst_month.calendar_month}월 ${sgn(report.worst_month.op_krw)}` : "-" },
                ]} />
                <p className="sx-note">{report.survived ? `${TOTAL}개월을 버텼어요. ` : <b>가게를 닫게 됐어요. </b>}{report.summary_ko}</p>
                <section className="sx-sec"><h2>남은 현금</h2><Cash start={startCash} months={months} total={TOTAL} /></section>
                <section className="sx-sec"><h2>월별</h2>
                  <table className="sx-table"><thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>월말 현금</th><th>사건과 대응</th></tr></thead>
                    <tbody>{report.months.map((x: { month: number; calendar_month: number; revenue_krw: number; op_krw: number; cash_krw: number; event: string; choice: string }) => (
                      <tr key={x.month}><td>{x.calendar_month}월</td><td>{wman(x.revenue_krw)}</td><td className={tone(x.op_krw)}>{sgn(x.op_krw)}</td><td>{wman(x.cash_krw)}</td><td>{x.event}: {x.choice}</td></tr>
                    ))}</tbody></table>
                </section>
              </div>
              <footer className="sx-foot">
                <button type="button" className="se-btn" onClick={restart}>처음부터 다시</button>
                <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로</button>
                <small>엔진은 새 업종 월 모델이에요. 비용 비율은 경영실태조사 2025, 별점·사건 크기는 가정값이에요.</small>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
