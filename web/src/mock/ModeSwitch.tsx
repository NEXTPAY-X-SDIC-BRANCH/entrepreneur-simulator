// 운영 계획 화면 머리에 붙는 모드 전환. 시작 화면에서 고른 모드를 계획 화면에서도 보이게 하고, 달마다 바꿀 수 있게 한다.
export type Mode = "easy" | "hard";
export default function ModeSwitch({ mode, set }: { mode: Mode; set: (m: Mode) => void }) {
  return (
    <div className="sx-modesw" role="radiogroup" aria-label="모드">
      <button type="button" role="radio" aria-checked={mode === "easy"} className={mode === "easy" ? "on" : ""} onClick={() => set("easy")}>쉬운 모드</button>
      <button type="button" role="radio" aria-checked={mode === "hard"} className={mode === "hard" ? "on" : ""} onClick={() => set("hard")}>자세히 모드</button>
    </div>
  );
}
