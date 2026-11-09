/* ==========================================================================
   sections/packs.js — the 13 study packs, and the frame kit the other five
   framed sections share.

   Loaded first of Worker B's files (build order in SPEC §3 step 5), so the kit
   is installed on window.__TARA_FK before demos/plan/sprint/manual/map run.
   Every consumer reaches it as window.__TARA_FK at *call* time, never at file
   scope, so build order can change without breaking anything.
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  if (window.__TARA_FK) return;

  /* --------------------------------------------------------------- tables */

  /* label = the TARA week(s) the pack serves, in TARA's own order (26 Oct 2026).
     The live label comes from calendar.md via APP.weeksOfPack (packLabel below);
     these are the fallback. Slugs are stable content ids, not week numbers. */
  var PACKS = [
    { slug: 'week-01', label: 'Week 0',  title: 'Einops and Ray Tracing',              sub: '[0.0] Prerequisites · [0.1] Ray Tracing' },
    { slug: 'week-02', label: 'Week 1',  title: 'Modules and ResNets',                 sub: '[0.2] CNNs & ResNets' },
    { slug: 'week-03', label: 'Week 1',  title: 'Optimizers and Sweeps',               sub: '[0.3] Optimization' },
    { slug: 'week-04', label: 'Week 1',  title: 'Your Own Autograd',                   sub: '[0.4] Backprop · [0.5] VAEs & GANs (optional)' },
    { slug: 'week-05', label: 'Week 2',  title: 'Transformer From Scratch',            sub: '[1.1] Transformer from Scratch' },
    { slug: 'week-06', label: 'Week 3',  title: 'Hooks and the Cache',                 sub: '[1.2] §1–3 · TransformerLens, induction heads, hooks' },
    { slug: 'week-07', label: 'Weeks 3–4', title: 'Induction Circuits and Patching',   sub: '[1.2] §4 circuits · [1.4.1] IOI & path patching' },
    { slug: 'week-08', label: 'Week 4',  title: 'Superposition and Sparse Autoencoders', sub: '[1.5.4] Superposition · [1.3.3] SAEs' },
    { slug: 'week-09', label: 'Week 5',  title: 'Value Functions and DQN',             sub: '[2.1] Intro to RL · [2.2.1] DQN' },
    { slug: 'week-10', label: 'Week 6',  title: 'Policy Gradients, PPO and RLHF',      sub: '[2.2.2] VPG · [2.3] PPO · [2.4] RLHF' },
    { slug: 'week-11', label: 'Weeks 7–9', title: 'Eval Design and Inspect',           sub: '[3.1]–[3.3] in depth · [3.4] agents and [3.5] AI control in brief' },
    { slug: 'alignment-science',    label: 'Weeks 10–11', title: 'Model Organisms and Open Problems', sub: '[4.1]–[4.5] alignment science · capstone quarry' },
    { slug: 'capstone-weeks-12-14', label: 'Weeks 12–14', title: 'Three Saturdays and a Talk',        sub: 'project phase · final presentation 12 Dec' }
  ];

  /* weeks = TARA weeks (fallback; live from calendar.md via APP.weeksOfDemo) */
  var DEMOS = [
    { slug: 'tensors-einops',           title: 'Einops Bench',                     weeks: [0] },
    { slug: 'convolutions-cnn',         title: 'Sliding Window Lab',               weeks: [1] },
    { slug: 'backprop-training',        title: 'Backprop Bench',                   weeks: [1] },
    { slug: 'transformer-block',        title: 'Residual Stream Anatomy',          weeks: [2] },
    { slug: 'sampling-decoding',        title: "Decoder's Bench",                  weeks: [2] },
    { slug: 'residual-stream-bus',      title: 'Residual Stream Bus',              weeks: [2, 3] },
    { slug: 'induction-heads-patching', title: 'Induction Circuit Workbench',      weeks: [3, 4] },
    { slug: 'superposition-sae',        title: 'Superposition Bench',              weeks: [4] },
    { slug: 'rl-foundations-dqn',       title: 'Bellman to DQN',                   weeks: [5] },
    { slug: 'policy-gradients-ppo',     title: 'Reading the PPO Objective',        weeks: [6] },
    { slug: 'rlhf-overoptimisation',    title: 'The Overoptimisation Curve',       weeks: [6] },
    { slug: 'evals-pipeline',           title: 'The Measurement Is Not the Property', weeks: [7, 8, 9] },
    { slug: 'steering-persona-vectors', title: 'Persona Vector Bench',             weeks: [10, 11] }
  ];

  /* Published-artifact uuid -> the route that now holds that page. Used only to
     keep clicks *inside* the app; nothing is rewritten in the stored bytes. */
  var URL2HASH = {
    'e79da475-aeb2-4350-a639-9be5b33eac50': '#week-01',
    'ab7159ab-c864-42c0-89de-41d0b340f0f6': '#week-02',
    '05bc0689-0163-428a-a580-ff3d539dbc10': '#week-03',
    'fb6e3102-08fe-41b7-a11c-f871e47c07b0': '#week-04',
    'b6eb1f5b-bbb5-476d-8e19-fb6bd2a4ad50': '#week-05',
    '7d8c5235-ecbe-4d31-b424-32a6f57bec73': '#week-06',
    'a7d50b7a-ac24-4365-8b81-b6eaa641de90': '#week-07',
    '9d492ed6-53c0-48e2-847e-000cf294bc59': '#week-08',
    '641c5d41-6744-4dda-aba1-c285e481ffc2': '#week-09',
    '12b22ee1-7be6-452c-a680-887437324f52': '#week-10',
    'ac4e396c-17d0-4e54-9864-387098d15e46': '#week-11',
    '737542f2-9ee3-4283-8676-340bc452c1b3': '#week-alignment-science',
    '523921d4-9788-4819-a3fe-4fe23c3bdf86': '#week-capstone-weeks-12-14',
    '920e23ec-256b-4f12-ae2e-cd9605ae08b8': '#demo/tensors-einops',
    '6a9118aa-9dbb-4e5a-8c32-0c6b7993730b': '#demo/convolutions-cnn',
    'd7d20812-f5b9-4d0c-820f-97c4e37aebd8': '#demo/backprop-training',
    'ca51b950-60f1-46cb-96fa-c62d1cd891e1': '#demo/transformer-block',
    'fb72d423-a493-47d6-bce4-669c9ada6b1d': '#demo/sampling-decoding',
    'efbf7372-bec0-4067-a650-898b543ba0ff': '#demo/residual-stream-bus',
    'd7cf4c22-2ff8-4502-8755-2823aa26bb85': '#demo/induction-heads-patching',
    'adefe783-4539-456d-bec9-5b3a6999f50a': '#demo/superposition-sae',
    '136bb50c-0a86-4129-95d0-c68d95c556be': '#demo/rl-foundations-dqn',
    'fe068b1c-e5e3-4883-ad00-9c2d8064eb86': '#demo/policy-gradients-ppo',
    '3f01988f-2fa3-4e57-b896-cc9823cbc9b6': '#demo/rlhf-overoptimisation',
    'b2724f82-2b83-442d-814a-c8fcf8c37791': '#demo/evals-pipeline',
    '30e29e60-dcb6-41f7-ba2d-d434bc2a0af5': '#demo/steering-persona-vectors',
    '2387b9cb-110d-49b5-b772-ded4804682a8': '#plan',
    '344077c2-aff3-49ea-be40-5a39844a698e': '#map',
    'f40cee0d-e9eb-4cd6-a410-1411bb4f4c30': '#cases',
    '438d8cfc-21dd-4b71-a51b-bc64923e8bc2': '#drill',
    'ca2002f6-eb38-447d-82c7-e2ac9961546a': '#sprint',
    '7ffef4c4-c902-4d05-95c7-a9aae13624d8': '#manual',
    '267222f4-202c-4030-9e9a-4924592f3df3': '#manual'
  };

  var PACK_BY = {}, DEMO_BY = {};
  PACKS.forEach(function (p, i) { p.order = i; PACK_BY[p.slug] = p; });
  DEMOS.forEach(function (d, i) { d.order = i; DEMO_BY[d.slug] = d; });

  /* Live week labels from the schedule (calendar.md), falling back to the tables. */
  function packWeeks(slug) {
    var ns = (window.APP && APP.weeksOfPack) ? APP.weeksOfPack(slug) : [];
    return ns.length ? ns : null;
  }
  function packLabel(slug) {
    var p = PACK_BY[slug], ns = packWeeks(slug);
    return ns ? APP.weekSpan(ns) : (p ? p.label : slug);
  }
  function demoWeeks(slug) {
    var ns = (window.APP && APP.weeksOfDemo) ? APP.weeksOfDemo(slug) : [];
    var d = DEMO_BY[slug];
    return ns.length ? ns : (d ? d.weeks : []);
  }

  /* ---------------------------------------------------------- string bits */

  function scriptSafe(s) {
    return String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  }
  function jsonLit(v) { return scriptSafe(JSON.stringify(v === undefined ? null : v)); }

  /* Several demos call history.replaceState('#tab') to remember a tab. Inside an
     `about:srcdoc` frame that throws (the document has no usable URL to rewrite)
     and the page logs an uncaught error on every tab click. Turning both history
     writers into no-ops before any of the page's own script runs costs nothing —
     the frame has no address bar to keep in sync — and the tab still switches. */
  var PRELUDE =
    '<script>/*app*/try{history.replaceState=function(){};history.pushState=function(){};}' +
    'catch(e){}<\/script>';

  /* V2: a pack's check questions answer 1-9 only once the learner chose them. The
     quiz engine focuses its quiz on every render (this.el.focus, preventScroll), so
     on opening a pack the focus sat in a quiz far below the fold and the tier keys
     answered questions nobody had seen (recorded as wrong answers, then imported by
     Recall). This gate runs before the engine: a press inside a quiz arms it (a
     press anywhere else disarms it), a Tab into it arms it, and any other focus that
     lands in an unarmed quiz is blurred back to the document. A digit that still
     reaches an unarmed quiz never gets to it (the shell's tier keys, on the document
     in capture, have already taken it). shell.js and chrome.js read the same mark. */
  var QUIZ_GATE =
    '<script>/*app: quiz gate*/(function(){' +
    'var tabAt=0;' +
    'function quiz(n){try{return n&&n.closest?n.closest(".tara-quiz"):null;}catch(e){return null;}}' +
    'function topTab(){try{var A=window.parent&&window.parent.APP;return (A&&A._tabAt)||0;}catch(e){return 0;}}' +
    'document.addEventListener("keydown",function(e){if(e.key==="Tab")tabAt=Date.now();},true);' +
    'document.addEventListener("pointerdown",function(e){' +
    'var q=quiz(e.target),on=document.querySelectorAll(".tara-quiz[data-v2-armed]");' +
    'for(var i=0;i<on.length;i++)if(on[i]!==q)on[i].removeAttribute("data-v2-armed");' +
    'if(q)q.setAttribute("data-v2-armed","1");},true);' +
    'document.addEventListener("focusin",function(e){' +
    'var q=quiz(e.target);if(!q||q.hasAttribute("data-v2-armed"))return;' +
    'if(Date.now()-Math.max(tabAt,topTab())<1000){q.setAttribute("data-v2-armed","1");return;}' +
    'try{e.target.blur();}catch(x){}},true);' +
    'document.documentElement.addEventListener("keydown",function(e){' +
    'if(e.metaKey||e.ctrlKey||e.altKey||!/^[1-9]$/.test(e.key||""))return;' +
    'var q=quiz(e.target);if(q&&!q.hasAttribute("data-v2-armed"))e.stopPropagation();},true);' +
    '})();<\/script>';
  /* a Tab pressed in the shell that carries the focus into a pack counts too */
  if (window.TARA_SHELL === 'v2') {
    document.addEventListener('keydown', function (e) { if (e.key === 'Tab') APP._tabAt = Date.now(); }, true);
  }

  /* A prelude has to run first. Fragment documents (every pack, every demo, the
     plan, the manual) take it at the very top; a complete document takes it just
     inside <body>, where it still precedes every script the page carries. */
  function prelude(html, extra) {
    var block = PRELUDE + (extra || '');
    var m = /<body[^>]*>/i.exec(html);
    if (m && m.index < 4000) {
      var at = m.index + m[0].length;
      return html.slice(0, at) + '\n' + block + '\n' + html.slice(at);
    }
    return block + '\n' + html;
  }

  /* Insert a block before the last </body>, or append. Same rule as apply.js —
     most packs and demos have no </body> at all. */
  function splice(html, block) {
    var i = html.toLowerCase().lastIndexOf('</body>');
    if (i === -1) return html + '\n' + block + '\n';
    return html.slice(0, i) + block + '\n' + html.slice(i);
  }

  /* The apply.js envelope mapping, ported (SPEC §11). The only deltas: the four
     nav URLs become in-app hashes, because the app is one page now. */
  function envelopeConfig(env) {
    env = env || {};
    var known = ['content', 'explain', 'glossary', 'options', 'mapUrl', 'planUrl',
      'casesUrl', 'drillUrl', 'stickyOffset', 'controlOffset'];
    var isEnvelope = known.some(function (k) {
      return Object.prototype.hasOwnProperty.call(env, k);
    });
    if (!isEnvelope) env = { content: env };

    var options = Object.assign({}, env.options || {});
    var co = Object.assign({}, env.controlOffset || options.controlOffset || {});
    if (Object.keys(co).length) options.controlOffset = co;

    var lines = ['/* per-page content for the TARA reading layer (ported apply.js) */'];
    if (env.content) lines.push('window.TARA_CONTENT=' + jsonLit(env.content) + ';');
    if (env.explain) lines.push('window.TARA_EXPLAIN=' + jsonLit(env.explain) + ';');
    if (env.glossary) lines.push('window.TARA_GLOSSARY_EXTRA=' + jsonLit(env.glossary) + ';');
    if (Object.keys(options).length) lines.push('window.TARA_OPTIONS=' + jsonLit(options) + ';');
    var sticky = env.stickyOffset;
    if (sticky != null && sticky !== '' && !isNaN(parseFloat(sticky))) {
      lines.push('window.TARA_STICKY_OFFSET=' + parseFloat(sticky) + ';');
    }
    return lines;
  }

  /* --------------------------------------------------- the child-side boot */
  /* Runs inside every frame. Same-origin, so it can reach the shell directly. */

  var CHILD_JS = [
    '(function(){',
    '"use strict";',
    'window.__TARA_APP=1;',
    'var P=null; try{ P=(window.parent&&window.parent!==window)?window.parent:null; }catch(e){}',
    'function app(){ try{ return (P&&P.APP)?P.APP:null; }catch(e){ return null; } }',
    'window.__app=app;',

    /* 1. one visible tier control. The layer keeps its glossary popover and its
          select-to-explain popup — those live in the same shadow root as the
          control, so hiding the whole host would take them with it. */
    'function hideChildControl(){',
    '  try{',
    '    var h=document.querySelector("[data-tara-host]");',
    '    if(!h) return false;',
    '    if(h.shadowRoot){',
    '      if(!h.shadowRoot.querySelector("#app-hide-control")){',
    '        var s=document.createElement("style"); s.id="app-hide-control";',
    '        s.textContent=".control,.pill{display:none!important}";',
    '        h.shadowRoot.appendChild(s);',
    '      }',
    '      return true;',
    '    }',
    '    h.style.setProperty("display","none","important"); return true;',
    '  }catch(e){ return false; }',
    '}',
    'window.addEventListener("tara:ready",hideChildControl);',
    'hideChildControl();',
    'var _n=0,_iv=setInterval(function(){ if(hideChildControl()||++_n>60) clearInterval(_iv); },50);',

    /* 2. keep every link inside the app */
    'var U2H=window.__APP_URL2HASH||{};',
    'function hasId(id){ try{ return !!(id&&document.getElementById(id)); }catch(e){ return false; } }',
    'window.__toAppHash=function(href){',
    '  href=String(href||"");',
    '  if(!href) return null;',
    '  var m=/\\/artifact\\/([0-9a-f-]{36})(?:[?][^#]*)?(#.*)?$/i.exec(href);',
    '  if(m){',
    '    var base=U2H[m[1].toLowerCase()]; if(!base) return null;',
    '    var frag=(m[2]||"").replace(/^#/,"");',
    '    if(!frag) return base;',
    '    var f=frag.match(/^node=(.+)$/); if(f) return "#map/node="+f[1];',
    '    var q=frag.match(/^q=(.*)$/);   if(q) return "#map/q="+q[1];',
    '    if(base==="#cases") return "#cases/"+frag;',
    '    if(base==="#drill") return "#drill/"+frag;',
    '    if(base==="#map")   return "#map/node="+frag;',
    '    if(/^#(week-|demo\\/|plan|sprint|manual)/.test(base)) return base+"/"+frag;',
    '    return base;',
    '  }',
    '  if(href.charAt(0)!=="#") return null;',
    '  var h=href.slice(1);',
    '  if(!h) return null;',
    '  var f2=h.match(/^node=(.+)$/); if(f2) return "#map/node="+f2[1];',
    '  var q2=h.match(/^q=(.*)$/);    if(q2) return "#map/q="+q2[1];',
    /*    an in-page anchor that actually exists here always wins */
    '  if(hasId(h)||hasId(decodeURIComponent(h))) return null;',
    '  if(/^(today|plan|packs|demos|map|cases|drill|sprint|manual)(\\/|$)/.test(h)) return "#"+h;',
    '  if(/^(week-|demo-week-|demo\\/)/.test(h)) return "#"+h;',
    '  return null;',
    '};',
    'document.addEventListener("click",function(ev){',
    '  if(ev.defaultPrevented||ev.button||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey) return;',
    '  var path=ev.composedPath?ev.composedPath():[ev.target], a=null;',
    '  for(var i=0;i<path.length;i++){ var n=path[i]; if(n&&n.tagName==="A"&&n.getAttribute){ a=n; break; } }',
    '  if(!a) return;',
    '  var to=window.__toAppHash(a.getAttribute("href"));',
    '  if(!to) return;',
    '  var A=app(); if(!A||!A.navigate) return;',
    '  ev.preventDefault(); ev.stopPropagation();',
    '  A.navigate(to);',
    '},true);',

    /* 3. tier, both ways */
    'window.addEventListener("tara:tier",function(ev){',
    '  var A=app(); if(!A||!A.setTier||!A.tier) return;',
    '  var t=ev&&ev.detail&&ev.detail.tier;',
    '  if((t===1||t===2||t===3)&&A.tier()!==t){ try{ A.setTier(t); }catch(e){} }',
    '});',
    /*    frames with no reading layer (sprint, map) still answer 1/2/3 */
    'document.addEventListener("keydown",function(ev){',
    '  if(window.TARA) return;',
    '  if(ev.metaKey||ev.ctrlKey||ev.altKey) return;',
    '  var t=ev.target;',
    '  while(t&&t.nodeType!==1) t=t.parentNode;',
    '  while(t&&t.nodeType===1){',
    '    var g=t.tagName;',
    '    if(g==="INPUT"||g==="TEXTAREA"||g==="SELECT"||t.isContentEditable) return;',
    '    t=t.parentNode;',
    '  }',
    '  if(ev.key!=="1"&&ev.key!=="2"&&ev.key!=="3") return;',
    '  var A=app(); if(!A||!A.setTier) return;',
    '  try{ A.setTier(parseInt(ev.key,10)); }catch(e){}',
    '});',

    /* 4. hold the reading position across a tier change.
          Tier 1 text is shorter than tier 3, so every box between the top of
          the document and the viewport grows or shrinks and the sentence you
          were reading slides away — the published pages have always done this.

          What can be held exactly: the reading layer swaps a whole tier group
          (a card) at a time, so a group's *box* changes height but every group
          boundary survives. Anchoring to a boundary and putting it back where
          it was is therefore exact, to the pixel. Anchoring to anything inside
          a group is not: at another tier that element is hidden (inline
          variants) or gone (external variants), and its rect reads 0.

          Which boundary: the surviving one nearest the top of the viewport,
          either side of it. Whatever sits between the anchor and the fold is
          the only content whose height change can still move the screen, so
          nearest-to-the-fold minimises it. Preferring the first boundary BELOW
          the fold reads better on paper and measures worse: when the next
          boundary is most of a screen down, everything above it slides instead
          (measured 4197 px on week-06, against 698 px unanchored).

          The correctness fix over the first cut is `survives`: the old rule
          took any [id], including ids inside a tier group. At another tier that
          element is hidden or replaced, its rect reads all zeros, and putting
          "it" back scrolls the page to an arbitrary place.

          It only ever adjusts scrollTop; no layout is touched. */
    'function pinned(n){',
    '  for(var e=n;e&&e.nodeType===1;e=e.parentElement){',
    '    var p=getComputedStyle(e).position;',
    '    if(p==="fixed"||p==="sticky") return true;',
    '  }',
    '  return false;',
    '}',
    /*    A candidate has to survive the swap. Group containers do; anything
          inside one does not. Anything outside every group does. */
    'function survives(e){',
    '  try{',
    '    if(e.hasAttribute("data-tier-group")) return true;',
    '    if(e.closest("[data-tier-group]")) return false;',
    '    if(e.closest("[data-tara-host]")) return false;',
    '    return true;',
    '  }catch(x){ return false; }',
    '}',
    'var SNAP_SEL="[data-tier-group],[id],h1,h2,h3,h4,h5,h6";',
    'var SNAP_PAD=8;',
    /*    A chain of tier changes has to be reversible. Each step is exact for
          the boundary it picks, but a fresh pick each time composes into drift
          (measured 372 px on week-07 for 2 -> 3 -> 1 -> 2). So the anchor is
          sticky: while the scroll position is still exactly where the last
          correction left it — i.e. the reader has not scrolled since — the same
          element and the same offset are reused, and the chain returns to the
          pixel it started on. The first scroll of the wheel drops it. */
    'var lastEl=null, lastTop=0, lastST=null;',
    'function snapTop(){',
    '  try{',
    '    var se=document.scrollingElement||document.documentElement;',
    '    if(!se||se.scrollTop<=0) return null;',
    '    if(lastEl && lastST!==null && Math.abs(se.scrollTop-lastST)<=1){',
    '      try{',
    '        if(lastEl.isConnected!==false){',
    '          var lr=lastEl.getBoundingClientRect();',
    '          if(lr.height||lr.width) return { el:lastEl, top:lastTop, se:se, sticky:1 };',
    '        }',
    '      }catch(x){}',
    '      lastEl=null; lastST=null;',
    '    }',
    '    var vh=window.innerHeight||0;',
    '    var all=document.querySelectorAll(SNAP_SEL);',
    '    var best=null, bd=1e9;',
    '    for(var i=0;i<all.length;i++){',
    '      var e=all[i], r=e.getBoundingClientRect();',
    '      if(!r.height||!r.width) continue;',
    '      if(r.height>vh*8) continue;',
    '      if(r.top>vh) continue;',
    '      var d=Math.abs(r.top-SNAP_PAD);',
    '      if(d>=bd) continue;',
    '      if(!survives(e)) continue;',
    '      if(pinned(e)) continue;',
    '      best=e; bd=d;',
    '    }',
    '    if(!best) return null;',
    '    return { el:best, top:best.getBoundingClientRect().top, se:se };',
    '  }catch(e){ return null; }',
    '}',
    /*    Put it back, then once more on the next frame: a group that regains a
          web font or an image settles a frame late, and the second pass costs
          nothing when the first one already landed. */
    'function snapBack(s){',
    '  if(!s||!s.el) return;',
    '  try{',
    '    var apply=function(){',
    '      try{',
    '        if(s.el.isConnected===false) return;',
    '        var r=s.el.getBoundingClientRect();',
    '        if(!r.height&&!r.width) return;',
    '        var d=r.top-s.top;',
    '        if(d) s.se.scrollTop+=d;',
    '      }catch(x){}',
    '    };',
    '    apply();',
    '    try{ requestAnimationFrame(function(){ apply(); remember(); }); }catch(x){ remember(); }',
    '    remember();',
    '    function remember(){',
    '      try{ lastEl=s.el; lastTop=s.top; lastST=s.se.scrollTop; }catch(x){}',
    '    }',
    '  }catch(e){}',
    '}',
    'window.__appSnapTop=snapTop; window.__appSnapBack=snapBack;',
    /*    The reading layer's own 1/2/3 handler calls its private setTier, not
          the public one, so wrapping TARA.setTier alone would miss it. A
          capture-phase listener runs before that handler, snapshots, and puts
          the anchor back once every handler on the key has run. */
    'document.addEventListener("keydown",function(ev){',
    '  if(!ev||ev.metaKey||ev.ctrlKey||ev.altKey) return;',
    '  if(ev.key!=="1"&&ev.key!=="2"&&ev.key!=="3") return;',
    '  var t=ev.target;',
    '  try{ if(t&&(t.isContentEditable||/^(input|textarea|select)$/i.test(t.tagName||""))) return; }catch(x){}',
    '  var s=snapTop();',
    '  if(!s) return;',
    '  setTimeout(function(){ snapBack(s); },0);',
    '},true);',
    'function wrapSetTier(){',
    '  try{',
    '    var T=window.TARA;',
    '    if(!T||typeof T.setTier!=="function"||T.__appWrapped) return !!(T&&T.__appWrapped);',
    '    var orig=T.setTier;',
    '    T.setTier=function(){ var s=snapTop(); var r=orig.apply(this,arguments); snapBack(s); return r; };',
    '    T.__appWrapped=1;',
    '    return true;',
    '  }catch(e){ return false; }',
    '}',
    'window.addEventListener("tara:ready",wrapSetTier);',
    'wrapSetTier();',
    'var _w=0,_wv=setInterval(function(){ if(wrapSetTier()||++_w>60) clearInterval(_wv); },50);',

    /* 5. deep links, driven by a call from the shell */
    'window.__appScrollTo=function(id){',
    '  if(!id) return false;',
    '  var n=null;',
    '  try{ n=document.getElementById(id)||document.getElementById(decodeURIComponent(id)); }catch(e){}',
    '  if(!n){ try{ n=document.querySelector(\'[name="\'+CSS.escape(id)+\'"]\'); }catch(e){} }',
    '  if(!n) return false;',
    '  try{ n.scrollIntoView({block:"start"}); }catch(e){ n.scrollIntoView(); }',
    '  return true;',
    '};',
    '})();'
  ].join('\n');

  /* --------------------------------------------------------- compose sides */

  function bootBlock(parts) {
    /* parts: {css, pre, engine, layer, tiers, post} — every field optional */
    var out = ['<!-- APP-FRAME:BEGIN -->'];
    if (parts.css) out.push('<style>' + parts.css + '</style>');
    var cfg = ['window.__APP_URL2HASH=' + jsonLit(URL2HASH) + ';'];
    if (parts.tiers) cfg = cfg.concat(envelopeConfig(parts.tiers));
    if (parts.nav !== false) {
      cfg.push('window.TARA_MAP_URL="#map";');
      cfg.push('window.TARA_PLAN_URL="#plan";');
      cfg.push('window.TARA_CASES_URL="#cases";');
      if (parts.drill) cfg.push('window.TARA_DRILL_URL=' + jsonLit(parts.drill) + ';');
    }
    if (parts.pre) cfg.push(parts.pre);
    out.push('<script>' + cfg.join('\n') + '<\/script>');
    if (parts.bank) out.push('<script>window.TARA_QUIZ_BANK=' + scriptSafe(parts.bank) + ';<\/script>');
    if (parts.engine) out.push('<script>' + scriptSafe(parts.engine) + '<\/script>');
    if (parts.layer) out.push('<script>' + scriptSafe(parts.layer) + '<\/script>');
    out.push('<script>' + CHILD_JS + '<\/script>');
    if (parts.post) out.push('<script>' + parts.post + '<\/script>');
    out.push('<!-- APP-FRAME:END -->');
    return out.join('\n');
  }

  function payloadOr(key, fallback) {
    return APP.payload(key).catch(function (e) {
      try { console.warn('[app] payload ' + key + ': ' + e.message); } catch (_) {}
      return fallback === undefined ? null : fallback;
    });
  }

  function composePack(slug) {
    return Promise.all([
      APP.payload('pack:' + slug),
      payloadOr('tier:' + slug, null),
      payloadOr('bank:' + slug, null),
      payloadOr('engine', null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      return splice(prelude(r[0], window.TARA_SHELL === 'v2' ? QUIZ_GATE : ''), bootBlock({
        tiers: tiers, bank: r[2], engine: r[3], layer: r[4],
        drill: '#drill/' + slug
      }));
    });
  }

  function composeDemo(slug) {
    return Promise.all([
      APP.payload('demo:' + slug),
      payloadOr('tier:' + slug, null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      return splice(prelude(r[0]), bootBlock({ tiers: tiers, layer: r[2] }));
    });
  }

  /* A one-document section (plan, manual): the page, its tier envelope if it
     has one, and the reading layer. Same recipe as a demo, different keys. */
  function composeSimple(htmlKey, tierKey, extra) {
    return Promise.all([
      APP.payload(htmlKey),
      tierKey ? payloadOr(tierKey, null) : Promise.resolve(null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      var parts = { tiers: tiers, layer: r[2] };
      for (var k in (extra || {})) parts[k] = extra[k];
      return splice(prelude(r[0]), bootBlock(parts));
    });
  }

  /* V2: the opener back pills (scaffold opts.opener), painted for the entry on screen */
  function tabTitle(id) {
    var T = APP.TABS || [];
    for (var i = 0; i < T.length; i++) if (T[i].id === id) return T[i].title;
    return 'Library';
  }
  function paintOpener(a) {
    var e = APP.entry ? APP.entry() : null;
    var tab = e && e.tab ? e.tab : 'library';
    a.textContent = '← ' + tabTitle(tab);
    a.href = '#' + (e && e.from != null ? e.from : 'library');
  }
  if (window.TARA_SHELL === 'v2' && APP.onRoute) {
    APP.onRoute(function () {
      var all = document.querySelectorAll('a.app-fr-back[data-v2-opener]');
      for (var i = 0; i < all.length; i++) paintOpener(all[i]);
    });
  }

  /* ----------------------------------------------------------- frame plumb */

  function frameDoc(f) {
    if (!f) return null;
    if (APP.frames && APP.frames.doc) { try { return APP.frames.doc(f); } catch (e) { /* fall through */ } }
    try { return f.contentDocument || null; } catch (e) { return null; }
  }

  /* Resolve once the child has parsed and run its inline scripts. */
  function ready(f) {
    return new Promise(function (res) {
      var tries = 0;
      (function tick() {
        var d = frameDoc(f);
        if (d && (d.readyState === 'complete' || d.readyState === 'interactive') &&
            d.body && d.body.childNodes.length) return res(f);
        if (++tries > 200) return res(f);          /* 4 s: degrade, never hang */
        setTimeout(tick, 20);
      })();
    });
  }

  /* The first h2/h3 whose text holds the anchor's word(s), any case:
     "primer" finds "Saturday primer". null when none does. */
  function headingFor(d, id) {
    var words = '';
    try { words = decodeURIComponent(String(id)); } catch (e) { words = String(id); }
    words = words.replace(/[-_]+/g, ' ').replace(/[^\w\s]/g, '').trim();
    if (!words) return null;
    var re = new RegExp('(^|\\W)' + words.split(/\s+/).join('\\s+') + '(\\W|$)', 'i');
    var hs = d.querySelectorAll('h2, h3');
    for (var i = 0; i < hs.length; i++) if (re.test(hs[i].textContent || '')) return hs[i];
    return null;
  }

  /* Deep link into a frame. The target can still be unparsed when the frame
     first reports readiness, so this keeps looking for up to ~4 s and then
     gives up quietly — a missing anchor must never break the section. */
  function scrollTo(f, id) {
    if (!id) return Promise.resolve(false);
    return ready(f).then(function () {
      return new Promise(function (res) {
        var tries = 0;
        (function tick() {
          var w = null;
          try { w = f.contentWindow; } catch (e) { return res(false); }
          if (w && typeof w.__appScrollTo === 'function' && w.__appScrollTo(id)) {
            /* one more pass next frame: the reading layer sets scroll-margin
               and the page's own fonts can settle after the first jump */
            try { w.requestAnimationFrame(function () { w.__appScrollTo(id); }); } catch (e) {}
            return res(true);
          }
          var d = frameDoc(f), n = null;
          if (d) {
            try { n = d.getElementById(id) || d.getElementById(decodeURIComponent(id)); } catch (e) {}
            /* V2: an anchor some packs never gave an id (#primer in week-01, -02, -09,
               -10) lands on the first h2/h3 that says it, once the page has parsed */
            if (!n && window.TARA_SHELL === 'v2' && (d.readyState === 'complete' || tries > 25)) n = headingFor(d, id);
            if (n) {
              try { n.scrollIntoView({ block: 'start' }); } catch (e) { n.scrollIntoView(); }
              return res(true);
            }
          }
          if (++tries > 200) return res(false);
          setTimeout(tick, 20);
        })();
      });
    });
  }

  var SPRINT_TIER = { 1: 'plain', 2: 'working', 3: 'expert' };
  var SPRINT_BACK = { plain: 1, working: 2, expert: 3 };

  /* Push tier N into one live frame. Three shapes, tried in order:
       reading layer  -> TARA.setTier(n)
       crash sprint   -> click its own (hidden) button, per SPEC §6.1
       anything else  -> nothing to do; the frame has no tiers
     Always a no-op when the frame is already at N, so it never re-renders and
     never moves anything. */
  function tierToFrame(f, n) {
    if (!f || !(n === 1 || n === 2 || n === 3)) return false;
    var w = null, d = frameDoc(f);
    try { w = f.contentWindow; } catch (e) { w = null; }
    try {
      if (w && w.TARA && typeof w.TARA.setTier === 'function') {
        if (!w.TARA.getTier || w.TARA.getTier() !== n) w.TARA.setTier(n);
        return true;
      }
    } catch (e) { /* fall through */ }
    if (!d) return false;
    try {
      var want = SPRINT_TIER[n];
      var body = d.body;
      if (body && body.hasAttribute('data-showtier')) {
        if (body.getAttribute('data-showtier') === want) return true;
        var b = d.querySelector('.tierbar button[data-settier="' + want + '"]');
        if (b) {
          /* the sprint has no reading layer to wrap, so hold its position here */
          var snap = (w && w.__appSnapTop) ? w.__appSnapTop() : null;
          b.click();
          if (w && w.__appSnapBack) w.__appSnapBack(snap);
          return true;
        }
      }
    } catch (e) { /* degrade: the frame still works, the shell just cannot steer it */ }
    return false;
  }

  /* Mount a frame into a host div. The host holds exactly one frame at a time;
     APP.frames owns the LRU, so a frame taken away stays alive and keeps its
     scroll position. */
  function show(host, key, composeFn) {
    if (!APP.frames || !APP.frames.get) return Promise.reject(new Error('APP.frames missing'));
    return APP.frames.get(key, composeFn).then(function (f) {
      try { f.className = 'app-fr'; } catch (e) {}
      /* APP.frames.show attaches f and hides every other frame in the host
         (shell.js). One visible frame per host is the shell's job, not ours. */
      if (APP.frames.show) APP.frames.show(host, f);
      else if (f.parentNode !== host) host.appendChild(f);
      return f;
    });
  }

  /* ------------------------------------------------------------- searching */

  var STOP = /^(the|a|an|and|or|of|to|in|is|it|for|on|with|that|this|as|at|by|from)$/i;

  /* Headings plus the first sentence after them, keyed to the nearest id.
     Regex over the source string — the pack is never parsed into the shell. */
  function headingIndex(html) {
    var out = [], seen = Object.create(null);
    var rx = /<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, m;
    var idRx = /\bid\s*=\s*["']([^"']+)["']/i;
    while ((m = rx.exec(html)) !== null) {
      var attrs = m[2] || '', title = strip(m[3]);
      if (!title) continue;
      var id = null, am = idRx.exec(attrs);
      if (am) id = am[1];
      if (!id) id = nearestId(html, m.index);
      if (!id) continue;
      if (seen[id + '|' + title]) continue;
      seen[id + '|' + title] = 1;
      out.push({ id: id, title: title, sub: firstSentence(html, rx.lastIndex) });
      if (out.length > 400) break;
    }
    return out;
  }
  function nearestId(html, at) {
    /* the closest id="..." on an open tag before this heading */
    var win = html.slice(Math.max(0, at - 1400), at);
    var rx = /<(?:section|article|div|details|main|aside|h[1-4])\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi;
    var last = null, m;
    while ((m = rx.exec(win)) !== null) last = m[1];
    return last;
  }
  function firstSentence(html, from) {
    var t = strip(html.slice(from, from + 900));
    if (!t) return '';
    var i = t.search(/[.!?](\s|$)/);
    return (i > 0 ? t.slice(0, i + 1) : t).slice(0, 160);
  }
  function strip(s) {
    return String(s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  }

  /* SPEC §8 scoring. Ties are broken by the caller, in registration order. */
  function score(q, fields) {
    q = String(q || '').toLowerCase().trim();
    if (!q || STOP.test(q)) return 0;
    var id = (fields.id || '').toLowerCase();
    var title = (fields.title || '').toLowerCase();
    var body = (fields.body || '').toLowerCase();
    if (id === q || (fields.slug || '').toLowerCase() === q) return 100;
    if (title.indexOf(q) === 0) return 60;
    if (title.indexOf(q) !== -1) return 40;
    if (id.indexOf(q) !== -1) return 40;
    if (body.indexOf(q) !== -1) return 15;
    return 0;
  }

  function cap(rows, n) {
    rows.sort(function (a, b) { return b.score - a.score || (a._o || 0) - (b._o || 0); });
    return rows.slice(0, n == null ? 8 : n);
  }

  /* -------------------------------------------------------------- the kit  */

  window.__TARA_FK = {
    PACKS: PACKS, DEMOS: DEMOS, PACK_BY: PACK_BY, DEMO_BY: DEMO_BY, URL2HASH: URL2HASH,
    packWeeks: packWeeks, packLabel: packLabel, demoWeeks: demoWeeks,
    scriptSafe: scriptSafe, jsonLit: jsonLit, splice: splice, prelude: prelude,
    envelopeConfig: envelopeConfig, bootBlock: bootBlock, payloadOr: payloadOr,
    composePack: composePack, composeDemo: composeDemo, composeSimple: composeSimple,
    frameDoc: frameDoc, ready: ready, scrollTo: scrollTo, show: show,
    tierToFrame: tierToFrame, SPRINT_TIER: SPRINT_TIER, SPRINT_BACK: SPRINT_BACK,
    headingIndex: headingIndex, strip: strip, score: score, cap: cap,
    /* every framed section renders the same two-part shell.
       opts.opener (V2): the back pill returns where the section was opened from
       (the Library, Today, a Weeks step), by stepping back in history, and says
       so ("← Library"); opened from nowhere (a deep link), it goes to the Library. */
    scaffold: function (el, opts) {
      if (el.__built) return el.__built;
      el.textContent = '';
      var idx = document.createElement('div');
      idx.className = 'app-idx';
      var wrap = document.createElement('div');
      wrap.className = 'app-fr-wrap';
      var bar = document.createElement('div');
      bar.className = 'app-fr-bar';
      var back = document.createElement('a');
      back.className = 'app-fr-back';
      back.href = opts.backHash || '#today';
      back.textContent = opts.backLabel || 'Back';
      if (opts.opener && window.TARA_SHELL === 'v2' && APP.entry) {
        back.setAttribute('data-v2-opener', '1');
        back.addEventListener('click', function (e) {
          if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          APP.backTo('library');
        });
        paintOpener(back);
      }
      var name = document.createElement('span');
      name.className = 'app-fr-name';
      bar.appendChild(back); bar.appendChild(name);
      var host = document.createElement('div');
      host.className = 'app-fr-host';
      wrap.appendChild(bar); wrap.appendChild(host);
      el.appendChild(idx); el.appendChild(wrap);
      el.__built = { idx: idx, wrap: wrap, bar: bar, back: back, name: name, host: host };
      return el.__built;
    },
    /* index vs frame — toggled with `hidden`, so nothing is ever rebuilt */
    showIndex: function (parts, on) {
      parts.idx.hidden = !on;
      parts.wrap.hidden = !!on;
    },
    /* headings of one framed document -> search rows */
    docSearch: function (payloadKey, q, hashPrefix, label, cacheBox) {
      var K = window.__TARA_FK;
      var p = cacheBox.rows
        ? Promise.resolve(cacheBox.rows)
        : K.payloadOr(payloadKey, '').then(function (html) {
            cacheBox.rows = html ? K.headingIndex(html) : [];
            return cacheBox.rows;
          });
      return p.then(function (rows) {
        var out = [];
        rows.forEach(function (row, i) {
          var s = K.score(q, { id: row.id, title: row.title, body: row.sub });
          if (!s) return;
          out.push({ title: row.title, sub: label, hash: hashPrefix + row.id, score: s, _o: i });
        });
        return K.cap(out, 8);
      });
    },

    /* raw hash, minus the leading '#', with the section token peeled off */
    hashOf: function (route) {
      var raw = (route && route.raw) || '';
      if (!raw) { try { raw = location.hash; } catch (e) { raw = ''; } }
      return String(raw).replace(/^#/, '');
    }
  };
})();

/* ============================================================ the section  */
(function () {
  'use strict';
  var SEC = 'packs';

  function fk() { return window.__TARA_FK; }

  /* Every spelling SPEC §7 allows, plus the two bare chapter slugs the router
     normalises to: #week-07, #week-7, #week-07/<anchor>, #alignment-science,
     #week-alignment-science, #pack/<slug>. */
  function parse(route) {
    var h = fk().hashOf(route);
    if (!h || h === 'packs' || h === 'pack') return { slug: null, anchor: null };
    /* #packs/week-NN: the index, with that TARA week's packs marked */
    var wm = /^packs\/w(?:eek)?-?(\d{1,2})$/i.exec(h);
    if (wm) return { slug: null, anchor: null, week: Number(wm[1]) };
    var i = h.indexOf('/');
    var head = i === -1 ? h : h.slice(0, i);
    var anchor = i === -1 ? null : h.slice(i + 1) || null;
    if (head === 'pack' && anchor) {
      var j = anchor.indexOf('/');
      head = j === -1 ? anchor : anchor.slice(0, j);
      anchor = j === -1 ? null : anchor.slice(j + 1) || null;
    }
    var P = fk().PACK_BY;
    if (P[head]) return { slug: head, anchor: anchor };
    var m = /^week-(.+)$/.exec(head);
    if (m) {
      var t = m[1];
      if (P['week-' + t]) return { slug: 'week-' + t, anchor: anchor };
      if (/^\d$/.test(t) && P['week-0' + t]) return { slug: 'week-0' + t, anchor: anchor };
      if (P[t]) return { slug: t, anchor: anchor };
    }
    return { slug: null, anchor: null };
  }

  function buildIndex(idx) {
    if (idx.__filled) return;
    idx.__filled = 1;
    var head = document.createElement('div');
    head.className = 'app-idx-head';
    head.innerHTML = '<h2 class="app-idx-h">Study packs</h2>' +
      '<p class="app-idx-note">Thirteen packs in TARA&rsquo;s week order, week 0 to week 14. Some weeks use ' +
      'two or three packs and some packs serve two or three weeks. Each pack carries its own ' +
      'eight-question drill.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().PACKS.forEach(function (p) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#' + p.slug;
      a.setAttribute('data-pack', p.slug);
      a.setAttribute('data-weeks', (fk().packWeeks(p.slug) || []).join(','));
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(fk().packLabel(p.slug)) + '</span>' +
        '<span class="app-idx-t">' + APP.esc(p.title) + '</span>' +
        '<span class="app-idx-s">' + APP.esc(p.sub) + '</span>';
      grid.appendChild(a);
    });
    idx.appendChild(grid);
    APP._order = APP._order || {};
    APP._order[SEC] = fk().PACKS.map(function (p) { return p.slug; });
  }

  /* #packs/week-NN: mark that week's cards in place (nothing reorders or hides),
     and say so in the note, the way #demo-week-NN does for demos. */
  function markWeek(idx, week) {
    var cards = idx.querySelectorAll('.app-idx-card');
    for (var i = 0; i < cards.length; i++) {
      var ws = (cards[i].getAttribute('data-weeks') || '').split(',');
      if (week != null && ws.indexOf(String(week)) !== -1) cards[i].setAttribute('data-now', '1');
      else cards[i].removeAttribute('data-now');
    }
    var note = idx.querySelector('.app-idx-note');
    if (!note) return;
    if (!note.__base) note.__base = note.innerHTML;
    var w = week != null && APP.weekByN ? APP.weekByN(week) : null;
    note.innerHTML = w
      ? 'Week ' + w.n + ' &middot; ' + APP.esc(w.chapter) + ' &middot; ' + APP.esc(w.arena || '') +
        '. Its packs are marked; open them in order.'
      : note.__base;
  }

  var openSlug = null, openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#packs', backLabel: '← All packs' });
    buildIndex(parts.idx);
    var r = parse(route);
    if (!r.slug || !K.PACK_BY[r.slug]) {
      markWeek(parts.idx, r.week == null ? null : r.week);
      K.showIndex(parts, true);
      openSlug = null; openFrame = null;
      return Promise.resolve();
    }
    var p = K.PACK_BY[r.slug];
    K.showIndex(parts, false);
    parts.name.textContent = K.packLabel(r.slug) + ' · ' + p.title;
    openSlug = r.slug;
    return K.show(parts.host, 'pack:' + r.slug, function () {
      return K.composePack(r.slug);
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  /* Lazy, one-shot: 13 pack sources decoded in parallel on the first query. */
  var index = null, indexing = null;
  function ensureIndex() {
    if (index) return Promise.resolve(index);
    if (indexing) return indexing;
    var K = fk();
    indexing = Promise.all(K.PACKS.map(function (p) {
      return K.payloadOr('pack:' + p.slug, '').then(function (html) {
        return { pack: p, rows: html ? K.headingIndex(html) : [] };
      });
    })).then(function (all) {
      index = all;
      indexing = null;
      return index;
    });
    return indexing;
  }

  function search(q) {
    var K = fk();
    var direct = [];
    K.PACKS.forEach(function (p) {
      var lab = K.packLabel(p.slug);
      var s = K.score(q, { id: p.slug, slug: p.slug, title: p.title, body: p.sub + ' ' + lab });
      if (!s) s = K.score(q, { id: lab.toLowerCase(), title: lab });
      if (s) direct.push({ title: p.title, sub: lab, hash: '#' + p.slug, score: s + 5, _o: p.order });
    });
    return ensureIndex().then(function (all) {
      var rows = direct.slice();
      all.forEach(function (entry) {
        entry.rows.forEach(function (row, i) {
          var s = K.score(q, { id: row.id, title: row.title, body: row.sub });
          if (!s) return;
          rows.push({
            title: row.title,
            sub: K.packLabel(entry.pack.slug) + ' · ' + entry.pack.title,
            hash: '#' + entry.pack.slug + '/' + row.id,
            score: s,
            _o: entry.pack.order * 1000 + i
          });
        });
      });
      return K.cap(rows, 8);
    });
  }

  function onTier(n) {
    /* the shell fans out to every live frame (SPEC §6.1); this is the belt for
       a frame that booted just before the shell wrote the key. Idempotent. */
    window.__TARA_FK.tierToFrame(openFrame, n);
  }

  APP.registerSection({
    id: SEC,
    title: 'Packs',
    navOrder: 30,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();
