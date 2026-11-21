from datetime import datetime

import pytest

from helper.cloud import MemoryStore
from helper.gaming.rules import MIN, Rules, RuleError
from helper.settings import day_start, with_defaults

SAT_NOON = datetime(2026, 11, 21, 12, 0).timestamp() * 1000   # Saturday (weekend cap 180)


def make(clock_box, **gaming):
    store = MemoryStore()
    s = with_defaults({"workout": {"schedule": {d: "home" for d in ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}}})
    s["gaming"].update(gaming)
    return store, Rules(store, s, clock=lambda: clock_box[0])


def open_gate(**extra):
    return dict(requireWorkout=False, requireKoreanReviews=False, requireKoreanNewCards=False, **extra)


def test_gate_reads_workouts_watch_and_cards():
    clock = [SAT_NOON]
    store, r = make(clock)
    store.set("cards", "a_r", {"kind": "read", "status": "active", "due": SAT_NOON - 1000})
    store.set("cards", "b_r", {"kind": "read", "status": "new", "newRank": 5})
    items = {i["key"]: i for i in r.gate()}
    assert not items["workout"]["ok"] and "home workout" in items["workout"]["detail"]
    assert items["korean"]["detail"] == "1 reviews due, 1 new cards left"
    # a long walk doesn't count as the workout, a 25-minute run does
    store.set("exercises", "w", {"start": SAT_NOON - 7200e3, "dur": 60 * 60, "type": "walking"})
    assert not {i["key"]: i for i in r.gate()}["workout"]["ok"]
    store.set("exercises", "x", {"start": SAT_NOON - 3600e3, "dur": 25 * 60, "type": "running"})
    assert {i["key"]: i for i in r.gate()}["workout"]["detail"] == "Watch workout recorded"
    store.update("cards", "a_r", {"due": SAT_NOON + 864e5})
    store.update("cards", "b_r", {"newRank": None, "introducedAt": SAT_NOON})
    store.data["cards"]["b_r"].pop("newRank")
    assert all(i["ok"] for i in r.gate())


def test_minimum_workout_and_rest_day_steps():
    clock = [SAT_NOON]
    store, r = make(clock, requireKoreanReviews=False, requireKoreanNewCards=False)
    store.set("workouts", "w", {"day": "2026-11-21", "status": "minimum"})
    assert r.gate()[0]["detail"] == "Minimum version done"
    r.settings["gaming"]["countMinimumWorkout"] = False
    assert not r.gate()[0]["ok"]
    r.settings["workout"]["schedule"]["sat"] = "rest"
    r.settings["activity"]["restDayStepGoal"] = 6000
    store.set("daily", "2026-11-21", {"steps": 4200})
    items = {i["key"]: i for i in r.gate()}
    assert items["workout"]["ok"] and not items["steps"]["ok"] and items["steps"]["detail"] == "4,200 / 6,000 steps"


def test_locked_gate_needs_override_and_overrides_are_limited():
    clock = [SAT_NOON]
    store, r = make(clock)
    store.set("cards", "a_r", {"due": SAT_NOON})
    with pytest.raises(RuleError, match="Locked"):
        r.start_session(30, "sleep")
    with pytest.raises(RuleError, match="25 characters"):
        r.start_session(30, "sleep", override_reason="too short")
    sid = r.start_session(30, "sleep", override_reason="Friends are online for a one-off raid tonight")
    assert store.get("sessions", sid)["open"] and r.overrides_today() == 1
    r.end_session()
    clock[0] += 60 * MIN
    with pytest.raises(RuleError, match="No overrides left"):
        r.start_session(30, "sleep", override_reason="Friends are online for a one-off raid tonight")


def test_cap_cooldown_and_publish():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    st = r.status()
    assert st["canStart"] and st["choices"] == [30, 45, 60, 90] and st["cap"] == 180
    with pytest.raises(RuleError, match="right after"):
        r.start_session(30, "  ")
    r.start_session(90, "dinner", games="Terraria")
    assert r.status()["session"]["games"] == "Terraria"
    clock[0] += 95 * MIN
    r.end_session("timeout")
    st = r.status()
    assert round(st["used"]) == 90 and st["cooldownLeft"] > 0 and not st["canStart"]
    published = r.publish(st)
    assert store.get("meta", "gaming")["used"] == published["used"]
    assert store.get("daily", "2026-11-21")["gameMinutes"] == 90
    clock[0] += 60 * MIN
    st = r.status()
    assert st["cooldownLeft"] == 0 and st["canStart"] and max(st["choices"]) == 90
    r.start_session(90, "bed")
    clock[0] += 120 * MIN
    r.end_session("timeout")
    clock[0] += 60 * MIN
    st = r.status()
    assert st["capLeft"] == 0 and "Daily limit reached (180 min)" in st["blockers"]


def test_extend_and_web_requests():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    store.set("sessionRequests", "q1", {"minutes": 45, "nextAction": "read", "status": "pending"})
    r.handle_request(store.get("sessionRequests", "q1"))
    q = store.get("sessionRequests", "q1")
    assert q["status"] == "ok" and store.get("sessions", q["session"])["plannedEnd"] == SAT_NOON + 45 * MIN
    store.set("sessionRequests", "q2", {"minutes": 45, "nextAction": "read", "status": "pending"})
    r.handle_request(store.get("sessionRequests", "q2"))
    assert store.get("sessionRequests", "q2")["message"] == "A session is already running."
    clock[0] += 46 * MIN
    r.extend_session("The boss fight started two minutes before the end")
    assert r.active_session()["plannedEnd"] == clock[0] + 15 * MIN


def test_loosened_limits_wait_until_tomorrow():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    r.settings["gamingPending"] = {"values": {"dailyCapWeekend": 300}, "effective": "2026-11-22"}
    assert r.daily_cap() == 180
    clock[0] += 864e5
    assert r.daily_cap() == 300


def test_day_rolls_over_at_4am():
    late = datetime(2026, 11, 22, 1, 30).timestamp() * 1000
    clock = [late]
    _, r = make(clock)
    assert r.today() == "2026-11-21"
    assert day_start("2026-11-21", 4) == datetime(2026, 11, 21, 4).timestamp() * 1000
