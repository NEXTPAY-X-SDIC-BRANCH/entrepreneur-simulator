// 궁금한 것 물어보기. 질문은 출처 서버(api/cite_api.py, 포트 8000)의 /ask 로 보내고, 서버가 근거 문장을 골라 그대로 돌려준다.
// 모델이 문장을 만들지 않는다. 화면이 지금의 가게 입력과 시뮬레이션 결과(ctx)를 같이 보내서 "내 가게" 질문에 답한다.
// 서버가 꺼져 있으면 화면에 이미 있는 숫자(월세, 여는 데 드는 돈, 경쟁)만 이 파일이 직접 답한다.
import { useEffect, useRef, useState } from "react";
import { cashLeft, guStat, iga, man, openingCost, rankOf, storeStats, type Gu, type Levers, type Profile, type ShockId, type Store } from "./model";
import { getEngineCtx } from "./chatContext";
import { profileOf } from "./area";
import "./cite.css";

type Cite = { id: string; title: string; publisher: string; year: string; type: string; url: string; note: string };
type Msg = { who: "me" | "bot"; text: string; cites?: Cite[]; offline?: boolean };
const ASK = ["내 가게는 몇 달째부터 남기 시작해요?", "여는 데 돈이 제일 많이 드는 곳은 어디예요?", "하루에 몇 명 받아야 본전이에요?", "이 동네 경쟁은 어때요?"];
const CITE_API = (import.meta.env.VITE_CITE_API as string | undefined) ?? "http://127.0.0.1:8000";

export default function Chat({ profile, store, levers, gus, onClose }: {
  profile: Profile; store: Store; levers: Levers; shocks: ShockId[]; gus: Gu[]; onClose: () => void;
}) {
  const [log, setLog] = useState<Msg[]>([{ who: "bot", text: "입력하신 가게와 시뮬레이션 결과, 월세·동네·외식업 비용·돼지고기 가격 같은 자료에서 찾아 답해요. 숫자는 자료의 문장 그대로 보여 드려요." }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [log]);

  // 서버에 함께 보내는 값: 지금 화면의 가게 입력과 시뮬레이션 결과
  const context = () => {
    const st = guStat(profile.gu);
    const s = storeStats(store);
    const cost = openingCost(store, profile.gu, profile.keyMoney ?? 0);
    const engine = getEngineCtx();
    return {
      gu: profile.gu, dong: st.area ?? undefined,
      dong_code: profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined, area_type: st.areaType ?? undefined,
      pyeong: store.pyeong, tables: s.tables, seats: s.seats, staff: levers.staff,
      rent: st.rent, rent_src: st.rentSrc,
      opening_total: cost.total, deposit: cost.lines.find((l) => l.key === "deposit")?.amount,
      capital: profile.capital, loan: store.loan, cash_left: cashLeft(profile, store),
      lines: cost.lines.filter((l) => l.amount > 0).map((l) => ({ label: l.label, amount: l.amount })),
      pork_gu: st.pork, pork_rank: rankOf(profile.gu, "pork", gus.map((g) => g.name)),
      pork_area: st.areaPork ?? undefined, stores_area: st.areaStores ?? undefined,
      ...(engine ? { engine } : {}),
    };
  };

  // 서버를 쓸 수 없을 때만: 화면에 이미 있는 숫자로 답한다 (시뮬레이션 결과는 서버 없이는 설명하지 못한다)
  const offlineAnswer = (q: string): string => {
    const st = guStat(profile.gu);
    if (/월세|임대/.test(q)) return `${profile.gu}${st.area ? ` ${st.area}` : ""}의 평당 월세는 ${st.rent}만원으로 잡았어요. ${store.pyeong}평이면 한 달 ${man(st.rent * store.pyeong)}이에요.`;
    if (/많이 드는|여는 데|오픈 비용|창업 비용|개업 비용/.test(q)) {
      const cost = openingCost(store, profile.gu, profile.keyMoney ?? 0);
      const top = [...cost.lines].sort((a, b) => b.amount - a.amount);
      return `여는 데 드는 ${man(cost.total)} 가운데 ${iga(top[0].label)} ${man(top[0].amount)}으로 가장 커요. 그다음이 ${top[1].label} ${man(top[1].amount)}이에요.`;
    }
    if (/경쟁|고깃집 수|옆 가게/.test(q)) return `${profile.gu}에는 돼지고기 구이 가게가 ${st.pork.toLocaleString("ko-KR")}곳 있어요.`;
    return "지금은 출처 서버가 꺼져 있어 이 질문에 답하지 못해요. api/cite_api.py를 켜 주세요 (python -m uvicorn api.cite_api:app --port 8000).";
  };

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setLog((l) => [...l, { who: "me", text: question }]);
    setText("");
    setBusy(true);
    try {
      const r = await fetch(`${CITE_API}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: question, ctx: context() }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const cites: Cite[] = d.citations ?? [];
      setLog((l) => [...l, { who: "bot", text: d.answer ?? d.message ?? "답을 찾지 못했어요.", cites: cites.length ? cites : undefined }]);
    } catch {
      setLog((l) => [...l, { who: "bot", text: `${offlineAnswer(question)}`, offline: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="m-chat" aria-label="질문 창">
      <header><h2>궁금한 것 물어보기</h2><button type="button" className="m-link" onClick={onClose}>닫기</button></header>
      <div className="m-chatlog" aria-live="polite">
        {log.map((m, i) => (
          <div key={i}>
            <p className={`is-${m.who}`}>{m.text}</p>
            {m.cites && (
              <details className="m-cite-box">
                <summary>근거 {m.cites.length}건 보기</summary>
                <ol className="m-cites" aria-label="출처">
                  {m.cites.map((c) => (
                    <li key={c.id}>
                      {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a> : <span>{c.title}</span>}
                      <span className="m-cite-meta"> · {c.publisher}{c.year ? `, ${c.year}` : ""} · {c.type} ({c.id})</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="m-asks">{ASK.map((a) => <button type="button" key={a} onClick={() => void send(a)}>{a}</button>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <label htmlFor="chat-in" className="m-sr">질문</label>
        <input id="chat-in" value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 월세가 얼마예요?" />
        <button type="submit" className="m-btn">보내기</button>
      </form>
    </aside>
  );
}
