"""Deterministically replace phone numbers in published chat content."""
from __future__ import annotations

import hashlib
import re

COLORS = ("amber", "blue", "coral", "crimson", "emerald", "indigo", "jade", "violet", "silver", "teal")
ANIMALS = ("badger", "bear", "crane", "dolphin", "fox", "koala", "lynx", "otter", "panda", "raven", "tiger", "wolf")
TIMES = ("dawn", "morning", "noon", "afternoon", "dusk", "evening", "night", "midnight")

PHONE_CANDIDATE = re.compile(r"(?<![\w])(?:\+\d[\d\s().-]{6,}\d|\d[\d\s().-]{8,}\d)(?![\w])")
DATE_ONLY = re.compile(r"^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$")


def _alias(number: str) -> str:
    digits = re.sub(r"\D", "", number)
    digest = hashlib.sha256(digits.encode("ascii")).digest()
    return f"{COLORS[digest[0] % len(COLORS)]} {ANIMALS[digest[1] % len(ANIMALS)]} {TIMES[digest[2] % len(TIMES)]}"


def redact_text(value: str) -> str:
    """Replace phone-number-shaped text with a stable alias."""
    def replace(match: re.Match[str]) -> str:
        candidate = match.group(0)
        if DATE_ONLY.fullmatch(candidate):
            return candidate
        digits = re.sub(r"\D", "", candidate)
        if len(digits) < (8 if candidate.startswith("+") else 10) or len(digits) > 15:
            return candidate
        return _alias(candidate)

    return PHONE_CANDIDATE.sub(replace, value)
