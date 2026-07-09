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

/* ---------- Quick Market Order — floating, draggable market-order bar ---------- */
(function () {
  const toggle = document.getElementById('quickOrderToggle');
  const panel = document.getElementById('quickOrderPanel');
  if (!toggle || !panel) return;

  // Reads the single account-balance source of truth exposed by app.js (falls back if not yet loaded).
  const availableBalance = () => (window.getAccountBalance ? window.getAccountBalance() : 52430.00);
  const buyBtn = document.getElementById('quickOrderBuy');
  const sellBtn = document.getElementById('quickOrderSell');
  const amountInput = document.getElementById('quickOrderAmount');
  const closeBtn = document.getElementById('quickOrderClose');
  const handle = panel.querySelector('.qop-drag-handle');
  const chartArea = document.getElementById('chartPaneArea');

  function currentPrice() {
    const el = document.getElementById('hdrLast');
    return el ? parseFloat(el.textContent.replace(/,/g, '')) : 0;
  }

  // The panel lives inside the chart — position and drag are clamped to these bounds.
  function chartBounds() {
    return chartArea
      ? chartArea.getBoundingClientRect()
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }

  function showPanel(show) {
    panel.classList.toggle('show', show);
    toggle.classList.toggle('active', show);
    // Center the bar near the bottom of the chart the first time it opens; drag persists after.
    if (show && !panel.style.left) {
      const b = chartBounds();
      const left = Math.round(b.left + (b.right - b.left - panel.offsetWidth) / 2);
      const top = Math.round(b.bottom - panel.offsetHeight - 24);
      panel.style.left = Math.max(b.left, left) + 'px';
      panel.style.top = Math.max(b.top, top) + 'px';
    }
  }

  toggle.addEventListener('click', () => showPanel(!panel.classList.contains('show')));
  closeBtn.addEventListener('click', () => showPanel(false));

  // Presets only show while the user is entering an amount (input focused).
  amountInput.addEventListener('focus', () => panel.classList.add('qop-typing'));
  amountInput.addEventListener('blur', () => panel.classList.remove('qop-typing'));

  // Clicking the chart should drop focus from the amount input. The chart's own mousedown
  // handlers call preventDefault (for pan/drag), which otherwise keeps the input focused, so
  // blur it explicitly.
  if (chartArea) chartArea.addEventListener('mousedown', () => amountInput.blur());

  // Percentage presets set the amount as a share of available balance at the live price.
  panel.querySelectorAll('.qop-pct').forEach(btn => {
    // Keep focus on the amount input so clicking a preset doesn't blur it (which would
    // hide the presets before this click lands) and the row stays open for more edits.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const pct = parseFloat(btn.dataset.pct) || 0;
      const price = currentPrice();
      if (!price) return;
      const qty = (pct / 100) * availableBalance() / price;
      amountInput.value = qty.toFixed(2);
      amountInput.focus();
    });
  });

  // Place market orders via the shared app.js pipeline (confirmation gate + fill).
  buyBtn.addEventListener('click', () => {
    if (window.placeQuickMarketOrder) window.placeQuickMarketOrder('buy', amountInput.value);
  });
  sellBtn.addEventListener('click', () => {
    if (window.placeQuickMarketOrder) window.placeQuickMarketOrder('sell', amountInput.value);
  });

  // Drag the bar by its left hamburger handle, clamped to the chart's borders.
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const b = chartBounds();
    const maxLeft = Math.max(b.left, b.right - panel.offsetWidth);
    const maxTop = Math.max(b.top, b.bottom - panel.offsetHeight);
    const left = Math.min(Math.max(b.left, startLeft + (e.clientX - startX)), maxLeft);
    const top = Math.min(Math.max(b.top, startTop + (e.clientY - startY)), maxTop);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})();

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
