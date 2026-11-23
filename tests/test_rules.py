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


# The caps and cooldown still work when set; the defaults are now "no cap".
CAPPED = dict(sessionChoices=[30, 45, 60, 90], dailyCapWeekday=120, dailyCapWeekend=180, cooldownMinutes=45)


def test_cap_cooldown_and_publish():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate(**CAPPED))
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
    store, r = make(clock, **open_gate(**CAPPED))
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


def test_no_cap_by_default_and_open_ended_sessions():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    st = r.status()
    assert st["cap"] is None and st["capLeft"] is None and st["choices"][0] == 0 and st["canStart"]
    sid = r.start_session(0, "dinner")
    assert store.get("sessions", sid)["plannedEnd"] is None
    clock[0] += 300 * MIN                                   # 5 hours: nothing blocks, nothing ends by itself
    st = r.status()
    assert round(st["used"]) == 300 and not [b for b in st["blockers"] if "limit" in b.lower()]
    r.end_session()
    assert store.get("sessions", sid)["endedAt"] == clock[0]


def test_sets_are_due_every_30_min_of_play_across_sessions():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    assert r.status()["sets"]["dueAt"] is None                # no session, nothing due
    r.start_session(0, "dinner")
    st = r.status()["sets"]
    assert st["dueAt"] == SAT_NOON + 30 * MIN and st["next"] and st["required"]
    clock[0] += 20 * MIN
    r.end_session()                                         # stopping and restarting doesn't reset the clock
    clock[0] += 5 * MIN
    r.start_session(0, "dinner")
    assert r.status()["sets"]["dueAt"] == clock[0] + 10 * MIN
    clock[0] += 12 * MIN                                    # 2 min overdue
    assert r.status()["sets"]["dueAt"] < clock[0]
    r.log_set([{"name": "Push-up", "reps": 6}])
    st = r.status()["sets"]
    assert st["today"] == 1 and st["dueAt"] == clock[0] + 30 * MIN
    assert store.query("snacks")[0]["session"] == r.active_session()["id"]
    store.set("meta", "setPlan", {"variants": [{"items": [{"name": "A", "reps": 1}]}, {"items": [{"name": "B", "reps": 2}]}]})
    assert r.status()["sets"]["next"] == [{"name": "B", "reps": 2}]   # alternates by sets done today
    r.settings["gaming"]["setEveryMinutes"] = 0
    assert r.status()["sets"] is None


SAT_6PM = datetime(2026, 11, 21, 18, 30).timestamp() * 1000


def test_dinner_break_pauses_the_set_clock_once_a_day_in_the_evening():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    assert not r.dinner()["canStart"]
    with pytest.raises(RuleError, match="between 6 PM and 9 PM"):
        r.start_dinner()
    clock[0] = SAT_6PM
    r.start_session(0, "dishes")
    clock[0] += 25 * MIN                                    # set due in 5 min, then dinner arrives
    assert r.status()["dinner"]["canStart"]
    doc = r.start_dinner("pc")
    assert store.get("daily", "2026-11-21")["dinner"] == doc and doc["end"] == clock[0] + 45 * MIN
    st = r.status()
    assert st["dinner"]["active"] and not st["dinner"]["canStart"]
    assert st["sets"]["dueAt"] == doc["end"] + 5 * MIN      # the remaining 5 min of play start after dinner
    clock[0] += 30 * MIN                                    # eating and playing: the clock doesn't move
    assert r.status()["sets"]["dueAt"] == doc["end"] + 5 * MIN
    r.end_dinner()                                          # done early
    st = r.status()
    assert not st["dinner"]["active"] and st["sets"]["dueAt"] == clock[0] + 5 * MIN
    with pytest.raises(RuleError, match="today's dinner break"):
        r.start_dinner()                                    # once a day
    r.settings["gaming"]["dinnerMinutes"] = 0
    assert not r.dinner()["canStart"]


def test_a_set_that_comes_due_while_eating_waits_until_after_dinner():
    clock = [SAT_6PM]
    store, r = make(clock, **open_gate())
    r.start_session(0, "dishes")
    clock[0] += 32 * MIN                                    # already 2 min overdue
    doc = r.start_dinner()
    assert r.status()["sets"]["dueAt"] == doc["end"]        # postponed to the end of dinner, not skipped
    clock[0] = doc["end"] + 1
    st = r.status()
    assert not st["dinner"]["active"] and st["sets"]["dueAt"] < clock[0]


def test_time_away_from_the_pc_doesnt_count_toward_sets():
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    sid = r.start_session(0, "sleep")
    clock[0] += 20 * MIN
    r.mark_away(sid, clock[0])                              # AFK
    clock[0] += 60 * MIN
    st = r.status()["sets"]
    assert st["awaySince"] == SAT_NOON + 20 * MIN and st["playedSince"] == 20 and st["dueAt"] == clock[0] + 10 * MIN
    r.mark_back(sid, clock[0])
    r.mark_back(sid, clock[0] + 5)                          # a second call changes nothing
    clock[0] += 5 * MIN
    st = r.status()["sets"]
    assert st["awaySince"] is None and st["dueAt"] == clock[0] + 5 * MIN
    assert store.get("sessions", sid)["away"] == [{"s": SAT_NOON + 20 * MIN, "e": SAT_NOON + 80 * MIN}]
    r.mark_away(sid, clock[0])
    clock[0] += 10 * MIN
    r.end_session()                                         # ending while away closes the away period
    s = store.get("sessions", sid)
    assert s["awaySince"] is None and s["away"][-1] == {"s": clock[0] - 10 * MIN, "e": clock[0]}


def test_away_during_dinner_is_only_taken_off_once():
    clock = [SAT_6PM]
    store, r = make(clock, **open_gate())
    sid = r.start_session(0, "dishes")
    clock[0] += 10 * MIN
    r.start_dinner()                                        # 45 min: until +55
    r.mark_away(sid, SAT_6PM + 20 * MIN)
    r.mark_back(sid, SAT_6PM + 70 * MIN)                    # away overlaps the end of dinner
    clock[0] = SAT_6PM + 80 * MIN
    assert r.status()["sets"]["playedSince"] == 20          # 80 min minus 60 min eating-or-away


def test_korean_quota_comes_from_the_web_apps_daily_plan():
    clock = [SAT_NOON]
    store, r = make(clock)
    assert r.korean_quota() == 10                           # nothing computed yet: settings value
    store.set("meta", "korean", {"day": "2026-11-20", "newPerDay": 4, "steady": 9})
    assert r.korean_quota() == 9                            # yesterday's plan: use its steady rate
    store.set("meta", "korean", {"day": "2026-11-21", "newPerDay": 4, "steady": 9})
    assert r.korean_quota() == 4
    r.settings["korean"]["autoNewCards"] = False
    assert r.korean_quota() == 10


def test_lunch_gym_day_label():
    clock = [datetime(2026, 11, 23, 12, 0).timestamp() * 1000]      # Monday
    store, r = make(clock)
    r.settings["workout"]["schedule"]["mon"] = "gym30"
    assert r.gate()[0]["detail"] == "Today's lunch gym workout isn't logged yet"


def test_a_treadmill_walk_pauses_the_set_clock():
    from helper import walks
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    r.start_session(0, "dishes")
    clock[0] += 20 * MIN                                    # 10 min of play left, then you start walking
    walks.start_walk(store, clock[0])
    st = r.status()["sets"]
    assert st["walkingSince"] == clock[0] and st["dueAt"] is None   # nothing comes due or warns mid-walk
    clock[0] += 40 * MIN                                    # walking and playing for 40 min
    st = r.status()["sets"]
    assert st["dueAt"] is None and st["playedSince"] == 20
    walks.stop_walk(store, clock[0])                        # stored in daily/{day}.walks; the clock picks up
    st = r.status()["sets"]
    assert st["walkingSince"] is None and st["dueAt"] == clock[0] + 10 * MIN


def test_a_set_already_due_when_you_start_walking_is_still_due():
    from helper import walks
    clock = [SAT_NOON]
    store, r = make(clock, **open_gate())
    r.start_session(0, "dishes")
    clock[0] += 31 * MIN                                    # 1 min overdue
    walks.start_walk(store, clock[0])
    clock[0] += 10 * MIN
    st = r.status()["sets"]
    assert st["walkingSince"] and st["dueAt"] == clock[0] - 1 * MIN   # walking doesn't cancel a set you owe


def test_a_forgotten_walk_stops_pausing_sets_after_4_hours():
    from helper import walks
    clock = [SAT_NOON - 5 * 60 * MIN]
    store, r = make(clock, **open_gate())
    walks.start_walk(store, clock[0])                       # left running, never stopped
    clock[0] = SAT_NOON
    r.start_session(0, "dishes")
    clock[0] += 10 * MIN
    st = r.status()["sets"]
    assert st["walkingSince"] is None and st["dueAt"] == clock[0] + 20 * MIN
