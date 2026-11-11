Thanks for the change. What is in it?

<!-- One or two sentences. Link the issue it closes, if any. -->

## Checks

- [ ] `node test/profile.js`, `node test/syncplay.js`, `node test/osd.js`,
      `node scripts/check-design.js` pass locally (CI runs them too)
- [ ] `node test/smoke.js` passes if screens, focus or layout changed
- [ ] No new colour literals outside `DESIGN.md`
- [ ] No version bump, signing material, `dist/` output or `credentials.env`
- [ ] If playback, subtitles or SyncPlay logic changed, say what was tested on a
      real TV and with which media

## Notes for the reviewer

<!-- Anything that needs a TV to verify, or that you are unsure about. -->
