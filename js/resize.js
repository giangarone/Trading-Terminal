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
    if (collapsed) {
      /* Remember the current expanded width (tracked in the CSS var, which the
         resize drag keeps in sync) so expanding restores it. Reading the var
         avoids box-model padding drift and the rail width when the page loads
         already-collapsed. */
      const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
      if (v) lastWidth = v;
      panel.classList.add('is-collapsed');
      document.querySelector('.app').classList.add(appClass);
      panel.style.width = '';
    } else {
      panel.classList.remove('is-collapsed');
      document.querySelector('.app').classList.remove(appClass);
      panel.style.width = lastWidth;
      document.documentElement.style.setProperty(cssVar, lastWidth);
    }
    /* Keep the always-visible toggle's tooltip in sync with the action it does. */
    if (expandBtn) {
      const action = collapsed ? 'Expand panel' : 'Collapse panel';
      expandBtn.title = action;
      expandBtn.setAttribute('aria-label', action);
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
      setCollapsed(!state[side], true);
    });
  }

  applyCollapsed(state[side]);
}

/*
 * Wires up the bottom panel so dragging its handle both resizes and
 * collapses/expands it — the same reversible gesture the side panels use.
 * Dragging below half the minimum height snaps it closed to the tab bar;
 * dragging back out reopens it. This coexists with the tab-click toggle in
 * workspace.js (both drive the `bp-collapsed` class), so the panel's
 * collapsed/expanded body stays in sync however it was triggered.
 */
function setupVerticalResize(handle, panel, minH, maxH) {
  if (!handle || !panel) return;
  const collapseThreshold = minH * 0.5;

  /* When expanding with no tab selected (e.g. dragging open from the initial
     collapsed state), show the first panel so the body isn't blank — mirrors
     the tab-click path, which always activates a panel when it expands. */
  function ensureActivePanel() {
    if (panel.querySelector('#bpTabs .bp-tab.active')) return;
    const firstTab = panel.querySelector('#bpTabs .bp-tab');
    if (!firstTab) return;
    firstTab.classList.add('active');
    const target = document.getElementById('bpPanel-' + firstTab.dataset.panel);
    if (target) target.classList.add('active');
  }

  /* Collapsing clears the active tab, matching the tab-click collapse. */
  function clearActivePanel() {
    panel.querySelectorAll('#bpTabs .bp-tab').forEach(b => b.classList.remove('active'));
    panel.querySelectorAll('.bp-table-wrap').forEach(p => p.classList.remove('active'));
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    /* The bottom edge stays anchored; the panel height is a pure function of the
       cursor Y, so crossing the threshold up/down toggles collapse reversibly
       within a single drag. */
    const bottomEdge = panel.getBoundingClientRect().bottom;
    const impliedHeight = (ev) => bottomEdge - ev.clientY;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    function move(ev) {
      const h = impliedHeight(ev);
      if (h < collapseThreshold) {
        if (!panel.classList.contains('bp-collapsed')) {
          clearActivePanel();
          panel.classList.add('bp-collapsed');
        }
        return;
      }
      if (panel.classList.contains('bp-collapsed')) {
        panel.classList.remove('bp-collapsed');
        ensureActivePanel();
      }
      panel.style.height = clampResize(h, minH, maxH) + 'px';
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
setupPanel(document.getElementById('leftResizeHandle'), document.querySelector('.left-panel'), document.getElementById('leftPanelToggle'), 'left', 290, 360, '--left-panel-w', '290px', 'is-left-collapsed');
setupPanel(document.getElementById('rightResizeHandle'), document.querySelector('.right-panel'), document.getElementById('rightPanelToggle'), 'right', 280, 360, '--right-panel-w', '300px', 'is-right-collapsed');
setupVerticalResize(document.getElementById('bottomResizeHandle'), document.querySelector('.bottom-panel'), 100, 560);

/* ---------- watchlist row selection (delegated so added rows work too) ---------- */
(function () {
  const wlRows = document.getElementById('wlRows');
  if (!wlRows) return;
  function selectRow(row) {
    wlRows.querySelectorAll('.wl-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    // Switch the active symbol too — relabels the topbar and reconfigures the Quick Trade panel.
    if (window.switchSymbol && row.dataset.sym) window.switchSymbol(row.dataset.sym);
  }
  wlRows.addEventListener('click', (e) => {
    const row = e.target.closest('.wl-row');
    if (!row) return;
    /* the per-row × removes the symbol instead of selecting it */
    if (e.target.closest('.wl-remove')) {
      if (window.removeWatchlistSymbol) window.removeWatchlistSymbol(row.dataset.sym);
      if (window.showToast) window.showToast('Removed ' + row.dataset.sym + ' from watchlist', 'remove');
      return;
    }
    selectRow(row);
  });
  /* Enter/Space activation is handled globally in app.js (the rows carry role="button"),
     so no per-list keydown is needed here. */
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

