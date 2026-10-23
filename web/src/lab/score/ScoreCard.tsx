// lab:score — 6개월 성적표. 시즌 결과 팝업 맨 위에 붙는다 (SimulateEngine.tsx, CafeSim.tsx).
// 점수와 구간은 엔진 서버가 SeasonSummary로 계산한다 (sim/score.py). 화면은 계산하지 않고 보여 주기만 한다.
// 순서: 총점과 눈금자(0·60·90) → 영역별 점수와 이유 → AI 진단(근본 원인, 다음 판) → 반 랭킹(닉네임 + 반 코드).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Score, SeasonSummary } from "../types";
import { getAdmin, getCoach, getRank, getScore, getStanding, loadLogin, saveLogin, submit, type Admin, type Coach, type Login, type RankRow, type Standing, type Submit } from "./api";
import "./score.css";

const PART_KO: Record<string, string> = { profit: "수익성", survival: "생존", cash: "현금 여유", customer: "손님", cost: "비용 구조", risk: "위험 대응" };
const BAND_KO: Record<string, string> = { fit: "창업 적격", train: "훈련 필요", rethink: "창업 재검토" };
const sent = new Set<string>(); // 같은 판을 두 번 저장하지 않게 (StrictMode 두 번 마운트 포함)

function Ruler({ total, best, top, topDemo }: { total: number; best?: number | null; top?: number | null; topDemo?: boolean }) {
  const at = (v: number) => `${Math.max(0, Math.min(100, v))}%`;
  return (
    <div className="ls-ruler" role="img" aria-label={`0점에서 100점 사이 ${total}점. 60점부터 훈련 필요, 90점부터 창업 적격`}>
      <div className="ls-zones" aria-hidden="true">
        <span className="z-rethink" style={{ inlineSize: "60%" }}>창업 재검토</span>
        <span className="z-train" style={{ inlineSize: "30%" }}>훈련 필요</span>
        <span className="z-fit" style={{ inlineSize: "10%" }}>적격</span>
      </div>
      <div className="ls-ticks" aria-hidden="true">
        {[0, 60, 90, 100].map((t) => <i key={t} style={{ insetInlineStart: at(t) }}>{t}</i>)}
      </div>
      {top != null && <b className="ls-mark ls-top" style={{ insetInlineStart: at(top) }} aria-hidden="true" />}
      {best != null && <b className="ls-mark ls-best" style={{ insetInlineStart: at(best) }} aria-hidden="true" />}
      <b className="ls-mark ls-now" style={{ insetInlineStart: at(total) }} aria-hidden="true"><em>이번 {total}</em></b>
      {(best != null || top != null) && (
        <p className="ls-legend">
          <span className="lg-now">이번 {total}점</span>
          {best != null && <span className="lg-best">내 최고 {best}점</span>}
          {top != null && <span className="lg-top">반 1등 {top}점{topDemo ? " (예시)" : ""}</span>}
        </p>
      )}
    </div>
  );
}

function Parts({ score }: { score: Score }) {
  return (
    <ol className="ls-parts">
      {score.parts.map((p) => {
        const r = p.score / p.max;
        return (
          <li key={p.key} className={r >= 0.8 ? "good" : r >= 0.5 ? "mid" : "low"}>
            <div className="ls-part-h">
              <span>{p.label}</span>
              <b>{p.score}<small>/{p.max}</small></b>
            </div>
            <div className="ls-bar" aria-hidden="true"><i style={{ inlineSize: `${r * 100}%` }} /></div>
            <p>{p.why}</p>
          </li>
        );
      })}
    </ol>
  );
}

function CoachBox({ coach, busy }: { coach: Coach | null; busy: boolean }) {
  if (!coach) return <p className="ls-muted">진단을 불러오는 중이에요</p>;
  return (
    <div className="ls-coach">
      <div className="ls-coach-h">
        <h3>무엇이 근본 원인이었나</h3>
        <span className={`ls-src ${coach.source}`}>{coach.source === "llm" ? "AI 진단 (이 컴퓨터의 언어 모델)" : busy ? "규칙 진단, AI가 다시 읽는 중" : "규칙 진단"}</span>
      </div>
      <ul className="ls-causes">
        {coach.causes.map((c) => (
          <li key={c.id}>
            <b>{c.title}</b>
            <span className="ls-ev">{c.evidence}</span>
            <p>{c.why}</p>
          </li>
        ))}
      </ul>
      {coach.next.length > 0 && (
        <>
          <h3>다음 판에 바꿔 볼 것</h3>
          <ul className="ls-next">
            {coach.next.map((n) => (
              <li key={n.id}>
                <b>{n.text}</b>
                <span>{n.expected}</span>
                {n.how && <p>{n.how}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      <small>원인과 숫자는 이번 판의 결과에서만 가져와요. 예상 효과는 다른 조건이 그대로일 때의 단순 계산이에요.</small>
    </div>
  );
}

function LoginForm({ onLogin }: { onLogin: (l: Login) => void }) {
  const [nick, setNick] = useState("");
  const [cls, setCls] = useState("");
  return (
    <form className="ls-login" onSubmit={(e) => { e.preventDefault(); if (nick.trim() && cls.trim()) onLogin({ nickname: nick.trim(), class_code: cls.trim().toUpperCase() }); }}>
      <p>반 코드를 넣으면 같은 반 사람들과 점수를 비교해요. 비밀번호와 실명은 받지 않아요.</p>
      <label>닉네임<input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={16} autoComplete="off" placeholder="예: 성수동사장" /></label>
      <label>반 코드<input value={cls} onChange={(e) => setCls(e.target.value)} maxLength={16} autoComplete="off" placeholder="강사님이 알려 준 코드" /></label>
      <button type="submit" className="ls-btn" disabled={!nick.trim() || cls.trim().length < 3}>이 점수로 반 랭킹에 올리기</button>
    </form>
  );
}

function AdminView({ cls }: { cls: string }) {
  const [a, setA] = useState<Admin | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { getAdmin(cls).then(setA).catch((e) => setErr(String(e.message ?? e))); }, [cls]);
  if (err) return <p className="ls-err">{err}</p>;
  if (!a) return <p className="ls-muted">반 기록을 불러오는 중이에요</p>;
  return (
    <div className="ls-admin">
      <p>{a.class_code} 반 학습자 {a.learners.length}명: 창업 적격 {a.bands.fit ?? 0}명, 훈련 필요 {a.bands.train ?? 0}명, 창업 재검토 {a.bands.rethink ?? 0}명</p>
      {a.weakest[0] && <p>반 전체에서 가장 많이 놓친 부분: <b>{PART_KO[a.weakest[0].key]}</b> (배점의 {Math.round(a.weakest[0].lost_share * 100)}%를 잃음)</p>}
      <table>
        <thead><tr><th>닉네임</th><th>최고</th><th>첫 점수</th><th>시도</th><th>구간</th></tr></thead>
        <tbody>{a.learners.map((p) => <tr key={p.nickname}><td>{p.nickname}{p.demo && <i className="ls-demo">예시</i>}</td><td>{p.best}</td><td>{p.first}</td><td>{p.attempts}</td><td>{BAND_KO[p.band]}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function RankBox({ summary, score, onRank }: { summary: SeasonSummary; score: Score; onRank: (rows: RankRow[], nickname: string) => void }) {
  const [login, setLogin] = useState<Login | null>(() => loadLogin());
  const [res, setRes] = useState<Submit | null>(null);
  const [rank, setRank] = useState<RankRow[] | null>(null);
  const [err, setErr] = useState("");
  const [admin, setAdmin] = useState(false);
  const key = useMemo(() => JSON.stringify(summary), [summary]);

  useEffect(() => {
    if (!login) return;
    setErr("");
    const id = `${login.class_code}|${login.nickname}|${key}`;
    if (sent.has(id)) { getRank(login.class_code, String(summary.industry)).then((r) => setRank(r.rank)).catch((e) => setErr(String(e.message ?? e))); return; }
    sent.add(id);
    submit(login, summary).then((r) => { setRes(r); setRank(r.rank); saveLogin(login); onRank(r.rank, login.nickname); })
      .catch((e) => { sent.delete(id); setErr(String(e.message ?? e)); });
  }, [login, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!login) return (
    <section className="ls-rank" aria-labelledby="ls-rank-h">
      <h3 id="ls-rank-h">반 랭킹</h3>
      <LoginForm onLogin={setLogin} />
    </section>
  );
  const me = res?.me ?? rank?.find((p) => p.nickname === login.nickname);
  const size = res?.class_size ?? rank?.length ?? 0;
  return (
    <section className="ls-rank" aria-labelledby="ls-rank-h">
      <div className="ls-rank-h">
        <h3 id="ls-rank-h">{login.class_code} 반 랭킹{login.class_code === "DEMO" && <i className="ls-demo">예시 반</i>}</h3>
        <button type="button" className="ls-link" onClick={() => { saveLogin(null); setLogin(null); setRes(null); setRank(null); }}>{login.nickname} (바꾸기)</button>
      </div>
      {err && <p className="ls-err" role="alert">{err}</p>}
      {me && (
        <dl className="ls-me">
          <div><dt>내 등수</dt><dd>{me.rank}<small>/{size}명</small></dd></div>
          <div><dt>내 최고</dt><dd>{me.best}<small>점</small></dd></div>
          <div><dt>시도</dt><dd>{me.attempts}<small>번</small></dd></div>
          <div><dt>첫 판 대비</dt><dd>{me.gain >= 0 ? "+" : "−"}{Math.abs(me.gain)}<small>점</small></dd></div>
        </dl>
      )}
      {res && !res.me.is_best && <p className="ls-muted">이번 {score.total}점은 내 최고 {res.me.best}점보다 낮아서 순위는 최고 점수로 매겨요.</p>}
      {rank?.some((p) => p.demo) && <p className="ls-muted">'예시' 표시는 시연용으로 넣은 가상 기록이에요. 실제 학습자 기록이 아니에요.</p>}
      {rank && (
        <ol className="ls-list">
          {rank.slice(0, 10).map((p) => (
            <li key={p.nickname} className={p.nickname === login.nickname ? "me" : ""}>
              <span className="ls-rk">{p.rank}</span>
              <span className="ls-nm">{p.nickname}{p.demo && <i className="ls-demo">예시</i>}</span>
              <span className={`ls-bd b-${p.band}`}>{BAND_KO[p.band]}</span>
              <b>{p.best}</b>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="ls-link" aria-expanded={admin} onClick={() => setAdmin((v) => !v)}>{admin ? "강사용 보기 닫기" : "강사용 보기 (반 전체 기록)"}</button>
      {admin && <AdminView cls={login.class_code} />}
    </section>
  );
}

// lab:standing 내 자리: 같은 업종·가진 돈 구간에서 엔진으로 돌린 판들의 점수 분포와 내 위치, 그리고 놓친 것 3가지
const won = (krw: number) => `${krw < 0 ? "−" : "+"}${Math.abs(Math.round(krw / 1e4)).toLocaleString("ko-KR")}만원`;
function StandingBox({ st, busy, err, total }: { st: Standing | null; busy: boolean; err: string; total: number }) {
  if (err) return <section className="ls-stand"><p className="ls-muted">비교할 판을 불러오지 못했어요: {err}</p></section>;
  if (!st) return <section className="ls-stand"><p className="ls-muted">같은 조건의 판들과 비교하는 중이에요. 내 가게를 엔진으로 몇 번 더 돌려요.</p></section>;
  const peak = Math.max(1, ...st.hist), mine = Math.min(9, Math.floor(total / 10));
  return (
    <section className="ls-stand" aria-labelledby="ls-stand-h">
      <div className="ls-stand-me">
        <div className="ls-stand-l">
          <h3 id="ls-stand-h" className="ls-cap">내 자리</h3>
          <p className="ls-pct">상위 <b>{st.top_pct}%</b></p>
          <small>{st.cohort}, 엔진으로 돌린 {st.n.toLocaleString("ko-KR")}판과 비교했어요. 수강생 기록이 쌓이면 그 기록과 비교해요.</small>
        </div>
        <div className="ls-hist" role="img" aria-label={`점수 분포에서 ${total}점은 상위 ${st.top_pct}%`}>
          {st.hist.map((c, i) => (
            <div key={i} className={i === mine ? "is-me" : ""}>
              <i style={{ blockSize: `${Math.max(2, (c / peak) * 100)}%` }}>{i === mine && <em>나 {total}점</em>}</i>
              <span>{i * 10}</span>
            </div>
          ))}
        </div>
        <p className="ls-hist-cap">점수 구간별 판 수 (10점 단위)</p>
      </div>
      <div className="ls-missed">
        <h3 className="ls-cap">놓친 것{st.missed.length ? ` ${st.missed.length}가지` : ""}</h3>
        {busy && <p className="ls-muted">계산 중이에요</p>}
        {!st.missed.length ? <p className="ls-muted">상위 10% 판과 다르게 고른 것 가운데 바꿔서 나아지는 것이 없었어요.</p> : (
          <ol>
            {st.missed.map((m, i) => (
              <li key={m.key}>
                <span className="ls-no">{i + 1}</span>
                <div>
                  <b>{m.label}</b>
                  <p className="ls-swap"><span className="ls-mine">{m.mine}</span><span aria-hidden>→</span><span className="ls-topv">{m.top}</span><small>상위 10%</small></p>
                </div>
                <p className="ls-gain" aria-label={`이것만 바꾸면 6개월 영업이익 ${won(m.d_op_krw)}`}><strong>{won(m.d_op_krw)}</strong>{m.d_score ? <small>점수 {m.d_score > 0 ? "+" : ""}{m.d_score}</small> : null}</p>
              </li>
            ))}
          </ol>
        )}
        <small>놓친 것은 내 가게를 엔진으로 다시 돌려(이달의 사건은 기본 대응) 그 항목 하나만 바꾼 판과 비교한 값이에요. 사건 뽑기에 따라 흔들려서 5번 돌려 평균을 냈고, 5번 중 4번 이상 나아진 것만 보여 줘요. 상위 10%가 많이 고른 값이 늘 정답은 아니에요.</small>
      </div>
    </section>
  );
}

// 성적표 없이 쓰는 화면(이지 모드 결과)용: 스스로 불러온다
export function StandingPanel({ summary, total }: { summary: SeasonSummary; total: number }) {
  const [st, setSt] = useState<Standing | null>(null);
  const [err, setErr] = useState("");
  const key = useMemo(() => JSON.stringify(summary), [summary]);
  useEffect(() => {
    let alive = true;
    setSt(null); setErr("");
    getStanding(summary).then((s) => alive && setSt(s)).catch((e) => alive && setErr(String(e.message ?? e)));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (summary.industry !== "bbq" && summary.industry !== "cafe") return null;
  return <div className="ls-card ls-solo"><StandingBox st={st} busy={false} err={err} total={total} /></div>;
}

export default function ScoreCard({ summary }: { summary: SeasonSummary }) {
  const [score, setScore] = useState<Score | null>(null);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [err, setErr] = useState("");
  const [stand, setStand] = useState<Standing | null>(null); // lab:standing
  const [standErr, setStandErr] = useState("");
  const [best, setBest] = useState<{ me?: number | null; top?: number | null; topDemo?: boolean }>({});
  const alive = useRef(true);
  const key = useMemo(() => JSON.stringify(summary), [summary]);
  // 눈금자의 '내 최고'는 이번 판을 올리기 전 기록, '반 1등'은 지금 순위의 맨 위
  const onRank = (rows: RankRow[], nickname: string, before: boolean) => setBest((b) => ({
    me: before ? rows.find((p) => p.nickname === nickname)?.best ?? null : b.me ?? null,
    top: rows[0]?.best ?? null, topDemo: !!rows[0]?.demo,
  }));

  useEffect(() => {
    alive.current = true;
    setScore(null); setCoach(null); setErr(""); setStand(null); setStandErr("");
    if (summary.industry === "bbq" || summary.industry === "cafe") // lab:standing 새 업종은 아직 비교 판이 없다
      getStanding(summary).then((s) => alive.current && setStand(s)).catch((e) => alive.current && setStandErr(String(e.message ?? e)));
    getScore(summary).then((s) => alive.current && setScore(s)).catch((e) => alive.current && setErr(String(e.message ?? e)));
    // 규칙 진단을 먼저 보여 주고, 로컬 언어 모델의 진단이 오면 바꾼다 (실패하면 서버가 규칙 문장을 돌려준다)
    // 규칙 진단은 AI 진단을 덮어쓰지 않는다 (캐시 덕에 둘이 거의 같이 도착할 수 있다)
    getCoach(summary, false).then((c) => alive.current && setCoach((prev) => (prev?.source === "llm" ? prev : c))).catch(() => undefined);
    setCoachBusy(true);
    getCoach(summary, true).then((c) => alive.current && setCoach((prev) => (prev?.source === "llm" && c.source !== "llm" ? prev : c)))
      .catch(() => undefined).finally(() => alive.current && setCoachBusy(false));
    const l = loadLogin();
    if (l) getRank(l.class_code, String(summary.industry)).then((r) => alive.current && onRank(r.rank, l.nickname, true)).catch(() => undefined);
    return () => { alive.current = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <section className="ls-card"><p className="ls-err" role="alert">성적표를 계산하지 못했어요: {err}</p></section>;
  if (!score) return <section className="ls-card"><p className="ls-muted">성적표를 계산하는 중이에요</p></section>;
  return (
    <section className={`ls-card band-${score.band}`} aria-labelledby="ls-h">
      <header className="ls-head">
        <div className="ls-total">
          <h2 id="ls-h" className="ls-cap">6개월 성적표</h2>
          <p className="ls-num"><b>{score.total}</b><span>/100</span></p>
          <p className="ls-band">{score.band_label}</p>
          {stand && <p className="ls-pctchip">상위 {stand.top_pct}%</p>}{/* lab:standing */}
        </div>
        <div className="ls-head-r">
          <Ruler total={score.total} best={best.me} top={best.top} topDemo={best.topDemo} />
          <p className="ls-bandtext">
            {score.band_text}.{" "}
            {score.total >= 90 ? "90점을 넘었어요." : `창업 적격(90점)까지 ${90 - score.total}점 남았어요.`}
          </p>
        </div>
      </header>
      {(summary.industry === "bbq" || summary.industry === "cafe") && <StandingBox st={stand} busy={false} err={standErr} total={score.total} />}
      <div className="ls-body">
        <section aria-label="영역별 점수"><Parts score={score} /></section>
        <RankBox summary={summary} score={score} onRank={(rows, nick) => onRank(rows, nick, false)} />
      </div>
      <CoachBox coach={coach} busy={coachBusy} />
      <small className="ls-foot">업계 비율은 외식업체경영실태조사 2025, 생존율은 통계청 기업생멸행정통계(공공 통계)예요. 점수 곡선과 구간(90점, 60점)은 교육용 가정(권고안)이에요.</small>
    </section>
  );
}
