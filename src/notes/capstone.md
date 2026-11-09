# capstone notes

Owner of `src/v2/lab.js`, `src/v2/lab.css`, this file. Section id `lab`, routes `#lab`, `#lab/<rest>`.

## Status
- Done. The Lab tab is built and styled only with brand tokens and `fu-*` classes. It is in the
  bundle (`node tools/build-shell.js`).
- Checked at 390x844 and 1280x800, in light and dark, with Google Fonts and the CDNs aborted:
  - zero page errors, no sideways scroll, tap targets at least 44px
  - `#lab` today, and with `?today=` set to 2026-11-28, 11-30, 12-05, 12-06, 12-12 and 12-13
  - `#lab/talk`: typed, saved, reloaded and downloaded as `capstone-talk.md`
  - a W12 tick made in `#lab` shows in `#plan/week-12`, even with the plan frame already open
  - an untick made in the plan shows in `#lab`
  - an unmigrated tick store is left alone
  - the 6pm freeze flips while the page is open (AEST clock)
  - the door opens `lab/index.html` in the same window

## The page (fixed order, fixed places)
1. Runway (`#lab-runway`):
   - days to the freeze and to the talk
   - five milestones in fixed places: 28 Nov start, 4 Dec last runs, 5 Dec freeze 6pm, 6–11 Dec
     rehearse, 12 Dec talk
   - a "Today" pin on the track
   - the "your pick" line
   - the two claude.ai links, which open in a new tab
2. Weeks 12 to 14 (`#lab-weeks`):
   - the plan's lists for before Saturday and on the day, plus its "done when" and "skip" lines
   - on a phone, one week shows at a time under W12/W13/W14 buttons; from 960px, three columns
   - the capstone pack's 11 sections, as `#capstone-weeks-12-14/<anchor>` links
3. Talk builder card, which opens `#lab/talk`:
   - six parts, each with a prompt and an estimate at 150 words a minute
   - a 0–8 minute meter with the 5–7 band marked
   - a "Save as markdown" button
4. Lab door (`#lab-door`): opens `lab/index.html` in the same window.
5. This week's missions (`#lab-missions`), for the week `APP.v2now().target` points to.
6. Latest results (`#lab-results`): the 3 newest entries of `lab/findings/index.json`.

## Decisions
- **First paint.** All four loaders (plan, pack, missions, results) finish before the first paint,
  each with a 3–4 s timeout, so nothing moves afterwards. A slow piece leaves a link in its slot;
  the results and the pack fill in on a later visit.
- **Ticks.** Each change re-reads `tara.fourteen.v1`, changes one key and writes the store back.
  Nothing is cached.
  - An empty store becomes `{__order:"tara"}`, which is what the plan does on its first run.
  - A store without `__order:"tara"` is never written. The box reverts, and a note and a toast
    say to open the plan once.
  - After a write the Lab drops the cached plan frame (`APP.frames.drop('plan')`) and fires
    `tara:ticks`.
- **Freeze.** On 5 Dec the clock decides: 6pm AEST (UTC+10). With `?today=` set there is no
  clock, so on 2026-12-05 the freeze stays ahead all day.
- **Talk length.** 5–7 minutes, as the brief says (see Requests).
  - `TALK_LO` and `TALK_HI` are the only place the length is set. The copy, the meter and the
    per-part aims all follow them.
  - The aims are 30, 45, 75, 120, 60 and 30 s, which add up to 6:00.
- **Missions.** Taken from `APP.paths.week(n).missions`. If that is missing, from `missionsFor(n)`
  in `lab/ui/missions.js`. If that is missing too, a link to `lab/index.html#missions/week-N`.
  - A card opens its tool if it has one, then its result, then the missions page.
  - The done state comes from `tara.lab.done`.
- **Lab links.** Every link into `lab/` has `data-v2-pass`, so the viewer never opens it.
- **Payload text.** Text from the plan and the pack goes through an inert `<template>` and an
  allowlist (b, strong, i, em, code). The plan's `WEEKS` literal is read by a small parser,
  never by `eval`.
- **Pack list.** Open from 720px wide, folded on a phone.
- **Tab left open.** The runway repaints when the tab is shown again, and at 6pm on 5 Dec.

## Interfaces
- `APP.capstone.summary(iso?)` returns
  `{ freeze: '2026-12-05', talk: '2026-12-12', daysToFreeze, daysToTalk, next: { title, date, hash } }`.
  What `next` is, by date:
  - up to 28 Nov: "Project phase starts", `#lab/week-12`
  - up to 4 Dec: "Experiments wrap up", `#lab/week-12`
  - 5 Dec before 6pm: "Results freeze at 6pm", `#lab/week-13`
  - after that: "The talk", date `2026-12-12`, `#lab/talk`
- Routes:
  - `#lab`
  - `#lab/talk`
  - `#lab/week-12`, `#lab/week-13`, `#lab/week-14` select that week
  - `#lab/runway`, `#lab/weeks`, `#lab/door`, `#lab/missions`, `#lab/results` scroll to that block
- Storage: `tara.v2.capstone` holds
  `{ v: 1, pick: '', talk: { question, why, did, result, means, next } }`.
  - Only the text the learner types is stored.
  - Each write re-reads the store and merges into it.
  - Saves wait 350 ms after typing stops. They also happen on blur, pagehide, when the tab is
    hidden, and on unmount.
- Events the Lab fires:
  - `tara:ticks` with `{ key, on, source: 'lab' }` after each tick write
  - `tara:capstone` with `{ frozen: true, source: 'lab' }` at 6pm on 5 Dec, if a page is open
    (Today already listens for it)
- Events the Lab listens to:
  - `storage`, for the ticks, `tara.v2.capstone` and `tara.lab.done`
  - `tara:path`, to repaint the ticks
  - `visibilitychange`
- `APP.capstone._test` exists for checks only. It is not an interface.

## Requests
- **shell, `src/v2/chrome.css`: the toast is not centred.**
  - Cause: `.app-toast.fu-toast[data-show="1"]` runs `fu-pop-in ... both`. That animation's last
    frame is `transform: none`, which replaces `translateX(-50%)`.
  - Result: at 390px the toast runs from x 195 to 533, past the right edge (see
    `tick-refused-390.png`). At 1280px it starts at the centre of the screen.
  - Fix: use `translate: -50% 0` in place of the transform, or
    `left: 0; right: 0; margin-inline: auto`.
- **shell, `src/v2/today.js`: the slot is wrong after 6pm on 5 Dec.**
  - `daysToFreeze` is still 0 then, but `next.date === talk`, and the slot still says
    "Freeze today, 6pm".
  - `tara:capstone` fires at that moment.
- **shell, the plan frame.** The plan payload requests Archivo and IBM Plex from
  fonts.googleapis.com. The checks abort it without errors, but it is still a Google web-font
  request on a V2 screen.
- **paths, `weeks.js`.** When writing `tara.fourteen.v1`:
  - re-read the store before each write
  - keep `__order: "tara"`
  - drop the plan frame
  - repaint on `tara:ticks`, because a write in the same window fires no `storage` event
  The Lab already repaints its ticks on `tara:path`.
- **bars, `lab/index.html`.** "← TARA" goes to `../index.html#today`. Under V2, `#lab` would bring
  the learner back to the tab the door is on.
- **orchestrator: the talk length.**
  - The brief says 5–7 minutes.
  - Pack section 07 is called "The ten minutes you are graded on".
  - The plan mentions fifteen minutes.
  - I built it to the brief. Changing it is one line in `lab.js`: `TALK_LO` and `TALK_HI`.

## Known issues
- The week marked as "now" and the week the missions come from are chosen when the page loads. A
  tab left open across a Saturday keeps the old week until it is reloaded; the runway itself
  catches up.
- On a phone, the "open the plan once" note sits below the week panel and can be off screen. The
  toast says the same thing, but only on screen once shell centres it.

## Shots
The folder is
`/tmp/claude-0/-home-user-practiceapp-tara/38da0dcc-b12c-5580-9901-1c3afc9cc69b/scratchpad/v2shots/capstone/`.
It holds `lab-today-*`, `lab-2026-11-30-*`, `lab-2026-12-06-*`, `talk-typed-*`, `talk-reloaded-*`,
`tick-w12-390.png`, `tick-w12-in-plan-390.png` and `tick-refused-390.png`.

## Orchestrator changes after hand-back
- 2026-11-09: talk length set to 8 to 10 minutes (TALK_LO/TALK_HI) to match the capstone pack's
  "present it in ten minutes" and its section "The ten minutes you are graded on". The official TARA
  slot is not in any source; the user is asked to confirm it.
