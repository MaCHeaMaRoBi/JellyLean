Per-machine agent tooling is kept out of this repo; read `AGENTS.local.md` if it
exists (gitignored).

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
  - `node test/profile.js` → device profile (codecs, channels, HEVC, resolution caps), audio-track logic and the bitrate-scaled stall limit; run it after touching `deviceProfile` in `js/api.js`, `js/audio.js` or `U.stallLimitMs`
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

## Tizen text fields & suspend (confirmed on the TV)

- A focused `readonly` input does not raise the IME, so a field can stay navigable until OK. `UI.textField` relies on that: keep the `readonly` flip and the 60 ms re-focus after it.
- The IME's Done key can close the keyboard without delivering Enter, and BACK is sometimes consumed by the IME. Either way the field stays in edit mode until the next key, so every handler resets `readonly` on the way out.
- HOME hides the app without pausing AVPlay; `bindLifecycle` pauses on `visibilitychange` so the position reaches the server.

## SyncPlay expectations

- The client authenticates the SyncPlay WebSocket using both `api_key` and `ApiKey` query spellings (12.x vs older servers).
- Pause/Unpause must **not** answer the server with Ready or Buffering: doing so re-triggers the command and pauses the whole group in a loop. Only a Seek is acknowledged, with exactly one Ready.
- If drift handling is modified, keep the existing “schedule commands with server timestamps + resync on large drift” behavior. Only seek on a sustained real desync; noisy position readings must not cause seeks.
- Run `node test/syncplay.js` after touching this; the smoke/live tests only assert SyncPlay socket reachability.

## Release checklist

1. Bump `version` in `config.xml` and `CLIENT_VERSION` in `js/api.js` together (the build guards version drift).
2. `scripts/build.sh`.
3. Verify `dist/JellyLean.wgt`: version, app/package ids, `required_version="2.3"`, both author and distributor signatures, sha256.
4. Commit, `git fetch`/rebase, push `main`, tag `vX.Y.Z`, push the tag.
5. Create the GitHub release **as a draft**, attach the asset named exactly
   `JellyLean.wgt` (Apps2Samsung catalog sync matches that name), download it back
   and compare its sha256 with the local build, put that sha256 in the release
   notes.
6. Enable immutable releases, confirm `{"enabled":true}`, then publish.
   `gh api -X PUT repos/{owner}/{repo}/immutable-releases -F enabled=true` returns
   422 ("enabled" is not a permitted key); the call that works is the same PUT
   with no body.

Releases are immutable once published: the asset and the tag can no longer be
replaced or deleted. A mistake caught in the draft is fixable; the same mistake
after publishing costs a new patch release — never re-tag or re-upload.
