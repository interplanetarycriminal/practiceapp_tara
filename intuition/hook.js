/* intuition/hook.js: joins the Intuition films to the app shell without touching
   the generated shell code. Adds a "Films" nav item and a floating "this week's
   film" chip on #today and #week-NN. Fixed-position, so it never moves layout. */
(function () {
  var FILMS = null, chip = null, closed = {};
  function weekNow() {
    var t0 = Date.parse('2026-09-12T00:00:00+10:00'), d = (Date.now() - t0) / 864e5;
    return Math.max(1, Math.min(14, Math.floor(d / 7) + 1 + (d % 7 > 0.5 ? 1 : 0)));
  }
  function addNav() {
    var list = document.getElementById('app-navlist');
    if (!list || !list.children.length || document.getElementById('app-nav-films')) return !!list && !!list.children.length;
    var li = document.createElement('li'); li.className = 'app-navitem';
    var a = document.createElement('a'); a.className = 'app-navlink'; a.id = 'app-nav-films';
    a.href = 'intuition/index.html'; a.textContent = 'Films';
    li.appendChild(a); list.insertBefore(li, list.children[1] || null);
    return true;
  }
  function pick() {
    if (!FILMS) return null;
    var h = location.hash || '#today', m = h.match(/^#week-(\d\d)/), w;
    if (m) w = Number(m[1]); else if (/^#today|^$/.test(h)) w = weekNow(); else return null;
    for (var i = 0; i < FILMS.length; i++) if (Number(FILMS[i].week) === w) return FILMS[i];
    if (!m) for (var j = 0; j < FILMS.length; j++) if (FILMS[j].id === 'north-star') return FILMS[j];
    return null;
  }
  function paint() {
    var f = pick();
    if (!f || closed[f.id]) { if (chip) chip.hidden = true; return; }
    if (!chip) {
      chip = document.createElement('div'); chip.id = 'intuition-chip';
      chip.setAttribute('style', 'position:fixed;z-index:69;left:14px;bottom:14px;display:flex;align-items:center;gap:6px;' +
        'background:#fff6e6;color:#2b2a33;border:1px solid #e8c9a8;border-radius:999px;padding:4px 6px 4px 12px;' +
        'box-shadow:0 3px 10px rgba(0,0,0,.18);font:600 13px/1.2 system-ui,sans-serif;max-width:calc(100vw - 28px)');
      if (window.matchMedia && matchMedia('(max-width: 720px)').matches) chip.style.bottom = 'calc(62px + env(safe-area-inset-bottom,0px))';
      document.body.appendChild(chip);
    }
    chip.hidden = false; chip.textContent = '';
    var a = document.createElement('a'); a.href = 'intuition/' + f.path; a.style.cssText = 'color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    a.textContent = '▶ Film: ' + f.title;
    var x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Hide film chip'); x.textContent = '×';
    x.style.cssText = 'border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#8a7a6a;padding:2px 6px';
    x.onclick = function () { closed[f.id] = 1; chip.hidden = true; };
    chip.appendChild(a); chip.appendChild(x);
  }
  function start() {
    var n = 0, iv = setInterval(function () { if (addNav() || ++n > 80) clearInterval(iv); }, 100);
    fetch('intuition/films.json').then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) { FILMS = Array.isArray(j) ? j : []; paint(); }).catch(function () {});
    addEventListener('hashchange', paint);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
