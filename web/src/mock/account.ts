// 시연용 계정: 별명·반 코드·역할만 이 브라우저(localStorage)에 저장한다. 비밀번호와 서버 저장은 없다.
// 실제 서비스에서는 소셜 로그인(카카오·구글 등)과 서버 계정으로 바꾼다. 화면은 useAccount()만 보면 된다.
import { useSyncExternalStore } from "react";

export type Role = "student" | "teacher";
export type Account = { name: string; cls: string; role: Role; since: string };
export const ROLE_KO: Record<Role, string> = { student: "수강생", teacher: "강사" };

const KEY = "cu-account";
const subs = new Set<() => void>();
let cache: Account | null | undefined;

function read(): Account | null {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    cache = null;
  }
  return cache;
}

function write(a: Account | null) {
  cache = a;
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY);
  } catch { /* 저장 못 해도 이번 화면에서는 로그인 상태를 유지한다 */ }
  subs.forEach((f) => f());
}

export const login = (name: string, cls: string, role: Role) =>
  write({ name: name.trim().slice(0, 12), cls: cls.trim().slice(0, 20) || "공개", role, since: new Date().toISOString().slice(0, 10) });
export const logout = () => write(null);
export const getAccount = read;
export function useAccount(): Account | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, read, () => null);
}
