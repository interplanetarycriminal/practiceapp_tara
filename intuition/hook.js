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
    var h = location.hash || '#today', m = h.match(/^#week-(\d\d)/) || h.match(/^#today\/week-(\d\d)/), w;
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

/* Concept films: every node on the concept map opens its own film and 3D twin.
   Inside the map frame the node panel gets a "Watch the film · Hold it in 3D" row;
   on #map/node=<id> and #cases/<id> the floating chip offers the same two doors. */
(function () {
  var IDX = null, BYLAB = {}, BYID = {}, chip = null, closed = {};
  function load() {
    return fetch('intuition/nodes/index.json').then(function (r) { return r.ok ? r.json() : { nodes: [] }; }).then(function (j) {
      IDX = j.nodes || []; IDX.forEach(function (n) { BYID[n.id] = n; BYLAB[String(n.label).toLowerCase()] = n; });
    }).catch(function () { IDX = []; });
  }
  function hrefs(n) {
    return { film: n.film ? 'intuition/' + n.film : null, obj: n.object ? 'objects/' + n.object : null };
  }
  function row(doc, n) {
    var h = hrefs(n), d = doc.createElement('div'); d.className = 'nf-doors';
    d.setAttribute('style', 'display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px');
    var css = 'display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:6px 12px;border-radius:999px;font:600 13px/1.2 system-ui,sans-serif;text-decoration:none;';
    if (h.film) { var a = doc.createElement('a'); a.href = new URL(h.film, location.href).href; a.target = '_top'; a.textContent = '▶ Watch the film'; a.title = n.title || ''; a.setAttribute('style', css + 'background:#1c2140;color:#f7e3a0'); d.appendChild(a); }
    if (h.obj) { var b = doc.createElement('a'); b.href = new URL(h.obj, location.href).href; b.target = '_top'; b.textContent = 'Hold it in 3D'; b.setAttribute('style', css + 'background:#f2ede4;color:#2b2a33;border:1px solid #d9cdb8'); d.appendChild(b); }
    if (!h.film && !h.obj) { var w = doc.createElement('span'); w.textContent = 'Film and 3D twin: being written'; w.setAttribute('style', 'font:12.5px system-ui,sans-serif;opacity:.65'); d.appendChild(w); }
    return d;
  }
  function decorate(doc) {
    var panel = doc.getElementById('panel'); if (!panel || !IDX) return;
    var h1 = panel.querySelector('.pname'); if (!h1 || panel.querySelector('.nf-doors')) return;
    var n = BYLAB[h1.textContent.trim().toLowerCase()]; if (!n) return;
    var plain = panel.querySelector('.plain') || h1; plain.parentNode.insertBefore(row(doc, n), plain.nextSibling);
  }
  function watchFrames() {
    [].forEach.call(document.querySelectorAll('iframe'), function (f) {
      var doc; try { doc = f.contentDocument; } catch (e) { return; }
      if (!doc || f.__nfWatched === doc) return;
      var panel = doc.getElementById('panel'); if (!panel) return;
      f.__nfWatched = doc;
      new MutationObserver(function () { decorate(doc); }).observe(panel, { childList: true });
      decorate(doc);
    });
  }
  function pickNode() {
    var h = location.hash || '', m = h.match(/^#cases\/([a-z0-9-]+)/);   // map nodes get doors in their own panel
    if (!m) return null; var id; try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
    return BYID[id] || null;
  }
  function paintChip() {
    var n = IDX && pickNode(), h = n && hrefs(n);
    if (!n || !h.film || closed[n.id]) { if (chip) chip.hidden = true; return; }
    var weekChip = document.getElementById('intuition-chip'); if (weekChip) weekChip.hidden = true;
    if (!chip) {
      chip = document.createElement('div'); chip.id = 'node-film-chip';
      chip.setAttribute('style', 'position:fixed;z-index:69;left:14px;bottom:14px;display:flex;align-items:center;gap:6px;' +
        'background:#fff6e6;color:#2b2a33;border:1px solid #e8c9a8;border-radius:999px;padding:4px 6px 4px 12px;' +
        'box-shadow:0 3px 10px rgba(0,0,0,.18);font:600 13px/1.2 system-ui,sans-serif;max-width:calc(100vw - 28px)');
      if (window.matchMedia && matchMedia('(max-width: 720px)').matches) chip.style.bottom = 'calc(62px + env(safe-area-inset-bottom,0px))';
      document.body.appendChild(chip);
    }
    chip.hidden = false; chip.textContent = '';
    var a = document.createElement('a'); a.href = h.film; a.style.cssText = 'color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    a.textContent = '▶ Film: ' + n.label; chip.appendChild(a);
    if (h.obj) { var b = document.createElement('a'); b.href = h.obj; b.textContent = '3D'; b.style.cssText = 'color:#2b2a33;text-decoration:none;border:1px solid #d9cdb8;border-radius:999px;padding:3px 8px;background:#f2ede4'; chip.appendChild(b); }
    var x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Hide film chip'); x.textContent = '×';
    x.style.cssText = 'border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#8a7a6a;padding:2px 6px';
    x.onclick = function () { closed[n.id] = 1; chip.hidden = true; }; chip.appendChild(x);
  }
  function start() {
    load().then(function () { paintChip(); watchFrames(); });
    addEventListener('hashchange', function () { setTimeout(paintChip, 30); setTimeout(watchFrames, 400); });
    setInterval(watchFrames, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
