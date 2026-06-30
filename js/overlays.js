/* ---------- Market Scanner lives in js/market-scanner.js (full-screen workspace modal) ---------- */

/* ---------- chart news + scheduled-event visibility toggle (one combined button) ---------- */
const newsToggle = document.getElementById('newsToggle');
const newsMarkerLayerEl = document.getElementById('newsMarkerLayer');
const eventLineLayerEl = document.getElementById('eventLineLayer');
function setNewsOverlay(show) {
  newsMarkerLayerEl.classList.toggle('show', show);
  if (eventLineLayerEl) eventLineLayerEl.classList.toggle('show', show);
  newsToggle.classList.toggle('active', show);
}
if (newsToggle) newsToggle.addEventListener('click', () => {
  setNewsOverlay(!newsMarkerLayerEl.classList.contains('show'));
});

/* ---------- chart drawing toolbar (visual only — no drawing functionality yet) ---------- */
(function () {
  const toolbar = document.getElementById('chartDrawToolbar');
  if (!toolbar) return;
  const exclusiveTools = ['Cursor', 'Trend Line', 'Horizontal Line', 'Brush', 'Text', 'Measure', 'Zoom In'];
  const independentToggles = ['Magnet Mode', 'Lock All', 'Hide Drawings'];
  toolbar.querySelectorAll('.cdt-btn').forEach(btn => {
    const tip = btn.dataset.tooltip;
    if (exclusiveTools.includes(tip)) {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.cdt-btn').forEach(b => {
          if (exclusiveTools.includes(b.dataset.tooltip)) b.classList.remove('active');
        });
        btn.classList.add('active');
      });
    } else if (independentToggles.includes(tip)) {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    }
  });
})();
