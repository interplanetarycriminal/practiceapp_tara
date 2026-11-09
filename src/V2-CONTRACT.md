# TARA V2 — the shared contract

Six builders work on V2 at the same time in this one working tree. This file is the
contract between them. Read all of it before you write code. If something here is
ambiguous, decide, write the decision in your notes file (below), and keep going.

## Who it is for, and what V2 is for

One learner doing TARA Round 2 2026 part-time (14 Saturdays, the ARENA curriculum,
AI alignment research engineering). Not yet strong in ML, learns fastest from
interactive visuals they can poke, remembers where things sit on a page, and does
best with nothing that feels like a classroom or an exam. Passing needs 11 of 14
Saturdays plus a capstone talk on Sat 12 Dec 2026. Today is Mon 9 Nov 2026: week 9 (evals) was Sat 7 Nov,
week 10 (alignment science) is Sat 14 Nov, the project phase is W12–W14
(28 Nov, 5 Dec, 12 Dec), capstone results freeze Sat 5 Dec 6pm, talk Sat 12 Dec.

V2 reworks the whole UX so learning is as smooth and fast as possible:

1. **One Start button.** Today opens on the next Saturday with one button that picks
   up where they stopped, and a 10 / 30 / 60 minute choice that sizes the session.
2. **Each week is one path** (film, core idea cards each with a 1-minute film and 3D
   twin, demo or Lab mission, a few shuffled check questions, the Saturday checklist)
   instead of nine separate places. Library-call topics are marked skippable.
3. **Five tabs** instead of twelve: Today, Weeks, Practice, Library, Lab. Bottom tab
   bar on a phone, top tabs on desktop.
4. **One identity**: the fumbleupon brand system, v1.0 (see Brand below), everywhere.
5. **One Recall queue** (drill misses, shaky cards, saved sentences, on a
   1 → 3 → 7 → 16 → 35 → 75 day rhythm), 5 minutes at a time.
6. **A Capstone runway** counting down to the 5 Dec freeze and the 12 Dec talk.
7. **The same top bar** on the Films, 3D and Lab pages.
8. **Fixes**: one meaning of "this week" (the next Saturday; the last one shows as
   "just done"), Cases relabelled to TARA's week order, no stale rows, nothing floating
   over content on a phone.

**Everything that exists keeps working**: 13 packs, 13 demos, 28 films + 215 concept
films, 28 3D objects + 215 twins and the Model Room, the 215-node map, 104 cases,
1,183 drill questions, the sprint, the manual, the plan (with its any-week picker),
the Lab (with its live Qwen 3.5 9B picker), every old URL and hash route, offline
install, and every saved tick, tier and quiz record (same storage keys).

## How it ships

V1 stays at `index.html` untouched. V2 is built to **`next.html`** beside it (a preview
the learner tries on their phone). Later a one-line switch makes V2 `index.html` and
moves V1 to `classic.html`. Both share the same origin, so both read the same
localStorage. **Never modify** `index.html`, `css/`, `js/`, `assets/`, `icons/`,
`build-site.js`, `manifest.json`, `intuition/films/*.html`, `objects/o/*.html`,
`intuition/nodes/*.json`, `lab/model/`, `lab/data/`, `lab/bench/`, `lab/findings/`.

## Layout and owners

| Path | Owner |
| --- | --- |
| `src/brand/**` (BRAND.md, tokens.css, fonts.css, components.css, fonts/, img/, sheet.html) | **brand** |
| `src/shell/**`, `src/sections/**` (copies of V1's sources, now V2's to edit) | **shell** |
| `src/v2/chrome.*`, `viewer.*`, `session.*`, `today.*`, `library.*` | **shell** |
| `tools/build-shell.js`, `tools/sw.tpl.js`, `next.html`, `shell/**`, `sw.js` | **shell** |
| `intuition/hook.js`, `objects/hook.js`, `lab/hook.js` | **shell** |
| `tools/build-paths.js`, `data/paths.json`, `src/v2/weeks.*` | **paths** |
| `src/v2/recall.*`, `src/v2/practice.*` | **recall** |
| `src/v2/lab.*` (the Lab tab: Lab door, missions, Capstone runway) | **capstone** |
| `shared/**`, `intuition/engine.js`, `intuition/index.html`, `intuition/node.html`, `intuition/node-film.js`, `intuition/node-list.js`, `objects/kit.js`, `objects/kit.css`, `objects/index.html`, `objects/node.html`, `objects/node.js`, `lab/index.html`, `lab/lab.css`, `lab/ui/*.js` | **bars** |
| `src/V2-CONTRACT.md`, git, the PR | the orchestrator (not you) |

Rules for everyone:
- **Do not commit, push, stash, reset, checkout or rebase.** `git status` / `git diff` are fine.
- **Do not edit a file you do not own.** Need a change there? Write it under "Requests" in
  your notes file, work around it, and say so in your final report.
- Keep a notes file at `src/notes/<your-name>.md`: status, decisions, the interfaces you
  expose, requests, known issues. Update it as you go; read the others' when you need
  their interface.
- No new runtime dependencies, no CDNs, no web fonts from Google (the sandbox blocks
  them and the app must work offline). Fonts come from `src/brand/fonts/`.

## Build

`node tools/build-shell.js` (shell writes it first, early) produces:

- `next.html` (pass `--out index.html` only at the switch).
- `shell/app.<hash>.css`: in order `src/brand/fonts.css`, `src/brand/tokens.css`,
  `src/brand/components.css`, `src/shell/shell.css`, `src/sections/frames.css`,
  `src/sections/cases.css`, `src/sections/drill.css`, then `src/v2/*.css` in the order
  chrome, viewer, session, today, weeks, recall, practice, library, lab, then any other
  `src/v2/*.css` alphabetically. Missing files are skipped with a warning.
- `shell/app.<hash>.js`: each module in its own IIFE, in order `src/shell/shell.js`,
  `src/shell/search.js`, `src/shell/review.js`, `src/sections/{packs,demos,plan,sprint,
  manual,map,cases,drill}.js`, then `src/v2/*.js` in the order chrome, viewer, session,
  today, weeks, recall, practice, library, lab, then the rest alphabetically. V1's
  `src/shell/today.js` is **not** bundled (V2's today replaces it), so the helpers it
  defined that other sections use (`APP.titleCaseSlug`, `APP.prettyDate`) move into V2.
- `shell/paths.<hash>.json` copied from `data/paths.json`; `next.html` carries
  `window.__PATHS_URL = "shell/paths.<hash>.json"`.
- `shell/fonts/*` and `shell/img/*` copied from `src/brand/fonts/` and `src/brand/img/`
  (the CSS refers to them relatively, so `src/brand/fonts.css` uses `fonts/<file>`
  and the build rewrites to the right path).
- `window.__MANIFEST` (the 76 payloads) read from V1's `index.html` (or `classic.html`
  after the switch).
- `sw.js` from `tools/sw.tpl.js`, precaching V1 (index.html and the css/js it names)
  **and** V2 (next.html and `shell/*`), caching each navigation under its **own** URL
  (V1's worker caches every navigation as index.html, which would cross the two
  shells), `shell/` cache-first (hashed), `shared/` network-first, and keeping V1's
  rules for `intuition/`, `objects/`, `lab/` (network-first) and the lab model / SAE
  passthroughs.

Payloads: `APP.payload(key)` / `APP.payloadJSON(key)` fetch and gunzip `assets/*.gz`.
Keys: `schedule`, `calendar`, `plan`, `tier:plan`, `pack:<slug>`, `tier:<slug>`,
`demo:<slug>`, `bank:<slug>`, `map`, `cases`, `concepts-index`, `sprint`, `manual`,
`layer`, `engine`. Pack and bank slugs are **content ids** (`week-01` … `week-11`,
`alignment-science`, `capstone-weeks-12-14`), not TARA week numbers; the `schedule`
payload's `weeks[]` (`n`, `saturday`, `chapter`, `arena`, `packSlug`, `packSlugs`,
`packAnchors`, `demoSlugs`) says which pack serves which TARA week.

## Routes

Every V1 route keeps working: `#plan`, `#plan/week-N`, `#packs`, `#week-NN[/anchor]`,
`#<pack-slug>[/anchor]`, `#demos`, `#demo/<slug>`, `#demo-week-NN`, `#drill`,
`#drill/<slug>[/<concept>]`, `#cases`, `#cases/<id>`, `#map`, `#map/node=<id>`,
`#map/q=<text>`, `#sprint`, `#sprint/day-N`, `#manual`, `#search/<q>`, and the legacy
`#node=`, `#q=`, `#day-N`, bare-token forms. New in V2:

| Route | Section id | Owner |
| --- | --- | --- |
| `#today` | today | shell |
| `#today/week-NN` (legacy) | redirects to `#weeks/N` | shell |
| `#weeks`, `#weeks/N`, `#weeks/N/<step>[/<i>]` | weeks | paths |
| `#practice`, `#practice/<rest>` | practice | recall |
| `#library` | library | shell |
| `#lab`, `#lab/<rest>` | lab | capstone |
| `#view/<site-relative path>` e.g. `#view/intuition/films/w10-em.html`, `#view/objects/node.html?id=lora` | viewer | shell |

For V2 sections the router sets `route.section` and `route.params.rest` (the decoded
remainder after the first `/`); the section parses `rest` itself. Tabs: Today = today;
Weeks = weeks; Practice = practice, drill; Library = library, plan, packs, demos, map,
cases, sprint, manual, view; Lab = lab.

**The viewer**: films, concept films, the Model Room and 3D objects open inside the
shell (an iframe below the top bar), so the chrome, the session timer and Back keep
working. Link them as `#view/<path>` (helper `APP.viewHref(path)`). Links inside a
viewed page that point back at the shell (`../index.html#x`, `../../index.html#x`)
are routed to `#x` in the shell. **The Lab (`lab/index.html`) is never put in the
viewer**: it needs its own window for the local Qwen server; link it directly.

## Shared APIs (all optional at runtime: always feature-test, never crash if absent)

```js
// shell
APP.v2now(iso?) -> { today, target, daysTo, isSaturday, justDone, phase }
//   target: the schedule week whose Saturday is today or the next one (W10 on 9 Nov)
//   justDone: the week whose Saturday was 1-6 days ago (W9 on 9 Nov), else null
//   phase: 'before' | 'course' | 'project' (W12-14) | 'after'
//   ?today=YYYY-MM-DD in the page URL overrides the date everywhere (APP.todayISO()).
APP.viewHref(path) -> '#view/' + path
APP.session.start(minutes) / .end() / .state() -> {startedAt, minutes} | null
APP.titleCaseSlug(slug), APP.prettyDate(iso)        // kept from V1
// existing, unchanged: APP.payload, APP.payloadJSON, APP.schedule, APP.today, APP.weekByN,
// APP.packHash, APP.weeksOfPack, APP.navigate, APP.onRoute, APP.tier, APP.setTier,
// APP.onTierChange, APP.registerSection, APP.frames, APP.review, APP.toast, APP.el, APP.esc

// paths
APP.paths.ready -> Promise                     // resolves when paths.json is loaded
APP.paths.week(n) -> { n, saturday, chapter, title, steps: [Step], missions: [...] }
//   Step = { id, kind, title, sub, minutes, hash, state: 'todo'|'doing'|'done' }
APP.paths.next(n) -> Step | null               // where to resume (hash may point inside a step)
APP.paths.progress(n) -> { done, total }
APP.paths.plan(n, minutes) -> [Step]           // what fits in a 10/30/60 minute box
// window event 'tara:path' whenever progress changes

// recall
APP.recall.add({ kind: 'concept'|'question'|'sentence', id, week, title, text, hash, concept })
APP.recall.dueCount(iso?) -> number
APP.recall.due(iso?) -> [Item]
APP.recall.grade(id, 'solid'|'shaky'|'blank')
// window event 'tara:recall' whenever it changes. Until it exists, fall back to APP.review.add.

// capstone
APP.capstone.summary() -> { freeze: '2026-12-05', talk: '2026-12-12', daysToFreeze,
                            daysToTalk, next: { title, date, hash } }
```

Register sections with `APP.registerSection({ id, title, mount(el, route), unmount?(el),
onTier?(n) })`. A section renders into its own container, never outside it.

## Storage keys

Existing, never renamed or destroyed: `tara.tier` (canonical) + `tara.resolution`
(alias; write both, values "1"/"2"/"3"); `tara.fourteen.v1` (plan ticks
`w<N>p<k>`, `w<N>e<k>`, with `__order: "tara"`); `tara.review` (saved sentences, see
`src/shell/review.js`); the drill's keys (see `src/sections/drill.js`);
`tara.objects.*`, `tara.lab.*`, `tara.dim.back`. New: `tara.v2.path` (paths),
`tara.v2.recall` (recall), `tara.v2.box` and `tara.v2.session` and `tara.v2.theme`
(shell), `tara.v2.capstone` (capstone). Wrap every storage call in try/catch.

## Brand: fumbleupon v1.0

The learner asked for **the fumbleupon brand system, latest version, as the one visual
identity**. The **brand** builder distils it into `src/brand/` and writes
`src/brand/READY` when the tokens and components are usable (early), then refines.
Until READY exists, build structure and logic and use only the token names below.
After it exists, read `src/brand/BRAND.md` and style with its tokens and `fu-*`
component classes; do not invent a parallel look.

Token names (values are the brand builder's call; light and dark):
`--paper --paper-2 --card --ink --ink-2 --muted --line --line-soft --shadow-hard
--accent --accent-ink --signal --signal-ink --sky --mint --butter --blush --lilac --sea
--trail-1 … --trail-6 --good --good-bg --warn --warn-bg --bad --bad-bg
--ch-found --ch-interp --ch-rl --ch-evals --ch-align --ch-project
--font-ui --font-voice --font-label --font-mono --r-btn --r-card --r-pill --lw
--spring --t-press --t-lift --t-enter --tap --s1 … --s6`.
Chapter tints by TARA week: found W0–1, interp W2–4, rl W5–6, evals W7–9,
align W10–11, project W12–14.

## Rules that hold everywhere

- **Phone first.** 390 px wide is the main screen; 16 px side gutters, tap targets at
  least 44 px, no horizontal page scroll, and **nothing fixed or floating over content**
  (content gets bottom padding for the tab bar and safe area).
- **No-reorder.** Tier changes, progress and state never move cards: fixed slots, swap
  text in place, show "done" states instead of removing a card. The learner navigates
  by remembered position.
- **Tiers.** Plain / Generalist / Expert, always that order and those names, keys
  1/2/3 (not inside inputs), `tara.tier` + `tara.resolution`. Sections with tiered text
  implement `onTier(n)`. `src/sections/packs.js`' tier scroll anchoring must keep its
  property (≤ 0.5 px drift; 0 px on a 2→3→1→2 round trip).
- **Zero friction.** Open into the interesting part. At most two short lines before an
  action. No exam feel: no percentages, scores or red crosses as judgement; say "got it"
  / "shaky" / "to revisit". Quizzes shuffle questions and options.
- **Teaching voice.** Plain, warm, concrete; what / when / why before how; name career-
  long library calls as low utility. UI microcopy follows the brand's voice (calm, kind,
  a little dry). Do not rewrite teaching content inside packs, demos, films or nodes.
- **Accessible.** Real buttons and links, visible focus, aria labels on icon buttons,
  `prefers-reduced-motion` respected, text contrast 4.5:1.
- **Offline.** Everything V2 needs is precached or cached on first use.
- **No private data** in the site (it is public on GitHub Pages): no names of other
  people, no emails, no capstone idea text beyond what is already in the repo.

## Verify before you report

Serve the repo root with `python3 -m http.server <your port>` (brand 8771, shell 8772,
paths 8773, recall 8774, capstone 8775, bars 8776). Playwright is preinstalled
(`require('playwright')`, `chromium.launch()`, never `playwright install`). Abort
requests to fonts.googleapis.com, fonts.gstatic.com, cdn.jsdelivr.net and
cdnjs.cloudflare.com (the sandbox blocks them). Check 390×844 and 1280×800, light and
dark (`colorScheme`), with zero page errors, and look at your screenshots. Open at most
one WebGL page (Model Room, 3D objects) at a time; a false "3D not ready" means retry.
Save screenshots under
`/tmp/claude-0/-home-user-practiceapp-tara/38da0dcc-b12c-5580-9901-1c3afc9cc69b/scratchpad/v2shots/<your-name>/`,
never in the repo. Your final report: what you built, files touched, how you verified
(with screenshot paths), interfaces, open issues and requests.
