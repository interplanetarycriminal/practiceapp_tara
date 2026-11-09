/* objects/hook.js: joins Object Lessons (the 3D layer) to the app shell without
   touching the generated shell code. Puts a 2D | 3D toggle in the top bar and,
   in V1, a "3D" item in the nav. Flipping to 3D remembers where you were
   (sessionStorage tara.dim.back) so the 2D side of the toggle brings you back, and
   lands on the matching object: a TARA week (#today/week-NN, #weeks/N, #plan/week-N,
   #packs/week-NN) opens that week's bay in the Model Room, a pack (#week-NN, ids
   in the original ARENA numbering, which is also the bay number) opens its bay, and
   a demo, case or map node opens the object that covers it.

   V2 (window.TARA_SHELL === 'v2', next.html): no nav item; the pill sits in the
   bar's #v2-dimslot and 3D opens inside the shell's viewer (#view/objects/...),
   so the chrome, the session timer and Back keep working. 2D closes the viewer
   and goes back to where 3D was pressed. On a phone only the 3D half shows (a
   toggle; the 2D state is the app itself). A film open in the viewer opens its
   own twin (objects.json `film`), a concept film its concept's object; any
   other page in the viewer opens the Model Room. Without the flag (V1, index.html)
   everything behaves exactly as before. */
(function () {
  var V2 = window.TARA_SHELL === 'v2';
  var REG = []; var NODES = {};
  function css() {
    if (document.getElementById('dim-toggle-css')) return;
    var s = document.createElement('style'); s.id = 'dim-toggle-css';
    s.textContent = V2
      /* V2: the bar's own CSS (src/v2/chrome.css) styles the pill; only the phone rule lives here */
      ? '@media (max-width:899.98px){#dim-toggle [data-dim="2d"]{display:none}}'
      : '.dim-toggle{display:inline-flex;gap:2px;padding:2px;background:var(--surface);border:1px solid var(--rule);border-radius:999px;flex:0 0 auto}' +
      '.dim-toggle a,.dim-toggle button{font:600 12.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:7px 11px;border-radius:999px;color:var(--app-muted,#5c6270);background:transparent;border:0;text-decoration:none;cursor:pointer}' +
      '.dim-toggle [aria-pressed="true"]{background:var(--accent);color:var(--surface)}' +
      '.dim-toggle button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      /* Phones: let the search box give up the room the toggle needs, never the page width. */
      '@media (max-width:760px){.app-tools{flex:1 1 auto;min-width:0;justify-content:flex-end}' +
      '.app-searchform{flex:1 1 auto;min-width:0;display:flex;justify-content:flex-end}' +
      '.app-searchbox{width:100%;max-width:120px;min-width:0}.dim-toggle a,.dim-toggle button{padding:7px 9px}}' +
      '@media (max-width:380px){.app-tools{gap:6px}.dim-toggle a,.dim-toggle button{padding:7px 7px}}';
    document.head.appendChild(s);
  }
  function ready(o) { return o && o.ready !== false; }
  function find(test) {
    var hit = null;
    for (var i = 0; i < REG.length; i++) {
      var o = REG[i];
      if (!ready(o) || !test(o)) continue;
      if (!hit || (hit.kind !== 'weekly' && o.kind === 'weekly')) hit = o;
    }
    return hit;
  }
  function pad2(n) { n = String(Number(n)); return (n.length < 2 ? '0' : '') + n; }
  function target() {
    var h = location.hash || '#today', m, o;
    if ((m = h.match(/^#(?:today|packs)\/week-(\d{1,2})/))) return 'objects/index.html#week-' + (m[1].length < 2 ? '0' : '') + m[1];
    if ((m = h.match(/^#plan\/w(?:eek)?-?(\d{1,2})$/))) return 'objects/index.html#week-' + (m[1].length < 2 ? '0' : '') + m[1];
    if (V2 && (m = h.match(/^#weeks\/(\d{1,2})(?:\/|$)/))) return 'objects/index.html#week-' + pad2(m[1]);
    if (V2 && /^#(today)?$/.test(h)) {
      /* Today is about the next Saturday: open that week's bay */
      try { var t = window.APP && APP.v2now && APP.v2now(); if (t && t.target) return 'objects/index.html#week-' + pad2(t.target.n); } catch (e) {}
    }
    if (V2 && (m = h.match(/^#view\/intuition\/(films\/[^?#]+\.html)/))) {
      /* a film in the viewer: its own twin (objects.json pairs them by `film`) */
      var fm = m[1];
      o = find(function (x) { return x.film === fm; });
      return o ? 'objects/' + o.path : 'objects/index.html';
    }
    if (V2 && (m = h.match(/^#view\/intuition\/node\.html\?(?:[^#]*&)?id=([\w-]+)/))) {
      /* a concept film: the concept's own 3D twin (intuition/nodes/index.json) */
      return NODES[m[1]] ? 'objects/' + NODES[m[1]] : 'objects/index.html';
    }
    if ((m = h.match(/^#(?:drill\/)?week-(\d\d)/))) return 'objects/index.html#bay-' + m[1];
    if (/^#(?:drill\/)?(?:week-)?capstone-weeks-12-14/.test(h)) return 'objects/index.html#bay-14';
    if (/^#(?:drill\/)?(?:week-)?alignment-science/.test(h)) return 'objects/index.html#bay-12';
    if ((m = h.match(/^#demo\/([\w-]+)/))) o = find(function (x) { return x.demo === m[1]; });
    else if ((m = h.match(/^#cases\/([\w-]+)/))) o = find(function (x) { return (x.concepts || []).indexOf(m[1]) >= 0; });
    else if ((m = h.match(/^#map\/node=([\w-]+)/))) {
      if (NODES[m[1]]) return 'objects/' + NODES[m[1]];   // the node's own 3D twin
      o = find(function (x) { return (x.map || []).indexOf(m[1]) >= 0; });
    }
    return o ? 'objects/' + o.path : 'objects/index.html';
  }
  /* V2: is the viewer showing a 3D page right now? */
  function in3d() { return V2 && /^#view\/objects\//.test(location.hash || ''); }
  function go3d() {
    if (V2) {
      if (in3d()) { go2d(); return; }
      try { sessionStorage.setItem('tara.dim.back', location.hash || '#today'); } catch (e) {}
      if (window.APP && APP.navigate) { APP.navigate('view/' + target()); return; }
    }
    try { sessionStorage.setItem('tara.dim.back', location.hash || '#today'); } catch (e) {}
    location.href = target();
  }
  function go2d() {
    if (!in3d()) return;
    var back = null;
    try { back = sessionStorage.getItem('tara.dim.back'); } catch (e) {}
    /* back to where 3D was pressed: a film in the viewer too, never a 3D page */
    if (!back || /^#?view\/objects\//.test(back)) back = '#today';
    if (window.APP && APP.navigate) APP.navigate(back.replace(/^#/, ''));
    else location.hash = back;
  }
  function paint() {
    var pill = document.getElementById('dim-toggle');
    if (!pill || !V2) return;
    var on3 = in3d();
    var b2 = pill.querySelector('[data-dim="2d"]'), b3 = pill.querySelector('[data-dim="3d"]');
    if (b2) { b2.setAttribute('aria-pressed', on3 ? 'false' : 'true'); b2.title = on3 ? 'Back to the 2D app' : 'You are in the 2D app'; }
    if (b3) {
      b3.setAttribute('aria-pressed', on3 ? 'true' : 'false');
      b3.title = on3 ? 'Leave 3D, back to the 2D app' : 'Open this in 3D (Object Lessons)';
      b3.setAttribute('aria-label', on3 ? '3D is on. Back to 2D' : 'Open this in 3D');
    }
  }
  function mount() {
    var slot = V2 ? (document.getElementById('v2-dimslot') || document.querySelector('.app-tools')) : document.querySelector('.app-tools');
    if (!slot) return false;
    if (document.getElementById('dim-toggle')) return true;
    css();
    var pill = document.createElement('div');
    pill.className = V2 ? 'dim-toggle fu-seg' : 'dim-toggle'; pill.id = 'dim-toggle';
    pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'View in 2D or 3D');
    var b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '2D';
    b2.setAttribute('data-dim', '2d');
    b2.setAttribute('aria-pressed', 'true'); b2.title = 'You are in the 2D app';
    var b3 = document.createElement('button'); b3.type = 'button'; b3.textContent = '3D';
    b3.setAttribute('data-dim', '3d');
    b3.setAttribute('aria-pressed', 'false'); b3.title = 'Open this in 3D (Object Lessons)';
    b3.onclick = go3d;
    if (V2) b2.onclick = go2d;
    if (V2) { b2.className = 'fu-seg__opt'; b3.className = 'fu-seg__opt'; }
    pill.appendChild(b2); pill.appendChild(b3);
    slot.appendChild(pill);
    paint();
    return true;
  }
  function addNav() {
    if (V2) return true;                          /* V2 has five tabs and no nav list */
    var list = document.getElementById('app-navlist');
    if (!list || !list.children.length) return false;
    if (document.getElementById('app-nav-3d')) return true;
    var li = document.createElement('li'); li.className = 'app-navitem';
    var a = document.createElement('a'); a.className = 'app-navlink'; a.id = 'app-nav-3d';
    a.href = 'objects/index.html'; a.textContent = '3D';
    a.onclick = function () { try { sessionStorage.setItem('tara.dim.back', location.hash || '#today'); } catch (e) {} };
    li.appendChild(a);
    var films = document.getElementById('app-nav-films');
    var after = films ? films.parentNode.nextSibling : (list.children[1] || null);
    list.insertBefore(li, after);
    return true;
  }
  function start() {
    var n = 0, iv = setInterval(function () {
      var ok = mount() & addNav();
      if (ok || ++n > 80) clearInterval(iv);
    }, 100);
    if (V2) addEventListener('hashchange', paint);
    fetch('objects/objects.json').then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) { REG = Array.isArray(j) ? j : []; }).catch(function () {});
    fetch('intuition/nodes/index.json').then(function (r) { return r.ok ? r.json() : { nodes: [] }; })
      .then(function (j) { (j.nodes || []).forEach(function (n) { if (n.object) NODES[n.id] = n.object; }); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
