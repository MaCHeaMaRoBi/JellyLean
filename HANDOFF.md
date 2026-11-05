# JellyLean — Handoff

_Last updated: 2026-11-03_

## Where things stand

JellyLean is a hand-written Jellyfin client for a Samsung UE43M5602
(Tizen 3.0, 1080p). The original client is **verified working on the TV**:
login, libraries, detail page, AVPlay/HTML5 playback, Skip Intro, SyncPlay,
subtitle picker, per-movie/per-series subtitle memory, Settings.

The second round of work is **written and verified locally** (114 smoke
checks, no console errors, screenshots reviewed):

- Phase A — foundations: global 401 handling, 4 Mbps "Data saver", per-library
  sort + direction, Home "Next Up" row, infinite scroll in libraries.
- Phase B — Seerr discovery through the Litefin plugin: Discover page,
  title detail, per-season requests, Where to Watch, watchlist.
- Phase C — unified search (Jellyfin library + Seerr).
- Phase D — audio track picker, Up Next overlay, watched/favourite actions.

The app icon and launch banner were also replaced. The signed
`dist/JellyLean.wgt` is built, and the work is pushed as `b1a3e26`.
Still required: a TV install/run-through.

## Current focus

Local verification is done. The remaining work is device-side:

1. `./scripts/install.sh --ip 192.168.0.109 --run` (the TV was unreachable on
   the last attempt).
2. Verify on the TV: Discover, movie/TV requests (ask before sending real
   requests), Where to Watch region, search, audio picker, Up Next countdown,
   and that the new icon/banner appear.

`scripts/dev-server.js` now mocks `/Litefin/Seerr/*` (Status, Discover,
Search, details with `watchProviders`/`seasons`, Requests, Watchlist) and has
two audio tracks plus an `ep2` for the Up Next test.
`test/smoke.js` drives all of it, including sort persistence, 401 expiry,
region filtering, requests, watchlist, search and audio switching.

## Files that changed

| File | What it holds |
| --- | --- |
| `js/seerr.js` | Litefin/Seerr REST client, status cache, TMDB image + region/provider helpers |
| `js/screens/discover.js` | Discover page, Seerr detail page, per-season request rows, Where to Watch |
| `js/screens/search.js` | Library + Seerr search |
| `js/screens/player-screen.js` | Audio picker, Up Next overlay, OSD (6 controls) |
| `js/screens/home.js` | Next Up row, Discover/Search top-bar buttons |
| `js/screens/library.js` | Sort bar, persisted direction, infinite scroll |
| `js/screens/settings.js` | 4 Mbps, watch region, autoplay toggle, plugin status |
| `js/screens/detail.js` | Watched/unwatched + favourite buttons |
| `js/api.js` | 401 hook, `nextUpList`, `markUnplayed`, `setFavorite`, audio index |
| `js/app.js` | 401 registration, audio index through both negotiations |
| `js/ui.js` | `topbarButton`, `addTopbarButton`, `remoteCard` |
| `js/icons.js` | search, compass, plus, bookmark, star, eye, audio |
| `index.html` | new scripts, `#audioPanel`, `#upNextOverlay` |
| `css/app.css` | discover/search/provider/season/up-next styles |
| `scripts/dev-server.js` | Seerr fixtures + routes, two audio tracks, `ep2` for Up Next |
| `test/smoke.js` | 114-check smoke suite covering Phases A–D |
| `icon.png` | 512×512 launcher icon generated from `new-icon.png` |
| `banner.jpg` | 1920×1080 launch-screen banner from `banner.png` |
| `config.xml` | icon plus `tizen:launch_screen` using `banner.jpg` |
| `scripts/build.sh` | stages the banner and reports signing correctly |

## Commands

```bash
node scripts/dev-server.js                 # mock server on :8096
node test/smoke.js                         # headless smoke (needs Chromium)
SHOTS=1 node test/smoke.js                 # + screenshots in .dev/screenshots
./scripts/build.sh                         # signed dist/JellyLean.wgt
./scripts/install.sh --ip 192.168.0.109 --run
```

## Next steps

Done locally: smoke suite (114 checks), screenshot review, signed build,
commit and push. Only the device pass remains:

1. Turn the TV on and run `./scripts/install.sh --ip 192.168.0.109 --run`.
2. Verify Discover, movie/TV requests (ask first), Where to Watch region,
   search, audio picker, Up Next countdown, and the new icon/banner.

## Gotchas

- **Internal Tizen ids stay old on purpose**: app id `jflean0001.JellyfinLean`,
  package `jflean0001`, signing profile `JellyfinLean`, widget
  `http://localhost/JellyfinLean`, storage key `jellyfinLean.config.v1`.
  Renaming them would make the TV lose its install/login.
- ES5 only, flexbox only: no CSS grid/vars/gap/inset/aspect-ratio.
- AVPlay draws **behind** the page: `#stage` and `<html>` must stay transparent
  during playback; no opaque overlay on the video plane.
- The TV never emits AVPlay `PLAYING`; the player infers state from position.
- Transcodes need `Api.warmTranscode` and a 40 s watchdog; 12 s kills a cold
  1080p remux before the first frame.
- Seerr is reached only through `/Litefin/Seerr/*` with the Jellyfin token.
  No Seerr URL/API key is stored on the TV.
- `.agents/` and `skills-lock.json` are third-party and intentionally ignored.
- TV debug access: ports 8001/8002/8080/26101; install/launch work, but no
  `sdb shell` / `dlog`. Server `http://192.168.0.140:8096`, TV
  `192.168.0.109`.
- Do not send real Seerr requests without asking.
