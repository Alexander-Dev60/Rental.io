/* public.js — shared behaviour for the PUBLIC pages only (theme toggle + extra icons).
   Load it directly AFTER icons.js. Dashboards do not load this file. */
(function () {
  'use strict';

  var KEY = 'ar-public-theme';
  var COLORS = { dark: '#0b0f1a', light: '#f5f1e6' };
  var root = document.documentElement;

  /* ---- extra icons, registered onto the existing ICON() set ---- */
  var EXTRA = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
  };
  try {
    if (typeof ICON_PATHS !== 'undefined') {
      Object.keys(EXTRA).forEach(function (k) { if (!ICON_PATHS[k]) ICON_PATHS[k] = EXTRA[k]; });
    }
  } catch (e) { /* icons.js missing: toggle falls back to text-free empty button */ }

  function icon(name, size) {
    try { return typeof ICON === 'function' ? ICON(name, size) : ''; } catch (e) { return ''; }
  }

  /* ---- theme ---- */
  function stored() {
    try { var v = localStorage.getItem(KEY); return (v === 'light' || v === 'dark') ? v : null; }
    catch (e) { return null; }
  }
  function system() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function current() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  function syncButtons(t) {
    var next = t === 'light' ? 'dark' : 'light';
    var btns = document.querySelectorAll('.ar-theme-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-label', 'Switch to ' + next + ' theme');
      btns[i].setAttribute('title', 'Switch to ' + next + ' theme');
    }
  }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', COLORS[t]);
    syncButtons(t);
    try { document.dispatchEvent(new CustomEvent('ar-theme-change', { detail: { theme: t } })); } catch (e) {}
  }
  function choose(t) {
    apply(t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
  }

  function buildButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ar-theme-toggle';
    b.innerHTML = '<span class="ar-t-sun">' + icon('sun', 17) + '</span><span class="ar-t-moon">' + icon('moon', 17) + '</span>';
    b.addEventListener('click', function () { choose(current() === 'light' ? 'dark' : 'light'); });
    return b;
  }

  function mount() {
    var slots = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < slots.length; i++) {
      if (!slots[i].querySelector('.ar-theme-toggle')) slots[i].appendChild(buildButton());
    }
    syncButtons(current());
  }

  /* wire any still-empty [data-icon] placeholders (idempotent with each page's own wireIcons) */
  function wireIcons() {
    var els = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.firstElementChild) continue;
      el.innerHTML = icon(el.getAttribute('data-icon'), parseInt(el.getAttribute('data-icon-size'), 10) || 16);
    }
  }

  function init() { mount(); wireIcons(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* keep tabs / pages in sync; follow the OS only while the visitor has not chosen */
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    apply(e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : system());
  });
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onSys = function () { if (!stored()) apply(system()); };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  } catch (e) {}

  window.ARTheme = { get: current, set: choose };

  var INSTALL_STYLE_ID = 'ar-install-styles';
  var INSTALL_BUTTON_ID = 'ar-app-install-btn';

  function ensureInstallStyles() {
    if (document.getElementById(INSTALL_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = INSTALL_STYLE_ID;
    style.textContent = `
      .ar-install-btn {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.52rem 0.9rem;
        border: 1px solid rgba(110, 231, 183, 0.35);
        background: linear-gradient(135deg, rgba(16,185,129,0.14), rgba(34,197,94,0.10));
        color: var(--text, #f8fafc);
        border-radius: 999px;
        font-family: 'Space Grotesk', sans-serif;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
        white-space: nowrap;
      }
      .ar-install-btn:hover {
        transform: translateY(-1px);
        border-color: rgba(110, 231, 183, 0.6);
        background: linear-gradient(135deg, rgba(16,185,129,0.18), rgba(34,197,94,0.12));
      }
    `;
    document.head.appendChild(style);
  }

  function updateInstallButton() {
    var btn = document.getElementById(INSTALL_BUTTON_ID);
    if (!btn) return;

    var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      !!window.navigator.standalone;
    btn.style.display = !!window.__AR_INSTALL_PROMPT__ && !isStandalone ? 'inline-flex' : 'none';
  }

  function mountInstallButton() {
    if (!('serviceWorker' in navigator)) return;
    var target = document.querySelector('.header-right, .topbar-right');
    if (!target || document.getElementById(INSTALL_BUTTON_ID)) return;

    ensureInstallStyles();

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = INSTALL_BUTTON_ID;
    btn.className = 'ar-install-btn';
    btn.textContent = 'Install App';

    btn.addEventListener('click', function () {
      if (!window.__AR_INSTALL_PROMPT__) {
        alert('Install is not available yet. You can still use the browser menu to install this app.');
        return;
      }

      window.__AR_INSTALL_PROMPT__.prompt();
      window.__AR_INSTALL_PROMPT__.userChoice.then(function (choiceResult) {
        if (choiceResult.outcome === 'accepted') {
          console.log('PWA install accepted');
        }
        window.__AR_INSTALL_PROMPT__ = null;
        updateInstallButton();
      });
    });

    target.insertBefore(btn, target.firstChild);
    updateInstallButton();
  }

  if (/(dashboard|tenant|stacklord)\.html$/i.test(window.location.pathname)) {
    window.__AR_EXIT_GUARD__ = true;
    window.addEventListener('beforeunload', function (event) {
      event.preventDefault();
      event.returnValue = 'Are you sure you want to leave this page?';
      return event.returnValue;
    });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    window.__AR_INSTALL_PROMPT__ = event;
    setTimeout(mountInstallButton, 0);
    setTimeout(updateInstallButton, 0);
  });

  window.addEventListener('appinstalled', function () {
    var btn = document.getElementById(INSTALL_BUTTON_ID);
    if (btn) btn.remove();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(mountInstallButton, 0);
      setTimeout(updateInstallButton, 0);
    });
  } else {
    setTimeout(mountInstallButton, 0);
    setTimeout(updateInstallButton, 0);
  }
})();
