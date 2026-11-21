"""The guardian: a background loop that only lets games run inside a session you chose in advance.

  game starts, no session  -> game is closed right away, session dialog opens (gate, length, "then I will...")
  session running          -> warnings at 10 and 2 minutes left (fixed-length sessions)
  time's up                -> 60 s "save your game" countdown, then the game is asked to close,
                              then force-closed 15 s later
  set due (every 30 min    -> warnings at 10 and 2 minutes, then a "set time" prompt; if the set isn't logged
   of play)                   within 60 s the game is closed, and stays closed until it is
  override                 -> 60 s wait + written reason; logged on the dashboard; limited per day
  at the desk 30 min       -> a small nudge to get up and walk for a few minutes (not while gaming); with a
                              treadmill desk: walk while working, and "Walking now" pauses nudges for a while

Rules and data come from Firestore (helper/gaming/rules.py). Sessions can also be requested from the
web app; the guardian checks them against the same rules and publishes its status for the web app.
"""
from __future__ import annotations

import ctypes
import logging
import queue
import sys
import time
import tkinter as tk
import webbrowser

import psutil

from .. import config
from ..cloud import Increment
from ..gaming.rules import Rules, RuleError, now_ms
from ..settings import with_defaults
from . import detect

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


def plan_text(items) -> str:
    """Same wording as web/js/workout.js setText."""
    return " + ".join(f"{i.get('reps')} × {i.get('name')}" + (f" ({i['note']})" if i.get("note") else "")
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
        self.break_deadline: float | None = None
        self.break_kill_at: float | None = None
        self.last_set_reminder = 0.0
        # get-up nudges while working
        self.nudge_win: tk.Toplevel | None = None
        self.sit_start: float | None = None
        self.nudge_at: float | None = None
        self.snooze_until = 0.0
        self.walking_until = 0.0
        self.sit_reset = False
        self.nudges_shown = 0
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
        self.root.after(500, self._tick)
        self.root.after(800, lambda: self._toast("Personal Helper is on — games run inside sessions.", GOOD, seconds=5))
        self.root.mainloop()

    def _tick(self) -> None:
        try:
            self._step()
        except Exception:
            log.exception("tick failed")
        self.root.after(TICK_MS, self._tick)

    def _step(self) -> None:
        if time.time() - self.lib.refreshed > 300:
            self.lib.refresh()
        while not self.requests.empty():
            req = self.requests.get_nowait()
            self.rules.handle_request(req)
            self.dirty = True
        try:
            self._publish()          # decide on fresh status (sets logged from the phone, settings, sessions)
        except Exception:
            log.exception("status refresh failed")
        games = self._scan()
        pids = {g.pid for g in games}
        try:
            sess = self._session()
            self._move_check(in_session=sess is not None)
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
        self._check_sets(sess, games, now)

    # ------------------------------------------------------------------ sets during play
    def _check_sets(self, sess, games, now) -> None:
        sets = (self.st or {}).get("sets")
        # A fixed-length session that ends before the next set is due: the end of the session is the break.
        if not sets or sets.get("dueAt") is None or (sess.get("plannedEnd") and sess["plannedEnd"] <= sets["dueAt"]):
            self._clear_break(only_due=True)
            return
        left = (sets["dueAt"] - now) / 1000
        if left > 0:
            self._clear_break(only_due=True)       # e.g. the set was just logged on the phone
            for w in self.cfg["warnAtMinutes"]:
                key = ("set", round(sets["dueAt"] / 60000), w)
                if key in self.warned or left > w * 60:
                    continue
                self.warned.add(key)
                if games and left > w * 60 - 30:
                    self._toast(f"Set due in {w} min: {plan_text(sets.get('next'))}. Do it between matches.",
                                WARN if w > 2 else BAD, seconds=15,
                                action=("Do it now", lambda: self._open_break(sets, due=False)))
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
        if not games or self.break_deadline is None or t < self.break_deadline:
            return
        pids = {g.pid for g in games}
        if self.break_kill_at is None:
            detect.close_windows(pids)
            self.break_kill_at = t + CLOSE_GRACE_S
            self.rules.log_event("set_missed", ", ".join(sorted({g.title for g in games})))
        elif t >= self.break_kill_at and detect.kill(pids):
            self._note_kill_failure(games)

    def _clear_break(self, only_due: bool = False) -> None:
        if only_due and not self.break_due:
            return
        self._destroy("break_win")
        self.break_due = False
        self.break_deadline = self.break_kill_at = None

    # ------------------------------------------------------------------ get-up nudges while working
    def _move_check(self, in_session: bool) -> None:
        m = self.rules.settings.get("moveBreaks") or {}
        if not m.get("enabled"):
            self._destroy("nudge_win")
            return
        t, idle = time.time(), idle_seconds()
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
        if self.walking_until:
            if t < self.walking_until:
                return                                # walking at the treadmill desk
            self.sit_start, self.walking_until = self.walking_until, 0.0
        if in_session or self.nudge_win is not None or t < self.snooze_until:
            return
        if t - self.sit_start >= float(m.get("everyMinutes", 30)) * 60:
            self.nudge_at = t
            self._count("moveNudges")
            self._open_nudge(m)

    def _walking_now(self, minutes: float) -> None:
        """'Walking now' on the treadmill-desk nudge: no nudges while you walk, then the sitting clock restarts."""
        self.walking_until = time.time() + minutes * 60
        self.nudge_at = None
        self._count("moveBreaks")
        self._destroy("nudge_win")

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
        tk.Label(inner, text="Standing still doesn't count: the benefit comes from walking." if treadmill
                 else "This closes by itself once you've been away a few minutes.", bg=CARD, fg=MUTED,
                 font=(FONT, 9), wraplength=340, justify="left").pack(anchor="w", pady=(0, 8))
        row = tk.Frame(inner, bg=CARD)
        row.pack(anchor="w")
        snooze = int(m.get("snoozeMinutes", 15))

        def later(minutes):
            self.snooze_until = time.time() + minutes * 60
            self._destroy("nudge_win")

        if treadmill:
            self._button(row, "Walking now", lambda: self._walking_now(walk), primary=True)
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
        if action:
            label, fn = action

            def run():
                try:
                    t.destroy()
                except tk.TclError:
                    pass
                fn()

            row = tk.Frame(inner, bg=CARD)
            row.pack(anchor="w", pady=(8, 0))
            self._button(row, label, run, primary=True)
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
    def _open_session_dialog(self, game: detect.GameProc, already_running: bool = False) -> None:
        if self.session_dlg is not None and self.session_dlg.winfo_exists():
            return
        try:
            st = self.rules.status()
        except Exception:
            log.exception("status failed")
            self._toast("Can't reach Firebase, so no session can start. Check the internet connection.", BAD)
            return
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
        if st["cooldownLeft"] > 0:
            self._label(box, f"Cooldown: {st['cooldownLeft']:.0f} min left", 10, WARN)

        choices = st["choices"] or [self.cfg["overrideExtendMinutes"]]
        self._label(w, "How long?", 11, bold=True)
        minutes = tk.IntVar(value=choices[0] if choices[0] == 0 else choices[min(1, len(choices) - 1)])
        row = tk.Frame(w, bg=BG)
        row.pack(fill="x", pady=(0, 10))
        for m in choices:
            tk.Radiobutton(row, text=minutes_label(m), variable=minutes, value=m, bg=BG, fg=FG, selectcolor=CARD,
                           activebackground=BG, activeforeground=FG, font=(FONT, 10)).pack(side="left", padx=(0, 10))

        self._label(w, "Right after, I will:", 11, bold=True)
        nxt = tk.Entry(w, font=(FONT, 11), bg=CARD, fg=FG, insertbackground=FG, relief="flat")
        nxt.pack(fill="x", ipady=5, pady=(0, 4))
        self._label(w, "e.g. \"go to bed\", \"make dinner\", \"30 min of Korean reading\"", 9, MUTED)
        err = self._label(w, "", 10, BAD)

        def start(reason=None):
            try:
                mins, then = minutes.get(), nxt.get().strip()
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
        self.break_deadline = time.time() + grace if due else None
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
