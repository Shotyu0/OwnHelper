"""Guardian decision logic, with process control and UI replaced by fakes (nothing is killed or shown)."""
from datetime import datetime
from unittest import mock

import pytest

from helper.cloud import MemoryStore
from helper.gaming.rules import MIN, Rules
from helper.guardian import app as gapp
from helper.guardian import detect
from helper.settings import with_defaults

GAME = detect.GameProc(pid=4242, exe_name="game.exe", appid="105600", title="Terraria")
NOON = datetime(2026, 11, 21, 12, 0).timestamp() * 1000


@pytest.fixture
def env(monkeypatch):
    running: list = []
    calls = {"kill": [], "close": [], "relaunch": [], "dialog": [], "toast": [], "timeup": []}
    monkeypatch.setattr(detect, "find_games", lambda *a, **k: list(running))
    monkeypatch.setattr(detect, "kill", lambda pids: calls["kill"].append(set(pids)) or [])
    monkeypatch.setattr(detect, "close_windows", lambda pids: calls["close"].append(set(pids)) or 1)
    monkeypatch.setattr(detect, "relaunch", lambda appid: calls["relaunch"].append(appid))
    monkeypatch.setattr(detect.SteamLibrary, "refresh", lambda self: setattr(self, "refreshed", 1e18))
    monkeypatch.setattr(gapp.Guardian, "_open_session_dialog",
                        lambda self, game, already_running=False: calls["dialog"].append(already_running))
    monkeypatch.setattr(gapp.Guardian, "_toast", lambda self, text, *a, **k: calls["toast"].append(text))
    monkeypatch.setattr(gapp.Guardian, "_open_timeup",
                        lambda self, sess: calls["timeup"].append(sess["id"]) or setattr(self, "timeup_win", object()))
    wall = {"t": 1_000_000.0}
    monkeypatch.setattr(gapp.time, "time", lambda: wall["t"])
    clock = [NOON]
    store = MemoryStore()
    store.set("meta", "settings", {"gaming": {"requireWorkout": False, "requireKoreanReviews": False,
                                              "requireKoreanNewCards": False}})

    def make():
        return gapp.Guardian(store, root=mock.MagicMock(), clock=lambda: clock[0])

    rules = Rules(store, with_defaults({"gaming": {"requireWorkout": False, "requireKoreanReviews": False,
                                                   "requireKoreanNewCards": False}}), clock=lambda: clock[0])
    return make, running, calls, wall, clock, store, rules


def test_launch_without_session_is_closed_and_asks(env):
    make, running, calls, _, _, store, _ = env
    g = make()
    running.append(GAME)
    g._step()
    assert calls["kill"] == [{4242}] and calls["dialog"] == [False]
    assert store.query("events")[0]["kind"] == "blocked"
    assert store.get("meta", "gaming")["canStart"]          # status published for the web app


def test_session_allows_game_warns_then_times_up(env):
    make, running, calls, _, clock, store, rules = env
    g = make()
    rules.start_session(30, "go to bed")
    running.append(GAME)
    g._step()
    assert not calls["kill"] and not calls["toast"]
    clock[0] += 20 * MIN + 10_000                     # 9:50 left
    g._step()
    g._step()
    assert len(calls["toast"]) == 1 and "10 minutes left" in calls["toast"][0] and "go to bed" in calls["toast"][0]
    clock[0] += 8 * MIN                               # 1:50 left
    g._step()
    assert len(calls["toast"]) == 2 and "2 minutes left" in calls["toast"][1]
    clock[0] += 2 * MIN                               # over
    g._step()
    assert calls["timeup"] and not calls["kill"]


def test_game_already_running_at_startup_gets_grace(env):
    make, running, calls, wall, *_ = env
    running.append(GAME)
    g = make()
    g._step()
    assert calls["dialog"] == [True] and not calls["kill"] and not calls["close"]
    wall["t"] += gapp.STARTUP_GRACE_S + 1
    g._step()
    assert calls["close"] == [{4242}] and not calls["kill"]      # polite close first
    wall["t"] += gapp.CLOSE_GRACE_S + 1
    g._step()
    assert calls["kill"] == [{4242}]                             # then forced


def test_ending_session_from_web_closes_politely(env):
    make, running, calls, _, clock, store, rules = env
    g = make()
    sid = rules.start_session(60, "dinner")
    running.append(GAME)
    g._step()
    store.update("sessions", sid, {"open": False, "endedAt": clock[0], "endReason": "manual"})  # web app button
    g._step()
    assert calls["close"] == [{4242}] and not calls["kill"] and not calls["dialog"]
    running.clear()
    g._step()
    assert any("dinner" in t for t in calls["toast"])


def test_web_request_is_processed(env):
    make, running, calls, _, clock, store, _ = env
    g = make()
    store.set("sessionRequests", "r1", {"minutes": 30, "nextAction": "walk", "status": "pending"})
    g._step()
    assert store.get("sessionRequests", "r1")["status"] == "ok"
    assert store.get("meta", "gaming")["session"]["nextAction"] == "walk"


def test_no_games_expired_session_just_ends(env):
    make, running, calls, _, clock, store, rules = env
    g = make()
    rules.start_session(30, "sleep")
    clock[0] += 31 * MIN
    g._step()
    assert rules.active_session() is None and not calls["timeup"]
