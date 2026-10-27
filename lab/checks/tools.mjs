/* lab/checks/tools.mjs: opens every Lab tool in a real browser, presses its run buttons in page order (a button that
   appears after the first run, such as "Push it" once a dictionary is loaded, is pressed in the next round), and
   reports page errors, console errors and error boxes per tool, with a full-page screenshot of each. A tool that could
   not run because another job (a render) held the 3090 the whole time is reported as BUSY, not as a failure.

     python -m http.server 8080 --bind 127.0.0.1        from the repo root (the Lab reads ../intuition for its links)
     node lab/checks/tools.mjs [tool ...]

   Environment:
     PICK     the model the tools run on: gpt2 (default) or qwen3.5-9b
     DEV      url,model of a test server for the 3090 entry, e.g. http://127.0.0.1:8791,tiny-qwen3.5 (lab/bench/serve.py
              --models tiny-qwen3.5 --port 8791); without it, qwen3.5-9b means the live lab server on this computer
     SITE     where the site is served (http://127.0.0.1:8080)
     BROWSER  chromium (default, Playwright's own), msedge or chrome (an installed browser, so playwright-core is enough)
     OUT      folder for the screenshots (the system's temp folder)

   It needs Playwright (npm i playwright-core, or playwright). The exit code is 1 if any tool failed, 2 if none failed
   but some were BUSY. */

import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);         // require() also finds a package through NODE_PATH
const load = (name) => { try { return require(name); } catch (e) { return null; } };
const { chromium } = load('playwright') || load('playwright-core') || (() => { throw new Error('Playwright is not installed: npm i playwright-core'); })();

const SITE = process.env.SITE || 'http://127.0.0.1:8080';
const PICK = process.env.PICK || 'gpt2';
const [DEV_URL, DEV_MODEL] = (process.env.DEV || '').split(',');
const BROWSER = process.env.BROWSER || 'chromium';
const OUT = process.env.OUT || os.tmpdir();
const TOOLS = ['next', 'surprise', 'lens', 'attention', 'ov', 'dla', 'ablate', 'patch', 'neurons', 'features', 'steer', 'probe'];
const RUN_S = 900, READY_S = 900;      // a cold 9B start (process, then the load) takes up to 8 minutes on the PC

const browser = await chromium.launch({ args: ['--no-proxy-server'], ...(BROWSER === 'chromium' ? {} : { channel: BROWSER }) });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(([pick, url, model]) => {
  localStorage.setItem('tara.lab.model', JSON.stringify(pick));
  if (url) localStorage.setItem('tara.lab.dev', JSON.stringify({ url, model }));
  else localStorage.removeItem('tara.lab.dev');
}, [PICK, DEV_URL || '', DEV_MODEL || '']);
const page = await ctx.newPage();
let errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errs.push(`page error: ${e.message}`));

const BUSY = /stayed busy with another job|^the model was not ready after \d+ s \("waiting"\)|while the card was busy$/;
let failed = 0, busy = 0;
const cardBusy = async () => ((await page.evaluate(() => window.__lab.engine.status.state)) === 'waiting' ? ' while the card was busy' : '');
/* a run a tool starts on its own (patching, say) shows Stop on its button: wait for every one to finish */
const settle = () => page.waitForFunction(() => ![...document.querySelectorAll('#view button.btn.primary')]
  .some((b) => b.offsetParent !== null && b.textContent.trim() === 'Stop'), null, { timeout: RUN_S * 1000 })
  .catch(async () => errs.push(`a run was still going after ${RUN_S} s${await cardBusy()}`));
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : TOOLS) {
  errs = [];
  const t0 = Date.now(), lines = [];
  await page.goto(`${SITE}/lab/index.html#tool/${id}`);
  await page.waitForFunction((x) => window.__lab && window.__lab.key === 'tool/' + x, id, { timeout: 30000 }).catch(() => errs.push('the tool did not open'));
  /* GPT-2 on a first visit: press "Download and start" (its card redraws as the state moves, so retry) */
  for (let k = 0; k < 10; k++) {
    const st = await page.evaluate(() => window.__lab && window.__lab.engine.status.state).catch(() => null);
    if (st && !['idle', 'needs-download'].includes(st)) break;
    await page.click('#view button.btn.primary:has-text("Download and start")', { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.waitForFunction(() => window.__lab.engine.status.state === 'ready', null, { timeout: READY_S * 1000 })
    .catch(async () => errs.push(`the model was not ready after ${READY_S} s (${await page.evaluate(() => JSON.stringify(window.__lab.engine.status.state))})`));
  await page.waitForTimeout(2500);
  await settle();
  const pressed = new Set();
  for (let round = 0; round < 4; round++) {
    let any = false;
    for (const b of await page.$$('#view button.btn.primary')) {
      const label = (await b.textContent()).trim();
      if (!(await b.isVisible()) || pressed.has(label) || label === 'Stop' || /^Download and start/.test(label)) continue;
      pressed.add(label); any = true;
      const t1 = Date.now();
      await b.click();
      await page.waitForTimeout(400);
      await page.waitForFunction((el) => !el.isConnected || el.textContent.trim() !== 'Stop', b, { timeout: RUN_S * 1000 })
        .catch(async () => errs.push(`"${label}" was still running after ${RUN_S} s${await cardBusy()}`));
      await page.waitForTimeout(800);
      lines.push(`       pressed "${label}": ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    }
    if (!any) break;
  }
  await settle();
  await page.waitForTimeout(1500);
  const boxes = await page.$$eval('#view .err, #view .engine-card.err', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().slice(0, 300)));
  for (const b of boxes) errs.push(`error box: ${b}`);
  const shot = path.join(OUT, `lab-${PICK}-${id}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  const verdict = !errs.length ? 'ok  ' : errs.every((e) => BUSY.test(e.replace(/^(console: Error: |error box: )/, ''))) ? 'BUSY' : 'FAIL';
  if (verdict === 'FAIL') failed++;
  if (verdict === 'BUSY') busy++;
  console.log(`${verdict}  ${id} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${shot}`);
  for (const l of lines) console.log(l);
  for (const e of errs) console.log('       ' + e);
}
await browser.close();
console.log(failed ? `${failed} tool(s) failed.` : busy ? `No errors, but ${busy} tool(s) could not run: another job held the graphics card.` : 'Every tool ran without an error.');
process.exit(failed ? 1 : busy ? 2 : 0);
