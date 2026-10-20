"""Korean particles for templated sentences (받침-aware), and the 만원 money form."""

MINUS = "\u2212"   # the UI minus (−), as in web/src/v2/format.ts and the yaml notes; never the ASCII hyphen


def man_won(v: float, plus: bool = False) -> str:
    """Won in 만원. Rounds first, then picks the sign, so -3,000 reads '0만원' (never '-0만원').
    plus=True marks gains with '+' (deltas)."""
    r = round(v / 1e4)
    return f"{MINUS if r < 0 else '+' if plus and r > 0 else ''}{abs(r):,}만원"


def won_ko(v: float) -> str:
    """Whole won, rounded first, with the UI minus."""
    r = round(v)
    return f"{MINUS if r < 0 else ''}{abs(r):,}원"


def _batchim(word: str) -> int | None:
    """0 = no final consonant, 8 = ㄹ, other = has one; None for non-Hangul endings (treated by digit).
    Trailing closing brackets, parens and quotes are skipped: '…이름 기준)' takes its particle from 준 (은), not ')'.
    A trailing digit is read aloud (2 = 이 -> 가), so digits are not skipped."""
    w = word.strip().rstrip(")]}>\"'」』” ")
    if not w:
        return None
    c = w[-1]
    if "가" <= c <= "힣":
        return (ord(c) - 0xAC00) % 28
    digits = {"0": 1, "1": 8, "2": 0, "3": 1, "4": 0, "5": 0, "6": 1, "7": 8, "8": 8, "9": 0}  # 영 일 이 삼 사 오 육 칠 팔 구
    return digits.get(c)


def ro(word: str) -> str:
    """word + 로/으로"""
    b = _batchim(word)
    return f"{word}{'로' if b in (0, 8, None) else '으로'}"


def ieyo(word: str) -> str:
    """word + 예요/이에요"""
    return f"{word}{'예요' if _batchim(word) in (0, None) else '이에요'}"


def ga(word: str) -> str:
    """word + 가/이"""
    return f"{word}{'가' if _batchim(word) in (0, None) else '이'}"


def eun(word: str) -> str:
    """word + 는/은"""
    return f"{word}{'는' if _batchim(word) in (0, None) else '은'}"


def ira(word: str) -> str:
    """word + 라/이라"""
    return f"{word}{'라' if _batchim(word) in (0, None) else '이라'}"


def myeon(word: str) -> str:
    """word + 면/이면"""
    return f"{word}{'면' if _batchim(word) in (0, 8, None) else '이면'}"


def wa(word: str) -> str:
    """word + 와/과"""
    return f"{word}{'와' if _batchim(word) in (0, None) else '과'}"


def yeosseoyo(word: str) -> str:
    """word + 였어요/이었어요"""
    return f"{word}{'였어요' if _batchim(word) in (0, None) else '이었어요'}"


def eul(word: str) -> str:
    """word + 를/을"""
    return f"{word}{'를' if _batchim(word) in (0, None) else '을'}"
