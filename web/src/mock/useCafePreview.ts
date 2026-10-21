// 카페 엔진 미리보기(/cafe/preview)를 입력이 바뀔 때마다(0.3초 모아서) 다시 불러온다.
import { useEffect, useState } from "react";
import { cafeDistrictCode } from "./cafe";
import { engineBody, type CafeCfg } from "./cafeChecks";
import type { Profile } from "./model";

export const ENGINE = (import.meta.env.VITE_ENGINE_API as string | undefined) ?? "http://127.0.0.1:8010";
export type Preview = {
  room: { width_m: number; depth_m: number; door: { x: number; w: number } };
  layout: { id: string; type: string; x: number; z: number; rot_deg: number; fits: boolean; w: number; d: number; unassigned?: boolean }[];
  staff: { roster: { id: string; role: string; label_ko: string; x: number; z: number; fits: boolean }[]; schedule: { hour: number; orders: number; staff: number; need: number; short: boolean }[] };
  space: { use_pct: number; table_slots: number; bar_capacity: number; overflow: { type: string; count: number }[]; fix: { label_ko: string; patch: Record<string, number> }[] };
  seats: { total: number; table: number; bar: number };
  bottleneck: { key: string; label_ko: string; ratio: number; note_ko: string }[];
  suggestion: { label_ko: string; patch: Record<string, number>; effect_ko: string };
  capex: { total_krw: number };
};

export function useCafePreview(profile: Profile, cfg: CafeCfg): { data: Preview | null; err: string } {
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const key = JSON.stringify([profile.gu, profile.dong, profile.capital, cfg]);
  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`${ENGINE}/cafe/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(engineBody(profile, cfg, cafeDistrictCode(profile))) })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "입력 범위를 확인해 주세요"); setData(j); setErr(""); })
        .catch((e) => setErr(/fetch/i.test(String(e)) ? "엔진 서버에 연결하지 못했어요. uvicorn api.changeup:app --host 127.0.0.1 --port 8010 으로 켜 주세요." : String(e.message ?? e)));
    }, 300);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, err };
}
