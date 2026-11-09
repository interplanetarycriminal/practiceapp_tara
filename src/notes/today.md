# today — notes

Owner of `src/v2/today.js`, `src/v2/today.css`, `src/v2/session.js`, `src/v2/session.css`, this file.

## Status (fix round)
- [x] 1 **Recall slot reads `APP.recall.summary()`**:
  - something due: "N things to look at again / five minutes at a time."
  - nothing due but some queued: "Nothing due today / 7 come back tomorrow." (`next.when`: tomorrow, on Thu, on Mon 16 Nov)
  - things saved, none queued: "Nothing due today / all quiet for now."
  - nothing saved yet: "Nothing to recall yet".
  - Without `summary()` it falls back to `dueCount()`.
- [x] 2 **Start never starts a clock on an empty screen.** A finished week (or the course) leads to a recall round if anything is due, else to the warm-up (`#practice/warm`). The click checks the warm-up first with `APP.recall.session({warm:true})`, capped at 2.5s:
  - it has cards: the clock starts, then the page opens
  - it has none: one calm toast ("nothing to warm up with yet. rest counts too."), no clock, no navigation
  - an error or the 2.5s cap: the page opens with no clock.
- [x] 3 **Time's up stays in the running row and at its height.** That is 55px (52px row plus the border) from 320 to 1280, and 46px in landscape. "time's up." with Stop here and Keep going takes the place of the time and the track. From 760px it adds "a good place to stop; it will be here next time." End, Stop here and Keep going are each at least 44x44.
- [x] 4 **Fixed places.** Every part of the hero has a reserved height:
  - title: two lines on a phone, one from 700px, bottom-aligned
  - date/voice row: one row
  - Start: 60px
  - box: one cell, shared with the calm line that replaces it after the course
  - next line: one row (two reserved under 360px; a one-line text sits on the lower one)
  - plan: two chip rows on a phone and one from 700px. Chips that don't fit fold into "+N". A calm line can take the same cell.
  - progress row: kept, even with no week.

  The slots have one height for each width band (120/126px; 142px under 360px; 170px from 700 to 1099px). Their text is clamped to the reserved lines. Box, state, date and progress never move Start, the slots or the strip.
- [x] 5 **Copy.**
  - The next line is "<step title> · N min", with no duplicated "ready for Saturday". Its minutes match the plan chip (idea cards are sized by the cards left).
  - The Capstone slot says "today" or "tomorrow" for its milestone ("next: Project phase starts · today" on 28 Nov).
  - The Just done card uses `APP.paths.week(n).short`, the title the Weeks tab shows ("Agents and control"), not the chapter. The strip tooltips use it too.
- [x] 6 **Date-dependent behaviour** (`heroState()`, below):
  - A session Saturday opens that week's checklist (`#weeks/N/do`), then its ready step, and the plan leads with them.
  - On 5 Dec before 6pm, the freeze comes first: Start opens `APP.capstone.summary().next.hash`, falling back to `#lab/week-13`. A signal chip "freeze 6pm" leads the plan.
  - From the freeze to 12 Dec, the talk builder (`#lab/talk`) comes first. It gets its own chip: the box minus 10 minutes, or the whole 10-minute box.
  - After 12 Dec it shows "The course is done": no clock, no box (a calm line in its place), and recall or the warm-up.
- [x] 7 **Just done card is calm.**
  - partly done: "pick up where you stopped, if you like." (it opens the step to resume)
  - not started: "there whenever you want it."
  - done: "week N, done. it keeps."
  - after the course: "every week stays open."
  - There is no "N steps left" line anywhere.
- [x] 8 **Session bar.**
  - Landscape (`max-height: 500px`): one thin row, 44px plus a 2px border.
  - At the box plus 60 minutes the session closes itself. If that happened in the last 3 hours, one toast says "the session closed on its own. it still counts."; a session forgotten longer goes quietly.
  - Screen readers hear "time's up. stop here, or keep going?" once, from a polite live region.

## What Start does (one place: `heroState(now)`, used by both paint and the click)
| mode | when | Start → | clock | next line | plan |
| --- | --- | --- | --- | --- | --- |
| path | a week with open steps | `P.next(n)` (label "Pick up where you stopped" once begun) | yes | step · N min | `P.plan(n, box)` |
| path, session day | Saturday of W1+ with open steps | first open of do, ready | yes | step · N min | do, ready, then the rest, cut to the box |
| freeze | 5 Dec, before the freeze | capstone `next.hash` / `#lab/week-13` | yes | Freeze at 6pm · the W13 list | freeze chip, then session-day plan |
| talk | after the freeze to 12 Dec | `#lab/talk` ("Pick up where you stopped" once the talk has words) | yes | Talk builder · six parts / one last read | talk builder (box − 10), then the plan |
| recall / warm | the week's path is done | `#practice/recall` if due, else `#practice/warm` (checked for cards) | yes | Recall · N cards · M min / Warm-up · five cards · 4 min | a calm line |
| after | after 12 Dec | as above | **no** | as above | a calm line, no box |

The voice line has a short form for phones too narrow for the whole line. It is the part after the first ". ", and "well done." after the course. `fitVoice()` picks it on paint and on resize. At 320 to 1920 every real line fits whole. The voice is `clamp(18px, 5.65vw, 22px)` and the title `clamp(24px, 7.9vw, 30px)`, so every week's name fits two lines from 320px.

## Verified (Playwright, `next.html`, server :8780, scripts in scratchpad `today-fix/`)
- **Positions** (`positions.js`): 8 dates (11-09, 11-14, 11-15, 11-28, 12-05, 12-06, 12-12, 12-13) × 5 storage states (fresh; W10 partly done; W10 done up to the ready step; all of W10 with 7 recall cards queued for tomorrow; all of W10 with 3 due today) × box 10/30/60/30, at 390x844 and 1280x800.
  - Start, box, next, progress, hero height, the three slots and the strip are at the same y in every case. Only the hidden plan list reads differently when its calm line stands in.
  - 0 page errors, no horizontal overflow, no tap under 44px, no clipped text.
  - Same result at 320, 340, 360, 375, 430, 768 and 1024.
- **Clipping**:
  - `titles.js`: every week's name, W0 to W14, and every voice line, at 320 to 1920.
  - `slotclip.js`: 21 dates (20 Aug to 13 Dec) × 6 widths × 2 states. Nothing clipped.
- **Copy and Start** (`texts.js`, `starts.js`): every row of the table above was checked by clicking Start.
- **Session bar** (`session.js`):
  - running, time's up, keep going and grace end at 390 light and dark, 320, 1280 dark and 844x390.
  - stale sessions: one closed 30 minutes ago toasts; one from 20 hours ago goes quietly.
- **Reviewer's `review-learner/t29_slots.js`**: identical positions for fresh, after-check, after-ready and fresh-sat at box 10/30/60. Its fifth case is covered under Requests.
- **Screenshots** (scratchpad `v2shots/today-fix/`):
  - `today-<date>-fresh-{390,1280}-{light,dark}.png` for all 8 dates
  - extra storage states and 320/340/360 phones
  - `sess-*-{run,timeup,graceend}.png`.

## Interfaces
- `APP.session` is unchanged: `start(minutes, extra)`, `end(quiet)`, `state()`, `elapsed()`, `keepGoing()`, and the window event `tara:session`.
- Storage: `tara.v2.session` and `tara.v2.box` are mine. `tara.v2.capstone` is read only, to see whether the talk has any words. Every read and write is wrapped in try/catch.
- Today reads, all feature-tested:
  - `APP.paths.week/next/progress/plan/ready`
  - `APP.recall.summary/dueCount/session`
  - `APP.capstone.summary`
- Today repaints on `tara:path`, `tara:recall`, `tara:session`, `tara:review` and `tara:capstone`. `APP._paintToday` repaints on demand.

## Requests (outside my files)
1. **Chrome (`src/v2/chrome.css`), landscape phones.** With a session running at 667x375, the page gets 212px: top bar 52 + session bar 46 + tab bar 65. At 844x390, with no tab bar, it gets 292px. The session bar is already at the 44px tap minimum. A slimmer tab bar under `@media (max-height: 500px)` would give the page back about 20px; for example icons only, or labels beside the icons, at about 44–48px.
2. **Reviewer, `review-learner/t29_slots.js`.** The "fresh-after" case (12-13) clicks the 10/30/60 box. After the course the box is hidden on purpose: there is no clock, so a calm line takes its place. Use `{ force: true }` there, or skip the box on that date. With force, all five cases read start 226, done 546, recall 682, cap 818, strip 985. A copy is in scratchpad `today-fix/t29_force.js`.

   Two more notes on that test. It measures viewport y, so a running session would shift every number by the in-flow bar (55px), by design. Its `state-after-ready.json` predates the paths change where the checklist counts as done only when every tick is on.

## Known, by design
- While a session runs, the whole column starts 55px lower (46px in landscape). The bar sits in normal flow so it never covers content; nothing inside Today moves.
- Offline, with no cached bank and nothing saved, the warm-up check finds no cards. Start then shows the calm toast and stays on Today.
- The recall minutes in the next line come from `APP.recall.summary().minutes`, for example "Recall · 7 cards · 2 min".
