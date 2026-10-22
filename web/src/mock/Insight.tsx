// 달 정산의 '다음 달에 이렇게 바꿔 보세요' 카드 (다섯 업종 공통). tries는 업종마다 같은 조건으로 한 가지씩 바꿔 다시 계산한 결과
import { man } from "./model";

export type Try<P> = { title: string; why: string; patch: P; d: number };

export default function Insight<P>({ tries, onApply, last }: { tries: Try<P>[]; onApply: (patch: P) => void; last: boolean }) {
  const top = tries.slice(0, 3);
  return (
    <section className="ins" aria-labelledby="ins-h">
      <h2 id="ins-h">다음 달에 이렇게 바꿔 보세요</h2>
      <p className="ins-sub">이번 달과 같은 날씨·사건·손님 조건에서 한 가지만 바꿔 다시 계산했어요. 영업이익이 많이 느는 순서예요.</p>
      {top.length ? (
        <ol className="ins-list">
          {top.map((t, i) => (
            <li key={t.title} className="ins-card">
              <span className="ins-n" aria-hidden>{i + 1}</span>
              <div className="ins-b">
                <b>{t.title}</b>
                <small>{t.why}</small>
              </div>
              <strong className="ins-d">+{man(Math.round(t.d))}<small>/월</small></strong>
              {!last && <button type="button" className="ins-go" onClick={() => onApply(t.patch)}>다음 달에 적용</button>}
            </li>
          ))}
        </ol>
      ) : <p className="ins-none">한 가지만 바꿔서는 이번 달보다 나아지는 게 없었어요. 지금 계획이 이 조건에서 잘 맞아요.</p>}
    </section>
  );
}
