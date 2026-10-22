// easy 모드 운영 계획: hard 모드의 선택지 중 업종마다 꼭 정해야 하는 몇 가지만, hard 모드와 같은 −/+ 칸으로 고른다.
// 값은 opts 목록 안에서 한 칸씩 움직인다. 고르지 않은 항목은 지난달 계획 그대로다. hard 모드는 이 값들과 나머지를 숫자로 하나씩 정한다.
export type Pick<P> = { key: keyof P & string; label: string; hint: string; opts: { label: string; value: number | string | boolean }[] };

export default function QuickPicks<P extends Record<string, unknown>>({ picks, base, tweak, setTweak, prev }: {
  picks: Pick<P>[]; base: P; tweak: Partial<P>; setTweak: (t: Partial<P>) => void; prev?: P;
}) {
  const idxOf = (p: Pick<P>, v: unknown) => {
    const i = p.opts.findIndex((o) => o.value === v);
    if (i >= 0 || typeof v !== "number") return Math.max(0, i);
    // 목록에 없는 숫자(hard 모드에서 정한 값)는 가장 가까운 칸으로
    let best = 0;
    p.opts.forEach((o, k) => { if (typeof o.value === "number" && Math.abs(o.value - v) < Math.abs((p.opts[best].value as number) - v)) best = k; });
    return best;
  };
  return (
    <div className="sx-steps">
      {picks.map((p) => {
        const cur = (tweak[p.key] ?? base[p.key]) as number | string | boolean;
        // 아직 정하지 않은 값(undefined)은 첫 칸(기본값)으로 본다
        const i = cur === undefined ? 0 : idxOf(p, cur), exact = cur === undefined || p.opts[i]?.value === cur;
        const before = prev ? (prev[p.key] as number | string | boolean) : undefined;
        const changed = prev !== undefined && (before ?? p.opts[0].value) !== (cur ?? p.opts[0].value);
        const move = (d: number) => setTweak({ ...tweak, [p.key]: p.opts[Math.min(p.opts.length - 1, Math.max(0, exact ? i + d : i))].value });
        return (
          <div key={p.key} className={`sx-step${changed ? " is-changed" : ""}`}>
            <div className="sx-step-t">
              <span className="sx-step-l">{p.label}</span>
              <small>{p.hint}</small>
              {changed && <small className="sx-step-prev">지난달 {before === undefined ? p.opts[0].label : p.opts[idxOf(p, before)]?.label}</small>}
            </div>
            <div className="sx-step-c">
              <button type="button" aria-label={`${p.label} 낮추기`} disabled={exact && i <= 0} onClick={() => move(-1)}>−</button>
              <output>{exact ? p.opts[i].label : `${p.opts[i].label} 근처`}</output>
              <button type="button" aria-label={`${p.label} 높이기`} disabled={exact && i >= p.opts.length - 1} onClick={() => move(1)}>+</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
