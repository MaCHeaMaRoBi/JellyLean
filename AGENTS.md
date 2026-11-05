## graphify (OpenCode)

When the user types `/graphify`, use the installed graphify skill or instructions **before** first grep/search/source-file reads.

Rules:
- If `graphify-out/graph.json` exists, run `graphify query "<question>"` before your first codebase question exploration, and include this rule in every subagent prompt.
- Read raw files only for lines the graph (or an earlier read) already located.
- Prefer `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused context.
- Dirty `graphify-out/` outputs are expected after hooks; don’t skip graphify unless the task is about stale/incorrect graph output, or the user says not to.
- Use `graphify-out/wiki/index.md` for broad navigation (not raw browsing).
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review when query/path/explain isn’t enough.
- After modifying code, run `graphify update .`.

## Tizen / widget build & install (avoid guessing)

- Build:
  - `scripts/build.sh` → signed widget to `dist/JellyLean.wgt` (uses active Tizen signing profile)
  - `scripts/build.sh --unsigned` → unsigned zip/wgt for browser/dev server inspection
  - `TIZEN_PROFILE=MyTVProfile scripts/build.sh` → pick profile explicitly
- Signing gotcha (headless machines): run `scripts/setup-signing.sh` first.
  - It installs `scripts/tizen-secret-shim.sh` because Tizen CLI 6.x otherwise fails with `CertificationException: Invaild password` when no keyring/Secret Service provider is reachable.
- Install:
  - `scripts/install.sh --scan` → find TVs exposing SDB on TCP 26101
  - `scripts/install.sh --ip 192.168.1.50` → install `dist/JellyLean.wgt`
  - `scripts/install.sh --ip 192.168.1.50 --run` → also launch the app
- TV app id/package ids are fixed for update-in-place:
  - app id: `jflean0001.JellyfinLean`
  - package id: `jflean0001`

## Browser verification & smoke tests (use the repo’s harness)

- Dev server (app + tiny mock Jellyfin API on one origin):
  - `node scripts/dev-server.js` (default `http://localhost:8096`)
  - Change port: `PORT=8097 node scripts/dev-server.js`
  - Reset client state: `localStorage.clear()` in DevTools
- Browser smoke test (drives the real UI with headless Chromium; fails on console errors):
  - `node test/smoke.js`
  - Screenshots: `SHOTS=1 node test/smoke.js`
  - Browser path: `CHROME=/path/to/chromium node test/smoke.js`
- Live check against a real Jellyfin server (read-only; validates login, images, media segments, playback negotiation, SyncPlay socket):
  - `JF_URL=http://192.168.1.20:8096 JF_USER=me JF_PASS=secret node test/live.js`

## Playback / subtitle constraints that affect code changes

- Direct-play subtitles: the client draws text tracks itself from WebVTT fetched from `/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt`.
  - If you change subtitle pipeline code, preserve “draw text overlay” (don’t rely on server burn-in).
- Image subtitles (PGS/VOBSUB): cannot be drawn as WebVTT; choosing an image track must restart playback with a burn-in transcode.
- Playback engine selection is critical on the TV:
  - `AVPlay` depends on `$WEBAPIS/webapis/webapis.js` being present (Tizen resolves it on the device; the dev server stubs it).
  - If `$WEBAPIS/webapis/webapis.js` include is broken, AVPlay may be skipped and MKV decoding can appear as black screen.

## SyncPlay expectations

- The client authenticates the SyncPlay WebSocket using both `api_key` and `ApiKey` query spellings (12.x vs older servers).
- If drift handling is modified, keep the existing “schedule commands with server timestamps + resync on large drift” behavior; the smoke/live tests assert SyncPlay socket reachability.
