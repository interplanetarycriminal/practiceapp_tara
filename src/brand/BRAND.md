# TARA brand: fumbleupon v1.0, "Digital Quartz"

TARA is the ninth fumbleupon home. Everything in V2 is styled from three files, loaded in
this order by the build: `fonts.css`, `tokens.css`, `components.css`. Use the tokens and
the `fu-*` classes; do not hard-code a colour, a font or a shadow. Open `sheet.html` (serve the
repo and visit `/src/brand/sheet.html`) to see every token and component in both themes.

Rules of the house, in one breath: **cool rooms, warm metal, one periwinkle action per
screen. Ink only on the layer above. Poke a working thing first. Wrong is just another state
with a way back.**

## 1. What goes where

| Thing | Use | Never |
| --- | --- | --- |
| Page ground | `.fu-ground` on the page root: ice `--paper`, ink text, Nunito 600 | a gradient, a photo, a pattern behind text |
| Second ground | `--paper-2` (quartz) for wells, alternating rows, empty states | a shadow on it |
| Cards, sheets, the dock | `--card`, 3px `--line`, radius 14, `--shadow-hard` (4px down-right) | soft or blurred shadows, ink lines on things that are not on top |
| The one big button | `.fu-btn--big`: periwinkle pill, white text, one per screen (Start, Resume, Next) | a second big button on the same screen |
| Every other button | `.fu-btn` (watch-case gold), `.fu-btn--ghost` (quiet), `.fu-iconbtn` | red buttons, filled black buttons |
| Picked / current | gold: the selected tab, segment, chip, dock item | colour alone; always pair with shape (`aria-selected`, `aria-pressed`) |
| Labels and plates | `.fu-label` / `.fu-plate`: Big Shoulders Stencil, uppercase, letter-spaced | sentences in stencil; anything longer than four words |
| The voice | `.fu-voice`: Cormorant Garamond italic, a small line: intros, asides, empty states | buttons, labels, body copy, numbers |
| Trail | `.fu-trail` divider, the logo; all six colours, in order | backgrounds, fills, text, fewer than six |
| Calm tints | `--sky --mint --butter --blush --lilac --sea`, `--ch-*`: surfaces only | text colour |
| TARA signal | `--signal` (lime, "level"): progress fills, the count badge, the "you are here" dot | text on paper (use `--signal-deep`), large areas |
| Sherbet | `--sherbet`: a pinch for joy (sparkles, tape, the wordmark shadow) | anything functional |

## 2. Palette

Light (default) and dark (the lamp off). Exact values live in `tokens.css`; these are for reading.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--paper` | #EDF4FC ice | #0F1522 | page ground |
| `--paper-2` | #E6F0FA quartz | #161E2D | wells |
| `--card` | #F7FAFE | #1A2232 | the layer above |
| `--ink` / `--line` | #141A24 | #E6F0FA / #DCE6F2 | text, lines, hard shadows |
| `--ink-2` | #364454 | #C9D5E2 | secondary text |
| `--muted` | #485869 | #A3B2C2 | quiet text (>= 4.6:1 on every tint) |
| `--line-soft` | #B7C7D6 | #364454 | dashed rules inside cards |
| `--accent` / `--accent-ink` | #6C5BF0 / #FFFFFF | same | the big button (4.78:1) |
| `--signal` / `--signal-ink` | #B1DE38 / #141A24 | same | TARA's home signal |
| `--gold` (+ `--gold-grad`) | #E6CDA0 | same | metal: buttons, plates, selection |
| `--good` / `--good-bg` | #1F7A43 / #DDF5E3 | #5BD48A / #17302A | "got it" |
| `--warn` / `--warn-bg` | #7F5A10 / #F6EBD3 | #F2C96E / #33301C | "shaky", time nearly up |
| `--bad` / `--bad-bg` | #B3352A / #FFE3DD | #FF9C8F / #3A2426 | system trouble only |
| trail 1-6 | #FF4D3D #FF8A1F #E6CDA0 #3FD36B #3B8BFF #9B5CFF | same | dividers, logo |

**TARA's signal: lime `#B1DE38`, "level".** The eight homes already hold the wheel: images
red, electronics orange, words yellow, software green, motions teal, portals sky, noises
violet, and periwinkle is the action colour. The widest free gap left is between words'
yellow and software's green, and it happens to be the colour of a spirit level's vial: the
bubble sits between the lines when the thing is aligned. That is the course in one object.
It is a light colour: put ink on it (11:1), and use `--signal-deep` (#556E0A, 5.2:1) when
the signal has to be a line or text on paper.

**Chapters.** `--ch-found` (W0-1), `--ch-interp` (W2-4), `--ch-rl` (W5-6), `--ch-evals`
(W7-9), `--ch-align` (W10-11), `--ch-project` (W12-14). Each is a calm tint, and they step
darker down the course (OKLCH L 0.97 to 0.845), so they differ in lightness as well as hue.
On a chapter tint use `--ink` or `--ink-2` (both >= 6:1; `--muted` still passes).
Shortcut classes: `.fu-ch-found` ... `.fu-ch-project` set `--fu-bg` for `.fu-card`,
`.fu-window`, `.fu-chip` and `.fu-badge`.

## 3. Type

Three faces and no more (plus mono for code): **Nunito** 900 headings and buttons, 800 UI
labels, 600 body; **Cormorant Garamond italic 500** for the voice; **Big Shoulders Stencil
800** for labels, plates and numbers on plates; **JetBrains Mono** 500/600 for code, keys and
tabular numbers (`.fu-mono`, `.fu-kbd`, `.fu-code`).

| Class | Phone (390) | Desktop (1280) | Use |
| --- | --- | --- | --- |
| `.fu-display` | 34px / 900 | 56px | one per page at most (Today's week title) |
| `.fu-h1` | 28px / 900 | 40px | page title |
| `.fu-h2` | 22px / 900 | 28px | section title |
| `.fu-h3` | 18px / 800 | 20px | card title |
| `.fu-text` | 16px / 600, 1.55 | 16px | body |
| `.fu-small` | 14px / 600 | 14px | meta, captions |
| `.fu-label` | 14px stencil, +.08em | 14px | labels, step kinds, plates |
| `.fu-voice` | 1.25em italic | same | one short line |

Headings are sentence case. Labels are uppercase (CSS does it; write them in sentence case
in the markup). Never go below 12px; body never below 16px on a phone. Line length 60-70ch.

## 4. Space, shape, line

`--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16 (the phone gutter), `--s5` 24, `--s6` 32. Cards pad
`--s4`; gaps between cards `--s4` on a phone, `--s5` on desktop. Tap targets `--tap` (44px).
Radius: `--r-btn` 9 buttons, `--r-card` 14 cards, `--r-window` 18 windows, `--r-pill` the big
button and chips. Line `--lw` 3px for cards and windows, 2.5px rings on buttons, 2px on chips.
Hard shadows only: `--shadow-hard` (4px), `--shadow-s` (2px, pressed), `--shadow-lift` (7px,
hover lift), `--shadow-big` (6px, windows). A card inside a card is `.fu-card--flat`.

## 5. Components

All single-class. States use `aria-*` first, `.is-on` second. Markup sketches:

```html
<body class="fu-ground">                                     <!-- page ground -->
<article class="fu-card">...</article>                        <!-- + --lift (link cards), --flat, --well, --done -->
<article class="fu-card fu-ch-align">...</article>            <!-- chapter-tinted -->
<section class="fu-window">                                   <!-- a window with the gold title bar -->
  <header class="fu-titlebar"><span class="fu-titlebar__title">week 10</span>
    <span class="fu-titlebar__tools"><button class="fu-iconbtn" aria-label="Close">...</button></span></header>
  <div class="fu-window__body">...</div>
</section>
<header class="fu-appbar">...<span class="fu-appbar__title">...</span>...</header>  <!-- top bar: Films, 3D, Lab -->

<button class="fu-btn fu-btn--big">Start</button>             <!-- the one big button -->
<button class="fu-btn">Open the demo</button>                 <!-- gold -->
<button class="fu-btn fu-btn--ghost">Skip</button>            <!-- quiet; + --small, --wide, --link -->
<button class="fu-iconbtn" aria-label="Back"><svg>...</svg></button>

<div class="fu-seg" role="group" aria-label="Session length">  <!-- 10/30/60, tiers 1/2/3 -->
  <button class="fu-seg__opt" aria-pressed="false">10 min</button>
  <button class="fu-seg__opt" aria-pressed="true">30 min</button>
  <button class="fu-seg__opt" aria-pressed="false">60 min</button>
</div>
<span class="fu-chip">W10</span>  <button class="fu-chip" aria-pressed="true">films</button>
<span class="fu-badge">skippable</span>  <span class="fu-badge fu-badge--count">7</span>

<nav class="fu-tabs fu-only-desk" aria-label="Main">        <!-- desktop, >= 720px -->
  <a class="fu-tab" href="#today" aria-current="page"><svg>...</svg>Today</a> ...
</nav>
<nav class="fu-tabbar fu-only-phone" aria-label="Main">     <!-- phone dock, < 720px -->
  <a class="fu-tabbar__item" href="#today" aria-current="page"><svg aria-hidden="true">...</svg>
    <span class="fu-tabbar__label">Today</span></a> ... five items
</nav>
<main class="fu-tabbar-pad">...</main>                       <!-- content clears the dock -->

<div class="fu-progress" role="progressbar" aria-label="Week 10 path" aria-valuemin="0"
     aria-valuemax="9" aria-valuenow="4"><span class="fu-progress__fill" style="width:44%"></span></div>
<span class="fu-label">core idea</span>  <span class="fu-plate">week 10</span>
<p class="fu-voice">start anywhere. the path remembers.</p>
<hr class="fu-trail">   <!-- or .fu-trail--thin -->
<kbd class="fu-kbd">2</kbd>  <code class="fu-code">torch.einsum</code>  <span class="fu-mono">12:40</span>
<div class="fu-note">today: one film, two cards, one check.</div>   <!-- taped note -->
<a class="fu-item" href="...">...</a>                       <!-- a row in a list card -->
<span class="fu-tick is-on" aria-hidden="true"></span>      <!-- done; .is-doing = here -->
<input class="fu-input" type="search" placeholder="search the library">
<div class="fu-toast" role="status">...</div>               <!-- + --good, --warn, --bad -->
<div class="fu-empty">...<p class="fu-empty__line">...</p></div>
<div class="fu-loading" role="status"><span class="fu-loading__lamp"></span><p class="fu-loading__line">...</p></div>
<div class="fu-oops" role="alert">...<p class="fu-oops__line">...</p><button class="fu-btn">try again</button></div>
```

Notes:
- **`.fu-ground`** sets the font, size (16px) and colour that everything inside inherits. Put it
  on V2's root; old sections keep their own CSS and win wherever they set their own values.
- **The dock** is `position: fixed` at the bottom with safe-area padding; give the scrolling
  content `.fu-tabbar-pad` so nothing sits under it. Show `.fu-tabs` at >= 720px and the dock
  below (`.fu-only-desk` / `.fu-only-phone`). Five items: Today, Weeks, Practice, Library, Lab.
  The Recall count rides on Practice as `.fu-badge--count`.
- **Toasts** are styled, not positioned: the shell gives them a reserved slot (under the top
  bar, or just above the dock with matching padding), never over content.
- **Done keeps its slot**: `.fu-card--done`, `.fu-tick.is-on`, gold for "here"; never remove a card.
- **Skeletons** (`.fu-skel`) hold the exact slot of what is coming, so nothing moves when it lands.

## 6. Motion

One spring, `--spring` = cubic-bezier(.34,1.56,.64,1). `--t-press` 120ms for presses (buttons
sink 2px and the shadow shrinks), `--t-lift` 260ms for hovers and lifts, `--t-enter` 650ms for
entrances (`.fu-enter`). The mechanism moves first, the result second: the button sinks, then
the panel opens; the tick lands, then the card goes quiet. Nothing loops except loading.
`prefers-reduced-motion` turns transforms and loops off (components.css does this for `fu-*`);
do the same for your own animations.

## 7. Icons

24px grid, drawn at 26px in the dock and 20px in buttons. Line icons: 2.5px stroke in
`currentColor`, round caps and joins, no fills except a gold or signal accent on one part.
Shapes are simple objects from the room (a clapperboard for films, a cube for 3D, a flask for
the Lab, a card stack for Practice, a book spine for the Library, a sun for Today, a path of
three dots for Weeks). Pixel icons (16x16, 1px squares, `shape-rendering: crispEdges`) only
for the fumble/shuffle gag and sparkles, as in electronics. Every icon-only button has an
`aria-label`; decorative SVG gets `aria-hidden="true"`.

## 8. Voice

Calm, kind, a little dry. Short. Say what happened and the way back. Two registers, as
electronics ships them:

- **Names** (buttons, tabs, headings, titles, labels): sentence case, plain. "Start", "Pick up
  where you stopped", "Week 10, alignment science".
- **The voice** (`.fu-voice`, toasts, the lines in empty / loading / oops states, asides):
  lowercase. "nothing here yet. every bench starts like this."

"its" without the apostrophe is the house fumble: use it only in the lockup ("its okay to"),
never in teaching text. Teaching content is not rewritten; this is for UI microcopy.

| Moment | Say | Not |
| --- | --- | --- |
| Start (button) | **Start** · **Pick up where you stopped** | Begin session |
| Box | 10 min · 30 min · 60 min, with "a quick look / a proper go / the full week" | Short / Medium / Long |
| Empty recall | nothing to recall yet. misses and shaky cards land here. | No items found. |
| Empty library search | nothing called that. try fewer words. | 0 results |
| Loading | warming up the lamp... · setting out the cards... | Loading, please wait |
| Slow | still going. the last 1% is always shy. | Request timed out |
| Offline | no signal. everything you opened before still works. | Network error |
| Oops | that fumbled. nothing is lost; try again. | An error occurred |
| Self-grade (buttons) | **Got it** · **Shaky** · **To revisit** (`solid` / `shaky` / `blank`) | correct / incorrect, scores, % |
| After a miss | almost. the answer was B; it comes back in 3 days. | Wrong! |
| Time's up | time's up. a good place to stop; it will be here next time. | Session expired |
| Done for the week | week 10, done. see you saturday. | 100% complete |
| Capstone | 26 days to the freeze. one small thing today is plenty. | Deadline approaching |
| Skippable | library call, low utility. skip it guilt-free. | Optional |

Buttons are verbs in sentence case ("Start", "Open the demo", "Try again"); the voice line
sits above or beside them in `.fu-voice`, never inside.

## 9. The TARA lockup

The fumbleupon mark (the fumble, a lilac blob with two eyes) + the wordmark ("its okay to /
**fumble** upon") + the home's sfx: **tara**. Paste-ready markup is in `lockup.html`:
`.fu-lockup` (sizes: `--s` 34px for the phone top bar, default 44px, `--l` for a hero). The
wordmark carries its lilac and sherbet shadows and two gold sparkles; the letters of "fumble"
jiggle on hover. The whole lockup is one link with one aria-label ("its okay to fumble upon
tara: today"); the parts are `aria-hidden`. Do not recolour, rotate or stretch it, never put
it on a tint, and keep clear space of half its height around it (the gag needs the space above
"upon").

The v1.0 sfx is Cormorant italic (as electronics ships it). The older stencil sfx exists as
`.fu-wordmark__sfx--stencil` for small plates; prefer the italic.

**TARA's gag: "level".** v1.0 gives every home one gag on its wordmark (electronics zaps "upon"
with a bolt). TARA's: point at the lockup and "upon" tips; a lime spirit level lands on it and
the bubble runs uphill; then "upon" settles level and the bubble sits between the lines. It is
pure CSS in `components.css`: hover or keyboard focus plays it, and adding `.is-level` to the
`.fu-lockup` plays it from script (for example once, the first time the learner finishes a
week). Reduced motion turns it off.

**Faces.** In reactions the fumble wears TARA's signal (lime), the way electronics' wears its
orange: delighted for toasts and "got it", content for empty states, sheepish for oops. SVG in
`lockup.html`. It never sulks.

## 10. Dark mode: the lamp

"The lamp is dark mode." The shell puts one `.fu-lamp` button in the top bar (markup in
`lockup.html`): a desk lamp with a pull chain. Pressing it pulls the chain (the chain dips,
then the light changes: mechanism first) and toggles the theme.

- State lives in `localStorage['tara.v2.theme']`: `"light"`, `"dark"` or absent (follow the OS).
- Apply it as `document.documentElement.dataset.theme = "light" | "dark"`; remove the
  attribute to follow the OS. `tokens.css` handles all three cases.
- The button: `aria-pressed="true"` when dark (lamp off), `aria-label="Lamp: lights off (dark mode)"`
  / `"Lamp: lights on"`. Set the attribute before first paint (an inline script in `<head>`)
  so there is no flash.
- In dark mode the ink line and the hard shadow turn light (chalk on a dark desk); gold and
  periwinkle buttons keep their dark ring and text. Do not add new dark-only colours: use tokens.

## 11. Do not

- add a second periwinkle button, a red button, or a gradient anywhere except the gold and
  periwinkle buttons that come with the classes;
- use soft, blurred or coloured shadows (the taped note is the one paper exception);
- put text on the trail, on sherbet, or in a calm tint colour;
- judge the learner: no percentages, scores, red crosses or "wrong";
- float anything over content on a phone; reorder cards when state changes;
- load a font from a CDN, or a fourth face;
- style bare elements (`button {}`, `h2 {}`) from shared CSS; scope to your section or use `fu-*`.

## 12. What v1.0 changed from the older boards

Taken from v1.0 (the ideals board and electronics' shipped CSS) over the v0.8 core pack:
paper is ice `#EDF4FC` not `#FBFAF6`; ink is blue-black `#141A24` not `#17140F`; the one big
button is a **periwinkle** pill, not red `#E8412F` (which also failed 4.5:1 with white text,
4.02); ordinary buttons are **watch-case gold** with a bevel, so "no gradients on UI" now
allows exactly those two metal finishes; butter is `#F3E6CB`; the trail's yellow is gold
`#E6CDA0`; the wordmark gets a lilac then sherbet shadow and sparkles; the sfx is Cormorant
italic; focus is a 3px dashed blue ring; there is a full dark theme. Kept from v0.8: three
faces, the 3px line, 4px hard shadow down-right, radii, the spring and timings, the voice.

Two judgement calls on v1.0 itself: the ideals say a room's light comes from a window on the
right "so every shadow falls left, including the card's", but every v1.0 component as shipped
(the kit board and electronics' CSS) still casts its hard shadow down-right, so the kit keeps
down-right. And the periwinkle gradient's middle stop moves from 55% to 38% so the white label
band clears 4.5:1 (it is large text, which only needs 3:1, but it costs nothing).

## 13. Fonts and files

Shipped in `fonts/` (latin woff2), all SIL Open Font License 1.1: Nunito 600/700/800/900
(Vernon Adams, Cyreal, Jacques Le Bailly), Cormorant Garamond 500 italic and 500 upright
(Christian Thalmann; upright is for longer voice passages, as electronics' "moment" cards use
it), Big Shoulders Stencil 800/900 (Patric King), JetBrains Mono 500/600 (JetBrains).
Dropped as unused by TARA: Barlow 500/600 and Barlow Semi Condensed 600/700 (electronics' 3D
silkscreen only), Cormorant Garamond 600, and `img/bolt.webp` / `img/scorch.webp` (electronics'
zap gag; TARA's gag is CSS). `img/` is empty; the build's `listDir` skips a missing folder.

Components set `box-sizing: border-box` on themselves, so they behave the same inside the
shell (which resets box-sizing in `.app-shell`) and on the Films, 3D and Lab pages (which may not).
