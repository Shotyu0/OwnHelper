"""Gaming rules, enforced by the PC guardian. They read the same Firestore documents the web app writes.

Design: you decide *before* playing (gate + session length + what you'll do next), when you're in a
"cold" state. The guardian enforces that decision in the "hot" state, when stopping is hard.
Overrides exist but cost a wait and a written reason; they're logged and shown on the dashboard.

Sets: every setEveryMinutes of play a short exercise set is due (push/pull + legs, sized from the workout
progression; the web app writes the menu to meta/setPlan). Logging one (PC prompt or phone) resets the clock.
Play time is counted across sessions, so ending and restarting a session doesn't reset it.

Gate inputs (same as web/js/pages/today.js gateInputs):
  workouts/{id}.day/status, exercises (watch) .start/.dur, cards .due/.introducedAt/.newRank,
  daily/{calendar day}.steps (kept by the relay).
"""
from __future__ import annotations

import time

from ..settings import calendar_day, day_key, day_start, effective_gaming, is_weekend, weekday_key

LEARN_AHEAD_MS = 20 * 60 * 1000
MIN = 60 * 1000
DAY_LABELS = {"gym30": "lunch gym"}   # web/js/workout.js DAY_TYPES
# Used until the web app has written meta/setPlan from your workout levels.
DEFAULT_SET_PLAN = [
    [{"name": "Push-up", "reps": 6}, {"name": "Bodyweight squat", "reps": 15}],
    [{"name": "Pike push-up (hips high)", "reps": 5}, {"name": "Glute bridge", "reps": 15}],
]


class RuleError(Exception):
    pass


def now_ms() -> float:
    return time.time() * 1000


class Rules:
    def __init__(self, store, settings: dict, clock=now_ms):
        self.store, self.settings, self.clock = store, settings, clock

    # ------------------------------------------------------------------ days
    @property
    def hour(self) -> int:
        return int(self.settings.get("dayStartsAtHour", 4))

    def today(self) -> str:
        return day_key(self.clock(), self.hour)

    def g(self) -> dict:
        return effective_gaming(self.settings, self.today())

    def daily_cap(self) -> int | None:
        """Minutes allowed today, or None for no cap (0 in settings)."""
        g = self.g()
        cap = int(g["dailyCapWeekend"] if is_weekend(self.today()) else g["dailyCapWeekday"])
        return cap if cap > 0 else None

    # ------------------------------------------------------------------ gate
    def gate(self) -> list[dict]:
        s, g, now = self.settings, self.g(), self.clock()
        today = self.today()
        start = day_start(today, self.hour)
        a = s["activity"]
        sched = s["workout"]["schedule"].get(weekday_key(today), "rest")
        items = []
        if g["requireWorkout"]:
            statuses = {w.get("status") for w in self.store.query("workouts", [("day", "==", today)])}
            done_as = "done" if "done" in statuses else (
                "minimum" if "minimum" in statuses and g["countMinimumWorkout"] else None)
            if not done_as and a["watchWorkoutCounts"]:
                watch = [x for x in self.store.query("exercises", [("start", ">=", start)])
                         if x.get("dur", 0) >= a["watchWorkoutMinMinutes"] * 60
                         and "walk" not in str(x.get("type", "")).lower()]   # walks count as steps (workout.js watchCounts)
                if watch:
                    done_as = "watch"
            detail = {"done": "Done", "minimum": "Minimum version done", "watch": "Watch workout recorded"}.get(
                done_as, "Rest day" if sched == "rest" else f"Today's {DAY_LABELS.get(sched, sched)} workout isn't logged yet")
            items.append({"key": "workout", "label": "Workout", "ok": bool(done_as) or sched == "rest", "detail": detail})
        if sched == "rest" and a.get("restDayStepGoal", 0) > 0:
            steps = (self.store.get("daily", calendar_day(now)) or {}).get("steps", 0)
            items.append({"key": "steps", "label": "Rest-day walk", "ok": steps >= a["restDayStepGoal"],
                          "detail": f"{steps:,} / {a['restDayStepGoal']:,} steps"})
        if g["requireKoreanReviews"] or g["requireKoreanNewCards"]:
            parts = []
            if g["requireKoreanReviews"]:
                due = self.store.count("cards", [("due", "<=", now + LEARN_AHEAD_MS)])
                if due:
                    parts.append(f"{due} reviews due")
            if g["requireKoreanNewCards"]:
                quota = self.korean_quota()
                new_today = self.store.count("cards", [("introducedAt", ">=", start)])
                if new_today < quota:
                    left = min(quota - new_today, self.store.count("cards", [("newRank", ">=", 0)]))
                    if left:
                        parts.append(f"{left} new cards left")
            items.append({"key": "korean", "label": "Korean", "ok": not parts,
                          "detail": ", ".join(parts) or "Done for today"})
        return items

    def korean_quota(self) -> int:
        """New cards today. In auto mode the web app sizes it to the time budget and stores it in meta/korean."""
        k = self.settings["korean"]
        if not k.get("autoNewCards"):
            return int(k["newCardsPerDay"])
        m = self.store.get("meta", "korean") or {}
        if m.get("day") == self.today() and m.get("newPerDay") is not None:
            return int(m["newPerDay"])
        return int(m.get("steady") or k["newCardsPerDay"])

    # ------------------------------------------------------------------ sessions
    @staticmethod
    def session_end(s: dict, now: float) -> float:
        end = min(s.get("endedAt") or now, now)
        return min(end, s["plannedEnd"]) if s.get("plannedEnd") else end

    @classmethod
    def session_minutes(cls, s: dict, now: float, since: float = 0) -> float:
        return max(0.0, (cls.session_end(s, now) - max(s["startedAt"], since)) / MIN)

    def active_session(self) -> dict | None:
        open_ = self.store.query("sessions", [("open", "==", True)])
        return max(open_, key=lambda s: s["startedAt"]) if open_ else None

    def sessions_today(self) -> list[dict]:
        return self.store.query("sessions", [("startedAt", ">=", day_start(self.today(), self.hour))])

    def minutes_today(self, sessions: list[dict] | None = None) -> float:
        now = self.clock()
        return sum(self.session_minutes(s, now) for s in (self.sessions_today() if sessions is None else sessions))

    # ------------------------------------------------------------------ sets during play
    def set_status(self, sess: dict | None, sessions: list[dict] | None = None) -> dict | None:
        """When the next set is due. None when sets are switched off (setEveryMinutes 0)."""
        g, now = self.g(), self.clock()
        every = int(g.get("setEveryMinutes") or 0)
        if every <= 0:
            return None
        start = day_start(self.today(), self.hour)
        done = self.store.query("snacks", [("at", ">=", start)])
        last = max((x["at"] for x in done), default=None)
        since = max(last or start, start)
        sessions = self.sessions_today() if sessions is None else sessions
        played = sum(self.session_minutes(s, now, since) for s in sessions)
        plan = (self.store.get("meta", "setPlan") or {}).get("variants") or DEFAULT_SET_PLAN
        return {
            "every": every, "required": bool(g.get("setsRequired")), "minSeconds": int(g.get("setMinSeconds", 30)),
            "today": len(done), "lastAt": last, "playedSince": round(played, 1),
            "dueAt": now + (every - played) * MIN if sess else None,
            "next": plan[len(done) % len(plan)],
        }

    def log_set(self, items: list[dict], source: str = "pc") -> str:
        sess = self.active_session()
        return self.store.add("snacks", {"at": self.clock(), "day": self.today(), "items": items, "source": source,
                                         "session": sess["id"] if sess else None})

    def overrides_today(self) -> int:
        return self.store.count("overrides", [("at", ">=", day_start(self.today(), self.hour))])

    def status(self) -> dict:
        g, now = self.g(), self.clock()
        items = self.gate()
        cap = self.daily_cap()
        sessions = self.sessions_today()
        used = self.minutes_today(sessions)
        sess = self.active_session()
        cooldown_left = 0.0
        if g["cooldownMinutes"] > 0:
            recent = self.store.query("sessions", [("endedAt", ">=", now - g["cooldownMinutes"] * MIN)])
            if recent:
                last_end = max(s["endedAt"] for s in recent)
                cooldown_left = max(0.0, (last_end + g["cooldownMinutes"] * MIN - now) / MIN)
        cap_left = None if cap is None else max(0.0, cap - used)
        blockers = [f"{i['label']}: {i['detail']}" for i in items if not i["ok"]]
        if cap_left is not None and cap_left < 5:
            blockers.append(f"Daily limit reached ({cap} min)")
        if cooldown_left > 0:
            blockers.append(f"Cooldown: {cooldown_left:.0f} min left")
        if cap_left is None:
            choices = sorted(set(g["sessionChoices"]), key=lambda m: (m > 0, m))   # "no limit" first
        else:
            choices = [m for m in g["sessionChoices"] if 0 < m <= cap_left]
            if cap_left >= 5 and int(cap_left) not in choices and (not choices or cap_left < max(g["sessionChoices"])):
                choices.append(int(cap_left))
            choices.sort()
        return {
            "gate": items, "gateOk": all(i["ok"] for i in items), "cap": cap, "used": used, "capLeft": cap_left,
            "cooldownLeft": cooldown_left, "session": sess, "blockers": blockers,
            "canStart": not blockers and sess is None, "choices": choices,
            "overridesLeft": max(0, g["overrideMaxPerDay"] - self.overrides_today()),
            "sets": self.set_status(sess, sessions),
        }

    def _check_override(self, reason: str) -> None:
        g = self.g()
        if self.overrides_today() >= g["overrideMaxPerDay"]:
            raise RuleError("No overrides left today.")
        if len(reason.strip()) < g["overrideMinReasonChars"]:
            raise RuleError(f"Write at least {g['overrideMinReasonChars']} characters explaining why.")

    def start_session(self, minutes: int, next_action: str, override_reason: str | None = None, games: str = "") -> str:
        st, g, now = self.status(), self.g(), self.clock()
        if st["session"]:
            raise RuleError("A session is already running.")
        if not next_action.strip():
            raise RuleError("Say what you'll do right after — it makes stopping much easier.")
        if st["blockers"]:
            if override_reason is None:
                raise RuleError("Locked: " + "; ".join(st["blockers"]))
            self._check_override(override_reason)
            self.store.add("overrides", {"at": now, "kind": "gate", "reason": override_reason.strip(),
                                         "detail": "; ".join(st["blockers"])})
        cap_left = st["capLeft"]
        if minutes <= 0 and cap_left is None:
            planned_end = None                      # open-ended: the sets every N minutes are the stop points
        else:
            fixed = [m for m in g["sessionChoices"] if m > 0]
            limit = max(fixed) if fixed else 24 * 60
            if cap_left is not None:
                # Over the daily cap is only reachable through an override, which buys a short session.
                limit = min(limit, cap_left if cap_left >= 5 else g["overrideExtendMinutes"])
            minutes = int(max(5, min(minutes if minutes > 0 else limit, limit)))
            planned_end = now + minutes * MIN
        return self.store.add("sessions", {"startedAt": now, "plannedEnd": planned_end, "open": True,
                                           "nextAction": next_action.strip(), "games": games})

    def extend_session(self, reason: str) -> None:
        sess = self.active_session()
        if not sess:
            raise RuleError("No session to extend.")
        self._check_override(reason)
        mins = self.g()["overrideExtendMinutes"]
        base = max(sess.get("plannedEnd") or self.clock(), self.clock())
        self.store.update("sessions", sess["id"], {"plannedEnd": base + mins * MIN})
        self.store.add("overrides", {"at": self.clock(), "kind": "extend", "reason": reason.strip(),
                                     "detail": f"+{mins} min"})

    def end_session(self, reason: str = "manual") -> None:
        sess = self.active_session()
        if not sess:
            return
        end = self.session_end(sess, self.clock())
        self.store.update("sessions", sess["id"], {"open": False, "endedAt": end, "endReason": reason})

    def publish(self, st: dict | None = None) -> dict:
        """Write the guardian's view for the web app (meta/gaming) and today's minutes for the heatmap."""
        st = st or self.status()
        now, today = self.clock(), self.today()
        doc = {**st, "at": now}
        if st["session"]:
            doc["session"] = {k: st["session"].get(k) for k in ("id", "startedAt", "plannedEnd", "nextAction", "games")}
        self.store.set("meta", "gaming", doc)
        self.store.update("daily", today, {"day": today, "gameMinutes": round(st["used"], 1)})
        return st

    def handle_request(self, req: dict) -> None:
        """A session requested from the web app. Overrides are only possible on the PC prompt."""
        try:
            sid = self.start_session(int(req.get("minutes") or 0), req.get("nextAction", ""), games="(planned)")
            self.store.update("sessionRequests", req["id"], {"status": "ok", "session": sid})
        except RuleError as e:
            self.store.update("sessionRequests", req["id"], {"status": "error", "message": str(e)})

    def log_event(self, kind: str, detail: str = "") -> None:
        self.store.add("events", {"at": self.clock(), "kind": kind, "detail": detail})
