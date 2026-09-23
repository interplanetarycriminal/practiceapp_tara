/* objects/hook.js: joins Object Lessons (the 3D layer) to the app shell without
   touching the generated shell code. Puts a 2D | 3D toggle at the far right of the
   top bar and a "3D" item in the nav. Flipping to 3D remembers where you were
   (sessionStorage tara.dim.back) so the 2D side of the toggle brings you back, and
   lands on the matching object: #week-NN opens that week's bay in the Model Room,
   a demo, case or map node opens the object that covers it. */
(function () {
  var REG = [];
  function css() {
    if (document.getElementById('dim-toggle-css')) return;
    var s = document.createElement('style'); s.id = 'dim-toggle-css';
    s.textContent =
      '.dim-toggle{display:inline-flex;gap:2px;padding:2px;background:var(--surface);border:1px solid var(--rule);border-radius:999px;flex:0 0 auto}' +
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
  function target() {
    var h = location.hash || '#today', m, o;
    if ((m = h.match(/^#week-(\d\d)/))) return 'objects/index.html#week-' + m[1];
    if ((m = h.match(/^#demo\/([\w-]+)/))) o = find(function (x) { return x.demo === m[1]; });
    else if ((m = h.match(/^#cases\/([\w-]+)/))) o = find(function (x) { return (x.concepts || []).indexOf(m[1]) >= 0; });
    else if ((m = h.match(/^#map\/node=([\w-]+)/))) o = find(function (x) { return (x.map || []).indexOf(m[1]) >= 0; });
    else if ((m = h.match(/^#drill\/week-(\d\d)/))) return 'objects/index.html#week-' + m[1];
    return o ? 'objects/' + o.path : 'objects/index.html';
  }
  function go3d() {
    try { sessionStorage.setItem('tara.dim.back', location.hash || '#today'); } catch (e) {}
    location.href = target();
  }
  function mount() {
    var tools = document.querySelector('.app-tools');
    if (!tools) return false;
    if (document.getElementById('dim-toggle')) return true;
    css();
    var pill = document.createElement('div');
    pill.className = 'dim-toggle'; pill.id = 'dim-toggle';
    pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'View in 2D or 3D');
    var b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '2D';
    b2.setAttribute('aria-pressed', 'true'); b2.title = 'You are in the 2D app';
    var b3 = document.createElement('button'); b3.type = 'button'; b3.textContent = '3D';
    b3.setAttribute('aria-pressed', 'false'); b3.title = 'Open this in 3D (Object Lessons)';
    b3.onclick = go3d;
    pill.appendChild(b2); pill.appendChild(b3);
    tools.appendChild(pill);
    return true;
  }
  function addNav() {
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
    fetch('objects/objects.json').then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) { REG = Array.isArray(j) ? j : []; }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
