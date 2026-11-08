## graphify (OpenCode)

When the user types `/graphify`, use the installed graphify skill or instructions **before** first grep/search/source-file reads.

Rules:
- If `graphify-out/graph.json` exists, run `graphify query "<question>"` before your first codebase question exploration, and include this rule in every subagent prompt.
- Read raw files only for lines the graph (or an earlier read) already located.
- Prefer `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused context.
- Dirty `graphify-out/` outputs are expected after hooks; don’t skip graphify unless the task is about stale/incorrect graph output, or the user says not to.
- Use `graphify-out/wiki/index.md` for broad navigation (not raw browsing).
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review when query/path/explain isn’t enough.
- After modifying code or docs, run `graphify update .`.

## ruflo (OpenCode MCP)

Installed globally (`npm i -g ruflo`) and registered in `~/.config/opencode/opencode.json` as a local MCP server:

```json
"ruflo": { "type": "local", "command": ["ruflo", "mcp", "start", "--tools", "memory,swarm,agent,task"] }
```

- Use the `ruflo_*` MCP tools directly (e.g. `memory_store` / `memory_search`) — no shell call needed.
- Its 81 agent definitions are converted to OpenCode subagents in `~/.config/opencode/agent/` (`planner`, `backend-dev`, `security-architect`, `swarm-pr`, …). `opencode debug agents` lists them; check there before adding a new agent.
- Its 22 skills are in `~/.config/opencode/skills/` (`swarm-orchestration`, `agentdb-*`, `github-*`, `pair-programming`, `verification-quality`, …).
- Prompts were remapped: `mcp__claude-flow__x` → `ruflo_x`, `npx claude-flow@v3alpha` → `ruflo`. Commands that never existed (`ruflo github`, `ruflo actions`, `ruflo ddd`, `ruflo integration`) are marked as sketches in the files that use them.
- Vector memory is per project in `.swarm/` (gitignored). Keep project facts in namespace `jellylean`.
- The full server advertises 386 tools (~75k schema tokens). Keep `--tools` curated; add selectors there only when a group is actually needed.
- `ruflo doctor` for health, `ruflo mcp tools` to list what is exposed.

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
- Regression tests that need no server:
  - `node test/syncplay.js` → SyncPlay state machine, pause/resume feedback loop, drift correction
  - `node test/osd.js` → OSD fade behaviour. Needs jsdom; it silently skips when jsdom is absent (`JSDOM_DIR=/tmp/jd node test/osd.js` to point at an install)
  - `node scripts/check-design.js` → every stylesheet colour must be defined in `DESIGN.md`
- Live check against a real Jellyfin server (read-only; validates login, images, media segments, playback negotiation, subtitles, SyncPlay socket):
  - `JF_URL=http://192.168.1.20:8096 JF_USER=me JF_PASS=secret node test/live.js`
  - `NO_MOCK=1 node scripts/dev-server.js` serves only the app, for driving the real client against a real server by hand.

## Playback / subtitle constraints that affect code changes

- Direct-play subtitles: the client draws text tracks itself from WebVTT fetched from `/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt`.
  - If you change subtitle pipeline code, preserve “draw text overlay” (don’t rely on server burn-in).
- Image subtitles (PGS/VOBSUB): cannot be drawn as WebVTT; choosing an image track must restart playback with a burn-in transcode.
- Playback engine selection is critical on the TV:
  - `AVPlay` depends on `$WEBAPIS/webapis/webapis.js` being present (Tizen resolves it on the device; the dev server stubs it).
  - If `$WEBAPIS/webapis/webapis.js` include is broken, AVPlay may be skipped and MKV decoding can appear as black screen.
- Bitrate policy:
  - The default is **uncapped** with the transcode resolution pinned to 1920x1080 (`Api.limitResolution`). Do not reintroduce a default cap.
  - `maxBitrate` (Settings → Maximum bitrate, `0` = no limit) is an opt-in cap and must reach both `PlaybackInfo` and the device profile.
  - The device profile deliberately does not claim HEVC/DTS; a 4K HEVC remux is expected to transcode.

## SyncPlay expectations

- The client authenticates the SyncPlay WebSocket using both `api_key` and `ApiKey` query spellings (12.x vs older servers).
- Pause/Unpause must **not** answer the server with Ready or Buffering: doing so re-triggers the command and pauses the whole group in a loop. Only a Seek is acknowledged, with exactly one Ready.
- If drift handling is modified, keep the existing “schedule commands with server timestamps + resync on large drift” behavior. Only seek on a sustained real desync; noisy position readings must not cause seeks.
- Run `node test/syncplay.js` after touching this; the smoke/live tests only assert SyncPlay socket reachability.

## Release checklist

1. Bump `version` in `config.xml` and `CLIENT_VERSION` in `js/api.js` together (the build guards version drift).
2. `graphify update .`, then `scripts/build.sh`.
3. Verify `dist/JellyLean.wgt`: version, app/package ids, `required_version="2.3"`, both author and distributor signatures, sha256.
4. Commit, `git fetch`/rebase, push `main`, tag `vX.Y.Z`, push the tag.
5. Create the GitHub release and upload the asset **named exactly `JellyLean.wgt`** (Apps2Samsung catalog sync matches that name). Download it back and compare sha256.
