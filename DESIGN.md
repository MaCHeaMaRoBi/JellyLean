---
version: alpha
name: JellyLean
description: >-
  A 10-foot Jellyfin client where the artwork is the light source. Deep-water ink
  surfaces, one luminous accent, a single white focus language (ring + lift), and
  a stage-like Home whose backdrop follows whatever the remote is resting on.
  Built for a 2017 Tizen 3.0 TV: transform/opacity motion only, no blur.

colors:
  ground: "#07090d"          # page background, behind everything
  ground-raised: "#0c1017"   # panels, sheets, OSD plates
  surface: "#121822"         # poster placeholders, idle list rows
  surface-high: "#1a2230"    # idle buttons, chips, inputs
  surface-focus: "#f4f7fa"   # focused control fill (paper white)
  ink: "#f4f7fa"             # primary text
  ink-2: "#b4becb"           # secondary text (>= 10:1 on ground)
  ink-3: "#8c99a9"           # tertiary / hints (>= 6:1 on ground)
  ink-on-light: "#0a0d12"    # text on focused (white) fills and accent fills
  ink-on-light-2: "#3b4859"  # secondary text on focused (white) fills
  ink-1: "#dbe2ea"           # overview text over artwork (between ink and ink-2)
  accent: "#4fe3c8"          # primary action fill, progress, "new" cues
  accent-deep: "#1f7f72"     # accent on quiet surfaces (progress track fill under art)
  line: "rgba(244,247,250,0.10)"
  fill-idle: "rgba(244,247,250,0.12)"   # idle ghost buttons on artwork
  scrim: "rgba(7,9,13,0.92)"
  good: "#7fe0a1"
  warn: "#ffc46b"
  bad: "#ff8b84"

typography:
  display-xl: { family: "JL Display", size: 96px, weight: 800, lineHeight: 1.0, letterSpacing: -0.02em }
  display:    { family: "JL Display", size: 72px, weight: 800, lineHeight: 1.04, letterSpacing: -0.018em }
  title:      { family: "JL Display", size: 56px, weight: 700, lineHeight: 1.1, letterSpacing: -0.012em }
  row-title:  { family: "JL Sans", size: 36px, weight: 700, lineHeight: 1.2 }
  lead:       { family: "JL Sans", size: 32px, weight: 400, lineHeight: 1.45 }
  body:       { family: "JL Sans", size: 28px, weight: 400, lineHeight: 1.45 }
  label:      { family: "JL Sans", size: 28px, weight: 600, lineHeight: 1.25 }
  meta:       { family: "JL Sans", size: 26px, weight: 600, lineHeight: 1.3 }
  badge:      { family: "JL Sans", size: 24px, weight: 700, lineHeight: 1.0 }

spacing: { 1: 8px, 2: 16px, 3: 24px, 4: 32px, 6: 48px, 8: 64px, 12: 96px }
safe-area: { x: 96px, y: 54px }     # 5% of 1920x1080
rounded: { card: 16px, panel: 28px, input: 20px, pill: 999px }
---

# JellyLean design system

## 1. Atmosphere

The room is dark and the screen is the only light, so the interface behaves like
the house lights going down: chrome recedes, artwork glows. Nothing is decorated.
Every surface is a step of the same deep-water ink; colour arrives from posters and
backdrops, plus **one** accent (a luminous aqua, the glow of a jellyfish in dark
water) reserved for the primary action, progress and live state.

Reference basis, per the brief: **Apple TV / tvOS** for the focus model (scale +
lift, paper-white fill on a focused control, shelves that peek at the edge) and
**Spotify** for content-first darkness (achromatic surfaces so art supplies the
colour, pill controls, bold/regular type binary). Netflix-style ambient backdrops
inform the Home stage. Deliberately not borrowed: blur/frosted glass (too costly
for a 2017 SoC), gradients as decoration, coloured side-bars on rows.

## 2. Colour

Dark only. Token names are the vocabulary; the stylesheet uses the literals
because Tizen 3.0 has no CSS custom properties. `scripts/check-design.js` fails the
build when a colour literal appears that is not in the table above.

| Role | Token | Use |
| --- | --- | --- |
| Page | `ground` | `html`, `body`, behind the backdrop layer |
| Plate | `ground-raised` | OSD panels, pickers, Up Next card |
| Quiet fill | `surface` | poster placeholders, idle list rows, inputs at rest |
| Control fill | `surface-high` / `fill-idle` | idle buttons: `fill-idle` (translucent ink) over artwork and on Home, `surface-high` for chips and inputs |
| Focus fill | `surface-focus` | any focused button, tab, row marker |
| Text | `ink`, `ink-2`, `ink-3` | 1 titles/values, 2 sentences/meta, 3 hints only |
| Action | `accent` | Play/Resume, Connect, selected state, progress fill |
| Semantic | `good` `warn` `bad` | request status badges, errors |

Rules: text over artwork always sits on a scrim from `scrim`; secondary text is never
below `ink-3`; accent text on `ground` is allowed, accent *fills* carry `ink-on-light`.

## 3. Typography (10-foot)

Fonts are bundled in the widget: **Bricolage Grotesque** (`JL Display`, 700/800) for
titles, **Figtree** (`JL Sans`, 400/600/700) for everything else, Samsung One as
fallback. Static weights only (Chromium 47 has no variable fonts); a Latin-Extended
file loads on demand for Romanian/Polish/Czech titles.

| Style | px @1080p | Use |
| --- | --- | --- |
| display-xl | 96 | Home stage title when the item has no logo |
| display | 72 | Details title |
| title | 56 | Screen titles (Settings, Library, Search) |
| row-title | 36 | Shelf headings, panel titles |
| lead | 32 | Overview on stage / details |
| body | 28 | **Minimum for any sentence**, list rows, descriptions |
| label | 28/600 | Buttons, tabs, card captions |
| meta | 26/600 | Year, runtime, rating, subtitles under captions |
| badge | 24/700 | Smallest text in the app: cert box, status badges |

Titles may use a negative tracking of at most -0.02em. Never uppercase, never
letter-spaced eyebrows above headings, never gradient text.

## 4. Space and safe area

8px base. **Safe area 96px left/right, 54px top/bottom** (5% of 1920x1080): no text,
control or focus ring may sit outside it; artwork bleeds to the edge. Gaps: 24px between
cards, 48px between shelves, 32px between button and button, 16px inside a control
between icon and label.

## 5. Structure

- **Nav**: one tab bar across the top of top-level screens only (Home, each video
  library up to four, Search, Discover when available) plus SyncPlay and Settings as
  icon buttons on the right. Deep screens (Details, Player) have no chrome; Back is
  the remote. UP from the first shelf enters the nav; DOWN returns to the last
  focused item, not the nearest one.
- **Home stage**: a fixed full-bleed backdrop cross-fades to the focused item's
  backdrop (250ms debounce, opacity only). Above the shelf line sit logo-or-title,
  metadata and a two-line overview; shelves are clipped below a fixed line so the
  focused shelf always sits at the same height and previous shelves slide away upward.
- **Library**: title and count top-left, a single *Sort* control (OK cycles) and a
  direction toggle, then a poster grid of 6 columns that scrolls by whole rows.
- **Details**: cinematic. Backdrop to the edge, scrim from the left; logo-or-title,
  metadata, tagline, actions (Play/Resume, Start Over, Watched, Favorite), overview, then shelves for Episodes / Cast / Details / More Like This.
- **Lists** (Settings, SyncPlay, pickers): single-column rows 104px tall, label +
  description on the left, current value as a pill on the right.

## 6. Components

**Poster card**: 250x375, radius 16, `surface` placeholder, caption 28/600 below (single
line, ellipsis). Landscape card 392x220. Progress under artwork: 6px track,
`accent` fill. Badges (Requested, Available) sit top-left, 24px, `ground` plate.

**Button**: 76px tall pill, 28/600, 16px icon gap. Idle: `fill-idle` over artwork or
`surface-high` on `ground`. Primary idle: `accent` fill, `ink-on-light` text. **Focused:
always `surface-focus` fill, `ink-on-light` text, scale 1.06.** Primary stays
identifiable by its idle colour, not by a second focus style.

**Tab**: 60px pill, 28/600, `ink-2` idle, `ink` when it is the current screen with a 4px
accent underline (scaleX), focused = button focus.

**Chip**: 44px pill, 26/600, `surface-high`. Cert (PG, TV-MA) is a 2px `ink-3` outlined
badge at 24/700, radius 8.

**List row**: 104px, radius 20, `surface` idle, focused = `surface-focus` fill with
`ink-on-light` text and secondary text at 80% (still >= 7:1). No side-bars.

**Input**: 88px, radius 20, `surface-high`, 32px text; focused gets a 4px `ink` ring.

**Panels (pickers, info, Up Next)**: `ground-raised`, radius 28, `line` hairline, no blur,
one static shadow. Rows inside follow list-row.

## 7. Focus (the UI)

One language everywhere: **white**. Posters and tiles get a 4px `ink` ring set 8px off
the artwork (a pseudo-element fading in by opacity) and lift by scale 1.08. Buttons, tabs
and list rows turn to the white focus fill. Inputs get the white ring. The ring never
clips: shelves reserve 24px of vertical and horizontal runway. Focus is `:focus`
(Chromium 47 has no `:focus-visible`). After any re-render the screen must restore
focus to the same logical item or the first one; on Back the previous screen restores
its focused item and scroll position.

## 8. Motion

Purpose first. Motion confirms where focus went and keeps context across jumps; it is
never decoration.

- Properties: **`transform` and `opacity` only.** Scrolling is a translate on a track,
  never `scrollTop` or `left`.
- Curve: `cubic-bezier(0.23, 1, 0.32, 1)` (strong ease-out) for everything entering or
  moving; `linear` only for the spinner and progress.
- Durations: focus lift 160ms, tab/button fill 120ms, shelf and page scroll 260ms,
  backdrop cross-fade 350ms, screen enter 200ms, OSD fade 200ms. Nothing over 400ms.
- Focus lift is the one motion repeated hundreds of times; it is kept at 160ms and
  skipped entirely under `prefers-reduced-motion` (colour change only).
- Never animate from `scale(0)`; enters use opacity plus 12px translate.

## 9. Iconography

One set, 24px grid, 2.25px round-cap stroke, `currentColor`, inline SVG in
`js/icons.js` (no icon font, no request). Icons accompany labels; they never replace
a label except on the right-hand nav buttons (SyncPlay, Settings) and OSD transport.

## 10. Performance and compatibility rules

- ES5, flexbox only, no `gap`, `inset`, `grid`, `aspect-ratio`, `var()`, `:focus-visible`,
  `position: sticky`, `IntersectionObserver`, `scroll-behavior`, variable fonts.
- No `backdrop-filter`, no animated `filter`/`blur`; one static shadow per panel at most.
- Artwork is lazy: `data-src` is promoted to `src` only when the card is within about
  two screens of the viewport, and requested at display size (poster 320w, landscape 480w,
  backdrop 1280w).
- Shelves hold at most 24 cards; library grids render rows incrementally and request
  pages of 60 as focus nears the bottom.
- AVPlay draws behind the page: during playback `html`, `body` and `#stage` stay
  transparent and the OSD never paints an opaque full-screen layer.

## 11. Do / Don't

Do keep the artwork large and the chrome small; do let one accent carry the primary
action; do make focus unmistakable from the sofa.
Don't use cards inside cards, coloured side-borders, eyebrows above headings,
gradient text, glass, or tiny text.
