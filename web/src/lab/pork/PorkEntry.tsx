// 고깃집 흐름 위쪽 막대의 '돼지고기 시세' 버튼 (lab:pork). 누르면 대시보드를 겹쳐 연다. 대시보드 코드는 누를 때 불러온다.
import { Suspense, lazy, useState } from "react";
import "./pork-entry.css";

const PorkDashboard = lazy(() => import("./PorkDashboard"));

export default function PorkEntry() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="m-porkbtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>돼지고기 시세</button>
      {open && (
        <Suspense fallback={<div className="m-pork-loading">시세 자료를 불러오는 중이에요</div>}>
          <PorkDashboard onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
