/* lab/ui/bar.js: the Lab under the TARA bar (shared/tara-bar.js). A classic script, loaded right after
   the Lab's header so the bar is there on first paint.
   - The bar: lockup, tabs (Lab current), "TARA" up (to the shell's Lab tab in V2 mode, else to Today),
     the title, the tier control (and the lamp in V2 mode). It scrolls away; the Lab's own row of tabs
     (Today, Tools, Results, Missions, About) is the sticky part, with the model button (on a phone the
     model button rides in the bar instead, so the Lab's five tabs fit one row).
   - The reading layer (vendor/tara-layer.js) keeps its glossary, its tiered copy, its popovers and its
     review queue, but nothing of it floats over the page: its control and its pill go (the tier is the
     bar's one control) and a Review button in flow opens the layer's own review panel: in the Lab's
     sticky row on a wide screen, at the end of the page on a phone. For V1 visitors the pill's links
     (Plan, Map) come along beside it. The layer and the bar stay on one tier (the layer's tara:tier
     event reaches the bar; the bar calls TARA.setTier).
   Without the bar (the script failed to load) the Lab's own header and the floating layer stay as they
   were. */
(function () {
  'use strict';
  var TB = window.TaraBar;
  if (!TB) return;
  var shellV2 = TB.isV2();
  var back = document.querySelector('.bar .back');     // the Lab's own back link (hidden under the bar)

  var B = TB.mount({
    tab: 'lab', title: 'The Lab', titleHref: '#today', slim: false,
    up: { href: TB.shellHref(shellV2 ? '#lab' : '#today'), label: 'TARA', title: shellV2 ? 'Back to the Lab tab in TARA' : 'Back to the TARA app' }
  });
  if (B.mode !== 'full') {            // inside the shell's viewer: no bar, no back link
    if (back) back.hidden = true;
    return;
  }
  var bar = B.el, sub = document.querySelector('header.bar');
  if (sub && bar.nextSibling !== sub && sub.parentNode) sub.parentNode.insertBefore(bar, sub);

  /* the reading layer's way in, in flow: Review (with its count), and for V1 visitors the layer's Plan
     and Map links (filled in once the layer is up) */
  var read = document.createElement('div');
  read.className = 'lab-read';
  var links = document.createElement('span');
  links.className = 'lab-readlinks';
  read.appendChild(links);
  var rev = document.createElement('button');
  rev.type = 'button';
  rev.className = 'lab-review';
  rev.hidden = true;                  // until the layer is up
  rev.setAttribute('aria-expanded', 'false');
  rev.title = 'The passages you saved (select text on any page to save one)';
  rev.innerHTML = '<span>Review</span><span class="lab-review-q">queue</span><span class="lab-review-n" hidden></span>';
  read.appendChild(rev);

  /* the model button and Review: in the Lab's sticky row on wide screens; on a phone the model button
     goes up into the bar and Review to the end of the page */
  var chip = document.getElementById('engine-chip'), home = chip && chip.parentNode;
  var phone = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
  function place() {
    var small = !!(phone && phone.matches);
    if (chip && home) {
      if (small) { if (chip.parentNode === home) B.setTools([chip]); }
      else if (chip.parentNode !== home) { home.appendChild(chip); B.setTools([]); }
    }
    read.classList.toggle('is-end', small);
    if (small) {
      var foot = document.querySelector('footer.foot');     // parsed after this script: placed once it is there
      if (foot && foot.parentNode) foot.parentNode.insertBefore(read, foot);
      else if (read.parentNode) read.parentNode.removeChild(read);
    } else if (home) home.insertBefore(read, chip && chip.parentNode === home ? chip : null);
  }
  place();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place);
  if (phone) { if (phone.addEventListener) phone.addEventListener('change', place); else if (phone.addListener) phone.addListener(place); }

  /* ---------------------------------------------------------------- the reading layer */
  var LAYER_CSS =
    '.control,.pill{display:none !important}' +
    /* a wide screen: the review panel hangs under our Review button; a phone: the sheet at the bottom
       that the layer means to draw there (its own narrow rule comes before its base rule and loses) */
    '@media (min-width:761px){.panel{top:var(--lab-review-top,120px) !important;right:var(--lab-review-right,16px) !important;left:auto !important}}' +
    '@media (max-width:760px){.panel{top:auto !important;bottom:10px !important;left:10px !important;right:10px !important;width:auto !important;max-height:66vh !important}}';
  var host = null, sh = null, wired = false;
  function panel() { return sh && sh.querySelector('.panel'); }
  function paintCount() {
    var T = window.TARA, n = 0;
    try { n = T && T.review ? T.review.list().length : 0; } catch (e) { n = 0; }
    var b = rev.querySelector('.lab-review-n');
    b.textContent = String(n);
    b.hidden = !n;
    rev.setAttribute('aria-label', 'Review queue: ' + (n ? n + ' saved' : 'empty'));
  }
  function paintOpen() {
    var p = panel();
    rev.setAttribute('aria-expanded', p && !p.hidden ? 'true' : 'false');
  }
  rev.addEventListener('click', function () {
    var T = window.TARA, p = panel();
    if (!T || !T.review) return;
    if (p && !p.hidden) { var x = p.querySelector('.x'); if (x) x.click(); paintOpen(); return; }
    var r = rev.getBoundingClientRect();
    if (host) {
      host.style.setProperty('--lab-review-top', Math.round(r.bottom + 8) + 'px');
      host.style.setProperty('--lab-review-right', Math.max(8, Math.round(document.documentElement.clientWidth - r.right)) + 'px');
    }
    T.review.open();
    paintOpen();
  });

  function adaptLayer() {
    var T = window.TARA;
    if (!T || typeof T.getTier !== 'function') return false;
    /* belt and braces: a layer from before its rename still announces tier 2 as Generalist */
    if (T.tiers && T.tiers[2] === 'Practitioner') T.tiers[2] = 'Generalist';
    if (!sh) {
      host = document.querySelector('[data-tara-host]');
      sh = host && host.shadowRoot;
      if (sh) {
        var st = document.createElement('style');
        st.setAttribute('data-tara-bar', '');
        st.textContent = LAYER_CSS;
        sh.appendChild(st);
        /* V1 visitors keep the pill's links (Plan, Map ...), here in flow; V2's tabs already have them */
        if (!shellV2) {
          var as = sh.querySelectorAll('.pill a');
          for (var i = 0; i < as.length; i++) { var a = as[i].cloneNode(true); a.className = 'lab-readlink'; links.appendChild(a); }
        }
        rev.hidden = false;
        paintCount();
        paintOpen();
        /* the count follows the layer's own badge; aria-expanded follows its panel */
        try {
          var badge = sh.querySelector('.badge'), p = panel();
          if (badge) new MutationObserver(paintCount).observe(badge, { childList: true, characterData: true, subtree: true });
          if (p) new MutationObserver(paintOpen).observe(p, { attributes: true, attributeFilter: ['hidden'] });
        } catch (e) { /* */ }
        window.addEventListener('storage', paintCount);
      }
    }
    if (!wired) {
      wired = true;
      if (Number(T.getTier()) !== TB.tier()) T.setTier(TB.tier());
      TB.onTier(function (n) { try { if (Number(T.getTier()) !== n) T.setTier(n); } catch (e) { /* */ } });
    }
    return !!sh;
  }
  window.addEventListener('tara:ready', adaptLayer);
  if (!adaptLayer()) {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(adaptLayer, 0); });
    window.addEventListener('load', adaptLayer);
  }
})();
