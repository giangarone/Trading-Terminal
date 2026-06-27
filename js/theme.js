/* ================================================================
   THEME CONTROLLER
   A simple dark/light toggle, triggered from the topbar sun/moon icon.
   ================================================================ */
(function () {
  const STORAGE_KEY = 'tt_theme';
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeToggleIcon = document.getElementById('themeToggleIcon');

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch (e) { /* storage unavailable */ }
    return 'dark';
  }

  function applyTheme(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* storage unavailable */ }
    document.documentElement.setAttribute('data-theme', theme);
    themeToggleIcon.textContent = theme === 'light' ? 'light_mode' : 'dark_mode';
    themeToggleBtn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    if (typeof window.ttRepaintChart === 'function') window.ttRepaintChart();
  }

  let currentTheme = getStoredTheme();
  applyTheme(currentTheme);

  themeToggleBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(currentTheme);
  });
})();
