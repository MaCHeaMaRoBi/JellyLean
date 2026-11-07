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
- **Seerr** (Discover tab): the Seerr address and, if you use one, the API key are
  stored in plain text in the TV app's local storage. They are sent only to that
  Seerr address. An API key acts as the Seerr user it belongs to (normally the
  admin), so requests are attributed to that user. Quick Connect and the Jellyfin
  password attribute them to you instead; Quick Connect approves its code with the
  TV's existing Jellyfin login and stores nothing, and a typed password is sent
  only to Seerr and not stored. Their Seerr login cookie lives in the TV's web view.
  Use a key you can revoke, and prefer a LAN or HTTPS address.

## Development tooling

`scripts/dev-server.js` is a **local mock server for development only**. Do not
expose it to an untrusted network and do not point it at real credentials.
Keep local secrets (`credentials.env`, signing certificates, `*.p12`) out of the
repository; the `.gitignore` already excludes them.

## Signing certificates

Never commit author or distributor certificates, `.p12` files, or their
passwords. Release `.wgt` packages are built and signed by the maintainer and
attached to GitHub releases, not committed.
