# Contributing

JellyLean is a small, opinionated client: plain ES5, no framework, no build
step, no runtime dependencies. Patches that keep it that way are easiest to take.

## Before you start

- **Bugs and ideas** are welcome as issues. Bug reports need the TV model, the
  Tizen version, the JellyLean version (Settings → Server & Device) and the
  Jellyfin server version — without them a playback bug cannot be reproduced.
- **Security problems** do not go in an issue. See [SECURITY.md](SECURITY.md).
- For anything larger than a small fix, open an issue first. This is a hobby
  project maintained in spare time; a merged surprise is not guaranteed.

## Getting it running

```bash
node scripts/dev-server.js        # app + mock Jellyfin API on http://localhost:8096
PORT=8097 node scripts/dev-server.js
```

Sign in with any username and password against the mock. `localStorage.clear()`
resets the client. `NO_MOCK=1 node scripts/dev-server.js` serves the static app
against a real server instead.

Node.js 18+ is enough; nothing is installed.

## Tests

```bash
node test/profile.js       # device profile, audio tracks, stall limit
node test/syncplay.js      # SyncPlay state machine and drift correction
node test/osd.js           # OSD fade (needs jsdom: npm install jsdom)
node scripts/check-design.js
node test/smoke.js         # drives the real UI in headless Chromium
```

`test/live.js` needs a real Jellyfin server and is not run in CI. CI runs the
rest on every push and pull request (`.github/workflows/ci.yml`).

## House rules

- **No build step and no dependencies in the app.** `index.html`, `css/` and
  `js/` ship as they are; ES5 syntax only (the TV's engine is old).
- **Colours come from `DESIGN.md`.** `scripts/check-design.js` fails on literals
  that are not defined there.
- **Remote-first UI.** Four-way navigation, no hover-only states, no pointer
  affordances.
- **Do not bump the version.** `config.xml` and `js/api.js` are bumped together
  for a release, and `scripts/build.sh` refuses to build when they disagree.
- **Never commit** `dist/`, `*.wgt`, signing material, or anything with a server
  address, username or token in it.
