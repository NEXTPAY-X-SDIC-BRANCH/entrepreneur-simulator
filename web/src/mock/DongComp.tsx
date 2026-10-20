// 동을 골랐을 때 '경쟁' 탭의 주요 지표 상세. 고깃집은 직접 경쟁(고깃집)과 넓은 경쟁(한식 소분류, 주변 음식점)을 나눠 보이고,
// 카페는 카페 구성(지표 엑셀)과 서울 비교, 브랜드를 보인다. 시안: docs/design-handoff/mockups/Dong.dc.html, CafeComp.dc.html
// 문장은 숫자만 말한다(현장 조사나 추측을 쓰지 않는다).
import { useState } from "react";
import { cafeDensity, cafeRowOf, cafeSeoul, cuts, shopMeta, shopsOf, type DongProfile } from "./area";

const n0 = (v: number) => v.toLocaleString("ko-KR");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const label = (s: string) => s.replace(/\//g, "·").replace(/류$/, "");
// 두 비율을 같은 자릿수로: 정수로 반올림해서 같아 보이면 소수 한 자리까지
const two = (a: number, b: number): [string, string] => (Math.round(a * 100) === Math.round(b * 100) ? [pct1(a), pct1(b)] : [pct(a), pct(b)]);
const quarter = (q: string) => `${q.slice(0, 4)}년 ${q.slice(4)}분기`;
const PORK = "돼지고기 구이/찜";
// 고기 구이 계열: 고깃집과 저녁 '고기 한 끼'를 두고 겹치는 소분류
const GRILL = ["소고기 구이/찜", "곱창 전골/구이", "닭/오리고기 구이/찜"];

function Cell({ k, v, sub }: { k: string; v: string; sub: string }) {
  return <div className="c-cell"><span>{k}</span><strong>{v}</strong><small>{sub}</small></div>;
}
function Bars({ rows, max }: { rows: { label: string; n: number; hi?: boolean; strong?: boolean }[]; max: number }) {
  return (
    <div className="c-bars">
      {rows.map((r) => (
        <div className={`c-bar${r.hi ? " is-hi" : ""}${r.strong ? " is-strong" : ""}`} key={r.label}>
          <span>{r.label}</span>
          <i><b style={{ inlineSize: `${(r.n / Math.max(1, max)) * 100}%` }} /></i>
          <strong>{n0(r.n)}</strong>
        </div>
      ))}
    </div>
  );
}
const Head = ({ title, scope }: { title: string; scope: string }) => (
  <div className="c-head"><h3>{title}</h3><span className="a-scope">{scope}</span></div>
);

const CHIP_MAX = 24;
export function BbqComp({ p, count }: { p: DongProfile; count: number }) {
  const sh = shopsOf(p.code), meta = shopMeta(), c = cuts();
  const [all, setAll] = useState(false);
  const km = p.pork_km2;
  const dense = km != null && c ? `서울 동네 '약함' 기준선 ${c.pork_km2[0]}곳보다 ${km < c.pork_km2[0] ? "적어요" : km > c.pork_km2[1] ? `많고 '치열' 기준선 ${c.pork_km2[1]}곳도 넘어요` : "많아요"}` : "";
  const total = sh ? Object.values(sh.hansik).reduce((a, b) => a + b, 0) : 0;
  const pork = sh?.hansik[PORK] ?? 0;
  const rest = sh ? Object.entries(sh.hansik).filter(([k]) => k !== PORK) : [];
  const seoul = meta?.seoul_hansik_share ?? {};
  const hiGrill = rest.filter(([k, v]) => GRILL.includes(k) && total > 0 && v / total > (seoul[k] ?? 1));
  const grill = pork + rest.filter(([k]) => GRILL.includes(k)).reduce((a, [, v]) => a + v, 0);
  const mix = sh && meta ? meta.mix_labels.map((l) => ({ label: l.replace(/음식점$|전문점$|점$/, "").replace("호프-간이주", "호프·간이주점"), n: sh.mix[l] ?? 0, strong: l === "한식음식점" })) : [];
  const mixTotal = mix.reduce((a, m) => a + m.n, 0);
  const mixHansik = sh?.mix["한식음식점"];
  return (
    <div className="c-comp">
      <div className="c-cells">
        <Cell k="직접 경쟁 · 고깃집" v={`${n0(count)}곳`} sub="돼지고기 구이·찜 가게" />
        {km != null && <Cell k="빽빽한 정도" v={`1㎢당 ${km}곳`} sub={dense} />}
        {p.pop_per_pork != null && <Cell k="손님 나눠 갖기" v={`${n0(p.pop_per_pork)}명당 1곳`} sub="주민+직장인 ÷ 고깃집 수" />}
      </div>

      {sh && sh.pork.length > 0 && (
        <section className="c-sec">
          <Head title={`직접 경쟁하는 고깃집 ${sh.pork.length}곳`} scope="상가정보 2026.6 · 동 안" />
          <ul className="c-chips">{(all ? sh.pork : sh.pork.slice(0, CHIP_MAX)).map((n) => <li key={n}>{n}</li>)}</ul>
          {sh.pork.length > CHIP_MAX && <button type="button" className="m-link c-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? "접기" : `나머지 ${sh.pork.length - CHIP_MAX}곳 더 보기`}</button>}
          <small>상가정보에 '돼지고기 구이/찜'으로 등록된 곳이에요.</small>
        </section>
      )}

      {sh && total > 0 && (
        <section className="c-sec">
          <Head title={`한식음식점 ${n0(total)}곳 중 고깃집은 ${n0(pork)}곳`} scope="상가정보 2026.6 · 동 안" />
          <div className="c-share" role="img" aria-label={`한식음식점 ${total}곳 중 고깃집 ${pork}곳, ${pct(pork / total)}`}><b style={{ inlineSize: `${(pork / total) * 100}%` }} /></div>
          <small>고깃집 {pct(pork / total)} · 나머지 한식 {n0(total - pork)}곳 {pct(1 - pork / total)}</small>
          {rest.length > 0 && (
            <div className="c-box">
              <b>나머지 {n0(total - pork)}곳은 이런 한식집이에요</b>
              <Bars rows={rest.map(([k, v]) => ({ label: label(k), n: v, hi: hiGrill.some(([h]) => h === k) }))} max={Math.max(...rest.map(([, v]) => v))} />
              <p>
                <b className="c-hi">고기 구이로 넓게 보면 {n0(grill)}곳</b>이에요.
                {hiGrill.length > 0 && ` ${hiGrill.map(([k, v]) => `${label(k)} ${two(v / total, seoul[k] ?? 0)[0]}`).join(", ")} 비중이 서울 평균(${hiGrill.map(([k, v]) => two(v / total, seoul[k] ?? 0)[1]).join(", ")})보다 높아요.`}
              </p>
            </div>
          )}
        </section>
      )}

      {mixTotal > 0 && meta && (
        <section className="c-sec">
          <Head title={`주변 음식점 ${n0(mixTotal)}곳은 이렇게 나뉘어요`} scope={`서울시 상권분석 ${quarter(meta.mix_quarter)} · 동 안`} />
          <Bars rows={mix} max={Math.max(...mix.map((m) => m.n))} />
          {mixHansik != null && mixHansik !== total && <small>한식 {n0(mixHansik)}곳은 서울시 상권분석 기준이라 상가정보 기준 {n0(total)}곳과 조금 달라요.</small>}
        </section>
      )}
      {!sh && <small>이 동네는 가게 목록 자료가 없어요 (행정동 코드가 바뀐 동).</small>}
    </div>
  );
}

export function CafeComp({ p, gu }: { p: DongProfile; gu: string }) {
  const r = cafeRowOf(p.code), sh = shopsOf(p.code);
  if (!r) return <small>이 동네는 카페 구성 자료가 없어요.</small>;
  const s = cafeSeoul(gu);
  const open = Math.round(r.open_y * r.cf_stores), close = Math.round(r.close_y * r.cf_stores);
  const parts = [
    { k: "저가 프랜차이즈", n: r.lowcost, cls: "is-low" },
    { k: "그 외 프랜차이즈", n: r.franchise - r.lowcost, cls: "is-fr" },
    { k: "개인 커피전문점", n: r.indie_coffee, cls: "is-indie" },
    { k: "개인 디저트·음료", n: r.indie_dessert, cls: "is-dessert" },
    { k: "무인카페", n: r.unmanned, cls: "is-none" },
  ];
  const lowShare = r.cafes ? r.lowcost / r.cafes : 0;
  // "서울 25%와 비슷해요" / "서울 14%보다 높아요"
  const cmp = (v: number, base: number, more: string, less: string, tol = 0.03) => Math.abs(v - base) < tol ? "와 비슷해요" : `보다 ${v > base ? more : less}`;
  const brands = sh?.cafe_brands ?? [];
  const chip = (b: (typeof brands)[number]) => `${b.b}${b.n > 1 ? ` ${b.n}` : ""}${b.branches.length ? ` · ${b.branches.join(", ")}` : ""}`;
  return (
    <div className="c-comp">
      <div className="c-cells">
        <Cell k="직접 경쟁 · 카페" v={`${n0(r.cafes)}곳`} sub="상가정보 2026년 6월" />
        <Cell k="빽빽한 정도" v={`1㎢당 ${(Math.round(cafeDensity(r) * 10) / 10).toFixed(1)}곳`} sub={`서울 동네 중간값 ${Math.round(s.density)}곳 · 한산한 쪽에서 ${pct(s.densityRank(cafeDensity(r)))}`} />
        <Cell k="최근 1년 흐름" v={`+${open} / −${close}`} sub={`커피·음료 ${r.cf_stores}곳 중 문 연 곳 ${open} · 닫은 곳 ${close}`} />
      </div>

      <section className="c-sec">
        <Head title={`${n0(r.cafes)}곳은 이렇게 나뉘어요`} scope="상가정보 2026.6 · 동 안" />
        <div className="c-stack" role="img" aria-label={parts.filter((x) => x.n > 0).map((x) => `${x.k} ${x.n}곳`).join(", ")}>
          {parts.filter((x) => x.n > 0).map((x) => <b key={x.k} className={x.cls} style={{ inlineSize: `${(x.n / r.cafes) * 100}%` }} />)}
        </div>
        <ul className="c-legend">{parts.map((x) => <li key={x.k}><i className={x.cls} />{x.k} <b>{n0(x.n)}곳</b></li>)}</ul>
      </section>

      <section className="c-sec">
        <h3>서울과 비교하면</h3>
        <div className="c-rows">
          <div className="a-drow"><div><b>프랜차이즈 비중</b><small>서울 동네 중간값 {pct(s.franchise)}{s.franchiseGu != null ? ` · ${gu} ${pct(s.franchiseGu)}` : ""}{cmp(r.franchise_share, s.franchise, "높아요", "낮아요")}</small></div><strong>{pct(r.franchise_share)}</strong></div>
          <div className="a-drow"><div><b>저가 프랜차이즈 비중</b><small>서울 전체 {pct(s.lowcost)}{cmp(lowShare, s.lowcost, "높아요", "낮아요", 0.02)}</small></div><strong>{pct(lowShare)}</strong></div>
          <div className="a-drow"><div><b>1년 폐업률</b><small>서울 동네 중간값 {pct1(s.close)}{cmp(r.close_y, s.close, "높아요", "낮아요", 0.005)} · 문 연 비율은 {pct1(r.open_y)}</small></div><strong>{pct1(r.close_y)}</strong></div>
          <div className="a-drow"><div><b>카페 1곳당 주민</b><small>직장인은 카페 1곳당 {n0(Math.round(r.work_per_cafe))}명 · 지하철역 {r.subway ? `${r.subway}곳` : "없음"}, 역 500m 안 카페 {pct(Math.min(1, r.near_station_share))}</small></div><strong>{n0(Math.round(r.resident_per_cafe))}명</strong></div>
          {sh && sh.cafe_floor.known > 0 && <div className="a-drow"><div><b>1층 카페</b><small>층 정보가 있는 {sh.cafe_floor.known}곳 중 {sh.cafe_floor.f1}곳</small></div><strong>{pct(sh.cafe_floor.f1 / sh.cafe_floor.known)}</strong></div>}
        </div>
      </section>

      {brands.length > 0 && (
        <section className="c-sec c-box">
          <h3>어떤 브랜드가 있나요</h3>
          {[["저가 커피", brands.filter((b) => b.low), "is-low"], ["그 외 프랜차이즈", brands.filter((b) => !b.low), ""]].map(([t, bs, cls]) => (bs as typeof brands).length > 0 && (
            <div key={t as string} className="c-brands">
              <b className={cls as string}>{t as string}</b>
              <ul className={`c-chips ${cls}`}>{(bs as typeof brands).map((b) => <li key={b.b}>{chip(b)}</li>)}</ul>
            </div>
          ))}
          <small>상가정보 2026년 6월 상호명으로 찾은 브랜드예요. 같은 지점이 두 번 등록된 곳은 한 번만 셌어요. 위 구성 숫자(카페 팀 지표 엑셀 분류)와 조금 다를 수 있어요.</small>
        </section>
      )}
      <small>카페 수·구성은 소상공인시장진흥공단 상가정보(2026년 6월), 개업·폐업은 서울시 상권분석서비스 커피-음료 {r.cf_stores}곳 기준(최근 4분기). 서울 비교는 카페 10곳 이상인 동 {s.n}곳 기준이에요.</small>
    </div>
  );
}
