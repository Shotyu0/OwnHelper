"""User settings (Firestore users/{uid}/meta/settings). Mirrors web/js/settings.js — keep them in sync."""
from __future__ import annotations

import copy
from datetime import date, datetime, timedelta

DEFAULTS = {
    "dayStartsAtHour": 4,
    "profile": {"birthYear": None, "weightKg": None, "goal": "recomp"},
    "korean": {"minutesPerDay": 40, "autoNewCards": True, "newCardsPerDay": 10, "desiredRetention": 0.9,
               "unlockTypingAfterDays": 7},
    "workout": {
        "schedule": {"mon": "gym", "tue": "rest", "wed": "home", "thu": "rest", "fri": "gym", "sat": "home", "sun": "rest"},
        "homeEquipment": [], "units": "lb", "restCompound": 150, "restAccessory": 90,
    },
    "activity": {"stepGoalAuto": True, "stepGoal": 8000, "restDayStepGoal": 0, "watchWorkoutCounts": True,
                 "watchWorkoutMinMinutes": 20},
    "moveBreaks": {"enabled": True, "everyMinutes": 30, "awayMinutes": 3, "snoozeMinutes": 15},
    "gaming": {
        "requireWorkout": True, "countMinimumWorkout": True, "requireKoreanReviews": True, "requireKoreanNewCards": True,
        # 0 = no limit (session choices, daily caps, set interval).
        "sessionChoices": [0, 30, 60, 90, 120], "dailyCapWeekday": 0, "dailyCapWeekend": 0, "cooldownMinutes": 0,
        "setEveryMinutes": 30, "setsRequired": True, "setMinSeconds": 30,
        "warnAtMinutes": [10, 2], "graceSeconds": 60,
        "overrideWaitSeconds": 60, "overrideMinReasonChars": 25, "overrideMaxPerDay": 1, "overrideExtendMinutes": 15,
    },
}
DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def with_defaults(saved: dict | None) -> dict:
    out = copy.deepcopy(DEFAULTS)
    for k, v in (saved or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


def effective_gaming(settings: dict, today: str) -> dict:
    """Loosened gaming limits only apply from the day after they were changed."""
    p = settings.get("gamingPending")
    if p and today >= p.get("effective", "9999"):
        return {**settings["gaming"], **p.get("values", {})}
    return settings["gaming"]


# --------------------------------------------------------------------------- days (local time, epoch ms)
def day_key(ms: float, start_hour: int) -> str:
    return (datetime.fromtimestamp(ms / 1000) - timedelta(hours=start_hour)).date().isoformat()


def day_start(key: str, start_hour: int) -> float:
    d = date.fromisoformat(key)
    return datetime(d.year, d.month, d.day, start_hour).timestamp() * 1000


def calendar_day(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000).date().isoformat()


def weekday_key(key: str) -> str:
    return DAY_KEYS[date.fromisoformat(key).weekday()]


def is_weekend(key: str) -> bool:
    return date.fromisoformat(key).weekday() >= 5
