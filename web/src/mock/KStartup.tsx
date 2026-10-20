// 지금 접수 중인 창업 지원사업. pipelines/fetch_kstartup.py가 만든 kstartup.json (K-Startup 사업공고, 예비창업자·서울/전국·마감 전).
// 고른 구의 공고 → 서울 공통 → 전국 순, 같은 묶음 안에서는 소상공인·외식 관련(food) 먼저, 그다음 마감이 가까운 순.
// 다른 구의 공고는 그 구 주민·사업장만 받는 경우가 많아 뺀다. 파일이 없으면 아무것도 보여 주지 않는다.
import { useEffect, useState } from "react";

type Item = {
  id: number; name: string; org: string; kind: string; region: string; age: string; start: string; end: string; url: string | null;
  public: boolean; food: boolean; seoul: boolean; gu: string | null;
};
type Data = { _meta: { fetched_at: string; kept: number }; items: Item[] };

const SHOW = 5;
const md = (d: string) => `${+d.slice(4, 6)}월 ${+d.slice(6, 8)}일`;
const daysLeft = (d: string) => {
  const end = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - now.getTime()) / 864e5);
};
const SOON = 3; // 이 날수 이하로 남으면 마감 칩을 경고색으로

const where = (x: Item) => (x.gu ? `${x.gu} 공고` : x.seoul ? "서울" : "전국");

export default function KStartup({ young, gu }: { young: boolean; gu: string }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}mock/kstartup.json`).then((r) => r.json()).then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ageOk = (a: string) => !a || (young ? a.includes("39세 이하") : a.includes("40세 이상"));
  const rank = (x: Item) => (x.gu === gu ? 0 : x.seoul ? 1 : 2);
  const list = data.items
    .filter((x) => x.end >= today && ageOk(x.age) && (!x.gu || x.gu === gu))
    .sort((a, b) => rank(a) - rank(b) || +b.food - +a.food || a.end.localeCompare(b.end));
  if (!list.length) return null;
  const mine = list.filter((x) => x.gu === gu).length;
  return (
    <div className="m-funds">
      <div>
        <h2 className="m-sub">지금 접수 중인 창업 지원사업</h2>
        <p>{mine ? `${gu}에서 여는 공고 ${mine}건을 먼저 보여 드려요.` : `${gu}만 대상으로 한 공고는 지금 없어서, 서울과 전국 공고를 보여 드려요.`} 창업 교육과 상담은 돈이 충분해도 들어 둘 만해요.</p>
        <ul>
          {list.slice(0, SHOW).map((x) => {
            const n = daysLeft(x.end);
            return (
              <li key={x.id}>
                <ul className="m-chips" aria-label="공고 정보">
                  <li className={`m-chip ${x.gu === gu ? "is-good" : ""}`}>{where(x)}</li>
                  <li className="m-chip">{x.kind}</li>
                  {x.food && <li className="m-chip is-good">소상공인·외식</li>}
                  <li className={`m-chip ${n <= SOON ? "is-warn" : ""}`}>{n === 0 ? "오늘 마감" : `D-${n}`}</li>
                </ul>
                <b>{x.url ? <a href={x.url} target="_blank" rel="noreferrer">{x.name}</a> : x.name}</b>
                <small>{x.org} · {md(x.end)}까지</small>
              </li>
            );
          })}
        </ul>
      </div>
      <small className="m-src">
        창업진흥원 K-Startup 사업공고, {data._meta.fetched_at.slice(0, 10)}에 받은 예비창업자 대상 공고 중 {gu}·서울·전국 {list.length}건 가운데 {Math.min(SHOW, list.length)}건.
        다른 구 공고는 그 구 주민만 받는 경우가 많아 뺐어요.{" "}
        신청 조건은 공고 원문을 확인하세요. <a href="https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do" target="_blank" rel="noreferrer">전체 공고 보기</a>
      </small>
    </div>
  );
}
