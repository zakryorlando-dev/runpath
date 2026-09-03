# RunPath

A run-tracking web app Zak built for himself and a handful of testers. It records
a run with the phone's GPS, cleans up the track, snaps it to real streets, and
shows it on a map — the Strava/Nike Run Club idea, cut down to what one person
actually uses.

**Live:** https://zakryorlando-dev.github.io/runpath/
**Repo:** https://github.com/zakryorlando-dev/runpath (GitHub Pages off `main`)
**Deploy:** commit and push to `main`. There is no build step.

## Stack

Plain HTML, CSS and JavaScript. No framework, no bundler, no package.json — the
files that are in the repo are the files that run.

| File | What's in it |
|---|---|
| `index.html` | Every screen, as `<section class="screen">`. One page, no router. |
| `app.js` | ~3,200 lines. All behaviour: GPS, smoothing, map matching, route planning, the training plan, the splash. |
| `style.css` | All styling. Design tokens live in `:root`. |
| `sync.js` | Firebase (auth + Firestore), loaded as an ES module from gstatic. Exposes `window.RunPathSync`. |
| `sw.js` | Service worker. Network-first with `cache: "no-store"`. |
| `plan.json` | A 20-week training plan, adopted once for an existing user. |
| `icon-*.png` | Home-screen icons, generated from the logo geometry (see below). |

**Services:** OpenStreetMap tiles (no key), the Overpass API for street geometry,
Firebase project `runpath-aeda1` for accounts and cross-device sync, and Strava
for nearby segments — which is **not usable yet**, because it needs Zak to create
a Strava API app and enter his own client ID and secret in Settings.

## Conventions that matter

- **Deploying a change means bumping two things**: `BUILD` in `app.js` (currently
  `"19:18"`) and `CACHE` in `sw.js` (currently `runpath-v29`). Skip the cache bump
  and the phone keeps the old files.
- `BUILD` is printed in the splash's bottom-left corner. It exists so a screen
  recording proves which code the phone is actually running — that has mattered
  repeatedly. It should come out once the splash work is finished.
- **Patch with a Python script written via the Write tool**, not a bash heredoc:
  heredocs eat backslash escapes and have corrupted this file before. Assert on
  every anchor, and make sure anchors are unique — a patch once landed inside the
  wrong function because the anchor text appeared twice.
- Build DOM nodes with `textContent`, never `innerHTML`, for anything containing
  third-party strings. A Strava segment name was a working XSS here once.
- Comments explain *why*, in prose. Match that; don't add narration.

## Verifying

There's a `.claude/launch.json` — `preview_start` with name `runpath` serves the
folder on a local port. Drive it with the browser tools and read computed styles
or animation state rather than eyeballing screenshots; that catches things a
screenshot can't. Zak tests on his iPhone and uploads screen recordings to
`G:\My Drive\RunPath\`; `ffmpeg` is at
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe`
(not on PATH). Extracting frames and reading the frame-size map is how most of
the hard bugs got found.

## Two things worth knowing before touching the splash

**Zak's phone has Reduce Motion on.** The stylesheet used to carry a second,
quieter copy of the splash under `@media (prefers-reduced-motion: reduce)`. It
had its own timings, so hours of changes landed on a version he was never
watching — the dots faded instead of dropping and the logo never moved. That
branch is gone; there is one animation now. **Do not reintroduce a second copy of
these timings.** All eleven live in one block at the top of the splash CSS.

**iOS does not reliably tell a home-screen web app that it was backgrounded.**
`visibilitychange`, `pagehide` and `blur` may simply never fire. The app raises
its name panel on all of them *and* on a heartbeat: a 1s timer that arrives
>2.5s late means the page was frozen and is now back. The letters after the build
stamp record which signals the phone actually delivered (`h` hidden, `v` visible,
`p` pagehide, `s` pageshow, `b` blur, `f` focus, `t` heartbeat).

## Where things stand

The splash is essentially done and Zak likes it: a dot drops in, the logo R draws
itself centre-screen, shrinks and slides left, "unpath" fades in beside it, then
the greeting. ~5.1s, skippable with a swipe. Leaving the app raises the finished
panel; swiping returns you to the screen you were on — except during a run, which
is deliberately left alone.

**Open:**
- Confirm the panel now appears on return, and read the build-stamp letters. If
  they show only `t`, iOS sends no exit event and the app-switcher thumbnail
  can't be fixed from inside the page.
- Remove the `BUILD` stamp and its signal letters once the splash is settled.
- `plan.json` has `startMonday: 2026-08-31` and `raceDate: 2027-01-17`. Zak has
  never confirmed those.
- Strava segments need his API app before that tab does anything.
- Offered and not taken up: elevation gain, calibrating GPS drift thresholds
  against a known-distance walk.

## Working with Zak

He's a commercial real estate broker in San Francisco, not a developer. Explain
in plain language and lead with what changed for him, not the mechanism. He
iterates on feel — expect "slower", "bigger", "more curve" — so keep the knobs in
one obvious place and tell him which number moved. He notices when something is
off and is usually right about it; when he reports something that seems
impossible, get the recording and look at the frames before arguing.

Never handle his passwords or API secrets — he enters those in the app himself.
