/* ---------- resizable + collapsible panels ---------- */
function clampResize(v, min, max) { return Math.max(min, Math.min(max, v)); }

const PANEL_COLLAPSE_KEY = 'tt_panelCollapse';

function loadPanelCollapseState() {
  try {
    const raw = localStorage.getItem(PANEL_COLLAPSE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore corrupt storage */ }
  return { left: false, right: false };
}

function savePanelCollapseState(state) {
  try { localStorage.setItem(PANEL_COLLAPSE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
}

/*
 * Wires up a side panel that can be resized by dragging its handle and
 * collapsed to a slim rail. Dragging the panel below half its minimum width
 * snaps it closed; the expand button (only shown while collapsed) restores it.
 */
function setupPanel(handle, panel, expandBtn, side, minW, maxW, cssVar, defaultWidth, appClass) {
  if (!handle || !panel) return;
  const state = loadPanelCollapseState();
  const collapseThreshold = minW * 0.5;
  let lastWidth = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || defaultWidth;

  function applyCollapsed(collapsed) {
    panel.classList.toggle('is-collapsed', collapsed);
    document.querySelector('.app').classList.toggle(appClass, collapsed);
    if (collapsed) {
      lastWidth = panel.style.width || getComputedStyle(panel).width;
      panel.style.width = '';
    } else {
      panel.style.width = lastWidth;
      document.documentElement.style.setProperty(cssVar, lastWidth);
    }
  }

  /* Applies collapsed state + visuals; only writes to storage when `persist`. */
  function setCollapsed(collapsed, persist) {
    if (state[side] !== collapsed) {
      state[side] = collapsed;
      applyCollapsed(collapsed);
    }
    if (persist) savePanelCollapseState(state);
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.resize-toggle')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    /* Anchored outer edge — the side that stays put while the panel resizes.
       The width implied by the cursor is measured from it, so the panel's
       collapsed/expanded state is a pure function of the cursor position. That
       keeps the whole gesture reversible: crossing the threshold back and forth
       toggles the panel without ever releasing the mouse. */
    const outerEdge = (side === 'left') ? rect.left : rect.right;
    const impliedWidth = (ev) => (side === 'left' ? ev.clientX - outerEdge : outerEdge - ev.clientX);
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    function move(ev) {
      const x = impliedWidth(ev);
      if (x < collapseThreshold) {
        /* Below the threshold: snap to the rail, but keep the drag alive so the
           user can reverse straight back out. */
        setCollapsed(true, false);
        return;
      }
      /* At/above the threshold: (re)open. clampResize pins the panel at its
         minimum until the cursor passes the handle, then tracks it 1:1. */
      setCollapsed(false, false);
      const w = clampResize(x, minW, maxW);
      panel.style.width = w + 'px';
      document.documentElement.style.setProperty(cssVar, w + 'px');
    }
    function up() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      savePanelCollapseState(state);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  if (expandBtn) {
    expandBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCollapsed(false, true);
    });
  }

  applyCollapsed(state[side]);
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
setupPanel(document.getElementById('leftResizeHandle'), document.querySelector('.left-panel'), document.getElementById('leftPanelToggle'), 'left', 290, 480, '--left-panel-w', '290px', 'is-left-collapsed');
setupPanel(document.getElementById('rightResizeHandle'), document.querySelector('.right-panel'), document.getElementById('rightPanelToggle'), 'right', 280, 540, '--right-panel-w', '300px', 'is-right-collapsed');
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

