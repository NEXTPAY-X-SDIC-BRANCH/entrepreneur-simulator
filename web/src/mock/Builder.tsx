// Step 3. A rough build mode: pick from the catalog bar, click the floor to place, click a piece to turn, move or
// remove it. Spending is capped by the cash on hand (own money + loan − opening costs), shown top right.
// The five checks sit below the stage and recompute as the store changes.
import { useEffect, useRef, useState, type RefObject } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { GLGuard } from "../shared/GLGuard";
import Checks from "./Checks";
import { Items, Piece, Room } from "./Parts3D";
import { FitControls, StoreLights, ViewBar, gfxDpr, gfxFrameloop, gfxShadows, useGfx } from "./Scene3D";
import { FlowPath } from "./ShopRoom3D";
import {
  CATALOG, DEPOSIT_MONTHS, GRADES, ITEM, LOAN_RATE, cashLeft, doorX, ecosRates, eul, ymKo, fits, footprint, guStat, kitchenSpot, man, nextUid, openingCost, roomSize, snap,
  recommend, storeStats, type CatalogItem, type Grade, type Levers, type Placed, type Profile, type Store,
} from "./model";

// 손님 동선: 문 → 문 안쪽 → 테이블 가운데. 서빙 동선: 주방 입구에서 테이블까지 평균 거리 (m)
function tablesOf(store: Store) { return store.items.filter((i) => i.id.startsWith("table")); }
function flowOf(store: Store, w: number, d: number): [number, number][] {
  const dx = doorX(w, store.door), ts = tablesOf(store);
  const mid: [number, number] = ts.length ? [ts.reduce((a, t) => a + t.x, 0) / ts.length, ts.reduce((a, t) => a + t.z, 0) / ts.length] : [0, 0];
  return [[dx, d / 2 + 0.6], [dx, d / 2 - 1.2], mid];
}
function serveWalk(store: Store, w: number, d: number): number {
  const k = kitchenSpot(store.pyeong, store), ts = tablesOf(store);
  if (!ts.length) return 0;
  const px = k.x + ITEM.kitchen.w / 2, pz = k.z; // 주방 문(오른쪽 면)
  void w; void d;
  return ts.reduce((a, t) => a + Math.abs(t.x - px) + Math.abs(t.z - pz), 0) / ts.length;
}

type Tool = { kind: "new"; id: string; rot: 0 | 1 } | { kind: "move"; uid: number; id: string; rot: 0 | 1 } | null;

function Scene({ portal, store, tool, selected, ghost, onFloorMove, onFloorClick, onPick, onTurn, onMove, onRemove }: {
  portal: RefObject<HTMLDivElement | null>; store: Store; tool: Tool; selected: number | null; ghost: { x: number; z: number; ok: boolean } | null;
  onFloorMove: (x: number, z: number) => void; onFloorClick: () => void; onPick: (uid: number) => void;
  onTurn: () => void; onMove: () => void; onRemove: () => void;
}) {
  const { w, d } = roomSize(store.pyeong, store);
  const gf = tool ? footprint(tool) : null;
  const sel = store.items.find((i) => i.uid === selected);
  return (
    <>
      <StoreLights w={w} d={d} r={Math.max(w, d) / 2 + 3} />
      <Room w={w} d={d} grade={store.grade} pyeong={store.pyeong} door={store.door} items={store.items.filter((i) => !(tool?.kind === "move" && tool.uid === i.uid))} />
      <FlowPath pts={flowOf(store, w, d)} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} visible={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => onFloorMove(e.point.x, e.point.z)}
        onClick={(e) => { if (e.delta < 5) onFloorClick(); }}>
        <planeGeometry args={[w + 6, d + 6]} />
      </mesh>
      {store.items.map((it) => (
        <group key={it.uid} visible={!(tool?.kind === "move" && tool.uid === it.uid)}
          onClick={(e) => { if (tool || e.delta >= 5) return; e.stopPropagation(); onPick(it.uid); }}>
          <Items items={[it]} />
        </group>
      ))}
      {sel && !tool && !ITEM[sel.id].fixed && (
        <group position={[sel.x, 0, sel.z]}>
          <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[footprint(sel).w, footprint(sel).d]} /><meshBasicMaterial color="#3d63ea" transparent opacity={0.4} />
          </mesh>
          <Html portal={portal as RefObject<HTMLElement>} position={[0, ITEM[sel.id].h + 0.7, 0]} center zIndexRange={[20, 0]}>
            <div className="m-handles" role="toolbar" aria-label={`${ITEM[sel.id].name} 편집`}>
              <button type="button" onClick={onTurn}>돌리기</button>
              <button type="button" onClick={onMove}>옮기기</button>
              <button type="button" onClick={onRemove}>치우기</button>
            </div>
          </Html>
        </group>
      )}
      {tool && ghost && gf && (
        <group position={[ghost.x, 0, ghost.z]}>
          <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[gf.w, gf.d]} /><meshBasicMaterial color={ghost.ok ? "#3d63ea" : "#d03b3b"} transparent opacity={0.45} />
          </mesh>
          <group rotation={[0, tool.rot ? Math.PI / 2 : 0, 0]}><Piece id={tool.id} /></group>
        </group>
      )}
      <FitControls box={[-w / 2, -d / 2, w / 2, d / 2 + 0.6]} />
    </>
  );
}

// top-view symbol for the catalog, drawn like a floor-plan stamp
function Stamp({ it }: { it: CatalogItem }) {
  const k = 22, w = it.w * k, d = it.d * k;
  const dots = it.id === "table4" ? [[-8, -d / 2 + 6], [8, -d / 2 + 6], [-8, d / 2 - 6], [8, d / 2 - 6]] : it.id === "table2" ? [[-w / 2 + 6, 0], [w / 2 - 6, 0]] : [];
  return (
    <svg viewBox="-40 -26 80 52" aria-hidden="true">
      <rect x={-w / 2} y={-d / 2} width={w} height={d} rx="1.5" />
      {it.seats ? <circle r="4.5" /> : null}
      {dots.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" className="seat" />)}
    </svg>
  );
}

const CATS: { key: CatalogItem["cat"]; label: string }[] = [{ key: "seat", label: "좌석" }, { key: "equip", label: "설비" }, { key: "deco", label: "꾸밈" }];
const LOAN_STEP = 500;

export default function Builder({ profile, store, setStore, levers, setLevers, onNext }: {
  profile: Profile; store: Store; setStore: (s: Store) => void; levers: Levers; setLevers: (l: Levers) => void; onNext: () => void;
}) {
  const gfx = useGfx();
  const [cat, setCat] = useState<CatalogItem["cat"]>("seat");
  const [tool, setTool] = useState<Tool>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [ghost, setGhost] = useState<{ x: number; z: number; ok: boolean } | null>(null);
  const [msg, setMsg] = useState("주방만 있는 빈 가게예요. 아래에서 테이블과 설비를 골라 바닥을 눌러 놓거나, 왼쪽 위의 '추천 배치'를 눌러 보세요.");
  const portal = useRef<HTMLDivElement>(null);

  const stats = storeStats(store);
  const cost = openingCost(store, profile.gu, profile.keyMoney ?? 0);
  const left = cashLeft(profile, store);
  const { w, d } = roomSize(store.pyeong, store);
  const count = (id: string) => store.items.filter((i) => i.id === id).length;
  const perPyeong = (g: Grade) => guStat(profile.gu).rent * DEPOSIT_MONTHS + GRADES[g].perPyeong; // 보증금 + 공사, 1평당

  const place = (x: number, z: number, t: NonNullable<Tool>) => {
    const f = footprint(t);
    const c = { id: t.id, rot: t.rot, x: snap(x, f.w), z: snap(z, f.d) };
    return { ...c, ok: fits(store, c, t.kind === "move" ? t.uid : undefined) };
  };
  const onFloorMove = (x: number, z: number) => {
    if (!tool) return;
    const c = place(x, z, tool);
    setGhost((g) => (g && g.x === c.x && g.z === c.z && g.ok === c.ok ? g : { x: c.x, z: c.z, ok: c.ok }));
  };
  const onFloorClick = () => {
    if (!tool) return setSelected(null);
    if (!ghost) return;
    if (!ghost.ok) return setMsg("여기에는 놓을 수 없어요. 벽 안쪽의 빈 칸을 골라 주세요.");
    if (tool.kind === "move") {
      setStore({ ...store, items: store.items.map((i) => (i.uid === tool.uid ? { ...i, x: ghost.x, z: ghost.z, rot: tool.rot } : i)) });
      setSelected(tool.uid);
      setTool(null);
      setMsg(`${eul(ITEM[tool.id].name)} 옮겼어요.`);
    } else {
      const it = ITEM[tool.id];
      if (it.price > left) { setTool(null); setGhost(null); return setMsg(`현금이 ${man(it.price - left)} 모자라서 ${eul(it.name)} 살 수 없어요.`); }
      const item: Placed = { uid: nextUid(store), id: tool.id, x: ghost.x, z: ghost.z, rot: tool.rot };
      setStore({ ...store, items: [...store.items, item] });
      setMsg(`${eul(it.name)} 놓았어요. 현금에서 ${man(it.price)}이 나갔어요.`);
      if ((it.max && count(it.id) + 1 >= it.max) || left - it.price < it.price) setTool(null);
    }
    setGhost(null);
  };
  const sel = store.items.find((i) => i.uid === selected);
  const pick = (uid: number) => {
    const it = store.items.find((i) => i.uid === uid)!;
    if (ITEM[it.id].fixed) { setSelected(null); return setMsg("주방은 벽으로 나눈 방이라 옮기거나 치울 수 없어요."); }
    setSelected(uid);
  };
  const turn = () => {
    if (tool) return setTool({ ...tool, rot: tool.rot ? 0 : 1 });
    if (!sel || ITEM[sel.id].fixed) return;
    const rot = (sel.rot ? 0 : 1) as 0 | 1;
    const f = footprint({ id: sel.id, rot });
    const c = { ...sel, rot, x: snap(sel.x, f.w), z: snap(sel.z, f.d) };
    if (!fits(store, c, sel.uid)) return setMsg("돌릴 자리가 모자라요. 먼저 옮겨 주세요.");
    setStore({ ...store, items: store.items.map((i) => (i.uid === sel.uid ? c : i)) });
  };
  const remove = () => {
    if (!sel || ITEM[sel.id].fixed) return;
    setStore({ ...store, items: store.items.filter((i) => i.uid !== sel.uid) });
    setSelected(null);
    setMsg(`${eul(ITEM[sel.id].name)} 치웠어요. ${man(ITEM[sel.id].price)}이 현금으로 돌아왔어요.`);
  };
  const resize = (pyeong: number) => {
    if (pyeong > store.pyeong && perPyeong(store.grade) > left) return setMsg(`1평 넓히는 데 ${man(perPyeong(store.grade))}이 들어요. 현금이 모자라요.`);
    const shell: Store = { ...store, pyeong, items: [] };
    const kitchen = store.items.find((i) => i.id === "kitchen")!;
    shell.items.push({ ...kitchen, ...kitchenSpot(pyeong, store) });
    for (const it of store.items) if (it.id !== "kitchen" && fits(shell, it)) shell.items.push(it);
    setStore(shell);
    setSelected(null);
    const gone = store.items.length - shell.items.length;
    setMsg(gone ? `${pyeong}평으로 바꿨어요. 자리가 없어진 ${gone}개는 치우고 돈을 돌려받았어요.` : `${pyeong}평으로 바꿨어요.`);
  };
  // 가게 모양·출입문을 바꾸면 벽이 움직인다. 주방은 새 구석으로 옮기고, 자리가 없어진 물건은 치운다
  const relay = (lay: { door?: Store["door"]; shape?: Store["shape"] }) => {
    const next: Store = { ...store, ...lay, items: [] };
    const kitchen = store.items.find((i) => i.id === "kitchen")!;
    next.items.push({ ...kitchen, ...kitchenSpot(store.pyeong, next) });
    for (const it of store.items) if (it.id !== "kitchen" && fits(next, it)) next.items.push(it);
    setStore(next); setSelected(null);
    const gone = store.items.length - next.items.length;
    setMsg(gone ? `가게 모양을 바꿨어요. 자리가 없어진 ${gone}개는 치우고 돈을 돌려받았어요.` : "가게 모양을 바꿨어요. 파란 화살표가 손님 동선이에요.");
  };
  const regrade = (g: Grade) => {
    const delta = (GRADES[g].perPyeong - GRADES[store.grade].perPyeong) * store.pyeong;
    if (delta > left) return setMsg(`${GRADES[g].label} 마감은 ${man(delta)}이 더 들어요. 현금이 모자라요.`);
    setStore({ ...store, grade: g });
  };
  const loan = (delta: number) => {
    if (delta < 0 && left + delta < 0) return setMsg("대출을 줄이면 현금이 0 아래로 내려가요. 먼저 물건을 치우거나 평수를 줄이세요.");
    setStore({ ...store, loan: Math.max(0, store.loan + delta) });
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "Escape") { setTool(null); setGhost(null); }
      else if (e.key === "r" || e.key === "R") turn();
      else if ((e.key === "Delete" || e.key === "Backspace") && !tool) remove();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });

  return (
    <main className="m-build">
      <div className="m-stage">
        <div ref={portal} className="m-canvas">
          <GLGuard>
            <Canvas key={gfx} frameloop={gfxFrameloop(gfx)} shadows={gfxShadows(gfx)} camera={{ position: [w * 0.55, Math.max(w, d) * 0.95, d * 1.25], fov: 38 }} dpr={gfxDpr(gfx)}>
              <Scene portal={portal} store={store} tool={tool} selected={selected} ghost={ghost} onFloorMove={onFloorMove} onFloorClick={onFloorClick}
                onPick={pick} onTurn={turn} onRemove={remove}
                onMove={() => { if (sel) { setTool({ kind: "move", uid: sel.uid, id: sel.id, rot: sel.rot }); setGhost(null); setMsg("놓을 자리를 누르세요. R 키로 돌리고 Esc로 그만둬요."); } }} />
            </Canvas>
          </GLGuard>
          <ViewBar />
        </div>

        <div className="m-room">
          <div className="m-stepper">
            <span id="py">가게 크기</span>
            <button type="button" aria-label="1평 줄이기" disabled={store.pyeong <= 12} onClick={() => resize(store.pyeong - 1)}>−</button>
            <output aria-labelledby="py">{store.pyeong}평</output>
            <button type="button" aria-label="1평 늘리기" disabled={store.pyeong >= 40} onClick={() => resize(store.pyeong + 1)}>+</button>
          </div>
          <div className="m-seg" role="group" aria-label="마감 수준">
            {(Object.keys(GRADES) as Grade[]).map((g) => (
              <button type="button" key={g} aria-pressed={store.grade === g} onClick={() => regrade(g)}>{GRADES[g].label}</button>
            ))}
          </div>
          <div className="m-stepper">
            <span id="st">직원 수</span>
            <button type="button" aria-label="직원 1명 줄이기" disabled={levers.staff <= 0} onClick={() => setLevers({ ...levers, staff: levers.staff - 1 })}>−</button>
            <output aria-labelledby="st">{levers.staff}명</output>
            <button type="button" aria-label="직원 1명 늘리기" disabled={levers.staff >= 8} onClick={() => setLevers({ ...levers, staff: levers.staff + 1 })}>+</button>
          </div>
          <div className="m-layout-row">
            <span id="bb-shape">가게 모양</span>
            <div className="m-seg" role="group" aria-labelledby="bb-shape">
              {([["wide", "가로로 긴"], ["square", "정사각"], ["deep", "세로로 긴"]] as const).map(([k, l]) => (
                <button type="button" key={k} aria-pressed={(store.shape ?? "wide") === k} onClick={() => relay({ shape: k })}>{l}</button>
              ))}
            </div>
          </div>
          <div className="m-layout-row">
            <span id="bb-door">출입문</span>
            <div className="m-seg" role="group" aria-labelledby="bb-door">
              {([["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]] as const).map(([k, l]) => (
                <button type="button" key={k} aria-pressed={(store.door ?? "right") === k} onClick={() => relay({ door: k })}>{l}</button>
              ))}
            </div>
          </div>
          <p>테이블 {stats.tables}개, {stats.seats}석 · 주방에서 테이블까지 평균 {serveWalk(store, w, d).toFixed(1)}m</p>
          <button type="button" className="m-btn m-btn-quiet m-recbtn" onClick={() => {
            const plan = recommend(profile, { door: store.door, shape: store.shape });
            setStore(plan.store); setLevers({ ...levers, staff: plan.staff }); setSelected(null); setTool(null);
            setMsg(`추천 배치를 놓았어요. ${plan.store.pyeong}평, 테이블 ${storeStats(plan.store).tables}개, 직원 ${plan.staff}명이에요.${plan.safe ? "" : " 이 돈으로는 6개월을 버티는 구성을 찾지 못했어요."}`);
          }}>추천 배치</button>
        </div>

        <div className={`m-cash ${left < 0 ? "is-short" : ""}`}>
          <p><span>{left < 0 ? "모자란 현금" : "현금"}</span><strong>{man(Math.abs(left))}</strong></p>
          <small>가진 돈 {man(profile.capital)}{store.loan > 0 ? ` + 대출 ${man(store.loan)}` : ""} 중 {man(cost.total)}을 썼어요.</small>
          <div className="m-stepper">
            <span id="loan">대출</span>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 줄이기`} disabled={store.loan <= 0} onClick={() => loan(-LOAN_STEP)}>−</button>
            <output aria-labelledby="loan">{man(store.loan)}</output>
            <button type="button" aria-label={`대출 ${LOAN_STEP}만원 늘리기`} disabled={store.loan >= 20000} onClick={() => loan(LOAN_STEP)}>+</button>
          </div>
          {(() => {
            const r = ecosRates();
            return r?.loan_sme
              ? <small>지금 은행 평균 금리 연 {r.loan_sme.rate}% (중소기업대출 신규, 한국은행 {ymKo(r.loan_sme.month)} 기준){r.base_rate ? `, 기준금리 ${r.base_rate.rate}%` : ""}. 이자는 이 금리로 계산해요.</small>
              : <small>대출 이자는 연 {(LOAN_RATE * 100).toFixed(1)}%로 가정했어요.</small>;
          })()}
          {left < 0 && <p className="m-warn">이대로는 가게를 열 수 없어요. 평수나 마감을 낮추거나 대출을 받으세요.</p>}
        </div>

        <p className="m-msg" role="status">{msg}</p>
      </div>

      <div className="m-tray">
        <dl className="m-spent">
          {cost.lines.filter((l) => l.amount > 0).map((l) => <div key={l.key}><dt>{l.label}</dt><dd>{man(l.amount)}</dd></div>)}
        </dl>
        <div className="m-cats" role="tablist" aria-label="물건 종류">
          {CATS.map((c) => <button type="button" role="tab" key={c.key} aria-selected={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</button>)}
        </div>
        <ul className="m-catalog">
          {CATALOG.filter((c) => c.cat === cat && !c.fixed).map((it) => {
            const full = Boolean(it.max && count(it.id) >= it.max);
            const poor = it.price > left;
            const on = tool?.kind === "new" && tool.id === it.id;
            return (
              <li key={it.id}>
                <button type="button" aria-pressed={on} disabled={full || (poor && !on)}
                  onClick={() => { setSelected(null); setGhost(null); setTool(on ? null : { kind: "new", id: it.id, rot: 0 }); setMsg(on ? "고르기를 그만뒀어요." : `${it.name}: 놓을 자리를 누르세요. R 키로 돌리고 Esc로 그만둬요.`); }}>
                  <Stamp it={it} />
                  <span>{it.name}</span>
                  <small>{full ? "이미 놓았어요" : poor ? `${man(it.price)}, 현금이 모자라요` : `${man(it.price)}${it.note ? `, ${it.note}` : ""}`}</small>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="m-tray-go">
          <button type="button" className="m-btn m-btn-outline" onClick={() => document.querySelector(".m-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}>오픈 전 점검 보러가기</button>
          <button type="button" className="m-btn" disabled={left < 0 || stats.seats === 0} onClick={onNext}>시뮬레이션 하러 가기</button>
        </div>
      </div>

      <Checks profile={profile} store={store} levers={levers} />
    </main>
  );
}
