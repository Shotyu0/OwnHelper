# Personal Helper

A private app for three goals: **work out consistently**, **learn Korean (reading first, then typing)**, and
**stop gaming when I meant to**, with smartwatch data for steps, workouts and heart rate.

```
 phone / PC browser                     Firebase (your project)               PC (Windows)
 ┌───────────────────────┐   sync    ┌──────────────────────────┐  read/write ┌─────────────────────────┐
 │ web app (GitHub Pages)│◄────────►│ Firestore users/{uid}/…   │◄───────────►│ guardian (closes games  │
 │ Today · Workout ·     │  Google   │ cards, workouts, daily,   │ service acct│ outside sessions)       │
 │ Korean · Activity ·   │  sign-in  │ sessions, activity, …     │             │ Korean reader :5057     │
 │ Gaming · Settings     │           └──────────────▲───────────┘             └─────────────────────────┘
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
1. Let Samsung Health / Fitbit write to **Health Connect**.
2. Install **HC Webhook** ([github.com/mcnaveen/health-connect-webhook](https://github.com/mcnaveen/health-connect-webhook), on Google Play).
3. Set the webhook URL to `https://<worker>/hc` and add the header `Authorization: Bearer <HC_TOKEN>`.
4. Choose Steps, Heart rate (1-minute), Exercise, Active calories and Distance, and sync every 30–60 min.

The web app's Settings page shows the exact URL.

**Korean keyboard:** Windows Settings → Time & Language → Language → add 한국어. Switch with Win+Space,
then Right Alt toggles 한/A. On Android, add Korean in Gboard / Samsung Keyboard.

## Daily flow

1. **Today** shows the gate (today's workout + Korean). Games stay locked until both are done.
2. **Workout**: log sets on your phone; the app sets next session's targets. A watch-recorded workout of 20+ min
   (not a walk) also counts.
3. **Korean**: clear the due reviews plus 10 new cards (~15–20 min/day once it settles).
4. **Gaming**: before playing, choose how long and what you'll do right after, here or on the PC prompt.
   Launching a Steam game without a session closes it and asks. You get warnings at 10 and 2 min, then 60 s
   to save, then the game is closed.

## How it works (and why)

**Gaming guardian.** You're proactive before playing and stuck once you start, so every decision happens
before:
- **Pre-commitment** (Ariely & Wertenbroch 2002).
- **"Right after, I will…"** plans, which roughly double follow-through (Gollwitzer & Sheeran 2006).
- **Premack principle**: games come after the hard things.

Daily cap, cooldown between sessions, and **overrides only on the PC prompt**: a 60 s wait plus a written
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

**Activity.** Steps are de-duplicated when both the phone and the watch count them. The goal defaults to
7,000/day, where health benefits level off (Paluch et al. 2022). You can set a rest-day step goal as part of the gate.

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
