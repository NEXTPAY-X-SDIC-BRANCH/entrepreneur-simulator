// 운영 계획 화면 오른쪽 위의 모드 스위치. 왼쪽이 easy, 오른쪽이 hard. 손잡이를 오른쪽으로 밀면 hard 모드.
// 눌러도 바뀌고, 끌어서 밀어도 바뀐다. 시작 화면에서 고른 모드를 달마다 바꿀 수 있다.
import { useRef } from "react";

export type Mode = "easy" | "hard";
// locked: 시즌을 시작한 뒤에는 바꿀 수 없다 (같은 모드끼리 점수를 비교하려고). 바꾸려면 처음부터 다시 시작한다
export default function ModeSwitch({ mode, set, locked }: { mode: Mode; set: (m: Mode) => void; locked?: boolean }) {
  const x0 = useRef<number | null>(null), dragged = useRef(false);
  const hard = mode === "hard";
  if (locked) return <span className="sx-modelock" title="시즌 중에는 모드를 바꿀 수 없어요. 처음부터 다시 하면 바꿀 수 있어요."><b>{hard ? "hard 모드" : "easy 모드"}</b> · 이번 시즌 고정</span>;
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
