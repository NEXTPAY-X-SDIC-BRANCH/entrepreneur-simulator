// 6개월 성적표: 100점 만점, 다섯 영역, 등급, 점수가 깎인 곳을 짚는 진단, 반(클래스 코드)별 랭킹.
// 배점과 만점 기준은 우리가 정한 가정이다 (교육용 비교 척도이지 창업 성공 확률이 아니다). 진단은 규칙으로 만든다.
// 랭킹은 엔진 서버(api/changeup.py /scores)에 별명과 점수만 쌓는다.
import { useEffect, useState } from "react";
import { man } from "./model";
import { useAccount } from "./account";
import Assume from "./Assume";

export type ScoreMonth = {
  month: number; revenue: number; op: number; cogs: number; labor: number; rent: number; mgmt: number; fees: number;
  covers: number; walkaways: number; util: number; fatigue: number; closed: boolean;
  decisions: { title: string; chosen_label: string; vs_default_op: number }[];
};
type Area = { key: string; label: string; max: number; got: number; detail: string; fix: string };

// 시도 기록: 이 브라우저(localStorage)에만 남는다. 같은 업종·모드의 바로 전 시도와 영역별 점수를 비교한다
type Attempt = { ts: string; shop: string; mode: string; gu: string; seed?: number; total: number; endCash: number; areas: Record<string, number> };
const ATTEMPTS = "cu-attempts";
function readAttempts(): Attempt[] {
  try { return JSON.parse(localStorage.getItem(ATTEMPTS) ?? "[]") as Attempt[]; } catch { return []; }
}
// 같은 판을 두 번 넣지 않는다 (React 개발 모드의 effect 두 번 실행, 화면 다시 그리기)
function recordAttempt(a: Attempt): Attempt[] {
  const all = readAttempts();
  const last = all.at(-1);
  if (last && last.seed === a.seed && last.total === a.total && last.endCash === a.endCash && last.shop === a.shop && last.mode === a.mode) return all;
  const next = [...all, a].slice(-30);
  try { localStorage.setItem(ATTEMPTS, JSON.stringify(next)); } catch { /* 저장 못 해도 이번 화면은 보여 준다 */ }
  return next;
}
type Row = { id: string; rank: number; name: string; score: number; grade: string; mode: string; gu: string; shop?: string };

const API = "http://127.0.0.1:8010";
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const won = (x: number) => man(Math.round(x / 1e4));

export const GRADES = [
  { min: 90, label: "창업 적격", note: "이 조건이면 창업해도 버틸 힘이 있어요." },
  { min: 80, label: "조금 더 훈련", note: "거의 다 왔어요. 아래 두 가지만 고치면 적격이에요." },
  { min: 60, label: "다시 설계 필요", note: "가게 구성이나 운영을 크게 바꿔 다시 돌려 보세요." },
  { min: 0, label: "지금은 직장인이 나아요", note: "이대로 열면 버티기 어려워요. 예산과 동네부터 다시 정해 보세요." },
];

// kind "retail"(옷가게): covers=결제 건수, walkaways=놓친 매출을 결제 건수로 바꾼 값, util=재고 소진율, fatigue=일손 부하(%). 문구만 다르고 점수 식은 같다
export function scoreOf(months: ScoreMonth[], startCash: number, lowestCash: number, endCash: number, monthlyCashOut: number, kind: "food" | "retail" = "food"): { total: number; areas: Area[] } {
  const n = months.length || 1;
  const closed = months.some((m) => m.closed);
  const last3 = months.slice(-3);
  const rev3 = last3.reduce((a, m) => a + m.revenue, 0);
  const margin = rev3 ? last3.reduce((a, m) => a + m.op, 0) / rev3 : 0;
  const black = months.filter((m) => m.op > 0).length;
  const runway = monthlyCashOut > 0 ? endCash / monthlyCashOut : 0;
  const covers = months.reduce((a, m) => a + m.covers, 0);
  const walk = months.reduce((a, m) => a + m.walkaways, 0) / Math.max(1, covers + months.reduce((a, m) => a + m.walkaways, 0));
  const util = months.reduce((a, m) => a + m.util, 0) / n;
  const fatigue = months.at(-1)?.fatigue ?? 30;
  const decs = months.flatMap((m) => m.decisions);
  const worse = decs.filter((d) => d.vs_default_op < 0);
  const revAll = months.reduce((a, m) => a + m.revenue, 0) || 1;
  const share = (k: "cogs" | "labor" | "rent") => months.reduce((a, m) => a + m[k] + (k === "rent" ? m.mgmt : 0), 0) / revAll;
  const big = (["cogs", "labor", "rent"] as const).map((k) => ({ k, v: share(k) })).sort((a, b) => b.v - a.v)[0];
  const retail = kind === "retail";
  const bigKo = { cogs: retail ? "매입 원가" : "재료비", labor: retail ? "인건비" : "인건비(사장 가상 급여 포함)", rent: retail ? "월세와 기타경비(카드 수수료·공과금 등)" : "월세·관리비" }[big.k];

  const areas: Area[] = [
    {
      key: "survive", label: "생존", max: 30,
      got: closed ? 0 : 30 * clamp(lowestCash / Math.max(1, startCash) / 0.5),
      detail: closed ? "6개월 안에 가게를 닫았어요." : `현금이 가장 낮을 때 ${won(lowestCash)}까지 내려갔어요 (시작의 ${pct(lowestCash / Math.max(1, startCash))}).`,
      fix: "운영자금을 더 남기세요. 인테리어 등급이나 평수를 낮추거나, 대출을 조금 더 받아 첫 석 달을 버틸 돈을 확보해요.",
    },
    {
      key: "profit", label: "수익성", max: 25,
      got: 15 * clamp((margin + 0.05) / 0.15) + 10 * (black / n),
      detail: `최근 3개월 영업이익률 ${pct(margin)}, 흑자인 달 ${black}/${months.length}. 매출에서 가장 큰 비용은 ${bigKo} ${pct(big.v)}예요.`,
      fix: retail ? (big.k === "rent" ? "고정비가 매출에 비해 커요. 매출을 늘리려면 알바를 둬 놓치는 손님을 줄이고, 아니면 평수를 줄이거나 월세가 낮은 구를 골라 봐요." : "할인을 줄이고, 철 지난 재고가 쌓이지 않게 매입량을 맞춰요. 남는 옷은 시즌 오프에 일찍 정리해요.")
        : big.k === "cogs" ? "원가율이 높은 메뉴의 가격을 올리거나 비중을 줄여요 (자세히 모드에서 메뉴별로 볼 수 있어요)."
        : big.k === "labor" ? "손님이 적은 달은 알바를 줄이거나 마감을 당겨 일하는 시간을 줄여요."
        : "월세가 매출에 비해 커요. 평수를 줄이거나 월세가 낮은 동네를 다시 골라 봐요.",
    },
    {
      key: "cash", label: "현금 여유", max: 20,
      got: 20 * clamp(runway / 3),
      detail: `6개월 뒤 현금 ${won(endCash)}은 한 달에 나가는 고정 지출(${won(monthlyCashOut)})의 ${runway.toFixed(1)}개월치예요.`,
      fix: "이 시뮬레이터는 고정 지출 3개월치가 남아 있으면 만점으로 봐요. 사장 생활비와 고정비를 다시 잡아 보세요.",
    },
    {
      key: "ops", label: "운영 효율", max: 15,
      got: 5 * clamp((0.15 - walk) / 0.12) + 5 * clamp((util - 0.2) / 0.4) + 5 * clamp((80 - fatigue) / 40),
      detail: retail ? `재고나 일손이 모자라 놓친 매출 ${pct(walk)}, 재고 소진율 ${pct(util)}, 일손 부하 ${Math.round(fatigue)}%.`
        : `자리가 없어 돌아간 손님 ${pct(walk)}, 테이블 이용률 ${pct(util)}, 직원 피로 ${Math.round(fatigue)}.`,
      fix: retail ? (walk > 0.08 ? "물건이나 일손이 모자라 손님을 놓쳤어요. 매입량을 늘리거나 바쁜 달엔 알바를 두세요." : util < 0.35 ? "재고가 너무 많이 쌓였어요. 매입량을 줄이고 시즌 오프 세일로 정리해요." : "일손이 빠듯해요. 주말에 알바를 두는 걸 생각해 보세요.")
        : walk > 0.08 ? "손님을 놓치고 있어요. 알바를 늘리거나 테이블을 더 두세요."
        : util < 0.35 ? "테이블이 많이 비어요. 평수를 줄이거나 홍보(SNS 협찬)로 손님을 늘려요."
        : "직원이 지쳐 있어요. 알바를 늘리거나 마감을 당겨 피로를 낮춰요.",
    },
    {
      key: "react", label: "위기 대응", max: 10,
      got: decs.length ? 10 * (1 - worse.length / decs.length) : 10,
      detail: decs.length ? `이달의 사건 ${decs.length}번 중 기본 대응보다 손해 본 선택이 ${worse.length}번이에요.` : "대응할 사건이 없었어요.",
      fix: worse.length ? `${worse[0].title}에서 고른 "${worse[0].chosen_label}"가 기본 대응보다 손해였어요. 정산의 "다른 대응을 골랐다면"으로 비교해 보세요.` : "사건마다 득실을 잘 따졌어요.",
    },
  ];
  return { total: Math.round(areas.reduce((a, x) => a + x.got, 0)), areas };
}

export default function Scorecard({ months, startCash, lowestCash, endCash, monthlyCashOut, gu, mode, kind = "food", benchmark, shop = "고깃집", seed }: {
  months: ScoreMonth[]; startCash: number; lowestCash: number; endCash: number; monthlyCashOut: number; gu: string; mode: "easy" | "hard";
  kind?: "food" | "retail"; benchmark?: string; // benchmark: 생존율 참고 문장을 바꿀 때 (옷가게는 도소매업 값)
  shop?: string; // 업종 이름 (랭킹은 같은 반·업종·모드끼리)
  seed?: number; // 이 판의 시드 (사건·날씨). 점수와 함께 저장한다
}) {
  const { total, areas } = scoreOf(months, startCash, lowestCash, endCash, monthlyCashOut, kind);
  const grade = GRADES.find((g) => total >= g.min)!;
  const weak = [...areas].sort((a, b) => (b.max - b.got) - (a.max - a.got)).filter((a) => a.max - a.got >= 1).slice(0, 2);
  const [surv, setSurv] = useState<{ y: string; s3: number } | null>(null);
  const acc = useAccount(); // 로그인했으면 별명·반 코드를 계정에서 가져온다
  const [name, setName] = useState(() => { try { return acc?.name ?? localStorage.getItem("cu-name") ?? ""; } catch { return acc?.name ?? ""; } });
  const [cls, setCls] = useState(() => { try { return acc?.cls ?? localStorage.getItem("cu-cls") ?? "공개"; } catch { return acc?.cls ?? "공개"; } });
  const [board, setBoard] = useState<{ top: Row[]; count: number; mine?: string; rank?: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [tries, setTries] = useState<Attempt[]>([]);
  useEffect(() => {
    const all = recordAttempt({ ts: new Date().toISOString(), shop, mode, gu, seed, total, endCash: Math.round(endCash),
      areas: Object.fromEntries(areas.map((a) => [a.key, Math.round(a.got)])) });
    setTries(all.filter((t) => t.shop === shop && t.mode === mode));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}mock/survival_kosis.json`).then((r) => r.json())
      .then((d) => { const y = d._meta.latest; setSurv({ y, s3: d.region.seoul_food[y]["3"] }); }).catch(() => setSurv(null));
  }, []);
  const modeKo = mode === "hard" ? "자세히" : "쉬운";
  const load = (c: string) => fetch(`${API}/scores?${new URLSearchParams({ cls: c, shop, mode })}`).then((r) => r.json())
    .then((d) => setBoard({ top: d.top, count: d.count })).catch(() => setBoard(null));
  useEffect(() => { void load(cls); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!name.trim()) { setMsg("별명을 적어 주세요."); return; }
    try { localStorage.setItem("cu-name", name.trim()); localStorage.setItem("cu-cls", cls.trim() || "공개"); } catch { /* 저장 못 해도 진행 */ }
    try {
      const r = await fetch(`${API}/scores`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), cls: cls.trim() || "공개", score: total, grade: grade.label, mode, gu, shop, end_cash: endCash, seed }) });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setBoard({ top: d.top, count: d.count, mine: d.id, rank: d.rank });
      setMsg(`${d.cls} 반 · ${shop} · ${modeKo} 모드 ${d.count}명 중 ${d.rank}등이에요.`);
    } catch { setMsg("랭킹 서버(엔진 서버 8010)에 저장하지 못했어요."); }
  };

  // 게임 결과 화면처럼: 한 줄 결론 → 가장 큰 원인 → 업적 배지
  const closed = months.some((m) => m.closed);
  const n = months.length;
  const best = [...months].sort((a, b) => b.op - a.op)[0];
  const worst = [...months].sort((a, b) => a.op - b.op)[0];
  const black = months.filter((m) => m.op > 0).length;
  const headline = closed ? `${n}개월 만에 문을 닫았어요` : total >= 80 ? `${n}개월을 버텼고, 남는 장사였어요` : endCash > 0 ? `${n}개월을 버텼지만 아슬아슬했어요` : `${n}개월을 버텼지만 현금이 바닥났어요`;
  const tone = closed || total < 60 ? "is-bad" : total < 80 ? "is-mid" : "";
  const signedMan = (x: number) => `${x >= 0 ? "+" : "−"}${won(Math.abs(x))}`;
  return (
    <section className="sx-sec sc-card" aria-label="6개월 성적표">
      <div className={`sc-hero ${tone}`}>
        <h2>{headline}</h2>
        <p>{weak[0] ? `가장 큰 원인은 ${weak[0].label}이에요. ${weak[0].detail}` : "다섯 영역 모두 고르게 잘했어요."}</p>
      </div>
      <ul className="sc-badges" aria-label="기록">
        <li><small>흑자인 달</small><b>{black} / {n}</b></li>
        <li><small>가장 좋았던 달</small><b>{best.month}월 {signedMan(best.op)}</b></li>
        <li><small>가장 힘들었던 달</small><b>{worst.month}월 {signedMan(worst.op)}</b></li>
        <li><small>마지막 현금</small><b>{won(endCash)}</b></li>
      </ul>
      <div className="sc-head">
        <div className="sc-score"><b>{total}</b><span>/ 100점</span></div>
        <div>
          <p className="sc-grade">{grade.label}</p>
          <p className="sx-note">{grade.note}</p>
        </div>
      </div>
      <ul className="sc-areas">
        {areas.map((a) => (
          <li key={a.key}>
            <span className="sc-label">{a.label}{a.key === "cash" && <Assume what="고정 지출 3개월치가 남으면 만점" />}</span>
            <span className="sc-bar" aria-hidden="true"><i style={{ width: `${(a.got / a.max) * 100}%` }} /></span>
            <span className="sc-pts">{Math.round(a.got)}/{a.max}</span>
            <small>{a.detail}</small>
          </li>
        ))}
      </ul>

      <h2>무엇을 고치면 점수가 오를까요</h2>
      {weak.length === 0 ? <p className="sx-note">깎인 점수가 거의 없어요. 다른 동네나 업종으로도 돌려 보세요.</p> : (
        <ol className="sc-fix">
          {weak.map((a) => <li key={a.key}><b>{a.label} +{Math.round(a.max - a.got)}점 가능</b><span>{a.fix}</span></li>)}
        </ol>
      )}
      {tries.length >= 2 && (() => {
        const prev = tries[tries.length - 2];
        const d = total - prev.total;
        const moved = areas.map((a) => ({ a, d: Math.round(a.got) - (prev.areas[a.key] ?? 0) })).filter((x) => x.d !== 0).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
        const recent = tries.slice(-5);
        return <>
          <h2>지난 시도와 비교</h2>
          <p className="sx-note">{shop} · {mode === "hard" ? "자세히" : "쉬운"} 모드 {tries.length}번째 시도예요. 바로 전보다 <b className={d >= 0 ? "sc-up" : "sc-down"}>{d >= 0 ? `+${d}` : d}점</b>{d === 0 ? " (같아요)" : ""}.</p>
          {moved.length > 0 && (
            <ul className="sc-diff">
              {moved.map(({ a, d: x }) => <li key={a.key}><span>{a.label}</span><b className={x > 0 ? "sc-up" : "sc-down"}>{x > 0 ? `+${x}` : x}</b></li>)}
            </ul>
          )}
          <table className="sx-table sc-tries">
            <thead><tr><th>시도</th><th>날짜</th><th>동네</th><th>점수</th><th>6개월 뒤 현금</th></tr></thead>
            <tbody>{recent.map((t, i) => (
              <tr key={t.ts} className={i === recent.length - 1 ? "me" : undefined}>
                <td>{tries.length - recent.length + i + 1}</td><td>{t.ts.slice(5, 10).replace("-", "/")}</td><td>{t.gu}</td><td>{t.total}</td><td>{won(t.endCash)}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="sx-note">시도 기록은 이 브라우저에만 저장돼요.</p>
        </>;
      })()}
      {benchmark ? <p className="sx-note">{benchmark}</p> : surv && <p className="sx-note">참고로 서울에서 새로 연 음식점(숙박·음식점업)은 3년 뒤 {surv.s3}%만 남아요 (통계청 기업생멸행정통계 {surv.y}년).</p>}
      <p className="sx-note">배점(생존 30, 수익성 25, 현금 여유 20, 운영 효율 15, 위기 대응 10)과 만점 기준은 교육용으로 정한 가정이에요<Assume what="성적표 배점과 만점 기준, 등급 구간(90·80·60점)" />. 진단은 결과 숫자로 만든 규칙이에요.</p>

      <h2>랭킹</h2>
      <div className="sc-save">
        {acc ? <p className="sx-note"><b>{acc.name}</b> · 반 {acc.cls} 이름으로 저장해요.</p> : <>
          <label>별명<input value={name} maxLength={12} onChange={(e) => setName(e.target.value)} placeholder="예: 창업러" /></label>
          <label>반 코드<input value={cls} maxLength={20} onChange={(e) => setCls(e.target.value)} onBlur={() => load(cls.trim() || "공개")} /></label>
        </>}
        <button type="button" className="se-btn" onClick={save} disabled={!!board?.mine}>{board?.mine ? "저장했어요" : "점수 저장"}</button>
      </div>
      {msg && <p className="sx-note" role="status">{msg}</p>}
      {board && board.top.length > 0 ? (
        <table className="sx-table sc-rank">
          <caption>{cls.trim() || "공개"} 반 · {shop} · {modeKo} 모드 랭킹</caption>
          <thead><tr><th>순위</th><th>별명</th><th>점수</th><th>등급</th><th>업종</th><th>모드</th><th>동네</th></tr></thead>
          <tbody>{board.top.map((r) => (
            <tr key={r.id} className={r.id === board.mine ? "me" : undefined}>
              <td>{r.rank}</td><td>{r.name}</td><td>{r.score}</td><td>{r.grade}</td><td>{r.shop ?? "고깃집"}</td><td>{r.mode === "hard" ? "자세히" : "쉬운"}</td><td>{r.gu}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="sx-note">{board ? `이 반의 ${shop} · ${modeKo} 모드에는 아직 기록이 없어요. 첫 기록을 남겨 보세요.` : "랭킹 서버에 연결하지 못했어요."}</p>}
      <small className="sx-note">같은 반 코드를 쓰는 사람끼리 순위를 봐요. 별명과 점수만 저장해요.</small>
    </section>
  );
}
