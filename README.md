# JellyLean

A small, vibe-coded Jellyfin client for Samsung Tizen TVs. It exists because the
official `jellyfin-tizen` build is a full jellyfin-web bundle: heavy on a 2017 TV,
and awkward to keep in sync with a server. This one is ~3.5k lines, no framework, no
build step, and it talks to the Jellyfin REST and WebSocket APIs directly.

Built for a **UE43M5602 (2017 M5 series, Tizen 3.0, 1080p)**, but it should run on
any Tizen TV from 2015 onwards.

## Screenshots

![Home: Continue Watching hero, rows per library](docs/screenshots/01-home.webp)

| Movies | Details |
| --- | --- |
| ![Library grid with real posters](docs/screenshots/02-movies.webp) | ![Movie detail with backdrop, logo and cast](docs/screenshots/03-detail.webp) |

## Download

Grab the signed `JellyLean.wgt` from the [latest release](../../releases/latest) and
sideload it with `scripts/install.sh --ip <tv>` — see
[Build and install](#build-and-install). Builds are signed for Tizen 3.0+, so they
install on any 2015-or-newer Samsung TV with developer mode enabled.

## Features

- Server address and login are entered on the TV and stored locally; nothing is
  hardcoded.
- Password sign-in and Quick Connect.
- Home screen with a **Continue Watching** hero, **Libraries**, and a latest row
  per library.
- Library browsing, item details, seasons and episodes.
- Playback through Samsung **AVPlay** (hardware decode, HLS) with an HTML5 `<video>`
  fallback so the app runs in a desktop browser for development.
- **Automatic transcode fallback**: if a direct-play stream errors or decodes no
  frames, playback reopens once through the server's HLS transcoder instead of
  sitting on a black screen.
- **Per-title subtitle picker**: choose Off or any track from the playback OSD.
  The choice is remembered per movie and per series (so every episode follows the
  show), and the picker marks the active track with a check. Text tracks are
  fetched as WebVTT and drawn by the client, so an embedded `subrip` track does not
  force a full video transcode. Image tracks (PGS/VOBSUB) restart the item on a
  transcode with that track burned into the picture.
- **Transcode quality setting**: caps the bitrate requested for a transcoded
  stream at 8, 12 or 20 Mbps (default 20). The server keeps returning 1920x1080
  at all three; lower it only if playback stutters over Wi-Fi.
- **Skip Intro / Skip Credits / Skip Recap** from Jellyfin 10.10 Media Segments, with
  a fallback to the older Intro Skipper plugin endpoint. The button appears when
  the segment starts; auto-skip can be enabled in Settings.
- **SyncPlay**: create or join a group, clock-offset estimation, group load/stop,
  play/pause/seek routing, buffering/ready reports and drift correction.
- Resume positions, progress reporting and played state.
- Remote-first UI: four-way spatial navigation, BACK handling, media keys.
- **On-screen control row** above the progress bar (rewind / play-pause / forward /
  subtitles / info) reachable with ↑ and ←/→; the play button reflects the current
  state and the captions button lights while a track is active.
- **Playback info panel** (info control or the remote's INFO key) showing the
  negotiation result: direct play vs transcode, engine, container, source video,
  transcode output and cap, audio and active subtitle.
- Inline SVG icon set anywhere a glyph helps: top bar, OSD badges and controls,
  settings rows and action buttons. No icon font or network request.

## Design

The full system lives in [`DESIGN.md`](DESIGN.md) (tokens, type scale, components,
focus, motion, compatibility rules) and [`PRODUCT.md`](PRODUCT.md). In short: deep-water
ink surfaces, artwork as the light source, one aqua accent, and one white focus
language. `node scripts/check-design.js` fails if the stylesheet uses a colour that
DESIGN.md does not define.

- **10-foot scale.** Nothing below 24 px; sentences 28 px and up; posters 250x375,
  landscape cards 392x220. Safe area is 96x54 px (5% of 1080p).
- **Navigation.** A tab bar (Home, libraries, Search, Discover) plus SyncPlay and
  Settings icons. UP from the first shelf enters the tabs at the current one; DOWN
  returns to the last focused item. BACK restores the previous screen's focused item.
- **Home stage.** The backdrop, title and overview follow the focused card; shelves
  slide under a fixed line so the focused shelf never moves vertically.
- **One focus language.** White: posters get a ring and scale, buttons/tabs/rows fill
  white with dark text. Scrolling is a `transform`, never `scrollTop`.
- **No CSS the TV cannot run.** Flexbox only; no grid, custom properties, `gap`,
  `inset`, `aspect-ratio`, blur or `backdrop-filter`; motion is `transform`/`opacity`
  only. Fonts (Figtree, Bricolage Grotesque, OFL) are bundled in `fonts/`.
- **Accessibility.** Headings per screen, `aria-label` on cards/rows, live regions,
  and a `prefers-reduced-motion` variant.

## Requirements

**TV**

- Tizen 2.3 or newer (the app is targeted at the `tv` profile, Tizen 3.0).
- Developer mode enabled, see below.
- Network access to your Jellyfin server.

**Server**

- Jellyfin 10.9 or newer, **verified against 12.4.0**. SyncPlay needs 10.8+;
  Media Segments (the clean Skip Intro path) need 10.10+. The client detects
  nothing by version — it sends the request formats both generations understand,
  see [Server compatibility](#server-compatibility).
- For Skip Intro on 10.8/10.9, install the
  [Intro Skipper](https://github.com/jellyfin/jellyfin-plugin-intros) plugin; the
  client falls back to `/Episode/{id}/IntroSkipperSegments`.
- A direct network path from the TV: `http://192.168.x.x:8096`, or HTTPS with a
  certificate the TV trusts. Self-signed certificates are usually rejected.

**Build machine**

- Tizen Studio CLI for a signed, installable package (`web-cli_Tizen_Studio_6.1`).
  No keyring daemon is required; `scripts/setup-signing.sh` handles that.
- `zip` for the unsigned development package.
- `node` (18+) if you want the mock server and browser test.
- `ffmpeg` (optional) so the mock server can generate a sample video.

## Build and install

### 1. Enable developer mode on the TV

1. Open **Apps**, highlight **App Store** (or any app tile), and press `12345` on
   the remote.
2. Turn **Developer mode** on.
3. Enter the **IP address of the computer** that will install the app.
4. Reboot the TV.

The TV now listens for `sdb` on TCP 26101.

### 2. Signing

A retail TV only installs widgets signed with a trusted certificate.

**Headless (what this project uses).** Put an author and a distributor PKCS#12 in
`~/.tizen-certs` (`author.p12`, `distributor.p12`, optional `ca/`), then:

```bash
scripts/setup-signing.sh          # creates the signing profile
```

`CERT_DIR=... CERT_PASSWORD=... PROFILE=... scripts/setup-signing.sh` overrides the
paths. Budget signing with the Tizen-issued pair that Apps2Samsung ships works on
retail TVs in developer mode:

```bash
CERT_DIR=~/.local/share/apps2samsung-bin/Assets/Certificate/Jellyfin \
  scripts/setup-signing.sh
```

Tizen CLI 6.x reads certificate passwords over the D-Bus **Secret Service**. On a
machine with no keyring daemon (headless, minimal KDE, container, WSL) every
build dies with `CertificationException: Invaild password`, because the lookup
cannot reach a provider at all. `setup-signing.sh` therefore installs
`scripts/tizen-secret-shim.sh` as the SDK's `secret-tool`, which stores the same
lookup/store contract in `~/.tizen-certs/passwords` (0600). The original binary is
kept as `secret-tool.real`. To undo:

```bash
cp -a ~/tizen-studio/tools/certificate-encryptor/secret-tool.real \
      ~/tizen-studio/tools/certificate-encryptor/secret-tool
```

**GUI alternative.** Tizen Studio → **Tools → Certificate Manager → Samsung →
Author certificate**, sign in with a Samsung account, create a profile, note its
name, and build with `TIZEN_PROFILE=<name>`.

> The unsigned `.wgt` produced without a profile is fine for the browser and for
> inspecting the package, but a TV rejects it with `Invalid certificate chain`.
> The widely used distributor certificate expires in 2022; TVs in developer mode
> accept it, but if yours does not, sign with a Samsung-issued one.

### 3. Build

```bash
# Signed, installable on the TV (uses the active profile)
scripts/build.sh

# Pick a profile explicitly
TIZEN_PROFILE=MyTVProfile scripts/build.sh

# Unsigned, for inspection / hosting only
scripts/build.sh --unsigned
```

The result is `dist/JellyLean.wgt`, plus `dist/JellyLean.zip` for unsigned
builds. The Tizen CLI is found in `PATH` or in `~/tizen-studio` automatically, and
the script reports whether the widget actually contains signatures. Without the
CLI it still packages the app with `zip`, so the widget structure can be checked
anywhere.

### 4. Install

```bash
# Find TVs on the local network (TCP 26101)
scripts/install.sh --scan

# Connect and install
scripts/install.sh --ip 192.168.1.50

# ...and launch it
scripts/install.sh --ip 192.168.1.50 --run
```

The script wraps `sdb connect`, `tizen install-permit` (when supported) and
`tizen install`. If the TV asks whether to allow the connection, accept it.

Manual equivalent:

```bash
sdb connect 192.168.1.50:26101
tizen install -n dist/JellyLean.wgt -s 192.168.1.50:26101
tizen run -p jflean0001.JellyfinLean -s 192.168.1.50:26101
```

The Tizen ids (`jflean0001.JellyfinLean`, package `jflean0001`) predate the
JellyLean name and are kept so an existing install updates in place instead of
appearing as a second app on the TV.

To remove the app:

```bash
tizen uninstall -p jflean0001
```

## First run

1. Start the app. The setup screen asks for the server address, e.g.
   `192.168.1.20:8096` or `https://jellyfin.example.com`.
2. Sign in with a username and password, or use **Quick Connect**.
3. The server URL, access token and user id are stored in the TV's `localStorage`.
   **Settings → Sign out** removes the token.

The app generates a stable per-install device id, which Jellyfin uses to keep
sessions and SyncPlay participants apart.

## Development

### Mock server

The dev server serves the app and a small mock Jellyfin API from one origin:

```bash
node scripts/dev-server.js
# open http://localhost:8096
```

On the setup screen enter `localhost:8096` and any username/password. The mock
provides two libraries, a movie, a series with one season and episode, working
images, intro segments (0:02–0:06), playback info, a default/forced subtitle served
as WebVTT and a generated 20-second test video. It also accepts SyncPlay group creation/leave and echoes a queue over the
WebSocket, so the group UI can be exercised without a real server.

Use `PORT=8097 node scripts/dev-server.js` to change the port. To reset the
client, run `localStorage.clear()` in DevTools and reload.

### Browser smoke test

```bash
node test/smoke.js
```

The test starts the dev server and headless Chromium, drives the real UI over the
Chrome DevTools Protocol, and fails on any console error. It covers setup and
remote-key navigation (including leaving a text field without the TV keyboard),
login, home, SyncPlay create/leave, library/detail navigation, playback, the
subtitle overlay and seek sync, Skip Intro and the SyncPlay `load` handoff. Use
`SHOTS=1 node test/smoke.js` to also write screenshots to `.dev/screenshots`.
Set `CHROME=/path/to/chromium` if the browser is not in a standard location.

### Live server test

The mock enforces the same rules as a current server, but the real check runs the
actual client against your Jellyfin:

```bash
JF_URL=http://192.168.1.20:8096 JF_USER=me JF_PASS=secret node test/live.js
```

It starts the dev server with `NO_MOCK=1` (static files only), signs in through the
real setup screen, and asserts that home rows render, libraries are listed, poster
images decode, media segments return an intro/outro, playback negotiation yields a
stream URL that authorizes, a subtitled movie's default track comes back as
WebVTT with parsed cues, and the SyncPlay screen reaches a WebSocket. Read-only:
it never starts playback and never changes watch state.

`NO_MOCK=1 node scripts/dev-server.js` serves only the app, which is how you can
drive the real client against a real server by hand.

## Remote controls

| Key | Outside playback | During playback |
| --- | --- | --- |
| Arrows | Move focus | Seek ±10s (←/→), focus Skip/controls (↑), leave focus (↓) |
| ←/→ while a control is focused | — | Move between rewind / play / forward / info |
| OK | Activate focused item | Play/pause, or activate the focused control |
| INFO | — | Toggle the playback info panel |
| BACK | Previous screen | Close the info panel if open, otherwise stop and go back |
| EXIT | Exit the app | Stop and exit |
| Play/Pause | — | Toggle playback |
| Stop | — | Stop and go back |
| FF / Rewind | — | Seek ±30s |

SyncPlay changes the meaning of pause and seek: the command is sent to the server
and applied when it comes back, so everybody stays together.

## How it works

```
config.xml            Tizen widget manifest (package jflean0001)
index.html            static shell: #app for screens, #stage + #osd for video
css/app.css           TV stylesheet; flexbox only (no grid/gap/custom properties)
js/util.js            DOM, formatting, emitter, spatial focus navigation
js/store.js           localStorage config, device id, auth, preferences
js/api.js             Jellyfin REST client, device profile, WebSocket
js/player.js          AVPlay + HTML5 playback engine, stall watchdog
js/subtitles.js       WebVTT parsing and the cue overlay
js/skipintro.js       Media Segments / Intro Skipper parsing
js/syncplay.js        SyncPlay group, queue, time sync, commands, drift
js/ui.js              cards, rows, top bar, screen shell
js/app.js             boot, router, remote keys, playback pipeline
js/screens/*.js       setup, home, library, detail, player, settings, syncplay
scripts/              build, install, signing setup, dev server
test/smoke.js         zero-dependency browser test
test/live.js          read-only test against a real server
```

### Playback pipeline

1. `App.playItem` posts to `/Items/{id}/PlaybackInfo` with a device profile that
   describes what the TV can decode.
2. The source with `SupportsDirectPlay` wins → `/Videos/{id}/stream?static=true`.
   Otherwise `DirectStreamUrl`, otherwise `TranscodingUrl` (HLS). Direct play is
   negotiated at 20 Mbps so a high-bitrate 1080p remux is not re-encoded; a
   source the server must transcode uses **Settings → Transcode quality**
   (8, 12 or 20 Mbps; default 20), because Jellyfin picks the target resolution
   from that number. A 4K source at the wrong cap produces a resolution this
   panel refuses — audio plays and the picture stays black. With this profile the
   server returns `1920x1080` High profile level 4.1 at every cap up to 20 Mbps,
   confirmed by probing the encoded segments with ffprobe, not just the playlist.
3. `Player.open` uses AVPlay on a TV and a `<video>` element in a browser. This
   depends on `index.html` loading `$WEBAPIS/webapis/webapis.js`: without it
   `window.webapis` is undefined, AVPlay is skipped, and an MKV with AC3 audio
   renders as a black screen because `<video>` cannot decode it.
   AVPlay also draws on a **native plane underneath the webview**, so while it
   owns the screen `showStage` adds `playing` to `<html>` (clear `html` and
   `body` backgrounds — a background on `html` propagates to the whole canvas)
   and hides `#html5Video`, otherwise its opaque rectangle covers the picture
   and only audio and DOM subtitles come through.
4. The device profile only claims what a 2017 Samsung decodes: H.264/MPEG-4
   video, AAC/MP3/AC3/E-AC3 audio, with H.264 capped at level 4.1, 1080p and
   8-bit. HEVC is deliberately **not** claimed: a UHD remux direct-played here
   gives audio with a black picture, and a 1080p panel gains nothing from it, so
   the server transcodes it to H.264 instead. Claiming more makes the server hand
   over a stream the TV then fails to show.
5. A direct-play stream that errors, or reports no playback time for 12 seconds,
   is reopened once through the HLS transcoder. A second failure is reported on
   screen rather than leaving a black picture.
6. The **subtitle picker** resolves the saved choice for the movie or series,
   falling back to Jellyfin's default/forced track on a first watch. Text tracks
   are fetched from
   `/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt` and drawn over the
   video, for every play method. This matters because Jellyfin otherwise treats
   an embedded `subrip` track as something the client cannot show and burns it
   in, turning every direct-play item with subtitles into a transcode. For the
   same reason `SubtitleStreamIndex`/`SubtitleMethod` are stripped from transcode
   URLs (`Api.stripSubtitleParams`, as jellyfin-web does when it is not encoding
   a subtitle) unless the viewer picked an image track. Image tracks cannot be
   drawn as text, so the picker reopens the item with that track burned in; the
   burn-in request names `MediaSourceId` and `SubtitleStreamIndex`, because the
   server ignores the index without the source id.
7. Progress is reported to `/Sessions/Playing`, `/Sessions/Playing/Progress`
   every 10s, and `/Sessions/Playing/Stopped` on exit. Played state is set when
   an item finishes.

### SyncPlay

The client follows the protocol used by jellyfin-web:

- `GET /GetUtcTime` estimates the server clock offset NTP-style; `/SyncPlay/Ping`
  reports the measured delay.
- The WebSocket at `ws(s)://host/socket?api_key=…&ApiKey=…&deviceId=…` carries
  `SyncPlayCommand` and `SyncPlayGroupUpdate` messages; `ForceKeepAlive` is
  answered with `KeepAlive`. Both parameter spellings are sent because 12.x
  rejects `api_key` with 403 while older servers only know that spelling.
- Commands carry a server timestamp, converted to local time and scheduled. Seek
  drift over 400ms causes a resync; 60–400ms is corrected with a temporary speed
  adjustment.
- Starting an item while in a group sends `SetNewQueue`, so every participant
  follows the same queue. The initiator ignores its own echoed queue event.

### Skip Intro

`GET /MediaSegments/{itemId}?includeSegmentTypes=Intro&includeSegmentTypes=Outro&…`
is parsed into ordered segments. The types are sent as repeated parameters, not a
comma-joined string: 12.x validates each value against the enum and answers 400
for `Intro,Outro`, and the client then retries without the filter. The client shows the button slightly before the
segment and hides it one second before the end. Auto-skip is disabled while in a
SyncPlay group (a local skip would desynchronise everybody); skipping there is a
group seek.

### Server compatibility

The client targets both the 10.x API and 12.x, without branching on the reported
version. Three differences matter, all handled in `js/api.js`:

| Area | 10.x | 12.x | What the client sends |
| --- | --- | --- | --- |
| Auth header | `X-Emby-Authorization` + `X-Emby-Token` | only `Authorization: MediaBrowser …, Token="…"` | the `Authorization` form plus both legacy headers |
| Array queries | comma-joined accepted | each value validated → 400 | repeated keys (`?x=A&x=B`) |
| WebSocket | `?api_key=` | `?ApiKey=` (`api_key` → 403) | both |

Images and video streams also accept `api_key=<token>` in the query string, which
is how the TV loads posters and media without custom headers.

## Limitations

- No audio-track picker yet. The server's default audio track is used.
- Image subtitles (PGS/VOBSUB) are supported through a server burn-in, which
  requires a transcode and briefly restarts playback at the current position.
- No search, playlists, collections, or music-specific UI.
- No Live TV / DVR.
- No automatic next-episode autoplay (the server's SyncPlay queue does advance).
- AVPlay handles what the TV can decode. HEVC and DTS are never claimed, so a
  4K HEVC remux always transcodes; the client also retries a failed direct-play
  stream through the transcoder, and **Settings → Force transcoding** skips the
  direct attempt entirely.
- HTTPS requires a certificate the TV trusts; a self-signed certificate will fail.
- The token is stored unencrypted in the TV's web storage, like other Tizen web
  apps. Sign out before handing the TV over.

## Troubleshooting

**`tizen package` fails with `CertificationException: Invaild password`** — the CLI
cannot reach a Secret Service to read the certificate password. Run
`scripts/setup-signing.sh`, which installs a file-backed password shim, then rebuild.

**Every API call returns 401** — a proxy or an older client build is sending only
`X-Emby-Token`. 12.x requires `Authorization: MediaBrowser Client="…", Token="…"`.
The current `js/api.js` sends both; rebuild the widget after pulling.

**"Invalid certificate chain" on install** — the widget is unsigned or signed with
the wrong profile. Rebuild with `TIZEN_PROFILE=<profile>` using a Samsung author
certificate, then reinstall.

**`scripts/install.sh --scan` finds nothing** — developer mode is off, the host IP
was not entered on the TV, or the TV is on another subnet/VLAN. Reboot the TV after
changing developer mode.

**Black screen or no audio** — playback now retries through the transcoder on its
own; if it still fails, the reason is shown as a toast. Enable **Settings → Force
transcoding** to skip direct play entirely. If every item is black, check that the
built `index.html` contains the `$WEBAPIS/webapis/webapis.js` include, otherwise
the TV never uses AVPlay.

**You hear audio and see subtitles, but the picture is black** — three causes,
in order of likelihood:

1. The server sent a stream the TV cannot decode. A 4K HEVC remux transcoded at
   a high bitrate becomes `2560x1440` H.264, which a 1080p panel refuses while
   still playing audio. Check **Settings → Last playback** for the resolution
   and check the cap in **Settings → Transcode quality** (8/12/20 Mbps).
2. The device profile claimed HEVC/10-bit, so the server direct-played a UHD
   remux instead of transcoding it.
3. AVPlay renders below the webview, so an opaque background (or the fallback
   `<video>` element) hides it. The player handles this via `html.playing`; if
   the change is reverted, check that no full-screen element keeps a background
   colour during playback.

**Subtitles take a few seconds to appear the first time** — the server extracts an
embedded track before it can serve the WebVTT file; later requests are cached.

**Skip Intro never appears** — check that the server is 10.10+ (Media Segments) or
that the Intro Skipper plugin has analysed the episode. Movies also work when the
server provides segments for them.

**SyncPlay drifts** — the TV and server clocks must be roughly right; the client
measures the offset but cannot fix a server whose clock jumps. Check that
`/GetUtcTime` is reachable (some reverse proxies block it).

**The app is not in the TV's app list** — reboot the TV once after installing, or
launch it with `tizen run -p jflean0001`.

## License

MIT — see [LICENSE](LICENSE). Bundled fonts (Figtree, Bricolage Grotesque) are
licensed under the SIL Open Font License 1.1; their license texts are in
[`fonts/`](fonts/).
