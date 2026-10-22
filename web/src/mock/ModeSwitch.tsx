// 운영 계획 화면 오른쪽 위의 모드 스위치. 왼쪽이 easy, 오른쪽이 hard. 손잡이를 오른쪽으로 밀면 hard 모드.
// 눌러도 바뀌고, 끌어서 밀어도 바뀐다. 시작 화면에서 고른 모드를 달마다 바꿀 수 있다.
import { useRef } from "react";

export type Mode = "easy" | "hard";
export default function ModeSwitch({ mode, set }: { mode: Mode; set: (m: Mode) => void }) {
  const x0 = useRef<number | null>(null), dragged = useRef(false);
  const hard = mode === "hard";
  return (
    <span className="sx-modesw">
      <span className={`sx-modesw-l${hard ? "" : " on"}`} aria-hidden>easy 모드</span>
      <button type="button" role="switch" aria-checked={hard} aria-label="hard 모드"
        className={`sx-modesw-t${hard ? " is-hard" : ""}`}
        onPointerDown={(e) => { x0.current = e.clientX; dragged.current = false; }}
        onPointerUp={(e) => {
          if (x0.current == null) return;
          const dx = e.clientX - x0.current; x0.current = null;
          if (Math.abs(dx) > 8) { dragged.current = true; set(dx > 0 ? "hard" : "easy"); }
        }}
        onClick={() => { if (dragged.current) { dragged.current = false; return; } set(hard ? "easy" : "hard"); }}>
        <span className="sx-modesw-k" />
      </button>
      <span className={`sx-modesw-l${hard ? " on" : ""}`} aria-hidden>hard 모드</span>
    </span>
  );
}
