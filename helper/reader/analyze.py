"""Reader: paste any Korean text and see which words you already know.

Research basis: readers need roughly 95% of the words in a text to understand it, and about 98% to read
comfortably without a dictionary (Laufer 1989; Hu & Nation 2000). The coverage score tells you whether a
text is at the right level, and clicking unknown words turns them into cards with the sentence as context
("sentence mining").
"""
from __future__ import annotations

import re
import threading

_kiwi = None
_lock = threading.Lock()

# Morpheme tags that carry meaning (vs. particles/endings). See Kiwi's tag set (Sejong-based).
CONTENT_PREFIXES = ("NNG", "NP", "NR", "VV", "VA", "VX", "MAG", "MAJ", "MM", "XR", "IC", "VCN", "VCP")
VERB_PREFIXES = ("VV", "VA", "VX", "VCP", "VCN")


def _get_kiwi():
    global _kiwi
    with _lock:
        if _kiwi is None:
            from kiwipiepy import Kiwi
            _kiwi = Kiwi()
        return _kiwi


def lemma(form: str, tag: str) -> str:
    return form + "다" if tag.startswith(VERB_PREFIXES) else form


def analyze(text: str, known: set[str], in_deck: set[str]) -> dict:
    """Returns paragraphs -> sentences -> words, each word flagged known / unknown / skip."""
    kiwi = _get_kiwi()
    paragraphs = []
    total = known_count = 0
    unknown_counts: dict[str, int] = {}
    for para in re.split(r"\n\s*\n|\n", text.strip()):
        if not para.strip():
            continue
        sentences = []
        for sent in kiwi.split_into_sents(para):
            stext = sent.text
            tokens = kiwi.tokenize(stext)
            words = []
            for m in re.finditer(r"\S+", stext):
                w_start, w_end = m.start(), m.end()
                lemmas = []
                for t in tokens:
                    if not (w_start <= t.start < w_end):
                        continue
                    if t.tag.startswith(CONTENT_PREFIXES):
                        lemmas.append(lemma(t.form, t.tag))
                    elif t.tag.startswith(("NNP", "NNB")) and t.form in in_deck:
                        # Proper/bound nouns (서울, 것, 번) only count when they're in your deck.
                        lemmas.append(t.form)
                unknown = []
                if not lemmas:
                    status = "skip"
                else:
                    unknown = [l for l in lemmas if l not in known and l.removesuffix("다") not in known]
                    total += len(lemmas)
                    known_count += len(lemmas) - len(unknown)
                    status = "unknown" if unknown else "known"
                    for u in unknown:
                        unknown_counts[u] = unknown_counts.get(u, 0) + 1
                words.append({"text": m.group(), "status": status, "lemmas": lemmas, "unknown": unknown})
            sentences.append({"text": stext, "words": words})
        paragraphs.append(sentences)
    coverage = (known_count / total) if total else 0.0
    unknown_list = sorted(unknown_counts.items(), key=lambda kv: -kv[1])
    return {
        "paragraphs": paragraphs,
        "coverage": coverage,
        "content_words": total,
        "unknown": [{"lemma": l, "count": c, "in_deck": l in in_deck} for l, c in unknown_list],
        "verdict": verdict(coverage, total),
    }


def verdict(coverage: float, total: int) -> str:
    if total == 0:
        return "No Korean words found."
    if coverage >= 0.98:
        return "Comfortable — read it for fun and speed."
    if coverage >= 0.95:
        return "Ideal for learning — understandable, with a few new words to mine."
    if coverage >= 0.85:
        return "Challenging — fine for intensive study; mine the most repeated unknown words."
    return "Too hard for now — find something easier, or mine its top words first."
