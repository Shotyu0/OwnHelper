from helper.reader import analyze, server
from helper.cloud import MemoryStore


def test_coverage_marks_known_and_unknown_words():
    res = analyze.analyze("저는 매일 공부해요. 고양이가 귀여워요.", {"저", "매일", "공부"}, {"저", "매일", "공부하다"})
    words = {w["text"]: w["status"] for p in res["paragraphs"] for s in p for w in s["words"]}
    assert words["공부해요."] == "known" and words["고양이가"] == "unknown"
    assert 0 < res["coverage"] < 1


def test_reader_page_reads_firestore_words(monkeypatch):
    store = MemoryStore()
    store.set("cards", "a", {"kind": "read", "status": "active", "deck": "vocab", "ko": "공부하다"})
    store.set("cards", "b", {"kind": "read", "status": "new", "deck": "vocab", "ko": "고양이"})
    monkeypatch.setattr(server, "_store", store)
    monkeypatch.setattr(server, "_cache", {"at": 0.0, "known": set(), "deck": set()})
    monkeypatch.setitem(server.config.section("cloud"), "web_url", "https://me.github.io/PersonalHelper/")
    html = server.app.test_client().post("/reader", data={"text": "고양이가 공부해요."}).get_data(as_text=True)
    assert "https://me.github.io/PersonalHelper/#/words?ko=" in html
    assert 'class="w known"' in html
