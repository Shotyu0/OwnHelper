"""Guardian decision logic, with process control and UI replaced by fakes (nothing is killed or shown)."""
from datetime import datetime
from unittest import mock

import pytest

from helper.cloud import MemoryStore
from helper.gaming.rules import MIN, Rules
from helper.guardian import app as gapp
from helper.guardian import detect
from helper.guardian.inputwatch import Presence
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
        setattr(self, "break_win", object()), setattr(self, "break_due", due), setattr(self, "break_opened", wall["t"]),
        setattr(self, "break_deadline", wall["t"] + 60 if due and self._away_idle() < gapp.PRESENT_S else None),
        setattr(self, "break_kill_at", None)))
    monkeypatch.setattr(gapp.Guardian, "_open_nudge",
                        lambda self, m: calls["nudge"].append(m) or setattr(self, "nudge_win", object()))
    monkeypatch.setattr(gapp.Guardian, "_destroy", lambda self, attr: setattr(self, attr, None))
    wall = {"t": 1_000_000.0, "idle": 0.0}
    monkeypatch.setattr(gapp.time, "time", lambda: wall["t"])
    monkeypatch.setattr(gapp, "idle_seconds", lambda: wall["idle"])
    monkeypatch.setattr(gapp, "_beep", lambda: None)

    class SimplePresence:                             # wall["idle"] = seconds since you were really here
        def __init__(self, *a): pass
        def sample(self, *a): pass
        def idle(self, now): return wall["idle"]
    monkeypatch.setattr(gapp, "Presence", SimplePresence)
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


def test_closing_the_game_ends_the_session_after_10_minutes(env):
    make, running, calls, _, clock, store, rules = env
    g = make()
    sid = rules.start_session(0, "chores")             # no length: it used to stay open until you ended it
    running.append(GAME)
    g._step()
    clock[0] += 20 * MIN
    g._step()
    last_played = clock[0]
    running.clear()                                    # you close the game
    clock[0] += 9 * MIN
    g._step()
    assert rules.active_session()                      # a quick restart keeps the session
    clock[0] += 1 * MIN
    g._step()
    s = store.get("sessions", sid)
    assert not s["open"] and s["endReason"] == "no game" and s["endedAt"] == last_played
    running.append(GAME)                               # the next launch asks for a session (and checks the gate)
    g._step()
    assert calls["kill"] == [{4242}] and calls["dialog"] == [False] and not calls["close"]


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


def test_a_night_of_game_keep_awake_input_isnt_sitting_at_the_desk(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(0, "sleep")
    running.append(GAME)
    g.presence = Presence(wall["t"], 0)               # the real thing, fed by each guardian tick
    last = [wall["t"]]

    def tick(sec, user=False, blip=False):
        wall["t"] += sec
        clock[0] += sec * 1000
        if user or blip:
            last[0] = wall["t"]
        wall["idle"] = wall["t"] - last[0]
        g._step()

    tick(2.5, user=True)
    for _ in range(72):                               # an hour in bed; the game pokes the mouse every 50 s
        tick(50, blip=True)
    rules.end_session()                               # morning: you end the session and close the game
    running.clear()
    tick(2.5, user=True)
    tick(1, user=True)
    assert not calls["nudge"]                         # was: "sitting" since last night, so a nudge right away
    for _ in range(31):                               # then 31 min at the desk
        tick(57, user=True)
        tick(3, user=True)
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


def test_treadmill_walk_logs_steps_and_replaces_nudges(env, monkeypatch):
    make, running, calls, wall, clock, store, rules = env
    bars = []
    monkeypatch.setattr(gapp.Guardian, "_show_walk_bar", lambda self: bars.append(self.walk_asking_since)
                        or setattr(self, "walk_bar", object()))
    store.update("meta", "settings", {"moveBreaks": {"treadmill": True, "walkCheckMinutes": 30}})
    g = make()
    g._step()
    wall["t"] += 31 * 60
    g._step()
    assert len(calls["nudge"]) == 1
    g._start_walk("pc")                                   # "Walking now" on the nudge
    assert store.get("meta", "walk")["start"] == clock[0] and store.get("daily", "2026-11-21")["moveBreaks"] == 1
    wall["t"] += 20 * 60
    clock[0] += 20 * 60_000
    g._step()
    assert len(calls["nudge"]) == 1 and bars[-1] is None  # walking: timer bar, no nudges
    wall["t"] += 11 * 60                                  # 31 min: "still walking?"
    clock[0] += 11 * 60_000
    g._step()
    assert bars[-1] is not None
    wall["t"] += 5 * 60                                   # no answer for 5 min: ends when asked (31 min)
    clock[0] += 5 * 60_000
    g._step()
    walk = store.get("daily", "2026-11-21")["walks"]
    (w,) = walk.values()
    assert w["est"] and w["e"] - w["s"] == 31 * 60_000 and w["steps"] == 31 * 85
    assert store.get("meta", "walk")["start"] is None and any("Treadmill walk logged" in t for t in calls["toast"])


def test_walk_ends_when_you_leave_and_learns_your_pace(env, monkeypatch):
    make, running, calls, wall, clock, store, rules = env
    monkeypatch.setattr(gapp.Guardian, "_show_walk_bar", lambda self: setattr(self, "walk_bar", object()))
    g = make()
    g._start_walk("pc")
    wall["t"] += 25 * 60
    clock[0] += 25 * 60_000
    wall["idle"] = 11 * 60                                # left the desk 11 min ago
    g._step()
    (w,) = store.get("daily", "2026-11-21")["walks"].values()
    assert w["e"] - w["s"] == 14 * 60_000
    wall["idle"] = 0
    g._start_walk("pc")
    clock[0] += 20 * 60_000
    g._end_walk(clock[0], steps=2000)                     # typed in from the treadmill display: 100 steps/min
    assert store.get("meta", "walkStats")["cadence"] == round(0.7 * 85 + 0.3 * 100)


def test_gate_updates_when_korean_progress_changes(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    g._step()
    assert not g.dirty
    store.update("daily", "2026-11-21", {"gameMinutes": 5})   # the guardian's own write: ignored
    assert not g.dirty
    store.update("daily", "2026-11-21", {"reviews": 1})       # an answer in the web app: re-check now
    assert g.dirty


def test_dinner_break_holds_the_set_until_after_dinner(env):
    make, running, calls, wall, clock, store, rules = env
    clock[0] = datetime(2026, 11, 21, 18, 30).timestamp() * 1000
    g = make()
    rules.start_session(0, "dishes")
    running.append(GAME)
    g._step()
    clock[0] += 30 * MIN + 5000                       # set overdue: the prompt opens
    g._step()
    assert calls["break"] == [True]
    g.hotkeys.put("dinner")                           # Ctrl+Alt+D: food's here
    g._step()
    assert g.break_win is None and store.get("daily", "2026-11-21")["dinner"]["src"] == "pc"
    assert g.st["dinner"]["active"] and g.st["sets"]["dueAt"] == store.get("daily", "2026-11-21")["dinner"]["end"]
    wall["t"] += 61
    clock[0] += 20 * MIN                              # eating and playing: no prompt, nothing closed
    g._step()
    assert calls["break"] == [True] and not calls["close"] and not calls["kill"]
    g.hotkeys.put("dinner")                           # done eating: the postponed set is due now
    g._step()
    assert not g.st["dinner"]["active"] and calls["break"] == [True, True]


def test_afk_pauses_sets_and_never_closes_the_game_while_away(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    sid = rules.start_session(0, "sleep")
    running.append(GAME)
    g._step()

    def later(sec, idle):
        wall["t"] += sec
        clock[0] += sec * 1000
        wall["idle"] = idle
        g._step()

    later(31 * 60, 90)                                # walked off 90 s ago; the set came due meanwhile
    assert calls["break"] == [True] and g.break_deadline is None
    later(120, 210)                                   # still away: no countdown, nothing closed
    later(120, 330)                                   # 5+ min: away since the last input; the clock rewinds
    g._step()
    assert not calls["close"] and not calls["kill"] and g.break_win is None
    assert store.get("sessions", sid)["awaySince"] == NOON + 29.5 * MIN
    toasts = len(calls["toast"])
    later(3600, 3930)                                 # an hour of idling in-game
    assert g.st["sets"]["playedSince"] == 29.5 and len(calls["toast"]) == toasts and calls["break"] == [True]
    later(0, 1)                                       # back at the keyboard
    assert store.get("sessions", sid)["away"][0]["e"] == clock[0] - 1000
    later(60, 0)                                      # the half minute left runs out: the set is due as usual
    assert calls["break"] == [True, True] and g.break_deadline is not None
    later(61, 0)
    assert calls["close"] == [{4242}]


def test_a_lone_input_every_50_s_is_not_you():
    """AION 2 sends a zero-move mouse event every 50 s while it runs (keep-awake). Sampled every half second."""
    p = Presence(1000.0, 0)                           # last really here at t=1000
    for k in range(1, 9):
        blip = 1000 + 50 * k
        for i in range(100):
            now = blip + i * 0.5
            p.sample(now, now - blip)
    assert p.idle(1450) == 450
    p.sample(1460, 0)                                 # one moment (a bumped mouse) isn't enough
    assert p.idle(1460) == 460
    p.sample(1461, 0)                                 # a second moment soon after: you're back
    assert p.idle(1461) == 0
    for i in range(1, 20):                            # using the PC normally
        p.sample(1461 + i * 0.5, 0.2)
    assert p.idle(1471) < 1


def test_game_keep_awake_input_doesnt_stop_afk_or_start_the_countdown(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    sid = rules.start_session(0, "sleep")
    running.append(GAME)
    g._step()
    last = [wall["t"]]

    def tick(sec=2.5, user=False, blip=False):
        wall["t"] += sec
        clock[0] += sec * 1000
        if user or blip:
            last[0] = wall["t"]
        wall["idle"] = wall["t"] - last[0]
        g._step()

    tick(27 * 60, user=True)                          # played 27 min
    g.presence = Presence(wall["t"], 0)               # from here, the real thing, fed by each guardian tick
    tick(user=True)
    left = clock[0]
    for i in range(1, 6 * 24 + 1):                    # 6 min on the bed; the game pokes the mouse every 50 s
        tick(blip=i % 20 == 0)
    assert calls["break"] == [True]                   # the set came due at minute 30 while away...
    assert not calls["close"] and not calls["kill"]   # ...and the pokes never started the countdown
    assert g.break_win is None                        # AFK at 5 min: the clock rewound, the prompt went away
    assert store.get("sessions", sid)["awaySince"] == pytest.approx(left, abs=1)
    tick(user=True)
    tick(user=True)                                   # back
    s = store.get("sessions", sid)
    assert s["awaySince"] is None and s["away"][0]["s"] == pytest.approx(left, abs=1)
    assert g.st["sets"]["playedSince"] == pytest.approx(27, abs=0.1)


def test_set_prompt_countdown_starts_when_you_come_back(env):
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(0, "sleep")
    running.append(GAME)
    g._step()
    wall["t"] += 30 * 60 + 5
    clock[0] += (30 * 60 + 5) * 1000
    wall["idle"] = 60                                 # stepped away a minute before it came due
    g._step()
    assert calls["break"] == [True] and g.break_deadline is None
    wall["t"] += 50
    wall["idle"] = 3                                  # back (before 5 min): input after the prompt opened
    g._step()
    assert g.break_deadline == wall["t"] + 60 and not calls["close"]
    wall["t"] += 61
    g._step()
    assert calls["close"] == [{4242}]
    back = gapp.hms((wall["t"] - 61 - 3) * 1000)
    missed = [e for e in store.query("events") if e["kind"] == "set_missed"]
    assert f"input at {back} started the 60s countdown" in missed[0]["detail"]    # the phone shows why it closed


def test_no_desk_nudges_while_eating(env):
    make, running, calls, wall, clock, store, rules = env
    clock[0] = datetime(2026, 11, 21, 18, 30).timestamp() * 1000
    g = make()
    g._step()
    rules.start_dinner("web")                         # from the phone, eating at the desk
    g._step()
    wall["t"] += 40 * 60
    g._step()
    assert not calls["nudge"]


def test_no_set_warnings_or_prompts_during_a_treadmill_walk(env, monkeypatch):
    from helper import walks
    monkeypatch.setattr(gapp.Guardian, "_show_walk_bar", lambda self: setattr(self, "walk_bar", object()))
    make, running, calls, wall, clock, store, rules = env
    g = make()
    rules.start_session(0, "sleep")
    running.append(GAME)
    g._step()

    def later(sec):
        wall["t"] += sec
        clock[0] += sec * 1000
        g._step()

    later(15 * 60)
    walks.start_walk(store, clock[0])                 # Ctrl+Alt+W with the game open
    later(3)
    assert g.st["sets"]["walkingSince"] and g.st["sets"]["dueAt"] is None
    later(40 * 60)
    later(5)
    assert not any("Set due" in t for t in calls["toast"]) and not calls["break"]
    walks.stop_walk(store, clock[0])
    later(3)
    assert g.st["sets"]["dueAt"] == pytest.approx(clock[0] + 15 * MIN, abs=5000)   # 15 min of play left
    later(15 * 60 + 30)                               # due, and the prompt opens
    assert calls["break"] == [True]
    walks.start_walk(store, clock[0])                 # you owe it, then start walking: the prompt goes away
    later(3)
    assert g.break_win is None and g.st["sets"]["dueAt"] is None
    later(20 * 60)
    assert walks.open_walk(store)                     # not ended by the last walk's stale "still walking?" timer
    assert calls["break"] == [True] and not calls["kill"] and not calls["close"]
    walks.stop_walk(store, clock[0])                  # not cancelled: due the moment you step off
    later(3)
    assert calls["break"] == [True, True]
