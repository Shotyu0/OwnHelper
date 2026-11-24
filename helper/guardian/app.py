"""The guardian: a background loop that only lets games run inside a session you chose in advance.

  game starts, no session  -> game is closed right away, session dialog opens (gate, length, "then I will...")
  session running          -> warnings at 10 and 2 minutes left (fixed-length sessions)
  time's up                -> 60 s "save your game" countdown, then the game is asked to close,
                              then force-closed 15 s later
  set due (every 30 min    -> warnings at 10 and 2 minutes, then a "set time" prompt; if the set isn't logged
   of play)                   within 60 s the game is closed, and stays closed until it is
  away from the PC         -> no keyboard/mouse for 5 min: time away doesn't count toward the next set, and an
                              overdue set's countdown waits until you're back (input again), so AFK never closes it
  dinner (6-9 PM, once     -> "Eating dinner" (session dialog, set prompts, Ctrl+Alt+D, or the phone): sets wait
   a day)                     while you eat; play during it doesn't count. Ctrl+Alt+D again when you're done
  override                 -> 60 s wait + written reason; logged on the dashboard; limited per day
  at the desk 30 min       -> a small nudge to get up and walk for a few minutes (not while gaming); with a
                              treadmill desk: walk while working. "Walking now" (or Ctrl+Alt+W) logs a treadmill
                              walk with a small timer + Stop, because the watch barely counts steps when your
                              hands rest on the desk (helper/walks.py)

Rules and data come from Firestore (helper/gaming/rules.py). Sessions can also be requested from the
web app; the guardian checks them against the same rules and publishes its status for the web app.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import logging
import queue
import sys
import threading
import time
import tkinter as tk
import webbrowser

import psutil

from .. import config, walks
from ..cloud import Increment
from ..gaming.rules import Rules, RuleError, now_ms
from ..settings import day_start, with_defaults
from . import detect
from .inputwatch import InputWatch, Presence, fmt_idle

TICK_MS = 2500
CLOSE_GRACE_S = 15
STARTUP_GRACE_S = 120
PUBLISH_EVERY_S = 60
BG, CARD, FG, MUTED = "#15171c", "#1f232b", "#e8eaed", "#9aa0a6"
GOOD, BAD, ACCENT, WARN = "#4ade80", "#f87171", "#60a5fa", "#fbbf24"
FONT = "Segoe UI"

log = logging.getLogger("guardian")

NUDGE_IDEAS = [
    "Walk to the kitchen and refill your water.",
    "Walk a lap of the house, or take the stairs.",
    "Walk while you think through the next bit of code.",
    "15 squats, then a short walk.",
    "Step outside for a few minutes of daylight.",
]


class _LastInput(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def idle_seconds() -> float:
    """Seconds since the last keyboard or mouse input (Windows)."""
    if sys.platform != "win32":
        return 0.0
    li = _LastInput()
    li.cbSize = ctypes.sizeof(li)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li)):
        return 0.0
    return ((ctypes.windll.kernel32.GetTickCount() - li.dwTime) & 0xFFFFFFFF) / 1000.0


PRESENT_S = 10                 # input this recently: you're at the PC (a set prompt's countdown can start)
WALK_IDLE_END_S = 10 * 60      # away from the PC this long during a walk: it ended when you left
WALK_ASK_TIMEOUT_S = 5 * 60     # "still walking?" unanswered this long: ended when asked
NO_GAME_END_S = 10 * 60         # no game running this long: the session is over (the next launch asks, and gates, again)


HOTKEYS = {1: ("W", "walk"), 2: ("D", "dinner")}


def hotkey_thread(events: queue.Queue) -> None:
    """Global hotkeys (Windows, on their own message loop): Ctrl+Alt+W toggles a treadmill walk,
    Ctrl+Alt+D the dinner break."""
    if sys.platform != "win32":
        return
    user32 = ctypes.windll.user32
    ok = False
    for hid, (key, what) in HOTKEYS.items():
        if user32.RegisterHotKey(None, hid, 0x2 | 0x1 | 0x4000, ord(key)):   # CONTROL | ALT | NOREPEAT
            ok = True
        else:
            log.warning("Ctrl+Alt+%s is already used by another app; use the web app for %s instead.", key, what)
    if not ok:
        return
    msg = ctypes.wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        if msg.message == 0x0312 and msg.wParam in HOTKEYS:   # WM_HOTKEY
            events.put(HOTKEYS[msg.wParam][1])


def clock_label(ms: float) -> str:
    """Epoch ms -> "7:15 PM"."""
    return time.strftime("%I:%M %p", time.localtime(ms / 1000)).lstrip("0")


def hms(ms: float) -> str:
    """Epoch ms -> "10:27:05" (logs)."""
    return time.strftime("%H:%M:%S", time.localtime(ms / 1000))


def plan_text(items) -> str:
    """Same wording as web/js/workout.js setText."""
    return " + ".join((f"{i['reps']} × " if i.get("reps") else "") + str(i.get("name")) + (f" ({i['note']})" if i.get("note") else "")
                      for i in items or []) or "a short set"


def minutes_label(m) -> str:
    return f"{m} min" if m and m > 0 else "No limit"


def _no_activate(win) -> None:
    """Keep small pop-ups from stealing keyboard focus while you're typing."""
    if sys.platform != "win32":
        return
    try:
        win.update_idletasks()
        u = ctypes.windll.user32
        hwnd = u.GetParent(win.winfo_id()) or win.winfo_id()
        u.SetWindowLongW(hwnd, -20, u.GetWindowLongW(hwnd, -20) | 0x08000000 | 0x80)  # NOACTIVATE | TOOLWINDOW
    except Exception:
        pass


def _beep() -> None:
    try:
        import winsound
        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
    except Exception:
        pass


class Guardian:
    def __init__(self, store, root: tk.Tk | None = None, clock=now_ms):
        self.store, self.clock = store, clock
        self.root = root or tk.Tk()
        self.root.withdraw()
        g = config.section("guardian")
        self.allow = {x.lower() for x in g["allow_exes"]}
        self.allow_apps = {str(x).lower() for x in g["allow_apps"]}
        self.extra = {x.lower() for x in g["extra_game_exes"]}
        self.lib = detect.SteamLibrary()
        self.lib.refresh()
        self.rules = Rules(store, with_defaults(None), clock)
        self.open_sessions: list[dict] = []
        self.requests: queue.Queue = queue.Queue()
        self.dirty = True   # status needs publishing
        self.last_publish = 0.0
        self.session_dlg: tk.Toplevel | None = None
        self.override_dlg: tk.Toplevel | None = None
        self.timeup_win: tk.Toplevel | None = None
        self.st: dict | None = None          # last published status (rules.status())
        # set due during play
        self.break_win: tk.Toplevel | None = None
        self.break_due = False               # opened because the set is overdue (vs. "do it early")
        self.break_deadline: float | None = None   # None while you're away: the countdown starts when you're back
        self.break_opened = 0.0
        self.away_sid: str | None = None           # session marked away (AFK)
        self.game_seen: tuple[str | None, float] = (None, 0.0)   # (session id, clock ms a game last ran in it)
        self.break_kill_at: float | None = None
        self.break_story = ""                      # why the countdown started, for the set_missed event
        self.input_watch = InputWatch()            # logs which device ended an idle stretch (helper.log)
        self.presence = Presence(time.time(), idle_seconds())   # ignores lone fake input (AION 2 keep-awake)
        self.last_set_reminder = 0.0
        # get-up nudges while working
        self.nudge_win: tk.Toplevel | None = None
        self.sit_start: float | None = None
        self.nudge_at: float | None = None
        self.snooze_until = 0.0
        self.sit_reset = False
        self.nudges_shown = 0
        # treadmill walks (helper/walks.py)
        self.walk: dict | None = None
        self.walk_bar: tk.Toplevel | None = None
        self.walk_bar_mode = ""
        self.walk_check_at: float | None = None
        self.walk_asking_since: float | None = None
        self.walk_stopping = False
        self.hotkeys: queue.Queue = queue.Queue()
        # gate inputs that change while you study/train today -> re-check the gate right away
        self.gate_day = ""
        self.gate_unsubs: list = []
        self.daily_key = None
        self.warned: set[tuple] = set()
        self.closing_until: float | None = None
        self.closing_next_action = ""
        self.kill_fail_noted = False
        # Games already running when the guardian starts get a short grace period instead of an instant close.
        self.startup_pids = {g.pid for g in self._scan()}
        self.startup_grace_until = time.time() + STARTUP_GRACE_S
        self._check_offline_gap()
        self._unsubs = [
            store.watch_doc("meta", "settings", self._on_settings),
            store.watch_query("sessions", [("open", "==", True)], self._on_sessions),
            store.watch_query("sessionRequests", [("status", "==", "pending")], self._on_requests),
            store.watch_query("snacks", [("at", ">=", clock() - 864e5)], self._on_sets),
            store.watch_doc("meta", "walk", self._on_walk),
        ]
        log.info("Guardian started. Steam libraries: %s, games known: %d", self.lib.commons, len(self.lib.apps))

    # ------------------------------------------------------------------ live data (may run on other threads)
    def _on_settings(self, doc):
        self.rules.settings = with_defaults({k: v for k, v in (doc or {}).items() if k != "id"})
        self.dirty = True

    def _on_sessions(self, docs):
        self.open_sessions = docs
        self.dirty = True

    def _on_requests(self, docs):
        for d in docs:
            self.requests.put(d)

    def _on_sets(self, docs):
        self.dirty = True
        self.sit_reset = True    # a set means you got up

    def _on_walk(self, doc):
        walk = doc if doc and doc.get("start") else None
        if (walk or {}).get("start") != (self.walk or {}).get("start"):
            self.dirty = True                # walking pauses the set clock: refresh it now
            if not self.walk_stopping:       # started/stopped on the phone: the next walk gets a fresh "still walking?"
                self.walk_check_at = self.walk_asking_since = None
        self.walk = walk

    def _on_daily(self, doc):
        # Korean answers and steps change the gate, a dinner break the set clock. Only those fields: the guardian
        # writes this doc too (gameMinutes, nudge counts), and reacting to its own writes would loop.
        key = tuple((doc or {}).get(k) for k in ("reviews", "newCards", "steps", "dinner"))
        if key != self.daily_key:
            self.daily_key = key
            self.dirty = True

    def _on_gate_change(self, _docs):
        self.dirty = True

    def _watch_gate(self) -> None:
        """Listen to today's workouts, watch workouts and Korean progress; re-subscribe when the day rolls over."""
        today = self.rules.today()
        if today == self.gate_day:
            return
        for u in self.gate_unsubs:
            try:
                u()
            except Exception:
                pass
        self.gate_day = today
        start = day_start(today, self.rules.hour)
        self.gate_unsubs = [
            self.store.watch_doc("daily", today, self._on_daily),
            self.store.watch_query("workouts", [("day", "==", today)], self._on_gate_change),
            self.store.watch_query("exercises", [("start", ">=", start)], self._on_gate_change),
        ]

    @property
    def cfg(self) -> dict:
        return self.rules.g()

    def _check_offline_gap(self) -> None:
        """If the guardian stopped while the PC stayed on (e.g. killed in Task Manager), log it."""
        last = (self.store.get("meta", "gaming") or {}).get("at")
        boot_ms = psutil.boot_time() * 1000
        now = self.clock()
        if last and last > boot_ms and now - last > 180_000:
            mins = (now - last) / 60000
            self.rules.log_event("offline", f"Guardian was not running for {mins:.0f} min")

    def _scan(self) -> list[detect.GameProc]:
        return detect.find_games(self.lib, self.allow, self.extra, self.allow_apps)

    def _session(self) -> dict | None:
        return max(self.open_sessions, key=lambda s: s["startedAt"]) if self.open_sessions else None

    def _publish(self, force: bool = False) -> None:
        if force or self.dirty or self.st is None or time.time() - self.last_publish > PUBLISH_EVERY_S:
            self.dirty = False   # cleared first, so a change that lands while publishing triggers another
            try:
                self.st = self.rules.publish()
            except Exception:
                self.dirty = True
                raise
            self.last_publish = time.time()

    # ------------------------------------------------------------------ main loop
    def run(self) -> None:
        threading.Thread(target=hotkey_thread, args=(self.hotkeys,), daemon=True, name="hotkey").start()
        self.input_watch.start()
        self.root.after(500, self._tick)
        self.root.after(500, self._sample_presence)
        self.root.after(800, lambda: self._toast("Personal Helper is on — games run inside sessions.", GOOD, seconds=5))
        self.root.mainloop()

    def _tick(self) -> None:
        try:
            self._step()
        except Exception:
            log.exception("tick failed")
        self.root.after(TICK_MS, self._tick)

    def _sample_presence(self) -> None:
        try:
            self.presence.sample(time.time(), idle_seconds())
        except Exception:
            log.exception("presence sample failed")
        self.root.after(500, self._sample_presence)

    def _away_idle(self) -> float:
        """Seconds since you were really at the PC (lone fake inputs don't count; see Presence)."""
        return self.presence.idle(time.time())

    def _step(self) -> None:
        if time.time() - self.lib.refreshed > 300:
            self.lib.refresh()
        while not self.requests.empty():
            req = self.requests.get_nowait()
            self.rules.handle_request(req)
            self.dirty = True
        while not self.hotkeys.empty():
            if self.hotkeys.get_nowait() == "dinner":
                self._toggle_dinner()
            else:
                self._toggle_walk()
        try:
            self._watch_gate()
        except Exception:
            log.exception("gate watch failed")
        try:
            self._publish()          # decide on fresh status (sets logged from the phone, settings, sessions)
        except Exception:
            log.exception("status refresh failed")
        games = self._scan()
        pids = {g.pid for g in games}
        try:
            sess = self._session()
            idle = idle_seconds()
            self.presence.sample(time.time(), idle)
            if idle >= PRESENT_S:
                self.input_watch.arm(idle)
            self._move_check(in_session=sess is not None or self._eating())
            if sess:
                self._in_session(sess, games)
                return
            self._clear_break()
            if not games:
                if self.closing_until is not None:
                    self.closing_until = None
                    self.kill_fail_noted = False
                    if self.closing_next_action:
                        self._toast(f"Game closed. Next up: {self.closing_next_action}", GOOD)
                return
            if self.closing_until is None:
                now = self.clock()
                recent = self.rules.store.query("sessions", [("endedAt", ">=", now - 120_000)])
                if recent:
                    # Session was just ended (e.g. from the web app): close politely.
                    self._begin_close(pids, max(recent, key=lambda s: s["endedAt"]).get("nextAction", ""))
                    return
                if pids & self.startup_pids:
                    if time.time() < self.startup_grace_until:
                        self._open_session_dialog(games[0], already_running=True)
                    else:
                        self.startup_pids = set()
                        self._destroy("session_dlg")
                        self.rules.log_event("closed", "Was running when the guardian started; no session chosen")
                        self._begin_close(pids, "")
                    return
                # Game launched without a session: stop it and ask.
                failed = detect.kill(pids)
                self.rules.log_event("blocked", ", ".join(sorted({g.title for g in games})))
                if failed:
                    self._note_kill_failure(games)
                self._open_session_dialog(games[0])
                return
            if time.time() >= self.closing_until:
                if detect.kill(pids):
                    self._note_kill_failure(games)
        finally:
            self._publish()

    def _in_session(self, sess, games) -> None:
        self.closing_until = None
        now = self.clock()
        if games or self.game_seen[0] != sess["id"]:
            self.game_seen = (sess["id"], now)       # (a session found open at startup gets the full 10 min)
        elif now - self.game_seen[1] >= NO_GAME_END_S * 1000:
            # Closing the game ends the session, so tomorrow's launch can't ride on today's (and skip its gate).
            self._clear_break()
            self.rules.end_session("no game", at=self.game_seen[1])
            log.info("Session ended: no game running since %s", hms(self.game_seen[1]))
            self.dirty = True
            return
        end = sess.get("plannedEnd")
        if end is not None and end <= now:
            self._clear_break()
            if not games:
                self.rules.end_session("timeout")
                self.dirty = True
                return
            if self.timeup_win is None:
                self._open_timeup(sess)
            return
        if self.timeup_win is not None:      # session was extended
            self._destroy("timeup_win")
        if end is not None:
            remaining = (end - now) / 1000
            for w in self.cfg["warnAtMinutes"]:
                key = (sess["id"], w)
                if key in self.warned or remaining > w * 60:
                    continue
                self.warned.add(key)
                if games and remaining > w * 60 - 30:
                    then = f" Then: {sess['nextAction']}" if sess.get("nextAction") else ""
                    self._toast(f"{w} minute{'s' if w != 1 else ''} left.{then}", WARN if w > 2 else BAD)
        self._track_away(sess, now)
        self._check_sets(sess, games, now)

    def _track_away(self, sess, now) -> None:
        """AFK: after afkMinutes without keyboard/mouse, mark the session away from your last input; back on input."""
        limit = float(self.cfg.get("afkMinutes") or 0) * 60
        idle = self._away_idle()
        away = self.away_sid == sess["id"] or bool(sess.get("awaySince"))
        if limit > 0 and idle >= limit:
            if not away:
                self.rules.mark_away(sess["id"], now - idle * 1000)
                self.away_sid = sess["id"]
                self.dirty = True
                log.info("AFK: no keyboard/mouse since %s (%s ago); set clock paused",
                         hms(now - idle * 1000), fmt_idle(idle))
        elif away:
            self.rules.mark_back(sess["id"], now - idle * 1000)
            self.away_sid = None
            self.dirty = True
            since = sess.get("awaySince")
            log.info("Back from AFK at %s%s", hms(now - idle * 1000),
                     f" (away since {hms(since)})" if since else "")

    # ------------------------------------------------------------------ sets during play
    def _check_sets(self, sess, games, now) -> None:
        sets = (self.st or {}).get("sets")
        # A fixed-length session that ends before the next set is due: the end of the session is the break.
        if not sets or sets.get("dueAt") is None or (sess.get("plannedEnd") and sess["plannedEnd"] <= sets["dueAt"]):
            self._clear_break(only_due=True)
            return
        left = (sets["dueAt"] - now) / 1000
        if left > 0:
            self._clear_break(only_due=True)       # e.g. the set was just logged on the phone, or you went AFK
            if self.away_sid == sess["id"]:
                return                             # paused while you're away: no warnings into an empty room
            for w in self.cfg["warnAtMinutes"]:
                key = ("set", round(sets["dueAt"] / 60000), w)
                if key in self.warned or left > w * 60:
                    continue
                self.warned.add(key)
                if games and left > w * 60 - 30:
                    self._toast(f"Set due in {w} min: {plan_text(sets.get('next'))}. Do it between matches.",
                                WARN if w > 2 else BAD, seconds=15,
                                action=[("Do it now", lambda: self._open_break(sets, due=False))] + self._dinner_action())
            return
        if not sets.get("required"):
            if games and time.time() - self.last_set_reminder > 300:
                self.last_set_reminder = time.time()
                self._toast(f"Set overdue: {plan_text(sets.get('next'))}", WARN, seconds=15,
                            action=("Do it now", lambda: self._open_break(sets, due=False)))
            return
        t = time.time()
        if self.break_win is None or not self.break_due:
            if not games:
                return                              # nothing running; the set is due before the next game
            self._clear_break()
            self._open_break(sets, due=True)
            return
        if self.break_deadline is None:
            # Opened while you were away from the PC: the save-your-game countdown starts when you're back.
            idle = self._away_idle()
            if idle < t - self.break_opened:
                grace = int(self.cfg["graceSeconds"])
                self.break_deadline = t + grace
                back = (t - idle) * 1000
                self.break_story += f"; input at {hms(back)} started the {grace}s countdown"
                log.info("Set prompt: input at %s, %ds countdown started", hms(back), grace)
                _beep()                              # you're back: the prompt may be behind the game
            return
        if not games or t < self.break_deadline:
            return
        pids = {g.pid for g in games}
        if self.break_kill_at is None:
            detect.close_windows(pids)
            self.break_kill_at = t + CLOSE_GRACE_S
            seen = self.input_watch.last
            if seen and seen["at"] >= self.break_opened:
                self.break_story += f" ({seen['text']})"
            titles = ", ".join(sorted({g.title for g in games}))
            log.info("Set not logged in time: closing %s. %s", titles, self.break_story)
            self.rules.log_event("set_missed", f"{titles}: {self.break_story}" if self.break_story else titles)
        elif t >= self.break_kill_at and detect.kill(pids):
            self._note_kill_failure(games)

    def _clear_break(self, only_due: bool = False) -> None:
        if only_due and not self.break_due:
            return
        self._destroy("break_win")
        self.break_due = False
        self.break_deadline = self.break_kill_at = None

    # ------------------------------------------------------------------ dinner break (rules.py Rules.dinner)
    def _dinner(self) -> dict:
        return (self.st or {}).get("dinner") or {}

    def _eating(self) -> bool:
        d = self._dinner()
        return bool(d.get("start") and d.get("end") and d["start"] <= self.clock() < d["end"])

    def _dinner_action(self) -> list:
        """An "Eating dinner" button for set prompts, while a dinner break can start."""
        return [("Eating dinner", self._start_dinner)] if self._dinner().get("canStart") else []

    def _start_dinner(self) -> bool:
        try:
            doc = self.rules.start_dinner("pc")
        except RuleError as e:
            self._toast(str(e), WARN, seconds=6)
            return False
        self.dirty = True
        self._clear_break()        # a set prompt that's open waits until after dinner
        self._toast(f"Enjoy your dinner. Sets wait until {clock_label(doc['end'])}, and playing while you eat doesn't "
                    "count toward the next one. Done early? Ctrl+Alt+D.", GOOD, seconds=10)
        return True

    def _toggle_dinner(self) -> None:
        if self.rules.dinner()["active"]:
            self.rules.end_dinner()
            self.dirty = True
            self._toast("Dinner's done: the set clock is running again.", GOOD, seconds=5)
        else:
            self._start_dinner()

    # ------------------------------------------------------------------ get-up nudges while working
    def _move_check(self, in_session: bool) -> None:
        m = self.rules.settings.get("moveBreaks") or {}
        t, idle = time.time(), idle_seconds()
        if self.walk:
            self._walk_tick(m, t, idle)
            return
        if self.walk_bar is not None:            # stopped elsewhere (e.g. the web app)
            self._destroy("walk_bar")
            self.sit_start = t
        if not m.get("enabled"):
            self._destroy("nudge_win")
            return
        if self.sit_reset:
            self.sit_reset = False
            self.sit_start = t
        if idle >= float(m.get("awayMinutes", 3)) * 60:
            if self.sit_start is not None and self.nudge_at is not None:
                self._count("moveBreaks")             # got up after a nudge
            self.sit_start = self.nudge_at = None
            self._destroy("nudge_win")
            return
        if self.sit_start is None:
            self.sit_start = t - idle
        if in_session or self.nudge_win is not None or t < self.snooze_until:
            return
        if t - self.sit_start >= float(m.get("everyMinutes", 30)) * 60:
            self.nudge_at = t
            self._count("moveNudges")
            self._open_nudge(m)

    # ------------------------------------------------------------------ treadmill walks
    def _start_walk(self, src: str = "pc") -> None:
        now = self.clock()
        walks.start_walk(self.store, now, src)
        self.walk = {"start": now, "src": src}
        self.walk_check_at, self.walk_asking_since = time.time(), None
        if self.nudge_at is not None:
            self._count("moveBreaks")             # walked after a nudge
        self.nudge_at = None
        self._destroy("nudge_win")

    def _toggle_walk(self) -> None:
        if self.walk:
            if not self.walk_stopping:
                self._stop_walk_dialog()
        else:
            self._start_walk("pc")
            owed = " The set you owe is due when you stop." if self._set_owed() else ""
            self._toast(f"Treadmill walk started: sets wait while you walk.{owed} Ctrl+Alt+W again (or Stop) when you "
                        "sit down.", GOOD, seconds=6)

    def _set_owed(self) -> bool:
        """A set is already due (or was moved by dinner or a walk), so it comes due as soon as the walk ends."""
        sets = (self.st or {}).get("sets") or {}
        return bool(self._session() and sets.get("every") and sets.get("playedSince", 0) >= sets["every"])

    def _walk_tick(self, m: dict, t: float, idle: float) -> None:
        self._destroy("nudge_win")
        if self.walk_stopping:
            return
        if self.walk_check_at is None:
            self.walk_check_at = t
        if idle >= WALK_IDLE_END_S:
            self._end_walk(self.clock() - idle * 1000, note="You were away from the PC, so it ends when you left.")
            return
        if self.walk_asking_since is None and t - self.walk_check_at >= float(m.get("walkCheckMinutes", 30)) * 60:
            self.walk_asking_since = t
            _beep()
        if self.walk_asking_since is not None and t - self.walk_asking_since >= WALK_ASK_TIMEOUT_S:
            self._end_walk(self.clock() - (t - self.walk_asking_since) * 1000,
                           note="No answer to \"still walking?\", so it ends when I asked.")
            return
        self._show_walk_bar()

    def _end_walk(self, end: float, steps: int | None = None, note: str = "") -> None:
        try:
            r = walks.stop_walk(self.store, self.clock(), end=end, steps=steps)
        except Exception:
            log.exception("saving the walk failed")
            r = None
        self.walk = None
        self.walk_check_at = self.walk_asking_since = None
        self.walk_stopping = False
        self._destroy("walk_bar")
        self.sit_start, self.nudge_at = time.time(), None
        if r:
            self._toast(f"Treadmill walk logged: {r['minutes']:.0f} min, {r['steps']:,} steps"
                        f"{' (estimated)' if r['est'] else ''}. {note}".strip(), GOOD, seconds=10)

    def _show_walk_bar(self) -> None:
        mins = max(0, int((self.clock() - self.walk["start"]) / 60000))
        mode = "ask" if self.walk_asking_since is not None else "walk"
        if self.walk_bar is not None and self.walk_bar_mode == mode:
            try:
                self.walk_bar.children["label"].config(text=self._walk_text(mins, mode, self._set_owed()))
                return
            except (KeyError, tk.TclError):
                pass
        self._destroy("walk_bar")
        self.walk_bar_mode = mode
        b = self.walk_bar = tk.Toplevel(self.root, bg=WARN if mode == "ask" else GOOD)
        b.overrideredirect(True)
        b.attributes("-topmost", True)
        tk.Label(b, name="label", text=self._walk_text(mins, mode, self._set_owed()), bg=CARD, fg=FG,
                 font=(FONT, 10, "bold"),
                 padx=12, pady=8).pack(side="left", padx=(4, 0))
        if mode == "ask":
            def still():
                self.walk_check_at, self.walk_asking_since = time.time(), None
                self._destroy("walk_bar")
            self._button(b, "Still walking", still, primary=True)
        self._button(b, "Stop", self._stop_walk_dialog, primary=mode != "ask")
        b.update_idletasks()
        b.geometry(f"+{b.winfo_screenwidth() - b.winfo_reqwidth() - 24}+{b.winfo_screenheight() - b.winfo_reqheight() - 80}")
        _no_activate(b)

    @staticmethod
    def _walk_text(mins: int, mode: str, owed: bool = False) -> str:
        if mode == "ask":
            return f"Still walking? ({mins} min so far)"
        return f"Treadmill walk · {mins} min" + (" · set due when you stop" if owed else "")

    def _stop_walk_dialog(self) -> None:
        if not self.walk or self.walk_stopping:
            return
        end = self.clock()
        self.walk_stopping = True
        self._destroy("walk_bar")
        mins = (end - self.walk["start"]) / 60000
        guess = round(mins * walks.cadence(self.store))
        w = self._window("Walk done")
        self._label(w, f"Walked {mins:.0f} min", 16, bold=True)
        self._label(w, "Steps shown on the treadmill (optional, makes the count exact and teaches the estimate "
                       "your pace):", 10, MUTED)
        entry = tk.Entry(w, font=(FONT, 12), bg=CARD, fg=FG, insertbackground=FG, relief="flat", width=12)
        entry.pack(anchor="w", ipady=4, pady=(4, 10))
        btns = tk.Frame(w, bg=BG)
        btns.pack(fill="x")

        def done(use_entry: bool):
            raw = entry.get().replace(",", "").strip() if use_entry else ""
            try:
                w.destroy()
            except tk.TclError:
                pass
            self._end_walk(end, steps=int(raw) if raw.isdigit() else None)

        self._button(btns, "Save", lambda: done(True), primary=True)
        self._button(btns, f"Estimate (~{guess:,})", lambda: done(False))
        w.protocol("WM_DELETE_WINDOW", lambda: done(False))
        w.bind("<Return>", lambda e: done(True))
        w.bind("<Escape>", lambda e: done(False))
        self._show(w)
        entry.focus_set()

    def _count(self, field: str) -> None:
        today = self.rules.today()
        try:
            self.store.update("daily", today, {"day": today, field: Increment(1)})
        except Exception:
            log.exception("count %s failed", field)

    def _open_nudge(self, m: dict) -> None:
        idea = NUDGE_IDEAS[self.nudges_shown % len(NUDGE_IDEAS)]
        self.nudges_shown += 1
        _beep()
        t = self.nudge_win = tk.Toplevel(self.root, bg=GOOD)
        t.overrideredirect(True)
        t.attributes("-topmost", True)
        inner = tk.Frame(t, bg=CARD, padx=18, pady=14)
        inner.pack(padx=(4, 0))
        mins = int(m.get("everyMinutes", 30))
        treadmill = bool(m.get("treadmill"))
        walk = int(m.get("walkMinutes", 15))
        title = f"{mins} min sitting: walk for a while" if treadmill else f"{mins} min at the desk: time to stand up"
        body = (f"Raise the desk and walk on the treadmill for {walk}+ minutes at an easy ~1.5 mph (2.4 km/h) while typing, faster on calls. "
                "Calls, reading, email and code review all work well while walking." if treadmill
                else f"Walk for 3–5 minutes. {idea}")
        tk.Label(inner, text=title, bg=CARD, fg=FG, font=(FONT, 12, "bold"), justify="left").pack(anchor="w")
        tk.Label(inner, text=body, bg=CARD, fg=FG, font=(FONT, 10), wraplength=340,
                 justify="left").pack(anchor="w", pady=(4, 2))
        tk.Label(inner, text="Standing still doesn't count: the benefit comes from walking. Ctrl+Alt+W starts or stops a "
                 "walk any time." if treadmill
                 else "This closes by itself once you've been away a few minutes.", bg=CARD, fg=MUTED,
                 font=(FONT, 9), wraplength=340, justify="left").pack(anchor="w", pady=(0, 8))
        row = tk.Frame(inner, bg=CARD)
        row.pack(anchor="w")
        snooze = int(m.get("snoozeMinutes", 15))

        def later(minutes):
            self.snooze_until = time.time() + minutes * 60
            self._destroy("nudge_win")

        if treadmill:
            self._button(row, "Walking now", lambda: self._start_walk("pc"), primary=True)
        else:
            self._button(row, "Going now", lambda: later(10), primary=True)
        self._button(row, f"Snooze {snooze} min", lambda: later(snooze))
        t.update_idletasks()
        t.geometry(f"+{t.winfo_screenwidth() - t.winfo_reqwidth() - 24}+{t.winfo_screenheight() - t.winfo_reqheight() - 80}")
        _no_activate(t)

    def _begin_close(self, pids: set[int], next_action: str) -> None:
        detect.close_windows(pids)
        self.closing_until = time.time() + CLOSE_GRACE_S
        self.closing_next_action = next_action or ""

    def _note_kill_failure(self, games) -> None:
        if self.kill_fail_noted:
            return
        self.kill_fail_noted = True
        names = ", ".join(sorted({g.title for g in games}))
        self.rules.log_event("kill_failed", names)
        self._toast(f"Couldn't close {names} — it runs as administrator. See README (run guardian elevated).", BAD,
                    seconds=15)

    # ------------------------------------------------------------------ UI helpers
    def _destroy(self, attr: str) -> None:
        w = getattr(self, attr)
        if w is not None:
            try:
                w.destroy()
            except tk.TclError:
                pass
        setattr(self, attr, None)

    def _window(self, title: str) -> tk.Toplevel:
        w = tk.Toplevel(self.root, bg=BG, padx=24, pady=20)
        w.title(title)
        w.attributes("-topmost", True)
        w.resizable(False, False)
        return w

    def _show(self, w: tk.Toplevel) -> None:
        w.update_idletasks()
        x = (w.winfo_screenwidth() - w.winfo_reqwidth()) // 2
        y = (w.winfo_screenheight() - w.winfo_reqheight()) // 3
        w.geometry(f"+{x}+{y}")
        w.deiconify()
        w.lift()
        w.focus_force()

    def _label(self, parent, text, size=11, color=FG, bold=False, wrap=420, **pack):
        lbl = tk.Label(parent, text=text, bg=parent["bg"], fg=color, justify="left", anchor="w",
                       font=(FONT, size, "bold" if bold else "normal"), wraplength=wrap)
        lbl.pack(fill="x", **({"pady": (0, 4)} | pack))
        return lbl

    def _button(self, parent, text, cmd, primary=False, side="left"):
        b = tk.Button(parent, text=text, command=cmd, font=(FONT, 10, "bold" if primary else "normal"),
                      bg=ACCENT if primary else CARD, fg="#0b0d10" if primary else FG, relief="flat",
                      activebackground=ACCENT, padx=14, pady=6, cursor="hand2", disabledforeground="#555")
        b.pack(side=side, padx=(0, 8))
        return b

    def _toast(self, text: str, color: str = ACCENT, seconds: int = 8, action=None) -> None:
        _beep()
        t = tk.Toplevel(self.root, bg=color)
        t.overrideredirect(True)
        t.attributes("-topmost", True)
        inner = tk.Frame(t, bg=CARD, padx=18, pady=14)
        inner.pack(padx=(4, 0))
        tk.Label(inner, text=text, bg=CARD, fg=FG, font=(FONT, 12, "bold"), wraplength=360,
                 justify="left").pack(anchor="w")
        actions = action if isinstance(action, list) else [action] if action else []
        if actions:
            row = tk.Frame(inner, bg=CARD)
            row.pack(anchor="w", pady=(8, 0))
        for i, (label, fn) in enumerate(actions):
            def run(fn=fn):
                try:
                    t.destroy()
                except tk.TclError:
                    pass
                fn()

            self._button(row, label, run, primary=i == 0)
        t.update_idletasks()
        t.geometry(f"+{t.winfo_screenwidth() - t.winfo_reqwidth() - 24}+24")
        _no_activate(t)

        def close():
            try:
                t.destroy()
            except tk.TclError:
                pass

        t.after(seconds * 1000, close)

    # ------------------------------------------------------------------ session dialog
    def _open_session_dialog(self, game: detect.GameProc, already_running: bool = False, prefill=None) -> None:
        if self.session_dlg is not None and self.session_dlg.winfo_exists():
            return
        try:
            st = self.rules.status()
        except Exception:
            log.exception("status failed")
            self._toast("Can't reach Firebase, so no session can start. Check the internet connection.", BAD)
            return
        self.st = st   # the dialog follows later updates of self.st (see recheck below)
        w = self.session_dlg = self._window("Start a gaming session")
        w.protocol("WM_DELETE_WINDOW", lambda: self._destroy("session_dlg"))
        if already_running:
            self._label(w, f"{game.title} is already running", 16, bold=True)
            self._label(w, f"The guardian just started. Choose a session to keep playing, or the game closes "
                           f"in {STARTUP_GRACE_S // 60} minutes.", 10, MUTED, pady=(0, 12))
        else:
            self._label(w, f"{game.title} is waiting", 16, bold=True)
            self._label(w, "Games run inside a session you choose now, while you're thinking clearly. "
                           "It was closed. It'll start again when you begin a session.", 10, MUTED, pady=(0, 12))

        box = tk.Frame(w, bg=CARD, padx=14, pady=10)
        box.pack(fill="x", pady=(0, 12))
        for item in st["gate"]:
            self._label(box, f"{'✓' if item['ok'] else '✗'}  {item['label']} — {item['detail']}", 11,
                        GOOD if item["ok"] else BAD)
        if st["cap"]:
            self._label(box, f"Played today: {st['used']:.0f} / {st['cap']} min", 10, MUTED, pady=(6, 0))
        else:
            self._label(box, f"Played today: {st['used']:.0f} min", 10, MUTED, pady=(6, 0))
        if st.get("sets"):
            self._label(box, f"A short set is due every {st['sets']['every']} min of play "
                             f"(next: {plan_text(st['sets'].get('next'))}).", 10, MUTED)
        dinner = st.get("dinner") or {}
        if dinner.get("active"):
            self._label(box, f"Dinner break: sets wait until {clock_label(dinner['end'])}.", 10, GOOD)
        if st["cooldownLeft"] > 0:
            self._label(box, f"Cooldown: {st['cooldownLeft']:.0f} min left", 10, WARN)

        choices = st["choices"] or [self.cfg["overrideExtendMinutes"]]
        self._label(w, "How long?", 11, bold=True)
        minutes = tk.IntVar(value=choices[0] if choices[0] == 0 else choices[min(1, len(choices) - 1)])
        if prefill and prefill[1] in choices:
            minutes.set(prefill[1])
        row = tk.Frame(w, bg=BG)
        row.pack(fill="x", pady=(0, 10))
        for m in choices:
            tk.Radiobutton(row, text=minutes_label(m), variable=minutes, value=m, bg=BG, fg=FG, selectcolor=CARD,
                           activebackground=BG, activeforeground=FG, font=(FONT, 10)).pack(side="left", padx=(0, 10))

        self._label(w, "Right after, I will:", 11, bold=True)
        nxt = tk.Entry(w, font=(FONT, 11), bg=CARD, fg=FG, insertbackground=FG, relief="flat")
        nxt.pack(fill="x", ipady=5, pady=(0, 4))
        if prefill and prefill[0]:
            nxt.insert(0, prefill[0])
        self._label(w, "e.g. \"go to bed\", \"make dinner\", \"30 min of Korean reading\"", 9, MUTED)
        eating = tk.BooleanVar(value=bool(prefill and len(prefill) > 2 and prefill[2]))
        if dinner.get("canStart") and st.get("sets"):
            tk.Checkbutton(w, text=f"I'm eating dinner while I play (sets wait {dinner['minutes']} min)", variable=eating,
                           bg=BG, fg=FG, selectcolor=CARD, activebackground=BG, activeforeground=FG,
                           font=(FONT, 10)).pack(anchor="w", pady=(4, 0))
        err = self._label(w, "", 10, BAD)

        def start(reason=None):
            try:
                mins, then, eat = minutes.get(), nxt.get().strip(), eating.get()
            except tk.TclError:  # dialog was closed while the override timer ran
                return
            try:
                self.rules.start_session(mins, then, reason, games=game.title)
            except RuleError as e:
                if err.winfo_exists():
                    err.config(text=str(e))
                else:
                    self._toast(str(e), BAD)
                return
            self.dirty = True
            self._destroy("session_dlg")
            if not (eat and self._start_dinner()):
                self._toast(f"Session started ({minutes_label(mins).lower()}). Then: {then}", GOOD)
            if not already_running:
                detect.relaunch(game.appid)

        if st["blockers"]:
            self._label(w, "Locked: " + "; ".join(st["blockers"]), 10, BAD, pady=(6, 0))
        btns = tk.Frame(w, bg=BG)
        btns.pack(fill="x", pady=(10, 0))
        if not st["blockers"]:
            self._button(btns, "Start session", start, primary=True)
        elif st["overridesLeft"] > 0:
            def ask_override():
                if not nxt.get().strip():
                    err.config(text="Fill in what you'll do right after first.")
                    return
                self._open_override("Start anyway", start)
            self._button(btns, f"Override… ({st['overridesLeft']} left today)", ask_override)
        url = config.section("cloud").get("web_url")
        if url:
            self._button(btns, "Open dashboard", lambda: webbrowser.open(url))
        self._button(btns, "Not now", lambda: self._destroy("session_dlg"))
        self._show(w)
        nxt.focus_set()

        # Finish the workout or the Korean with this open, and it updates itself (no need to relaunch the game).
        shown = tuple(st["blockers"])

        def recheck():
            if self.session_dlg is not w or not w.winfo_exists():
                return
            cur = tuple((self.st or {}).get("blockers") or ())
            if cur != shown:
                try:
                    keep = (nxt.get(), minutes.get(), eating.get())
                except tk.TclError:
                    return
                self._destroy("session_dlg")
                self._open_session_dialog(game, already_running, prefill=keep)
                if not cur:
                    _beep()
                return
            w.after(1000, recheck)

        w.after(1000, recheck)

    # ------------------------------------------------------------------ override dialog
    def _open_override(self, action: str, on_confirm) -> None:
        if self.override_dlg is not None and self.override_dlg.winfo_exists():
            self.override_dlg.lift()
            return
        wait = int(self.cfg["overrideWaitSeconds"])
        min_chars = int(self.cfg["overrideMinReasonChars"])
        w = self.override_dlg = self._window("Override")
        w.protocol("WM_DELETE_WINDOW", lambda: self._destroy("override_dlg"))
        self._label(w, "Breaking your own rule", 15, bold=True)
        self._label(w, "You set these limits when you were thinking clearly. If this is still worth it after "
                       "a minute, write down why. It will show up on your dashboard.", 10, MUTED, pady=(0, 10))
        txt = tk.Text(w, height=4, width=48, font=(FONT, 11), bg=CARD, fg=FG, insertbackground=FG,
                      relief="flat", wrap="word")
        txt.pack(fill="x", pady=(0, 8))
        status = self._label(w, "", 10, MUTED)
        btns = tk.Frame(w, bg=BG)
        btns.pack(fill="x", pady=(8, 0))
        ok = self._button(btns, action, lambda: confirm(), primary=True)
        ok.config(state="disabled")
        self._button(btns, "Never mind", lambda: self._destroy("override_dlg"))
        deadline = time.time() + wait

        def refresh():
            if self.override_dlg is None or not w.winfo_exists():
                return
            left = int(deadline - time.time())
            n = len(txt.get("1.0", "end").strip())
            if left > 0:
                status.config(text=f"Wait {left}s…   ({n}/{min_chars} characters)")
            elif n < min_chars:
                status.config(text=f"Write a bit more: {n}/{min_chars} characters")
            else:
                status.config(text="Okay — your call.")
            ok.config(state="normal" if left <= 0 and n >= min_chars else "disabled")
            w.after(500, refresh)

        def confirm():
            reason = txt.get("1.0", "end").strip()
            self._destroy("override_dlg")
            on_confirm(reason)

        refresh()
        self._show(w)
        txt.focus_set()

    # ------------------------------------------------------------------ set prompt
    def _open_break(self, sets: dict, due: bool) -> None:
        if self.break_win is not None:
            try:
                if self.break_win.winfo_exists():
                    self.break_win.lift()
                    return
            except tk.TclError:
                pass
        _beep()
        items = sets.get("next") or []
        grace = int(self.cfg["graceSeconds"])
        min_s = int(sets.get("minSeconds", 30))
        w = self.break_win = self._window("Set time")
        self.break_due = due
        self.break_opened = time.time()
        # Away from the PC when it opens? Then the countdown waits for you (see _check_sets).
        idle = self._away_idle()
        self.break_deadline = time.time() + grace if due and idle < PRESENT_S else None
        if due:
            self.break_story = (f"prompt at {hms(self.clock())}, last input {fmt_idle(idle)} before"
                                + (f", {grace}s countdown started" if self.break_deadline else ""))
            log.info("Set prompt opened (set due), last input %s before: %s", fmt_idle(idle),
                     "countdown started" if self.break_deadline else "countdown waits for input")
        self.break_kill_at = None
        w.protocol("WM_DELETE_WINDOW", (lambda: None) if due else (lambda: self._clear_break()))
        self._label(w, "Set time" if due else "Your next set", 20, bold=True)
        self._label(w, f"Every {sets['every']} minutes of play: stand up and do", 11, MUTED)
        for it in items:
            self._label(w, "•  " + plan_text([it]), 14, GOOD, bold=True)
        self._label(w, "Steady pace, stopping 2–3 reps before failure. It breaks up the sitting and adds "
                       "training volume without hurting your workouts.", 9, MUTED, pady=(6, 6))
        count = self._label(w, "", 11, WARN, bold=True)
        btns = tk.Frame(w, bg=BG)
        btns.pack(fill="x", pady=(10, 0))
        opened = time.time()

        def done():
            self.rules.log_set(items, "pc")
            self.dirty = True
            self.sit_start = time.time()
            self._clear_break()
            self._toast(f"Set logged. Next one after {sets['every']} min of play.", GOOD)

        def stop():
            self.rules.end_session("stopped at a set")
            self.dirty = True
            self._clear_break()

        ok = self._button(btns, "Done ✓", done, primary=True)
        ok.config(state="disabled")
        for label, fn in self._dinner_action():
            self._button(btns, label, fn)
        if due:
            self._button(btns, "Stop playing", stop)
        else:
            self._button(btns, "Later", lambda: self._clear_break())

        def tick():
            if self.break_win is not w or not w.winfo_exists():
                return
            el = time.time() - opened
            ok.config(state="normal" if el >= min_s else "disabled")
            parts = [] if el >= min_s else [f"Done unlocks in {int(min_s - el) + 1}s"]
            if due and self.break_deadline is not None:
                left = int(self.break_deadline - time.time())
                parts.append(f"Save your game: it closes in {left}s unless the set is logged" if left > 0
                             else "The game stays closed until the set is logged.")
            elif due:
                parts.append(f"You're away, so the game stays open. When you're back, you'll have {grace}s.")
            count.config(text="\n".join(parts))
            w.after(500, tick)

        tick()
        self._show(w)

    # ------------------------------------------------------------------ time's up
    def _open_timeup(self, sess) -> None:
        _beep()
        grace = int(self.cfg["graceSeconds"])
        w = self.timeup_win = self._window("Time's up")
        w.protocol("WM_DELETE_WINDOW", lambda: None)  # can't just close it
        self._label(w, "Time's up", 22, bold=True)
        planned = (sess["plannedEnd"] - sess["startedAt"]) / 60000
        self._label(w, f"You chose {planned:.0f} minutes, and they're over.", 11, MUTED)
        if sess.get("nextAction"):
            self._label(w, f"Next: {sess['nextAction']}", 14, GOOD, bold=True, pady=(8, 8))
        count = self._label(w, "", 12, WARN, bold=True)
        btns = tk.Frame(w, bg=BG)
        btns.pack(fill="x", pady=(12, 0))
        deadline = time.time() + grace
        next_action = sess.get("nextAction", "")

        def close_now():
            self.rules.end_session("timeout")
            self.rules.log_event("closed", sess.get("games") or "")
            self.dirty = True
            self._destroy("timeup_win")
            self._begin_close({g.pid for g in self._scan()}, next_action)

        def tick():
            if self.timeup_win is None or not w.winfo_exists():
                return
            left = int(deadline - time.time())
            if left <= 0:
                close_now()
                return
            count.config(text=f"Save your game — it closes in {left}s")
            w.after(500, tick)

        def extend(reason):
            try:
                self.rules.extend_session(reason)
            except RuleError as e:
                self._toast(str(e), BAD)
                return
            self.dirty = True
            self._destroy("timeup_win")
            self._toast(f"Extended {self.cfg['overrideExtendMinutes']} min (logged).", WARN)

        self._button(btns, "Close the game now", close_now, primary=True)
        if self.rules.overrides_today() < self.cfg["overrideMaxPerDay"]:
            self._button(btns, f"+{self.cfg['overrideExtendMinutes']} min (override)",
                         lambda: self._open_override("Extend", extend))
        tick()
        self._show(w)


def single_instance() -> bool:
    if sys.platform != "win32":
        return True
    ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\PersonalHelperGuardian")
    return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def main(store, root: tk.Tk | None = None) -> None:
    if not single_instance():
        log.warning("Guardian already running; exiting.")
        return
    Guardian(store, root).run()
