// lab:industry 1단계 업종 고르기 (안 B): 식사 / 술 / 카페·빵으로 묶고 2열. 일곱 업종 모두 같은 출처의 한 줄(서울 가게 수, 객단가)을 단다.
import { INVEST, PICKER, PICKER_GROUPS, PICKER_SRC, isLab } from "./industries";
import { man } from "../../mock/model";
import "./industry.css";

export function IndustryPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <fieldset>
      <legend>어떤 가게를 열고 싶으세요?</legend>
      <p className="m-help">서울에 가게가 많고 새로 여는 곳이 많은 외식 업종 일곱 개예요.</p>
      {PICKER_GROUPS.map((g) => (
        <div className="ip-grp" key={g.key} role="group" aria-labelledby={`ip-${g.key}`}>
          <h3 id={`ip-${g.key}`}>{g.label}</h3>
          <div className="m-choices ip-grid">
            {PICKER.filter((p) => p.group === g.key).map((p) => (
              <label className="m-choice" key={p.id}>
                <input type="radio" name="ind" checked={value === p.id} onChange={() => onChange(p.id)} />
                <span>
                  {p.name}{p.isNew && <em className="ip-new">새 업종</em>}
                  <small>{p.desc}</small>
                  <small className="ip-data">{p.data}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <p className="ip-src">{PICKER_SRC}</p>
    </fieldset>
  );
}

// 가진 돈 질문 아래 참고 문장 (새 업종만). 경영실태조사 2025 개업 시 투자 비용 분위수.
export function InvestRef({ industry }: { industry: string }) {
  if (!isLab(industry)) return null;
  const v = INVEST[industry];
  return (
    <p className="m-moneyref">
      실제 {v.label}은 공사, 주방, 홀 같은 시설에 중앙값 {man(v.p50)}을 들였어요. 4분의 1은 {man(v.p25)} 아래, 4분의 1은 {man(v.p75)} 위예요.
      보증금과 권리금은 이 금액에 안 들어 있어요 (경영실태조사 2025 원자료, 전국, 응답 {v.n}곳).
    </p>
  );
}
