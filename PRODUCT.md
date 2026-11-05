# PRODUCT.md

_Written from the repository's own README/HANDOFF (no interview was possible; see the redesign summary)._

## What it is

JellyLean is a hand-written Jellyfin client for Samsung Tizen TVs (verified on a 2017 UE43M5602, Tizen 3.0, 1080p). It browses a personal Jellyfin library, plays it through Samsung AVPlay, and adds Skip Intro, SyncPlay, subtitle and audio pickers, and Seerr discovery through the Litefin plugin.

## Who uses it

People on a sofa, ~3 m from the screen, in a dim room, holding a TV remote (four arrows, OK, Back, media keys). Household members with different tech comfort; a movie night, a binge, a SyncPlay session with a friend elsewhere.

## Surface mode

Operate, with an Experience core: the artwork is the interface. Browse, decide, press play. Brand lives in motion, type and focus, never in chrome.

## Hard constraints

- 10-foot UI, D-pad + OK + Back only, no pointer assumptions. Safe area 5%.
- Tizen 3.0 web engine (Chromium 47): ES5, flexbox, no CSS variables/grid/gap/`inset`/`aspect-ratio`/variable fonts.
- Weak hardware: animate only `transform` and `opacity`; no blur or `backdrop-filter`; lazy images; bounded DOM.
- AVPlay draws behind the page: the stage stays transparent during playback.
- No changes to Jellyfin API behaviour, app/package ids, or the storage key.

## Anti-references

Generic "Jellyfin purple gradient" skins, component-library tiles, a website header with Back/Home buttons, amber-on-black "cinema" clichés, eyebrow labels above every heading.
