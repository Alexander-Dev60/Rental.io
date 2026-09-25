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
})();
