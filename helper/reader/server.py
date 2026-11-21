"""The Korean reader, served on the PC (http://localhost:<port>/reader).

Kiwi's language model is ~100 MB, too big for the phone web app, so this one page runs here. It reads which
words you know from Firestore and sends new words to the web app's Words page to be added.
"""
from __future__ import annotations

import time
from urllib.parse import urlencode

from flask import Flask, render_template, request

from .. import config
from . import analyze

app = Flask(__name__)
_store = None
_cache: dict = {"at": 0.0, "known": set(), "deck": set()}


def _words() -> tuple[set[str], set[str]]:
    """(known, in_deck) — refreshed at most every 2 minutes."""
    if time.time() - _cache["at"] > 120 and _store is not None:
        known, deck = set(), set()
        for c in _store.query("cards", [("kind", "==", "read")]):
            ko = (c.get("ko") or "").strip()
            deck.add(ko)
            if c.get("status") == "active" and c.get("deck") in ("vocab", "mined", "hangul"):
                known.add(ko)
                if ko.endswith("하다") and len(ko) > 2:
                    known.add(ko[:-2])  # 공부하다 -> 공부 (Kiwi splits 하다-verbs into noun + 하)
        _cache.update(at=time.time(), known=known, deck=deck)
    return _cache["known"], _cache["deck"]


@app.route("/")
@app.route("/reader", methods=["GET", "POST"])
def reader():
    text = request.form.get("text", "") if request.method == "POST" else ""
    result = None
    if text.strip():
        known, deck = _words()
        result = analyze.analyze(text, known, deck)
    web = config.section("cloud").get("web_url", "").rstrip("/")

    def add_link(word: str, sentence: str = "") -> str:
        q = urlencode({"ko": word, **({"ex": sentence} if sentence else {})})
        return f"{web}/#/words?{q}" if web else ""

    return render_template("reader.html", text=text, result=result, add_link=add_link,
                           connected=_store is not None, web=web)


def run(store, port: int | None = None) -> None:
    global _store
    _store = store
    app.run(host="127.0.0.1", port=port or config.section("reader")["port"], debug=False, use_reloader=False,
            threaded=True)
