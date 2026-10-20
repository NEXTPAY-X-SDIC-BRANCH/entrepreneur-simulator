// 열기 전 점검, shown under the builder: five questions an owner asks, each answered with a number, what to do about
// it, and how it was worked out. Status is always a mark plus a word, never colour alone.
import { useMemo } from "react";
import { FOOD_SHARE, STATUS_LABEL, checks, man, settledNet, simulate, storeStats, sunkCost, type Levers, type Profile, type Status, type Store } from "./model";

export function Mark({ s }: { s: Status }) {
  return (
    <svg className={`m-mark is-${s}`} viewBox="0 0 20 20" aria-hidden="true">
      {s === "ok" && <><circle cx="10" cy="10" r="9" /><path d="M5.5 10.5l3 3 6-6.5" /></>}
      {s === "warn" && <><path d="M10 1.5 19 18H1z" /><path d="M10 7.5v5M10 15v.5" /></>}
      {s === "weak" && <><rect x="1.5" y="1.5" width="17" height="17" rx="2" /><path d="M6 6l8 8M14 6l-8 8" /></>}
    </svg>
  );
}

export default function Checks({ profile, store, levers }: { profile: Profile; store: Store; levers: Levers }) {
  const { net, list } = useMemo(() => ({
    net: settledNet(simulate(profile, store, levers, []), store),
    list: checks(profile, store, levers),
  }), [profile, store, levers]);
  const stats = storeStats(store);
  const sunk = sunkCost(store, profile.gu, profile.keyMoney ?? 0);
  const headline = stats.seats === 0
    ? <>아직 테이블이 없어요. <mark>가게를 꾸미면</mark> 점검이 채워져요.</>
    : net <= 0
      ? <>이 구성은 자리가 잡혀도 한 달에 <mark>{man(-net)}씩 줄어요.</mark></>
      : <>자리가 잡히면 한 달에 <mark>{man(net)}</mark>이 남아요.</>;

  return (
    <section className="m-checks" aria-labelledby="checks-h">
      <p className="m-eyebrow" id="checks-h">열기 전 점검</p>
      <h1>{headline}</h1>
      <p className="m-sub">{profile.gu}, {store.pyeong}평, {stats.seats}석, 직원 {levers.staff}명 기준이에요. 여는 데 {man(sunk)}과 보증금이 들어요. 가게나 직원 수를 바꾸면 바로 다시 계산해요.</p>
      {stats.seats === 0 && <p className="m-aside">테이블을 놓거나 위쪽의 '추천 배치'를 누르면 다섯 가지 질문의 답이 나와요.</p>}
      {stats.seats > 0 && <ul className="m-checklist">
        {list.map((c) => (
          <li key={c.key}>
            <Mark s={c.status} />
            <div>
              <h2>{c.title}<span className={`m-status is-${c.status}`}>{STATUS_LABEL[c.status]}</span></h2>
              <p>{c.line}</p>
              {c.todo && <p className="m-todo">{c.todo}</p>}
              {c.rows && (
                <ul className="m-shockrows">
                  {c.rows.map((r) => <li key={r.label} className={r.ok ? "is-ok" : "is-weak"}><span>{r.label}</span><b>{r.value}</b></li>)}
                </ul>
              )}
              <details><summary>이렇게 계산했어요</summary><p>{c.rule}</p></details>
            </div>
          </li>
        ))}
      </ul>}
      <p className="m-aside">
        식재료비는 매출의 약 {Math.round(FOOD_SHARE * (19000 / levers.price) * 100)}%로 잡았어요. 서울권 음식점 평균은 39.3%예요
        (한국농촌경제연구원 2025년 조사. 술과 음료가 들어 있고 고깃집만의 값은 아니에요). 고기 값은 한 인분 원가에서 따로 계산해서, 고깃값이 오르면 그만큼 올라가요.
      </p>
      <p className="m-src">손님 수는 {profile.gu} 한식음식점 평균 매출에서 어림한 값이에요. 고깃집만의 매출 자료는 공개된 것이 없어요. 월세는 한국부동산원 상권 값을 구로 묶은 근사라 매물마다 달라질 수 있어요. 아는 매물이 있으면 동네 분석에서 직접 넣을 수 있어요.</p>
    </section>
  );
}
