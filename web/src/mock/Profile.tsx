// Step 1. One question on screen at a time; the previous one fades out before the next fades in.
import { useEffect, useRef, useState } from "react";
import { krei, man, type Gu, type Profile } from "./model";

const REASONS = ["사는 곳과 가까워서", "유동 인구가 많아서", "월세가 쌀 것 같아서", "잘 아는 동네라서", "아직 잘 모르겠어요"];
const AGES = ["20대", "30대", "40대", "50대 이상"];
const PRESETS = [3000, 5000, 10000, 20000];
const QUESTIONS = ["industry", "gu", "reasons", "capital", "age"] as const;
type Q = (typeof QUESTIONS)[number];

export default function ProfileStep({ profile, setProfile, gus, onDone }: {
  profile: Profile; setProfile: (p: Profile) => void; gus: Gu[]; onDone: () => void;
}) {
  const [i, setI] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const q: Q = QUESTIONS[i];
  const set = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch });

  useEffect(() => () => clearTimeout(timer.current), []);
  const move = (to: number) => {
    if (leaving) return;
    if (to >= QUESTIONS.length) return onDone();
    setLeaving(true);
    timer.current = window.setTimeout(() => { setI(Math.max(0, to)); setLeaving(false); }, 200);
  };
  const valid = q !== "capital" || profile.capital >= 500;
  const invest = krei()?.micro.invest_total as { n: number; p25: number; p50: number; p75: number } | undefined;

  const answered: { label: string; at: number }[] = [
    { label: profile.industry === "bbq" ? "고깃집" : "카페", at: 0 },
    { label: profile.gu, at: 1 },
    { label: profile.reasons.length ? profile.reasons[0] : "이유 없음", at: 2 },
    { label: man(profile.capital), at: 3 },
  ].slice(0, i);

  return (
    <main className="m-profile">
      <div className="m-bar" role="progressbar" aria-label="질문 진행" aria-valuemin={1} aria-valuemax={QUESTIONS.length} aria-valuenow={i + 1}>
        <i style={{ inlineSize: `${((i + 1) / QUESTIONS.length) * 100}%` }} />
      </div>
      <p className="m-progress">
        {i > 0 && <button type="button" onClick={() => move(i - 1)}>이전 질문</button>}
        <span>질문 {QUESTIONS.length}개 중 {i + 1}번째</span>
      </p>
      {answered.length > 0 && (
        <p className="m-answered">
          지금까지: {answered.map((a, k) => (
            <span key={a.at}>{k > 0 && ", "}<button type="button" onClick={() => move(a.at)}>{a.label}</button></span>
          ))}
        </p>
      )}

      <form className={`m-q ${leaving ? "is-leaving" : ""}`} key={q} onSubmit={(e) => { e.preventDefault(); if (valid) move(i + 1); }}>
        {q === "industry" && (
          <fieldset>
            <legend>어떤 가게를 열고 싶으세요?</legend>
            <div className="m-choices m-choices-big">
              <label className="m-choice"><input type="radio" name="ind" checked={profile.industry === "bbq"} onChange={() => set({ industry: "bbq" })} /><span>고깃집<small>삼겹살, 목살 같은 돼지고기 구이 (자료는 한식 육류 요리 전문점 기준)</small></span></label>
              <label className="m-choice"><input type="radio" name="ind" checked={profile.industry === "cafe"} onChange={() => set({ industry: "cafe" })} /><span>카페<small>커피, 음료, 디저트 (자료는 독립 카페 기준, 동네 분석부터 열려 있어요)</small></span></label>
            </div>
          </fieldset>
        )}
        {q === "gu" && (
          <fieldset>
            <legend>서울 어디에 열고 싶으세요?</legend>
            <p className="m-help">정하지 못했다면 떠오르는 곳 하나를 고르세요. 다음 화면 지도에서 다른 구와 견줘 볼 수 있어요.</p>
            <div className="m-choices m-choices-gu">
              {(gus.length ? gus.map((g) => g.name) : [profile.gu]).map((n) => (
                <label className="m-choice" key={n}><input type="radio" name="gu" checked={profile.gu === n} onChange={() => set({ gu: n })} /><span>{n}</span></label>
              ))}
            </div>
          </fieldset>
        )}
        {q === "reasons" && (
          <fieldset>
            <legend>{profile.gu}를 고른 이유가 있나요?</legend>
            <p className="m-help">여러 개를 골라도 돼요. 고른 이유가 실제 숫자와 맞는지 다음 화면에서 보여 드려요.</p>
            <div className="m-choices">
              {REASONS.map((r) => (
                <label className="m-choice" key={r}>
                  <input type="checkbox" checked={profile.reasons.includes(r)}
                    onChange={(e) => set({ reasons: e.target.checked ? [...profile.reasons, r] : profile.reasons.filter((x) => x !== r) })} />
                  <span>{r}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {q === "capital" && (
          <fieldset>
            <legend>가게를 여는 데 쓸 수 있는 돈은 얼마인가요?</legend>
            <p className="m-help">대출을 받기 전, 지금 가진 돈만 적어 주세요.</p>
            <div className="m-money">
              <input id="cap" type="number" inputMode="numeric" min={0} step={100} value={profile.capital || ""} autoFocus
                onChange={(e) => set({ capital: Math.max(0, Number(e.target.value)) })} aria-describedby="cap-read" />
              <label htmlFor="cap">만원</label>
            </div>
            <p id="cap-read" className="m-moneyread">{profile.capital >= 500 ? man(profile.capital) : "500만원 이상을 적어 주세요"}</p>
            {profile.industry === "cafe" && (
              <p className="m-moneyref">
                실제 독립 카페는 인테리어, 머신과 주방, 가구 같은 시설에 중앙값 {man(6000)}을 들였어요. 4분의 1은 {man(3000)} 아래, 4분의 1은 {man(9000)} 위예요.
                보증금과 권리금은 이 금액에 안 들어 있어요 (경영실태조사 2025 원자료, 카페 팀 지표 엑셀 정리, 전국).
              </p>
            )}
            {profile.industry === "bbq" && invest && (
              <p className="m-moneyref">
                실제 고깃집(한식 육류 요리 전문점)은 공사, 주방, 홀 같은 시설에 중앙값 {man(Math.round(invest.p50 / 100) * 100)}을 들였어요. 4분의 1은 {man(Math.round(invest.p25 / 100) * 100)} 아래,
                4분의 1은 {man(Math.round(invest.p75 / 100) * 100)} 위예요. 보증금과 권리금은 이 금액에 안 들어 있어요 (경영실태조사 2025, 전국, 응답 {invest.n}곳).
              </p>
            )}
            <div className="m-presets">
              {PRESETS.map((p) => <button type="button" key={p} onClick={() => set({ capital: p })}>{man(p)}</button>)}
            </div>
          </fieldset>
        )}
        {q === "age" && (
          <fieldset>
            <legend>나이대를 알려 주세요.</legend>
            <p className="m-help">나이 조건이 있는 정책자금을 걸러내는 데만 써요. 저장하지 않아요.</p>
            <div className="m-choices">
              {AGES.map((a) => (
                <label className="m-choice" key={a}><input type="radio" name="age" checked={profile.age === a} onChange={() => set({ age: a })} /><span>{a}</span></label>
              ))}
            </div>
          </fieldset>
        )}

        <div className={`m-actions ${i > 0 ? "m-actions-row" : ""}`}>
          {i > 0 && <button type="button" className="m-btn m-btn-quiet" onClick={() => move(i - 1)}>이전</button>}
          <button type="submit" className="m-btn" disabled={!valid}>{i === QUESTIONS.length - 1 ? "동네 분석 보기" : "다음"}</button>
        </div>
      </form>
    </main>
  );
}
