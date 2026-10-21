// lab:modes — 첫 질문: 이지 / 하드 (옵션 A, cu-modes-options/pick-a.png). 프로필 질문과 같은 카드 모양.
import { useState } from "react";
import "./modes.css";

export type Mode = "easy" | "hard";

export default function ModePick({ initial, onPick }: { initial: Mode | null; onPick: (m: Mode) => void }) {
  const [m, setM] = useState<Mode>(initial ?? "easy");
  return (
    <main className="m-profile">
      <form className="m-q" onSubmit={(e) => { e.preventDefault(); onPick(m); }}>
        <fieldset>
          <legend>어떻게 연습해 볼까요?</legend>
          <p className="m-help">처음이면 이지로 한 판 돌려 보고, 망한 이유를 본 뒤 하드로 넘어가도 돼요. 언제든 바꿀 수 있어요.</p>
          <div className="m-choices m-choices-big">
            <label className="m-choice">
              <input type="radio" name="mode" checked={m === "easy"} onChange={() => setM("easy")} />
              <span>이지 모드<small>업종, 동네, 가진 돈만 정하면 나머지(평수, 테이블, 직원, 가격, 월세)는 서울 상권 자료로 채워서 6개월을 한 번에 돌려요. 결과를 보고 고쳐서 다시 해 봐요.</small></span>
            </label>
            <label className="m-choice">
              <input type="radio" name="mode" checked={m === "hard"} onChange={() => setM("hard")} />
              <span>하드 모드<small>동네 분석, 가게 배치, 매달 운영 계획과 사건 대응까지 직접 정해요. 손님 수, 고깃값, 월세가 바뀌면 결과가 얼마나 흔들리는지 민감도로 따져 봐요.</small></span>
            </label>
          </div>
        </fieldset>
        <div className="m-actions"><button type="submit" className="m-btn">다음</button></div>
      </form>
    </main>
  );
}
