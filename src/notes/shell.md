build ready: node tools/build-shell.js

# shell — notes

Owner of: `src/shell/**`, `src/sections/**`, `src/v2/{chrome,viewer,library}.*`,
`tools/build-shell.js`, `tools/sw.tpl.js`, `next.html`, `shell/**`, `sw.js`,
`intuition/hook.js`, `objects/hook.js`, `lab/hook.js`.
(`src/v2/today.*` and `src/v2/session.*` belong to the Today builder from the learner-walkthrough
round on.)

## Status
- [x] `tools/build-shell.js` (next.html, shell/*, sw.js; deterministic; strict by default)
- [x] router / chrome / viewer / session
- [x] Today, Library
- [x] hooks + V1 return shim
- [x] service worker (both shells, navigations under their own URL)
- [x] brand pass on chrome, Today, Library, panels, toast; brand layers (scoped to `.v2-shell`) on
      cases, drill, the frame bar and the packs / demos indexes (frame content keeps its own look)
- [x] fixes in the old sections: Cases in TARA's weeks, chapters and dates; drill and cases side
      gutters; the cases "back" pill in flow; nothing under the dock; Today has no crash-sprint row
- [x] verification (see the bottom of this file)

## Build (how to use it)
```
node tools/build-shell.js                  # -> next.html + shell/ + sw.js
node tools/build-shell.js --skip-broken    # leave out (with a warning) any src/v2/*.js that does not parse
node tools/build-shell.js --out index.html # only at the switch; V1 must be classic.html first
node tools/build-shell.js --check          # writes nothing; exit 1 if next.html / sw.js are out of step
python3 -m http.server <port>              # then open next.html#today
```
- `--check` (run it before every deploy, and after V1's `build-site.js`): next.html's payload list
  must equal index.html's (the keys that differ are named), every `shell/...` file next.html names
  must exist, sw.js must precache next.html and every file it lists must exist, and sw.js's
  `ASSET_FILES` must be V2's list (a `null` there means V1's build-site.js wrote sw.js last). On a
  failure it prints what to run (`node tools/build-shell.js`, then check again).
- Bundles `src/v2/*.js` / `*.css` in the contract's order (chrome, viewer, session, today,
  weeks, recall, practice, library, lab, then the rest alphabetically). Files starting with
  `_` or `.` and `*.test.js` are NOT bundled.
- Each JS module is wrapped in its own IIFE and syntax-checked; a module that does not parse
  fails the build (name + error printed). `--skip-broken` skips it instead.
- CSS `url()`s are resolved against their own source file and re-pointed: anything in
  `src/brand/fonts/` -> `shell/fonts/`, `src/brand/img/` -> `shell/img/`, any other repo
  file -> `../<path>`. Root-absolute urls fail the build. A missing or empty `src/brand/img/` is fine.
- `data/paths.json` (if present, must parse) -> `shell/paths.<hash>.json`;
  `window.__PATHS_URL = "shell/paths.<hash>.json"` is set before the bundle runs.
  Absent paths.json -> `window.__PATHS_URL` is not set at all (undefined).
- `shell/` is wiped and rewritten on every build (no stale hashed files).
- next.html also gets its own web app manifest (`shell/manifest.<hash>.json`, start_url
  `../next.html#today`) so a home-screen install of the preview opens the preview.
- **V1's `build-site.js` also writes `sw.js`** from the same template with V1's files only
  (it fills `__CACHE_VERSION__` and `__SHELL_FILES__` with a first-match `.replace`, so the
  template's header comment never spells those two names). If anyone runs it, run
  `node tools/build-shell.js` after it; `--check` says so when it was forgotten.
- next.html also carries `window.__MANIFEST_DOC` (index.html, or classic.html at the switch): the
  document whose payload list V2 re-reads when a payload name has gone stale (see Payloads).

## Interfaces I expose

### Files
- **`shell/brand-scoped.css`** (stable name, no hash, precached): `src/brand/fonts.css`
  (urls -> `fonts/...`) + `tokens.css` with its three root selectors moved onto a scope class
  (`:root {` -> `.fu-scope {`, `:root:not([data-theme="light"]) {` ->
  `:root:not([data-theme="light"]) .fu-scope {`, `:root[data-theme="dark"] {` ->
  `:root[data-theme="dark"] .fu-scope {`) + `components.css`. For pages that keep their own
  `:root` tokens (Films, 3D, Lab): link `../shell/brand-scoped.css` and put `class="fu-scope"`
  on the element that should use the brand (add `fu-ground` too for the brand's base font, size
  and colour). The build fails if tokens.css stops having exactly those three selectors (so
  nothing can leak onto the host page's `:root`). Checked: a host page's own `:root` tokens stay
  as they are; inside `.fu-scope` the brand's light and dark tokens apply.

### Globals set in next.html's <head> (before anything paints)
- `window.TARA_SHELL = 'v2'`, `window.TARA_SHELL_DOC = 'next.html'`
- `sessionStorage['tara.shell'] = 'next.html'` (or 'index.html' when built with --out index.html)
- Theme (BRAND.md §10): `tara.v2.theme` 'light'|'dark' -> `<html data-theme="light|dark">`;
  'auto' or absent -> **no data-theme attribute** (tokens.css follows the OS).
  Also `<html data-theme-pref="auto|light|dark">` (the choice, for styling the lamp).

### window.APP
- `APP.v2now(iso?) -> { today, target, daysTo, isSaturday, justDone, phase }` (schedule week objects;
  target = the next Saturday, or today on a Saturday; justDone = the Saturday 1-6 days back)
- `APP.todayISO()` honours `?today=YYYY-MM-DD` (query before the hash); `APP.dateOverride()`
- `APP.viewHref(path) -> '#view/' + path`
- `APP.titleCaseSlug(slug)`, `APP.prettyDate(iso)` ("Sat 14 Nov"), `APP.dayMonth(iso)` ("14 Nov"),
  `APP.chapterKey(n)` -> 'found'|'interp'|'rl'|'evals'|'align'|'project'
- `APP.onBoot(fn)` — runs after the schedule loads, before the first route renders (awaited).
  `APP.booted` — Promise, resolves at the same point.
- `APP.TABS`, `APP.tabOf(sectionId)`; `<html data-tab="..." data-section="...">` on every route
- `APP.frames.onLoad(fn(iframe, doc, win))` — runs for every srcdoc frame load
- Router: V2 sections (today, weeks, practice, library, lab, view) get
  `route.params.rest` = decoded remainder after the first "/", **absent when empty**.
  `#today/week-NN` (also week-N, wN) -> `#weeks/N`.
- `APP.session`: `start(minutes, extra?)`, `end(quiet?)`, `state()` -> `{startedAt, minutes, week?, over}`|null,
  `elapsed()` -> minutes|null, `keepGoing()`. State in `localStorage['tara.v2.session']`, dropped
  once box + 60 min has passed. Window event `tara:session` `{state}`. `<html data-session>` while one runs.
- `APP.viewer`: `open(path)`, `close()`, `path()`, `route(href)`, `frame()`. Event `tara:view`.
- `APP.theme`: `get()` -> 'auto'|'light'|'dark', `resolved()`, `set(pref)`, `toggle()` (the lamp). Event `tara:theme`.
- `APP.focusSearch(q?)` (puts the caret in the right search field for the screen and shows results),
  `APP.searchAnchor(el)` (results drop under `el` where the panel floats, >= 720px).
- `<html data-search-open>` while the search panel is open; `data-search-keep` on an element keeps
  a click on it from closing the panel.
- History (V2): `APP.entry()` -> `{i, from, fromI, tab}` for the entry on screen; `APP.backTo(fallback,
  extra?)` steps back to where the entry was opened from (`history.go(-n)`; with no opener in this
  tab's history it replaces the entry with `fallback`); `APP.replaceHash(h)` moves the hash in place
  **keeping the entry's stamps** (use it instead of `history.replaceState(null, ...)`).
  Stamps in `history.state`: `v2i` (place in this tab's history), `v2from`/`v2fromI` (the route it
  was opened from: the last route of another section; a film opened from a film keeps the first
  one's), `v2tab` (the tab it lights: its own, except that a film, a pack, a demo or a Library door
  keeps the tab it was opened from).
- `APP.oops(err, retry, cls?, {line?, link?}?)` -> the brand's oops panel (`.fu-oops`, role=alert)
  with Try again (and an optional second way out). Offline (`APP.isOffline(err)`: navigator.onLine
  false, or a fetch-failed / HTTP 503 message) it says "offline, and this part was not saved yet.
  it will be after one visit online."; otherwise "that fumbled. nothing is lost; try again." and the
  error. A section whose mount fails shows it at its top (V2; V1 keeps its old line).
- Payloads (V2's `fetchPayload`): when a payload's file is missing or its name is stale (index.html
  was rebuilt, next.html was not), it re-reads the payload list from `window.__MANIFEST_DOC` once
  (`cache: 'no-store'`) and tries the fresh name once, before failing as before.

### Breakpoints (chrome)
- the brand's 720px: dock below (`.fu-tabbar.fu-only-phone`), the five tabs in the bar from it
  (`.fu-tabs.fu-only-desk`). 720-899 the bar is tightened and the 2D|3D pill shows only its 3D half.
- the bar's own search field from 1024px (an icon below that, which opens the panel with its own field);
  the pressed tier's name from 1024px; the wordmark from 1160px; every tier name from 1280px.
  Checked to fit (no overlap, no overflow) at every width from 320 to 1920.
- every target in the bar is 44 x 44 (the logo link, the tier digits, the 2D|3D halves, the tabs,
  the search field) from 354px up, without the bar growing (60px phone, 72px from 720): below 384px
  the gutters go to 12px and the gaps to 4px, below 375px to 10px / 2px; only below 354px do the
  tier digits (36px) and the logo (36px) narrow, never the height.
- a short screen (`max-height: 500px`, a phone on its side): the bar is 52px (its 50px tier and 2D|3D
  pills still fit inside), the frame bar 48px, and the dock one row of icon + label with 44px taps
  (47px with its rule; icons only below 560px wide, the labels kept for screen readers). 667x375
  with a session running: the page gets 230px (was 212). On its side (`and (orientation:
  landscape)`), on `#view/...` the bar and the dock are hidden (the viewer's 44px header stays).
  The session bar is the Today builder's (session.css has its own `max-height: 500px` row).

### Service worker (sw.js from tools/sw.tpl.js)
- precaches both shells (index.html + its css/js; next.html + shell/*, incl. brand-scoped.css and fonts),
  manifests, icons, the three hooks, and every file in `shared/` (tara-bar.js, tara-bar.css: the
  offline fallback; online they are still fetched network-first). Lab files are not listed one by
  one (lab/ is network-first by prefix), so lab/ui/bar.js needs nothing.
- three caches: `tara-shell-<version>` (the precache: both shells and their files, replaced on
  every deploy), `tara-assets` (the gz payloads, stable across deploys: a V2-only deploy keeps them),
  `tara-pages` (films, 3D pages, lab, shared: stable, so what was visited stays offline).
  Activate moves what older workers kept (`tara-assets-*` -> tara-assets, the page entries of older
  `tara-shell-*` -> tara-pages; an entry is copied only when the destination has none at least as
  new), deletes those caches, and never touches a cache with any other name. With V2's list
  (`/*@ASSET_FILES*/`, filled by build-shell.js) it then drops payload files no longer listed; V1's
  build leaves it `null` (no pruning).
- documents (navigations, the root, `*.html`): network-first, each cached under its **own** URL
  with the query dropped, saved only from a navigation (a script that fetches index.html never mixes
  versions). Offline a document gets its own copy; index.html and the root stand in for each other;
  an extensionless path tries its `.html` (and V1 only if that is not V2's); next.html never falls
  back to V1 or V1 to next.html; a page never saved gets a calm 503 "offline, and this page was not
  saved yet" page.
- network-first with a saved copy races the network against 3 s: the copy answers if the network is
  slower, and the network's answer is saved in the background when it comes.
- `shell/` hashed names cache-first; `shell/brand-scoped.css` network-first; `shared/`, `intuition/`,
  `objects/`, `lab/` network-first (tara-pages); `lab/model/*` and `lab/data/sae/*/sae.bin` passed
  through; V1's hashed assets cache-first (tara-assets); HEAD and other non-GET requests pass
  through.

## Decisions
- The dock and the toast are rows of the shell's flex column, not fixed: nothing can sit under the
  dock, so sections need no `.fu-tabbar-pad` (inside the shell it is reduced to the normal end
  padding). The toast gets its own slot just above the dock (the bottom edge >= 720px), open only
  while a toast shows: the section area is a little shorter for those seconds, nothing is covered,
  nothing moves, the dock stays tappable. Centred with margins (fu-pop-in animates transform).
- Today's Start is the brand's one big periwinkle `.fu-btn--big` (the contract says "red pill";
  BRAND.md v1.0 says the one big button is periwinkle and never red; the brand wins).
- The lamp has two states (on = light, off = dark); a pull that lands on what the OS shows goes
  back to following the OS, so auto/light/dark are all one chain away.
- Tier keys 1/2/3 stand aside while a quiz is on screen or has the focus (V2 only): anywhere inside
  `.tara-quiz`, on `#drill*` and `#practice/mixed*`, or whenever a `.tara-quiz` is visible. In srcdoc
  frames a digit typed inside a quiz is stopped at `<html>` (after the quiz used it, before the
  reading layer's own 1/2/3 handler on the frame's document). `#practice` and `#practice/recall`
  keep the tier keys (Recall's player reads letters, never digits).
- Cases (src/sections/cases.js): each case's TARA week comes from its `arena_section` (the payload's
  own `week` is ARENA's numbering): W0 [0.0] [0.1] · W1 [0.2]-[0.5] · W2 [1.1] · W3 [1.2] ·
  W4 [1.3]-[1.5] · W5 [2.1] [2.2.1] · W6 [2.2.2] [2.3]-[2.5] · W7 [3.1] [3.2] · W8 [3.3] ·
  W9 [3.4] [3.5] · W10 [4.1] [4.2] · W11 [4.3]-[4.5] (agrees with intuition/nodes/index.json).
  The cards are put in TARA's week order once, on load (stable: the payload's order inside a week);
  filters only dim. Chapters are TARA's (found, interp, rl, evals, align) with the schedule's names;
  rail, week chips, headings and a W<n> tag on each card carry TARA's dates. The "back to ..." link
  now sits in flow at the top of the card you jumped to (V1 floated it over the content).
- The old sections' V2 looks live at the end of their own css files (`.v2-shell ...`), so V1's
  look is untouched even if V1 is ever rebuilt from these sources.
- Today's capstone slot keys its wording off `APP.capstone.summary().next` (the capstone module
  knows the 6pm clock), so after 6pm on Sat 5 Dec it counts to the talk.
- Today labels paths' step kinds `ready` -> "ready for Saturday", `runway` -> "capstone runway"
  (same style as "film", "idea cards", "Lab mission", "Saturday checklist").
- Packs (src/sections/packs.js, V2 only): a deep link whose anchor no element has as its id
  (`#week-01/primer`, also week-02, -09, -10) lands on the first h2/h3 whose text holds the
  anchor's word(s), any case ("Saturday primer"). Anchors that exist win as before; V1 unchanged.
- V1's template `src/shell/index.tpl.html` is kept as-is for reference; V2's is `src/shell/next.tpl.html`.
- `APP.NAV` still lists every section (search groups render in its order):
  today, weeks, practice, drill, library, plan, packs, demos, map, cases, sprint, manual, view, lab.
  V2's search shows only groups with a match, and one line ("nothing matches ...") when none has.
- The viewer's X steps back in history to the opener (no new entry, so Back afterwards does not
  reopen the film and reload its WebGL). Pages in the frame that move themselves push entries into
  the same history (the Model Room's cards, a page's own #hash): the viewer counts them (history
  grew by exactly one) and steps back over them too; a move it cannot count (Back inside the frame,
  the 50-entry cap) makes X replace the entry instead, and a check 800ms after the step replaces it
  if Back still landed in the viewer. Opened with no opener (a deep link), X replaces it with the
  Library. Before a page is shown it is checked (HEAD; offline a GET through the worker): a page
  that is not there gets the oops panel ("that page is not here ...", Try again, Go to the Library),
  a page offline and never saved gets the offline line.
- Tabs: a film, a pack, a demo or a Library door keeps the tab it was opened from lit; each tab
  remembers its last own route (sessionStorage `tara.v2.tabroutes`; never the viewer, never a
  borrowed section), so Weeks taps back to the step. Tapping the lit tab from a film or a door it
  opened goes back to its last route (a step back in history when that is the opener); deeper in
  the tab, to its root; on its root, to the top.
- The Library doors (Map, Plan, Sprint, Manual) carry a back pill that says where they were opened
  from ("← Library", "← Weeks", "← Today") and steps back to it; from a deep link it goes to the
  Library. Packs and demos keep their "← All packs" / "← All demos" (that is their index).
- Pack quizzes (V2): a pack's check questions take 1-9 only once the learner chose them: a press
  inside the quiz, or a Tab into it (within 1s, in the frame or in the shell), arms it
  (`data-v2-armed`); a press anywhere else disarms it; a focus that lands in an unarmed quiz with no
  such gesture (the engine focuses its quiz on every render) is blurred. Digits never reach an
  unarmed quiz, so the tier keys work everywhere else (the gate runs as the pack's first script).
- Below 720px the cases HUD and the drill rail scroll with the page (they were sticky, a third of a
  phone); the cases "where this fits" diagram (17px chips at that width) is replaced by a list of
  44px buttons (same `data-go`, same handlers). Cases chips and arrows, drill sizes, the quiz's mode
  tabs and concept chips (in the drill), summaries and the frame bar's back pill are 44px tall.
- At >= 1280px the tier digit beside its name is `--muted` (6.3:1 light), not a faded `--ink-2`
  (3.9:1); hovered or pressed it takes the option's colour.
- 3D from a film in the viewer opens that film's own twin (objects.json `film`), from a concept film
  its concept's object (intuition/nodes/index.json), otherwise the Model Room; 3D again goes back to
  the film.
- The Library's Manual door is "Study agents · 6 agents · 7 commands" (it is the Claude Code
  study-agents manual); "Classic version" opens index.html in a new tab and says so (this tab stays;
  V1 there stays V1, since lab/hook.js hands over to next.html only from a film, 3D or Lab page).
- The plan in V2 (plan.js passes CSS into its frame; V1 untouched): its "What to do right now" card
  and its nav link are hidden (Today says what to do now), and below 720px its sticky header and
  section nav scroll with the page; `#plan/week-N` then lands the week's row 12px from the top.
- A failed load is not kept: cases (`load()`), the map's node list (an empty list), the drill's
  engine and banks are fetched again next time, so Try again works after coming back online.

## Requests
- bars: nothing needed from the shell side for the viewer protocol; my capture listener in the
  viewer document runs first and calls preventDefault + stopPropagation on links it routes
  (intuition/**, objects/** -> the viewer; shell documents -> the shell's hash; lab/ -> whole window).
- bars: `shell/brand-scoped.css` is ready (see Files).
- weeks (src/v2/weeks.js ~1058, the ideas deck's `go()`): `history.replaceState(null, '', '#' + want)`
  wipes the entry's v2 stamps (where it was opened from, its place, its tab). Please use
  `APP.replaceHash(want)` (it keeps them and updates the entry's route), or pass `history.state`
  instead of `null`.
- recall / practice: the quiz engine draws its mode tabs and concept chips 36px tall; the drill's
  are 44px via `.v2-shell .drill-root .tara-quiz-mode, .v2-shell .drill-root .tara-quiz-chip
  { min-height: 44px }` (drill.css). The same rule scoped to your roots would do it for Recall and
  Mixed.

## Known issues
- V1's own quiz/tier digit clash in `index.html` (#drill) is left as it is (V1 is frozen).
- Offline, a section whose payload was never opened online shows the oops panel's offline line
  (payloads are cached on first use, as the contract says; only the shells are precached).
- The test server for the worker suite ran on port 8773 (8772 was already serving the repo; that
  server was left alone).
- `index.html` (V1) in a tab that has opened next.html goes on to next.html (the V1 return shim in
  lab/hook.js, by design during the preview); a fresh tab opens V1 as before.

## Verification (last run)
Worker and learner-walkthrough rounds (scripts in the session scratchpad: `swv/` for the worker,
`rb/` and `review-learner/` for the walkthrough), against the final build:
- service worker, real workers in Chromium (test server on 8773): precache (every listed file, 200);
  a V2-only deploy keeps all 76 payloads and the visited films / 3D pages offline (V1 and V2 both
  load 76/76 offline; an unvisited film gets the calm 503 page); index.html and next.html never
  answer for each other, online or offline, by navigation or fetch (root, queries, classic.html,
  pretty URLs); the V1-only template (as build-site.js fills it) never prunes and never serves V1 for
  next.html; HEAD's deployed worker -> this one keeps 76 payloads and 14 pages and drops the old
  worker's mixed-up index.html copy; a slow network: the saved copy answers at ~3.0 s and the fresh
  one is saved in the background; V1 rebuilt with a renamed payload and next.html not: V2 re-reads
  the list once and loads the new name; activate trims only the renamed payload. `--check` passes
  on the tree and fails (with the fix) on a doctored manifest, a V1-only sw.js and the stale case.
- pack quiz digits (390x844 and 1280x800, light and dark): opening a pack, 1/2/3 are tier keys and
  nothing is recorded; a focus the engine gives an unarmed quiz is blurred; a press inside the quiz
  or a Tab into it arms it and the digit answers it (the tier stays); a press elsewhere disarms it.
  The walkthrough's t20d / t40 repros: no answer recorded, Recall stays empty.
- history (all four combos): Library -> Films -> X back to the Library with no new entry, Back then
  goes to Today; film -> film -> X; the Model Room moving itself (its own entry) -> X back to the
  Library, Back to Today; Map door "← Library" steps back; Plan from a Weeks step "← Weeks", back to
  the step; a film from a step keeps Weeks lit, X back to the step; tapping lit Weeks on that film
  steps back (no new entry); Weeks remembers the step from the Library; a deep-linked film's X
  replaces it with the Library. The walkthrough's t23 run: X and Back never reopen the viewer.
- below 720px the cases HUD and the drill rail are static (sticky from 720); cases chips, arrows,
  summaries, the fits buttons (a fits button opens its case), drill sizes / modes / chips / new
  draw and the frame back pill all 44px; the top bar's targets 44x44 and the bar 60 / 72px; the bar
  fits with every target >= 44 from 354px, swept 320-720 (2px steps), 720-1920 (4px) and short
  560-940 (4px): no overlap, no overflow, no horizontal scroll.
- tier digits at 1280, unpressed: 6.3:1 (light) and 7.7:1 (dark), was 3.9:1; hovered and pressed
  >= 4.5:1; no opacity.
- 3D: a film -> its own twin (deep-w12-steering -> o/d12-dial.html), 3D again -> the film; a concept
  film -> its concept's object; the films hub -> the Model Room.
- Library: "Study agents · 6 agents · 7 commands"; Classic opens index.html (V1) in a new tab, this
  tab stays on #library.
- errors: an unknown #view path -> the oops panel (not here, Try again, Go to the Library), no frame,
  no "open on its own"; offline, a demo and a never-visited film -> the offline line, under the
  frame bar; online again Try again loads them; the drill offline -> the line in its stage, Try again
  draws. Search: only groups with a match; "nothing matches ..." when none.
- plan (V2): the "right now" card and its nav link hidden; header and nav static below 720 (sticky
  above); #plan/week-10 opens the row 12px from the top on a phone.
- short screens (667x375, 568x320, 640x360, 740x360, 844x390, 932x430, 320x480, 480x320, both
  themes): bar 52, dock 47 (icon + label; icons only under 560px), every dock tab >= 44 and nothing
  clipped; 667x375 with a session: page 230px (was 212); a film on its side: no bar, no dock.
- V1: `git diff` of index.html, css/, js/, assets/, icons/, manifest.json, build-site.js and the
  frozen folders is empty. Two builds in a row: byte-identical next.html, sw.js and shell/*.

Earlier rounds:
- next.html at 390x844 and 1280x800, light and dark: #today, ?today=2026-11-14#today (Saturday
  mode), #weeks/10, #practice, #library, #lab, #drill, #cases, #map, #week-11, #plan/week-10,
  #view/intuition/index.html, #view/objects/index.html: zero page errors, no horizontal scroll,
  no failed same-origin requests (52 loads).
- the top bar fits (no overlap, no overflow) at every width from 320 to 1920.
- tier keys 1/2/3 and buttons; search (phone sheet, tablet window, desktop field, Library box
  anchored); a hit navigates and closes; back / back / forward; a film link in the map's node
  panel opens in the viewer, Back closes it (iframe destroyed); one viewer page at a time;
  3D from Today -> the week's bay, 3D again -> back; Start -> session bar "0 of 30 min", End;
  the lamp; tier keys stand aside in #drill, #practice/mixed and in a pack's quiz.
- capstone slot: ?today=2026-12-05 / -06 / -12 / -13 and the real clock at 5pm and 7pm on 5 Dec.
- service worker: installs, both shells precached, index.html stays V1 and next.html V2 after
  visiting both, no ?today= copies; offline: next.html (any route opened before), index.html and
  the site root (fresh tab: V1) all boot.
- V1 index.html #today, #drill, #week-11, #map: zero errors, unchanged look.
- two builds in a row: byte-identical next.html, sw.js and shell/*.
