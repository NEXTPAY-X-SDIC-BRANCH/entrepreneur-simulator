// "그래서 ○○동 안에서는 어디가 좋을까요?": 동 안 상권을 성장·안정·조심으로 나눠 카드로 보인다. 시안: docs/design-handoff/mockups/Dong.dc.html
// 라벨 규칙은 area.ts trdarPicks. 문장은 숫자로만 말하고 현장 조사·추측은 쓰지 않는다. 주의 한 줄도 데이터에서 나온 것만.
import { useState } from "react";
import Icon from "./Icons";
import { T, iga, industry } from "./model";
import { TRDAR_RULE, trdarMeta, trdarPicks, type TrdarInd, type TrdarPick } from "./area";

const n0 = (v: number) => Math.round(v).toLocaleString("ko-KR");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`;
const quarter = (q: string) => `${q.slice(0, 4)}년 ${q.slice(4)}분기`;
const TRDAR_MIN = TRDAR_RULE.minStores, BIG = TRDAR_RULE.labelMinStores;
const RANK: Record<string, string> = { 성장: "1순위 · 성장", 안정: "2순위 · 안정", 조심: "조심" };

// 카드 문장: 라벨이 붙은 이유를 숫자로
function why(p: TrdarPick, dong: string): string {
  const m = p.m, out: string[] = [];
  if (p.label === "성장") out.push(`${dong} 안 상권(${BIG}곳 이상) 중 1년 매출이 가장 많이 늘었어요 (${signed(m.yoy ?? 0)}).`);
  if (p.label === "안정") out.push(`점포당 월매출이 ${dong} 안 상권(${BIG}곳 이상) 중 가장 높고, ${m.close ? `최근 1년 문 닫은 곳이 ${m.close}곳${m.close === 1 ? "뿐" : ""}이에요` : "최근 1년 문 닫은 곳이 한 곳도 없어요"}.`);
  if (p.label === "조심") {
    if ((m.yoy ?? 0) <= -15) out.push(`매출이 1년 새 ${Math.abs(m.yoy ?? 0)}% 줄었어요.`);
    if (m.close > m.open * 1.5) out.push(m.open ? `문 닫은 곳(${m.close})이 연 곳(${m.open})의 ${(Math.round((m.close / m.open) * 10) / 10).toFixed(1)}배예요.` : `1년 동안 연 곳 없이 ${m.close}곳이 문을 닫았어요.`);
  }
  if (!p.label) out.push(`점포당 월매출 ${n0(m.per_store ?? 0)}만원, 1년 매출 ${m.yoy != null ? signed(m.yoy) : "비교 자료 없음"}이에요.`);
  if ((m.age4050 ?? 0) >= 0.5) out.push(`손님은 40·50대가 ${pct(m.age4050!)}예요.`);
  else if ((m.age2030 ?? 0) >= 0.5) out.push(`손님은 20·30대가 ${pct(m.age2030!)}예요.`);
  return out.join(" ");
}
// 주의 한 줄: 카드의 라벨 이유와 겹치지 않는 것 중 첫 번째
function caution(p: TrdarPick, base: string, q25: number): string | null {
  const m = p.m, c: string[] = [];
  if (m.stores < 15) c.push(`${iga(base)} ${m.stores}곳뿐인 작은 상권이에요`);
  if (p.label !== "조심" && m.close > m.open) c.push(`문 닫은 곳(${m.close})이 연 곳(${m.open})보다 많아요`);
  if (p.label !== "조심" && (m.yoy ?? 0) < 0) c.push(`1년 매출이 ${Math.abs(m.yoy!)}% 줄었어요`);
  if ((m.per_store ?? 0) < q25) c.push(`점포당 월매출이 서울 상권의 아래쪽 4분의 1이에요`);
  return c[0] ?? null;
}
function Stat({ k, v, tone }: { k: string; v: string; tone?: "up" | "down" }) {
  return <div><span>{k}</span><b className={tone ? `is-${tone}` : undefined}>{v}</b></div>;
}

export default function DongTrdar({ code, dong }: { code: string; dong: string }) {
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const r = trdarPicks(code), meta = trdarMeta();
  if (!r || !meta) return null;
  const cafe = industry() === "cafe";
  const base = cafe ? "커피·음료 가게" : "한식집";
  const bench = meta.bench[industry()];
  const [q25, q50] = bench.per_store_q;
  const labeled = r.picks.filter((p) => p.label);
  const shown = [...labeled.filter((p) => p.label !== "조심"), ...labeled.filter((p) => p.label === "조심").slice(0, 2)];
  const rest = r.picks.filter((p) => !shown.includes(p));
  const allBelow = r.picks.length > 0 && r.picks.every((p) => (p.m.per_store ?? 0) < q50);
  const allAbove = r.picks.length > 0 && r.picks.every((p) => (p.m.per_store ?? 0) >= q50);
  const card = (p: TrdarPick) => {
    const m: TrdarInd = p.m, c = caution(p, base, q25);
    return (
      <article key={p.t.code} className={`t-card is-${p.label ?? "none"}`}>
        <div className="t-top">{p.label && <span className="t-badge">{RANK[p.label]}</span>}<span>{p.t.type}</span></div>
        <h3>{p.t.name} 상권</h3>
        <p>{why(p, dong)}</p>
        <div className="t-stats">
          <Stat k="1년 매출" v={m.yoy != null ? signed(m.yoy) : "-"} tone={m.yoy != null ? (m.yoy >= 0 ? "up" : "down") : undefined} />
          <Stat k="점포당 월매출" v={`${n0(m.per_store ?? 0)}만원`} />
          <Stat k={cafe ? "커피·음료 가게" : "한식집"} v={`${m.stores}곳`} />
          <Stat k="1년 개업·폐업" v={`+${m.open} / −${m.close}`} />
        </div>
        {c && <span className="t-warn">주의 · {c}</span>}
      </article>
    );
  };

  return (
    <section className={`t-sec${open ? " is-open" : ""}`} aria-labelledby="trdar-title">
      {/* 처음엔 접어 두고 제목과 라벨 한 줄만 보인다. 누르면 카드와 기준이 펼쳐진다 */}
      <button type="button" className="t-toggle" aria-expanded={open} aria-controls="trdar-body" onClick={() => setOpen((o) => !o)}>
        <span className="t-toggle-text">
          <span id="trdar-title" className="t-title">그래서 {dong} 안에서는 어디가 좋을까요?</span>
          {!open && (shown.length > 0
            ? <span className="t-peek">{shown.map((p) => <span key={p.t.code} className={`t-badge is-${p.label}`}>{p.label === "조심" ? "조심" : RANK[p.label!]} · {p.t.name}</span>)}</span>
            : <small>{r.picks.length ? `상권 ${r.picks.length}곳 비교` : `${iga(base)} ${TRDAR_MIN}곳 이상인 상권이 없어요`}</small>)}
        </span>
        <Icon name="arrow" size={22} />
      </button>
      {open && (
        <div className="t-body" id="trdar-body">
          <small className="t-sub">
            {r.picks.length > 0
              ? `${dong}에 있는 상권 ${r.all.length}곳 중 ${base} ${TRDAR_MIN}곳 이상이고 매출이 잡히는 ${r.picks.length}곳을 비교했어요. 서울시 상권분석 ${quarter(meta.quarter)}, ${cafe ? "커피-음료" : "한식음식점"} 기준이에요.`
              : `${dong}에는 ${iga(base)} ${TRDAR_MIN}곳 이상이고 매출이 잡히는 상권이 없어요${r.all.length ? ` (상권 ${r.all.length}곳)` : ""}.`}
          </small>
          {shown.length > 0 && <div className="t-cards">{shown.map(card)}</div>}
          {rest.length > 0 && (
            <>
              <button type="button" className="m-link t-more" aria-expanded={more} onClick={() => setMore((x) => !x)}>
                {more ? "접기" : shown.length ? `라벨이 붙지 않은 상권 ${rest.length}곳 더 보기` : `상권 ${rest.length}곳 보기`}
              </button>
              {more && <div className="t-cards">{rest.map(card)}</div>}
            </>
          )}
          <small className="t-foot">
            성장·안정은 {base} {BIG}곳 이상인 상권에만 붙여요(작은 상권은 한두 곳의 매출로 숫자가 크게 흔들려서). 비교 기준 · 서울 상권({base} {TRDAR_MIN}곳 이상, {n0(bench.n)}곳)의 점포당 월매출 중간값은 {n0(q50)}만원이에요.
            {allBelow ? ` ${dong} 상권은 모두 이보다 낮아요.` : allAbove ? ` ${dong} 상권은 모두 이보다 높아요.` : ""}
            {" "}점포당 월매출은 카드 추정 원값이라 위 지표 카드의 보정한 {T().shop} 매출과 기준이 달라요. 1년 매출은 {quarter(meta.quarter_prev)} 대비 {quarter(meta.quarter)}이고 상권 전체 매출이라 점포 수 변화가 섞여 있어요.
            열고 닫은 곳은 최근 4분기({quarter(meta.flow_quarters[0])}~{quarter(meta.flow_quarters[meta.flow_quarters.length - 1])})예요.
            {cafe ? "" : " 상권별 고깃집 수는 아직 없어 한식음식점 전체 기준이에요."}
            {" "}서울시 자료는 상권마다 중심이 속한 행정동 하나에만 붙어서, 맞닿은 동의 상권은 여기에 나오지 않아요.
          </small>
        </div>
      )}
    </section>
  );
}
