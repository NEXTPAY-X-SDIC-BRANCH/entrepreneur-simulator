// 쉬운 모드의 '한 가지 더 정하기': 방향(추천대로/늘리기/아끼기)을 고른 뒤, 업종마다 중요한 몇 가지를 버튼 하나로 바꾼다.
// 고르지 않은 항목은 방향의 값을 그대로 쓴다. 자세히 모드는 이 값들을 숫자로 하나씩 정한다.
export type Pick<P> = { key: keyof P & string; label: string; hint: string; opts: { label: string; value: number | string }[] };

export default function QuickPicks<P extends Record<string, unknown>>({ picks, base, tweak, setTweak }: {
  picks: Pick<P>[]; base: P; tweak: Partial<P>; setTweak: (t: Partial<P>) => void;
}) {
  return (
    <section className="qp" aria-label="한 가지 더 정하기">
      <h3>한 가지 더 정하기 <small>안 고르면 위 방향대로 해요</small></h3>
      {picks.map((p) => {
        const cur = (tweak[p.key] ?? base[p.key]) as number | string;
        return (
          <div key={p.key} className="qp-row" role="radiogroup" aria-label={p.label}>
            <div className="qp-l"><b>{p.label}</b><small>{p.hint}</small></div>
            <div className="qp-opts">
              {p.opts.map((o) => (
                <button type="button" key={String(o.value)} role="radio" aria-checked={cur === o.value} className={cur === o.value ? "on" : ""}
                  onClick={() => setTweak({ ...tweak, [p.key]: o.value })}>{o.label}</button>
              ))}
            </div>
          </div>
        );
      })}
      {Object.keys(tweak).length > 0 && <button type="button" className="qp-reset" onClick={() => setTweak({})}>방향대로 되돌리기</button>}
    </section>
  );
}
