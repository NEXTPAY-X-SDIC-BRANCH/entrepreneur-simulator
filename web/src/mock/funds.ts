// 예비 창업자가 알아볼 만한 정책자금. 출처: 예비창업 정책자금 정리표(중진공·소진공·신보·서울신보·미소금융 안내 자료)
// (업계 글과 기관 안내를 모은 정리표, 시트의 출처 번호 S1~S31). 업종과 상관없는 제도라 고깃집에도 그대로 쓴다.
// 한도·금리·접수 시기는 기관 공고가 기준이고, 자료마다 다르게 적힌 값은 그대로 두었다. 신청 전에 공고 원문을 확인하세요.
export type Fund = {
  name: string; org: string; who: string; pre: "가능" | "등록 후" | "조건부"; youth?: boolean; // youth: 만 39세 이하 조건
  program?: boolean; // 대출이 아니라 교육·선발 프로그램 (모자란 돈 탭에서 대출과 따로 보여 준다)
  limit: string; terms: string; where: string; note: string;
  rate?: [number, number]; // 연 금리 % 범위 (terms 문장에 적힌 값). 화면에서 ECOS 은행 평균과 견준다
  floating?: boolean; // 기준금리 연동 변동금리
  url?: string; // 공식 안내·신청 페이지 (2026-10-20 접속 확인). 우리는 링크만 걸고 신청을 받지 않는다
};

export const FUNDS: Fund[] = [
  { name: "청년전용창업자금", rate: [2, 3.9], url: "https://www.kosmes.or.kr/nsh/SH/SBI/SHSBI004M0.do", org: "중소벤처기업진흥공단", who: "만 39세 이하 예비창업자 또는 업력 3년 미만", pre: "가능", youth: true,
    limit: "최대 1억원 (제조업 등 우대 업종은 2억원)", terms: "연 2~3%대, 6년 (거치 3년 + 상환 3년). 자료마다 금리가 달라요.", where: "중진공 온라인 신청 (kosmes.or.kr), 서울 지역본부",
    note: "상시 접수, 예산이 떨어지면 마감. 사업계획서와 사업성 평가가 있어요." },
  { name: "프렙 아카데미", program: true, url: "https://www.seoul.go.kr/policy/view.do?id=77&lan=KO", org: "서울시 · 서울신용보증재단", who: "서울 거주 만 19~39세 외식업 예비창업 청년", pre: "가능", youth: true,
    limit: "교육 12주 뒤 서울신보 연계 최대 7,000만원 융자", terms: "장기·저리 (세부 금리 미확인)", where: "서울시 소상공인 종합지원 포털",
    note: "서류와 면접으로 뽑아요. 차기 기수 일정은 아직 확인되지 않았어요." },
  { name: "모두의 창업 프로젝트 로컬트랙", program: true, url: "https://www.modoo.or.kr/", org: "중소벤처기업부", who: "예비창업자 (사업자등록이 없어야 해요)", pre: "가능",
    limit: "1라운드 활동자금 200만원, 최종 우승 상금 최대 1억원", terms: "대출이 아니에요 (교육·멘토링 포함)", where: "modoo.or.kr",
    note: "수도권 선발 비중이 약 10%라 서울은 경쟁이 센 편이에요." },
  { name: "예비창업가육성보증", url: "https://www.kodit.co.kr/", org: "신용보증기금", who: "창업 전 6개월 이내 예비창업가", pre: "조건부",
    limit: "한도 10억원 (운전 + 시설, 실제 금액은 심사로 정해져요)", terms: "보증비율 90~100%, 보증료율 0.3~0.7%p 차감", where: "신보 서울 영업점",
    note: "'전문·기술형 창업' 구분 아래 있어서 일반 음식점이 해당하는지는 상담으로 확인해야 해요." },
  { name: "미소금융 창업자금", rate: [4.5, 4.5], url: "https://www.kinfa.or.kr/financialProduct/smileFinanceFunds.do", org: "서민금융진흥원", who: "소득·신용이 취약한 창업 예정자 (신용평점 하위 20% 이하 등)", pre: "조건부",
    limit: "최대 7,000만원 (임차보증금 포함)", terms: "연 4.5% 고정, 창업교육 12시간 필수", where: "서민금융 잇다 앱, 1397",
    note: "신용이 좋은 청년은 대상이 아닐 수 있어요. 앱에서 자가진단을 먼저 해 보세요." },
  { name: "청년고용연계자금", floating: true, url: "https://www.semas.or.kr/web/SUP01/SUP0103/SUP010301.kmdc", org: "소상공인시장진흥공단", who: "만 39세 이하 청년 소상공인 또는 청년 직원을 고용한 가게", pre: "등록 후", youth: true,
    limit: "대표 최대 7,000만원", terms: "분기별 기준금리에 연동하는 변동금리", where: "소상공인정책자금 누리집, 지역센터",
    note: "사업자등록을 마친 뒤에 신청해요. 분기마다 접수하고 예산이 떨어지면 마감해요." },
  { name: "서울시 중소기업육성자금 (창업기업자금)", rate: [2, 3.3], url: "https://www.seoulshinbo.co.kr/", org: "서울시 · 서울신용보증재단", who: "서울 사업장을 둔 중소기업·소상공인", pre: "등록 후",
    limit: "자금별 상이", terms: "직접융자 연 2.0~3.3%", where: "서울신보 앱·누리집",
    note: "2026년 1월~12월, 예산이 떨어지면 마감. 창업기업자금의 세부 한도는 공고 별표를 확인하세요." },
  { name: "청년 소상공인 보증부 대출", url: "https://www.koreg.or.kr/adit/onTact/onTact_01.html", org: "신용보증재단중앙회 · 신한은행", who: "6개월 이상 영업한 만 39세 이하 청년 소상공인", pre: "등록 후", youth: true,
    limit: "최대 5,000만원", terms: "보증료 전액 지원", where: "신한은행, 신용보증재단",
    note: "문을 연 지 6개월 뒤에 쓸 수 있는 후속 제도예요." },
];
export const FUNDS_SRC = "예비창업 정책자금 정리표 (기관 안내와 업계 글 포함, 원문 확인 필요)";

// 지역신용보증재단 보증서 대출을 방문 없이 앱으로 신청할 수 있는 은행 (신용보증재단중앙회 '비대면 보증' 안내, 2026-10-20 확인).
// 신청은 은행 앱에서 하므로 링크는 각 은행 앱의 Google Play 안내 페이지다. 은행 인터넷뱅킹·상품 페이지는 들어가자마자
// 보안 프로그램(TouchEn·Veraport·Delfino 등) 설치를 요구할 수 있어 쓰지 않는다 (2026-10-21 확인, 앱 이름도 이날 기준).
// 대출 중개로 보이지 않게 은행을 추천하거나 순서를 매기지 않는다 (가나다순).
const PLAY = (id: string) => `https://play.google.com/store/apps/details?id=${id}&hl=ko`;
export const BANKS: { name: string; app: string; url: string }[] = [
  { name: "KB국민은행", app: "KB스타뱅킹", url: PLAY("com.kbstar.kbbank") },
  { name: "IBK기업은행", app: "i-ONE Bank", url: PLAY("com.ibk.android.ionebank") },
  { name: "NH농협은행", app: "NH올원뱅크", url: PLAY("com.nonghyup.nhallonebank") },
  { name: "신한은행", app: "신한 슈퍼SOL", url: PLAY("com.shinhan.sbanking") },
  { name: "우리은행", app: "우리WON뱅킹", url: PLAY("com.wooribank.smart.npib") },
  { name: "하나은행", app: "하나원큐", url: PLAY("com.hanabank.oqf") },
];
export const BANK_GUARANTEE_URL = "https://www.koreg.or.kr/adit/onTact/onTact_01.html";
// 은행연합회 소비자포털: 은행별 중소기업(개인사업자) 운전자금 대출금리 비교공시 (보증서담보·신용·마이너스)
export const BANK_COMPARE_URL = "https://portal.kfb.or.kr/compare/loan_snmindustry_4.php";
