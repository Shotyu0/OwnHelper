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
    calls["break"], calls["nudge"] = [], []
    monkeypatch.setattr(gapp.Guardian, "_open_break", lambda self, sets, due: calls["break"].append(due) or (
        setattr(self, "break_win", object()), setattr(self, "break_due", due),
        setattr(self, "break_deadline", wall["t"] + 60 if due else None), setattr(self, "break_kill_at", None)))
    monkeypatch.setattr(gapp.Guardian, "_open_nudge",
                        lambda self, m: calls["nudge"].append(m) or setattr(self, "nudge_win", object()))
    monkeypatch.setattr(gapp.Guardian, "_destroy", lambda self, attr: setattr(self, attr, None))
    wall = {"t": 1_000_000.0, "idle": 0.0}
    monkeypatch.setattr(gapp.time, "time", lambda: wall["t"])
    monkeypatch.setattr(gapp, "idle_seconds", lambda: wall["idle"])
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


def test_open_session_requires_a_set_every_30_minutes(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(0, "dinner")                  # no time limit
    running.append(GAME)
    g._step()
    assert not calls["kill"] and not calls["break"]
    clock[0] += 20 * MIN + 10_000                     # set due in 9:50
    g._step()
    assert any("Set due in 10 min" in t for t in calls["toast"])
    clock[0] += 10 * MIN                              # overdue: prompt with a save-your-game countdown
    g._step()
    assert calls["break"] == [True] and not calls["close"] and not calls["kill"]
    wall["t"] += 61                                   # grace over: asked to close, then force-closed
    g._step()
    assert calls["close"] == [{4242}] and store.query("events")[-1]["kind"] == "set_missed"
    wall["t"] += 16
    g._step()
    assert calls["kill"] == [{4242}]
    rules.log_set([{"name": "Push-up", "reps": 6}], "web")   # logged on the phone: playing is allowed again
    wall["t"] += 3
    g._step()
    assert g.break_win is None and len(calls["kill"]) == 1
    assert g.st["sets"]["dueAt"] == clock[0] + 30 * MIN


def test_fixed_session_ending_first_needs_no_set(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(30, "go to bed")
    running.append(GAME)
    clock[0] += 29 * MIN
    g._step()
    assert not calls["break"] and not any("Set due" in t for t in calls["toast"])


def test_desk_nudge_after_30_minutes_and_counts_getting_up(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    g._step()
    wall["t"] += 29 * 60
    g._step()
    assert not calls["nudge"]
    wall["t"] += 2 * 60
    g._step()
    assert len(calls["nudge"]) == 1 and store.get("daily", "2026-11-21")["moveNudges"] == 1
    wall["t"] += 60
    wall["idle"] = 200                                # away from the keyboard > 3 min: got up
    g._step()
    assert g.nudge_win is None and store.get("daily", "2026-11-21")["moveBreaks"] == 1
    wall["idle"] = 0                                  # back: the clock starts again
    wall["t"] += 10 * 60
    g._step()
    assert len(calls["nudge"]) == 1


def test_no_desk_nudges_while_gaming(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(0, "dinner")
    running.append(GAME)
    g._step()
    wall["t"] += 45 * 60
    g._step()
    assert not calls["nudge"]
