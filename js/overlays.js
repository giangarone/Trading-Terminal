/* ---------- Market Scanner modal (fixed position, viewport-level) ---------- */
const marketScannerTrigger = document.getElementById('marketScannerTrigger');
const marketScannerPopup = document.getElementById('marketScannerPopup');
const marketScannerClose = document.getElementById('marketScannerClose');
function closeMarketScannerPopup() {
  marketScannerPopup.classList.remove('show');
  marketScannerTrigger.classList.remove('active');
}
if (marketScannerTrigger) marketScannerTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const willShow = !marketScannerPopup.classList.contains('show');
  if (willShow) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popW = 920;
    const estH = Math.min(Math.round(vh * 0.86), 720);
    const left = Math.max(8, Math.round((vw - popW) / 2));
    const top  = Math.max(8, Math.round((vh - estH) / 2));
    marketScannerPopup.style.right = 'auto';
    marketScannerPopup.style.left = left + 'px';
    marketScannerPopup.style.top  = top + 'px';
  }
  marketScannerPopup.classList.toggle('show', willShow);
  marketScannerTrigger.classList.toggle('active', willShow);
});
if (marketScannerClose) marketScannerClose.addEventListener('click', (e) => {
  e.stopPropagation();
  closeMarketScannerPopup();
});
const marketScannerRefresh = document.getElementById('marketScannerRefresh');
if (marketScannerRefresh) marketScannerRefresh.addEventListener('click', (e) => e.stopPropagation());
makeDraggableFixed(marketScannerPopup);

/* ---------- chart news visibility toggle ---------- */
const newsToggle = document.getElementById('newsToggle');
const newsMarkerLayerEl = document.getElementById('newsMarkerLayer');
function setNewsOverlay(show) {
  newsMarkerLayerEl.classList.toggle('show', show);
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
