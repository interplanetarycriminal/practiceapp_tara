# bars — notes

Owner of: `shared/**`, `intuition/engine.js`, `intuition/index.html`, `intuition/node.html`,
`intuition/node-film.js`, `intuition/node-list.js`, `objects/kit.js`, `objects/kit.css`,
`objects/index.html`, `objects/node.html`, `objects/node.js`, `lab/index.html`, `lab/lab.css`,
`lab/ui/*.js`, this file.

## Status
- [x] `shared/tara-bar.js` + `shared/tara-bar.css` (the one top bar), in the brand's fu-* classes
- [x] films: hub, engine (all 28 films), concept films
- [x] objects: Model Room, kit (all 28 objects), concept twins
- [x] Lab: header, the reading layer's tier tabs follow the bar, "Practitioner" -> "Generalist"
- [x] viewer mode (inside the V2 shell's iframe)
- [x] brand pass (bar, films hub title area, Model Room bar, Lab header; `shell/brand-scoped.css`)
- [x] verification shots (`scratchpad/v2shots/bars/`)
- [x] Lab Tools map: three tool pins (Logit lens, OV circuit, Probe) were blank, because the reading
  layer's glossary wrapped their SVG text in HTML spans; `lab/ui/river.js` and `lab/ui/charts.js` now
  mark `svg` and `text` with `data-tara-noglossary` (found while shooting; not a bar change)
- [x] safety review (2026-11-09): V1 visitors get V1's tabs; no lamp or `tara.v2.theme` for them;
  one short row on a phone on its side; the Lab's floating pill is gone (Review in flow, V1 keeps
  Plan/Map); shots `scratchpad/v2shots/bars/modes/`
- [x] learner walkthrough (2026-11-09): Lab card labels keep their room; film controls and scrub are
  44px targets; the Model Room's title no longer shows twice in the viewer

## The protocol with the shell

**Who handles which click inside the viewer.** Rule for both of us: handle a click only if
`!e.defaultPrevented`, and call `e.preventDefault()` when you do handle it. Then a click never
navigates twice, whichever listener runs first.

The shell's viewer (`src/v2/viewer.js`) routes first: capture phase on the viewed page's window,
then `preventDefault()` + `stopPropagation()`. bars listens later (bubble phase, the page's
`document`, `shared/tara-bar.js`) and acts only on clicks the shell left alone (e.g. before the
shell has attached to a fresh page), with the same routing, only when the page is in the V2
viewer (`window.top !== window && top.TARA_SHELL === 'v2'`):
- a link to the shell document (`<root>/`, `<root>/index.html`, `<root>/next.html`, with or
  without `#hash`) -> `top.location.hash = hash || '#today'`;
- a link into `lab/` -> `top.location.href = <that url>` (the Lab never goes in the viewer);
- anything else: left to the iframe (the shell already sends films/objects links to `#view/...`).
- modified clicks (ctrl/meta/shift/alt, middle button), `target="_blank"` and `download` links
  are left alone.
Tested on every page type in a harness whose parent sets `TARA_SHELL='v2'` (no shell router):
shell links set the top hash and the frame stays; lab links move the top window.

Outside the viewer (a standalone page), the same listener rewrites links to the front door
(`<root>/` or `<root>/index.html#x`, which the pages hard-code) to the shell named by
`sessionStorage['tara.shell']` when that is another document (so during the preview a coda link
"On the concept map" lands in `next.html#map/node=x`).

**V1 or V2 mode.** The shells' file names live in one place, `shared/tara-bar.js`:
`V2_DOC = 'next.html'`, `V1_DOC = 'index.html'` (and `FRONT_DOC = 'index.html'`, the default for a
tab with no `tara.shell`, which never changes). When V2 becomes the front door, change those two
lines to `V2_DOC = 'index.html'`, `V1_DOC = 'classic.html'`; the classic shell must then write
`sessionStorage tara.shell = 'classic.html'` on boot, as next.html writes `'next.html'` today.
V2 mode = in the viewer, or the tab's shell is `V2_DOC`; everyone else is in V1 mode (today: the
live site's visitors, whose index.html clears `tara.shell`). `lab/ui/bar.js` asks `TaraBar.isV2()`.
- V2 mode: V2's five tabs (Today, Weeks, Practice, Library, Lab -> `next.html#...`), the lamp,
  `tara.v2.theme`.
- V1 mode: what V1's own nav has, so every tab lands where it says: Now (`index.html#today`; V1's
  nav calls it Now), Plan (`#plan`), Drill (`#drill`), Films (`intuition/index.html`), 3D
  (`objects/index.html`), Lab (`lab/index.html`); current = the page's folder (films -> Films,
  objects -> 3D, lab -> Lab; `mount({v1tab})` overrides). No lamp, no `tara.v2.theme`: the pages
  follow the device as before. The films hub's label reads "TARA · films" (Library is V2's word).

**Viewer mode.** When `top.TARA_SHELL === 'v2'`: no bar and no back links on the films hub, the
films, concept films, objects, concept twins and the Lab. Only the Model Room keeps a slim row,
with the List button, because List has no other home; its h1 "Model Room" stays for screen readers
only (the viewer's own row already names the page). 2D | 3D in the viewer
is the shell's own pill (`objects/hook.js`, `#v2-dimslot`); a weekly film's coda also offers
"Hold it in 3D". The objects' own 1/2/3 pill in the label card steps aside (the shell's tier is
the control). Keys 1/2/3 still work inside the iframe: they write `tara.tier` +
`tara.resolution` and, when `top.APP.setTier` exists, call it at once (the shell's `storage`
listener would follow anyway). Tier changes made in the shell reach the page through `storage`.

**Theme.** In the viewer a page copies the shell's resolved `<html data-theme>` (and follows it).
Standalone pages in V2 mode follow `tara.v2.theme` ('light' | 'dark' sets `<html data-theme>`, absent leaves
it to the OS), follow changes through `storage`, and from 1080px wide the bar has the lamp
(`.fu-lamp`), which pulls exactly like `APP.theme.toggle()` (a flip that lands on what the device
shows goes back to following the device) and fires `tara:theme`.

## Interfaces

`window.TaraBar` (`shared/tara-bar.js`, plain script, no deps; every call is safe without a mount):
- `mount(opts) -> bar`. opts: `tab` ('today'|'weeks'|'practice'|'library'|'lab', V2's), `v1tab`
  ('today'|'plan'|'drill'|'films'|'3d'|'lab', V1's; default from the page's folder), `title`
  (string or element), `titleTag` ('h1'), `titleHref`, `up: {href, label, title}`,
  `tools: [Element]` (moved into the bar's page slot), `dim: {active: '2d'|'3d', href, title}`,
  `host` (fill this element) or `replace` (replace it) or neither (top of `<body>`),
  `onTier(n)`, `keys` (default true: keys 1/2/3 unless typing), `slim` (viewer row; default true,
  false = nothing in the viewer), `root` (site root if the script cannot find its own URL).
- `bar = { el, mode: 'full'|'slim'|'none', viewer, setTitle, setUp, setDim, setTools, height() }`
- `tier()`, `setTier(n)` (writes `tara.tier` + `tara.resolution`), `onTier(fn) -> off`,
  `names {1: 'Plain', 2: 'Generalist', 3: 'Expert'}`
- `inViewer()`, `isV2()`, `docs {v1, v2}`, `shellDoc()`, `shellHref('#x')`, `isShellURL(u)`,
  `root()`, `theme()`, `toggleTheme()`,
  `heights {narrow: 99, wide: 67, short: 51, slim: 50, wideFrom: 1080, shortTo: 500}`,
  `fullHeight()` (the full bar's height at this viewport, for pages that hold its room)
- `<html data-tb="full|slim|none">`, `<html data-tara-tier="1|2|3">`; listens to `storage`
  (`tara.tier`, `tara.resolution`, `tara.v2.theme`) and `tara:tier` (the Lab's reading layer).
- Markup: `header.tara-bar.tb-full|tb-slim.fu-scope.fu-appbar` (+ `.tb-v1|.tb-v2`); lockup `.fu-lockup.fu-lockup--s`;
  tier `.tb-tier.fu-seg > button.tb-t.fu-seg__opt[aria-pressed]`; 2D|3D `.tb-dim.fu-seg`; lamp
  `.tb-lamp.fu-lamp`. The script links `<root>/shell/brand-scoped.css` just before
  `shared/tara-bar.css`; `tara-bar.css` keeps the bar's layout and a copy of the tokens (scoped to
  `.tara-bar, .tb-scope`), so the bar is whole without the brand file.
- Heights (before `env(safe-area-inset-top)`): two rows of 48px + 3px = 99px below 1080px, one
  row of 64px + 3px = 67px from 1080px, slim 48px + 2px = 50px; a phone on its side (below 1080px
  wide and at most 500px tall): one row of 48px + 3px = 51px (mark, page slot, tier, 2D|3D; no
  tabs). The films (`#ifilm.tb-pending`) and objects (`html.k-tb-pending`) hold the same heights.

Films (`intuition/engine.js`): `IFilm.play(cfg)` also takes `up: {href, label, title}` (default:
the films hub from `cfg.back`) and `dim` (`{active, href, title}`; `null` = no 3D twin;
left out = looked up in `objects/objects.json` by the film's path). The engine loads the bar
itself (no change to the 28 film files); `api.bar` is the mounted bar.

Objects (`objects/kit.js`): `run(spec)` also takes `up: {href, label, title}` (default: the
object's place in the Model Room), `dim2d` + `dim2dTitle` (the 2D side when it is a film, not a
week). Exports `VIEWER` and `barReady` (a promise of `window.TaraBar` or null). With the bar the
kit sets `<html class="k-has-bar">` and `--bar-h` to the bar's height; in the viewer
`<html class="k-viewer">` and `--bar-h: 0`.

## Decisions
- Tabs stay in the top bar on every width (films and objects have their own bottom controls, so
  no dock). Phones: two rows (lockup mark + tabs; up/title/tools + tier + 2D|3D). From 1080px one
  row. The tier shows 1 2 3 below 600px (like the shell's bar on a phone), names above; the whole
  lockup only from 1440px (the page title needs the room); the lamp from 1080px.
- Picked/current is gold (BRAND.md): the current tab, the tier, the side of 2D|3D you are on.
- Films: mute moved into the bottom control row; the film's old top row comes back only if the
  bar cannot load (offline first visit). The control buttons are 44px targets and the scrub's hit
  area is 44px (its track stays thin); below 560px wide the chapter dots get their own line above
  the controls; at most 500px tall the caption box is three lines (4.2em), so a phone on its side
  keeps a 210px stage at 844x390 (it was 208px before the bar). Concept films: up is the concept films list, or the map
  node when opened from the app; 2D|3D leads to the 3D twin.
- Objects: one tier control (the card's pill hides with the bar); the kit's own bar is the
  fallback. Concept twins: 2D is the concept film, up is the Model Room's concept list.
- Model Room: List moves into the bar's tools slot as a `.fu-chip`; the bar mounts from a
  classic script right after the header (no wait for three.js, no layout shift).
- Lab: the bar scrolls away; the Lab's own tab row (48px) is the sticky part, with the model
  button; on a phone (<= 760px) the model button rides in the bar so the five Lab tabs fit one
  row. The reading layer keeps its glossary, tiered copy, popovers and Review queue, but nothing
  of it floats any more: its control and pill are hidden (a style injected into its open shadow
  root) and a Review button with the saved count sits in flow, in the sticky row beside the model
  button on a wide screen, at the end of the page (before the footer, "Review queue") on a phone.
  It opens the layer's own panel: under the button on a wide screen, as a sheet at the bottom on
  a phone. V1 visitors also get the pill's links (Plan, Map) beside it. The layer stays on the
  bar's tier both ways. "TARA" up goes to `next.html#lab` in V2 mode (capstone's request),
  `#today` otherwise. A card's label keeps 14px of room above the card (`.card:has(> .label)`),
  so it never sits on the line above. The Lab's body palette is untouched (statistics colours);
  its tabs take Nunito.
- Films hub title area: stencil label, Nunito 900 title (tape kept), Nunito intro in ink-2, a
  thin six-colour trail, through `.tb-scope.fu-scope`; the film cards keep their paper.
  Contrast on the hub's paper: ink 15:1 light / 14:1 dark, ink-2 8.7:1 / 10.7:1.

## Requests
- shell (`sw.js`): `shell/brand-scoped.css` and the faces are precached already, `shared/` is
  network-first and cached on use; please also precache `shared/tara-bar.js` and
  `shared/tara-bar.css`, so a film or an object opened offline before any bar page was seen
  online still gets the bar (today it falls back to the page's old header, which works).
- ~~`lab/vendor/tara-layer.js`: TIER_LABEL and SKIP_TAGS~~ done by the orchestrator (below).
- whoever owns `lab/vendor/tara-layer.js`: its narrow rule
  `.panel{top:auto; bottom:10px; ...; max-height:66vh}` (inside `@media (max-width:760px)`) comes
  before the base `.panel{top:96px; ...}` rule and loses, so on a phone the review panel hangs from
  96px instead of sitting at the bottom. The Lab overrides it from its injected style; other pages
  with the layer still get the hanging panel.

## Known issues
- Lab on a phone: the model button scrolls away with the bar (the Lab's tab row stays).
- Lab without the bar (its script failed to load): the floating control/pill come back as before,
  and the Lab's own back link goes to `index.html#today` (lab/hook.js hands a V2 tab over to
  `next.html#today`, not `#lab`).
- Model Room in the viewer: the slim row now holds only the List button.
- `intuition/node-list.js` untouched (nothing in it needed the bar).

## Orchestrator changes after hand-back
- 2026-11-09: lab/vendor/tara-layer.js now says 'Generalist' for tier 2 in its own TIER_LABEL, and
  skipSubtree() upper-cases tagName so SVG subtrees (lowercase tag names) are skipped by the glossary
  wrap. The runtime rename in lab/ui/bar.js and the data-tara-noglossary marks stay as belt and braces.
