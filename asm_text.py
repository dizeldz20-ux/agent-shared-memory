"""One tokenizer for every Python consumer of the brain.

`tokenize()` reads a QUERY: it keeps `.`, `-` and `/` inside a token so `src/app.py` and
`index.ts` survive as written. `field_words()` reads the INDEX side and splits further,
because a field is a path, a title or a sentence and a query word has to be able to land
on one word inside it.

hook/asm-prompt-recall.js carries the same two functions for the prompt hook;
tests/fixtures/tokenize.json is run against both implementations.
"""
from __future__ import annotations

import re

STOP = {
    "את", "של", "על", "אני", "אתה", "לא", "כן", "זה", "זאת", "יש", "אין", "מה", "איך", "כמו",
    "גם", "אבל", "כדי", "כל", "הוא", "היא", "הם", "עם", "אם", "רק", "עוד", "שם", "פה", "צריך", "מול",
    "רוצה", "אפשר", "בבקשה", "תעשה", "תבדוק", "עכשיו", "קובץ", "קוד", "עבור", "בתוך", "לפי",
    "the", "and", "for", "with", "that", "this", "from", "have", "has", "you", "are", "was",
    "can", "not", "but", "all", "any", "now", "please", "need", "want", "make", "file", "code",
    "add", "fix", "run", "use", "let", "get", "set", "new", "why", "how", "what", "where",
}
_SPLIT = re.compile(r"[^\w.\-/]+")
_TRIM = re.compile(r"^[.\-/]+|[.\-/]+$")
_PLURAL = re.compile(r"(ים|ות|יה|ית)$")
# The index side splits on the separators the query side keeps.
_WORD = re.compile(r"[^\w]+")


def stem(t: str) -> str:
    """Hebrew is agglutinative: strip one leading particle and a plural ending."""
    s = t
    if len(s) >= 5 and s[0] in "הבלומשכ":
        s = s[1:]
    if len(s) >= 6:
        s = _PLURAL.sub("", s)
    return s


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in _SPLIT.split(str(text or "").lower()):
        t = _TRIM.sub("", raw)
        if len(t) < 3 or t in STOP:
            continue
        t = _TRIM.sub("", stem(t))  # "ב-aws" -> "-aws" -> "aws"
        if len(t) < 3 or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:25]


def field_words(text: str) -> set[str]:
    """Stemmed word set of one indexed field.

    Whole words only. `t in text` used to be the test, so a three-letter query such as
    `gnu` matched the bundled file `gnuplot-q7elnnri.js` and outranked the page that
    actually documents GNU vs BSD.
    """
    return {stem(w) for w in _WORD.split(str(text or "").lower()) if len(w) >= 3}


def query_parts(token: str) -> set[str]:
    """The index-side words a single query token has to cover.

    `src/app.py` is one query token but three words in a path; all of them must be present
    for the token to count as a hit. A token that splits into nothing (too short after
    stemming) keeps itself so it can still match a short field word.
    """
    return field_words(token) or {token}
