"""Gaming rules, enforced by the PC guardian. They read the same Firestore documents the web app writes.

Design: you decide *before* playing (gate + session length + what you'll do next), when you're in a
"cold" state. The guardian enforces that decision in the "hot" state, when stopping is hard.
Overrides exist but cost a wait and a written reason; they're logged and shown on the dashboard.

Gate inputs (same as web/js/pages/today.js gateInputs):
  workouts/{id}.day/status, exercises (watch) .start/.dur, cards .due/.introducedAt/.newRank,
  daily/{calendar day}.steps (kept by the relay).
"""
from __future__ import annotations

import time

from ..settings import calendar_day, day_key, day_start, effective_gaming, is_weekend, weekday_key

LEARN_AHEAD_MS = 20 * 60 * 1000
MIN = 60 * 1000


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

    def daily_cap(self) -> int:
        g = self.g()
        return int(g["dailyCapWeekend"] if is_weekend(self.today()) else g["dailyCapWeekday"])

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
                done_as, "Rest day" if sched == "rest" else f"Today's {sched} workout isn't logged yet")
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
                quota = int(s["korean"]["newCardsPerDay"])
                new_today = self.store.count("cards", [("introducedAt", ">=", start)])
                if new_today < quota:
                    left = min(quota - new_today, self.store.count("cards", [("newRank", ">=", 0)]))
                    if left:
                        parts.append(f"{left} new cards left")
            items.append({"key": "korean", "label": "Korean", "ok": not parts,
                          "detail": ", ".join(parts) or "Done for today"})
        return items

    # ------------------------------------------------------------------ sessions
    @staticmethod
    def session_minutes(s: dict, now: float) -> float:
        end = min(s.get("endedAt") or now, s["plannedEnd"])
        return max(0.0, (end - s["startedAt"]) / MIN)

    def active_session(self) -> dict | None:
        open_ = self.store.query("sessions", [("open", "==", True)])
        return max(open_, key=lambda s: s["startedAt"]) if open_ else None

    def minutes_today(self) -> float:
        start = day_start(self.today(), self.hour)
        now = self.clock()
        return sum(self.session_minutes(s, now) for s in self.store.query("sessions", [("startedAt", ">=", start)]))

    def overrides_today(self) -> int:
        return self.store.count("overrides", [("at", ">=", day_start(self.today(), self.hour))])

    def status(self) -> dict:
        g, now = self.g(), self.clock()
        items = self.gate()
        cap = self.daily_cap()
        used = self.minutes_today()
        sess = self.active_session()
        recent = self.store.query("sessions", [("endedAt", ">=", now - g["cooldownMinutes"] * MIN)])
        cooldown_left = 0.0
        if recent:
            last_end = max(s["endedAt"] for s in recent)
            cooldown_left = max(0.0, (last_end + g["cooldownMinutes"] * MIN - now) / MIN)
        cap_left = max(0.0, cap - used)
        blockers = [f"{i['label']}: {i['detail']}" for i in items if not i["ok"]]
        if cap_left < 5:
            blockers.append(f"Daily limit reached ({cap} min)")
        if cooldown_left > 0:
            blockers.append(f"Cooldown: {cooldown_left:.0f} min left")
        choices = [m for m in g["sessionChoices"] if m <= cap_left]
        if cap_left >= 5 and int(cap_left) not in choices and (not choices or cap_left < max(g["sessionChoices"])):
            choices.append(int(cap_left))
        return {
            "gate": items, "gateOk": all(i["ok"] for i in items), "cap": cap, "used": used, "capLeft": cap_left,
            "cooldownLeft": cooldown_left, "session": sess, "blockers": blockers,
            "canStart": not blockers and sess is None, "choices": sorted(choices),
            "overridesLeft": max(0, g["overrideMaxPerDay"] - self.overrides_today()),
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
        limit = max(g["sessionChoices"])
        # Over the daily cap is only reachable through an override, which buys a short session.
        limit = min(limit, st["capLeft"] if st["capLeft"] >= 5 else g["overrideExtendMinutes"])
        minutes = int(max(5, min(minutes, limit)))
        return self.store.add("sessions", {"startedAt": now, "plannedEnd": now + minutes * MIN, "open": True,
                                           "nextAction": next_action.strip(), "games": games})

    def extend_session(self, reason: str) -> None:
        sess = self.active_session()
        if not sess:
            raise RuleError("No session to extend.")
        self._check_override(reason)
        mins = self.g()["overrideExtendMinutes"]
        base = max(sess["plannedEnd"], self.clock())
        self.store.update("sessions", sess["id"], {"plannedEnd": base + mins * MIN})
        self.store.add("overrides", {"at": self.clock(), "kind": "extend", "reason": reason.strip(),
                                     "detail": f"+{mins} min"})

    def end_session(self, reason: str = "manual") -> None:
        sess = self.active_session()
        if not sess:
            return
        end = min(self.clock(), sess["plannedEnd"])
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
            sid = self.start_session(int(req.get("minutes", 30)), req.get("nextAction", ""), games="(planned)")
            self.store.update("sessionRequests", req["id"], {"status": "ok", "session": sid})
        except RuleError as e:
            self.store.update("sessionRequests", req["id"], {"status": "error", "message": str(e)})

    def log_event(self, kind: str, detail: str = "") -> None:
        self.store.add("events", {"at": self.clock(), "kind": kind, "detail": detail})
