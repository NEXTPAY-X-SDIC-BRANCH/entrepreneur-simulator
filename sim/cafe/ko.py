"""Korean money text: amounts of 1만원 and more are written with 만 and 억 (41만원, 1억 6,759만원), never as raw won."""
from __future__ import annotations


def won(krw: float) -> str:
    """9,772원 / 1만 320원 (under 10만, kept exact) / 41만원 / 3,785만원 / 1억 6,759만원 / 2억원; 10만 and up round to 만."""
    n = int(round(krw))
    sign, n = ("-" if n < 0 else ""), abs(n)
    if n < 10_000:
        return f"{sign}{n:,}원"
    if n < 100_000:
        man, rest = divmod(n, 10_000)
        return f"{sign}{man}만" + (f" {rest:,}원" if rest else "원")
    eok, man = divmod(round(n / 10_000), 10_000)
    if eok:
        return f"{sign}{eok:,}억" + (f" {man:,}만원" if man else "원")
    return f"{sign}{man:,}만원"
