/* lab/hook.js: joins the Lab (live GPT-2 tools and the bench's results) to the app shell without touching the
   generated shell code. Adds a "Lab" item to the nav, after 3D (or Films when 3D is absent). */
(function () {
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
