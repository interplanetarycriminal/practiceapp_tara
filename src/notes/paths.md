# paths — notes

Owner of `tools/build-paths.js`, `data/paths.json`, `src/v2/weeks.js`, `src/v2/weeks.css`, this file.

## Status
- [x] `tools/build-paths.js` → `data/paths.json` (332.4 KB, deterministic, no dependencies,
      reads repo files only; `--check` builds in memory and prints coverage, writing nothing)
- [x] `src/v2/weeks.js` + `weeks.css`: `#weeks`, `#weeks/N`, `#weeks/N/<step>[/<i>]`, `APP.paths`
- [x] Brand pass (tokens and fu-* classes only; every selector scoped to `.wk-sec` / `wk-*`)
- [x] Verified in next.html with Playwright: 390x844 and 1280x800, light and dark, zero page
      errors, no horizontal overflow. Shots: scratchpad `v2shots/paths/*.png`; the learner-walkthrough
      fixes in `v2shots/review-learner/2*-5*.png`.

## Build
```
node tools/build-paths.js          # writes data/paths.json and prints coverage per week
node tools/build-paths.js --check  # build in memory, print coverage, write nothing
node tools/build-shell.js          # copies it to shell/paths.<hash>.json
```
Inputs: the payloads in `assets/` (schedule, plan, packs, banks, demos, concepts-index, map),
`intuition/films.json`, `intuition/nodes/*.json`, `objects/objects.json`, `objects/index.html`
(bay table), `lab/ui/missions.js`. Text keeps only b i em strong code.

## The path (per TARA week, W0–W14), steps in this fixed order
| step | what | done when |
| --- | --- | --- |
| watch | the week's film (deep dives and related films as extras), opens `#view/intuition/films/<file>` | a film opened (here or anywhere: `tara:view`) |
| ideas | core + contested cards in map order, one at a time; library calls and background collapsed below | every core card marked got it / shaky |
| play | demos `#demo/<slug>`, 3D `#view/objects/o/<file>`, Lab missions linked directly (never in the viewer) | one item opened |
| do | the plan's pre + ex items as checkboxes (keys `w<N>p<k>` / `w<N>e<k>`), the pack at this week's part, skip line, exercise helpers; W12–14 the capstone pack parts | every tick is on (the same ticks as `#plan` and the Lab, so the three agree) |
| check | six questions inline from this week's pool, shuffled | a round finished |
| ready | the Saturday checkpoint, three things to have solid / say out loud, pack anchors, `#plan/week-N` | opened |
| runway (W12–14) | days to the freeze, `APP.capstone.summary().next`, opens `#lab` | opened |
Every step screen has one big "Next: <step>" button and a quiet "back to the path". Next marks the step
done, except the checklist: only its ticks do (Next there just moves on; `APP.paths.mark(n,'do')` is a
no-op, and an old stored `d.do` is ignored).

## Coverage (`node tools/build-paths.js`)
| week | ideas (core) | library | films | 3D | demos | missions | ticks | check six/pool |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W0 | 5 | 1 | 1+2 | 3 | 1 | 1 | 3p+4e | 6/78 |
| W1 | 15 | 5 | 3+3 | 6 | 2 | 2 | 3p+5e | 6/235 |
| W2 | 13 | 4 | 2+2 | 2 | 3 | 3 | 3p+5e | 6/85 |
| W3 | 13 | 3 | 2+2 | 4 | 2 | 4 | 4p+6e | 6/117 |
| W4 | 23 | 1 (+14 background) | 1+2 | 3 | 2 | 4 | 4p+7e | 6/144 |
| W5 | 17 | 0 | 1+1 | 2 | 1 | 2 | 3p+5e | 6/55 |
| W6 | 20 | 0 | 1+1 | 2 | 2 | 2 | 6p+5e | 6/86 |
| W7 | 5 | 1 | 1+1 | 1 | 1 | 2 | 4p+6e | 6/34 |
| W8 | 0 | 3 | 1+1 | 1 | 1 | 2 | 3p+6e | 6/21 |
| W9 | 11 | 0 | 1+1 | 1 | 1 | 1 | 3p+6e | 6/21 |
| W10 | 8 (1 contested) | 0 | 1+1 | 1 | 1 | 2 | 4p+6e | 6/23 |
| W11 | 10 (4 contested) | 0 | 1+1 | 2 | 1 | 2 | 3p+5e | 6/34 |
| W12 | 3 | 0 | 1 | 1 | 0 | 2 | 4p+4e | 6/71 |
| W13 | 1 (capstone, again from W12) | 0 | 1 | 1 | 0 | 1 | 2p+4e | 6/26 |
| W14 | 1 (talk, again from W12) | 0 | 1 | 1 | 0 | 1 | 3p+4e | 6/33 |
All 215 map nodes, 28 films, 28 objects and 31 missions are placed. Every first six is five
multiple-choice questions and one ordering (W8: one number). The check pools leave out 40 trivia
questions; the build prints them by reason (a number to recall 20, a setting to recall 4, schedule or
logistics 15, a list order to recall 1) and stops if any first six holds two non-MCQ questions.

## Interfaces (window.APP.paths, defined when the bundle runs; data arrives with `ready`)
```js
APP.paths.ready -> Promise<boolean>            // never rejects; false if paths.json failed
APP.paths.week(n) -> { n, saturday, chapter, title, short, tint, arena, sections, online, risk,
                       steps: [Step], missions: [{ id, title, why, href, tool, steps }] } | null
//   Step = { id, kind, title, sub, minutes, hash, state: 'todo'|'doing'|'done' }
//   id: watch | ideas | play | do | check | ready | runway
//   kind (for Today's labels): film | ideas | demo|mission | checklist | check | ready | runway
APP.paths.next(n) -> Step | null               // where the learner stopped if that step is open,
                                               // else the first open step; ideas -> '#weeks/N/ideas/<card>'
APP.paths.progress(n) -> { done, total }       // steps
APP.paths.plan(n, minutes) -> [Step]           // resume step first (cut to the box, `partial: true`),
                                               // then open steps in path order while they fit; [] when all done
APP.paths.card(id, week?) -> { id, label, title, week, need, plain, tiers: {1,2,3} (plain strings),
                               film, object, hash } | null     // for Recall's concept cards
APP.paths.data(), APP.paths.weeks(), APP.paths.mark(n, step), APP.paths.reload()   // extras
// window 'tara:path' { week, step, progress } on every change (also when paths.json lands)
// listens: 'storage' (tara.v2.path, tara.fourteen.v1), 'tara:ticks' (the Lab tab), 'tara:view' (viewer)
```
Section `weeks`: `mount`, `unmount`, `onTier`, `search` (weeks and idea cards by name).

## Storage
- `tara.v2.path` = `{ v:1, w: { "<n>": { d:{step:ts} done, o:{step:ts} opened, f:{film:ts},
  c:{node:'got'|'shaky'}, p:{'demo:x'|'obj:x'|'mis:x':ts}, k:{ r: rounds, a:[asked ids] } } },
  last: { n, step, i, at } }`. Re-read before every write.
- `tara.fourteen.v1`: the same rules as the Lab tab: re-read before every write, written only when
  `__order === "tara"` or the store is empty (then `{__order:"tara"}`, which is what the plan's own
  first run writes); an older store is left alone and the checklist shows a note + toast with a link
  to `#plan/week-N` (opening the plan migrates it). After a write: `APP.frames.drop('plan')` and
  window `tara:ticks` `{ key, on, source: 'weeks' }`.
- Recall: "Shaky" on a card → `APP.recall.add({ kind:'concept', id, concept, week, title, text, hash })`;
  a missed check question → `APP.recall.add({ kind:'question', id, bank, concept, week, title, text,
  hash:'#drill/<slug>' })`; both fall back to `APP.review.add` when Recall is absent.

## Decisions
- An idea card holds what you grade on and the grade row: label and badges, the title, the plain
  line (every tier), Got it / Shaky, then the doors (Film, 3D, Case, Map). The tier layers sit under
  the card, not in it: Plain = "Picture it" (the allegory); Generalist = what / when / why; Expert =
  what + "where the field stands" (contested cards) + "where else it shows up" + the ARENA section.
  Tiers replace, never stack; the three layers share one grid cell (inactive ones
  `visibility:hidden`) with no box of its own, so a tier change moves nothing and a short tier ends
  in page space, not in an empty card. Measured on every card of every week (145) in all three
  tiers at 390x844 with the section at the top: the grade row is always in view (at least 92 px to
  spare with the session bar showing, 147 px without) and nothing moves on a tier change.
- In-deck moves (swipe, ← →, prev/next, auto-advance after a grade) update the hash with
  `history.replaceState` and patch `APP._route` the way viewer.js does, so the shell does not re-mount
  or restore a stale scroll; a reload lands on the same card.
- Check pools hold no trivia (the standing rule: conceptual first, no code-constant or schedule
  trivia). `trivia()` in the build leaves out a numeric question in recall mode (STEERING_LAYER's
  24, R1_3_3_3's nine adapters, the talk's ten minutes), a number whose unit is a remembered setting
  (layer index, index offset, a threshold score, a fraction of depth, a paper's solve rate),
  schedule and logistics arithmetic (minutes, hours, days, a clock hour, rehearsals, slides, words,
  questions to prepare, dollars), any question asking for a setting's value ("by default", "set to
  what"), options or ordering items that are dates and times, "as the playbook lists them", and by
  id the pass condition (cap00-q004).
- Check draw: at most one question in any six is not multiple choice. The build's first six is five
  MCQs (easy first, distinct concepts) plus one ordering, else one number; later rounds take the pool
  minus what was asked (reset when exhausted), distinct concepts first, with the same one-in-six cap
  at runtime. A random stem variant; options and ordering items shuffled. Ordering is "tap in
  order": items keep their places and get numbers; Clear is a full 44 px button. Answers by tap or
  A–H (uppercase, as Recall now shows); 1/2/3 stay the tier keys. Numeric uses the quiz engine's
  parse and the question's tolerance.
- Check copy: after a miss "almost. the answer was B; it comes back tomorrow." A number is said with
  its unit only when the unit reads as a count ("22,500 elements", "1 token", "10×", "42%"); a
  setting's label stays on the input ("the answer was 24", not "24 layer index"). The progress dots
  say only answered / here, never got or missed. The round's end has no tally: "Five cards went to
  Recall; they come back tomorrow." or "Nothing went to Recall this round."
- 244 of the 943 MCQ explanations name options by their bank letter ("Option (c) is tempting").
  The check shows options shuffled under positional letters, so `relabel()` points "Option(s) x"
  and a free-standing "(x)" at the letters on screen (never `f(a)` or `T(s,a)`).
- `do` is titled "Prep and exercises" (W12–14: "Do on the day") so Today's "Saturday checklist ·
  25 min · <title>" does not say the same thing twice.
- W12/W13 shared the short title "Project": the build takes the plan title's part after the dash
  ("Get a number on the board", "Scope freeze").
- First route waits up to 1.5 s for paths.json (`APP.onBoot`), so Today paints once with data.

## Requests
- **shell (packs.js `__appScrollTo`)**: the Saturday primer in packs week-01, week-02, week-09 and
  week-10 has no id, so `#week-01/primer` opens the pack at the top. A heading-text fallback (an
  `<h2>`/`<h3>` whose text starts "Saturday primer") would land it. `found:false` marks these in
  paths.json.
- **shell (today.js `KIND`)**, optional: `ready: 'ready for Saturday'`, `runway: 'capstone runway'`
  (today it shows the raw kind "ready" / "runway").

- **recall (FYI)**: the Recall player shuffles options under letters a–h and shows the bank's
  explanation, which names options by their original letter in 244 MCQs; `relabel()` in
  `src/v2/weeks.js` (about 8 lines) does the remap if you want it.

## Known issues
- Under a short tier (Plain most of all) the room the longest tier needs stays as page space below
  the layer, before the deck's hint line and Next (below the fold on a phone): the cost of "a tier
  change never moves anything". The card itself never has blank space.
- A check question's stem variant is chosen at random, so the same id can read differently between
  rounds (as the drill does).

## Orchestrator changes after hand-back
- 2026-11-09: the ideas deck's in-place hash update uses APP.replaceHash(want) (falls back to
  replaceState(history.state, ...)) so the shell's per-entry stamps (viewer back, tab memory) survive.
