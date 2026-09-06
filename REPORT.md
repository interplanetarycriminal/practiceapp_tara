# Verification report

What was actually run, what it measured, and what could not be checked here.
Everything below was driven with Playwright + Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
headless, 1280x900, DPR 1) against a plain Node static server that sets no
`Content-Encoding` and no compression, serving `/mnt/project-files/site`:

* **root** — `http://127.0.0.1:8811/`
* **subpath** — `http://127.0.0.1:8812/tara/` (the GitHub Pages `...github.io/<repo>/` case)
* **control** — `http://127.0.0.1:8813/` serving an unmodified copy of
  `../app/tara-app.html`, so every behavioural claim could be compared against the
  single-file build rather than against my expectations.

## Environment limitation, stated up front

This container's egress proxy returns **403 to every CDN**: `cdn.jsdelivr.net`,
`cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`. That is an
organisation egress policy, not a site problem, and I did not route around it.

Consequently, in every browser run below, cross-origin requests were aborted at the
Playwright level so they failed instantly instead of stalling ~10 s each, and console
errors were classified into **app errors** (same-origin, the app's own — these must be
zero) and **CDN errors** (a blocked third-party host — expected here). The `cdn-errs`
column in the route table is that second class. Nothing that depends on those hosts —
highlight.js syntax colouring in four packs, three.js in three demos, web fonts
everywhere — could be exercised in this container, in this build **or in the original**.
A demo that fails to draw a WebGL scene here is a proxy artefact; I distinguished the
two classes by origin (127.0.0.1 vs. a CDN host) and by the identifier in the thrown
error (`THREE`, `hljs`, `loadPyodide`).

---

## 1. Payload equivalence with the single-file build

All **76** payloads written to `assets/*.gz` were compared byte-for-byte against the
base64 blobs embedded in `../app/tara-app.html`:

```
byte-identical payloads: 76 / 76
monolith payload tags:   76
```

So the split changed no content at all — only where the bytes live.

## 2. Routes — 32/32 at the root, 32/32 under a subpath, zero app console errors

Each row is a **cold page load** at that deep link (not an in-app click), waited to
`data-app-ready`, then checked for: the normalised hash, the routed section, exactly one
visible `.app-sec`, and real rendered content (>200 chars inside the frame for framed
sections, >80 chars in the container otherwise).

```
route                            normalised                      pass  cdn-errs
(empty)                          #today                          PASS  0
#today                           #today                          PASS  0
#plan                            #plan                           PASS  1
#plan/week-3                     #plan/week-3                    PASS  1
#packs                           #packs                          PASS  0
#week-01                         #week-01                        PASS  3
#week-07                         #week-07                        PASS  1
#week-11                         #week-11                        PASS  1
#week-alignment-science          #alignment-science              PASS  1
#week-capstone-weeks-12-14       #capstone-weeks-12-14           PASS  1
#week-1                          #week-01                        PASS  3   (legacy one-digit)
#demos                           #demos                          PASS  0
#demo/tensors-einops             #demo/tensors-einops            PASS  1
#demo/superposition-sae          #demo/superposition-sae         PASS  2
#demo-week-05                    #demo-week-05                   PASS  0
#map                             #map                            PASS  0
#map/node=adam                   #map/node=adam                  PASS  0
#map/q=attention                 #map/q=attention                PASS  0
#cases                           #cases                          PASS  0
#cases/broadcasting              #cases/broadcasting             PASS  0
#drill                           #drill                          PASS  0
#drill/week-01                   #drill/week-01                  PASS  0
#drill/week-01/einops-rearrange  #drill/week-01/einops-rearrange PASS  0
#sprint                          #sprint                         PASS  2
#sprint/day-3                    #sprint/day-3                   PASS  2
#manual                          #manual                         PASS  1
#node=adam                       #map/node=adam                  PASS  0   (legacy)
#q=attention                     #map/q=attention                PASS  0   (legacy)
#day-4                           #sprint/day-4                   PASS  2   (legacy)
#broadcasting                    #cases/broadcasting             PASS  0   (bare case-card stem)
#adam                            #map/node=adam                  PASS  0   (bare concept-map node)
#not-a-real-thing-at-all         #today                          PASS  0   (unknown falls through)

32/32 routes pass. app console errors: 0
```

Identical result at `http://127.0.0.1:8812/tara/` — **32/32, 0 app console errors** — which
is the proof that the subpath deployment works: no leading-slash path anywhere, and all
payload fetches resolved against `document.baseURI`.

Two rows deserve a note. `#week-alignment-science` self-heals to `#alignment-science`
and `#week-capstone-weeks-12-14` to `#capstone-weeks-12-14`. My first expectation was
that they stayed verbatim; the **control run against `tara-app.html` produced exactly the
same rewrite**, so this is the app's documented "the URL self-heals" behaviour, unchanged
by the split, and both still land on the right pack.

I also ran the complete table against the control. Both builds: 32/32, 0 app errors.

## 3. The tier control's scroll anchoring

Measured with the frame's **own** anchor function, `window.__appSnapTop()` from
`sections/packs.js` — so this measures the boundary the implementation actually pins,
not a guess at it. Procedure per sample: force tier 2, scroll the frame to a fraction of
its scroll range, snapshot the anchor element and its `getBoundingClientRect().top`,
then `APP.setTier(3)` -> `(1)` -> `(2)`, re-reading that same element's top after each
change (600 ms settle, which includes the anchor's own `requestAnimationFrame` second
pass).

**All 13 packs x 4 scroll depths (0.10, 0.30, 0.55, 0.80) = 52 samples, 156 single tier
changes:**

| | this static site | control (`tara-app.html`) |
|---|---|---|
| worst single-change drift | **0.8906 px** | **0.8906 px** |
| mean single-change drift | 0.2304 px | 0.2260 px |
| samples over 0.50 px | 12 / 156 | 11 / 156 |
| samples over 1.00 px | 0 / 156 | 0 / 156 |
| **2 -> 3 -> 1 -> 2 scroll delta** | **0 px, all 52** | **0 px, all 52** |
| **2 -> 3 -> 1 -> 2 anchor delta** | **0 px, all 52** | **0 px, all 52** |

Row by row the two runs agree on 50 of 52 samples exactly; the two that differ are both
`week-04`, and they differ between two runs of the *same* build too, so that pack's
anchor choice is sensitive to a re-layout, not to which build is serving.

**Honest reading of this.** The round-trip requirement is met exactly: **0 px**, every
pack, every depth, both builds. The single-change requirement of <= 0.50 px is **not**
reproduced in this container — worst 0.89 px — but it is not reproduced by the original
single-file build either, at the same number, so **the split introduces no regression**.
I did not refactor the anchoring logic; `sections/packs.js` is copied through byte for
byte. The most likely reason the app README's <= 0.5 px does not reproduce here is the
environment: web fonts are blocked, so text lays out on fallback metrics and the
sub-pixel residual the anchor cannot correct (it can only move `scrollTop`) lands
differently. I tested DPR 2 and an 1,100 ms settle: neither changes the numbers, so it is
not a scroll-snapping or timing artefact. For scale, when I first measured against the
*wrong* candidate class (a `[data-tier-group]` below the fold rather than the anchor the
code picks) the same changes drifted 187-818 px — that is the magnitude the mechanism is
suppressing.

## 4. Tier persistence, and one pre-existing defect

| check | result |
|---|---|
| `APP.setTier(3)` reaches the open pack frame (`TARA.getTier() === 3`, `<html data-tara-tier="3">`) | PASS |
| `localStorage["tara.tier"]` **and** `["tara.resolution"]` both written | PASS (`3` / `3`) |
| tier survives navigating to another pack (new frame, iframe boundary crossed) | PASS |
| tier survives a **cold reload** into the sprint and maps to `sprint7.v1.tier` | **FAIL** |

The last one: load a pack, set tier 3, then open `#sprint`. The sprint frame comes up at
`working` (tier 2) and its `MutationObserver` pushes that back into the shell, resetting
`tara.tier` to `2`. **The control build does exactly the same thing, to the same
values** — verified side by side — so this is a pre-existing defect in
`sections/sprint.js` / `src/sprint.html` (the sprint reads its own tier key before the
composed seed script has run), not something the split introduced. Fixing it would mean
changing sprint behaviour, which the brief put out of scope; it is left as-is and
reported here.

Tier persistence across every non-sprint section is correct.

## 5. Interaction

| check | result |
|---|---|
| demo `sampling-decoding` responds to input | PASS — moving the first range control re-rendered the frame's output |
| drill draws questions | PASS — "1 / 12", 4 options, from `bank:week-01` |
| drill re-shuffles (not a fixed order) | PASS — **6 distinct opening questions in 6 consecutive draws** |
| map node deep link opens the node | PASS — `#map/node=induction-heads` opens the node panel ("Induction head — A head implementing 'I saw A then B earlier...'") |
| case deep link opens and lands on the card | PASS — `#cases/einops-rearrange` scrolls its card into view, `class="cases-card is-hit"`, 2,791 chars of content |

## 6. Progressive web app — 8/8 at the root, 8/8 under the subpath

| check | root | subpath |
|---|---|---|
| service worker installs and activates | PASS (`scope /`) | PASS (`scope /tara/`) |
| shell precached (10 entries: `./`, index.html, manifest.json, hashed css, hashed js, 5 icons) | PASS | PASS |
| `assets/*.gz` cached on first use | PASS (5 after opening one pack) | PASS |
| second load **with the network offline** still renders the shell | PASS — 9 nav items, `#today` renders | PASS |
| a cached pack payload opens offline | PASS — week-01 rendered from cache | PASS |
| `manifest.json` parses | PASS — name TARA, `start_url ./#today`, `display standalone`, `theme_color #1f3fb8`, `background_color #fbfaf7`, 5 icons | PASS |
| Chromium parses the manifest with no errors (`Page.getAppManifest`) | PASS — `errors: []` | PASS |
| **Chromium reports the app installable** (`Page.getInstallabilityErrors`) | **PASS — `installabilityErrors: []`** | **PASS** |

Icons render correctly and decode at their declared sizes (192x192, 512x512, and the SVG
at 512x512) — checked by loading each into an `<img>` and reading `naturalWidth/Height`,
and by screenshotting the three variants side by side.

Cross-origin passthrough was exercised incidentally: the successful Pyodide run in section 8
happened on a page with the service worker active, and its fetches went to a different
origin untouched.

## 7. Sizes

Measured from Chromium's own response sizes on a **cold load into a fresh browser
context** (no HTTP cache, no service worker), same-origin requests only.

| cold load | requests | as served (no compression) | if the host gzips text (GitHub Pages does) |
|---|--:|--:|--:|
| `#today` (the shell + what boot needs) | 5 | **234,399 B** | **80,348 B** |
| `#week-01` (shell + pack, tiers, bank, engine, layer) | 10 | 352,397 B | 198,346 B |
| `#sprint` (shell + the 574 KB sprint document) | 6 | 430,451 B | 276,400 B |

The `#today` shell breaks down as `js/app.<hash>.js` 171,149 + `css/shell.<hash>.css`
42,805 + `index.html` 14,833 + `assets/concepts-index.gz` 4,724 +
`assets/schedule.gz` 888. The single-file build downloads **2,989,431 B** for that same
first screen, so the shell is **12.7x smaller uncompressed, 37x smaller gzipped**.

**Total site on disk: 2,405,925 B (2.5 MB) in 94 files** — `assets/` 2,072,772 B in 76
files, `js/` 171,149, `css/` 42,805, `icons/` ~41 KB, plus index.html, sw.js,
manifest.json, README.md, REPORT.md, the workflow, the build script and `tools/`.

## 8. The Python runner in the crash sprint

Two runs, both against this site in Chromium.

**(a) CDN unreachable — the fallback path.** With `cdn.jsdelivr.net` blocked, as it is in
this container:

```
probe: { state: "blocked", why: "Failed to fetch",
         index: "https://cdn.jsdelivr.net/npm/pyodide@0.28.3/" }
notice shown: true  — "Python exercises cannot run here. Pyodide loads its interpreter
                       by fetching WebAssembly from a CDN, ..."
rest of the sprint still renders: 5,931 chars, day 1 heading, 8 exercise editors
```

PASS — the graceful notice is intact and everything else in the sprint keeps working.

**(b) Pyodide reachable — the runner path, end to end.** Since the CDN is 403'd here, I
mirrored the **identical** distribution locally: `pyodide-0.28.3.tar.bz2` from the
pyodide GitHub release, served from `http://127.0.0.1:8814/pyodide/`, with
`window.SPRINT_PYODIDE_INDEX` pointed at it (the override the sprint already supports).
Then I opened `#sprint/day-1`, typed the correct answer into the first exercise
("Read the shape off") and clicked **Run**:

```
probe:   { state: "ok", index: "http://127.0.0.1:8814/pyodide/" }
notice:  not shown
result:  class "out pass", text "Correct."          (3.7 s from click to result)
env:     { ready: true, einops: true, error: null }
pyodide: 0.28.3
python:  numpy 2.2.5 / einops 0.8.1 / np.arange(6).reshape(2,3).sum(axis=0) -> [3, 5, 7]
app console errors: 0
```

So: real Pyodide, real numpy, **real einops installed from the base64 wheel embedded in
`src/sprint.html`**, and `run_exercise` executed the check and returned a pass. Laziness
was confirmed too — nothing Pyodide-shaped is requested on shell load or on any route
other than `#sprint`.

**Verdict, stated plainly: the runner path is wired and works, but it was NOT confirmed
against `cdn.jsdelivr.net` itself, because this container's proxy refuses that host.**
What I proved is that everything downstream of the fetch — the lazy script injection,
`loadPyodide({indexURL})`, `loadPackage(["numpy","micropip"])`, the einops wheel install,
the exercise runner and the pass/fail UI — works with the genuine pyodide 0.28.3 files.
What remains unproven is only that jsDelivr serves those same files to a browser on a
real https origin. Nothing was changed to make this work: the shipped code still points
at `https://cdn.jsdelivr.net/npm/pyodide@0.28.3/`, and the fallback notice is untouched.

## 9. Path audit

`grep` over `index.html`, `css/*.css`, `js/*.js`, `sw.js`, `manifest.json` for
`src="/..."`, `href="/..."`, `url(/...)` and quoted root-absolute string literals: **no hits**
(the only `/`-leading matches in the JS are regex literals, `"/g` and `'/g`). I also
decompressed all 76 payloads and searched every `html`/`js` one for
`src="/..."` / `href="/..."`: **no hits**. Every internal URL is relative.

---

## What I did not verify

* **Anything behind a blocked CDN.** highlight.js colouring (packs 01, 02, 09, 10),
  three.js scenes (`steering-persona-vectors`, `transformer-block`, `residual-stream-bus`,
  `backprop-training`, `superposition-sae`) and Google Fonts never loaded in any run,
  in this build or in the control. Those sections render, scroll, tier-switch and
  deep-link correctly without them; what is unverified is only the CDN-dependent visual.
* **Pyodide against the real jsDelivr origin** — see section 8.
* **The GitHub Actions workflow was written, not run.** `.github/workflows/pages.yml` is
  a file only, per the brief. It has not been executed and no repository, commit, push or
  deployment was made anywhere.
* **Real-device installation.** Chromium reports zero installability errors, which is the
  programmatic verdict; I did not install the app on a phone or desktop OS.
* **Browsers other than Chromium.** No Safari or Firefox run. The one new API used is
  `fetch` + `Response.arrayBuffer`, on top of the `DecompressionStream('gzip')` the app
  already required, so the browser floor is unchanged.
* **Very old / no-`DecompressionStream` browsers.** The existing single-line fallback
  message is unchanged; I did not exercise it.

## Known defects left in place

1. **Tier resets to 2 when the sprint opens** (section 4). Pre-existing; reproduced
   identically in `tara-app.html`; fixing it means changing sprint behaviour, which was
   out of scope.
2. **Icon files are not byte-reproducible in this container.** The encoder is
   deterministic (1,393 B for the 192 px PNG on every run) but this filesystem rewrites
   image files on write to attach C2PA content-credential metadata with a fresh UUID, so
   `icons/*.png` and `icons/icon.svg` differ between two otherwise identical builds and
   are ~5-8 KB larger than the encoder's output. Everything else — `index.html`, the
   hashed CSS and JS, `manifest.json`, `sw.js` and all 76 `assets/*.gz` — is byte-identical
   across consecutive builds (verified by `sha256sum` over the whole tree, twice). The
   service-worker cache version is hashed over the icons *as the encoder produced them*
   so that `sw.js` stays deterministic regardless.
