# brand notes

## Status
- READY written 16:57Z (tokens.css, fonts.css, components.css, BRAND.md). Token and class names frozen since.
- Done since: lockup.html (lockup, mark, app icon, fumble faces, lamp, five tab icons), sheet.html,
  TARA's wordmark gag "level", contrast pass, screenshots at 390x844 and 1280x800, light and dark.
- Sources read: the brand canvas (F1-Ideals, F1E-Parts, F1E-Phone, Family, Logo-System, Oops-Empty,
  Oops-Loading, Badges) and electronics.fumbleupon's shipped CSS + index.html. All readable.

## Decisions
- v1.0 "Digital Quartz" wins over v0.8: ice paper #EDF4FC, blue-black ink #141A24, the one big
  button is a periwinkle pill (#6C5BF0, white text 4.78:1) not red (#E8412F failed 4.5 with white,
  4.02), ordinary buttons are watch-case gold, butter #F3E6CB, trail slot 3 is gold #E6CDA0,
  wordmark shadow lilac then sherbet, sfx in Cormorant italic, 3px dashed blue focus ring, full dark theme.
- Hard shadows stay down-right (every shipped v1.0 component does), though the ideals' "light from
  the right" would cast left.
- TARA signal = lime #B1DE38 "level" (spirit-level vial; fills the free hue gap between words'
  yellow and software's green). Text-safe variant --signal-deep #556E0A.
- Chapter tints step down in OKLCH lightness 0.97 to 0.845 (found butter, interp sky, rl mint,
  evals blush, align lilac, project sea); dark ladder 0.235 to 0.345.
- --muted darkened to #485869 so it passes 4.5:1 on every tint and chapter tint.
- Casing: names (buttons, tabs, headings) sentence case; voice lines (toasts, empty/loading/oops,
  asides) lowercase. This is how electronics ships v1.0.
- TARA's gag "level" replaces electronics' zap (one gag per home). CSS only.
- Dropped unused files: Barlow x2, Barlow Semi Condensed x2, Cormorant Garamond 600, img/bolt.webp,
  img/scorch.webp. img/ is now empty (build's listDir tolerates a missing folder).
- --accent-grad middle stop moved to 38% so the label band clears 4.5:1.

## Interfaces
- `src/brand/tokens.css`: every contract token, light default, dark under the media query (when
  html has no data-theme="light") and under `:root[data-theme="dark"]`. Extras (stable): --card-2,
  --gold, --gold-hi, --gold-grad, --gold-bevel, --gold-ink, --accent-grad, --accent-2, --accent-text,
  --sherbet, --signal-deep, --focus, --link, --steel, --done, --shadow-s, --shadow-lift, --shadow-big,
  --ease, --r-window, --r-small, --lw-thin, --tabbar-h, --sparkle.
- `src/brand/components.css` classes: fu-ground (+--quartz), fu-focus, fu-display, fu-h1, fu-h2,
  fu-h3, fu-text, fu-small, fu-muted, fu-voice, fu-label, fu-mono, fu-code, fu-kbd, fu-plate,
  fu-trail (+--thin), fu-card (+--lift, --flat, --well, --done), fu-tint-{sky,mint,butter,blush,lilac,sea},
  fu-ch-{found,interp,rl,evals,align,project}, fu-window, fu-window__body, fu-titlebar (+__title, __tools),
  fu-appbar (+__title), fu-btn (+--big, --ghost, --small, --wide, --link), fu-iconbtn, fu-chip (+--signal),
  fu-badge (+--gold, --quiet, --signal, --count), fu-seg (+--wide, __opt, __sub), fu-tabs, fu-tab,
  fu-tabbar (+__item, __label), fu-tabbar-pad, fu-only-phone, fu-only-desk, fu-progress (+--thin, __fill),
  fu-note, fu-item, fu-tick (.is-on, .is-doing), fu-input, fu-lamp (+__bulb, __glow, __chain),
  fu-toast (+--good, --warn, --bad, __icon), fu-empty (+__art, __line), fu-loading (+__lamp, __bar,
  __line, __art), fu-oops (+__art, __line, __detail), fu-skel, fu-mark (+--breathe), fu-lockup (+--s, --l,
  .is-level), fu-wordmark (+__lead, __row, __main, __tail, __sfx, __sfx--stencil), fu-l, fu-sr, fu-enter.
  States: aria-pressed / aria-selected / aria-current / aria-checked, else .is-on.
- Breakpoint: dock below 720px, top tabs from 720px.
- `src/brand/lockup.html`: paste-ready SVG/markup between BEGIN/END comments.
- `src/brand/sheet.html`: the living brand sheet (?theme=light|dark pins a theme).

## Requests
- shell: apply `tara.v2.theme` as `<html data-theme>` in an inline head script before first paint
  (spec in BRAND.md section 10); put `.fu-lamp` and `.fu-lockup--s` in the top bar; give scrolling
  content `.fu-tabbar-pad` (or equal padding) under the fixed `.fu-tabbar`.
- shell: re-run `node tools/build-shell.js` so sw.js stops precaching the dropped
  shell/fonts/barlow-*, shell/fonts/cormorant-garamond-latin-600-*, shell/img/bolt.webp and
  shell/img/scorch.webp (stale copies in shell/ can be deleted).
- bars: the Films / 3D / Lab pages need fonts.css + tokens.css + components.css (or the built
  shell/app.<hash>.css) to use `.fu-appbar`; components set their own box-sizing.

## Known issues
- Dark mode draws lines and hard shadows in light "chalk" (#DCE6F2), as v1.0 does; gold and
  periwinkle buttons keep their dark ring on purpose.
- `.fu-ground` sets font, size and colour that children inherit; put it on V2 roots. Old sections
  keep their own CSS and win where they set their own values.
- Toasts are styled, not positioned (the shell owns placement; never over content on a phone).

## Orchestrator changes after hand-back
- 2026-11-09: default `.fu-badge` text is now `var(--fu-ink, var(--gold-ink))` and every `.fu-tint-*` / `.fu-ch-*`
  class also sets `--fu-ink: var(--ink)`. Reason: in dark mode `--gold` stays light while `--ink` turns light,
  so the default gold badge had light text on light gold (reported by recall).
