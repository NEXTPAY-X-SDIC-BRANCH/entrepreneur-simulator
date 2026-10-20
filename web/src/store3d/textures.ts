// Canvas-drawn textures for signs, the menu board and particles. Korean text uses the page's Pretendard
// (loaded in index.html); every texture is redrawn when its inputs change. No image files.
import * as THREE from "three";
import type { Plan } from "../v2/types";

const FONT = `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function tex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export const won = (v: number) => Math.round(v).toLocaleString("ko-KR");

// Fascia sign: deep red board, cream lettering. The emissive copy (lettering only) lights up as night falls.
export function fasciaSign(text: string, sub: string) {
  const [c, g] = canvas(1024, 192);
  const [e, ge] = canvas(1024, 192);
  g.fillStyle = "#7d1f16";
  g.fillRect(0, 0, 1024, 192);
  g.strokeStyle = "#e9c99a";
  g.lineWidth = 6;
  g.strokeRect(14, 14, 996, 164);
  ge.fillStyle = "#000";
  ge.fillRect(0, 0, 1024, 192);
  for (const [ctx, color] of [[g, "#fff3dd"], [ge, "#ffd9a8"]] as const) {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 104px ${FONT}`;
    ctx.fillText(text, 512, 92);
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(sub, 512, 160);
  }
  return { map: tex(c), emissive: tex(e) };
}

// Vertical blade sign (돌출간판), one syllable per row.
export function bladeSign(text: string, bg: string, fg: string) {
  const chars = [...text];
  const [c, g] = canvas(160, 160 * chars.length + 40);
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `800 112px ${FONT}`;
  chars.forEach((ch, i) => g.fillText(ch, 80, 100 + i * 160));
  return tex(c);
}

// Generic shop sign for neighbours and the competitor.
export function shopSign(text: string, bg: string, fg: string, w = 768, h = 160, size = 92) {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `800 ${size}px ${FONT}`;
  g.fillText(text, w / 2, h / 2 + 4);
  return tex(c);
}

const GRADE_KO: Record<Plan["meat_grade"], string> = { imported: "수입 냉동", domestic: "국내산 생", aged: "국내산 숙성" };
const ORIGIN_KO: Record<Plan["meat_grade"], string> = { imported: "돼지고기 수입산(칠레)", domestic: "돼지고기 국내산", aged: "돼지고기 국내산" };
const ADD_KO: Record<string, [string, number]> = { naengsam: ["냉삼", -3000], tongsam: ["통삼겹", 2000], minari: ["미나리 추가", 0] };

// The menu board inside the store. Prices come from the plan, so a reprice is visible on the wall.
export function menuBoard(plan: Plan) {
  const [c, g] = canvas(640, 760);
  g.fillStyle = "#3b2a1e";
  g.fillRect(0, 0, 640, 760);
  g.fillStyle = "#24170f";
  g.fillRect(18, 18, 604, 724);
  g.fillStyle = "#f6ead2";
  g.textBaseline = "alphabetic";
  g.font = `800 58px ${FONT}`;
  g.textAlign = "left";
  g.fillText("차림표", 48, 100);
  g.font = `500 22px ${FONT}`;
  g.fillStyle = "#cdb894";
  g.fillText(`원산지  ${ORIGIN_KO[plan.meat_grade]}`, 50, 140);
  const rows: [string, string, boolean][] = [[`삼겹살 ${GRADE_KO[plan.meat_grade]} 1인분`, won(plan.meat_price), true], ["목살 1인분", won(plan.meat_price + 1000), false]];
  for (const m of plan.menu_extras) {
    const [name, diff] = ADD_KO[m] ?? [m, 0];
    rows.push([name, m === "minari" ? "4,000" : won(plan.meat_price + diff), true]);
  }
  rows.push(["된장찌개", "3,000", false], ["공기밥", "1,000", false], ["소주", won(plan.soju_price), true], ["맥주", won(plan.soju_price + 500), false]);
  let y = 210;
  for (const [name, price, hi] of rows) {
    g.fillStyle = hi ? "#fff7e6" : "#dccbab";
    g.font = `${hi ? 700 : 500} ${hi ? 36 : 30}px ${FONT}`;
    g.textAlign = "left";
    g.fillText(name, 50, y);
    g.textAlign = "right";
    g.fillText(price, 590, y);
    g.strokeStyle = "#5a4433";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(50, y + 16);
    g.lineTo(590, y + 16);
    g.stroke();
    y += hi ? 66 : 58;
  }
  g.fillStyle = "#cdb894";
  g.font = `500 22px ${FONT}`;
  g.textAlign = "left";
  g.fillText(`기본 반찬 ${plan.banchan}가지${plan.staff_grilling ? "  직원이 구워 드립니다" : ""}`, 50, 720);
  return tex(c);
}

// Window poster with the headline price (seen from the street).
export function pricePoster(plan: Plan) {
  const [c, g] = canvas(400, 520);
  g.fillStyle = "#fff8ea";
  g.fillRect(0, 0, 400, 520);
  g.fillStyle = "#7d1f16";
  g.fillRect(0, 0, 400, 120);
  g.fillStyle = "#fff3dd";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `800 64px ${FONT}`;
  g.fillText(plan.meat_grade === "aged" ? "숙성 삼겹" : plan.meat_grade === "imported" ? "수입 삼겹" : "생삼겹", 200, 64);
  g.fillStyle = "#24170f";
  g.font = `600 34px ${FONT}`;
  g.fillText("1인분 (150g)", 200, 190);
  g.font = `800 92px ${FONT}`;
  g.fillText(won(plan.meat_price), 200, 300);
  g.font = `600 34px ${FONT}`;
  g.fillText(`소주 ${won(plan.soju_price)}`, 200, 410);
  g.fillStyle = "#5a4433";
  g.font = `600 24px ${FONT}`;
  const close = plan.close_hour >= 25 ? "01:00" : `${plan.close_hour}:00`;
  g.fillText(`${plan.lunch ? "11:30~14:00, " : ""}17:00~${close}`, 200, 452);
  if (plan.review_event) {
    g.fillStyle = "#1f6b4e";
    g.font = `700 26px ${FONT}`;
    g.fillText("리뷰 쓰면 음료 서비스", 200, 492);
  }
  return tex(c);
}

export function softDot(color = "#ffffff") {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, color);
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return tex(c);
}

// Charcoal grill grate seen from above: dark ring, glowing slots. Used as the ember disc's map and emissive map.
export function grate() {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#1c1a19";
  g.fillRect(0, 0, 128, 128);
  g.save();
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = "#ff6a2b";
  for (let i = 0; i < 9; i++) g.fillRect(8 + i * 13, 4, 6, 120);
  g.restore();
  return tex(c);
}

// Small table card ("예약석") and the X-banner for SNS 협찬.
export function cardSign(text: string, bg: string, fg: string, w = 256, h = 128, size = 54) {
  return shopSign(text, bg, fg, w, h, size);
}
