// 로그인 화면과 머리글의 계정 버튼. 시연용이라 비밀번호 없이 별명·반 코드·역할만 받는다 (account.ts).
import { useEffect, useRef, useState } from "react";
import { ROLE_KO, login, logout, useAccount, type Role } from "./account";

export const IconUser = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
  </svg>
);

export default function Login({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [name, setName] = useState("");
  const [cls, setCls] = useState("");
  const [role, setRole] = useState<Role>("student");
  const [err, setErr] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("이름(별명)을 적어 주세요."); return; }
    login(name, cls, role);
    onDone();
  };
  return (
    <main className="lg-main">
      <form className="lg-card" onSubmit={submit}>
        <div className="lg-mark"><IconUser size={34} /></div>
        <h1>ChangeUp 시작하기</h1>
        <p className="lg-sub">예비 창업 시뮬레이터에 오신 걸 환영해요. 성적표와 반 랭킹에 이 이름이 쓰여요.</p>
        <label>이름 (별명)
          <input value={name} maxLength={12} autoFocus onChange={(e) => setName(e.target.value)} placeholder="예: 창업러" />
        </label>
        <label>반 코드 <small>강사님이 알려 준 코드. 없으면 비워 두세요</small>
          <input value={cls} maxLength={20} onChange={(e) => setCls(e.target.value)} placeholder="예: 서울대-1기" />
        </label>
        <fieldset className="lg-role">
          <legend>역할</legend>
          {(["student", "teacher"] as const).map((r) => (
            <label key={r} className={role === r ? "on" : ""}>
              <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />{ROLE_KO[r]}
            </label>
          ))}
        </fieldset>
        {err && <p className="lg-err" role="alert">{err}</p>}
        <button type="submit" className="m-btn">시작하기</button>
        <button type="button" className="lg-skip" onClick={onSkip}>로그인 없이 둘러보기</button>
        <small className="lg-note">시연용 로그인이에요. 비밀번호 없이 이 브라우저에만 저장돼요. 실제 서비스에서는 카카오·구글 로그인으로 바꿀 예정이에요.</small>
      </form>
    </main>
  );
}

export function AccountButton({ onLogin }: { onLogin: () => void }) {
  const acc = useAccount();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!acc) return <button type="button" className="m-acct" onClick={onLogin}><IconUser /><span>로그인</span></button>;
  return (
    <div className="m-acct-wrap" ref={box}>
      <button type="button" className="m-acct" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="m-avatar" aria-hidden="true">{acc.name.slice(0, 1)}</span><span>{acc.name}</span>
      </button>
      {open && (
        <div className="m-acct-menu" role="menu">
          <p><b>{acc.name}</b><small>{ROLE_KO[acc.role]} · 반 {acc.cls}</small></p>
          <button type="button" role="menuitem" onClick={() => { logout(); setOpen(false); }}>로그아웃</button>
        </div>
      )}
    </div>
  );
}
