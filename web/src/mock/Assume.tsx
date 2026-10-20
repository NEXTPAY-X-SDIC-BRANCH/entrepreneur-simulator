// 출처 없는 가정값 옆에 붙이는 작은 표시. 마우스를 올리면 무엇이 가정인지 보여 준다.
// 값 목록은 바탕화면 simulator-assumptions.xlsx (scratchpad assumptions_xlsx.py로 만듦)와 research/*.yaml의 '가정' 태그.
export default function Assume({ what }: { what: string }) {
  const tip = `출처 없는 가정이에요: ${what}. 추정치 목록에서 출처 있는 값으로 바꿀 수 있어요.`;
  return <span className="m-assume" title={tip} aria-label={tip}>가정</span>;
}
