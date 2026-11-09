/* sw.js — generated from tools/sw.tpl.js. Do not hand-edit; edit the template.
 * tools/build-shell.js writes it with both shells' files and the payload list;
 * V1's build-site.js writes it too, with V1's files only and no payload list, so
 * run node tools/build-shell.js after it (node tools/build-shell.js --check says).
 *
 * Three caches. Only the first carries the version, so a deploy replaces the
 * shell and never the learner's offline content:
 *   tara-shell-<v>   this version's shell, precached on install so each shell works
 *                    offline after one visit: index.html (V1), next.html (V2) when the
 *                    list names it, the css/js each document names, shell/* (V2's
 *                    bundle, paths, fonts, the scoped brand css), the manifests, icons,
 *                    the three hooks and shared/* (the one top bar the Films, 3D and Lab
 *                    pages link). Dropped when the version changes.
 *   tara-assets      assets/* payloads: content-hashed names, cached on first use, kept
 *                    across versions. Activate trims it to the payloads the current
 *                    documents name (when build-shell.js gave the list).
 *   tara-pages       intuition/, objects/, lab/, shared/ as they are visited, under
 *                    their own URL, kept across versions.
 * Activate moves what an older worker saved (tara-assets-<v>, and the pages inside an
 * old tara-shell-<v>) into the stable caches, then deletes the old caches. Caches
 * that are not tara-shell-* / tara-assets-* are never touched.
 *
 * Strategy:
 *   documents       (navigations, *.html, the site root) network-first, saved under
 *                   their own URL without the query (?today=... is the same page),
 *                   navigations only. Offline, a document gets its own saved copy:
 *                   the root and index.html stand in for each other, and nothing else
 *                   ever does, so index.html and next.html never answer for each other.
 *   shared/, intuition/, objects/, lab/   network-first, saved in tara-pages
 *   shell/brand-scoped.css (the one stable name under shell/)   network-first
 *   network-first   with a saved copy the network gets 3 s; past that the saved copy
 *                   answers and the fetch finishes in the background to refresh it.
 *                   With none, the request waits for the network.
 *   lab/model/*, lab/data/sae/<L>/sae.bin  passed straight through: the lab's own
 *                   worker keeps them (about 133 MB and 38 MB each)
 *   hashed names (assets/, icons/, css/, js/, shell/fonts|img/, shell/*.<hash>.*)
 *                   cache-first: the name changes when the bytes do
 *   anything else same-origin  cache-first in tara-shell-<v>, then network
 *   cross-origin    not intercepted at all. The packs and demos pull highlight.js
 *                   and three.js from cdnjs/jsdelivr, web fonts from
 *                   fonts.googleapis.com, and the sprint pulls pyodide from
 *                   jsdelivr. Those are third-party, versioned and large; the
 *                   browser's own HTTP cache handles them and a failed one must
 *                   fail visibly rather than be masked by the worker.
 */

const VERSION = '__CACHE_VERSION__';
const SHELL_CACHE = 'tara-shell-' + VERSION;
const ASSET_CACHE = 'tara-assets';
const PAGE_CACHE = 'tara-pages';
const NET_TIMEOUT = 3000;

/* Relative to the worker's own URL, so the site works from any subpath
   (https://<owner>.github.io/<repo>/). */
const SHELL_FILES = __SHELL_FILES__;

/* The assets/* files the current documents name. null: no list, keep them all. */
const ASSET_FILES = /*@ASSET_FILES*/null;

const SCOPE = new URL('./', self.location.href);
const ROOT_URL = SCOPE.href;
const V1_URL = new URL('index.html', SCOPE).href;
const PAGES = /^(intuition|objects|lab|shared)\//;

/* the path inside the site: "next.html", "shell/app.1234567890.js", "" for the root */
function sitePath(url) { return url.pathname.slice(SCOPE.pathname.length); }
function ours(url) { return url.origin === self.location.origin && url.pathname.startsWith(SCOPE.pathname); }

function isImmutable(p) {
  return /^assets\//.test(p) || /^icons\//.test(p) ||
         /^css\/[^/]+\.[0-9a-f]{6,}\.css$/.test(p) ||
         /^js\/[^/]+\.[0-9a-f]{6,}\.js$/.test(p) ||
         /^shell\/(fonts|img)\//.test(p) ||
         /^shell\/[^/]+\.[0-9a-f]{10}\.(css|js|json)$/.test(p);
}

/* A response to keep: a redirected one is re-wrapped, because a cached redirect
   cannot answer a navigation (its redirect mode is "manual"). Clones at once, so
   call it before the page starts reading the body. */
function keepable(res) {
  if (!res.redirected) return res.clone();
  return res.clone().blob().then((body) => new Response(body, {
    status: res.status, statusText: res.statusText, headers: res.headers
  }));
}
async function put(cache, key, res) {
  try { await cache.put(key, await keepable(res)); } catch (e) { /* quota, opaque: never fatal */ }
}

/* When a response was fetched (its Date header), 0 when unknown. */
function stamp(res) {
  const t = Date.parse((res && res.headers.get('date')) || '');
  return isNaN(t) ? 0 : t;
}

/* The saved copy of `key`: tara-pages or this version's precache, the newer one when
   both have it. The exact URL first, then the same path with any query. */
async function savedCopy(key) {
  const hits = await Promise.all([PAGE_CACHE, SHELL_CACHE].map(async (name) => {
    const cache = await caches.open(name);
    return (await cache.match(key, { ignoreVary: true })) ||
           (await cache.match(key, { ignoreVary: true, ignoreSearch: true })) || null;
  }));
  if (hits[0] && hits[1]) return stamp(hits[1]) > stamp(hits[0]) ? hits[1] : hits[0];
  return hits[0] || hits[1];
}

function offlinePage() {
  return new Response('<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>Offline</title>' +
    '<p style="font:16px/1.5 system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:32rem">' +
    'Offline, and this page was not saved yet. It will be after one visit online.</p>', {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* addAll is all-or-nothing; one 404 would leave the app with no offline
       shell at all, so each file is added on its own and failures are logged. */
    await Promise.all(SHELL_FILES.map(async (f) => {
      const url = new URL(f, SCOPE).href;
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await put(cache, url, res);
        else console.warn('[sw] precache skipped', f, res.status);
      } catch (e) { console.warn('[sw] precache failed', f, e && e.message); }
    }));
    await self.skipWaiting();
  })());
});

/* Copy the entries of cache `from` that pass `keep(path)` into cache `to`, unless
   `to` already holds a copy at least as new. */
async function moveInto(from, to, keep) {
  const src = await caches.open(from), dst = await caches.open(to);
  for (const req of await src.keys()) {
    try {
      const url = new URL(req.url);
      if (!ours(url) || !keep(sitePath(url))) continue;
      const res = await src.match(req, { ignoreVary: true });
      if (!res) continue;
      const have = await dst.match(req, { ignoreVary: true });
      if (have && stamp(have) >= stamp(res)) continue;
      await dst.put(req, res);
    } catch (e) { /* one bad entry never stops the move */ }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k === SHELL_CACHE || k === ASSET_CACHE || k === PAGE_CACHE) continue;
      if (/^tara-assets-/.test(k)) await moveInto(k, ASSET_CACHE, (p) => /^assets\//.test(p));
      else if (/^tara-shell-/.test(k)) await moveInto(k, PAGE_CACHE, (p) => PAGES.test(p));
      else continue;                                    // never touch someone else's cache
      await caches.delete(k);
    }
    if (Array.isArray(ASSET_FILES)) {
      /* payloads no current document names: a deploy renamed them */
      const keep = new Set(ASSET_FILES);
      const cache = await caches.open(ASSET_CACHE);
      for (const req of await cache.keys()) {
        const url = new URL(req.url), p = sitePath(url);
        if (ours(url) && /^assets\//.test(p) && !keep.has(p)) await cache.delete(req);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/* Network-first. A good response is saved in cache `store` under `key` when `save`
   is set. With a saved copy (savedCopy) the network gets NET_TIMEOUT ms; past that
   the copy answers and the fetch still finishes in the background to refresh it.
   With none, the request waits for the network; offline it gets the first of
   `fallbacks` that is saved, then (a document) a short offline page. */
function networkFirst(event, key, fallbacks, store, save) {
  const req = event.request;
  let copy = null;
  const net = fetch(req).then((res) => {
    if (save && res && res.ok && res.type === 'basic') copy = keepable(res);  // before the page reads it
    return res;
  });
  /* registered now, while the event is live: it outlasts a response the cache gave */
  event.waitUntil(net.then(async () => {
    if (!copy) return;
    try { await (await caches.open(store)).put(key, await copy); } catch (e) { /* quota: never fatal */ }
  }, () => {}));
  return (async () => {
    const saved = await savedCopy(key);
    if (saved) {
      let timer = 0;
      const late = new Promise((resolve) => { timer = setTimeout(resolve, NET_TIMEOUT, null); });
      const res = await Promise.race([net.catch(() => null), late]);
      clearTimeout(timer);
      return res || saved;
    }
    try {
      return await net;
    } catch (e) {
      for (const k of fallbacks) {
        const hit = await savedCopy(k);
        if (hit) return hit;
      }
      if (req.mode === 'navigate') return offlinePage();
      throw e;
    }
  })();
}

/* What a document may fall back to offline, after its own copy: the root and
   index.html stand in for each other; a named file (next.html, classic.html,
   x.css) has only itself; an extensionless path tries its pretty-URL document
   (next -> next.html), then V1 unless that document is one of the shells. */
function docFallbacks(p, own) {
  if (own === ROOT_URL) return [V1_URL];
  if (own === V1_URL) return [ROOT_URL];
  if (/\.[^/]*$/.test(p)) return [];
  const pretty = own + (own.endsWith('/') ? 'index.html' : '.html');
  return SHELL_FILES.indexOf(sitePath(new URL(pretty))) >= 0 ? [pretty] : [pretty, V1_URL, ROOT_URL];
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!ours(url)) return;                     // third-party, or outside our scope: hands off
  const p = sitePath(url);

  /* The lab's model weights and SAE dictionaries: the lab's own worker caches
     them (under their checksum), so this one passes them straight through. */
  if (/^lab\/model\//.test(p)) return;
  if (/^lab\/data\/sae\/[^/]+\/sae\.bin$/.test(p)) return;

  /* Their own pages, edited often: network-first, kept in tara-pages under their
     own URL (a navigation to one of them is never stored as a shell). */
  if (PAGES.test(p)) {
    event.respondWith(networkFirst(event, url.origin + url.pathname + url.search, [], PAGE_CACHE, true));
    return;
  }

  /* A document: under its own URL without the query. Saved on navigation only, so
     a script reading index.html (a payload manifest refresh) gets the network's
     copy without mixing a newer document into this version's precache. */
  if (req.mode === 'navigate' || p === '' || /\.html?$/.test(p)) {
    const own = url.origin + url.pathname;
    event.respondWith(networkFirst(event, own, docFallbacks(p, own), SHELL_CACHE, req.mode === 'navigate'));
    return;
  }

  /* The scoped brand css keeps its name across builds: network-first. */
  if (/^shell\//.test(p) && !isImmutable(p)) {
    event.respondWith(networkFirst(event, url.origin + url.pathname, [], SHELL_CACHE, true));
    return;
  }

  const immutable = isImmutable(p);
  event.respondWith((async () => {
    const cache = await caches.open(/^assets\//.test(p) ? ASSET_CACHE : SHELL_CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && (immutable || res.type === 'basic')) event.waitUntil(put(cache, req, res));
      return res;
    } catch (e) {
      const any = await caches.match(req, { ignoreVary: true });
      if (any) return any;
      throw e;
    }
  })());
});
