// 출처 없는(또는 일부만 있는) 가정값 옆에 붙이는 표시. ▸를 누르면 챗봇 근거처럼 펼쳐져 무엇을, 왜, 어떤 식으로 가정했는지와
// 기댄 자료, 근거 있는 값으로 바꾸는 데 필요한 자료를 보여 준다. 내용은 assumptions.ts의 id로 부르거나, what 등을 직접 넘긴다.
import { useEffect, useId, useRef, useState } from "react";
import { ASSUME, type AssumeInfo } from "./assumptions";

type Props = { id?: keyof typeof ASSUME | string; what?: string } & Partial<Omit<AssumeInfo, "what">>;

export default function Assume({ id, what, why, f, src, need }: Props) {
  const base = id ? ASSUME[id] : undefined;
  const info: AssumeInfo = {
    what: what ?? base?.what ?? "가정값",
    why: why ?? base?.why ?? "",
    f: f ?? base?.f, src: src ?? base?.src,
    need: need ?? base?.need ?? "출처 있는 조사값이나 가게 장부로 확인이 필요해요",
  };
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const pid = useId();
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span className="m-assume-w" ref={ref}>
      <button type="button" className={`m-assume${open ? " on" : ""}`} aria-expanded={open} aria-controls={pid}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }} title="가정값 근거 보기">
        <span className="m-assume-tri" aria-hidden>{open ? "▾" : "▸"}</span>가정 근거
      </button>
      {open && (
        <span className="m-assume-pop" id={pid} role="note">
          <b className="m-assume-h">{info.what}</b>
          <span className="m-assume-r"><i>쓴 자료</i>{info.src ?? "출처 있는 자료가 없어 정한 가정값이에요"}</span>
          {info.f && <span className="m-assume-r"><i>계산식</i><code>{info.f}</code></span>}
          {info.why && <span className="m-assume-r"><i>왜</i>{info.why}</span>}
          <span className="m-assume-r need"><i>바꾸려면</i>{info.need}</span>
        </span>
      )}
    </span>
  );
}
