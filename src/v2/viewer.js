/* src/v2/viewer.js — #view/<site-relative path> (owner: shell).
   Films, concept films, the Model Room and the 3D objects open inside the shell:
   a same-origin iframe under the chrome with a slim header (title, close, "open
   on its own"), so the top bar, the session timer and Back keep working.

   Links are routed in one place, the capture phase of each document's window:
   the shell's own, every srcdoc frame's (APP.frames.onLoad) and the viewed
   page's (re-attached on each load). For a plain left click on <a href>:
     - intuition/**.html, objects/**.html  -> #view/<path> in the shell
     - index.html / next.html / classic.html (with or without #x) -> the shell
       routes to #x (or #today) and the viewer closes
     - lab/**                              -> the whole window goes there
   Bare "#x" hrefs, target=_blank, modified clicks, download links and anything
   marked data-v2-pass are left alone. A routed click calls preventDefault()
   (and stopPropagation()), so a page's own handler that checks
   event.defaultPrevented never navigates a second time.

   Before a page is shown it is checked (HEAD, then a GET through the service
   worker when the network is down): a page that is not there, or not saved for
   offline yet, gets the shell's calm oops panel with Try again instead of a
   server's 404 or the browser's dinosaur.

   Close (X) steps back in history to where the viewer was opened from
   (APP.backTo), so Back afterwards does not reopen the film and reload its
   WebGL. A page in the viewer that moves itself (the Model Room's cards, an
   object's hub link, a hash of its own) adds entries to the same history; the
   viewer counts them (history.length grew by one) and steps back over them too.
   A move it cannot count (a full history) makes close replace this entry with
   the opener instead, and a check after the step replaces it if Back still
   landed inside the viewer.

   APP.viewer.open(path) / .close() / .path() / .route(url) -> 'view'|'shell'|'lab'|null */

'use strict';

var SHELL_DOCS = { '': 1, 'index.html': 1, 'next.html': 1, 'classic.html': 1 };
var VIEWABLE = /^(intuition|objects)\/(?:[^?#]*\.html|[^?#]*\/|)$/i;

function scope() {
  try { return new URL('./', document.baseURI); } catch (e) { return null; }
}

/* site-relative path of an absolute URL, or null when it is not ours */
function sitePath(u) {
  var s = scope();
  if (!s || u.origin !== s.origin) return null;
  if (u.pathname.indexOf(s.pathname) !== 0) return null;
  return u.pathname.slice(s.pathname.length);
}

/* What a URL is to the shell. */
function classify(u) {
  var p = sitePath(u);
  if (p == null) return null;
  if (SHELL_DOCS[p] === 1) return { kind: 'shell', hash: (u.hash || '').replace(/^#/, '') };
  if (/^lab(\/|$)/i.test(p)) return { kind: 'lab', href: u.href };
  var path = p;
  if (/^(intuition|objects)$/i.test(path)) path += '/';
  if (!VIEWABLE.test(path)) return null;
  if (/\/$/.test(path)) path += 'index.html';
  return { kind: 'view', path: path + (u.search || '') + (u.hash || '') };
}

/* ------------------------------------------------------------ interceptor */

function onClickCapture(e) {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var t = e.target;
  if (t && t.nodeType !== 1) t = t.parentElement;
  var a = t && t.closest ? t.closest('a[href]') : null;
  if (!a) return;
  if (a.hasAttribute('download') || a.hasAttribute('data-v2-pass')) return;
  var target = (a.getAttribute('target') || '').toLowerCase();
  if (target && target !== '_self' && target !== '_top' && target !== '_parent') return;
  var raw = (a.getAttribute('href') || '').trim();
  if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel|data|blob):/i.test(raw)) return;
  var u;
  try { u = new URL(a.href); } catch (err) { return; }
  var c = classify(u);
  if (!c) return;

  var inShell = a.ownerDocument === document;
  if (c.kind === 'lab') {
    if (inShell) return;                       /* the browser does exactly this already */
    e.preventDefault(); e.stopPropagation();
    window.location.href = c.href;
    return;
  }
  e.preventDefault(); e.stopPropagation();
  if (c.kind === 'shell') { APP.navigate(c.hash || 'today'); return; }
  APP.navigate('view/' + c.path);
}

function attach(win) {
  if (!win) return;
  try {
    if (win.__v2links === win.document) return;
    win.__v2links = win.document;
    win.addEventListener('click', onClickCapture, true);
  } catch (e) { /* cross-origin: not ours to route */ }
}

attach(window);
if (APP.frames && APP.frames.onLoad) APP.frames.onLoad(function (f, d, w) { attach(w); });

/* ----------------------------------------------------------------- section */

var lastOutside = null;          /* the last non-viewer route, for close */
var frame = null;                /* the one viewer iframe; destroyed on leave */
var hostEl = null;
var requested = null;            /* the URL the shell last put in the frame */
var lenAtShow = 0;               /* history.length when it did (or last looked) */
var framePushes = 0;             /* entries the frame's pages pushed since the viewer opened */
var selfNav = false;             /* ...and a move that could not be counted */
var openSeq = 0;                 /* the check in flight; a newer route wins */

APP.onRoute(function (r) {
  if (r && r.section !== 'view') lastOutside = r.raw;
});

function titleFromPath(p) {
  var f = String(p || '').split(/[?#]/)[0].split('/').pop().replace(/\.html$/i, '');
  if (!f || f === 'index') {
    if (/^objects\//.test(p)) return 'Model Room';
    if (/^intuition\//.test(p)) return 'Films';
    return 'Viewer';
  }
  return APP.titleCaseSlug(f.replace(/^(w\d+|deep-w\d+)-/, ''));
}

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var head = APP.el('div', { 'class': 'v2-viewhead' });
  var close = APP.el('button', { 'class': 'v2-viewclose', type: 'button', 'aria-label': 'Close the viewer', title: 'Close' });
  close.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
  close.addEventListener('click', function () { APP.viewer.close(); });
  var title = APP.el('span', { 'class': 'v2-viewtitle', id: 'v2-viewtitle' });
  var out = APP.el('a', { 'class': 'v2-viewout', id: 'v2-viewout', href: '#', 'data-v2-pass': '1', text: 'open on its own' });
  out.addEventListener('click', function () {
    /* the page will want to come back here, not to V1 */
    try { sessionStorage.setItem('tara.dim.back', '#' + (lastOutside || 'today')); } catch (e) {}
  });
  head.appendChild(close); head.appendChild(title); head.appendChild(out);
  var box = APP.el('div', { 'class': 'v2-viewbox', id: 'v2-viewbox' });
  var empty = APP.el('div', { 'class': 'v2-viewempty app-sec-pad', id: 'v2-viewempty', hidden: 'hidden' });
  el.appendChild(head); el.appendChild(box); el.appendChild(empty);
}

function dropOops(el) {
  var old = el.querySelector('.v2-viewoops');
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

function showEmpty(el, msg, linkHref, linkText) {
  var empty = el.querySelector('#v2-viewempty');
  var box = el.querySelector('#v2-viewbox');
  dropFrame();
  dropOops(el);
  if (box) box.hidden = true;
  if (!empty) return;
  empty.hidden = false;
  empty.textContent = '';
  empty.appendChild(APP.el('p', { 'class': 'app-empty', text: msg }));
  var out = el.querySelector('#v2-viewout');
  if (out) out.hidden = true;
  if (linkHref) empty.appendChild(APP.el('p', {}, [APP.el('a', { 'class': 'app-a', href: linkHref, text: linkText || linkHref })]));
  var title = el.querySelector('#v2-viewtitle');
  if (title) title.textContent = 'Viewer';
}

function dropFrame() {
  if (!frame) return;
  try { if (frame.parentNode) frame.parentNode.removeChild(frame); } catch (e) {}
  frame = null;
}

function frameHref() {
  try { return frame && frame.contentWindow ? frame.contentWindow.location.href : null; } catch (e) { return null; }
}

function onViewLoad() {
  if (!frame) return;
  var w = null, d = null;
  try { w = frame.contentWindow; d = frame.contentDocument; } catch (e) {}
  if (!w || !d) return;
  attach(w);
  var title = document.getElementById('v2-viewtitle');
  var t = '';
  try { t = (d.title || '').replace(/\s+[·|—-]\s+(TARA|Object Lessons|Intuition).*$/i, '').trim(); } catch (e) {}
  if (title && t) title.textContent = t;
  /* the page moved by itself (its own script): keep the shell's hash honest */
  var u = null;
  try { u = new URL(w.location.href); } catch (e) {}
  var c = u && classify(u);
  if (u && requested && noHash(u.href) !== noHash(requested)) {
    /* a move the shell did not ask for */
    countMove();
    requested = u.href;
  }
  /* a page's own #hash moves push entries too, with no load */
  try {
    if (w.__v2hashwatch !== w.document) {
      w.__v2hashwatch = w.document;
      w.addEventListener('hashchange', function () { if (frame && frame.contentWindow === w) countMove(); });
    }
  } catch (e) {}
  if (c && c.kind === 'view') {
    var want = 'view/' + c.path;
    if (APP._route && APP._route.raw !== want && location.hash !== '#' + want) {
      /* in place, keeping this entry's v2 stamps (where it was opened from) */
      if (APP.replaceHash) APP.replaceHash(want);
      else history.replaceState(null, '', '#' + want);
      APP._route.raw = want; APP._route.params.rest = c.path;
    }
    var out = document.getElementById('v2-viewout');
    if (out) out.setAttribute('href', c.path);
  }
  try { window.dispatchEvent(new CustomEvent('tara:view', { detail: { path: c && c.path, title: t } })); } catch (e) {}
}

function noHash(h) { return String(h || '').split('#')[0]; }

/* One entry more: a push by the frame's page. None, before any push: the page
   replaced itself (a concept film handing over to its full film). None after a
   push could be Back or Forward inside the frame, and anything else (the
   50-entry cap, forward entries cut) cannot be counted either: then close
   replaces this entry instead of stepping back. */
function countMove() {
  var d = history.length - lenAtShow;
  if (d === 1 && history.length < 50) framePushes++;
  else if (d !== 0 || history.length >= 50 || framePushes > 0) selfNav = true;
  lenAtShow = history.length;
}

function show(el, path) {
  var box = el.querySelector('#v2-viewbox');
  var empty = el.querySelector('#v2-viewempty');
  if (empty) empty.hidden = true;
  dropOops(el);
  if (box) box.hidden = false;
  var s = scope();
  var url = new URL(path, s).href;
  requested = url; lenAtShow = history.length;
  var title = el.querySelector('#v2-viewtitle');
  var out = el.querySelector('#v2-viewout');
  if (out) { out.setAttribute('href', path); out.hidden = false; }
  if (!frame) {
    selfNav = false; framePushes = 0;   /* a new frame: no history of its own yet */
    if (title) title.textContent = titleFromPath(path);
    frame = document.createElement('iframe');
    frame.className = 'v2-viewframe';
    frame.setAttribute('title', titleFromPath(path));
    frame.setAttribute('allow', 'fullscreen; autoplay');
    frame.setAttribute('allowfullscreen', '');
    frame.addEventListener('load', onViewLoad);
    frame.src = url;
    box.appendChild(frame);
    return;
  }
  var cur = frameHref();
  if (cur === url) return;
  if (title) title.textContent = titleFromPath(path);
  frame.setAttribute('title', titleFromPath(path));
  /* replace, so the shell's hash change is the only history entry */
  try { frame.contentWindow.location.replace(url); }
  catch (e) { frame.src = url; }
}

/* Is the page there? HEAD first (the service worker lets HEAD through to the
   network); with no network, a GET through the worker finds a saved copy. */
function check(path) {
  var url = noHash(new URL(path, scope()).href);
  return fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    .catch(function () { return fetch(url, { credentials: 'same-origin' }); })
    .then(function (res) {
      /* read the body to its end (empty for HEAD; offline, the saved copy), so
         the request finishes instead of being cancelled half-read */
      return res.text().catch(function () { return ''; }).then(function () { return res; });
    })
    .then(function (res) {
      if (res.ok) return true;
      var e = new Error('HTTP ' + res.status + ' for ' + path);
      e.status = res.status;
      throw e;
    });
}

function showOops(el, err, retry) {
  dropFrame();
  dropOops(el);
  var box = el.querySelector('#v2-viewbox');
  var empty = el.querySelector('#v2-viewempty');
  if (box) box.hidden = true;
  if (empty) empty.hidden = true;
  var gone = err && (err.status === 404 || err.status === 410);
  var out = el.querySelector('#v2-viewout');
  if (out) out.hidden = true;                 /* nothing there to open on its own */
  var p = APP.oops(err, retry, 'v2-viewoops', gone ? {
    line: 'that page is not here. it may have moved; the Library has every film and object.',
    link: { href: '#library', text: 'Go to the Library' }
  } : null);
  el.appendChild(p);
  var title = el.querySelector('#v2-viewtitle');
  if (title) title.textContent = gone ? 'Not here' : 'Viewer';
}

/* check, then show; the Try again button runs it again */
function open(el, path) {
  var seq = ++openSeq;
  /* the frame already shows it (a hash the page moved to itself): nothing to check */
  if (frame && noHash(frameHref()) === noHash(new URL(path, scope()).href)) { show(el, path); return; }
  check(path).then(function () {
    if (seq === openSeq) show(el, path);
  }, function (err) {
    if (seq !== openSeq) return;
    showOops(el, err, function () { open(el, path); });
  });
}

APP.registerSection({
  id: 'view',
  title: 'Viewer',
  mount: function (el, route) {
    hostEl = el;
    el.classList.add('v2-viewsec');
    build(el);
    var rest = (route && route.params && route.params.rest) || '';
    if (!rest) {
      showEmpty(el, 'Nothing is open in the viewer. Films and the Model Room are in the Library.', '#library', 'Go to the Library');
      return;
    }
    var u;
    try { u = new URL(rest, scope()); } catch (e) { u = null; }
    var c = u && classify(u);
    if (!c) {
      if (u && sitePath(u) != null && !/^(https?:)?\/\//i.test(rest)) {
        /* ours but not a film or an object: show it all the same, once it is there */
        open(el, rest.replace(/^\/+/, ''));
        return;
      }
      showEmpty(el, 'That page does not open here.', null);
      return;
    }
    if (c.kind === 'shell') { APP.navigate(c.hash || 'today', { replace: true }); return; }
    if (c.kind === 'lab') { window.location.href = c.href; return; }
    open(el, c.path);
  },
  unmount: function () {
    /* one live viewer page at a time, and none in the background: a film keeps
       its sound and a 3D room its GPU until the frame is gone */
    openSeq++;
    dropFrame();
    if (hostEl) dropOops(hostEl);
  }
});

APP.viewer = {
  open: function (path) { APP.navigate(APP.viewHref(path)); },
  close: function () {
    var back = lastOutside;
    if (!back || /^view\//.test(back)) back = 'library';
    var e = APP.entry ? APP.entry() : null;
    if (!APP.backTo || selfNav || !e || e.from == null) { APP.navigate(back, { replace: true }); return; }
    APP.backTo(back, framePushes);
    /* the safety net: a history entry of the frame's own that went unseen keeps
       Back inside the viewer; then close by replacing this entry after all */
    setTimeout(function () {
      if (/^#view\//.test(location.hash)) APP.navigate(back, { replace: true });
    }, 800);
  },
  path: function () {
    var r = APP.route && APP.route();
    return r && r.section === 'view' ? (r.params.rest || null) : null;
  },
  route: function (url) {
    try { var c = classify(new URL(url, scope())); return c ? c.kind : null; } catch (e) { return null; }
  },
  frame: function () { return frame; }
};
