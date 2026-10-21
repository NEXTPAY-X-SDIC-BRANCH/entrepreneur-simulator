// 메뉴판 고치기 (lab:menu). 운영 계획 팝업 안에서 여는 화면: 메뉴 표(이름, 판매가, 원가, 주문 비중, 원가 출처·기준일)와
// 고른 줄의 원가 전표. 원가는 엔진 서버가 오늘 식자재 시세(ingredients_today.json)로 계산한다 (sim/menu.py).
import { useEffect, useRef, useState, type WheelEvent } from "react";
import { fetchTemplate, recompute, type CostDetail, type Industry, type Kind, type MenuDoc, type MenuItem, type Source } from "./api";
import "./menu.css";

const ORDER: Record<Industry, Kind[]> = { bbq: ["main", "side", "drink"], cafe: ["drink", "side"] };
const NEW_PRICE: Record<Industry, Record<Kind, number>> = {
  bbq: { main: 19000, side: 5000, drink: 5000 }, cafe: { main: 6000, side: 5000, drink: 4500 },
};
const SRC_SHORT: Record<string, string> = {
  kape_wholesale: "KAPE 도매", seoul_necessities: "서울시 시장가", kamis: "KAMIS 소매", kmta_import: "육류협회 도매", assumed: "가정",
};
// 숫자 칸 위에서 휠을 굴리면 값이 바뀌지 않고 화면만 내려가게 (Chrome은 포커스된 number 칸의 값을 휠로 바꾼다)
const noWheel = (e: WheelEvent<HTMLInputElement>) => e.currentTarget.blur();
const fmt = (n: number) => Math.round(n).toLocaleString("ko-KR");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const shortDate = (d: string | null) => (!d ? "" : d.length === 7 ? `${+d.slice(5)}월` : `${+d.slice(5, 7)}/${+d.slice(8)}`);

// 원가 출처 꼬리표: 금액이 가장 큰 재료의 출처와 기준일. 전체 출처는 툴팁에
function costTag(cs: string | undefined, c: CostDetail | undefined, sources: Source[]) {
  if (cs === "user") return { text: "직접 입력", title: "직접 고친 원가예요 (가정)", assumed: true };
  if (!c || !c.lines.length) return { text: "가정", title: "원가 자료가 없어요 (가정)", assumed: true };
  if (cs === "가정") return { text: "가정 많음", title: `재료비의 ${pct(c.assumed_share)}가 공개 자료 없는 가정 값이에요`, assumed: true };
  const top = [...c.lines].sort((a, b) => b.amount - a.amount)[0];
  const full = c.lines.map((l) => `${l.name}: ${sources.find((s) => s.id === l.source)?.publisher ?? l.source}${l.date ? `, ${l.date}` : " (가정)"}`).join("\n");
  return { text: `${SRC_SHORT[top.source] ?? top.source} · ${shortDate(top.date)}`, title: full, assumed: false };
}

const STATUS: Record<string, string> = {
  ok: "오늘 받음", cached: "저장된 값", snapshot: "저장 자료", not_connected: "유통업체 제휴 시 연결", missing: "없음",
};

type Props = {
  api: string; industry: Industry; grade: string; district?: string; doc: MenuDoc;
  onSave: (d: MenuDoc) => void; onCancel: () => void; note?: string;
};

export default function MenuEditor({ api, industry, grade, district, doc, onSave, onCancel, note }: Props) {
  const [draft, setDraft] = useState<MenuDoc>(doc);
  const [sel, setSel] = useState<string>(doc.items[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 고칠 때마다 서버에서 요약(예상 지출, 원가율, 가격 수준)을 다시 받는다. 늦게 온 응답은 버린다
  const sync = (next: MenuDoc, force = false, wait = 350) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    const n = ++seq.current;
    timer.current = window.setTimeout(async () => {
      if (force) setBusy(true);
      try {
        const d = await recompute(api, industry, grade, next.items, { district, force, table: next.table_setting });
        if (n === seq.current) { setDraft(d); setErr(""); }
      } catch (e) {
        if (n === seq.current) setErr(String((e as Error).message ?? e));
      }
      if (force) setBusy(false);
    }, wait);
  };

  const edit = (id: string, patch: Partial<MenuItem>) =>
    sync({ ...draft, items: draft.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const remove = (id: string) => {
    const items = draft.items.filter((x) => x.id !== id);
    if (sel === id) setSel(items[0]?.id ?? "");
    sync({ ...draft, items });
  };
  const add = (kind: Kind) => {
    let i = 1;
    while (draft.items.some((x) => x.id === `my${i}`)) i++;
    const price = NEW_PRICE[industry][kind];
    const item: MenuItem = { id: `my${i}`, name: "새 메뉴", kind, price, unit_cost: Math.round(price * 0.35 / 10) * 10, mix: 10, cost_source: "user" };
    setSel(item.id);
    sync({ ...draft, items: [...draft.items, item] }, false, 0);
  };
  const reset = async () => {
    setBusy(true);
    try { const d = await fetchTemplate(api, industry, grade, district); setDraft(d); setSel(d.items[0]?.id ?? ""); setErr(""); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  const pc = draft.per_cover;
  const bench = draft.benchmark;
  const selItem = draft.items.find((x) => x.id === sel);
  const table = draft.table_setting;
  const detail: { title: string; unit: string; c?: CostDetail; cost: number; user: boolean } | null =
    sel === "_table" && table ? { title: table.label, unit: "손님 1명", c: table.cost_detail, cost: table.cost, user: table.cost_source === "user" }
      : selItem ? { title: `${selItem.name}${selItem.portion ? ` (${selItem.portion})` : ""}`, unit: draft.kinds[selItem.kind]?.unit ?? "1개", c: selItem.cost_detail, cost: selItem.unit_cost, user: selItem.cost_source === "user" }
        : null;
  const kindLabel = (k: Kind) => draft.kinds[k]?.label ?? k;

  return (
    <>
      <div className="sx-scroll mn">
        <h1>메뉴판 고치기</h1>
        <div className="mn-sum" aria-live="polite">
          <div><small>{industry === "cafe" ? "결제 1건 예상 금액" : "손님 1명 예상 지출"}</small><b>{fmt(pc.ticket)}원</b></div>
          <div title={bench?.source ?? ""}>
            <small>{industry === "bbq" ? "재료 원가율 (상차림 포함)" : "재료 원가율"}</small>
            <b>{pct(pc.cost_ratio)}</b>
            {bench && <span className={`mn-bench${Math.abs(pc.cost_ratio - bench.cost_ratio) > 0.03 ? " low" : ""}`}>업종 평균 {pct(bench.cost_ratio)}</span>}
          </div>
          <div><small>가격 수준 (기본 메뉴 = 100)</small>
            <b className="mn-levels">{ORDER[industry].filter((k) => draft.levels[k]).map((k) => (
              <span key={k}>{kindLabel(k)} {Math.round(draft.levels[k].level * 100)}</span>
            ))}</b>
          </div>
          <div><small>식자재 시세 기준일</small><b>{draft.snapshot.basis_date ?? "자료 없음"}</b></div>
        </div>
        {bench && pc.cost_ratio < bench.cost_ratio - 0.03 && (
          <p className="mn-gap">이 메뉴판의 원가율 {pct(pc.cost_ratio)}는 {bench.label} {pct(bench.cost_ratio)}보다 낮아요. 실제 가게에는 폐기, 서비스로 나가는 음식, 메뉴에 없는 양념이 더 들어가요.</p>
        )}
        {bench && pc.cost_ratio > bench.cost_ratio + 0.05 && (
          <p className="mn-gap">이 메뉴판의 원가율 {pct(pc.cost_ratio)}는 {bench.label} {pct(bench.cost_ratio)}보다 높아요. 판매가가 낮으면 같은 재료비가 매출에서 차지하는 몫이 커져요. 가격이나 메뉴 구성을 바꿔 보세요.</p>
        )}

        <div className="mn-grid">
          <table className="mn-table">
            <caption className="mn-cap">판매가와 주문 비중은 내가 정하는 값이에요 (기본값은 가정). 원가는 오늘 시세로 계산하고, 직접 고칠 수도 있어요.</caption>
            <colgroup><col className="c-name" /><col className="c-num" /><col className="c-num" /><col className="c-pct" /><col className="c-mix" /><col className="c-src" /><col className="c-x" /></colgroup>
            <thead><tr><th scope="col">메뉴</th><th scope="col">판매가 (원)</th><th scope="col">원가 (원)</th><th scope="col">원가율</th><th scope="col">주문 비중</th><th scope="col">원가 출처</th><th scope="col"><span className="mn-sr">빼기</span></th></tr></thead>
            {ORDER[industry].map((k) => {
              const rows = draft.items.filter((x) => x.kind === k);
              const mixSum = rows.reduce((s, x) => s + x.mix, 0);
              return (
                <tbody key={k}>
                  <tr className="mn-grp"><th colSpan={7} scope="rowgroup">{kindLabel(k)}<small>{draft.kinds[k]?.per_cover}</small></th></tr>
                  {rows.map((x) => {
                    const tag = costTag(x.cost_source, x.cost_detail, draft.snapshot.sources);
                    return (
                      <tr key={x.id} className={x.id === sel ? "on" : undefined} onClick={() => setSel(x.id)}>
                        <td><input aria-label="메뉴 이름" className="mn-name" value={x.name} maxLength={24} onFocus={() => setSel(x.id)} onChange={(e) => edit(x.id, { name: e.target.value })} /></td>
                        <td><input aria-label={`${x.name} 판매가`} type="number" onWheel={noWheel} min={100} step={100} value={x.price} onFocus={() => setSel(x.id)} onChange={(e) => edit(x.id, { price: +e.target.value })} /></td>
                        <td><input aria-label={`${x.name} 원가`} type="number" onWheel={noWheel} min={0} step={10} value={x.unit_cost} onFocus={() => setSel(x.id)} onChange={(e) => edit(x.id, { unit_cost: +e.target.value, cost_source: "user" })} /></td>
                        <td className="mn-n">{x.price > 0 ? pct(x.unit_cost / x.price) : "-"}</td>
                        <td><span className="mn-mix"><input aria-label={`${x.name} 주문 비중`} type="number" onWheel={noWheel} min={0} max={1000} value={x.mix} onFocus={() => setSel(x.id)} onChange={(e) => edit(x.id, { mix: +e.target.value })} />
                          <small className="mn-share" title="같은 종류 안에서의 비율">{mixSum > 0 ? pct(x.mix / mixSum) : "0%"}</small></span></td>
                        <td><span className={`mn-tag${tag.assumed ? " as" : ""}`} title={tag.title}>{tag.text}</span></td>
                        <td><button type="button" className="mn-x" aria-label={`${x.name} 빼기`} title="메뉴에서 빼기" onClick={(e) => { e.stopPropagation(); remove(x.id); }}>빼기</button></td>
                      </tr>
                    );
                  })}
                  <tr className="mn-addrow"><td colSpan={7}><button type="button" className="mn-add" onClick={() => add(k)}>{kindLabel(k)} 메뉴 추가</button></td></tr>
                </tbody>
              );
            })}
            {table && (
              <tbody>
                <tr className="mn-grp"><th colSpan={7} scope="rowgroup">{table.label}<small>쌈채소·쌈장·김치·기본 반찬·숯. 반찬 {table.base_banchan}가지 기준이고, 운영 계획의 반찬 가짓수에 비례해요</small></th></tr>
                <tr className={sel === "_table" ? "on" : undefined} onClick={() => setSel("_table")}>
                  <td><span className="mn-fixed">메뉴판에 안 나오는 상차림</span></td>
                  <td className="mn-n">-</td>
                  <td><input aria-label="기본 상차림 원가" type="number" onWheel={noWheel} min={0} max={20000} step={10} value={table.cost} onFocus={() => setSel("_table")}
                    onChange={(e) => sync({ ...draft, table_setting: { ...table, cost: +e.target.value, cost_source: "user" } })} /></td>
                  <td className="mn-n">-</td><td className="mn-n">손님마다</td>
                  <td>{(() => { const t = costTag(table.cost_source, table.cost_detail, draft.snapshot.sources); return <span className={`mn-tag${t.assumed ? " as" : ""}`} title={t.title}>{t.text}</span>; })()}</td>
                  <td />
                </tr>
              </tbody>
            )}
          </table>

          <aside className="mn-side" aria-label="원가 내역">
            {detail && (
              <div className="mn-slip">
                <p className="mn-slip-h">{detail.title}<small>{detail.unit} 원가 내역</small></p>
                {detail.user && <p className="mn-slip-note">직접 고친 원가예요 (가정). 아래 재료 내역은 오늘 시세로 계산한 값이에요.</p>}
                {detail.c && detail.c.lines.length > 0 ? (
                  <ul>
                    {detail.c.lines.map((l) => (
                      <li key={l.ing}>
                        <span>{l.name} {l.qty}{l.unit}
                          <small>{l.stage === "가정" ? "가정" : `${draft.snapshot.sources.find((s) => s.id === l.source)?.publisher ?? l.source} · ${l.date}`} · {fmt(l.unit_price)}원/{l.unit}</small></span>
                        <b>{fmt(l.amount)}원</b>
                      </li>
                    ))}
                    {detail.c.aged_mult > 1 && <li><span>숙성 손실 x{detail.c.aged_mult}<small>가정</small></span><b>{fmt(detail.c.raw * (detail.c.aged_mult - 1))}원</b></li>}
                    {detail.c.overhead.value > 0 && (
                      <li title={detail.c.overhead.note}><span>{detail.c.overhead.label ?? detail.c.overhead.note} {pct(detail.c.overhead.value)}<small>{detail.c.overhead.tag}</small></span>
                        <b>{fmt(detail.c.unit_cost - detail.c.raw * detail.c.aged_mult)}원</b></li>
                    )}
                    <li className="mn-slip-sum"><span>오늘 시세 원가</span><b>{fmt(detail.c.unit_cost)}원</b></li>
                    {detail.user && <li className="mn-slip-sum"><span>쓰는 원가 (직접 입력)</span><b>{fmt(detail.cost)}원</b></li>}
                  </ul>
                ) : <p className="mn-slip-note">재료 내역이 없는 메뉴예요. 원가 {fmt(detail.cost)}원은 직접 넣은 값이에요 (가정).</p>}
              </div>
            )}
            <button type="button" className="sx-ghost mn-refresh" disabled={busy} onClick={() => sync(draft, true, 0)}>
              {busy ? "계산하는 중이에요" : "오늘 시세로 원가 다시 계산"}
            </button>
            <p className="mn-hint">직접 고친 원가도 재료 내역이 있으면 시세 값으로 돌아가요.</p>
            <details className="mn-src">
              <summary>시세 출처 {draft.snapshot.sources.length}곳</summary>
              <ul>
                {draft.snapshot.sources.map((s) => (
                  <li key={s.id}><b>{s.publisher}</b><span>{s.title}</span>
                    <small>{STATUS[s.status] ?? s.status}{s.basis_date ? ` · 기준 ${s.basis_date}` : ""}</small></li>
                ))}
              </ul>
              {draft.snapshot.caveat && <p className="mn-hint">{draft.snapshot.caveat}</p>}
            </details>
          </aside>
        </div>
        {err && <p className="se-err" role="alert">{err}</p>}
      </div>
      <footer className="sx-foot">
        <button type="button" className="se-btn" disabled={busy || !!err} onClick={() => onSave(draft)}>이 메뉴판으로 정하기</button>
        <button type="button" className="sx-ghost" disabled={busy} onClick={reset}>기본 메뉴로 되돌리기</button>
        <button type="button" className="se-link" onClick={onCancel}>고치지 않고 돌아가기</button>
        {note && <small>{note}</small>}
      </footer>
    </>
  );
}

// 운영 계획 안의 한 줄 요약 (삼겹살 가격 자리)
export function MenuSummary({ doc, onEdit, locked }: { doc: MenuDoc | null; onEdit: () => void; locked?: string }) {
  if (!doc) return <div className="mn-row"><span className="mn-row-l">메뉴판</span><small>메뉴 기본값을 불러오는 중이에요</small></div>;
  const pc = doc.per_cover;
  return (
    <div className="mn-row">
      <div className="mn-row-t">
        <span className="mn-row-l">메뉴판 {doc.items.length}개</span>
        <small>{doc.industry === "cafe" ? "결제 1건" : "손님 1명"} 약 {fmt(pc.ticket)}원 · 원가율 {pct(pc.cost_ratio)}{doc.benchmark ? ` (업종 평균 ${pct(doc.benchmark.cost_ratio)})` : ""} · 시세 {doc.snapshot.basis_date ?? "-"}</small>
        {locked && <small>{locked}</small>}
      </div>
      {!locked && <button type="button" className="sx-ghost" onClick={onEdit}>메뉴판 고치기</button>}
    </div>
  );
}
