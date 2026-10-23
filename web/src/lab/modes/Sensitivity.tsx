// lab:modes — 하드 모드 민감도: 학습자가 정한 ± 범위로 같은 계획을 여러 번 돌려 6개월 뒤 현금이 얼마나 흔들리는지 본다.
// 계산은 /lab/sensitivity (sim/easy.py). 범위는 학습자가 정한 가정이고, 각 칸은 같은 시드(같은 사건 순서)로 돌린 엔진 결과다.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { netErr, sensitivity, type Cell, type Sens } from "./api";
import { manWon, signedMan } from "./Compare";
import "./modes.css";

const KEYS = { bbq: ["customers", "meat", "rent", "labor"], other: ["customers", "food", "rent", "labor"] } as const; // other = 카페, 새 업종
const LABEL: Record<string, string> = { customers: "손님 수", meat: "고깃값", food: "재료비 (원두, 우유, 디저트)", rent: "월세", labor: "인건비" };
const LABEL_BBQ: Record<string, string> = { labor: "알바 시급" }; // 고깃집 엔진은 알바 시급만 바꾼다 (사장님 몫은 그대로)
const HINT: Record<string, string> = {
  customers: "동네 손님이 생각보다 적거나 많을 때",
  meat: "돼지고기 도매가가 오르내릴 때 (질병, 계절)",
  food: "식재료값이 오르내릴 때",
  rent: "재계약 때 월세가 바뀔 때",
  labor: "시급이 오르거나 사람을 구하기 어려울 때",
};
const DEFAULT: Record<string, number> = { customers: 15, meat: 20, food: 20, rent: 10, labor: 10 };

const cellText = (c: Cell) => (c.closed ? `${c.closed_month}개월째 폐업` : manWon(c.end_cash));
// lab:heat 격자를 히트맵으로: 6개월 뒤 현금이 많을수록 진한 파랑, 모자랄수록 진한 빨강. 진하기는 이 격자 안에서 가장 적은 값과
// 가장 많은 값 사이의 자리라서 칸끼리 차이가 보인다. 폐업은 짙은 칸
function heat(c: Cell, cells: Cell[]): CSSProperties | undefined {
  if (c.closed) return undefined;
  const v = c.end_cash, pos = cells.filter((x) => !x.closed && x.end_cash >= 0).map((x) => x.end_cash), neg = cells.filter((x) => !x.closed && x.end_cash < 0).map((x) => -x.end_cash);
  const at = (x: number, xs: number[]) => (xs.length < 2 || Math.max(...xs) === Math.min(...xs) ? 0.5 : (x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs)));
  return v < 0 ? { background: `rgba(200, 60, 60, ${(0.15 + 0.45 * at(-v, neg)).toFixed(2)})` } : { background: `rgba(37, 106, 191, ${(0.08 + 0.5 * at(v, pos)).toFixed(2)})` };
}

export default function Sensitivity({ industry, getBody, onClose, note }: {
  industry: string; note?: string; getBody: () => Promise<Record<string, unknown>>; onClose: () => void;
}) {
  const keys = KEYS[industry === "bbq" ? "bbq" : "other"];
  const lab = (k: string) => (industry === "bbq" && LABEL_BBQ[k]) || (industry !== "cafe" && k === "food" ? "재료비" : LABEL[k]);
  const [ranges, setRanges] = useState<Record<string, number>>(() => Object.fromEntries(keys.map((k) => [k, DEFAULT[k]])));
  const [out, setOut] = useState<Sens | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ms, setMs] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = async () => {
    setBusy(true); setErr("");
    const t0 = performance.now();
    try {
      const body = await getBody();
      setOut(await sensitivity(industry, body, ranges));
      setMs(performance.now() - t0);
    } catch (e) { setErr(netErr(e)); }
    setBusy(false);
  };

  const all = out ? [out.base, ...out.factors.flatMap((f) => [f.low, f.high])].map((c) => c.end_cash) : [];
  // 막대 축: 값들의 범위에 10% 여백. 0이 범위 안에 들어올 때만 0 선을 그린다
  const pad = all.length ? Math.max(1e5, (Math.max(...all) - Math.min(...all)) * 0.1) : 1;
  const lo = all.length ? Math.min(...all) - pad : 0, hi = all.length ? Math.max(...all) + pad : 1;
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const ySteps = out ? [-out.grid.y.pct, 0, out.grid.y.pct] : [];
  const xSteps = out ? [-out.grid.x.pct, 0, out.grid.x.pct] : [];
  const pct = (p: number) => (p === 0 ? "그대로" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`);

  return (
    <div className="lm-modal" role="dialog" aria-modal="true" aria-labelledby="lm-sens-h" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lm-sheet" ref={ref} tabIndex={-1}>
        <header className="lm-sheet-h">
          <h2 id="lm-sens-h">민감도: 이 계획은 얼마나 흔들리나요</h2>
          <button type="button" className="m-btn m-btn-quiet lm-close" onClick={onClose}>닫기</button>
        </header>
        <p className="lm-quiet">가게 꾸미기에서 정한 가게{industry === "bbq" ? "와 가격, 알바" : "와 직원"}로 기본 운영을 6개월 그대로 둔 계획을, 아래 값만 바꿔 여러 번 돌려요.
          매달 바꾼 운영 계획은 들어가지 않아요. 범위는 직접 정하는 가정이고, 사건 순서(시드)를 고정해서 칸끼리의 차이는 바꾼 값 때문이에요.{note ? ` ${note}` : ""}</p>
        <div className="lm-ranges">
          {keys.map((k) => (
            <div key={k} className="lm-range">
              <span className="lm-ctl-l">{lab(k)}<small>{industry === "cafe" && k === "food" ? "원두와 우유값이 오르내릴 때" : HINT[k]}</small></span>
              <div className="m-stepper">
                <output>±{ranges[k]}%</output>
                <button type="button" aria-label={`${lab(k)} 범위 줄이기`} disabled={ranges[k] <= 0} onClick={() => setRanges({ ...ranges, [k]: Math.max(0, ranges[k] - 5) })}>−</button>
                <button type="button" aria-label={`${lab(k)} 범위 늘리기`} disabled={ranges[k] >= 50} onClick={() => setRanges({ ...ranges, [k]: Math.min(50, ranges[k] + 5) })}>+</button>
              </div>
            </div>
          ))}
        </div>
        <div className="lm-actions">
          <button type="button" className="m-btn" disabled={busy} onClick={go}>{busy ? "여러 번 돌리는 중이에요" : out ? "이 범위로 다시 돌리기" : "민감도 돌려 보기"}</button>
          {industry === "bbq" && !out && <small>처음 보는 가게면 손님 흐름 계산에 15초쯤 걸려요</small>}
        </div>
        {err && <p className="lm-err" role="alert">{err}</p>}

        {out && (
          <>
            <section className="lm-sec">
              <h3>6개월 뒤 현금, 하나씩 바꿨을 때</h3>
              <p className="lm-quiet">가운데 선이 지금 계획 ({cellText(out.base)}). 막대가 길수록 그 값에 민감해요.</p>
              <ul className="lm-tornado">
                {out.factors.map((f) => {
                  const a = Math.min(f.low.end_cash, f.high.end_cash), b = Math.max(f.low.end_cash, f.high.end_cash);
                  const bad = f.good === "high" ? f.low : f.high, good = f.good === "high" ? f.high : f.low;
                  return (
                    <li key={f.key}>
                      <span className="lm-tor-l">{lab(f.key)} ±{f.pct}%</span>
                      <div className="lm-tor-bar" aria-hidden>
                        {lo < 0 && hi > 0 && <i className="lm-tor-zero" style={{ insetInlineStart: pos(0) }} />}
                        <i className="lm-tor-span" style={{ insetInlineStart: pos(a), inlineSize: `calc(${pos(b)} - ${pos(a)})` }} />
                        <i className="lm-tor-base" style={{ insetInlineStart: pos(out.base.end_cash) }} />
                      </div>
                      <span className="lm-tor-v">
                        나쁠 때 {cellText(bad)} <small>({signedMan(bad.end_cash - out.base.end_cash)})</small>,
                        좋을 때 {cellText(good)} <small>({signedMan(good.end_cash - out.base.end_cash)})</small>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="lm-sec">
              <h3>{out.grid.x.label} × {out.grid.y.label}, 같이 바뀌면</h3>
              <table className="lm-tbl lm-grid">
                <thead><tr><th scope="col">{out.grid.y.label} \ {out.grid.x.label}</th>{xSteps.map((p, i) => <th key={i} scope="col">{pct(p)}</th>)}</tr></thead>
                <tbody>
                  {out.grid.cells.map((row, r) => (
                    <tr key={r}><th scope="row">{pct(ySteps[r])}</th>
                      {row.map((c, i) => <td key={i} style={heat(c, out.grid.cells.flat())}
                        className={`${c.closed ? "is-closed" : c.end_cash < 0 || c.lowest_cash < 0 ? "is-neg" : ""}${r === 1 && i === 1 ? " is-base" : ""}`}>{cellText(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="lm-heatkey" aria-hidden="true"><i className="k-neg" />현금이 모자람<i className="k-pos" />현금이 남음 (진할수록 큼)<i className="k-closed" />폐업<i className="k-base" />지금 계획</p>
              <p className="lm-quiet">
                전부 나쁜 쪽이면 {cellText(out.worst)}{out.worst.lowest_cash < 0 && !out.worst.closed ? ", 중간에 현금이 마이너스로 내려가요" : ""}.
                전부 좋은 쪽이면 {cellText(out.best)}. 엔진을 {out.runs}번 돌렸어요 ({(ms / 1000).toFixed(1)}초).
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
