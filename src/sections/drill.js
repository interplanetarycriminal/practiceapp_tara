/* app/sections/drill.js — Worker C
 * The drill room, rebuilt natively in the shell DOM from quiz-banks/engine.js
 * plus the thirteen bank payloads. Ported from the published drill room
 * (artifact 438d8cf) with these changes:
 *   - concept side-links stay inside the app (#map/node=… and #cases/…) instead
 *     of opening the two library artifacts in new tabs;
 *   - the room does not repaint the document's --accent per week (the shell owns
 *     the palette); a week's colour is a stripe on its chip only;
 *   - routing goes through APP.navigate, never location.hash.
 *
 * The draw is the engine's: a mastery-weighted random subset, shuffled question
 * order, shuffled options tracked by option id, and a random stem variant per
 * appearance. A repeat visit therefore never reproduces a sequence. Session size
 * is capped at 8 / 12 / 20 — never the whole bank.
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || !APP.registerSection) return;

  /* One chip per bank. Banks share their pack's slug, a stable content id, so the
     labels are TARA weeks (26 Oct 2026 order): week-11's bank serves W7-W9, the
     three chapter-0 banks all serve W1. name/saturday/when are the fallback;
     liveWeeks() refreshes them from calendar.md. saturday = the last Saturday the
     bank serves, so the default chip stays on a shared bank until its block ends. */
  var WEEKS = [
    { slug: 'week-01', name: 'W0', saturday: '2026-09-05', when: '5 Sep', topic: 'Einops', title: 'Einops and Ray Tracing', count: 78, accent: '#c2477f' },
    { slug: 'week-02', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'ResNets', title: 'Modules and ResNets', count: 88, accent: '#a86a1f' },
    { slug: 'week-03', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'Optimisers', title: 'Optimizers and Sweeps', count: 72, accent: '#4a5fc4' },
    { slug: 'week-04', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'Autograd', title: 'Your Own Autograd', count: 76, accent: '#c05a34' },
    { slug: 'week-05', name: 'W2', saturday: '2026-09-19', when: '19 Sep', topic: 'Transformer', title: 'Transformer From Scratch', count: 81, accent: '#4c58bd' },
    { slug: 'week-06', name: 'W3', saturday: '2026-09-26', when: '26 Sep', topic: 'Hooks', title: 'Hooks and the Cache', count: 79, accent: '#4c58bd' },
    { slug: 'week-07', name: 'W3–4', saturday: '2026-10-03', when: '26 Sep – 3 Oct', topic: 'Circuits', title: 'Induction circuits, ablation and activation patching', count: 91, accent: '#4a5fc4' },
    { slug: 'week-08', name: 'W4', saturday: '2026-10-03', when: '3 Oct', topic: 'SAEs', title: 'Superposition, feature geometry and sparse autoencoders', count: 96, accent: '#6f8a20' },
    { slug: 'week-09', name: 'W5', saturday: '2026-10-10', when: '10 Oct', topic: 'DQN', title: 'Value functions, DQN and vanilla policy gradients', count: 70, accent: '#5561c9' },
    { slug: 'week-10', name: 'W6', saturday: '2026-10-17', when: '17 Oct', topic: 'PPO & RLHF', title: 'PPO and RLHF', count: 73, accent: '#a1519f' },
    { slug: 'week-11', name: 'W7–9', saturday: '2026-11-07', when: '24 Oct – 7 Nov', topic: 'Evals', title: 'Eval Design, Inspect and AI Control', count: 78, accent: '#4a63c0' },
    { slug: 'alignment-science', name: 'W10–11', saturday: '2026-11-21', when: '14 – 21 Nov', topic: 'Alignment', title: 'Alignment science — chapter 4, the capstone quarry', count: 68, accent: '#b45a2a' },
    { slug: 'capstone-weeks-12-14', name: 'W12–14', saturday: '2026-12-12', when: '28 Nov – 12 Dec', topic: 'Capstone', title: 'Capstone — three Saturdays and a talk', count: 233, accent: '#8759c0' }
  ];
  var MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function dm(iso) { var p = String(iso).split('-'); return Number(p[2]) + ' ' + MON3[Number(p[1]) - 1]; }
  /* Labels from the schedule, so calendar.md stays the one place weeks are decided. */
  function liveWeeks() {
    if (!APP.weeksOfPack || !APP.weekByN) return;
    WEEKS.forEach(function (w) {
      var ns = APP.weeksOfPack(w.slug);
      if (!ns.length) return;
      var a = APP.weekByN(ns[0]), b = APP.weekByN(ns[ns.length - 1]);
      w.name = APP.weekSpan(ns, true);
      w.saturday = b.saturday;
      w.when = a === b ? dm(a.saturday) : dm(a.saturday) + ' – ' + dm(b.saturday);
      w.first = ns[0];
    });
    WEEKS.sort(function (x, y) { return (x.first == null ? 99 : x.first) - (y.first == null ? 99 : y.first) || x.order - y.order; });
  }
  WEEKS.forEach(function (w, i) { w.order = i; });

  var SIZES = [8, 12, 20];
  var PREF_KEY = 'tara-drill-prefs-v1';

  /* Node ids from concept-map/nodes.json, inlined at authoring time exactly as
     the published drill room inlined them. 199 of the 358 concept values used
     across the banks are NOT node ids (the quiz-engine contract §3 says they
     must be), so a map link is drawn only where the destination exists. */
  var MAP_IDS = {};
  ["ablation","activation-cache","activation-capping","activation-oracle","activation-patching","activation-pca","actor-critic","adam","adamw-vs-adam","advantage","agentic-misalignment-testbed","ai-control","algorithmic-task-interpretability","alignment-faking","alphazero","as-strided-and-stride-tricks","assistant-axis","attention-head","attention-pattern","attribution-graph","attribution-patching","autoencoder","autointerp","autorater","backdoor","backprop-and-topological-order","backup-name-mover-head","backward-function","barycentric-coordinates","baseline","batched-raytracing","batchnorm","beam-search","bellman-equation","broadcasting","capstone-project","circuit","circuit-pruning","composition-score","computational-graph","contrastive-steering-vector","convolution","cot-faithfulness","counterfactual-importance","cross-entropy-loss","dataset-generation","dead-latent","defer-to-trusted","denoising-vs-noising","direct-feature-attribution","direct-logit-attribution","discount-factor","distributed-training","dqn","duplicate-token-head","einops-rearrange","einops-reduce","einops-repeat","einsum","eligibility-traces","embedding","emergent-misalignment","emergent-world-representation","entropy-bonus","epsilon-greedy","eval-prompt-engineering","eval-task","eval-threat-model-and-spec","factored-matrix","feature","feature-dimensionality","few-shot-prompting","final-presentation","fourier-basis","function-vector","gan","gated-sae","gelu","generalized-advantage-estimation","grokking","grpo","hooks","indirect-object-identification","induction-heads","induction-score","inspect-ai","interference","investigator-agent","jumprelu-sae","k-composition","kl-divergence","kv-cache","l1-penalty","latent-space","layernorm","linear-layer","linear-probe","linear-representation-hypothesis","llm-agent","llm-scorer","logit-difference","logit-lens","lora","lr-schedule","markov-decision-process","max-activating-examples","max-pooling","minimal-circuit","misalignment-phase-transition","mlp-layer","mode-collapse","model-diffing","model-organism","momentum","monte-carlo-tree-search","multi-armed-bandit","name-mover-head","othellogpt","ov-circuit","padding","paper-replication","path-patching","persona-drift","persona-vector","petri","policy","policy-evaluation","policy-gradient-theorem","policy-improvement","policy-iteration","polysemanticity","positional-embedding","ppo","ppo-clipped-surrogate","previous-token-head","probe-environment","probe-intervention","progress-measure","projection-monitoring","puct","q-composition","q-learning","q-network","q-value","qk-circuit","ray-generation","ray-object-intersection","react-framework","receiver-head","red-team-campaign","red-teaming-results","reference-model","reinforce","reparameterisation-trick","replay-buffer","resampling-importance","residual-block","residual-stream","resnet34","reward-hacking","reward-model","reward-shaping","rlhf","rlhf-kl-penalty","rmsprop","rollout-buffer","s-inhibition-head","sae-latent","sae-steering","safety-usefulness-frontier","sampling","sandbagging","sarsa","scorer","scratchpad-reasoning","self-play","sgd","shutdown-resistance","softmax-attention-and-causal-mask","solver","sparse-autoencoder","sparsity","steering-hook","steering-vector","structured-output","superposition","suspiciousness-score","target-network","td-error","temperature","tensor-strides","thought-anchor","tokenization","tool-use","top-k-sampling","top-p-sampling","topological-sort","training-loop","transcoder","transformer-block","transformerlens","trust-region","trusted-editing","trusted-monitoring","ucb-selection","unbroadcast","unembedding","upfront-auditing","vae","value-function","value-function-loss","value-head","variance-prompt","wandb-sweep","weight-decay"].forEach(function (id) { MAP_IDS[id] = true; });

  var BYSLUG = {};
  WEEKS.forEach(function (w) { BYSLUG[w.slug] = w; });

  /* ------------------------------------------------------------ prefs ---- */
  var mem = {};
  function prefGet() {
    try { if (window.localStorage) { var v = localStorage.getItem(PREF_KEY); if (v) return JSON.parse(v); } }
    catch (e) {}
    try { return mem[PREF_KEY] ? JSON.parse(mem[PREF_KEY]) : {}; } catch (e) { return {}; }
  }
  function prefSet(o) {
    var s = JSON.stringify(o);
    mem[PREF_KEY] = s;
    try { if (window.localStorage) localStorage.setItem(PREF_KEY, s); } catch (e) {}
  }

  /* ------------------------------------------------------------ state ---- */
  var prefs = prefGet();
  var S = {
    built: false,
    root: null,
    els: {},
    banks: {},        // slug -> bank JSON (decoded lazily, cached)
    QIDX: {},         // question id -> {c: concept, w: slug}
    CLABEL: {},       // concept id -> human label
    CASE_IDS: {},     // concept id -> true when a case card exists
    slug: null,
    size: SIZES.indexOf(prefs.size) >= 0 ? prefs.size : 12,
    concept: null,
    inst: null,
    answered: 0,
    engineReady: null,
    mo: null
  };

  function esc(s) { return String(s == null ? '' : s); }

  /* --------------------------------------------------------- the engine -- */
  function loadEngine() {
    if (S.engineReady) return S.engineReady;
    if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) {
      S.engineReady = Promise.resolve(true);
      return S.engineReady;
    }
    S.engineReady = APP.payload('engine').then(function (src) {
      /* An inline <script> element, not eval(): the artifact CSP allows inline
         script (the whole app is one) but need not allow unsafe-eval. */
      var s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      return !!(window.TARA_QUIZ && window.TARA_QUIZ.mount);
    }).catch(function (e) { S.loadErr = e; return false; })
      .then(function (ok) {
        if (!ok) S.engineReady = null;   /* a failure is not kept: the next draw tries again */
        return ok;
      });
    return S.engineReady;
  }

  function loadBank(slug) {
    if (S.banks[slug]) return Promise.resolve(S.banks[slug]);
    return APP.payloadJSON('bank:' + slug).then(function (b) {
      S.banks[slug] = b;
      (b.concepts || []).forEach(function (c) {
        if (c && c.id && !S.CLABEL[c.id]) S.CLABEL[c.id] = c.label || c.id;
      });
      (b.questions || []).forEach(function (q) {
        if (q && q.id) S.QIDX[q.id] = { c: q.concept, w: slug };
      });
      return b;
    }).catch(function (e) { S.loadErr = e; return null; });
  }

  /* Index every bank once, so "what's shaky" can aggregate across banks and
     search() can see all thirteen. Cheap next to the decode itself. */
  var allLoaded = null;
  function loadAll() {
    if (allLoaded) return allLoaded;
    allLoaded = Promise.all(WEEKS.map(function (w) { return loadBank(w.slug); })).then(function (r) {
      for (var i = 0; i < r.length; i++) if (!r[i]) { allLoaded = null; break; }  /* try the missing ones again next time */
      return r;
    });
    return allLoaded;
  }

  /* -------------------------------------------------- concept side-links -- */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function arrowSVG() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M4.2 2.2h5.6v5.6M9.8 2.2 2.4 9.6');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }
  function makeLink(hash, short, full) {
    var a = document.createElement('a');
    a.className = 'drill-clink';
    a.href = hash;
    a.title = full;
    a.setAttribute('aria-label', full);
    a.appendChild(document.createTextNode(short));
    a.appendChild(arrowSVG());
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();   /* the chip beside this one redraws the session */
      APP.navigate(hash);
    });
    return a;
  }
  function conceptLinks(id) {
    if (!id) return null;
    var hasMap = MAP_IDS[id] === true, hasCase = S.CASE_IDS[id] === true;
    if (!hasMap && !hasCase) return null;
    var lab = S.CLABEL[id] || id;
    var span = document.createElement('span');
    span.className = 'drill-clinks';
    span.setAttribute('data-concept', id);
    if (hasMap) span.appendChild(makeLink('#map/node=' + encodeURIComponent(id), 'map',
      'See ' + lab + ' in the concept map'));
    if (hasCase) span.appendChild(makeLink('#cases/' + encodeURIComponent(id), 'used',
      'See ' + lab + ' used in practice'));
    return span;
  }
  /* The chips belong to the engine, so decorate where they land rather than
     reaching into engine.js. */
  function decorateChips() {
    if (!S.els.stage) return;
    var chips = S.els.stage.querySelectorAll('.tara-quiz-chip[data-concept]');
    Array.prototype.forEach.call(chips, function (chip) {
      if (chip.getAttribute('data-clinked')) return;
      chip.setAttribute('data-clinked', '1');
      var links = conceptLinks(chip.getAttribute('data-concept'));
      if (!links) return;
      if (chip.nextSibling) chip.parentNode.insertBefore(links, chip.nextSibling);
      else chip.parentNode.appendChild(links);
    });
  }

  /* ------------------------------------------------------- which week --- */
  function todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function defaultSlug() {
    var t = todayISO(), i, last = null;
    for (i = 0; i < WEEKS.length; i++) {
      if (WEEKS[i].saturday && WEEKS[i].saturday >= t) return WEEKS[i].slug;
    }
    for (i = 0; i < WEEKS.length; i++) if (WEEKS[i].saturday) last = WEEKS[i];
    return (last && t > last.saturday) ? last.slug : 'week-01';
  }

  /* ------------------------------------------------------------ chrome --- */
  function build(el) {
    el.innerHTML =
      '<div class="drill-root">' +
        '<div class="drill-rail">' +
          '<div class="drill-rail-top">' +
            '<h2 class="drill-now" data-now>Drill room<span class="drill-now-sub" data-now-sub></span></h2>' +
            '<span class="drill-focus" data-focus><span data-focus-label></span>' +
              '<button type="button" data-focus-clear aria-label="Drill the whole week again">×</button></span>' +
            '<span class="drill-sizer"><span class="drill-sizer-lab">questions</span>' +
              '<span class="drill-seg" data-sizes role="group" aria-label="Questions per session"></span></span>' +
            '<button type="button" class="drill-redraw" data-redraw title="Draw a fresh set from this bank">new draw</button>' +
          '</div>' +
          '<div class="drill-weeks" data-weeks role="group" aria-label="Week"></div>' +
        '</div>' +
        '<div class="drill-floor">' +
          '<div class="drill-stage" data-stage></div>' +
          '<aside class="drill-shaky" data-shaky aria-live="polite"></aside>' +
        '</div>' +
      '</div>';

    S.root = el.querySelector('.drill-root');
    S.els = {
      now: S.root.querySelector('[data-now]'),
      nowSub: S.root.querySelector('[data-now-sub]'),
      weeks: S.root.querySelector('[data-weeks]'),
      sizes: S.root.querySelector('[data-sizes]'),
      stage: S.root.querySelector('[data-stage]'),
      shaky: S.root.querySelector('[data-shaky]'),
      focus: S.root.querySelector('[data-focus]'),
      focusLabel: S.root.querySelector('[data-focus-label]'),
      focusClear: S.root.querySelector('[data-focus-clear]')
    };

    liveWeeks();
    WEEKS.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'drill-wk';
      b.setAttribute('data-slug', w.slug);
      b.setAttribute('aria-pressed', 'false');
      b.title = w.title + ' — ' + w.name + ' · ' + w.when + ' · ' + w.count + ' questions';
      b.style.setProperty('--dw', w.accent);
      b.innerHTML = '<span class="drill-wk-id"></span><span class="drill-wk-meta"></span>';
      b.querySelector('.drill-wk-id').textContent = w.name;
      b.querySelector('.drill-wk-meta').textContent = w.topic + ' · ' + w.count;
      b.addEventListener('click', function () { APP.navigate('#drill/' + w.slug); });
      S.els.weeks.appendChild(b);
      w._btn = b;
    });
    var next = defaultSlug();
    if (BYSLUG[next] && BYSLUG[next]._btn) BYSLUG[next]._btn.classList.add('is-next');

    SIZES.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(n);
      b.setAttribute('data-size', String(n));
      b.setAttribute('aria-pressed', String(n === S.size));
      b.addEventListener('click', function () {
        if (n === S.size) return;
        S.size = n;
        prefs.size = n;
        prefSet(prefs);
        Array.prototype.forEach.call(S.els.sizes.children, function (c) {
          c.setAttribute('aria-pressed', String(c.getAttribute('data-size') === String(n)));
        });
        draw(true);
      });
      S.els.sizes.appendChild(b);
    });

    S.els.focusClear.addEventListener('click', function () {
      S.concept = null;
      APP.navigate('#drill/' + S.slug, { replace: true });
      draw(true);
    });
    S.root.querySelector('[data-redraw]').addEventListener('click', function () { draw(true); });

    document.addEventListener('tara:quiz-answered', onAnswered);
    if (window.MutationObserver) {
      S.mo = new MutationObserver(decorateChips);
      S.mo.observe(S.els.stage, { childList: true, subtree: true });
    }
    S.built = true;
  }

  function onAnswered() {
    S.answered++;
    paintShaky();
    decorateChips();
  }

  function paintHeader() {
    var w = BYSLUG[S.slug] || {};
    S.els.now.firstChild.nodeValue = w.title || S.slug || 'Drill room';
    S.els.nowSub.textContent = [w.name, w.when, (w.count || 0) + ' questions']
      .filter(Boolean).join(' · ');
    WEEKS.forEach(function (x) {
      if (x._btn) x._btn.setAttribute('aria-pressed', String(x.slug === S.slug));
    });
    var cur = BYSLUG[S.slug];
    if (cur && cur._btn && cur._btn.scrollIntoView) {
      try { cur._btn.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
    if (S.concept) {
      S.els.focusLabel.textContent = 'only ' + (S.CLABEL[S.concept] || S.concept);
      S.els.focus.classList.add('is-on');
    } else {
      S.els.focus.classList.remove('is-on');
    }
  }

  /* -------------------------------------------------------------- draw --- */
  function draw(force) {
    var slug = S.slug;
    if (!slug) return Promise.resolve();
    return Promise.all([loadEngine(), loadBank(slug)]).then(function (r) {
      var okEngine = r[0], bank = r[1];
      paintHeader();
      if (!okEngine || !bank) {
        if (window.TARA_SHELL === 'v2' && APP.oops) {
          /* V2: the calm oops panel (offline: "not saved yet"), with Try again */
          S.els.stage.className = 'drill-stage';
          S.els.stage.textContent = '';
          S.els.stage.appendChild(APP.oops(S.loadErr || new Error(okEngine ? 'the ' + slug + ' questions did not load' : 'the quiz engine did not load'),
            function () { S.loadErr = null; draw(true); }));
          return;
        }
        S.els.stage.className = 'drill-stage drill-fallback';
        S.els.stage.textContent = okEngine
          ? 'That bank would not load. Pick another week above.'
          : 'The quiz engine would not load, so there is nothing to drill right now.';
        return;
      }
      /* Keep an unfinished session alive when re-entering the same week; a
         finished one, or an explicit redraw, always gets a fresh shuffle. */
      if (!force && S.inst && S.inst.el === S.els.stage && S.inst.week === slug &&
          S.answered > 0 && S.answered < S.size) {
        paintShaky();
        return;
      }
      S.els.stage.className = 'drill-stage';
      S.answered = 0;
      var opts = {
        el: S.els.stage,
        bank: bank,
        week: slug,
        sessionSize: S.size,
        onConcept: function (id) {
          if (!S.CLABEL[id]) return;
          S.concept = id;
          APP.navigate('#drill/' + S.slug + '/' + encodeURIComponent(id), { replace: true });
          draw(true);
        }
      };
      if (S.concept) opts.concepts = [S.concept];
      S.inst = window.TARA_QUIZ ? window.TARA_QUIZ.mount(opts) : null;
      if (!S.inst) {
        S.els.stage.className = 'drill-stage drill-fallback';
        S.els.stage.textContent = 'That bank would not load. Pick another week above.';
      }
      decorateChips();
      paintShaky();
    });
  }

  /* ------------------------------------------------------ what's shaky --- */
  function paintShaky() {
    if (!S.els.shaky) return;
    var st = window.TARA_QUIZ && window.TARA_QUIZ.stats ? window.TARA_QUIZ.stats() : null;
    if (!st) return;
    var per = st.perQuestion || {}, agg = {}, touched = {}, banks = {};
    Object.keys(per).forEach(function (qid) {
      var r = per[qid], idx = S.QIDX[qid];
      if (!r || !r.seen || !idx || !idx.c) return;
      banks[idx.w] = true;
      var a = agg[idx.c] || (agg[idx.c] = { id: idx.c, seen: 0, wrong: 0, banks: {} });
      a.seen += r.seen; a.wrong += r.wrong; a.banks[idx.w] = true;
      touched[idx.c] = true;
    });
    var rows = Object.keys(agg).map(function (k) { return agg[k]; })
      .filter(function (a) { return a.wrong > 0; })
      .sort(function (a, b) {
        var sa = a.wrong / a.seen, sb = b.wrong / b.seen;
        return sb - sa || b.wrong - a.wrong;
      }).slice(0, 6);

    var out = document.createDocumentFragment();
    var h = document.createElement('h2');
    h.appendChild(document.createTextNode("What's shaky"));
    if (rows.length) {
      var n = document.createElement('span');
      n.className = 'drill-n';
      n.textContent = String(rows.length);
      h.appendChild(n);
    }
    out.appendChild(h);

    if (!rows.length) {
      var p = document.createElement('p');
      p.className = 'drill-shaky-empty';
      p.textContent = Object.keys(touched).length
        ? 'Nothing shaky yet — everything you have touched has held up. Keep going.'
        : 'Answer a few and the concepts you keep dropping collect here — across every bank you touch, not just this one.';
      out.appendChild(p);
    } else {
      var ol = document.createElement('ol');
      rows.forEach(function (a) {
        var li = document.createElement('li');
        var top = document.createElement('div');
        top.className = 'drill-sh-top';
        var name = document.createElement('button');
        name.type = 'button';
        name.className = 'drill-sh-name';
        name.textContent = S.CLABEL[a.id] || a.id;
        name.title = 'Drill just this concept';
        var home = Object.keys(a.banks)[0];
        name.addEventListener('click', function () {
          APP.navigate('#drill/' + home + '/' + encodeURIComponent(a.id));
        });
        var miss = document.createElement('span');
        miss.className = 'drill-sh-miss';
        miss.textContent = a.wrong + ' missed';
        top.appendChild(name); top.appendChild(miss);
        var bar = document.createElement('div');
        bar.className = 'drill-sh-bar';
        var fill = document.createElement('i');
        fill.style.width = Math.max(8, Math.round(100 * a.wrong / a.seen)) + '%';
        bar.appendChild(fill);
        var from = document.createElement('div');
        from.className = 'drill-sh-from';
        Object.keys(a.banks).forEach(function (slug) {
          var s = document.createElement('span');
          s.textContent = (BYSLUG[slug] && BYSLUG[slug].name) || slug;
          from.appendChild(s);
        });
        var links = conceptLinks(a.id);
        if (links) from.appendChild(links);
        li.appendChild(top); li.appendChild(bar); li.appendChild(from);
        ol.appendChild(li);
      });
      out.appendChild(ol);
    }

    var foot = document.createElement('div');
    foot.className = 'drill-shaky-foot';
    var l = document.createElement('span');
    var nb = Object.keys(banks).length;
    l.textContent = Object.keys(touched).length
      ? Object.keys(touched).length + ' concepts seen · ' + nb + ' bank' + (nb === 1 ? '' : 's')
      : 'nothing tracked yet';
    var rr = document.createElement('span');
    rr.textContent = st.storage === 'memory' ? 'this tab only' : 'saved on this device';
    foot.appendChild(l); foot.appendChild(rr);
    out.appendChild(foot);

    while (S.els.shaky.firstChild) S.els.shaky.removeChild(S.els.shaky.firstChild);
    S.els.shaky.appendChild(out);
  }

  /* ------------------------------------------------------------- route --- */
  var SLUG_BY_LOWER = {};
  WEEKS.forEach(function (w) { SLUG_BY_LOWER[w.slug.toLowerCase()] = w.slug; });

  function parseRoute(route) {
    var raw = (route && (route.raw || route.hash)) || '';
    raw = String(raw).replace(/^#/, '');
    var m = /^drill(?:\/(.*))?$/.exec(raw);
    var rest = m && m[1] ? m[1] : '';
    if (!rest && route && route.params) {
      rest = [route.params.week || route.params.slug || '', route.params.concept || '']
        .filter(Boolean).join('/');
    }
    if (!rest) return { slug: null, concept: null };
    var parts = rest.split('/');
    var slug = SLUG_BY_LOWER[String(parts[0] || '').trim().toLowerCase()] || null;
    var concept = parts[1] ? decodeURIComponent(parts[1]) : null;
    return { slug: slug, concept: concept };
  }

  /* -------------------------------------------------------------- mount -- */
  APP.registerSection({
    id: 'drill',
    title: 'Drill',
    navOrder: 70,

    mount: function (el, route) {
      if (!S.built) build(el);
      else if (!el.contains(S.root)) el.appendChild(S.root);

      /* the case-card roster decides which concepts get a "used" link */
      if (!Object.keys(S.CASE_IDS).length) {
        APP.payloadJSON('concepts-index').then(function (ix) {
          ((ix && ix.concepts) || []).forEach(function (c) {
            S.CASE_IDS[c.id] = true;
            if (!S.CLABEL[c.id]) S.CLABEL[c.id] = c.title || c.id;
          });
        }).catch(function () {});
      }

      var r = parseRoute(route || APP.route());
      var want = r.slug || S.slug || defaultSlug();
      var changed = want !== S.slug || (r.concept || null) !== S.concept;
      S.slug = want;
      S.concept = r.concept || null;

      return loadAll().then(function () {
        return draw(changed || !S.inst);
      });
    },

    unmount: function () {},

    /* SPEC §8: distinct concepts across the banks + question counts.
       Hash is #drill/<slug>/<concept>, which preselects the concept. */
    search: function (q) {
      return loadAll().then(function () {
        var raw = String(q || '').trim().toLowerCase();
        if (!raw) return [];
        var counts = {};
        Object.keys(S.QIDX).forEach(function (qid) {
          var e = S.QIDX[qid];
          if (!e || !e.c) return;
          var a = counts[e.c] || (counts[e.c] = { n: 0, banks: {} });
          a.n++;
          a.banks[e.w] = (a.banks[e.w] || 0) + 1;
        });
        var out = [];
        Object.keys(counts).forEach(function (id) {
          var lab = S.CLABEL[id] || id;
          var l = lab.toLowerCase();
          if (id.indexOf(raw) < 0 && l.indexOf(raw) < 0) return;
          /* SPEC §8 weights come from the shell so every group ranks alike */
          var score = typeof APP.score === 'function'
            ? APP.score(raw, { id: id, title: lab, body: id })
            : (id === raw ? 100 : (l.indexOf(raw) === 0 ? 60 : 40));
          if (!score) score = 15;
          var banks = counts[id].banks;
          var home = Object.keys(banks).sort(function (a, b) { return banks[b] - banks[a]; })[0];
          out.push({
            title: lab,
            sub: counts[id].n + (counts[id].n === 1 ? ' question' : ' questions') +
              ' · ' + ((BYSLUG[home] || {}).name || home),
            hash: '#drill/' + home + '/' + encodeURIComponent(id),
            score: score
          });
        });
        out.sort(function (a, b) { return b.score - a.score || a.title.localeCompare(b.title); });
        return out.slice(0, 8);
      });
    }
  });

  void esc;
})();
