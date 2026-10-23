// lab:peek 시뮬레이션 팝업(운영 계획·사건·정산·결과)을 잠깐 내려 두고 가게 화면(3D, 현금 그래프, 영수증)을 보는 상태.
// 네 시뮬레이션 화면(고깃집 SimulateEngine, 카페 CafeSim, 옷가게 ApparelSim, 새 업종 IndustrySim)이 같이 쓴다.
// 팝업은 숨기기만 해서(hidden) 스크롤 위치와 고른 값이 그대로 남는다. 다음 화면으로 넘어가면 다시 보인다.
import { useEffect, useState } from "react";

export const PEEK_BACK: Record<string, string> = {
  intro: "시작 안내로 돌아가기", plan: "운영 계획으로 돌아가기", menu: "메뉴판으로 돌아가기",
  scenario: "이달의 사건으로 돌아가기", settle: "정산 다시 보기", report: "6개월 결과 다시 보기",
};

export function useSimChrome(view: string | null) {
  const [peek, setPeek] = useState(false);
  const [planOpen, setPlanOpen] = useState(true); // 왼쪽 'N월 운영 계획' 판 접기
  useEffect(() => setPeek(false), [view]);
  return { peek, setPeek, planOpen, setPlanOpen };
}
