# recall notes

Owner of `src/v2/recall.js`, `src/v2/recall.css`, `src/v2/practice.js`, `src/v2/practice.css`, this file.

## Status
- [x] `APP.recall`: store, ladder, import + sync from V1, `tara:recall` events
- [x] Recall player: question / concept / sentence cards, keys, end screens, warm-up
- [x] `#practice` (Recall card, the drill's week banks in TARA-week slots, mixed),
      `#practice/recall`, `#practice/warm`, `#practice/mixed`
- [x] Brand pass (tokens and fu-* classes only; every selector scoped to `.rc-*` / `.pr-*`)
- [x] Verified in next.html with Playwright: 93 checks pass, 0 page errors
      (390x844 and 1280x800, light and dark). Shots: scratchpad `v2shots/recall/*.png`.

## What it does
One spaced-repetition queue, store `tara.v2.recall`
(`{ v:1, items:{}, cursor:{ review, drill, drillInit, concepts:{} }, log:[[iso,id,grade]] }`,
log capped at 400). Item ids: `q:<qid>`, `c:<concept id>`, `s:<V1 ts>`. Every storage read
and write is in try/catch; with storage blocked it runs from memory.

Ladder (days): **1 → 3 → 7 → 16 → 35 → 75**.
- `solid` ("Got it"): up one rung, due after the new rung's interval (tops out at 75).
- `shaky`: holds the rung, due after the same interval again (at least tomorrow).
- `blank`: back to the 1-day rung (counts a lapse).
- New items start on the 1-day rung: due tomorrow, never the day they are added.
- `add()` of an item already there = "came up shaky again": back to rung 1, due no later than
  tomorrow, and a let-go item comes back.
- A session is the 7 most overdue (`SESSION_MAX`), shuffled; "Five more minutes" takes the next 7.
- Minutes estimate: question 45 s, concept 40 s, sentence 20 s.

## Import rules (V1 keys are read, never written or deleted)
Runs on every load (`APP.onBoot`), again on `storage` events for `tara.review` /
`tara-quiz-mastery-v1`, on `tara:review`, on a missed `tara:quiz-answered`, and when the tab
becomes visible. Cursors make every re-import take only what is new.
- **Saved sentences** (`tara.review`, `{text,title,url,tier,ts}`): cursor = newest `ts`.
  Deduped on normalised text. Source link: a shell URL keeps its `#hash`; another site page
  becomes `#view/<path>`; a Lab page is linked directly; frames (`url: about:srcdoc`) are
  matched by page title to `#week-NN` / `#demo/<slug>`. Week read off that link. A line
  deleted in V1 is marked `gone` here (kept, hidden) unless V1's 300-line cap could have
  trimmed it.
- **Missed questions** (`tara-quiz-mastery-v1`): first run takes every question whose latest
  answer was a miss (`wrong > 0 && streak === 0`); later runs take anything with
  `lastWrong` after the cursor. A question already queued and missed again goes back to rung 1.
  Bank from the id prefix (`w01..w11` → `week-01..week-11`, `ch4` → `alignment-science`,
  `cap*` → `capstone-weeks-12-14`); week from the bank's TARA weeks (cap12/13/14 exact).
- **Shaky concepts**: the drill's "what's shaky" (misses / answers per concept over every
  bank touched, top 6). Only intuition-map nodes (`intuition/nodes/index.json`) become
  concept items; the rest already live on as their questions. Questions also get their
  `concept` filled from the bank. Cursor: concept id → day added.
- **Spreading**: an import batch never lands before its natural day (event day + 1) and puts
  at most 7 on any one day, freshest first, so a big first import is a few calm days, not 40
  due at once.

## Cards
- **question**: the real question from `APP.payloadJSON('bank:<slug>')`, options reshuffled
  (shown A–H like the week check, either key case works, never digits), multi-select and
  ordering supported, numeric answers checked. Explanations that name options by bank letter
  are relabelled to the capitals on screen (`relabel()`, `C.map`).
  Auto-checked, then the bank's explanation; the suggested grade is "Got it" when right and
  "Shaky" when wrong; the learner always picks. Free-text items reveal and self-grade.
  Doors: "▶ 1-minute film" when its concept is a map node, and "Drill <concept>" →
  `#drill/<slug>/<concept>`.
- **concept**: "say it in one line: <label>", hint = the node's allegory title, reveal = plain
  line + one short thought per tier: Plain "picture it" (allegory), Generalist "when to use it"
  (hamming.when), Expert "why it matters" (hamming.why); "what" only as a fallback, since it
  restates the plain line. The three sit in one grid cell (`.rc-tiers`, inactive ones
  `visibility: hidden` + `aria-hidden`), so the card is as tall as its longest tier and a tier
  change moves nothing. `APP.paths.card` gives the plain line, and tier text only when the node
  file has none (its strings are the whole week-path card, too long for one phone screen).
  Doors "▶ 1-minute film" → `#view/intuition/node.html?id=<id>` and the card / drill.
- **sentence**: the saved line, "still clear?", "Open where it came from", "Let it go".
- Keys: space shows / checks, letters pick, enter takes the suggestion, G / S / B grade (either
  case). Digits are left to the tier control. Key hints (capitals, per question type) only at
  ≥720 px with a fine pointer. Focus after a reveal goes to the answer, never onto a grade button.
- After a reveal the grades are scrolled into the section's own scroll box (the V2 shell scrolls
  `.app-sec`, with the dock and the toast row outside it). Measured at 390x844: label, answer,
  tier text and grades on one screen for the longest nodes; 0 px movement on 2→1→3→2 with the
  shell's tier toast up and gone, also when revealed while a toast shows (the session view keeps
  `--tap + --s4` of room under the grades so the toast row leaving never clamps the scroll).

## Decisions
- UI words: "Got it" / "Shaky" / "Blank" (the brief's); each grade shows when it comes back.
- Empty copy: "nothing due. every bench starts like this." when items exist but none are
  due; "nothing to recall yet. misses and shaky cards land here." for an empty store (the
  same line Today uses). No scores, percentages or streaks anywhere.
- "Warm up anyway" (`#practice/warm`): 5 cards, up to 3 queued items from the last 5 TARA
  weeks, the rest fresh questions from those weeks' banks (unseen and missed weighted up).
  Fresh ones join the queue only when graded shaky or blank.
- Mixed (`#practice/mixed`): the V1 quiz engine over the merged banks of the last 5 weeks,
  mounted with `week: ''` so it writes no `tara.quiz.<slug>` key (mastery still updates,
  and misses flow back into Recall). Size from the drill's prefs (8 / 12 / 20, default 12).
- Week tiles: 13 banks placed by their first TARA week (`week-11` → W7–9), marks "this week"
  (`APP.v2now().target`) and "just done" (`justDone`); each opens `#drill/<slug>`.
- A session in progress survives leaving `#practice` and coming back.
- Lab links open in this window, never the viewer (matches lab.js).

## Interfaces (APP.recall; all feature-test safe)
```js
APP.recall.add({ kind: 'concept'|'question'|'sentence', id, week, title, text, hash, concept, bank?, label? }) -> Item
//   kind aliases: check|miss -> question, idea|card -> concept, line|review -> sentence
//   concept: id defaults to `concept`; sentence: id defaults to a hash of `text`
APP.recall.dueCount(iso?) -> number
APP.recall.due(iso?) -> [Item]              // most overdue first
APP.recall.grade(id, 'solid'|'shaky'|'blank') -> Item | null   // id raw or prefixed
APP.recall.get(id) / .list() / .letGo(id) / .restore(id)
APP.recall.preview(id, g) -> { days, date, word }               // where grade g would put it
APP.recall.next(iso?) -> { date, count, when } | null           // the next day something is due
APP.recall.summary(iso?) -> { today, due, session, minutes, byKind, total, next }
APP.recall.minutes(items?) -> number
APP.recall.mountSession(el, { warm?, size?, onDone?, onExit?, onRestart? }) -> { destroy, state, el }
APP.recall.ready -> Promise                 // after the first sync, concepts included
APP.recall.sync() -> Promise
APP.recall.RUNGS, APP.recall.SESSION_MAX
// Item = { id, ref, kind, src, added, due, rung, reps, lapses, last?, grade?, title?, text?,
//          hash?, concept?, bank?, week?, label?, url?, ts?, off?, gone? }
// window 'tara:recall' (one per tick) on every change, detail { due, total }
```

## Requests
- **paths**: when a week path finds a shaky card or a missed check, call
  `APP.recall.add({ kind: 'concept', id: <node id>, week: N, title, hash: '#weeks/N/ideas/<i>' })`
  or `APP.recall.add({ kind: 'question', id: <qid>, week: N })`. (Done on their side, and
  `APP.paths.card` exists: Recall uses its plain line and falls back to its tier text.)
- **shell / drill**: the V1 quiz engine answers on digits 1–9, which are also the tier keys,
  in `#drill/*` and in my mixed view (mounted through the engine). Worth one owner deciding
  which wins there; Recall itself never uses digits.
- **shell**: on a phone the tier toast sat over the dock once in a shot (`#practice/recall`).
- **brand**: the default `.fu-badge` keeps light ink on gold in dark mode (low contrast); I use
  `fu-badge--gold` instead.

## Known issues
- A shorter tier leaves blank space under it (the card keeps its longest tier's height): the
  cost of a tier change never moving anything, as in the week path's ideas deck.
- A warm-up's fresh questions need their bank payloads; offline before the payload is cached,
  the warm-up falls back to whatever is queued.
- Sentences saved inside a frame before V1 stored a real URL are matched by page title; a
  title that is not in the table gets no source link (the text still shows).

## Orchestrator changes after hand-back
- 2026-11-09: MCQ explanations are relabelled to the on-screen letters (relabel() copied from weeks.js;
  askMCQ stores C.map = bank letter -> shown letter; verdict() applies it). Reported by paths.
- 2026-11-09 (recall, after the learner walkthrough): tiers stacked in one cell (0 px movement),
  one short thought per tier, reveal scroll measured against the section box, answer keys shown
  A–H everywhere in Recall (either case typed); `relabel()` maps give those same capitals.
- 2026-11-09 (orchestrator): .pr-mix-stage .tara-quiz-mode / .tara-quiz-chip get min-height 44px (shell's request).
