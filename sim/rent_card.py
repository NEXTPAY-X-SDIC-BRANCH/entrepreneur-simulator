"""임대료 카드 할부 (lab:finance). 월세를 카드로 내고 2·3·6개월 할부로 나눠 갚으면 현금이 언제 빠지는지.

카드로 월세를 내면 임대인은 플랫폼에서 현금을 받고, 임차인(사장님)은 카드 대금을 나중에 나눠 낸다.
손익(P&L)의 임대료는 그대로다. 바뀌는 것은 현금이 빠지는 때와 수수료다.

    plan["rent_card"] = {"months": 0 | 2 | 3 | 6, "fee_rate": 0.0~0.2}   # 0 = 지금처럼 현금 (기본)

한 달의 계산 (step):
  - 이번 달 월세는 엔진 영업이익에서 이미 빠졌다. 카드로 냈다면 그 현금은 이번 달에 나가지 않으므로 되돌린다 (+rent).
  - 월세 x (1 + fee_rate)를 months번으로 나눠 다음 달부터 카드 대금으로 낸다 (가정: 카드 결제일이 다음 달).
  - 앞서 카드로 낸 월세의 이번 달 할부금을 낸다 (−paid). 현금으로 돌아가도 남은 할부는 계속 낸다.
  - 시즌이 끝날 때 남은 할부(balance)는 갚아야 할 빚이다. 화면은 이 값을 같이 보여 줘야 한다.

수수료 근거 (업계 자료, 화면에서는 '업계 자료·가정'으로 표시):
  - 서비스 수수료: 한달페이 사업자회원 2.2% (부가세 별도), 벤처스퀘어 2026-09-12 기사.
    카드사 월세 납부 서비스(신한카드 마이월세 등)는 1% 안팎 (아이뉴스24 2020-06-30).
  - 할부 수수료: 신한카드 할부수수료율 안내 페이지 연 12.5% (2개월), 17.5% (3개월), 18.9% (6~9개월).
    게시일이 없어 지금 값인지는 확인하지 못했다. 회원 신용과 카드사 행사(무이자 할부)에 따라 달라진다.
  - 할부 수수료 총액은 원금이 매달 줄어드는 것을 반영해 연 이율 / 12 x (개월 수 + 1) / 2 로 어림한다.
"""
from __future__ import annotations

MONTHS = (0, 2, 3, 6)
SERVICE_FEE = 0.022                                   # 업계 자료: 한달페이 사업자회원 (부가세 별도)
INSTALLMENT_APR = {2: 0.125, 3: 0.175, 6: 0.189}       # 업계 자료: 신한카드 할부수수료율 안내 (게시일 미확인)
MAX_FEE = 0.2
SOURCES = {
    "service_fee": "한달페이 사업자회원 수수료 2.2% (부가세 별도), 벤처스퀘어 2026-09-12",
    "service_fee_low": "카드사 월세 납부 서비스 1% 안팎 (신한카드 마이월세, 아이뉴스24 2020-06-30)",
    "installment_apr": "신한카드 할부수수료율 안내: 2개월 연 12.5%, 3개월 17.5%, 6~9개월 18.9% (게시일 미확인)",
}


def installment_fee(months: int, apr: float | None = None) -> float:
    """할부 수수료 총액 / 원금 (어림). 0개월이면 0."""
    if months not in INSTALLMENT_APR:
        return 0.0
    a = INSTALLMENT_APR[months] if apr is None else apr
    return a / 12 * (months + 1) / 2


def default_fee_rate(months: int, *, interest_free: bool = False, service_fee: float = SERVICE_FEE) -> float:
    """월세 대비 총 수수료율 = 서비스 수수료 + 할부 수수료 (무이자 할부면 서비스 수수료만)."""
    if months not in MONTHS or months == 0:
        return 0.0
    return round(service_fee + (0.0 if interest_free else installment_fee(months)), 5)


def normalize(rc: dict | None) -> dict | None:
    """plan의 rent_card를 검사한다. 쓰지 않으면 None. fee_rate가 없으면 기본 수수료율."""
    if not isinstance(rc, dict):
        return None
    try:
        months = int(rc.get("months", 0) or 0)
    except (TypeError, ValueError):
        return None
    if months not in MONTHS or months == 0:
        return None
    fee = rc.get("fee_rate")
    try:
        fee = default_fee_rate(months) if fee is None else float(fee)
    except (TypeError, ValueError):
        fee = default_fee_rate(months)
    fee = min(max(fee, 0.0), MAX_FEE)
    return {"months": months, "fee_rate": fee}


def step(queue: list[float] | None, rc: dict | None, rent: float) -> dict | None:
    """한 달. queue[i] = i+1달 뒤가 아니라 '다음 달부터' 차례로 낼 할부금 목록 (queue[0] = 이번 달에 낼 돈).

    돌려주는 값 (쓰지 않고 남은 할부도 없으면 None, 그래서 기본 계획의 결과는 그대로다):
      cash_delta  엔진 현금에 더할 값 (+카드로 낸 이번 달 월세 − 이번 달 할부금)
      paid        이번 달 낸 카드 할부금
      charged     이번 달 카드로 낸 월세 (0이면 현금으로 냄)
      fee         이번 달 월세에 붙은 수수료 (나눠서 나가지만 비용은 이번 달 몫으로 센다)
      queue       다음 달부터 낼 할부금
      balance     아직 안 낸 할부 합계 (빚)
    """
    rc = normalize(rc)
    q = [float(x) for x in (queue or [])]
    if rc is None and not q:
        return None
    paid = q[0] if q else 0.0
    rest = q[1:]
    charged = fee = 0.0
    if rc is not None and rent > 0:
        charged = float(rent)
        fee = charged * rc["fee_rate"]
        inst = (charged + fee) / rc["months"]
        while len(rest) < rc["months"]:
            rest.append(0.0)
        for i in range(rc["months"]):
            rest[i] += inst
    return {"cash_delta": charged - paid, "paid": paid, "charged": charged, "fee": fee, "queue": rest,
            "balance": sum(rest), "months": rc["months"] if rc else 0, "fee_rate": rc["fee_rate"] if rc else 0.0}


def schedule(rents: list[float], rc: dict | None) -> list[dict]:
    """월세 목록 전체를 같은 방식으로 (투자·대출 장부와 화면 미리보기용). 쓰지 않으면 빈 목록."""
    if normalize(rc) is None:
        return []
    out, q = [], []
    for r in rents:
        s = step(q, rc, r)
        q = s["queue"]
        out.append(s)
    return out
