# Personal Helper

A private app for three goals: **work out consistently**, **learn Korean (reading first, then typing)**, and
**stop gaming when I meant to**, with smartwatch data for steps, workouts and heart rate.

```
 phone / PC browser                     Firebase (your project)               PC (Windows)
 ┌───────────────────────┐   sync    ┌──────────────────────────┐  read/write ┌─────────────────────────┐
 │ web app (GitHub Pages)│◄────────►│ Firestore users/{uid}/…   │◄───────────►│ guardian (closes games  │
 │ Today · Workout ·     │  Google   │ cards, workouts, daily,   │ service acct│ outside sessions)       │
 │ Korean · Activity ·   │  sign-in  │ sessions, activity, …     │             │ Korean reader :5057     │
 │ Gaming · Plan · …     │           └──────────────▲───────────┘             └─────────────────────────┘
 └───────────────────────┘                          │ service account
 watch → Samsung Health / Fitbit → Health Connect → HC Webhook app → Cloudflare Worker (relay/)
```

- **web/**: static web app (no build step). Works offline at the gym and syncs when back online. Add it to
  your phone's home screen from Chrome's menu.
- **relay/**: Cloudflare Worker that receives watch data from the HC Webhook Android app.
- **helper/**: Python on the PC. The gaming guardian, plus the Korean reader (its language model is ~100 MB,
  too big for a phone).

## Setup (once)

**1. Firebase** (you can reuse the console you used for Kina Ledger, but make a *new* project):
1. Create a project → **Build → Firestore Database** → create (production mode).
2. **Build → Authentication** → Get started → enable **Google**. Under Settings → Authorized domains, make
   sure `<you>.github.io` is listed.
3. **Project settings → General → Your apps** → add a Web app → copy its config into `web/config.js`
   (`firebase: { apiKey, authDomain, projectId, appId }`).
4. **Project settings → Service accounts → Generate new private key**. Save it as
   `data/service-account.json` on the PC (data/ is git-ignored). The Worker gets the same key as a secret.

**2. Publish the web app.** Push this folder to a GitHub repo, then go to Settings → Pages → Source:
**GitHub Actions**. `.github/workflows/pages.yml` publishes `web/` on every push. Open the site and sign in
with Google. You'll see "This Google account isn't allowed" with your **uid**. That's expected: put the uid in
`firestore.rules` (replacing `OWNER_UID`), paste the rules into Firebase console → Firestore → Rules, and
sign in again.

**3. PC guardian.** In `config.toml` set `[cloud] uid` and `web_url`, then:
```
start.bat                                                                 # start now
powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1    # start at every login
.venv\Scripts\python -m helper check                                      # test the connection
```
A fresh PC needs `python -m venv .venv` and `.venv\Scripts\pip install -r requirements.txt` first.

**4. Watch sync (Galaxy / Pixel / Wear OS).**
```
cd relay
npx wrangler login
npx wrangler secret put FIREBASE_SA      # paste the service account JSON
npx wrangler secret put HC_TOKEN         # paste a long random string
# set OWNER_UID in wrangler.toml to your uid, then:
npx wrangler deploy
```
Put the Worker URL in `web/config.js` (`relay`). On the phone:
1. Let your watch app write to **Health Connect**: on a Pixel Watch that's the **Google Health** app (formerly
   Fitbit); on a Galaxy Watch, Samsung Health.
2. Install **HC Webhook** ([github.com/mcnaveen/health-connect-webhook](https://github.com/mcnaveen/health-connect-webhook), on Google Play).
3. Set the webhook URL to `https://<worker>/hc` and add the header `Authorization: Bearer <HC_TOKEN>`.
4. Choose Steps, Heart rate, Exercise, Active calories, Distance, Weight, Resting heart rate, VO2 max and Body fat,
   and sync every 15–30 min.
5. On a Galaxy Watch, set heart rate to **measure continuously** (Galaxy Wearable → Watch settings → Samsung
   Health → Heart rate). The app uses it to check your in-game sets afterwards.

The web app's Settings page shows the exact URL and, once the relay is deployed, has Copy buttons for the URL
and the header (the token is kept in your private Firestore at meta/relay so the phone can copy it).

**Korean keyboard:** Windows Settings → Time & Language → Language → add 한국어. Switch with Win+Space,
then Right Alt toggles 한/A. On Android, add Korean in Gboard / Samsung Keyboard.

## Daily flow

1. **Today** shows the gate (today's workout + Korean). Games stay locked until both are done.
2. **Workout**: log sets on your phone; the app sets next session's targets. A watch-recorded workout of 20+ min
   (not a walk) also counts. Schedule days can be gym, **lunch gym (30 min)**, home or rest. Lunch sessions
   alternate upper and lower, each as two supersets (alternate two exercises with 60 s rest), which roughly
   halves the time for the same sets (Iversen et al. 2021).
3. **Korean**: clear the due reviews plus today's new words. New words are sized so the long-run load fits
   your daily minutes (40 by default), using your own answer speed once there's enough of it.
4. **Gaming**: no daily cap. Before playing, say what you'll do right after (and a length if you want one).
   Every 30 minutes of play a short set is due: an upper-body move plus a leg move at your home-workout level
   (e.g. 6 push-ups + 15 squats). Warnings come at 10 and 2 minutes, so you can do it between matches. If it's
   overdue, you get 60 s to save, then the game is closed until the set is logged (on the PC prompt or the
   phone). The watch checks each set afterwards for a heart-rate rise.
   **Dinner break** (6–9 PM, once a day): no sets while you eat. Start it from the session dialog ("I'm eating
   dinner"), the set prompts ("Eating dinner"), **Ctrl+Alt+D**, or the Gaming page. Sets wait 45 min (Ctrl+Alt+D
   again or "Done eating" ends it early), play during dinner doesn't count, and a set that comes due is moved to
   right after dinner, not skipped.
   **Away from the PC** (AFK, e.g. leaving the game idling): after 5 minutes with no keyboard or mouse input, the
   time away (from your last input) doesn't count toward the next set, and an overdue set never closes the game
   while you're gone: its 60 s countdown starts when you're back. "Back" means input at two moments a few seconds
   apart: AION 2 sends a fake mouse event every 50 s while it runs (to keep the PC awake), and a lone event like that,
   or a bumped mouse, doesn't count. Game controllers aren't seen by this check. `data/helper.log` records when you
   went away and came back, and why a set prompt closed a game.
   **Treadmill walk**: walking already breaks up the sitting, so while a walk is running (Ctrl+Alt+W, or the Today
   button) play doesn't count toward the next set and no set warnings come. The clock picks up after the walk, and a
   set that was already due when you started walking still has to be done.
5. **At the desk**: after 30 minutes at the PC, a small nudge to get up and walk for 3–5 minutes. It clears
   itself once the PC sees you've been away for 3 minutes. Not shown while gaming. With a treadmill under the
   desk (Settings), it asks you to walk while you work instead. "Walking now" (or **Ctrl+Alt+W**, or the button on
   Today) logs a **treadmill walk**: a small timer with Stop, an optional treadmill step reading at the end, and a
   "still walking?" check every 30 min. A wrist watch barely counts steps when your hands rest on the desk (wrist
   trackers undercount with no arm swing), so inside a walk the walk's steps replace the watch's. Typed-in readings
   teach the estimate your pace (85 steps/min to start).
   Walk rather than just stand: standing more didn't lower heart-disease risk (Ahmadi et al. 2024).
6. **Plan** shows your targets (steps, protein, weight change, Korean, sets) with the reasons and sources.
   Add your birth year and weight there; recent watch readings take over automatically.

## How it works (and why)

**Gaming guardian.** You're proactive before playing and stuck once you start, so every decision happens
before:
- **Pre-commitment** (Ariely & Wertenbroch 2002).
- **"Right after, I will…"** plans, which roughly double follow-through (Gollwitzer & Sheeran 2006).
- **Premack principle**: games come after the hard things.

A set every 30 minutes of play is the stop point: you get up, move, and decide again with a clear head.
Optional daily cap and cooldown (off by default), and **overrides only on the PC prompt**: a 60 s wait plus a written
reason, 1/day, shown on the dashboard. Changes in Settings that **loosen** limits take effect tomorrow, so they
can't be made mid-urge. If the guardian is killed, the gap is logged on its next start.

**Korean.** **FSRS** spaced repetition ([ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), the
scheduler in Anki). The order is:
1. Hangul.
2. Loanwords, to practise decoding.
3. The most frequent words, with the grammar needed to parse sentences mixed in early.

Each word starts as a **reading card**. Its **typing card** unlocks once the reading memory lasts 7+ days,
because recognizing a word comes before producing it. Typing is checked letter by letter (jamo).

The **Reader** (PC) shows what % of a pasted text you know: ~95% is good for learning, ~98% is comfortable
(Hu & Nation 2000). Click an unknown word to add it with its sentence; your own words come before the starter deck.

**Workouts.** Full-body 3–4×/week, so each muscle gets ~2 sessions/week. **Double progression**: once every set
hits the top of the rep range, add weight (gym) or move to a harder bodyweight variation (home). Two sessions
below the range → a small step back. The 10-minute **minimum version** keeps the streak and the gate, because
consistency beats intensity and one missed day doesn't break a habit (Lally et al. 2010).

**Activity.** Steps are de-duplicated when both the phone and the watch count them. The weekly step goal starts
1,000 above your own baseline (median of your first days of watch data) and goes up 1,000 when you hit it on
5 days of the week, toward 10,000 for fat loss or 8,000 for health (7,000 if 60+). Health benefits level off
around 7,000–8,000 (Ding et al. 2025, Paluch et al. 2022); for fat loss, walking is extra energy out that doesn't
cost recovery. Walking breaks every 30 minutes lowered blood sugar and blood pressure in a lab trial (Duran et
al. 2023). You can set a rest-day step goal as part of the gate.

**Sets while gaming.** Brief "exercise snacks" through the day build strength and fitness, and with weekly
volume equal, many small bouts work about as well as a few big ones. The sets stop well short of failure,
so they don't hurt your next workout. The watch can't unlock the game (it syncs every 15+ minutes), so a set
logged without a heart-rate rise shows up as "no HR rise seen".

## Limits

- The guardian can be closed in Task Manager. That isn't prevented, but it's logged.
- A game running **as administrator** or protected by anti-cheat may refuse to close. That's logged as
  "kill failed". Fix: run the guardian elevated with Task Scheduler ("Run with highest privileges").
- Only Steam games, plus exes you list in `config.toml`, are guarded.
- Sessions need Firebase. If the internet is down, games can't be unlocked (an already running session continues).
- Health Connect deletions of steps/heart-rate records aren't mirrored (deleted watch workouts are).

## Development

```
npm install && npm test                      # JS: SRS, progression, settings, relay transform, Worker auth
.venv\Scripts\python -m pytest -q tests      # Python: gaming rules, guardian decisions, reader
.venv\Scripts\python scripts\serve.py        # preview web/ at http://127.0.0.1:8080 (fixes .js MIME on Windows)
node scripts/csp-hash.mjs                     # after editing the import map in web/index.html
```
With `firebase: null` in `web/config.js`, the web app keeps everything in that browser (good for trying it).
