"""Treadmill-desk walks (mirrors web/js/walks.js — keep them in sync).

A wrist watch barely counts steps while your hands rest on the desk, so a walk is logged with its start and end;
inside that window the walk's steps replace the watch's (web/js/activity.js stepsWithWalks, relay/worker.js).

  meta/walk       {start: ms | None, src}      the walk in progress, if any
  meta/walkStats  {cadence}                    your steps per minute, learned from treadmill readings
  daily/{day}.walks.<start ms>  {s, e, steps, est, src}   day = calendar day the walk started
"""
from __future__ import annotations

from .settings import calendar_day

DEFAULT_CADENCE = 85   # steps/min at ~1.5 mph
MAX_WALK_MIN = 240


def open_walk(store) -> dict | None:
    w = store.get("meta", "walk") or {}
    return w if w.get("start") else None


def cadence(store) -> float:
    return (store.get("meta", "walkStats") or {}).get("cadence") or DEFAULT_CADENCE


def start_walk(store, now: float, src: str = "pc") -> None:
    store.set("meta", "walk", {"start": now, "src": src})


def stop_walk(store, now: float, end: float | None = None, steps: int | None = None) -> dict | None:
    """Ends the open walk at `end` and stores it. `steps` from the treadmill display, or None to estimate."""
    w = open_walk(store)
    if not w:
        return None
    end = min(end if end is not None else now, w["start"] + MAX_WALK_MIN * 60000)
    minutes = max(0.0, (end - w["start"]) / 60000)
    walk = None
    if minutes >= 1:
        est = not steps or steps <= 0
        if est:
            steps = round(minutes * cadence(store))
        else:
            c = steps / minutes
            if 40 <= c <= 140:
                store.set("meta", "walkStats", {"cadence": round(0.7 * cadence(store) + 0.3 * c)})
        day = calendar_day(w["start"])
        walks = dict((store.get("daily", day) or {}).get("walks") or {})
        walk = {"s": w["start"], "e": end, "steps": int(round(steps)), "est": est, "src": w.get("src") or "pc"}
        walks[str(int(w["start"]))] = walk
        store.update("daily", day, {"day": day, "walks": walks})
    # Cleared last, so the walk is always findable (the set clock pauses while you walk; gaming/rules.py).
    store.set("meta", "walk", {"start": None, "src": w.get("src")})
    return {**walk, "minutes": minutes} if walk else None
