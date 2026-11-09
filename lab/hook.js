/* lab/hook.js: joins the Lab (live GPT-2 tools and the bench's results) to the app shell without touching the
   generated shell code. Adds a "Lab" item to the nav, after 3D (or Films when 3D is absent).

   V2 (window.TARA_SHELL === 'v2', next.html): nothing; the Lab is one of V2's five tabs.
   V1 (index.html), one addition: while the V2 preview is the shell this tab came from
   (sessionStorage tara.shell === 'next.html', set by next.html on boot), V1's index.html hands
   over to next.html with the same hash, so a link back from the Lab or from a full-page film
   (they all point at index.html) lands in the preview. Only when the referrer is one of those
   pages: opening index.html any other way shows V1 and clears tara.shell for this tab.
   Library's "classic version" door opens index.html in a new tab: a link from next.html, so V1. */
(function () {
  if (window.TARA_SHELL === 'v2') return;
  try {
    var p = location.pathname;
    var onV1 = /(^|\/)(index\.html)?$/.test(p) && !!document.getElementById('app-navlist');
    if (onV1 && sessionStorage.getItem('tara.shell') === 'next.html') {
      /* hand over only when we arrived from a Films, 3D or Lab page (their back links all point at
         index.html); a typed URL, a bookmark or a link from next.html itself opens V1 as asked */
      var fromSubApp = false;
      try {
        var r = document.referrer ? new URL(document.referrer) : null;
        var dir = p.replace(/[^\/]*$/, '');
        if (r && r.origin === location.origin && r.pathname.indexOf(dir) === 0) {
          fromSubApp = /^(intuition|objects|lab)\//.test(r.pathname.slice(dir.length));
        }
      } catch (e2) { fromSubApp = false; }
      if (fromSubApp) {
        location.replace('next.html' + location.search + location.hash);
        return;
      }
      sessionStorage.removeItem('tara.shell');
    }
  } catch (e) { /* no sessionStorage: stay in V1 */ }
  function addNav() {
    var list = document.getElementById('app-navlist');
    if (!list || !list.children.length) return false;
    if (document.getElementById('app-nav-lab')) return true;
    var li = document.createElement('li'); li.className = 'app-navitem';
    var a = document.createElement('a'); a.className = 'app-navlink'; a.id = 'app-nav-lab';
    a.href = 'lab/index.html'; a.textContent = 'Lab';
    a.title = 'Take GPT-2 apart in your browser, and see results from the 3090';
    li.appendChild(a);
    var anchor = document.getElementById('app-nav-3d') || document.getElementById('app-nav-films');
    var after = anchor ? anchor.parentNode.nextSibling : (list.children[1] || null);
    list.insertBefore(li, after);
    return true;
  }
  function start() {
    /* the 3D and Films hooks add their items on their own timers; wait a moment so the order is stable */
    var n = 0, iv = setInterval(function () {
      var ready = document.getElementById('app-nav-3d') || n > 15;
      if ((ready && addNav()) || ++n > 80) clearInterval(iv);
    }, 100);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
