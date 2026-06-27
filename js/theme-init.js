/* Runs synchronously before the stylesheets resolve, so the correct theme
   attribute is in place before first paint — no flash of the wrong theme. */
(function () {
  var stored = null;
  try { stored = localStorage.getItem('tt_theme'); } catch (e) { /* storage unavailable */ }
  document.documentElement.setAttribute('data-theme', stored === 'light' ? 'light' : 'dark');
})();
