# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). If that is
unavailable, contact the maintainer through the email on their GitHub profile.

Include what you found, how to reproduce it, and the affected version
(Settings → Server & Device shows the client version). You can expect an
acknowledgement within about a week. This is a hobby project maintained in spare
time, so fixes are best-effort, but credible reports are taken seriously and you
will be credited in the release notes if you wish.

## Supported versions

Only the latest release is supported.

## Security model and known limits

JellyLean is a client for a Jellyfin server you already trust. Things to know:

- **Plain HTTP is allowed.** An address typed without a scheme defaults to
  `http://`. On plain HTTP your password and access token cross the network
  unencrypted. Use HTTPS (with a certificate the TV trusts) or keep the server on
  a network you control.
- **The access token is stored unencrypted** in the TV's `localStorage`, like other
  Tizen web apps. **Settings → Sign out** removes it from the TV.
- **The token appears in some URLs.** Image, stream, subtitle and WebSocket
  requests carry it as `api_key=` because the TV's media engine cannot attach
  headers. Server and proxy logs may therefore record it. Avoid sharing logs.
- **Trust in the server.** Item metadata, subtitles and playlists come from your
  server and are rendered as plain text, never as HTML. A malicious server could
  still return stream URLs of its choosing.
- **SyncPlay**: any member of a group you join can queue playback on your TV.
  Join only groups you trust.
- **Seerr requests** (Discover tab) are sent with your Jellyfin identity and
  enforced by the server-side Litefin plugin, not by this client.

## Development tooling

`scripts/dev-server.js` is a **local mock server for development only**. Do not
expose it to an untrusted network and do not point it at real credentials.
Keep local secrets (`credentials.env`, signing certificates, `*.p12`) out of the
repository; the `.gitignore` already excludes them.

## Signing certificates

Never commit author or distributor certificates, `.p12` files, or their
passwords. Release `.wgt` packages are built and signed by the maintainer and
attached to GitHub releases, not committed.
