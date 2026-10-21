"""투자·대출 계층: 엔진의 월 영업이익을 창업자의 현금과 투자금 회수 시점으로 바꾼다.

엔진(sim.season)의 현금은 '운영자금'이고, 영업이익은 대표자 가상 임금(cst_owner_imputed_wage)을 뺀 값이다.
창업자가 알고 싶은 것은 (1) 문을 열 때 얼마가 묶이는지, (2) 대출 이자와 원금까지 낸 뒤 매달 현금이 어떻게
움직이는지, (3) 묶인 돈을 언제 되찾는지다. 이 모듈은 엔진 밖에서 그 셋을 계산한다. 엔진은 건드리지 않는다.

    ledger = venture_ledger(monthly_op, invest, loan, owner_draw=..., imputed_owner_wage=...)

회수 시점은 엔진이 계산한 개월 뒤를 마지막 3개월 평균으로 이어 붙인 외삽이다. 값에는 estimated=True가 붙고,
화면에서는 '추정'이라고 표시해야 한다.
"""
from __future__ import annotations

from math import ceil

from sim import rent_card as _rent_card  # lab:finance

# 문 닫을 때 돌려받는 돈 (회수 계산에서 '묶인 돈'과 '쓴 돈'을 구분한다)
REFUNDABLE = ("deposit",)
HORIZON_MONTHS = 120  # 회수 외삽의 한계 (10년). 그 안에 못 되찾으면 None


def loan_schedule(loan: dict | None, months: int) -> list[dict]:
    """대출 월별 이자와 원금. loan: {principal, annual_rate, term_months, grace_months}.

    grace_months 동안은 이자만 내고, 이후 term_months까지 원금을 균등하게 갚는다 (원금균등).
    grace_months가 term_months 이상이면 만기까지 이자만 낸다 (ChangeUp 목업의 기본 방식).
    """
    out = [{"interest": 0.0, "principal": 0.0, "balance": 0.0} for _ in range(months)]
    if not loan or loan.get("principal", 0) <= 0:
        return out
    p0 = float(loan["principal"])
    rate = float(loan.get("annual_rate", 0.06)) / 12
    term = int(loan.get("term_months", 60))
    grace = int(loan.get("grace_months", term))
    repay_n = max(0, term - grace)
    bal = p0
    for i in range(months):
        interest = bal * rate
        princ = p0 / repay_n if repay_n and grace <= i < term else 0.0
        princ = min(princ, bal)
        out[i] = {"interest": interest, "principal": princ, "balance": bal - princ}
        bal -= princ
    return out


def venture_ledger(monthly_op: list[float], invest: dict, loan: dict | None = None, *, own_capital: float,
                   owner_draw: float = 0.0, imputed_owner_wage: float = 0.0, horizon: int = HORIZON_MONTHS,
                   rent_card: dict | None = None, monthly_rent: list[float] | None = None) -> dict:
    """월별 현금 장부와 투자금 회수 시점.

    monthly_op        엔진이 낸 월 영업이익 (대표자 가상 임금을 뺀 값)
    invest            {항목: 원}. deposit(보증금)은 돌려받는 돈, 나머지는 쓴 돈
    loan              loan_schedule 참고. 대출금은 시작 현금에 들어간다
    own_capital       가진 돈
    owner_draw        사장이 실제로 가져가는 월 생활비 (현금 유출)
    imputed_owner_wage 엔진이 영업이익에서 뺀 대표자 가상 임금. 현금 흐름에서는 되돌려 놓고 owner_draw만 뺀다
    rent_card         lab:finance 월세 카드 할부 {months, fee_rate} (sim.rent_card). monthly_rent(월세, 원)와 같이 준다.
                      현금은 할부 일정대로 움직이고, 수수료는 회수 계산에서 비용으로 뺀다. 남은 할부는 card_balance로 돌려준다
    """
    rents = [float(x) for x in monthly_rent if isinstance(x, (int, float))] if isinstance(monthly_rent, list) else []
    rc_rows = _rent_card.schedule(rents, rent_card) if rents else []  # lab:finance
    spent = sum(v for k, v in invest.items() if k not in REFUNDABLE)
    deposit = sum(invest.get(k, 0.0) for k in REFUNDABLE)
    total_out = spent + deposit
    principal_in = float(loan["principal"]) if loan else 0.0
    cash = own_capital + principal_in - total_out
    n = len(monthly_op)
    sched = loan_schedule(loan, max(n, horizon))
    rows, cum_cash_op, low_cash, low_month = [], 0.0, cash, 0
    for i, op in enumerate(monthly_op):
        cash_op = op + imputed_owner_wage - owner_draw           # 사장 생활비까지 뺀 영업 현금
        debt = sched[i]["interest"] + sched[i]["principal"]
        rc = rc_rows[i] if i < len(rc_rows) else None                 # lab:finance 월세 카드 할부
        net = cash_op - debt + (rc["cash_delta"] if rc else 0.0)
        cash += net
        cum_cash_op += cash_op - sched[i]["interest"] - (rc["fee"] if rc else 0.0)  # 이자·카드 수수료는 장사 비용
        if cash < low_cash:
            low_cash, low_month = cash, i + 1
        rows.append({"month": i + 1, "op": op, "cash_op": cash_op, "interest": sched[i]["interest"],
                     "principal": sched[i]["principal"], "net": net, "cash": cash, "cum_recovered": cum_cash_op,
                     **({"rent_card_paid": rc["paid"], "rent_card_charged": rc["charged"], "rent_card_fee": rc["fee"],
                         "card_balance": rc["balance"]} if rc else {})})

    payback = {"month": None, "estimated": True, "run_rate": None, "within_engine": False, "reason": ""}
    if spent <= 0:
        payback.update(month=0, estimated=False, reason="쓴 돈이 없어 되찾을 것이 없음")
    else:
        hit = next((r["month"] for r in rows if r["cum_recovered"] >= spent), None)
        if hit is not None:
            payback.update(month=hit, estimated=False, within_engine=True)
        else:
            tail = [r["cash_op"] - r["interest"] - r.get("rent_card_fee", 0.0) for r in rows[-3:]] or [0.0]
            run = sum(tail) / len(tail)
            payback["run_rate"] = run
            if run <= 0:
                payback["reason"] = "마지막 3개월 평균이 적자라 이 속도로는 되찾지 못함"
            else:
                need = spent - (rows[-1]["cum_recovered"] if rows else 0.0)
                m = n + ceil(need / run)
                if m <= horizon:
                    payback["month"] = m
                else:
                    payback["reason"] = f"{horizon}개월 안에 되찾지 못함"
    return {
        "rows": rows,
        "start_cash": own_capital + principal_in - total_out,
        "spent": spent, "deposit": deposit, "loan_principal": principal_in,
        "end_cash": rows[-1]["cash"] if rows else own_capital + principal_in - total_out,
        "lowest_cash": low_cash, "lowest_month": low_month,
        "payback": payback,
        **({"rent_card": {**_rent_card.normalize(rent_card), "fee_total": sum(r["fee"] for r in rc_rows[:n]),
                          "card_balance": rc_rows[min(n, len(rc_rows)) - 1]["balance"] if rc_rows and n else 0.0}}
           if rc_rows else {}),  # lab:finance
        "note": "회수 시점은 엔진이 계산한 개월 뒤를 마지막 3개월 평균으로 이어 붙인 추정이다" if payback["estimated"] else "",
    }
