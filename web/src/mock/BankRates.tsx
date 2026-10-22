// 은행별 개인사업자 대출 금리 (은행연합회 비교공시, pipelines/fetch_kfb_rates.py -> bank_rates.json).
// 보증서담보대출(지역신용보증재단 보증서) 평균이 낮은 순서. 은행을 누르면 그 은행 상품 페이지나 은행연합회 비교표로 간다 (대출 연계는 하지 않음)
import { useEffect, useState } from "react";
import { BANKS, BANK_COMPARE_URL } from "./funds";

type Kind = { avg: number; by: Record<string, number> };
type Data = { ym: string; url: string; banks: Record<string, { 보증서담보대출?: Kind; 신용대출?: Kind; note?: string }> };
let CACHE: Data | null = null;

export function useBankRates() {
  const [d, setD] = useState<Data | null>(CACHE);
  useEffect(() => {
    if (CACHE) return;
    fetch(`${import.meta.env.BASE_URL}mock/bank_rates.json`).then((r) => r.json()).then((x: Data) => { CACHE = x; setD(x); }).catch(() => setD(null));
  }, []);
  return d;
}
export const bankRateOf = (d: Data | null, name: string) => d?.banks[name] ?? null;

export default function BankRates() {
  const d = useBankRates();
  const [all, setAll] = useState(false);
  if (!d) return null;
  const rows = Object.entries(d.banks).filter(([, v]) => v.보증서담보대출).sort((a, b) => a[1].보증서담보대출!.avg - b[1].보증서담보대출!.avg);
  const best = rows[0]?.[1].보증서담보대출?.avg ?? 0;
  const shown = all ? rows : rows.slice(0, 8);
  const ymKo = `${d.ym.slice(0, 4)}년 ${+d.ym.slice(4)}월`;
  return (
    <section className="br">
      <h3>은행별 개인사업자 대출 금리 <small>{ymKo} 공시 · 신규취급액 기준</small></h3>
      <div className="br-scroll">
        <table className="br-table">
          <thead><tr><th>은행</th><th>보증서담보 평균</th><th>보증 100%</th><th>신용대출 평균</th><th>신용 1~3등급</th></tr></thead>
          <tbody>
            {shown.map(([name, v]) => {
              const link = BANKS.find((b) => b.name === name)?.url ?? BANK_COMPARE_URL;
              const g = v.보증서담보대출!, c = v.신용대출;
              return (
                <tr key={name} className={g.avg === best ? "best" : undefined}>
                  <th><a href={link} target="_blank" rel="noreferrer">{name}</a>{v.note && <small className="br-note">{v.note}</small>}</th>
                  <td><b>연 {g.avg.toFixed(2)}%</b>{g.avg === best && <span className="br-tag">가장 낮아요</span>}</td>
                  <td>{g.by["보증 100%"] != null ? `${g.by["보증 100%"].toFixed(2)}%` : "-"}</td>
                  <td>{c ? `연 ${c.avg.toFixed(2)}%` : "-"}</td>
                  <td>{c?.by["1~3등급"] != null ? `${c.by["1~3등급"].toFixed(2)}%` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 8 && <button type="button" className="br-more" onClick={() => setAll(!all)}>{all ? "접기" : `${rows.length - 8}개 은행 더 보기`}</button>}
      <small className="m-src">출처: <a href={d.url} target="_blank" rel="noreferrer">은행연합회 소비자포털 중소기업대출금리 은행별 비교공시</a> (개인사업자). 공시 직전 3개월에 새로 나간 대출의 평균이라, 내 신용과 보증비율에 따라 실제 금리는 달라요.
        처음 여는 가게는 보통 지역신용보증재단 보증서를 담보로 빌려요.</small>
    </section>
  );
}
