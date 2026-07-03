/* ---------- resizable panels ---------- */
function clampResize(v, min, max) { return Math.max(min, Math.min(max, v)); }
function setupHorizontalResize(handle, panel, side, minW, maxW, cssVar) {
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    function move(ev) {
      const dx = ev.clientX - startX;
      const w = clampResize((side === 'left' ? startW + dx : startW - dx), minW, maxW);
      panel.style.width = w + 'px';
      if (cssVar) document.documentElement.style.setProperty(cssVar, w + 'px');
    }
    function up() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
function setupVerticalResize(handle, panel, minH, maxH) {
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = panel.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    function move(ev) {
      const dy = ev.clientY - startY;
      const h = clampResize(startH - dy, minH, maxH);
      panel.style.height = h + 'px';
    }
    function up() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
setupHorizontalResize(document.getElementById('leftResizeHandle'), document.querySelector('.left-panel'), 'left', 310, 480, '--left-panel-w');
setupHorizontalResize(document.getElementById('rightResizeHandle'), document.querySelector('.right-panel'), 'right', 280, 540);
setupVerticalResize(document.getElementById('bottomResizeHandle'), document.querySelector('.bottom-panel'), 100, 560);

/* ---------- watchlist row selection (delegated so added rows work too) ---------- */
(function () {
  const wlRows = document.getElementById('wlRows');
  if (!wlRows) return;
  function selectRow(row) {
    wlRows.querySelectorAll('.wl-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
  wlRows.addEventListener('click', (e) => {
    const row = e.target.closest('.wl-row');
    if (row) selectRow(row);
  });
  wlRows.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.wl-row');
    if (row) { e.preventDefault(); selectRow(row); }
  });
})();

/* ---------- watchlist category tabs + search ---------- */
(function () {
  const tabs = document.querySelectorAll('#wlTabs .wl-tab');
  const searchInput = document.getElementById('wlSearchInput');
  const emptyMsg = document.getElementById('wlEmpty');
  let activeCat = 'all';
  /* query rows live so symbols added after init are still filtered */
  function applyFilter() {
    const q = searchInput.value.trim().toUpperCase();
    let visibleCount = 0;
    document.querySelectorAll('#wlRows .wl-row').forEach(row => {
      const matchesCat = activeCat === 'all' || row.dataset.cat === activeCat;
      const matchesSearch = !q || row.dataset.sym.toUpperCase().includes(q);
      const show = matchesCat && matchesSearch;
      row.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });
    emptyMsg.style.display = visibleCount === 0 ? 'block' : 'none';
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      activeCat = tab.dataset.cat;
      applyFilter();
    });
  });
  searchInput.addEventListener('input', applyFilter);
  window.applyWatchlistFilter = applyFilter;
  applyFilter();
})();

const qtyInput = document.querySelector('.qty-input');

