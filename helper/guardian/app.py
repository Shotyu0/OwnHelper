"""The guardian: a background loop that only lets games run inside a session you chose in advance.

  game starts, no session  -> game is closed right away, session dialog opens (gate, length, "then I will...")
  session running          -> warnings at 10 and 2 minutes left
  time's up                -> 60 s "save your game" countdown, then the game is asked to close,
                              then force-closed 15 s later
  override                 -> 60 s wait + written reason; logged on the dashboard; limited per day

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
        self.warned: set[tuple[str, int]] = set()
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
        if force or self.dirty or time.time() - self.last_publish > PUBLISH_EVERY_S:
            self.rules.publish()
            self.dirty = False
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
        games = self._scan()
        pids = {g.pid for g in games}
        try:
            sess = self._session()
            if sess:
                self._in_session(sess, games)
                return
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
        remaining = (sess["plannedEnd"] - self.clock()) / 1000
        if remaining > 0:
            if self.timeup_win is not None:      # session was extended
                self._destroy("timeup_win")
            for w in self.cfg["warnAtMinutes"]:
                key = (sess["id"], w)
                if key in self.warned or remaining > w * 60:
                    continue
                self.warned.add(key)
                if games and remaining > w * 60 - 30:
                    then = f" Then: {sess['nextAction']}" if sess.get("nextAction") else ""
                    self._toast(f"{w} minute{'s' if w != 1 else ''} left.{then}", WARN if w > 2 else BAD)
            return
        if not games:
            self.rules.end_session("timeout")
            self.dirty = True
            return
        if self.timeup_win is None:
            self._open_timeup(sess)

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

    def _toast(self, text: str, color: str = ACCENT, seconds: int = 8) -> None:
        _beep()
        t = tk.Toplevel(self.root, bg=color)
        t.overrideredirect(True)
        t.attributes("-topmost", True)
        inner = tk.Frame(t, bg=CARD, padx=18, pady=14)
        inner.pack(padx=(4, 0))
        tk.Label(inner, text=text, bg=CARD, fg=FG, font=(FONT, 12, "bold"), wraplength=360,
                 justify="left").pack()
        t.update_idletasks()
        t.geometry(f"+{t.winfo_screenwidth() - t.winfo_reqwidth() - 24}+24")
        t.after(seconds * 1000, t.destroy)

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
        self._label(box, f"Played today: {st['used']:.0f} / {st['cap']} min", 10, MUTED, pady=(6, 0))
        if st["cooldownLeft"] > 0:
            self._label(box, f"Cooldown: {st['cooldownLeft']:.0f} min left", 10, WARN)

        choices = st["choices"] or [self.cfg["overrideExtendMinutes"]]
        self._label(w, "How long?", 11, bold=True)
        minutes = tk.IntVar(value=choices[min(1, len(choices) - 1)])
        row = tk.Frame(w, bg=BG)
        row.pack(fill="x", pady=(0, 10))
        for m in choices:
            tk.Radiobutton(row, text=f"{m} min", variable=minutes, value=m, bg=BG, fg=FG, selectcolor=CARD,
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
            self._toast(f"Session started: {mins} min. Then: {then}", GOOD)
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
