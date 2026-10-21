// lab:score — 개발용 미리보기 (vite dev 에서 /src/lab/score/preview.html). 빌드에는 들어가지 않는다.
// ?fx=0..3 (fixtures.json: 실제 엔진 6개월 결과). 시안 B, C는 notes 폴더 cu-score-options 스크린샷으로만 남겼다.
import { createRoot } from "react-dom/client";
import "../../styles/base.css";
import "../../mock/mock.css";
import "../../mock/simulate-engine.css";
import ScoreCard from "./ScoreCard";
import type { SeasonSummary } from "../types";
import fixtures from "./fixtures.json";

const q = new URLSearchParams(location.search);
const fx = (fixtures as unknown as SeasonSummary[])[Number(q.get("fx") ?? 0)];

createRoot(document.getElementById("root")!).render(
  <div className="m-app" style={{ background: "#e9eef6", minBlockSize: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
    <div className="sx-pop" style={{ maxBlockSize: "none" }}>
      <div className="sx-scroll">
        <ScoreCard summary={fx} />
        <h1>6개월 결과</h1>
        <p className="sx-note">(아래는 기존 결과 화면: 현금 그래프, 월별 현금, 정산표)</p>
      </div>
    </div>
  </div>,
);
