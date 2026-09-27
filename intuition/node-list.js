/* node-list.js: the "Every concept" list shared by the Films hub and the Model Room.
   NodeList.mount(host, {mode: 'film' | 'object', index: 'nodes/index.json',
   film: prefix to intuition/, object: prefix to objects/}). Reads the index built from
   the concept map plus the node scripts, grouped by Saturday in course order. */
(function () {
  'use strict';
  var NEED = { core: 'core', exercise: 'exercise', library: 'library call', contested: 'open question' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var CSS = '.nl{margin:8px 0 28px}.nl h3{margin:18px 0 6px;font-size:19px}.nl h3 small{font:400 13px system-ui,sans-serif;opacity:.7;margin-left:6px}' +
    '.nl ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px}' +
    '.nl li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(127,117,140,.35);border-radius:10px;min-height:44px;box-sizing:border-box}' +
    '.nl li a.m{flex:1;min-width:0;color:inherit;text-decoration:none;display:flex;flex-direction:column}' +
    '.nl li a.m b{font-weight:650;font-size:14.5px}.nl li a.m span{font-size:12.5px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.nl li a.alt{flex:none;font:600 12px system-ui,sans-serif;text-decoration:none;color:inherit;border:1px solid rgba(127,117,140,.5);border-radius:999px;padding:6px 9px}' +
    '.nl li i{flex:none;font:600 10.5px system-ui,sans-serif;font-style:normal;padding:3px 6px;border-radius:4px;background:rgba(247,227,160,.55);color:#2b2a33}' +
    '.nl li i.library{background:rgba(169,201,239,.6)}.nl li i.contested{background:rgba(243,179,195,.6)}.nl li i.exercise{background:rgba(185,227,204,.65)}' +
    '.nl li.wait{opacity:.55}.nl li.wait a.m{pointer-events:none}.nl .nl-q{width:100%;max-width:420px;box-sizing:border-box;font:15px system-ui,sans-serif;padding:9px 12px;border-radius:10px;border:1px solid rgba(127,117,140,.5);background:transparent;color:inherit;margin:4px 0 6px}';
  function mount(host, o) {
    if (!host) return;
    o = o || {};
    if (!document.getElementById('nl-css')) { var st = document.createElement('style'); st.id = 'nl-css'; st.textContent = CSS; document.head.appendChild(st); }
    var film = o.film || '', obj = o.object || '../objects/';
    fetch(o.index || 'nodes/index.json').then(function (r) { return r.ok ? r.json() : { nodes: [] }; }).then(function (idx) {
      var nodes = (idx.nodes || []).slice().sort(function (a, b) { return ((a.week || 99) - (b.week || 99)) || ((a.order || 0) - (b.order || 0)); });
      var ready = nodes.filter(function (n) { return o.mode === 'object' ? n.object : n.film; }).length;
      var groups = {}, order = [];
      nodes.forEach(function (n) { var k = n.week ? 'Week ' + n.week : 'Alignment science and background'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(n); });
      var thing = o.mode === 'object' ? '3D twin' : 'film';
      var html = '<p class="nl-sum">' + (ready === nodes.length ? 'Every one of the ' + nodes.length + ' concepts on the map has its own ' + thing + '.' : ready + ' of ' + nodes.length + ' concepts on the map have their own ' + thing + ' so far.') +
        (o.mode === 'object' ? ' Each twin has a film to go with it, and each film ends in something you can play with.' : ' Each film ends in something you can play with, and each has a 3D twin.') + '</p>' +
        '<input class="nl-q" type="search" placeholder="Find a concept, e.g. softmax, LoRA, SAE" aria-label="Find a concept">';
      order.forEach(function (k) {
        var g = groups[k], got = g.filter(function (n) { return o.mode === 'object' ? n.object : n.film; }).length;
        html += '<h3>' + esc(k) + '<small>' + got + ' of ' + g.length + '</small></h3><ul>';
        g.forEach(function (n) {
          var main = o.mode === 'object' ? n.object && (obj + n.object) : n.film && (film + n.film);
          var alt = o.mode === 'object' ? n.film && (film + n.film) : n.object && (obj + n.object);
          html += '<li class="' + (main ? '' : 'wait') + '" data-q="' + esc((n.label + ' ' + (n.title || '') + ' ' + n.id).toLowerCase()) + '">' +
            '<a class="m" href="' + esc(main || '#') + '"><b>' + esc(n.label) + '</b><span>' + esc(main ? (o.mode === 'object' ? (n.object_title || n.title) : n.title) : 'being written') + '</span></a>' +
            (n.need && main ? '<i class="' + esc(n.need) + '">' + esc(NEED[n.need] || n.need) + '</i>' : '') +
            (alt && main ? '<a class="alt" href="' + esc(alt) + '">' + (o.mode === 'object' ? 'Film' : '3D') + '</a>' : '') + '</li>';
        });
        html += '</ul>';
      });
      host.innerHTML = html; host.classList.add('nl');
      var q = host.querySelector('.nl-q');
      q.addEventListener('input', function () {
        var v = q.value.trim().toLowerCase();
        [].forEach.call(host.querySelectorAll('li'), function (li) { li.hidden = !!v && li.getAttribute('data-q').indexOf(v) < 0; });
        [].forEach.call(host.querySelectorAll('ul'), function (ul) { var any = [].some.call(ul.children, function (li) { return !li.hidden; }); ul.hidden = !any; ul.previousElementSibling.hidden = !any; });
      });
      if (location.hash === '#concepts') setTimeout(function () { host.scrollIntoView({ block: 'start' }); }, 50);
    }).catch(function () { host.textContent = 'The concept list could not load. Check your connection and try again.'; });
  }
  window.NodeList = { mount: mount };
})();
