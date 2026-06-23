/* ---------- Market Scanner popover (same open/close model as Indicators / L2 Indicators, but ---------- */
/* ---------- opens horizontally centered and can be dragged around by its header)         ---------- */
const marketScannerTrigger = document.getElementById('marketScannerTrigger');
const marketScannerPopup = document.getElementById('marketScannerPopup');
const marketScannerClose = document.getElementById('marketScannerClose');
if (marketScannerTrigger) marketScannerTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  if (marketScannerPopup.classList.contains('show') && marketScannerPopup._openTrigger === marketScannerTrigger) {
    window.closeAllPopovers();
    return;
  }
  window.openNear(marketScannerPopup, marketScannerTrigger.getBoundingClientRect(), 'left', marketScannerTrigger);
  const left = Math.max(8, Math.round((window.innerWidth - marketScannerPopup.offsetWidth) / 2));
  marketScannerPopup.style.left = left + 'px';
});
if (marketScannerClose) marketScannerClose.addEventListener('click', (e) => {
  e.stopPropagation();
  window.closeAllPopovers();
});
const marketScannerRefresh = document.getElementById('marketScannerRefresh');
if (marketScannerRefresh) marketScannerRefresh.addEventListener('click', (e) => e.stopPropagation());

/* keeps the trigger's .active state in sync with the popup regardless of how it closes
   (close button, outside click, Escape, or another pop-menu trigger taking over) */
new MutationObserver(() => {
  marketScannerTrigger.classList.toggle('active', marketScannerPopup.classList.contains('show'));
}).observe(marketScannerPopup, { attributes: true, attributeFilter: ['class'] });

/* drag the popup around by its header, like the legacy chart-popups used to */
(function enableMarketScannerDrag() {
  const head = marketScannerPopup.querySelector('.ind-modal-header');
  if (!head) return;
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.ind-modal-close, .ct-icon')) return;
    dragging = true;
    const rect = marketScannerPopup.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = startLeft + (e.clientX - startX);
    let top = startTop + (e.clientY - startY);
    left = Math.min(Math.max(0, left), vw - marketScannerPopup.offsetWidth);
    top = Math.min(Math.max(0, top), vh - marketScannerPopup.offsetHeight);
    marketScannerPopup.style.left = left + 'px';
    marketScannerPopup.style.top = top + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})();

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
