/* ================================================================
   ORDER MANAGEMENT ENGINE
   ================================================================ */
(function () {
  const POINT_VALUE = 50;          // $ per point per contract (ES)
  const FEE_RATE_MARKET = 0.0006;  // 0.06% taker fee (market / stop-market fills)
  const FEE_RATE_LIMIT  = 0.0002;  // 0.02% maker fee (limit / stop-limit fills)
  let TICK = 0.25;
  const PX_PER_POINT = 22;         // vertical px per 1.0 point
  const BASE_PRICE = 4500.25;      // anchors chart's vertical price scale
  const AXIS_RIGHT_W = 68;         // width reserved for the price axis gutter
  const AXIS_BOTTOM_H = 24;        // height reserved for the time axis gutter
  const BAR_INTERVAL_MIN = 15;     // minutes per candle, matches the active "15m" timeframe
  const FUTURE_BARS = 24;          // empty bar-slots reserved on the right so the time axis continues past "now"
  const VISIBLE_BARS = 90;         // default on-screen candle density; older bars sit off to the left, reachable by panning
  const MARGIN_PER_CONTRACT = 13200; // mock margin / contract (ballpark ES futures margin)
  const BUYING_POWER = 87643.20;   // matches Order Entry panel
  const ACCOUNT_BALANCE = 20000;   // mock, used for % of Account mode

  const chart = document.getElementById('chartPlaceholder');
  const layer = document.getElementById('orderLineLayer');
  const newsMarkerLayer = document.getElementById('newsMarkerLayer');
  const toastStack = document.getElementById('toastStack');
  const priceCanvas = document.getElementById('priceChartCanvas');

  let order = null;
  let tpCounter = 1;
  let pendingClickPrice = BASE_PRICE;
  let activeGearTpId = null;          // which TP a gear-menu / modal call refers to
  let exitModal = null;                // {tpId, mode, pct}

  /* ---------- Chart Settings: Trade Management defaults ---------- */
  const CS_DEFAULTS = {
    tpSlDisplayMode: 'condensed',      // 'condensed' = manual TP/SL (default), 'expanded' = auto-add using defaultTargets/defaultStopLoss
    defaultProfile: 'scalp',
    defaultTargets: [
      { pct: 50, r: 1.0, type: 'limit' },
      { pct: 25, r: 2.0, type: 'limit' },
      { pct: 25, r: 4.0, type: 'limit' }
    ],
    defaultStopLoss: { r: 1.0, type: 'stopMarket' },
    moveSlToBreakeven: { trigger: 'tp1', customR: 1, offsetValue: 1, offsetUnit: 'ticks' },
    trailingStop: { method: 'fixed', distanceValue: 1.0, distanceUnit: 'percent', start: 'immediate', startCustomR: 1, atrMultiplier: 2.0 },
    atrStop: { length: 14, multiplier: 2.0, timeframe: 'current', updateFreq: 'newbar', dynamic: true },
    trailingTp: { activation: 'tp1', activationCustomR: 1, method: 'fixed', distanceValue: 20, distanceUnit: 'ticks' },
    globalBehavior: { cancelOnManualClose: true, recalcOnSizeChange: true, persist: true }
  };
  function cloneCsDefaults() { return JSON.parse(JSON.stringify(CS_DEFAULTS)); }
  function loadChartSettings() {
    try {
      const raw = localStorage.getItem('tt_chartSettings');
      if (raw) {
        const merged = Object.assign(cloneCsDefaults(), JSON.parse(raw));
        // 'Points' was removed as a trailing-distance unit — migrate any persisted value to %
        if (merged.trailingStop && merged.trailingStop.distanceUnit === 'points') merged.trailingStop.distanceUnit = 'percent';
        return merged;
      }
    } catch (e) { /* ignore corrupt storage */ }
    return cloneCsDefaults();
  }
  let chartSettings = loadChartSettings();
  function persistChartSettingsIfEnabled() {
    if (!chartSettings.globalBehavior.persist) return;
    try { localStorage.setItem('tt_chartSettings', JSON.stringify(chartSettings)); } catch (e) { /* storage unavailable */ }
  }

  /* ---------- order history & alerts state ---------- */
  let alertCounter = 1;
  let alerts = [];
  function nowTimeStr() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  let orderHistory = [
    { symbol: 'ETHUSD', side: 'buy',  qty: 2, price: 4486.50, status: 'filled',    type: 'Market', time: '09:15:32 AM', pnl: null },
    { symbol: 'NQU5',   side: 'buy',  qty: 1, price: 18480.00, status: 'filled',   type: 'Market', time: '09:18:47 AM', pnl: null },
    { symbol: 'RTYU5',  side: 'buy',  qty: 3, price: 2070.00,  status: 'cancelled', type: 'Market', time: '08:55:10 AM', pnl: null },
  ];

  /* ---------- trade history state ----------
     Only actual fill executions — no cancels, no pending orders.
     pnl: realized P&L in dollars for closing trades; null for opening trades. */
  let tradeHistory = [
    { symbol: 'ETHUSD', side: 'buy',  qty: 2, price: 4486.50,  pnl: null,       role: 'open',  type: 'Market',     time: '09:15:32 AM', fee: 2.50 },
    { symbol: 'NQU5',   side: 'buy',  qty: 1, price: 18480.00, pnl: null,       role: 'open',  type: 'Market',     time: '09:18:47 AM', fee: 1.25 },
    { symbol: 'ETHUSD', side: 'sell', qty: 1, price: 4562.25,  pnl: 3787.50,    role: 'close', type: 'Limit (TP)', time: '10:03:18 AM', fee: 1.25 },
    { symbol: 'NQU5',   side: 'sell', qty: 1, price: 18560.00, pnl: 4000.00,    role: 'close', type: 'Limit (TP)', time: '10:41:55 AM', fee: 1.25 },
    { symbol: 'ETHUSD', side: 'sell', qty: 1, price: 4495.00,  pnl: 425.00,     role: 'close', type: 'Market',     time: '11:12:40 AM', fee: 1.25 },
  ];

  /* ---------- helpers ---------- */
  function fmt(n, dec) {
    dec = dec === undefined ? 2 : dec;
    const neg = n < 0; n = Math.abs(n);
    const parts = n.toFixed(dec).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function fmtMoney(n) { return (n < 0 ? '-$' : '$') + fmt(Math.abs(n)); }
  function roundTick(p) { return Math.round(p / TICK) * TICK; }
  function rectH() { return chart.getBoundingClientRect().height; }
  let panX = 0, panY = 0; // panX: px shift of candles; panY: price shift applied to whole scale
  let panXInitialized = false; // on first draw, panX is set to push candles left, leaving more empty space on the right
  let crosshair = null; // {x,y} in CSS px relative to chart, within plot bounds, or null when not hovering
  let hoveredHandle = null; // 'entry' | 'sl' | 'tp:<id>' | 'tp-add' | 'sl-add' | null — which order-line handle is currently hovered
  let isDraggingOrderLine = false; // true for the duration of any order-line drag — blocks the price-tick auto-render from wiping live drag visuals
  let isHoveringBarControls = false; // true when pointer is over a non-drag interactive element inside an entry/TP/SL bar — suppresses the chart crosshair
  layer.addEventListener('mouseover', (e) => {
    if (e.target.closest('.ol-pill-seg, .ol-gear, .ol-amt, .ol-pct-chip, .ol-entry-pnl')) {
      isHoveringBarControls = true;
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); }
    }
  });
  layer.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest('.ol-pill-seg, .ol-gear, .ol-amt, .ol-pct-chip, .ol-entry-pnl')) {
      isHoveringBarControls = false;
    }
  });
  function priceToY(price, h) { const ih = h - AXIS_BOTTOM_H; return ih / 2 - (price - BASE_PRICE - panY) * PX_PER_POINT; }
  function yToPrice(y, h) { const ih = h - AXIS_BOTTOM_H; return BASE_PRICE + panY - (y - ih / 2) / PX_PER_POINT; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function showToast(msg, icon) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span class="material-symbols-outlined">' + (icon || 'info') + '</span><span>' + msg + '</span>';
    toastStack.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  /* ---------- popover positioning ---------- */
  function closeAllPopovers() {
    document.querySelectorAll('.pop-menu.show, .ctx-menu.show').forEach(m => {
      if (!m.dataset.persistent) m.classList.remove('show');
    });
  }
  function openAt(el, x, y) {
    closeAllPopovers();
    const vw = window.innerWidth, vh = window.innerHeight;
    el.classList.add('show');
    const w = el.offsetWidth, h = el.offsetHeight;
    if (x + w > vw - 12) x = vw - w - 12;
    if (y + h > vh - 12) y = vh - h - 12;
    el.style.left = Math.max(8, x) + 'px';
    el.style.top = Math.max(8, y) + 'px';
  }
  function positionPopover(el, anchorRect, align) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = align === 'right' ? anchorRect.right - w : anchorRect.left;
    let y = anchorRect.bottom + 8;
    if (y + h > vh - 12) y = anchorRect.top - h - 8;
    if (x + w > vw - 12) x = vw - w - 12;
    if (x < 8) x = 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
  function openNear(el, anchorRect, align, trigger) {
    if (trigger && el.classList.contains('show') && el._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    /* if this popover was triggered from inside another already-open popover (e.g. a dropdown */
    /* nested in the SL gear menu), keep that parent open instead of closing it out from under the user */
    const parentMenu = trigger ? trigger.closest('.pop-menu, .ctx-menu') : null;
    closeAllPopoversExcept(el, parentMenu);
    el.classList.add('show');
    el._openTrigger = trigger || null;
    positionPopover(el, anchorRect, align);
  }
  function closeAllPopoversExcept(...keep) {
    document.querySelectorAll('.pop-menu.show, .ctx-menu.show').forEach(m => {
      if (m.dataset.persistent || m.classList.contains('float-panel') || keep.includes(m)) return;
      m.classList.remove('show');
    });
  }
  /* exposed so overlays.js (loaded before this script) can share the same popover engine */
  window.openNear = openNear;
  window.closeAllPopovers = closeAllPopovers;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.pop-trigger') || e.target.closest('.pop-menu') || e.target.closest('.ctx-menu')) return;
    closeAllPopovers();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const csEl = document.getElementById('chartSettingsBackdrop');
    if (csEl && csEl.classList.contains('show')) { closeChartSettings(false); }
    else { closeAllPopovers(); }
  });

  /* ---------- generic custom dropdown engine (used by Chart Settings / SL override selects) ----------
     Each "select" is a hidden native <select> (the value/options source of truth, still readable via
     .value and still fires real 'change' events) paired with a .cs-dd-trigger element styled like the
     trade panel's .select-input dropdowns. One shared popover is repopulated per open. */
  const csDropdownMenu = document.getElementById('csDropdownMenu');
  function csDropdownLabelFor(select) {
    const opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }
  function refreshCsDropdownTriggerLabel(trigger) {
    const select = document.getElementById(trigger.dataset.target);
    const label = trigger.querySelector('.cs-select-label');
    if (select && label) label.textContent = csDropdownLabelFor(select);
  }
  function refreshAllCsDropdownLabels(root) {
    (root || document).querySelectorAll('.cs-dd-trigger').forEach(refreshCsDropdownTriggerLabel);
  }
  refreshAllCsDropdownLabels();
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.cs-dd-trigger');
    if (!trigger) return;
    e.stopPropagation();
    const select = document.getElementById(trigger.dataset.target);
    if (!select) return;
    /* a dropdown nested inside another popover (e.g. the SL gear menu) shouldn't take that parent down with it */
    const parentMenu = trigger.closest('.pop-menu, .ctx-menu');
    if (csDropdownMenu.classList.contains('show') && csDropdownMenu._openTrigger === trigger) {
      csDropdownMenu.classList.remove('show');
      return;
    }
    csDropdownMenu.innerHTML = Array.from(select.options).map((opt) =>
      '<button type="button" class="pop-item' + (opt.value === select.value ? ' selected' : '') + '" data-value="' + opt.value.replace(/"/g, '&quot;') + '">' +
      '<span class="pop-text"><span class="pt-title">' + opt.textContent + '</span></span></button>'
    ).join('');
    csDropdownMenu.querySelectorAll('[data-value]').forEach(btn => {
      btn.addEventListener('click', (e2) => {
        e2.stopPropagation();
        select.value = btn.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refreshCsDropdownTriggerLabel(trigger);
        closeAllPopoversExcept(parentMenu);
      });
    });
    openNear(csDropdownMenu, trigger.getBoundingClientRect(), 'left', trigger);
  });

  /* ---------- context menu ---------- */
  const ctxMenu = document.getElementById('ctxMenu');
  const ctxLongLbl = document.getElementById('ctxLongLbl');
  const ctxShortLbl = document.getElementById('ctxShortLbl');
  chart.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = chart.getBoundingClientRect();
    pendingClickPrice = roundTick(yToPrice(e.clientY - rect.top, rect.height));
    const qty = parseFloat(qtyInput.value || '1') || 1;
    const lastEl = document.getElementById('hdrLast');
    const currentPrice = lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : BASE_PRICE;
    const below = pendingClickPrice < currentPrice;
    const priceStr = fmt(pendingClickPrice);
    const qtyStr = qty.toFixed(2);
    ctxLongLbl.textContent = 'Buy ' + qtyStr + ' ETH @ ' + priceStr;
    ctxShortLbl.textContent = 'Sell ' + qtyStr + ' ETH @ ' + priceStr;
    openAt(ctxMenu, e.clientX, e.clientY);
  });
  document.getElementById('ctxLong').addEventListener('click', () => { createOrder('buy', pendingClickPrice); closeAllPopovers(); });
  document.getElementById('ctxShort').addEventListener('click', () => { createOrder('sell', pendingClickPrice); closeAllPopovers(); });

  /* ---------- positions panel: expand/collapse & in-row actions ---------- */
  document.querySelectorAll('.pos-row-summary').forEach(summary => {
    summary.addEventListener('click', (e) => {
      if (e.target.closest('.pos-col-quickclose') || e.target.closest('.pos-sym-ticker')) return;
      summary.closest('.pos-row').classList.toggle('is-expanded');
    });
  });

  const posPanel = document.getElementById('bpPanel-positions');
  posPanel.addEventListener('click', e => {
    const tickerEl = e.target.closest('.pos-sym-ticker');
    if (tickerEl) {
      e.stopPropagation();
      switchSymbol(tickerEl.closest('.pos-row').dataset.posId);
      return;
    }
    const closeBtn = e.target.closest('[data-pos-close-pct]');
    if (closeBtn) {
      const row = closeBtn.closest('.pos-row');
      const sym = row.dataset.posId;
      const pct = parseInt(closeBtn.dataset.posClosePct, 10);
      if (!window.closePositionPct(sym, pct)) return;
      showToast(sym + ' position ' + (pct >= 100 ? 'closed' : 'reduced by ' + pct + '%'), 'check_circle');
      return;
    }
    const reverseBtn = e.target.closest('[data-pos-reverse]');
    if (reverseBtn) {
      const sym = reverseBtn.closest('.pos-row').dataset.posId;
      if (!window.reversePosition(sym)) return;
      showToast(sym + ' position reversed', 'sync_alt');
    }
  });
  posPanel.addEventListener('input', e => {
    const slider = e.target.closest('.pos-quick-slider');
    if (!slider) return;
    const cluster = slider.closest('.pos-col-quickclose');
    cluster.querySelector('.pos-quick-pct').textContent = slider.value + '%';
    cluster.querySelector('.pos-quick-close').dataset.posClosePct = slider.value;
  });
  document.getElementById('ctxAlert').addEventListener('click', () => { addAlert(pendingClickPrice); closeAllPopovers(); });
  document.getElementById('ctxReset').addEventListener('click', () => {
    panX = 0; panY = 0; panXInitialized = false;
    crosshair = null;
    scheduleDrawPriceChart();
    showToast('Chart view reset', 'restart_alt');
    closeAllPopovers();
  });
  document.getElementById('ctxSettings').addEventListener('click', () => { closeAllPopovers(); openChartSettings('general'); });

  /* ---------- order lifecycle ---------- */
  function createOrder(side, entryPrice, source) {
    const dir = side === 'buy' ? 1 : -1;
    const isChartTrade = source !== 'quick';
    const currentPrice = (() => {
      const el = document.getElementById('hdrLast');
      return el ? parseFloat(el.textContent.replace(/,/g, '')) : BASE_PRICE;
    })();
    const fillAbove = entryPrice > currentPrice;
    const autoOrderType = side === 'buy'
      ? (fillAbove ? 'Stop Market' : 'Limit')
      : (fillAbove ? 'Limit' : 'Stop Market');
    const orderType = isChartTrade ? 'Market' : autoOrderType;
    // Market chart trades snap to live price immediately so TPs/SL are calculated correctly
    const entry = roundTick((isChartTrade && orderType === 'Market') ? currentPrice : entryPrice);
    const expanded = chartSettings.tpSlDisplayMode === 'expanded';
    let tps = [];
    let sl = null;
    if (expanded) {
      const baseR = 2; // price distance representing 1.0R, used to price default targets/SL from their R Multiple
      tps = (chartSettings.defaultTargets || []).map(t => ({
        id: 'tp' + (tpCounter++),
        price: roundTick(entry + dir * t.r * baseR),
        pct: t.pct,
        trailing: false,
        trailOverride: null
      }));
      if (chartSettings.defaultStopLoss) {
        sl = { price: roundTick(entry - dir * chartSettings.defaultStopLoss.r * baseR), enabled: false, mode: 'trailing', atrMult: (chartSettings.atrStop.multiplier || 2.0), beTpId: null, beActive: false, beOverride: null, trailOverride: makeSlConfig() };
      }
    }
    order = {
      side, entry, qty: parseInt(qtyInput.value || '1'), orderType, fillAbove,
      sizeMode: 'contracts', filled: false,
      pendingConfirm: isChartTrade,
      sizeValues: { dollar: 5000, percent: 25, risk: 500 },
      tps, sl, tpsHitCount: 0,
      initialRisk: sl ? Math.abs(entry - sl.price) * POINT_VALUE : null
    };
    render();
  }

  /* ---------- Quick Trade panel ---------- */
  const QT_INSTRUMENT_UNIT = 'ETH';      // default instrument for the Quick Trade panel
  const QT_AVAILABLE_BALANCE = 52430.00;
  const QT_FEE_PER_CONTRACT = 1.25;
  function qtCurrentPrice() {
    const lastEl = document.getElementById('hdrLast');
    return lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : BASE_PRICE;
  }

  /* ---------- order type tabs (Limit / Market / advanced dropdown) ---------- */
  const qtOrderTabs = document.getElementById('qtOrderTabs');
  const qtBuyBtn = document.getElementById('qtBuyBtn');
  const qtSellBtn = document.getElementById('qtSellBtn');
  const QT_TAB_LABELS = { limit: 'Limit', market: 'Market' };
  const QT_ADVANCED_LABELS = { stopMarket: 'Stop Market', stopLimit: 'Stop Limit', mit: 'MIT' };
  let qtAdvancedType = 'stopMarket';
  function qtSetActiveTab(tabName) {
    const panelName = tabName === 'advanced' ? qtAdvancedType : tabName;
    qtOrderTabs.querySelectorAll('.qt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.qt-tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.tabPanel === panelName);
    });
    const lbl = QT_TAB_LABELS[tabName] || QT_ADVANCED_LABELS[qtAdvancedType] || 'Market';
    qtBuyBtn.querySelector('.bs-lbl').textContent = 'Buy ' + lbl;
    qtSellBtn.querySelector('.bs-lbl').textContent = 'Sell ' + lbl;
    const isLimit = panelName === 'limit';
    const tpslToggleEl = document.getElementById('qtTpslToggle');
    const tpslBlockEl = document.getElementById('qtTpslBlock');
    const tpslCheckboxEl = document.getElementById('qtTpslCheckbox');
    tpslToggleEl.style.display = isLimit ? '' : 'none';
    tpslBlockEl.style.display = (isLimit && tpslCheckboxEl.classList.contains('checked')) ? 'block' : 'none';
  }
  qtOrderTabs.querySelectorAll('.qt-tab:not(.qt-tab-dropdown)').forEach(tab => {
    tab.addEventListener('click', () => qtSetActiveTab(tab.dataset.tab));
  });
  qtSetActiveTab('limit');

  /* ---------- advanced order type dropdown (Stop Limit / Stop Market / Trailing Stop / MIT) ---------- */
  const qtAdvancedTab = document.getElementById('qtAdvancedTab');
  const qtAdvancedTabLabel = document.getElementById('qtAdvancedTabLabel');
  const qtAdvancedTypeMenu = document.getElementById('qtAdvancedTypeMenu');
  let qtAdvHoverTimer = null;
  function qtOpenAdvMenu() {
    clearTimeout(qtAdvHoverTimer);
    qtAdvancedTypeMenu.querySelectorAll('.pop-item').forEach(it => {
      it.classList.toggle('selected', it.dataset.advType === qtAdvancedType);
    });
    openNear(qtAdvancedTypeMenu, qtAdvancedTab.getBoundingClientRect(), 'right', qtAdvancedTab);
  }
  function qtScheduleCloseAdvMenu() {
    /* A transient hover dropdown only dismisses itself — it must not sweep away
       other open popovers (e.g. the Indicators / L2 / Market Scanner floating panels). */
    clearTimeout(qtAdvHoverTimer);
    qtAdvHoverTimer = setTimeout(() => {
      qtAdvancedTypeMenu.classList.remove('show');
      qtAdvancedTypeMenu._openTrigger = null;
    }, 150);
  }
  qtAdvancedTab.addEventListener('mouseenter', qtOpenAdvMenu);
  qtAdvancedTab.addEventListener('mouseleave', qtScheduleCloseAdvMenu);
  qtAdvancedTypeMenu.addEventListener('mouseenter', () => clearTimeout(qtAdvHoverTimer));
  qtAdvancedTypeMenu.addEventListener('mouseleave', qtScheduleCloseAdvMenu);
  qtAdvancedTab.addEventListener('click', (e) => {
    e.stopPropagation();
    qtSetActiveTab('advanced');
    closeAllPopovers();
  });
  qtAdvancedTypeMenu.querySelectorAll('.pop-item').forEach(it => {
    it.addEventListener('click', () => {
      qtAdvancedType = it.dataset.advType;
      qtAdvancedTabLabel.textContent = QT_ADVANCED_LABELS[qtAdvancedType];
      closeAllPopovers();
      qtSetActiveTab('advanced');
    });
  });

  /* ---------- generic price stepper arrows (Stop / Limit / Trailing Delta / Trigger / Activation fields) ---------- */
  const QT_SLIPPAGE_IDS = ['qtStopMarketSlippage', 'qtMitSlippage'];
  document.querySelectorAll('.price-stepper-arrows .ps-up, .price-stepper-arrows .ps-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input || input.disabled) return;
      const isSlippage = QT_SLIPPAGE_IDS.includes(input.id);
      const dataStep = input.dataset.step ? parseFloat(input.dataset.step) : null;
      const step = dataStep !== null ? dataStep : input.id === 'qtTrailDelta' ? 0.1 : isSlippage ? 0.05 : 0.25;
      const min = input.id === 'qtLeverageInput' ? 1 : isSlippage ? 0.1 : 0;
      const cur = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
      const next = btn.classList.contains('ps-up') ? cur + step : Math.max(min, cur - step);
      if (dataStep !== null) {
        input.value = Number.isInteger(step) ? String(Math.round(next)) : next.toFixed(2);
      } else {
        input.value = input.id === 'qtTrailDelta' ? next.toFixed(1) : isSlippage ? next.toFixed(2) : fmt(next);
      }
    });
  });

  /* ensure all data-step stepper inputs accept typed values */
  document.querySelectorAll('.price-stepper input[data-step]').forEach(input => {
    input.addEventListener('change', () => {
      const step = parseFloat(input.dataset.step) || 1;
      const v = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
      const snapped = Math.round(v / step) * step;
      const min = input.id === 'qtLeverageInput' ? 1 : 0;
      input.value = Number.isInteger(step) ? String(Math.max(min, Math.round(snapped))) : Math.max(min, snapped).toFixed(2);
    });
  });

  /* ---------- Limit tab: TP/SL toggle ---------- */
  const qtTpslToggle = document.getElementById('qtTpslToggle');
  const qtTpslCheckbox = document.getElementById('qtTpslCheckbox');
  const qtTpslBlock = document.getElementById('qtTpslBlock');
  qtTpslToggle.addEventListener('click', () => {
    const enabled = qtTpslCheckbox.classList.toggle('checked');
    qtTpslBlock.style.display = enabled ? 'block' : 'none';
  });
  /* Leverage toggle — same reveal behavior as TP/SL; the value defaults to 10× even while collapsed */
  const qtLeverageToggle = document.getElementById('qtLeverageToggle');
  const qtLeverageCheckbox = document.getElementById('qtLeverageCheckbox');
  const qtLeverageBlock = document.getElementById('qtLeverageBlock');
  qtLeverageToggle.addEventListener('click', () => {
    const enabled = qtLeverageCheckbox.classList.toggle('checked');
    qtLeverageBlock.style.display = enabled ? 'block' : 'none';
  });
  document.querySelectorAll('#qtTpslBlock .tpsl-offset-unit').forEach(unit => {
    unit.addEventListener('click', (e) => {
      e.stopPropagation();
      const isPct = unit.textContent.trim().startsWith('%');
      unit.innerHTML = (isPct ? 'pts' : '%') + '<span class="material-symbols-outlined">expand_more</span>';
    });
  });

  function qtPlaceOrder(side, price) {
    const { qty } = qtComputeAmount();
    const prevVal = qtyInput.value;
    qtyInput.value = Math.max(1, Math.round(qty));
    const tab = qtActiveTab();
    createOrder(side, price, 'quick');
    if (order && tab === 'limit') order.orderType = 'Limit';
    if (tab === 'market') confirmOrderFill();
    qtyInput.value = prevVal;
  }
  function qtActiveTab() {
    const active = qtOrderTabs.querySelector('.qt-tab.active');
    return active ? active.dataset.tab : 'market';
  }
  const QT_ADVANCED_TRIGGER_IDS = { stopMarket: 'qtStopMarketTrigger', stopLimit: 'qtStopLimitTrigger', mit: 'qtMitTrigger' };
  function qtActivePrice() {
    const tab = qtActiveTab();
    if (tab === 'limit') return parseFloat(document.getElementById('qtLimitPrice').value.replace(/,/g, ''));
    if (tab === 'advanced') {
      const inputId = QT_ADVANCED_TRIGGER_IDS[qtAdvancedType];
      const input = document.getElementById(inputId);
      const val = input && !input.disabled ? parseFloat((input.value || '').replace(/,/g, '')) : NaN;
      return isNaN(val) ? qtCurrentPrice() : val;
    }
    return qtCurrentPrice();
  }
  qtBuyBtn.addEventListener('click', () => qtPlaceOrder('buy', qtActivePrice()));
  qtSellBtn.addEventListener('click', () => qtPlaceOrder('sell', qtActivePrice()));
  /* the symbol currently shown in the top-bar selector — Close/Cancel All are scoped to it */
  function currentSymbol() {
    const el = document.getElementById('symSelectLabel');
    return el ? el.textContent.trim() : '';
  }
  document.getElementById('qtFlatten').addEventListener('click', () => {
    const sym = currentSymbol();
    let closedRow = false;
    // The chart position is hardcoded to ETHUSD; close it (cancelOrder shows its own toast) only when filled.
    if (order && order.filled && sym === 'ETHUSD') cancelOrder();
    // Close any positions-tab rows for this symbol (static or graduated from a fill).
    while (document.querySelector('.pos-row[data-pos-id="' + sym + '"]')) {
      if (!window.closePositionPct(sym, 100)) break;
      closedRow = true;
    }
    if (closedRow) showToast(sym + ' position closed', 'check_circle');
    else if (!(order && order.filled && sym === 'ETHUSD')) showToast('No open ' + sym + ' positions to close', 'info');
  });
  document.getElementById('qtCancelAll').addEventListener('click', () => {
    const sym = currentSymbol();
    // Pending orders only ever exist for the ETHUSD chart order in this mockup.
    if (order && !order.filled && sym === 'ETHUSD') cancelOrder();
    else showToast('No pending ' + sym + ' orders to cancel', 'info');
  });
  /* ---------- amount type (Quantity / USD / % of Balance) ---------- */
  const QT_MODES = {
    Quantity: { unit: QT_INSTRUMENT_UNIT, label: 'Quantity', step: 1, default: '1' },
    USD: { unit: 'USD', label: 'USD Amount', step: 50, default: '100' },
    '% of Balance': { unit: '%', label: 'Percent of Balance', step: 5, default: '10' },
  };
  let qtAmountMode = 'Quantity';
  const qtAmountInput = document.getElementById('qtAmountInput');
  const qtAmountLabel = document.getElementById('qtAmountLabel');
  const qtQtyUnit = document.getElementById('qtQtyUnit');
  const qtSlider = document.getElementById('qtSlider');
  const qtSliderTicks = document.getElementById('qtSliderTicks');
  const qtEstSize = document.getElementById('qtEstSize');
  const qtEstValue = document.getElementById('qtEstValue');
  const qtEstFees = document.getElementById('qtEstFees');

  function qtModeMax(mode) {
    const price = qtCurrentPrice() || 1;
    if (mode === 'Quantity') return Math.max(0.01, QT_AVAILABLE_BALANCE / price);
    if (mode === 'USD') return QT_AVAILABLE_BALANCE;
    return 100;
  }
  function qtComputeAmount() {
    const amt = Math.max(0, parseFloat(qtAmountInput.value) || 0);
    const price = qtCurrentPrice() || 1;
    if (qtAmountMode === 'Quantity') return { qty: amt, usdValue: amt * price };
    if (qtAmountMode === 'USD') return { qty: amt / price, usdValue: amt };
    const usdValue = QT_AVAILABLE_BALANCE * (amt / 100);
    return { qty: usdValue / price, usdValue };
  }
  function qtFmtQty(q) {
    return q.toFixed(2);
  }
  function qtSliderFill(pct) {
    qtSlider.style.background = 'linear-gradient(to right, var(--border-strong) 0%, var(--border-strong) ' + pct + '%, var(--border-default) ' + pct + '%, var(--border-default) 100%)';
  }
  function qtSliderTickLabel(val) {
    if (qtAmountMode === 'Quantity') return qtFmtQty(val) + ' ' + QT_INSTRUMENT_UNIT;
    if (qtAmountMode === 'USD') return '$' + fmt(val, 0);
    return Math.round(val) + '%';
  }
  function qtUpdateSliderTicks() {
    const max = qtModeMax(qtAmountMode) || 0;
    qtSliderTicks.querySelectorAll('span').forEach((span, i) => {
      span.textContent = qtSliderTickLabel(max * i / 4);
    });
  }
  function qtUpdateEstimates(syncSlider) {
    const { qty, usdValue } = qtComputeAmount();
    const qtyDisp = qtFmtQty(qty);
    qtEstSize.textContent = qtyDisp + ' ' + QT_INSTRUMENT_UNIT;
    qtEstValue.textContent = fmtMoney(usdValue) + ' USD';
    qtEstFees.textContent = fmtMoney(Math.max(0, qty) * QT_FEE_PER_CONTRACT);
    if (syncSlider !== false) {
      const max = qtModeMax(qtAmountMode) || 1;
      const amt = Math.max(0, parseFloat(qtAmountInput.value) || 0);
      qtSlider.value = Math.min(100, Math.round(amt / max * 100));
    }
    qtSliderFill(parseInt(qtSlider.value, 10));
    qtUpdateSliderTicks();
  }
  function qtSetAmountMode(mode) {
    qtAmountMode = mode;
    const cfg = QT_MODES[mode];
    qtAmountLabel.textContent = cfg.label;
    qtQtyUnit.textContent = cfg.unit;
    qtAmountInput.value = cfg.default;
    qtUpdateEstimates();
  }

  const qtAmountTypeTrigger = document.getElementById('qtAmountTypeTrigger');
  const qtAmountTypeMenu = document.getElementById('qtAmountTypeMenu');
  const qtAmountTypeVal = document.getElementById('qtAmountTypeVal');
  qtAmountTypeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    qtAmountTypeMenu.querySelectorAll('.pop-item').forEach(it => {
      it.classList.toggle('selected', it.dataset.amountType === qtAmountTypeVal.textContent);
    });
    openNear(qtAmountTypeMenu, qtAmountTypeTrigger.getBoundingClientRect(), 'right', qtAmountTypeTrigger);
  });
  qtAmountTypeMenu.querySelectorAll('.pop-item').forEach(it => {
    it.addEventListener('click', () => {
      qtAmountTypeVal.textContent = it.dataset.amountType;
      closeAllPopovers();
      qtSetAmountMode(it.dataset.amountType);
    });
  });

  document.querySelector('.qty-dec').addEventListener('click', () => {
    const step = QT_MODES[qtAmountMode].step;
    qtAmountInput.value = Math.max(0, (parseFloat(qtAmountInput.value) || 0) - step);
    qtUpdateEstimates();
  });
  document.querySelector('.qty-inc').addEventListener('click', () => {
    const step = QT_MODES[qtAmountMode].step;
    qtAmountInput.value = (parseFloat(qtAmountInput.value) || 0) + step;
    qtUpdateEstimates();
  });
  qtAmountInput.addEventListener('input', () => qtUpdateEstimates());
  qtSlider.addEventListener('input', () => {
    const pct = parseInt(qtSlider.value, 10);
    const max = qtModeMax(qtAmountMode);
    const raw = pct / 100 * max;
    qtAmountInput.value = qtAmountMode === 'Quantity' ? parseFloat(raw.toFixed(2)) : Math.max(0, Math.round(raw));
    qtUpdateEstimates(false);
  });
  qtUpdateEstimates();

  function cancelOrder() {
    if (order) {
      if (order.filled) {
        const lastEl = document.getElementById('hdrLast');
        const closePrice = lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : order.entry;
        const dir = order.side === 'buy' ? 1 : -1;
        const closeSide = order.side === 'buy' ? 'sell' : 'buy';
        const closePnl = (closePrice - order.entry) * order.qty * dir * POINT_VALUE;
        orderHistory.unshift({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'closed', type: order.orderType, time: nowTimeStr(), pnl: closePnl });
        tradeHistory.unshift({ symbol: 'ETHUSD', side: closeSide, qty: order.qty, price: closePrice, pnl: closePnl, role: 'close', type: 'Market', time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT });
        window.closePositionPct('ETHUSD', 100);
        showToast((order.side === 'buy' ? 'Long' : 'Short') + ' position closed at ' + fmt(closePrice), 'check_circle');
      } else {
        orderHistory.unshift({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'cancelled', type: order.orderType, time: nowTimeStr(), pnl: null });
        showToast('Pending order cancelled', 'cancel');
      }
    }
    order = null; render(); closeAllPopovers();
  }
  /* quick visual sweep of the entry chip's progress fill before the (instant) fill completes */
  const FILL_SWEEP_MS = 450;
  function startFillSweep() {
    if (!order || order.filled || order.filling) return;
    order.filling = true;
    const chip = document.getElementById('entryPriceHandle');
    if (chip) chip.classList.add('filling');   // CSS transitions the fill width 0 -> 100%
    setTimeout(() => {
      if (!order) return;
      order.filling = false;
      confirmOrderFill();                       // existing instant fill: history, position, locked render
    }, FILL_SWEEP_MS);
  }
  function confirmOrderFill() {
    if (!order || order.filled) return;
    order.filled = true;
    // Anchor trailing stop to actual fill price so it starts trailing from there
    if (slTrailActive()) {
      const dir = order.side === 'buy' ? 1 : -1;
      const cfg = getEffectiveTrailConfig();
      order.sl.price = roundTick(order.entry - dir * computeTrailDist(cfg, order.entry));
      syncQtyFromRisk();
    }
    orderHistory.unshift({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'filled', type: order.orderType, time: nowTimeStr(), pnl: null });
    tradeHistory.unshift({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, pnl: null, role: 'open', type: order.orderType, time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT });
    window.upsertPositionFromFill('ETHUSD', order.side, order.qty, order.entry);
    render();
    showToast((order.side === 'buy' ? 'Long' : 'Short') + ' position opened at ' + fmt(order.entry), 'check_circle');
  }
  /* clicking the BUY/SELL entry chip places a pending chart order — blocked while TP/SL sit on the wrong side of entry */
  function placeOrder() {
    if (!order || !order.pendingConfirm || !orderTpSlValid()) return;
    order.pendingConfirm = false;
    if (order.orderType === 'Market') {
      confirmOrderFill();
    } else {
      render();
    }
  }
  function removeTp(id) {
    if (!order) return;
    order.tps = order.tps.filter(t => t.id !== id);
    if (order.sl && !order.sl.beActive && (order.tps.length < 2 || order.sl.beTpId === id)) {
      order.sl.beTpId = null;
    }
    render();
  }
  function removeSl() {
    if (!order) return;
    order.sl = null;
    render();
  }
  /* ---------- SL hit detection ---------- */
  function checkSlHit(currentPrice) {
    if (!order || !order.filled || !order.sl) return false;
    const dir = order.side === 'buy' ? 1 : -1;
    const hit = dir === 1 ? currentPrice <= order.sl.price : currentPrice >= order.sl.price;
    if (!hit) return false;
    const closingSide = order.side === 'buy' ? 'sell' : 'buy';
    const slPnl = (order.sl.price - order.entry) * order.qty * dir * POINT_VALUE;
    orderHistory.unshift({ symbol: 'ETHUSD', side: closingSide, qty: order.qty, price: order.sl.price, status: 'filled', type: 'Stop (SL)', time: nowTimeStr(), pnl: slPnl });
    tradeHistory.unshift({ symbol: 'ETHUSD', side: closingSide, qty: order.qty, price: order.sl.price, pnl: slPnl, role: 'close', type: 'Stop (SL)', time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT });
    window.closePositionPct('ETHUSD', 100);
    showToast('Stop loss hit at ' + fmt(order.sl.price) + ' — position closed', 'stop_circle');
    order = null;
    render();
    return true;
  }

  /* ---------- TP fill detection (drives "Move to Break Even" once the chosen TP is hit) ---------- */
  function checkTpFills(prevPrice, currentPrice) {
    if (!order || !order.filled || !order.tps.length) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const hitTps = order.tps.filter(tp => dir === 1
      ? (prevPrice < tp.price && currentPrice >= tp.price)
      : (prevPrice > tp.price && currentPrice <= tp.price));
    if (!hitTps.length) return;
    hitTps.forEach(tp => {
      const idx = order.tps.indexOf(tp);
      const closingSide = order.side === 'buy' ? 'sell' : 'buy';
      const tpQty = Math.max(1, Math.round(order.qty * tp.pct / 100));
      const tpPnl = (tp.price - order.entry) * tpQty * dir * POINT_VALUE;
      orderHistory.unshift({ symbol: 'ETHUSD', side: closingSide, qty: tpQty, price: tp.price, status: 'filled', type: 'Limit (TP)', time: nowTimeStr(), pnl: tpPnl });
      tradeHistory.unshift({ symbol: 'ETHUSD', side: closingSide, qty: tpQty, price: tp.price, pnl: tpPnl, role: 'close', type: 'Limit (TP)', time: nowTimeStr(), fee: tpQty * QT_FEE_PER_CONTRACT });
      window.closePositionPct('ETHUSD', tp.pct);
      showToast('TP' + (idx + 1) + ' hit at ' + fmt(tp.price), 'check_circle');
      if (order.sl && order.sl.beTpId === tp.id && !order.sl.beActive) {
        const beCfg = getEffectiveBeConfig();
        const offsetPrice = beCfg.offsetUnit === 'points' ? beCfg.offsetValue
          : beCfg.offsetUnit === 'percent' ? order.entry * beCfg.offsetValue / 100
          : beCfg.offsetValue * TICK;
        order.sl.price = roundTick(order.entry + dir * offsetPrice);
        order.sl.beActive = true;
        syncQtyFromRisk();
        showToast('Stop loss moved to breakeven', 'vertical_align_center');
      }
    });
    order.tpsHitCount = (order.tpsHitCount || 0) + hitTps.length;
    order.tps = order.tps.filter(tp => !hitTps.includes(tp));
    if (order.tps.length === 0) {
      showToast('All targets hit — position fully closed', 'check_circle');
      order = null;
    }
    render();
  }
  /* ---------- shared trigger-condition resolver for breakeven / trailing-stop / trailing-TP ---------- */
  function currentRMultiple(currentPrice) {
    if (!order || !order.initialRisk) return null;
    const dir = order.side === 'buy' ? 1 : -1;
    const pts = dir * (currentPrice - order.entry);
    return (pts * POINT_VALUE) / order.initialRisk;
  }
  function meetsTriggerCondition(triggerKey, customRValue, currentPrice) {
    if (!order) return false;
    if (triggerKey === 'tp1') return (order.tpsHitCount || 0) >= 1;
    if (triggerKey === 'tp2') return (order.tpsHitCount || 0) >= 2;
    if (triggerKey === 'tp3') return (order.tpsHitCount || 0) >= 3;
    if (triggerKey === 'customR') {
      const r = currentRMultiple(currentPrice);
      return r !== null && r >= customRValue;
    }
    return false;
  }
  /* effective config = this SL's own override if set, otherwise the global Chart Settings default */
  function getEffectiveBeConfig() { return (order && order.sl && order.sl.beOverride) || chartSettings.moveSlToBreakeven; }
  function getEffectiveTrailConfig() { return (order && order.sl && order.sl.trailOverride) || chartSettings.trailingStop; }
  function getEffectiveAtrConfig() { return chartSettings.atrStop; }
  function getEffectiveTpTrailConfig(tp) { return (tp && tp.trailOverride) || chartSettings.trailingTp; }
  /* ---- SL special-behavior model: one master toggle (enabled) + one selected mode ---- */
  function slTrailActive() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'trailing'); }
  function slAtrActive() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'atr'); }
  function slBeActiveMode() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'breakeven'); }
  /* Each SL carries its own fixed-trailing distance config, seeded from the global default */
  function makeSlConfig() {
    const b = chartSettings.trailingStop;
    return { distanceValue: b.distanceValue, distanceUnit: b.distanceUnit === 'points' ? 'percent' : b.distanceUnit, start: b.start, startCustomR: b.startCustomR };
  }
  function ensureSlConfig() {
    if (!order || !order.sl) return null;
    if (!order.sl.trailOverride) order.sl.trailOverride = makeSlConfig();
    return order.sl.trailOverride;
  }
  function slAtrMult() { return (order && order.sl && order.sl.atrMult) || chartSettings.atrStop.multiplier || 2.0; }
  /* current Entry↔SL gap expressed in the given unit (% of entry, or ticks) */
  function slGapDistance(unit) {
    if (!order || !order.sl) return 0;
    const gapPts = Math.abs(order.entry - order.sl.price);
    return unit === 'percent' ? gapPts / order.entry * 100 : gapPts / TICK;
  }
  function atrStopDistance(cfg) {
    cfg = cfg || getEffectiveAtrConfig();
    return 7.5 * (cfg.multiplier / 2);
  }
  /* short label for an SL's distance value, e.g. "1.25%" or "8t" */
  function slDistanceLabel(cfg) {
    return cfg.distanceUnit === 'percent' ? (+cfg.distanceValue).toFixed(2) + '%' : Math.round(cfg.distanceValue) + 't';
  }
  /* badge shown inside the SL chip — text + style class, and it opens the SL settings */
  function slBadgeInfo() {
    if (!order || !order.sl) return { text: 'Fixed', cls: 'fixed' };
    if (!order.sl.enabled) return { text: 'Fixed', cls: 'fixed' };
    if (order.sl.mode === 'breakeven') return { text: order.sl.beActive ? 'SL → BE' : 'Breakeven', cls: 'be' };
    if (order.sl.mode === 'atr') return { text: 'ATR ' + slAtrMult().toFixed(1) + 'x', cls: 'atr' };
    return { text: 'Trailing ' + slDistanceLabel(ensureSlConfig()), cls: 'trail' };
  }
  let simTickCounter = 0;
  /* Shared helper: compute fixed trailing distance in price units from a reference price */
  function computeTrailDist(cfg, refPrice) {
    if (cfg.distanceUnit === 'percent') return refPrice * cfg.distanceValue / 100;
    return cfg.distanceValue * TICK;
  }
  /* Place an unfilled order's static ATR stop at the ATR distance from entry */
  function placeAtrStop() {
    if (!order || !order.sl) return;
    const dir = order.side === 'buy' ? 1 : -1;
    order.sl.price = roundTick(order.entry - dir * atrStopDistance({ multiplier: slAtrMult() }));
    syncQtyFromRisk();
  }
  /* Reposition an unfilled order's trailing SL to sit at the configured distance from the entry reference */
  function repositionSlFromConfig() {
    if (!order || !order.sl || order.filled) return;
    if (!slTrailActive()) return;
    const cfg = ensureSlConfig();
    const dir = order.side === 'buy' ? 1 : -1;
    const refPrice = order.orderType === 'Market' ? qtCurrentPrice() : order.entry;
    order.sl.price = roundTick(refPrice - dir * computeTrailDist(cfg, refPrice));
    syncQtyFromRisk();
  }

  /* For filled positions: move SL only in the favorable direction (ratchet) */
  function applyTrailingStop(currentPrice) {
    if (!slTrailActive() || !order.filled) return;
    const cfg = getEffectiveTrailConfig();
    if (cfg.start !== 'immediate' && !meetsTriggerCondition(cfg.start, cfg.startCustomR, currentPrice)) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const candidate = roundTick(currentPrice - dir * computeTrailDist(cfg, currentPrice));
    const improvement = dir * (candidate - order.sl.price);
    if (improvement > 0) {
      order.sl.price = candidate;
      syncQtyFromRisk();
    }
  }

  /* For unfilled orders: keep the trailing SL at the configured distance from entry reference */
  function applyTrailingStopPreview() {
    if (!slTrailActive() || order.filled) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const cfg = getEffectiveTrailConfig();
    const refPrice = order.orderType === 'Market' ? qtCurrentPrice() : order.entry;
    const newSl = roundTick(refPrice - dir * computeTrailDist(cfg, refPrice));
    if (newSl !== order.sl.price) {
      order.sl.price = newSl;
      syncQtyFromRisk();
    }
  }
  function applyTrailingTp(currentPrice) {
    if (!order || !order.filled || !order.tps.length) return;
    const dir = order.side === 'buy' ? 1 : -1;
    order.tps.forEach(tp => {
      if (!tp.trailing) return;
      const cfg = getEffectiveTpTrailConfig(tp);
      if (!meetsTriggerCondition(cfg.activation, cfg.activationCustomR, currentPrice)) return;
      const distPrice = cfg.method === 'atr' ? atrStopDistance()
        : cfg.distanceUnit === 'percent' ? currentPrice * cfg.distanceValue / 100
        : cfg.distanceValue * (cfg.distanceUnit === 'points' ? 1 : TICK);
      const candidate = roundTick(currentPrice + dir * distPrice);
      const improvement = dir * (candidate - tp.price);
      if (improvement > 0) { tp.price = candidate; }
    });
  }
  /* ---------- auto-balance TP allocations so they always sum to exactly 100% ---------- */
  function rebalanceTpAllocations(newTpId) {
    if (!order) return;
    const n = order.tps.length;
    if (n === 0) return;
    if (n === 1) { order.tps[0].pct = 100; return; }
    const newShare = Math.round(100 / n);
    const others = order.tps.filter(t => t.id !== newTpId);
    const remaining = 100 - newShare;
    const othersTotalPct = others.reduce((s, t) => s + t.pct, 0) || 1;
    let allocated = 0;
    others.forEach((t, i) => {
      if (i === others.length - 1) { t.pct = remaining - allocated; }
      else { t.pct = Math.round(t.pct / othersTotalPct * remaining); allocated += t.pct; }
    });
    const newTp = order.tps.find(t => t.id === newTpId);
    if (newTp) newTp.pct = newShare;
  }

  /* ---------- alerts ---------- */
  function addAlert(price) {
    const lastEl = document.getElementById('hdrLast');
    const last = lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : BASE_PRICE;
    const condition = price >= last ? 'Crosses Above' : 'Crosses Below';
    alerts.unshift({ id: 'al' + (alertCounter++), symbol: 'ETHUSD', price: roundTick(price), condition, status: 'active', created: nowTimeStr() });
    renderAlerts();
    render();
    showToast('Alert set: ETHUSD ' + condition.toLowerCase() + ' ' + fmt(roundTick(price)), 'notifications');
  }
  function removeAlert(id) {
    alerts = alerts.filter(a => a.id !== id);
    renderAlerts();
    render();
  }
  /* Resolve icon class and 2-char initials for any symbol */
  function symMeta(sym) {
    const u = sym.toUpperCase();
    if (/AAPL|TSLA|NVDA|MSFT|AMZN|GOOGL/.test(u)) return { cls: 'pos-icon-stock',   init: u.slice(0, 2) };
    if (/USD|BTC|ETH|SOL|XRP|BNB|DOGE|JUP/.test(u)) return { cls: 'pos-icon-crypto', init: u.slice(0, 2) };
    return { cls: 'pos-icon-futures', init: u.slice(0, 2) };
  }

  /* Build the reusable symbol cell used across all three tabs */
  function symCell(sym, sideCls, sideLabel, subText) {
    const m = symMeta(sym);
    return (
      '<div class="ord-sym-cell">' +
        '<div class="pos-sym-icon ' + m.cls + '">' + m.init + '</div>' +
        '<div class="pos-sym-info">' +
          '<div class="pos-sym-top">' +
            '<span class="pos-sym-ticker">' + sym + '</span>' +
            (sideCls ? '<span class="pos-side-badge ' + sideCls + '">' + sideLabel + '</span>' : '') +
          '</div>' +
          (subText ? '<span class="pos-sym-sub">' + subText + '</span>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function renderAlerts() {
    const body = document.getElementById('bpBody-alerts');
    if (!body) return;
    if (alerts.length === 0) {
      body.innerHTML = '<tr class="bp-empty-row"><td colspan="6">No alerts yet — right-click the chart and choose "Add Alert Here".</td></tr>';
    } else {
      body.innerHTML = alerts.map(a => {
        const isAbove = a.condition === 'Crosses Above';
        const dirCls = isAbove ? 'above' : 'below';
        const dirIcon = isAbove ? '↑' : '↓';
        const triggered = a.status === 'triggered';
        return (
          '<tr>' +
          '<td>' + symCell(a.symbol, '', '', '') + '</td>' +
          '<td><span class="ord-alert-dir ' + dirCls + '">' + dirIcon + ' ' + a.condition + '</span></td>' +
          '<td>' + fmt(a.price) + '</td>' +
          '<td><span class="ord-val-sub" style="display:inline">' + a.created + '</span></td>' +
          '<td><span class="bp-status ' + (triggered ? 'triggered' : 'active-status') + '">' + (triggered ? 'Triggered' : 'Active') + '</span></td>' +
          '<td>' + (!triggered ? '<span class="bp-action-icon" data-remove-alert="' + a.id + '"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span>' : '') + '</td>' +
          '</tr>'
        );
      }).join('');
    }
    body.querySelectorAll('[data-remove-alert]').forEach(el => {
      el.addEventListener('click', () => removeAlert(el.dataset.removeAlert));
    });
    const activeCount = alerts.filter(a => a.status === 'active').length;
    const countEl = document.getElementById('bpCountAlerts');
    if (countEl) countEl.textContent = activeCount > 0 ? '(' + activeCount + ')' : '';
  }

  function renderOpenOrders() {
    const body = document.getElementById('bpBody-orders');
    if (!body) return;
    const rows = [];

    if (order) {
      const sideCls  = order.side === 'buy' ? 'long' : 'short';
      const sideLabel = order.side === 'buy' ? 'Buy' : 'Sell';
      const closeSideCls  = order.side === 'buy' ? 'short' : 'long';
      const closeSideLabel = order.side === 'buy' ? 'Sell' : 'Buy';

      /* Entry row — only while still unfilled; once filled, it's a position, not an order */
      if (!order.filled) {
        rows.push(
          '<tr>' +
          '<td>' + symCell('ETHUSD', sideCls, sideLabel, 'Entry · ' + order.orderType) + '</td>' +
          '<td><span class="ord-val-primary">' + order.qty + '</span></td>' +
          '<td>' + fmt(order.entry) + '</td>' +
          '<td><span class="bp-status working">Pending</span></td>' +
          '<td><span class="bp-action-icon" data-cancel-entry="1"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
          '</tr>'
        );
      }

      if (order.filled) {
        order.tps.forEach((tp, i) => {
          const tpQty = Math.max(1, Math.round(order.qty * tp.pct / 100));
          rows.push(
            '<tr' + (i === 0 ? ' class="ord-group-sep"' : '') + '>' +
            '<td>' + symCell('ETHUSD', closeSideCls, closeSideLabel, 'TP ' + (i + 1) + ' · Limit') + '</td>' +
            '<td><span class="ord-val-primary">' + tpQty + '</span></td>' +
            '<td>' + fmt(tp.price) + '</td>' +
            '<td><span class="bp-status working">Working</span></td>' +
            '<td><span class="bp-action-icon" data-cancel-tp="' + tp.id + '"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
            '</tr>'
          );
        });

        if (order.sl) {
          rows.push(
            '<tr' + (order.tps.length === 0 ? ' class="ord-group-sep"' : '') + '>' +
            '<td>' + symCell('ETHUSD', closeSideCls, closeSideLabel, 'Stop Loss · Stop') + '</td>' +
            '<td><span class="ord-val-primary">' + order.qty + '</span></td>' +
            '<td>' + fmt(order.sl.price) + '</td>' +
            '<td><span class="bp-status working">Working</span></td>' +
            '<td><span class="bp-action-icon" data-cancel-sl="1"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
            '</tr>'
          );
        }
      }
    }

    body.innerHTML = rows.length ? rows.join('') : '<tr class="bp-empty-row"><td colspan="5">No open orders — right-click the chart to trade.</td></tr>';
    body.querySelectorAll('[data-cancel-entry]').forEach(el => el.addEventListener('click', cancelOrder));
    body.querySelectorAll('[data-cancel-tp]').forEach(el => el.addEventListener('click', () => removeTp(el.dataset.cancelTp)));
    body.querySelectorAll('[data-cancel-sl]').forEach(el => el.addEventListener('click', removeSl));
    const countEl = document.getElementById('bpCountOrders');
    if (countEl) countEl.textContent = rows.length > 0 ? '(' + rows.length + ')' : '';
  }

  /* shared P&L cell formatting for Order History / Position History — null (opening fills) shows as a dash */
  function pnlCellHtml(pnl) {
    if (pnl === null) return '<span class="ord-val-sub" style="display:inline">—</span>';
    const pnlCls = pnl >= 0 ? 'up' : 'down';
    const pnlStr = (pnl >= 0 ? '+' : '') + '$' + fmt(Math.abs(pnl));
    return '<span class="' + pnlCls + '" style="font-weight:500">' + pnlStr + '</span>';
  }

  function renderOrderHistory() {
    const body = document.getElementById('bpBody-history');
    if (!body) return;
    if (orderHistory.length === 0) {
      body.innerHTML = '<tr class="bp-empty-row"><td colspan="6">No order history yet.</td></tr>';
      return;
    }
    body.innerHTML = orderHistory.map(h => {
      const sideCls   = h.side === 'buy' ? 'long' : 'short';
      const sideLabel = h.side === 'buy' ? 'Buy' : 'Sell';
      const statusLabel = h.status.charAt(0).toUpperCase() + h.status.slice(1);
      return (
        '<tr>' +
        '<td>' + symCell(h.symbol, sideCls, sideLabel, h.type || '') + '</td>' +
        '<td><span class="ord-val-primary">' + h.qty + '</span></td>' +
        '<td>' + fmt(h.price) + '</td>' +
        '<td>' + pnlCellHtml(h.pnl) + '</td>' +
        '<td><span class="ord-val-sub" style="display:inline">' + h.time + '</span></td>' +
        '<td><span class="bp-status ' + h.status + '">' + statusLabel + '</span></td>' +
        '</tr>'
      );
    }).join('');
  }

  function renderTradeHistory() {
    const body = document.getElementById('bpBody-trades');
    if (!body) return;
    if (tradeHistory.length === 0) {
      body.innerHTML = '<tr class="bp-empty-row"><td colspan="6">No trades yet — executed fills will appear here.</td></tr>';
      return;
    }
    body.innerHTML = tradeHistory.map(t => {
      const sideCls   = t.side === 'buy' ? 'long' : 'short';
      const sideLabel = t.side === 'buy' ? 'Buy' : 'Sell';
      const subText = t.role === 'open'
        ? 'Open · ' + t.type
        : t.type === 'Limit (TP)' ? 'Take Profit · Close'
        : t.type === 'Stop (SL)'  ? 'Stop Loss · Close'
        : 'Market Close';
      return (
        '<tr>' +
        '<td>' + symCell(t.symbol, sideCls, sideLabel, subText) + '</td>' +
        '<td><span class="ord-val-primary">' + t.qty + '</span></td>' +
        '<td>' + fmt(t.price) + '</td>' +
        '<td>' + pnlCellHtml(t.pnl) + '</td>' +
        '<td><span class="ord-val-sub" style="display:inline">' + fmtMoney(t.fee) + '</span></td>' +
        '<td><span class="ord-val-sub" style="display:inline">' + t.time + '</span></td>' +
        '</tr>'
      );
    }).join('');
  }

  function syncQtyFromRisk() {
    if (!order || order.sizeMode !== 'risk' || !order.sl) return;
    const stopDist = Math.abs(order.entry - order.sl.price);
    const riskPerContract = stopDist * POINT_VALUE;
    if (riskPerContract > 0) { order.qty = Math.max(0, Math.floor(order.sizeValues.risk / riskPerContract)); }
  }

  /* ---------- TP fee & net PnL helpers ---------- */
  /* Entry fee depends on order type (market fill vs limit fill); TP exit is always a limit order. */
  function tpFeeCalc(tp, contracts) {
    const dir = order.side === 'buy' ? 1 : -1;
    const gross = dir * (tp.price - order.entry) * POINT_VALUE * contracts;
    const entryFeeRate = /Market/.test(order.orderType) ? FEE_RATE_MARKET : FEE_RATE_LIMIT;
    const fee = (order.entry * entryFeeRate + tp.price * FEE_RATE_LIMIT) * contracts;
    return { gross, fee, net: gross - fee };
  }
  function tpFeeTooltipHtml(gross, fee, net) {
    const sign = v => v >= 0 ? '+' : '';
    const cls  = v => v >= 0 ? 'up' : 'down';
    return '<span class="tp-fee-row"><span class="tp-fee-lbl">Gross</span><span class="tp-fee-val ' + cls(gross) + '">' + sign(gross) + fmtMoney(gross) + '</span></span>' +
      '<span class="tp-fee-row"><span class="tp-fee-lbl">Fee</span><span class="tp-fee-val">-' + fmtMoney(fee) + '</span></span>' +
      '<span class="tp-fee-row tp-fee-row-net"><span class="tp-fee-lbl">Net</span><span class="tp-fee-val ' + cls(net) + '">' + sign(net) + fmtMoney(net) + '</span></span>';
  }

  /* ---------- drag behaviour ---------- */
  /* a TP/SL is only valid on the correct side of entry: long TP above / SL below, short TP below / SL above */
  function tpSlSideOk(kind, price) {
    const dir = order.side === 'buy' ? 1 : -1;
    return kind === 'tp' ? dir * (price - order.entry) > 0 : dir * (order.entry - price) > 0;
  }
  function orderTpSlValid() {
    if (!order) return true;
    return order.tps.every(tp => tpSlSideOk('tp', tp.price)) && (!order.sl || tpSlSideOk('sl', order.sl.price));
  }
  /* toggle the entry chip's disabled state without a full render(), so it reacts live while dragging */
  function updateEntryPlaceableState() {
    if (!order) return;
    const handle = document.getElementById('entryPriceHandle');
    if (!handle) return;
    handle.classList.toggle('disabled', order.pendingConfirm && !order.filled && !orderTpSlValid());
  }
  /* re-check every TP/SL chip's invalid state without a full render() — used while dragging Entry/TP/SL */
  function updateAllTpSlValidityLive() {
    if (!order) return;
    layer.querySelectorAll('.ol-side-row[data-tp-id]').forEach(row => {
      const tp = order.tps.find(t => t.id === row.dataset.tpId);
      if (tp) row.querySelector('.ol-chip').classList.toggle('invalid', !tpSlSideOk('tp', tp.price));
    });
    if (order.sl) {
      const slChip = layer.querySelector('.ol-chip.sl');
      if (slChip) slChip.classList.toggle('invalid', !tpSlSideOk('sl', order.sl.price));
    }
    updateEntryPlaceableState();
  }
  /* recompute every TP/SL chip's profit/loss amount and R-multiple without a full render() — used while
     dragging Entry/TP/SL, since each of those moves changes the reward (TP↔entry) and/or risk (entry↔SL)
     for every TP (same formulas as the initial render). SL's own "-1.0R" is fixed by definition. */
  function updateAllTpSlReadoutsLive() {
    if (!order) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const riskPerContractTotal = order.sl ? Math.abs(order.entry - order.sl.price) * POINT_VALUE : null;
    layer.querySelectorAll('.ol-side-row[data-tp-id]').forEach(row => {
      const tp = order.tps.find(t => t.id === row.dataset.tpId);
      if (!tp) return;
      const pts = dir * (tp.price - order.entry);
      const amtEl = row.querySelector('.ol-amt');
      if (amtEl) {
        const contracts = Math.max(1, Math.round(order.qty * tp.pct / 100));
        const { gross, fee, net } = tpFeeCalc(tp, contracts);
        const valEl = amtEl.querySelector('.tp-amt-val');
        if (valEl) valEl.textContent = (net >= 0 ? '+' : '') + fmtMoney(net);
        amtEl.classList.toggle('up', net >= 0);
        amtEl.classList.toggle('down', net < 0);
        const tipEl = amtEl.querySelector('.tp-fee-tip');
        if (tipEl) tipEl.innerHTML = tpFeeTooltipHtml(gross, fee, net);
      }
      const rEl = row.querySelector('.ol-rmult');
      if (rEl) {
        const rMultiple = riskPerContractTotal ? (pts * POINT_VALUE / riskPerContractTotal) : null;
        rEl.textContent = rMultiple !== null ? fmt(rMultiple, 1) + 'R' : '—R';
      }
    });
    if (order.sl) {
      const slAmtEl = layer.querySelector('.ol-chip.sl .ol-amt');
      if (slAmtEl) {
        const loss = dir * (order.entry - order.sl.price) * POINT_VALUE * order.qty;
        slAmtEl.textContent = '-' + fmtMoney(Math.abs(loss));
      }
    }
  }
  /* repositions just the entry line/bar without a full render() — used while a TP/SL drag is in progress,
     since a pending Market order's entry tracks the live price tick but render() is suppressed mid-drag
     to avoid wiping the drag's own DOM (see isDraggingOrderLine) */
  function updateEntryLinePositionLive() {
    if (!order) return;
    const line = layer.querySelector('.ol-line.entry');
    const bar = layer.querySelector('.ol-entry-bar');
    if (!line || !bar) return;
    const H = rectH();
    const y = clamp(priceToY(order.entry, H), 10, H - 10);
    line.style.top = y + 'px';
    bar.style.top = y + 'px';
    updateAllTpSlValidityLive();
    updateAllTpSlReadoutsLive();
  }
  /* a plain click (no movement) on the handle falls through to onClick (if given) instead of dragging — */
  /* lets a handle double as both a drag target and a menu/edit/place trigger (e.g. the size/type pills, .ol-amt) */
  function makeDraggable(handle, onDrag, onDrop, excludeSelector, onClick) {
    handle.addEventListener('mousedown', (e) => {
      if (excludeSelector && e.target.closest(excludeSelector)) return;
      e.preventDefault(); e.stopPropagation();
      closeAllPopovers();
      isDraggingOrderLine = true;
      const rect = chart.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      let dragging = false;
      function move(ev) {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          dragging = true;
        }
        const y = clamp(ev.clientY - rect.top, 10, rect.height - 10);
        onDrag(y, rect.height);
      }
      function up(ev) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        isDraggingOrderLine = false;
        if (!dragging) { if (onClick) onClick(); return; }
        const y = clamp(ev.clientY - rect.top, 10, rect.height - 10);
        onDrop(y, rect.height);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  /* ---------- TP/SL "add" handles next to the entry: drag away from entry to create a TP or SL at that price ---------- */
  function makeAddHandleDraggable(handle, kind) {
    handle.title = kind === 'tp' ? 'Drag to create TP' : 'Drag to create SL';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      closeAllPopovers();
      isDraggingOrderLine = true;
      hoveredHandle = kind + '-add';
      if (crosshair) crosshair = null;
      scheduleDrawPriceChart();
      const rect = chart.getBoundingClientRect();
      const dir = order.side === 'buy' ? 1 : -1;
      const minDist = 0.25;
      const handleRect = handle.getBoundingClientRect();
      const originX = handleRect.left - rect.left + handleRect.width / 2;

      handle.classList.add('drag-source');

      const guideLine = document.createElement('div');
      guideLine.className = 'ol-line ' + kind;
      layer.appendChild(guideLine);

      const floatChip = document.createElement('div');
      floatChip.className = 'ol-chip ' + kind + ' ol-drag-float';
      floatChip.style.left = originX + 'px';
      floatChip.innerHTML =
        '<span class="material-symbols-outlined ol-chip-warning">warning</span>' +
        '<span class="ol-drag-float-label">' + kind.toUpperCase() + '</span>' +
        '<span class="ol-drag-float-amt"></span>';
      layer.appendChild(floatChip);
      const amtEl = floatChip.querySelector('.ol-drag-float-amt');

      function isValid(rawPrice) {
        const signedDist = kind === 'tp' ? dir * (rawPrice - order.entry) : dir * (order.entry - rawPrice);
        return signedDist >= minDist;
      }
      function update(clientY) {
        const y = clamp(clientY - rect.top, 10, rect.height - 10);
        const rawPrice = yToPrice(y, rect.height);
        const price = roundTick(rawPrice);
        const valid = isValid(rawPrice);
        const py = clamp(priceToY(price, rect.height), 10, rect.height - 10);
        guideLine.style.top = py + 'px';
        floatChip.style.top = py + 'px';
        floatChip.classList.toggle('invalid', !valid);
        const pts = dir * (kind === 'tp' ? (price - order.entry) : (order.entry - price));
        const amount = pts * POINT_VALUE * order.qty;
        amtEl.textContent = (amount >= 0 ? '+' : '-') + fmtMoney(Math.abs(amount));
        return { price, valid };
      }

      let last = update(e.clientY);
      function move(ev) { last = update(ev.clientY); }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        isDraggingOrderLine = false;
        hoveredHandle = null;
        guideLine.remove();
        floatChip.remove();
        handle.classList.remove('drag-source');
        const finalPrice = last.price;
        if (kind === 'tp') {
          const newId = 'tp' + (tpCounter++);
          order.tps.push({ id: newId, price: finalPrice, pct: 100, trailing: false, trailOverride: null });
          rebalanceTpAllocations(newId);
        } else {
          order.sl = { price: finalPrice, enabled: false, mode: 'trailing', atrMult: (chartSettings.atrStop.multiplier || 2.0), beTpId: null, beActive: false, beOverride: null, trailOverride: makeSlConfig() };
          order.initialRisk = Math.abs(order.entry - order.sl.price) * POINT_VALUE;
          syncQtyFromRisk();
        }
        render();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  function bindHandleHover(handle, key) {
    handle.addEventListener('mouseenter', () => {
      hoveredHandle = key;
      if (crosshair) crosshair = null;
      scheduleDrawPriceChart();
    });
    handle.addEventListener('mouseleave', () => {
      if (hoveredHandle === key) hoveredHandle = null;
      scheduleDrawPriceChart();
    });
  }

  /* ---------- price chart (candlesticks) ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const candleBars = (function () {
    const rand = mulberry32(42);
    const n = 300;
    const bars = [];
    let price = BASE_PRICE - 14;
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const open = price;
      const drift = (rand() - 0.48) * 2.4;
      let close = isLast ? BASE_PRICE : open + drift;
      const wick = 0.6 + rand() * 1.8;
      let high = Math.max(open, close) + rand() * wick;
      let low = Math.min(open, close) - rand() * wick;
      bars.push({ open, high, low, close });
      price = close;
    }
    return bars;
  })();
  function newsTimeLabel(idxFromEnd) {
    const mins = idxFromEnd * BAR_INTERVAL_MIN;
    const hrs = Math.round(Math.abs(mins) / 60 * 10) / 10;
    const hrsStr = hrs % 1 === 0 ? hrs.toFixed(0) : hrs.toFixed(1);
    return mins > 0 ? hrsStr + 'h ago' : 'in ' + hrsStr + 'h';
  }
  // idxFromEnd values above ~60 sit just past the default-visible chart window on
  // first load — pan left to reveal them, same as scrolling back through older news.
  const newsEvents = [
    {
      idxFromEnd: 14,
      source: 'News',
      sentiment: 'bearish',
      headline: 'SEC Delays Ruling on Ether ETF Options Listing',
      description: 'The regulator pushed its decision window on the pending spot Ether ETF options proposal, citing the need for further review of market manipulation safeguards. Traders had priced in approval this week, raising the odds of near-term volatility.',
    },
    {
      idxFromEnd: -8,
      source: 'News',
      sentiment: 'bullish',
      headline: 'Ethereum Foundation Sets Fusaka Upgrade Mainnet Date',
      description: 'The Foundation confirmed a mainnet activation date for the Fusaka upgrade, which bundles several EIPs aimed at boosting blob throughput and cutting L2 data costs. Validators are expected to begin client upgrades ahead of the rollout.',
    },
    {
      idxFromEnd: -20,
      source: 'News',
      sentiment: 'bearish',
      headline: 'FOMC Meeting Begins Tomorrow — Rate Decision Due Wednesday',
      description: 'Markets are pricing in a 70% chance of a hold, with traders bracing for volatility around the 2:00 PM ET announcement and press conference.',
    },
    {
      idxFromEnd: 4,
      source: 'X',
      sentiment: 'bullish',
      headline: '@realDonaldTrump: "We are going to make the United States the bitcoin and crypto capital of the world!"',
      description: 'Pro-crypto rhetoric reignites optimism around friendlier U.S. digital asset policy.',
    },
    {
      idxFromEnd: 9,
      source: 'News',
      sentiment: 'bullish',
      headline: 'Fed Chair Signals Openness to September Rate Cut',
      description: 'Comments at a policy forum boosted bets on imminent easing, lifting risk assets broadly.',
    },
    {
      idxFromEnd: 27,
      source: 'X',
      sentiment: 'bullish',
      headline: '@elonmusk: "Had a constructive call with the SEC on crypto regulatory clarity."',
      description: 'Traders read the comment as a sign friendlier rules are coming.',
    },
    {
      idxFromEnd: 42,
      source: 'News',
      sentiment: 'bullish',
      headline: 'Nonfarm Payrolls Crush Estimates, Unemployment Falls',
      description: 'A blowout jobs report initially weighed on rate-cut bets, but risk assets recovered as the soft-landing narrative held.',
    },
    {
      idxFromEnd: 58,
      source: 'X',
      sentiment: 'bearish',
      headline: '@realDonaldTrump: "China is not living up to the deal. Tariffs going up substantially!"',
      description: 'Tariff-escalation rhetoric pressured risk assets across the board.',
    },
    {
      idxFromEnd: 78,
      source: 'News',
      sentiment: 'bearish',
      headline: 'US Core CPI Comes In Above Expectations',
      description: 'A hotter-than-forecast inflation print pressured rate-cut bets and sent risk assets lower.',
    },
  ].map(ev => Object.assign(ev, { timeLabel: newsTimeLabel(ev.idxFromEnd) }));
  let newsMarkerEls = null;
  let hoveringNewsMarker = false;
  function buildNewsMarkers() {
    if (!newsMarkerLayer) return [];
    const els = newsEvents.map(ev => {
      const el = document.createElement('div');
      el.className = 'news-marker ' + ev.sentiment;
      const sentimentLabel = ev.sentiment === 'bullish' ? 'Bullish' : 'Bearish';
      el.innerHTML =
        '<div class="news-marker-guide"></div>' +
        '<div class="news-marker-icon"><span class="material-symbols-outlined">article</span></div>' +
        '<div class="news-marker-popup">' +
        '<div class="news-bar"></div>' +
        '<div class="news-main">' +
        '<div class="news-row-top"><span class="news-src">' + ev.source + '</span><span class="news-sentiment">' + sentimentLabel + '</span><span class="news-time">' + ev.timeLabel + '</span></div>' +
        '<div class="news-headline">' + ev.headline + '</div>' +
        '<div class="news-desc">' + ev.description + '</div>' +
        '</div>' +
        '</div>';
      newsMarkerLayer.appendChild(el);
      const icon = el.querySelector('.news-marker-icon');
      icon.addEventListener('mouseenter', () => {
        el.classList.add('hovered');
        hoveringNewsMarker = true;
        if (crosshair) { crosshair = null; scheduleDrawPriceChart(); }
      });
      icon.addEventListener('mouseleave', () => {
        el.classList.remove('hovered');
        hoveringNewsMarker = false;
      });
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasActive = el.classList.contains('active');
        els.forEach(m => m.classList.remove('active'));
        if (!wasActive) el.classList.add('active');
      });
      return el;
    });
    return els;
  }
  document.addEventListener('click', () => {
    if (newsMarkerEls) newsMarkerEls.forEach(m => m.classList.remove('active'));
  });
  function renderNewsMarkers(slot, baseIndexOffset, panX, plotW, ih, n) {
    if (!newsMarkerLayer) return;
    if (!newsMarkerEls) newsMarkerEls = buildNewsMarkers();
    newsEvents.forEach((ev, i) => {
      const el = newsMarkerEls[i];
      const barIndex = (n - 1) - ev.idxFromEnd;
      const x = slot * (barIndex - baseIndexOffset) + slot / 2 + panX;
      if (x < -slot || x > plotW + slot) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.left = x + 'px';
      }
    });
  }
  function niceStep(raw) {
    const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow10;
    let step;
    if (norm < 1.5) step = 1; else if (norm < 3) step = 2; else if (norm < 7) step = 5; else step = 10;
    return step * pow10;
  }
  function fmtBarTime(idxFromEnd) {
    const ts = Date.now() - idxFromEnd * BAR_INTERVAL_MIN * 60000;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  let secondaryPanes = []; // [{canvas, container}] — live panes other than the primary
  window.ttRepaintChart = () => {
    drawPriceChart();
    secondaryPanes.forEach(({ canvas, container }) => drawPriceChart(canvas, container.getBoundingClientRect()));
  };

  function drawPriceChart(secCanvas, secRect) {
    const targetCanvas = secCanvas || priceCanvas;
    if (!targetCanvas) return;
    const rect = secRect || chart.getBoundingClientRect();
    const isPrimary = !secCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width, h = rect.height;
    if (w <= 0 || h <= 0) return;
    targetCanvas.width = w * dpr; targetCanvas.height = h * dpr;
    const ctx = targetCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = Math.max(0, w - AXIS_RIGHT_W);
    const ih = Math.max(0, h - AXIS_BOTTOM_H);
    const themeVars = getComputedStyle(document.documentElement);
    const themeColor = (name) => themeVars.getPropertyValue(name).trim();
    const upColor = themeColor('--long'), downColor = themeColor('--short');
    const axisLineColor = themeColor('--border-default'), labelColor = themeColor('--text-muted');

    const n = candleBars.length;
    const slotCount = VISIBLE_BARS + FUTURE_BARS;
    const slot = plotW / slotCount;
    const bodyW = Math.max(2, slot * 0.6);
    const baseIndexOffset = n - VISIBLE_BARS; // shifts older bars off-screen to the left; pan to reveal them
    if (!panXInitialized) { panX = -slot * 20; panXInitialized = true; }

    /* ---- price axis labels (no gridlines — just the right-edge scale) ---- */
    const targetPxGap = 56;
    const priceStep = niceStep(targetPxGap / PX_PER_POINT);
    const topPrice = yToPrice(0, h);
    const botPrice = yToPrice(ih, h);
    const desiredLabels = Math.max(3, Math.round(plotW / 110));
    const stride = Math.max(1, Math.round(slotCount / desiredLabels));
    ctx.fillStyle = labelColor;
    ctx.font = '11px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let p = Math.ceil(botPrice / priceStep) * priceStep; p <= topPrice; p += priceStep) {
      ctx.fillText(fmt(p), plotW + 8, priceToY(p, h));
    }

    /* ---- candles (clipped to the plot area so panning doesn't bleed into the axes) ---- */
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, ih);
    ctx.clip();
    ctx.lineWidth = 1;
    candleBars.forEach((bar, i) => {
      const cx = slot * (i - baseIndexOffset) + slot / 2 + panX;
      if (cx < -slot || cx > plotW + slot) return;
      const up = bar.close >= bar.open;
      const color = up ? upColor : downColor;
      const yO = priceToY(bar.open, h), yC = priceToY(bar.close, h);
      const yH = priceToY(bar.high, h), yL = priceToY(bar.low, h);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx, yH); ctx.lineTo(cx, yL);
      ctx.stroke();
      ctx.fillStyle = color;
      const top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
    });
    ctx.restore();

    /* ---- time axis labels (continues past the last candle into the future) ---- */
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let vi = 0; vi < slotCount; vi += stride) {
      const x = slot * vi + slot / 2 + panX;
      if (x < 0 || x > plotW) continue;
      ctx.fillText(fmtBarTime((VISIBLE_BARS - 1) - vi), x, ih + 7);
    }
    if (isPrimary) renderNewsMarkers(slot, baseIndexOffset, panX, plotW, ih, n);

    /* ---- axis divider lines ---- */
    ctx.strokeStyle = axisLineColor;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, h);
    ctx.moveTo(0, ih + 0.5); ctx.lineTo(plotW, ih + 0.5);
    ctx.stroke();

    /* ---- dotted current-price line ---- */
    const lastBar = candleBars[n - 1];
    const lastUp = lastBar.close >= lastBar.open;
    const tagColor = lastUp ? upColor : downColor;
    const tagY = clamp(priceToY(lastBar.close, h), 8, h - 8);
    ctx.save();
    ctx.strokeStyle = tagColor;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, tagY); ctx.lineTo(plotW, tagY);
    ctx.stroke();
    ctx.restore();

    /* ---- highlighted current-price tag ---- */
    ctx.fillStyle = tagColor;
    ctx.fillRect(plotW, tagY - 9, AXIS_RIGHT_W, 18);
    ctx.fillStyle = themeColor('--on-signal');
    ctx.font = '600 11px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmt(lastBar.close), plotW + 8, tagY + 0.5);

    /* ---- order price tags (entry / TP / SL) on the right axis ---- */
    function drawOrderAxisTagOutline(price, color, highlighted) {
      const y = clamp(priceToY(price, h), 8, h - 8);
      const hh = highlighted ? 20 : 18;
      ctx.fillStyle = highlighted ? color : themeColor('--bg-base');
      ctx.fillRect(plotW, y - hh / 2, AXIS_RIGHT_W, hh);
      ctx.strokeStyle = color;
      ctx.lineWidth = highlighted ? 1.5 : 1;
      ctx.strokeRect(plotW + 0.5, y - hh / 2 + 0.5, AXIS_RIGHT_W - 1, hh - 1);
      ctx.fillStyle = highlighted ? themeColor('--bg-base') : color;
      ctx.font = '600 11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(price), plotW + 8, y + 0.5);
    }
    if (isPrimary && order) {
      order.tps.forEach(tp => drawOrderAxisTagOutline(tp.price, upColor, hoveredHandle === 'tp:' + tp.id));
      if (order.sl) drawOrderAxisTagOutline(order.sl.price, downColor, hoveredHandle === 'sl');
      drawOrderAxisTagOutline(order.entry, order.side === 'buy' ? upColor : downColor, hoveredHandle === 'entry');
    }

    /* ---- crosshair: dotted guide lines + axis labels at cursor ---- */
    if (isPrimary && crosshair) {
      const cx = clamp(crosshair.x, 0, plotW);
      const cy = clamp(crosshair.y, 0, ih);
      ctx.save();
      ctx.strokeStyle = themeColor('--crosshair-line');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, 0); ctx.lineTo(cx + 0.5, ih);
      ctx.moveTo(0, cy + 0.5); ctx.lineTo(plotW, cy + 0.5);
      ctx.stroke();
      ctx.restore();

      const tooltipBg = themeColor('--bg-input'), tooltipBorder = themeColor('--border-strong'), tooltipText = themeColor('--text-primary');
      const hoverPrice = yToPrice(cy, h);
      ctx.fillStyle = tooltipBg;
      ctx.strokeStyle = tooltipBorder;
      ctx.lineWidth = 1;
      ctx.fillRect(plotW, cy - 9, AXIS_RIGHT_W, 18);
      ctx.strokeRect(plotW + 0.5, cy - 8.5, AXIS_RIGHT_W - 1, 17);
      ctx.fillStyle = tooltipText;
      ctx.font = '600 11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(hoverPrice), plotW + 8, cy + 0.5);

      const vi = clamp(Math.round((cx - panX - slot / 2) / slot), 0, slotCount - 1);
      const timeLabel = fmtBarTime((VISIBLE_BARS - 1) - vi);
      ctx.font = '600 11px "IBM Plex Sans", sans-serif';
      const tw = ctx.measureText(timeLabel).width + 16;
      const tx = clamp(cx - tw / 2, 0, plotW - tw);
      ctx.fillStyle = tooltipBg;
      ctx.fillRect(tx, ih, tw, AXIS_BOTTOM_H);
      ctx.strokeRect(tx + 0.5, ih + 0.5, tw - 1, AXIS_BOTTOM_H - 1);
      ctx.fillStyle = tooltipText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeLabel, tx + tw / 2, ih + AXIS_BOTTOM_H / 2 + 0.5);
    }
  }
  let chartResizeRaf = null;
  function scheduleDrawPriceChart() {
    if (chartResizeRaf) return;
    chartResizeRaf = requestAnimationFrame(() => {
      chartResizeRaf = null;
      drawPriceChart();
      secondaryPanes.forEach(({ canvas, container }) => {
        drawPriceChart(canvas, container.getBoundingClientRect());
      });
    });
  }
  new ResizeObserver(scheduleDrawPriceChart).observe(chart);
  window.addEventListener('resize', scheduleDrawPriceChart);
  drawPriceChart();

  /* ---------- chart panning (drag to move around) ---------- */
  let isPanning = false;
  let panStart = { x: 0, y: 0, panX: 0, panY: 0 };
  chart.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.ol-entry-bar, .ol-side-row, .ol-alert-hit, .pop-menu, .ctx-menu')) return;
    isPanning = true;
    chart.classList.add('panning');
    panStart = { x: e.clientX, y: e.clientY, panX, panY };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = panStart.panX + (e.clientX - panStart.x);
    panY = panStart.panY + (e.clientY - panStart.y) / PX_PER_POINT;
    scheduleDrawPriceChart();
    render();
  });
  document.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    chart.classList.remove('panning');
  });

  /* ---------- chart crosshair (dotted guide lines + axis labels) ---------- */
  chart.addEventListener('mousemove', (e) => {
    const rect = chart.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const plotW = rect.width - AXIS_RIGHT_W, ih = rect.height - AXIS_BOTTOM_H;
    if (isPanning || hoveringNewsMarker || hoveredHandle || isHoveringBarControls || x < 0 || x > plotW || y < 0 || y > ih) {
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); }
      return;
    }
    crosshair = { x, y };
    scheduleDrawPriceChart();
  });
  chart.addEventListener('mouseleave', () => {
    if (!crosshair) return;
    crosshair = null;
    scheduleDrawPriceChart();
  });

  /* ---------- live price simulation: primary symbol (ETH) ---------- */
  (function () {
    const simRand = mulberry32(7777);
    function noise() { let s = 0; for (let i = 0; i < 3; i++) s += simRand(); return (s - 1.5); }
    function setUpDown(el, isUp) { el.classList.remove('up', 'down'); el.classList.add(isUp ? 'up' : 'down'); }
    function flashEl(el, isUp) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(isUp ? 'flash-up' : 'flash-down'); }
    function fmtVol(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(Math.round(v)); }

    const dayOpen = 4493.50;
    const prevClose = BASE_PRICE - 18.25; // matches the +18.25 day change shown at load
    let last = BASE_PRICE;
    let dayHigh = 4505.75, dayLow = 4473.25;
    let vol = 24800;

    const els = {
      hdrLast: document.getElementById('hdrLast'),
      hdrChg: document.getElementById('hdrChg'),
      hdrBid: document.getElementById('hdrBid'),
      hdrAsk: document.getElementById('hdrAsk'),
      hdrDayHigh: document.getElementById('hdrDayHigh'),
      hdrDayLow: document.getElementById('hdrDayLow'),
      wlLast: document.getElementById('wlLast-ETHUSD'),
      wlChg: document.getElementById('wlChg-ETHUSD'),
      ohlcH: document.getElementById('ohlcH'),
      ohlcL: document.getElementById('ohlcL'),
      ohlcC: document.getElementById('ohlcC'),
      ohlcChg: document.getElementById('ohlcChg'),
      ohlcVol: document.getElementById('ohlcVol'),
    };

    function tick() {
      const prevLast = last;
      const reversion = (BASE_PRICE - last) * 0.015;
      let next = roundTick(last + noise() * 1.2 + reversion);
      if (next === last) next = roundTick(last + (simRand() < 0.5 ? -TICK : TICK));
      last = next;
      dayHigh = Math.max(dayHigh, last);
      dayLow = Math.min(dayLow, last);
      vol += 40 + simRand() * 260;

      const tickUp = last > prevLast;
      const dayChg = last - prevClose;
      const dayChgPct = dayChg / prevClose * 100;
      const dayUp = dayChg >= 0;

      els.hdrLast.textContent = fmt(last);
      els.hdrChg.textContent = (dayUp ? '+' : '') + fmt(dayChg) + ' (' + (dayUp ? '+' : '') + fmt(dayChgPct) + '%)';
      setUpDown(els.hdrChg, dayUp);
      els.hdrBid.textContent = fmt(roundTick(last - TICK));
      els.hdrAsk.textContent = fmt(last);
      els.hdrDayHigh.textContent = fmt(dayHigh);
      els.hdrDayLow.textContent = fmt(dayLow);

      els.wlLast.textContent = fmt(last);
      els.wlChg.textContent = (dayUp ? '+' : '') + fmt(dayChgPct) + '%';
      setUpDown(els.wlChg, dayUp);

      els.ohlcH.textContent = fmt(dayHigh);
      els.ohlcL.textContent = fmt(dayLow);
      els.ohlcC.textContent = fmt(last);
      const ohlcUp = last >= dayOpen;
      setUpDown(els.ohlcC, ohlcUp);
      const ohlcChg = last - dayOpen, ohlcChgPct = ohlcChg / dayOpen * 100;
      els.ohlcChg.textContent = (ohlcUp ? '+' : '') + fmt(ohlcChg) + ' (' + (ohlcUp ? '+' : '') + fmt(ohlcChgPct) + '%)';
      setUpDown(els.ohlcChg, ohlcUp);
      els.ohlcVol.textContent = fmtVol(vol);

      flashEl(els.hdrLast, tickUp);
      flashEl(els.wlLast, tickUp);

      const lastBar = candleBars[candleBars.length - 1];
      lastBar.close = last;
      lastBar.high = Math.max(lastBar.high, last);
      lastBar.low = Math.min(lastBar.low, last);
      scheduleDrawPriceChart();
      checkTpFills(prevLast, last);
      if (order && order.filled) checkSlHit(last);
      if (order && !order.filled && order.pendingConfirm && order.orderType === 'Market') {
        order.entry = last;
        if (slTrailActive()) applyTrailingStopPreview();
        else if (slAtrActive()) placeAtrStop();
        if (!isDraggingOrderLine) render();
        else updateEntryLinePositionLive();
      }
      if (order && !order.filled && !order.pendingConfirm && !order.filling) {
        const hitEntry = order.fillAbove ? last >= order.entry : last <= order.entry;
        if (hitEntry) startFillSweep();
      }
      simTickCounter++;
      applyTrailingStop(last);
      applyTrailingTp(last);
      if (order && order.filled && !isDraggingOrderLine) render();

      let alertsChanged = false;
      alerts.forEach(a => {
        if (a.status !== 'active') return;
        const hit = a.condition === 'Crosses Above' ? last >= a.price : last <= a.price;
        if (hit) {
          a.status = 'triggered';
          alertsChanged = true;
          showToast('Alert triggered: ETHUSD ' + a.condition.toLowerCase() + ' ' + fmt(a.price), 'notifications_active');
        }
      });
      if (alertsChanged) renderAlerts();
    }
    setInterval(tick, 1200 + Math.random() * 400);
  })();

  /* ---------- main render ---------- */
  function render() {
    renderOpenOrders();
    renderOrderHistory();
    renderTradeHistory();
    isHoveringBarControls = false;
    layer.innerHTML = '';
    const H0 = rectH();
    alerts.forEach(a => {
      const y = clamp(priceToY(a.price, H0), 10, H0 - 10);
      const hit = document.createElement('div');
      hit.className = 'ol-alert-hit';
      hit.style.top = y + 'px';
      hit.innerHTML =
        '<div class="ol-line alert"></div>' +
        '<div class="ol-alert-tag"><span class="material-symbols-outlined" style="font-size:13px;">notifications</span><span class="ol-alert-price">' + fmt(a.price) + '</span>' +
        '<span class="ol-alert-del" data-del-alert="' + a.id + '"><span class="material-symbols-outlined" style="font-size:13px;">close</span></span>' +
        '</div>';
      layer.appendChild(hit);
      hit.querySelector('[data-del-alert]').addEventListener('click', (e) => {
        e.stopPropagation();
        removeAlert(a.id);
      });
      const alertTagEl = hit.querySelector('.ol-alert-tag');
      const alertPriceEl = hit.querySelector('.ol-alert-price');
      alertTagEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.ol-alert-del')) return;
        e.preventDefault(); e.stopPropagation();
        closeAllPopovers();
        hit.classList.add('dragging');
        const rect = chart.getBoundingClientRect();
        function move(ev) {
          const cy = clamp(ev.clientY - rect.top, 10, rect.height - 10);
          hit.style.top = cy + 'px';
          a.price = roundTick(yToPrice(cy, rect.height));
          alertPriceEl.textContent = fmt(a.price);
          drawPriceChart();
        }
        function up(ev) {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          hit.classList.remove('dragging');
          const cy = clamp(ev.clientY - rect.top, 10, rect.height - 10);
          a.price = roundTick(yToPrice(cy, rect.height));
          render();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
    if (!order) { return; }
    const H = rectH();

    // ---- TP lines (sorted nearest-to-entry first, so labels renumber TP1, TP2, TP3... by proximity) ----
    {
      const tpSortDir = order.side === 'buy' ? 1 : -1;
      order.tps.slice().sort((a, b) => tpSortDir * (a.price - b.price)).forEach((tp, idx) => {
        const y = clamp(priceToY(tp.price, H), 10, H - 10);
        const line = document.createElement('div');
        line.className = 'ol-line tp';
        line.style.top = y + 'px';
        layer.appendChild(line);

        const dir = order.side === 'buy' ? 1 : -1;
        const pts = dir * (tp.price - order.entry);
        const contracts = Math.max(1, Math.round(order.qty * tp.pct / 100));
        const { gross: tpGross, fee: tpFee, net: tpNet } = tpFeeCalc(tp, contracts);
        const riskPerContractTotal = order.sl ? Math.abs(order.entry - order.sl.price) * POINT_VALUE : null;
        const rMultiple = riskPerContractTotal ? (pts * POINT_VALUE / riskPerContractTotal) : null;
        const tpInvalid = !tpSlSideOk('tp', tp.price);

        const row = document.createElement('div');
        row.className = 'ol-side-row';
        row.dataset.tpId = tp.id;
        row.style.top = y + 'px';
        const tpSign = tpNet >= 0 ? '+' : '';
        row.innerHTML =
          '<span class="ol-chip tp' + (tpInvalid ? ' invalid' : '') + '"><span class="material-symbols-outlined ol-chip-warning">warning</span>TP' + (idx + 1) + (tp.trailing ? '<span class="ol-badge trail">TRAIL</span>' : '') + '<span class="ol-amt ' + (tpNet >= 0 ? 'up' : 'down') + '" data-edit-tp="' + tp.id + '"><span class="tp-amt-val">' + tpSign + fmtMoney(tpNet) + '</span><span class="tp-fee-tip">' + tpFeeTooltipHtml(tpGross, tpFee, tpNet) + '</span></span></span>' +
          '<span class="ol-rmult">' + (rMultiple !== null ? fmt(rMultiple, 1) + 'R' : '—R') + '</span>' +
          '<span class="ol-pct-chip" data-pct-tp="' + tp.id + '">' + tp.pct + '%</span>' +
          '<span class="ol-gear" data-gear-tp="' + tp.id + '"><span class="material-symbols-outlined">settings</span></span>' +
          '<span class="ol-gear ol-danger" data-remove-tp="' + tp.id + '" title="Remove TP"><span class="material-symbols-outlined">delete</span></span>';
        layer.appendChild(row);

        const tpChipEl = row.querySelector('.ol-chip');
        bindHandleHover(tpChipEl, 'tp:' + tp.id);
        function onDragTp(cy, h) {
          row.style.top = cy + 'px'; line.style.top = cy + 'px';
          tp.price = roundTick(yToPrice(cy, h));
          updateAllTpSlValidityLive();
          updateAllTpSlReadoutsLive();
          drawPriceChart();
        }
        function onDropTp(cy, h) {
          tp.price = roundTick(yToPrice(cy, h));
          render();
        }
        makeDraggable(tpChipEl, onDragTp, onDropTp);
        makeDraggable(line, onDragTp, onDropTp);

        row.querySelector('[data-edit-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditExitModal(tp.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        row.querySelector('[data-pct-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditExitModal(tp.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        row.querySelector('[data-gear-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          activeGearTpId = tp.id;
          openTpGearMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        row.querySelector('[data-remove-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          removeTp(tp.id);
        });
      });

      // ---- SL line ----
      if (order.sl) {
        const y = clamp(priceToY(order.sl.price, H), 10, H - 10);
        const line = document.createElement('div');
        line.className = 'ol-line sl';
        line.style.top = y + 'px';
        layer.appendChild(line);

        const dir = order.side === 'buy' ? 1 : -1;
        const pts = dir * (order.entry - order.sl.price);
        const loss = pts * POINT_VALUE * order.qty;
        const slInvalid = !tpSlSideOk('sl', order.sl.price);

        const badge = slBadgeInfo();
        const row = document.createElement('div');
        row.className = 'ol-side-row';
        row.style.top = y + 'px';
        row.innerHTML =
          '<span class="ol-chip sl' + (slInvalid ? ' invalid' : '') + '">' +
            '<span class="material-symbols-outlined ol-chip-warning">warning</span>SL' +
            '<span class="ol-badge ' + badge.cls + '" id="slBadgeTrigger" title="Edit stop loss">' + badge.text + '</span>' +
            '<span class="ol-amt down">-' + fmtMoney(Math.abs(loss)) + '</span>' +
            '<button class="sl-chip-toggle' + (order.sl.enabled ? ' on' : '') + '" id="slChipToggle" type="button" title="Enable/disable special SL behavior"><span class="ui-toggle-track"><span class="ui-toggle-thumb"></span></span></button>' +
          '</span>' +
          '<span class="ol-rmult">-1.0R</span>' +
          '<span class="ol-pct-chip">100%</span>' +
          '<span class="ol-gear ol-danger" id="slDeleteTrigger" title="Remove SL"><span class="material-symbols-outlined">delete</span></span>';
        layer.appendChild(row);

        const slChipEl = row.querySelector('.ol-chip');
        bindHandleHover(slChipEl, 'sl');
        // Dragging the SL line: trailing redefines its distance; a manual drag detaches an ATR stop
        function syncSlOnDrag() {
          if (slTrailActive()) {
            const cfg = ensureSlConfig();
            cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(cfg.distanceUnit === 'percent' ? 2 : 0);
          } else if (slAtrActive()) {
            order.sl.enabled = false;
          }
          const badgeEl = document.getElementById('slBadgeTrigger');
          if (badgeEl) { const info = slBadgeInfo(); badgeEl.textContent = info.text; badgeEl.className = 'ol-badge ' + info.cls; }
          const togEl = document.getElementById('slChipToggle');
          if (togEl) togEl.classList.toggle('on', order.sl.enabled);
        }
        function onDragSl(cy, h) {
          row.style.top = cy + 'px'; line.style.top = cy + 'px';
          order.sl.price = roundTick(yToPrice(cy, h));
          syncSlOnDrag();
          updateAllTpSlValidityLive();
          updateAllTpSlReadoutsLive();
          drawPriceChart();
        }
        function onDropSl(cy, h) {
          order.sl.price = roundTick(yToPrice(cy, h));
          syncSlOnDrag();
          syncQtyFromRisk();
          render();
        }
        makeDraggable(slChipEl, onDragSl, onDropSl, '.ol-badge, .sl-chip-toggle');
        makeDraggable(line, onDragSl, onDropSl);

        row.querySelector('#slBadgeTrigger').addEventListener('click', (e) => {
          e.stopPropagation();
          openSlGearMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        row.querySelector('#slChipToggle').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSlEnabled();
        });
        row.querySelector('#slDeleteTrigger').addEventListener('click', (e) => {
          e.stopPropagation();
          removeSl();
        });
      }
    }

    // ---- Entry line + control bar (always visible in full edit mode) ----
    {
      const y = clamp(priceToY(order.entry, H), 10, H - 10);
      const canDragEntry = !order.filled && !(order.pendingConfirm && order.orderType === 'Market');
      const placeable = !order.filled && order.pendingConfirm;
      const blocked = placeable && !orderTpSlValid();

      const line = document.createElement('div');
      line.className = 'ol-line entry ' + order.side + (canDragEntry ? ' draggable' : '');
      line.style.top = y + 'px';
      layer.appendChild(line);

      function onDragEntry(cy, h) {
        bar.style.top = cy + 'px'; line.style.top = cy + 'px';
        order.entry = roundTick(yToPrice(cy, h));
        // Keep an automated SL anchored to entry while dragging for non-market orders
        if (order.orderType !== 'Market') {
          if (slTrailActive()) applyTrailingStopPreview();
          else if (slAtrActive()) placeAtrStop();
        }
        updateAllTpSlValidityLive();
        updateAllTpSlReadoutsLive();
        drawPriceChart();
      }
      function onDropEntry(cy, h) {
        order.entry = roundTick(yToPrice(cy, h));
        syncQtyFromRisk();
        render();
      }
      if (canDragEntry) makeDraggable(line, onDragEntry, onDropEntry);

      const bar = document.createElement('div');
      bar.className = 'ol-entry-bar';
      bar.style.top = y + 'px';

      const side = order.side;
      const sideLabel = side === 'buy' ? 'BUY' : 'SELL';
      const tpAddHandleHtml = '<span class="ol-chip ghost tp-add" id="tpAddHandle">TP</span>';
      const slAddHandleHtml = !order.sl ? '<span class="ol-chip ghost sl-add" id="slAddHandle">SL</span>' : '';
      const sizeLabel = order.sizeMode === 'contracts' ? String(order.qty)
        : order.sizeMode === 'dollar' ? '$' + fmt(order.sizeValues.dollar, 0)
          : order.sizeMode === 'percent' ? order.sizeValues.percent + '%'
            : String(order.qty);

      if (!order.filled) {
        let entryTitle;
        if (blocked) entryTitle = 'Fix invalid TP/SL before placing the order';
        else if (placeable) entryTitle = canDragEntry ? 'Drag to move, or click to place the order' : 'Click to place the order';
        else entryTitle = 'Drag to move entry';
        // Resting/working order: placed and waiting for price to reach entry (not yet filled, no longer awaiting placement)
        const working = !placeable;
        const entryClass = 'ol-chip entry ' + side
          + (placeable ? ' placeable' : '')
          + (working ? ' working' : '')
          + (order.filling ? ' filling' : '')   // keeps the progress fill at 100% if a re-render lands mid-sweep
          + (blocked ? ' disabled' : '');
        bar.innerHTML =
          '<span class="' + entryClass + '" id="entryPriceHandle" title="' + entryTitle + '">' +
          '<span class="ol-chip-fill"></span><span class="ol-chip-lbl">' + sideLabel + '</span></span>' +
          tpAddHandleHtml + slAddHandleHtml +
          '<span class="ol-pill neutral combo" id="orderConfigPill">' +
          '<span class="ol-pill-seg" id="sizePillTrigger">' + sizeLabel + '</span>' +
          '<span class="ol-pill-divider"></span>' +
          '<span class="ol-pill-seg" id="typePillTrigger">' + order.orderType + '</span>' +
          '</span>' +
          '<span class="ol-gear ol-danger" id="cancelOrderBtn" title="Cancel Order"><span class="material-symbols-outlined">delete</span></span>';
      } else {
        const dir = order.side === 'buy' ? 1 : -1;
        const currentPrice = qtCurrentPrice();
        const pnl = dir * (currentPrice - order.entry) * POINT_VALUE * order.qty;
        const pnlHtml = '<span class="ol-entry-pnl ' + (pnl >= 0 ? 'up' : 'down') + '">' + (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '</span>';
        bar.innerHTML =
          '<span class="ol-chip entry locked ' + side + '" id="entryPriceHandle">' + sideLabel + pnlHtml + '</span>' +
          tpAddHandleHtml + slAddHandleHtml +
          '<span class="ol-pill neutral combo locked" id="orderConfigPill">' +
          '<span class="ol-pill-seg" id="sizePillTrigger">' + order.qty + '</span>' +
          '<span class="ol-pill-divider"></span>' +
          '<span class="ol-pill-seg" id="typePillTrigger">' + order.orderType + '</span>' +
          '</span>' +
          '<span class="ol-gear ol-danger" id="cancelOrderBtn" title="Close Position"><span class="material-symbols-outlined">delete</span></span>';
      }
      layer.appendChild(bar);

      const tpAddHandle = bar.querySelector('#tpAddHandle');
      if (tpAddHandle) { makeAddHandleDraggable(tpAddHandle, 'tp'); bindHandleHover(tpAddHandle, 'tp-add'); }
      const slAddHandle = bar.querySelector('#slAddHandle');
      if (slAddHandle) { makeAddHandleDraggable(slAddHandle, 'sl'); bindHandleHover(slAddHandle, 'sl-add'); }

      const entryPriceHandle = bar.querySelector('#entryPriceHandle');
      if (entryPriceHandle) {
        bindHandleHover(entryPriceHandle, 'entry');
        if (canDragEntry) {
          makeDraggable(entryPriceHandle, onDragEntry, onDropEntry, undefined, placeOrder);
        } else if (placeable) {
          entryPriceHandle.addEventListener('click', (e) => { e.stopPropagation(); placeOrder(); });
        }
      }

      if (!order.filled) {
        bar.querySelector('#sizePillTrigger').addEventListener('click', (e) => {
          e.stopPropagation(); openSizeMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        bar.querySelector('#typePillTrigger').addEventListener('click', (e) => {
          e.stopPropagation(); openOrderTypeMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
      }
      bar.querySelector('#cancelOrderBtn').addEventListener('click', (e) => { e.stopPropagation(); cancelOrder(); });
    }

    drawPriceChart();
  }

  /* ---------- topbar alerts menu ---------- */
  const alertsTrigger = document.getElementById('alertsTrigger');
  const alertsTopbarMenu = document.getElementById('alertsTopbarMenu');
  alertsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openNear(alertsTopbarMenu, alertsTrigger.getBoundingClientRect(), 'left', alertsTrigger);
  });

  /* ---------- settings gear → Chart Settings modal ---------- */
  const settingsTrigger = document.getElementById('settingsTrigger');
  settingsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openChartSettings('general');
  });

  /* ---------- topbar account selector ---------- */
  const ACCOUNTS = [
    { id: 'BloFin', balance: 52430.00 },
    { id: 'TradeStation', balance: 128940.55 },
    { id: 'Bitget', balance: 76210.30 }
  ];
  let selectedAccountId = 'BloFin';
  const accountSelectTrigger = document.getElementById('accountSelectTrigger');
  const accountSelectMenu = document.getElementById('accountSelectMenu');
  const accountSelectList = document.getElementById('accountSelectList');
  function renderAccountSelect() {
    const acct = ACCOUNTS.find(a => a.id === selectedAccountId);
    document.getElementById('accountSelectName').textContent = acct.id;
    document.getElementById('accountSelectBalance').textContent = fmtMoney(acct.balance);
    accountSelectList.innerHTML = ACCOUNTS.map(a =>
      '<button class="pop-item account-item' + (a.id === selectedAccountId ? ' selected' : '') + '" data-account="' + a.id + '">' +
      '<span class="pop-text"><span class="pt-title">' + a.id + '</span></span>' +
      '<span class="account-item-balance">' + fmtMoney(a.balance) + '</span>' +
      '</button>'
    ).join('');
    accountSelectList.querySelectorAll('[data-account]').forEach(it => {
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedAccountId = it.dataset.account;
        renderAccountSelect();
        closeAllPopovers();
        showToast('Switched to ' + selectedAccountId, 'account_balance');
      });
    });
  }
  renderAccountSelect();
  accountSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openNear(accountSelectMenu, accountSelectTrigger.getBoundingClientRect(), 'left', accountSelectTrigger);
  });
  document.getElementById('accountConnectNew').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
    openChartSettings('broker');
  });

  /* ---------- Connect Broker modal ---------- */
  const bcConnectBackdrop = document.getElementById('bcConnectBackdrop');
  function openBcConnectModal() { bcConnectBackdrop.classList.add('show'); }
  function closeBcConnectModal() { bcConnectBackdrop.classList.remove('show'); }
  document.getElementById('bcConnectClose').addEventListener('click', closeBcConnectModal);
  bcConnectBackdrop.addEventListener('click', (e) => { if (e.target === bcConnectBackdrop) closeBcConnectModal(); });
  document.querySelectorAll('.bc-connect-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openBcConnectModal(); });
  });

  /* ---------- trade templates selector (UI-only — no settings are actually applied) ---------- */
  let templates = [
    { id: 'tpl1', name: 'Scalping' },
    { id: 'tpl2', name: 'Swing Trading' }
  ];
  let selectedTemplateId = 'tpl1';
  let templateIdCounter = 3;
  let templateNameMode = null; // 'save' | 'rename'
  let templateRenameTargetId = null;
  const templatesSelectTrigger = document.getElementById('templatesSelectTrigger');
  const templatesSelectMenu = document.getElementById('templatesSelectMenu');
  const templatesSelectList = document.getElementById('templatesSelectList');
  const templateNameMenu = document.getElementById('templateNameMenu');
  const templateNameMenuTitle = document.getElementById('templateNameMenuTitle');
  const templateNameInput = document.getElementById('templateNameInput');
  const templateNameSaveBtn = document.getElementById('templateNameSave');
  function renderTemplatesSelect() {
    const active = templates.find(t => t.id === selectedTemplateId) || templates[0];
    const activeName = active ? active.name : 'Templates';
    document.getElementById('templatesSelectName').textContent = activeName;
    const footerLabel = document.getElementById('csFooterTemplateName');
    if (footerLabel) footerLabel.textContent = activeName;
    const canDelete = templates.length > 1;
    templatesSelectList.innerHTML = templates.map(t => {
      const isSelected = t.id === selectedTemplateId;
      return '<div class="pop-item template-item' + (isSelected ? ' selected' : '') + '" data-template-id="' + t.id + '">' +
        '<span class="pop-text"><span class="pt-title">' + escapeHtml(t.name) + '</span></span>' +
        '<span class="template-item-right">' +
        '' +
        '<span class="template-item-actions">' +
        '<button type="button" class="template-action-btn" data-action="rename" data-template-id="' + t.id + '" title="Rename"><span class="material-symbols-outlined">edit</span></button>' +
        '<button type="button" class="template-action-btn danger' + (canDelete ? '' : ' disabled') + '" data-action="delete" data-template-id="' + t.id + '" title="' + (canDelete ? 'Delete' : 'At least one template is required') + '"><span class="material-symbols-outlined">delete</span></button>' +
        '</span>' +
        '</span>' +
        '</div>';
    }).join('');
    templatesSelectList.querySelectorAll('.template-item').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.templateId;
        if (id !== selectedTemplateId) {
          selectedTemplateId = id;
          renderTemplatesSelect();
          const t = templates.find(x => x.id === id);
          showToast('Switched to "' + t.name + '" template', 'style');
        }
        closeAllPopovers();
      });
    });
    templatesSelectList.querySelectorAll('[data-action="rename"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTemplateNamePrompt('rename', btn.dataset.templateId, btn.getBoundingClientRect(), btn);
      });
    });
    templatesSelectList.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (templates.length <= 1) return;
        const id = btn.dataset.templateId;
        const t = templates.find(x => x.id === id);
        templates = templates.filter(x => x.id !== id);
        if (selectedTemplateId === id) selectedTemplateId = templates[0].id;
        renderTemplatesSelect();
        showToast('"' + t.name + '" template deleted', 'delete');
      });
    });
  }
  function openTemplateNamePrompt(mode, targetId, anchorRect, trigger) {
    templateNameMode = mode;
    templateRenameTargetId = targetId;
    if (mode === 'save') {
      templateNameMenuTitle.textContent = 'Save as…';
      templateNameInput.value = '';
      templateNameSaveBtn.textContent = 'Save';
    } else {
      const t = templates.find(x => x.id === targetId);
      templateNameMenuTitle.textContent = 'Rename Template';
      templateNameInput.value = t ? t.name : '';
      templateNameSaveBtn.textContent = 'Rename';
    }
    openNear(templateNameMenu, anchorRect, 'left', trigger);
    templateNameInput.focus();
    templateNameInput.select();
  }
  function closeTemplateNamePrompt() { closeAllPopoversExcept(templatesSelectMenu); }
  function commitTemplateName() {
    const name = templateNameInput.value.trim();
    if (!name) { templateNameInput.focus(); return; }
    if (templateNameMode === 'save') {
      const id = 'tpl' + (templateIdCounter++);
      templates.push({ id, name });
      selectedTemplateId = id;
      showToast('Template "' + name + '" saved', 'bookmark_added');
    } else if (templateNameMode === 'rename') {
      const t = templates.find(x => x.id === templateRenameTargetId);
      if (t) { t.name = name; showToast('Template renamed to "' + name + '"', 'edit'); }
    }
    closeTemplateNamePrompt();
    renderTemplatesSelect();
  }
  renderTemplatesSelect();
  function openTemplatesMenu(anchorRect, trigger) {
    openNear(templatesSelectMenu, anchorRect, 'left', trigger);
  }
  templatesSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openTemplatesMenu(templatesSelectTrigger.getBoundingClientRect(), templatesSelectTrigger);
  });
  const csFooterTemplateTrigger = document.getElementById('csFooterTemplateTrigger');
  if (csFooterTemplateTrigger) {
    csFooterTemplateTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openTemplatesMenu(csFooterTemplateTrigger.getBoundingClientRect(), csFooterTemplateTrigger);
    });
  }
  document.getElementById('templateSaveCurrent').addEventListener('click', (e) => {
    e.stopPropagation();
    openTemplateNamePrompt('save', null, e.currentTarget.getBoundingClientRect(), e.currentTarget);
  });
  document.getElementById('templateApplyDefaults').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
    showToast('Defaults applied', 'restart_alt');
  });
  templateNameSaveBtn.addEventListener('click', (e) => { e.stopPropagation(); commitTemplateName(); });
  document.getElementById('templateNameCancel').addEventListener('click', (e) => { e.stopPropagation(); closeTemplateNamePrompt(); });
  document.getElementById('templateNameMenuClose').addEventListener('click', (e) => { e.stopPropagation(); closeTemplateNamePrompt(); });
  templateNameInput.addEventListener('click', (e) => e.stopPropagation());
  templateNameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitTemplateName(); }
    if (e.key === 'Escape') { e.preventDefault(); closeTemplateNamePrompt(); }
  });

  /* ---------- Chart Settings modal ---------- */
  const csBackdrop = document.getElementById('chartSettingsBackdrop');
  let csDraftSnapshot = null;
  function setCsTab(tab) {
    document.querySelectorAll('.cs-nav-item').forEach(b => b.classList.toggle('active', b.dataset.csTab === tab));
    document.querySelectorAll('.cs-pane').forEach(p => p.classList.toggle('active', p.dataset.csPane === tab));
    document.querySelector('.cs-content').scrollTop = 0;
  }
  document.querySelectorAll('.cs-nav-item').forEach(btn => {
    btn.addEventListener('click', () => setCsTab(btn.dataset.csTab));
  });
  document.getElementById('csSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.cs-nav-item').forEach(b => {
      b.style.display = (!q || b.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
  function csUpdateConditionalFields() {
    document.getElementById('csBeCustomRWrap').style.display = document.getElementById('csBeTrigger').value === 'customR' ? '' : 'none';
    const csTsMethodVal = document.getElementById('csTsMethod').value;
    document.getElementById('csTsDistanceWrap').style.display = csTsMethodVal === 'atr' ? 'none' : '';
    document.getElementById('csTsAtrMultiplierWrap').style.display = csTsMethodVal === 'atr' ? '' : 'none';
    document.getElementById('csTsStartWrap').style.display = csTsMethodVal === 'atr' ? 'none' : '';
    document.getElementById('csTsStartCustomRWrap').style.display = (csTsMethodVal !== 'atr' && document.getElementById('csTsStart').value === 'customR') ? '' : 'none';
    document.getElementById('csTtpDistanceWrap').style.display = document.getElementById('csTtpMethod').value === 'atr' ? 'none' : '';
    document.getElementById('csTtpActivationCustomRWrap').style.display = document.getElementById('csTtpActivation').value === 'customR' ? '' : 'none';
  }
  ['csBeTrigger', 'csTsMethod', 'csTsStart', 'csTtpMethod', 'csTtpActivation'].forEach(id => {
    document.getElementById(id).addEventListener('change', csUpdateConditionalFields);
  });
  /* percentOverride lets a field use a finer min/step/decimals when its unit dropdown is set to "%" —
     ticks/points distances are sensibly whole numbers, but a percent distance needs sub-1 decimals (e.g. 0.5%) */
  function bindCsStepper(prefix, min, max, step, percentOverride) {
    const input = document.getElementById(prefix + 'Value');
    const dec = document.getElementById(prefix + 'Dec');
    const inc = document.getElementById(prefix + 'Inc');
    const unitSelect = document.getElementById(prefix + 'Unit');
    function activeParams() {
      if (percentOverride && unitSelect && unitSelect.value === 'percent') return percentOverride;
      return { min, max, step };
    }
    function clampVal(v) {
      const p = activeParams();
      v = Math.round(v / p.step) * p.step;
      if (Number.isInteger(p.step)) v = Math.round(v); else v = +v.toFixed(2);
      return Math.min(p.max, Math.max(p.min, v));
    }
    input.removeAttribute('readonly');
    input.addEventListener('change', () => { input.value = clampVal(parseFloat(input.value) || 0); });
    dec.addEventListener('click', () => { input.value = clampVal(parseFloat(input.value || '0') - activeParams().step); });
    inc.addEventListener('click', () => { input.value = clampVal(parseFloat(input.value || '0') + activeParams().step); });
  }
  const PERCENT_DISTANCE_STEP = { min: 0.1, max: 50, step: 0.1 };
  bindCsStepper('csBeOffset', 0, 200, 1, PERCENT_DISTANCE_STEP);
  bindCsStepper('csTsDistance', 1, 2000, 5, PERCENT_DISTANCE_STEP);
  bindPlainStepper('csTsAtrMultiplier', 0.1, 20, 0.1);
  bindCsStepper('csTtpDistance', 1, 2000, 5, PERCENT_DISTANCE_STEP);
  function bindPlainStepper(valueId, min, max, step, onChange) {
    const input = document.getElementById(valueId);
    const dec = document.getElementById(valueId + 'Dec');
    const inc = document.getElementById(valueId + 'Inc');
    function clampVal(v) {
      v = Math.round(v / step) * step;
      v = Number.isInteger(step) ? Math.round(v) : +v.toFixed(2);
      return Math.min(max, Math.max(min, v));
    }
    function set(v) { input.value = clampVal(v); if (onChange) onChange(); }
    input.removeAttribute('readonly');
    input.addEventListener('change', () => set(parseFloat(input.value) || 0));
    dec.addEventListener('click', (e) => { e.stopPropagation(); set(parseFloat(input.value || '0') - step); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); set(parseFloat(input.value || '0') + step); });
  }
  bindPlainStepper('csAtrLength', 1, 200, 1);
  bindPlainStepper('csAtrMultiplier', 0.1, 20, 0.1);
  document.querySelectorAll('#chartSettingsBackdrop .cs-checkbox-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      row.querySelector('.chk-box').classList.toggle('checked');
    });
  });

  /* ---------- General / Appearance settings panes (visual only, no persistence) ---------- */
  document.querySelectorAll('#chartSettingsBackdrop .cs-switch-row .ui-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.closest('.cs-switch-row').classList.toggle('active');
    });
  });
  document.querySelectorAll('#chartSettingsBackdrop .cs-radio-group').forEach(group => {
    group.querySelectorAll('.cs-radio-row').forEach(row => {
      row.addEventListener('click', () => {
        group.querySelectorAll('.cs-radio-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
      });
    });
  });
  function bindSimpleSegmented(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.cs-seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        group.querySelectorAll('.cs-seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
  }
  bindSimpleSegmented('csTimeFormatGroup');
  bindSimpleSegmented('csScalePositionGroup');
  bindSimpleSegmented('qtsCrossIsolatedGroup');
  bindSimpleSegmented('qtDisplayModeGroup');
  bindSimpleSegmented('ctCrossIsolatedGroup');
  bindSimpleSegmented('ctDisplayModeGroup');
  bindSimpleSegmented('pdCrossIsolatedGroup');

  /* ---------- Alert email update button ---------- */
  const alertEmailSave = document.getElementById('alertEmailSave');
  if (alertEmailSave) {
    alertEmailSave.addEventListener('click', () => {
      alertEmailSave.textContent = 'Saved!';
      alertEmailSave.classList.add('saved');
      setTimeout(() => {
        alertEmailSave.textContent = 'Update';
        alertEmailSave.classList.remove('saved');
      }, 2000);
    });
  }

  /* ---------- Alert volume slider ---------- */
  const alertVolumeSlider = document.getElementById('alertVolume');
  const alertVolumeValue  = document.getElementById('alertVolumeValue');
  if (alertVolumeSlider && alertVolumeValue) {
    alertVolumeSlider.addEventListener('input', () => {
      alertVolumeValue.textContent = alertVolumeSlider.value + '%';
    });
  }

  /* ---------- Position Defaults: size field tracks the selected sizing method ---------- */
  const PD_SIZE_MODES = {
    contracts: { label: 'Default Contracts', unit: 'contracts', step: 1, default: '1' },
    shares: { label: 'Default Shares', unit: 'shares', step: 1, default: '100' },
    dollar: { label: 'Default Dollar Amount', unit: '$', step: 50, default: '500' },
    pct_equity: { label: 'Default % of Equity', unit: '%', step: 1, default: '5' },
    risk_pct: { label: 'Default Risk %', unit: '%', step: 0.25, default: '1' },
  };
  const pdSizingMethod = document.getElementById('pdSizingMethod');
  const pdDefaultSize = document.getElementById('pdDefaultSize');
  const pdDefaultSizeUnit = document.getElementById('pdDefaultSizeUnit');
  const pdDefaultSizeLabel = document.getElementById('pdDefaultSizeLabel');
  function pdApplySizeMode() {
    const cfg = PD_SIZE_MODES[pdSizingMethod.value] || PD_SIZE_MODES.contracts;
    pdDefaultSizeLabel.textContent = cfg.label;
    pdDefaultSizeUnit.textContent = cfg.unit;
    pdDefaultSize.dataset.step = cfg.step;
    pdDefaultSize.value = cfg.default;
  }
  pdSizingMethod.addEventListener('change', pdApplySizeMode);
  pdApplySizeMode();

  function bindColorSwatchMenu(triggerId, menuId, swatchId) {
    const trigger = document.getElementById(triggerId);
    const menu = document.getElementById(menuId);
    const swatch = document.getElementById(swatchId);
    const nameEl = trigger ? trigger.querySelector('.cs-color-name') : null;
    if (!trigger || !menu || !swatch) return;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openNear(menu, trigger.getBoundingClientRect(), 'right', trigger);
    });
    menu.querySelectorAll('.pop-item').forEach(item => {
      item.addEventListener('click', () => {
        menu.querySelectorAll('.pop-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        swatch.style.background = item.dataset.color;
        if (nameEl) nameEl.textContent = item.querySelector('.pt-title')?.textContent || '';
        closeAllPopovers();
      });
    });
  }
  bindColorSwatchMenu('csBullColorTrigger', 'csBullColorMenu', 'csBullColorSwatch');
  bindColorSwatchMenu('csBearColorTrigger', 'csBearColorMenu', 'csBearColorSwatch');

  function csUpdateTargetTableVisibility() {
    const mode = document.querySelector('#csDisplayModeGroup .cs-seg-btn.active').dataset.mode;
    document.getElementById('csTargetTableWrap').style.display = mode === 'expanded' ? '' : 'none';
  }
  document.querySelectorAll('#csDisplayModeGroup .cs-seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#csDisplayModeGroup .cs-seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      csUpdateTargetTableVisibility();
    });
  });
  /* ---------- default targets / stop loss table (Expanded mode entry defaults) ---------- */
  let csTargetsDraft = [];
  let csSlDraft = null;
  const CS_MAX_TARGETS = 5;
  function renderTargetsTable() {
    const rowsEl = document.getElementById('csTargetRows');
    /* layout top-to-bottom: [Add TP] -> highest TP ... TP1 -> SL row or [Add SL] -- new rows land exactly where their add button was */
    let html = csTargetsDraft.length < CS_MAX_TARGETS
      ? '<button type="button" class="cs-add-target-btn tp" id="csAddTpBtn"><span class="material-symbols-outlined">add</span>Add TP</button>'
      : '';
    for (let i = csTargetsDraft.length - 1; i >= 0; i--) {
      const t = csTargetsDraft[i];
      html +=
        '<div class="cs-target-row" data-idx="' + i + '">' +
        '<span class="cs-target-label tp">TP' + (i + 1) + '</span>' +
        '<input type="text" class="cs-target-input" data-field="pct" value="' + t.pct + '%">' +
        '<input type="text" class="cs-target-input" data-field="r" value="' + t.r.toFixed(1) + 'R">' +
        '<div class="select-input pop-trigger cs-dd-trigger" data-target="csTargetType' + i + '"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div>' +
        '<select id="csTargetType' + i + '" data-field="type" style="display:none;">' +
        '<option value="limit"' + (t.type === 'limit' ? ' selected' : '') + '>Limit</option>' +
        '<option value="market"' + (t.type === 'market' ? ' selected' : '') + '>Market</option>' +
        '</select>' +
        '<button type="button" class="cs-target-del" data-idx="' + i + '"><span class="material-symbols-outlined">delete</span></button>' +
        '</div>';
    }
    if (csSlDraft) {
      html += '<div class="cs-target-row">' +
        '<span class="cs-target-label sl">SL</span>' +
        '<input type="text" class="cs-target-input" value="100%" disabled>' +
        '<input type="text" class="cs-target-input" id="csSlDraftR" value="' + csSlDraft.r.toFixed(1) + 'R">' +
        '<div class="select-input pop-trigger cs-dd-trigger" data-target="csSlDraftType"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div><select id="csSlDraftType" style="display:none;">' +
        '<option value="stopMarket"' + (csSlDraft.type === 'stopMarket' ? ' selected' : '') + '>Stop Market</option>' +
        '<option value="stopLimit"' + (csSlDraft.type === 'stopLimit' ? ' selected' : '') + '>Stop Limit</option>' +
        '</select>' +
        '<button type="button" class="cs-target-del" id="csSlDraftDel"><span class="material-symbols-outlined">delete</span></button>' +
        '</div>';
    } else {
      html += '<button type="button" class="cs-add-target-btn sl" id="csAddSlBtn"><span class="material-symbols-outlined">add</span>Add SL</button>';
    }
    rowsEl.innerHTML = html;
    refreshAllCsDropdownLabels(rowsEl);
    rowsEl.querySelectorAll('.cs-target-row[data-idx]').forEach(row => {
      const idx = parseInt(row.dataset.idx);
      row.querySelector('[data-field="pct"]').addEventListener('change', (e) => { csTargetsDraft[idx].pct = parseFloat(e.target.value) || 0; e.target.value = csTargetsDraft[idx].pct + '%'; });
      row.querySelector('[data-field="r"]').addEventListener('change', (e) => { csTargetsDraft[idx].r = parseFloat(e.target.value) || 0; e.target.value = csTargetsDraft[idx].r.toFixed(1) + 'R'; });
      row.querySelector('[data-field="type"]').addEventListener('change', (e) => { csTargetsDraft[idx].type = e.target.value; });
    });
    rowsEl.querySelectorAll('.cs-target-del[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => { csTargetsDraft.splice(parseInt(btn.dataset.idx), 1); renderTargetsTable(); });
    });
    const slR = document.getElementById('csSlDraftR');
    if (slR) slR.addEventListener('change', (e) => { csSlDraft.r = parseFloat(e.target.value) || 0; e.target.value = csSlDraft.r.toFixed(1) + 'R'; });
    const slType = document.getElementById('csSlDraftType');
    if (slType) slType.addEventListener('change', (e) => { csSlDraft.type = e.target.value; });
    const slDel = document.getElementById('csSlDraftDel');
    if (slDel) slDel.addEventListener('click', () => { csSlDraft = null; renderTargetsTable(); });
    const addTpBtn = document.getElementById('csAddTpBtn');
    if (addTpBtn) addTpBtn.addEventListener('click', () => {
      const maxR = csTargetsDraft.reduce((m, t) => Math.max(m, t.r), 0);
      csTargetsDraft.push({ pct: 0, r: Math.round((maxR + 1) * 10) / 10, type: 'limit' });
      renderTargetsTable();
    });
    const addSlBtn = document.getElementById('csAddSlBtn');
    if (addSlBtn) addSlBtn.addEventListener('click', () => {
      csSlDraft = { r: 1.0, type: 'stopMarket' };
      renderTargetsTable();
    });
  }
  function populateChartSettingsForm() {
    const s = chartSettings;
    document.getElementById('csBeTrigger').value = s.moveSlToBreakeven.trigger;
    document.getElementById('csBeCustomRValue').value = s.moveSlToBreakeven.customR;
    document.getElementById('csBeOffsetValue').value = s.moveSlToBreakeven.offsetValue;
    document.getElementById('csBeOffsetUnit').value = s.moveSlToBreakeven.offsetUnit;

    document.getElementById('csTsMethod').value = s.trailingStop.method;
    document.getElementById('csTsDistanceValue').value = s.trailingStop.distanceValue;
    document.getElementById('csTsDistanceUnit').value = s.trailingStop.distanceUnit;
    document.getElementById('csTsAtrMultiplier').value = s.trailingStop.atrMultiplier !== undefined ? s.trailingStop.atrMultiplier : 2.0;
    document.getElementById('csTsStart').value = s.trailingStop.start;
    document.getElementById('csTsStartCustomRValue').value = s.trailingStop.startCustomR;

    document.getElementById('csAtrLength').value = s.atrStop.length;
    document.getElementById('csAtrMultiplier').value = s.atrStop.multiplier;
    document.getElementById('csAtrTimeframe').value = s.atrStop.timeframe;
    document.getElementById('csAtrUpdateFreq').value = s.atrStop.updateFreq;
    document.getElementById('csAtrDynamic').classList.toggle('checked', s.atrStop.dynamic);

    document.getElementById('csTtpActivation').value = s.trailingTp.activation;
    document.getElementById('csTtpActivationCustomRValue').value = s.trailingTp.activationCustomR;
    document.getElementById('csTtpMethod').value = s.trailingTp.method;
    document.getElementById('csTtpDistanceValue').value = s.trailingTp.distanceValue;
    document.getElementById('csTtpDistanceUnit').value = s.trailingTp.distanceUnit;

    document.querySelectorAll('#csDisplayModeGroup .cs-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === s.tpSlDisplayMode));
    csTargetsDraft = JSON.parse(JSON.stringify(s.defaultTargets || []));
    csSlDraft = s.defaultStopLoss ? JSON.parse(JSON.stringify(s.defaultStopLoss)) : null;
    renderTargetsTable();
    csUpdateTargetTableVisibility();

    document.getElementById('csGbCancelOnClose').classList.toggle('checked', s.globalBehavior.cancelOnManualClose);
    document.getElementById('csGbRecalc').classList.toggle('checked', s.globalBehavior.recalcOnSizeChange);
    document.getElementById('csGbPersist').classList.toggle('checked', s.globalBehavior.persist);

    csUpdateConditionalFields();
    refreshAllCsDropdownLabels(document.getElementById('chartSettingsBackdrop'));
  }
  function collectChartSettingsForm() {
    chartSettings = {
      tpSlDisplayMode: document.querySelector('#csDisplayModeGroup .cs-seg-btn.active').dataset.mode,
      defaultProfile: chartSettings.defaultProfile,
      defaultTargets: csTargetsDraft,
      defaultStopLoss: csSlDraft,
      moveSlToBreakeven: {
        trigger: document.getElementById('csBeTrigger').value,
        customR: parseFloat(document.getElementById('csBeCustomRValue').value) || 1,
        offsetValue: parseFloat(document.getElementById('csBeOffsetValue').value) || 0,
        offsetUnit: document.getElementById('csBeOffsetUnit').value,
      },
      trailingStop: {
        method: document.getElementById('csTsMethod').value,
        distanceValue: parseFloat(document.getElementById('csTsDistanceValue').value) || 1,
        distanceUnit: document.getElementById('csTsDistanceUnit').value,
        atrMultiplier: parseFloat(document.getElementById('csTsAtrMultiplier').value) || 2.0,
        start: document.getElementById('csTsStart').value,
        startCustomR: parseFloat(document.getElementById('csTsStartCustomRValue').value) || 1,
      },
      atrStop: {
        length: parseInt(document.getElementById('csAtrLength').value) || 14,
        multiplier: parseFloat(document.getElementById('csAtrMultiplier').value) || 2,
        timeframe: document.getElementById('csAtrTimeframe').value,
        updateFreq: document.getElementById('csAtrUpdateFreq').value,
        dynamic: document.getElementById('csAtrDynamic').classList.contains('checked'),
      },
      trailingTp: {
        activation: document.getElementById('csTtpActivation').value,
        activationCustomR: parseFloat(document.getElementById('csTtpActivationCustomRValue').value) || 1,
        method: document.getElementById('csTtpMethod').value,
        distanceValue: parseFloat(document.getElementById('csTtpDistanceValue').value) || 1,
        distanceUnit: document.getElementById('csTtpDistanceUnit').value,
      },
      globalBehavior: {
        cancelOnManualClose: document.getElementById('csGbCancelOnClose').classList.contains('checked'),
        recalcOnSizeChange: document.getElementById('csGbRecalc').classList.contains('checked'),
        persist: document.getElementById('csGbPersist').classList.contains('checked'),
      }
    };
    persistChartSettingsIfEnabled();
  }
  const csSaveBtn = document.getElementById('csSaveBtn');
  function csMarkSaved() {
    csSaveBtn.textContent = 'Saved';
    csSaveBtn.classList.add('saved');
  }
  function csMarkUnsaved() {
    if (!csSaveBtn.classList.contains('saved')) return;
    csSaveBtn.textContent = 'Save Settings';
    csSaveBtn.classList.remove('saved');
  }
  function openChartSettings(initialTab) {
    csDraftSnapshot = JSON.stringify(chartSettings);
    populateChartSettingsForm();
    setCsTab(initialTab || 'general');
    closeAllPopovers();
    csMarkUnsaved();
    csBackdrop.classList.add('show');
  }
  function closeChartSettings(commit) {
    if (!commit && csDraftSnapshot) { chartSettings = JSON.parse(csDraftSnapshot); }
    csDraftSnapshot = null;
    csBackdrop.classList.remove('show');
  }
  csSaveBtn.addEventListener('click', () => {
    collectChartSettingsForm();
    csDraftSnapshot = JSON.stringify(chartSettings);
    showToast('Settings saved', 'check_circle');
    closeChartSettings(true);
  });
  document.getElementById('csCancelBtn').addEventListener('click', () => closeChartSettings(false));
  document.getElementById('csCloseBtn').addEventListener('click', () => closeChartSettings(false));
  csBackdrop.addEventListener('click', (e) => { if (e.target === csBackdrop) closeChartSettings(false); });
  csBackdrop.addEventListener('click', (e) => {
    if (e.target.closest('#csSaveBtn, #csCancelBtn, #csCloseBtn, .cs-nav-item, .cs-search')) return;
    csMarkUnsaved();
  });
  csBackdrop.addEventListener('input', csMarkUnsaved);
  document.getElementById('csResetBtn').addEventListener('click', () => {
    chartSettings = cloneCsDefaults();
    populateChartSettingsForm();
    showToast('Reset to defaults', 'restart_alt');
  });

  /* ---------- layout picker (topbar) ---------- */
  const chartPaneArea = document.getElementById('chartPaneArea');

  const LAYOUT_CSS = {
    'Single':     '',
    '2 Columns':  'layout-2col',
    '2 Rows':     'layout-2row',
    '4 Grid':     'layout-4grid',
    'Large + 2':  'layout-large2',
    '2 + Large':  'layout-2large',
    '3 Columns':  'layout-3col',
    'Top + 2':    'layout-top2',
    '2 + Bottom': 'layout-2bottom',
  };
  const LAYOUT_PANES = {
    'Single': 1, '2 Columns': 2, '2 Rows': 2, '4 Grid': 4,
    'Large + 2': 3, '2 + Large': 3, '3 Columns': 3,
    'Top + 2': 3, '2 + Bottom': 3,
  };

  function applyLayout(name) {
    chartPaneArea.querySelectorAll('.chart-pane.secondary').forEach(p => p.remove());
    secondaryPanes = [];
    chartPaneArea.className = 'chart-pane-area' + (LAYOUT_CSS[name] ? ' ' + LAYOUT_CSS[name] : '');
    const paneCount = LAYOUT_PANES[name] || 1;
    for (let i = 1; i < paneCount; i++) {
      const pane = document.createElement('div');
      pane.className = 'chart-pane secondary';
      const canvas = document.createElement('canvas');
      const label = document.createElement('div');
      label.className = 'chart-pane-label';
      label.textContent = 'ETHUSD · 15m';
      pane.appendChild(canvas);
      pane.appendChild(label);
      chartPaneArea.appendChild(pane);
      secondaryPanes.push({ canvas, container: pane });
      new ResizeObserver(scheduleDrawPriceChart).observe(pane);
    }
    scheduleDrawPriceChart();
  }

  const layoutPickerTrigger = document.getElementById('layoutPickerTrigger');
  const layoutPickerMenu = document.getElementById('layoutPickerMenu');
  layoutPickerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openNear(layoutPickerMenu, layoutPickerTrigger.getBoundingClientRect(), 'left', layoutPickerTrigger);
  });
  layoutPickerMenu.querySelectorAll('.layout-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      layoutPickerMenu.querySelectorAll('.layout-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      applyLayout(opt.dataset.layout);
      closeAllPopovers();
    });
  });

  /* ---------- candle type dropdown (topbar) ---------- */
  const candleTypeTrigger = document.getElementById('candleTypeTrigger');
  const candleTypeMenu = document.getElementById('candleTypeMenu');
  const candleTypeLabel = document.getElementById('candleTypeLabel');
  candleTypeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openNear(candleTypeMenu, candleTypeTrigger.getBoundingClientRect(), 'left', candleTypeTrigger);
  });
  candleTypeMenu.querySelectorAll('.pop-item[data-candle]').forEach(it => {
    it.addEventListener('click', () => {
      candleTypeMenu.querySelectorAll('.pop-item[data-candle]').forEach(i => i.classList.remove('selected'));
      it.classList.add('selected');
      candleTypeLabel.textContent = it.dataset.candle;
      closeAllPopovers();
      showToast('Candle type set to ' + it.dataset.candle, 'candlestick_chart');
    });
  });

  /* ---------- timeframe group (5 quick buttons + "more" dropdown) ---------- */
  (function () {
    const tfGroup = document.getElementById('tfGroup');
    const tfMoreTrigger = document.getElementById('tfMoreTrigger');
    const tfMoreMenu = document.getElementById('tfMoreMenu');
    const tfMoreLabel = document.getElementById('tfMoreLabel');
    const tfMenuDivider = document.getElementById('tfMenuDivider');
    const tfAddCustomBtn = document.getElementById('tfAddCustomBtn');
    const tfCustomForm = document.getElementById('tfCustomForm');
    const tfCustomType = document.getElementById('tfCustomType');
    const tfCustomInterval = document.getElementById('tfCustomInterval');
    const tfCustomError = document.getElementById('tfCustomError');
    const tfCustomCancel = document.getElementById('tfCustomCancel');
    const tfCustomAdd = document.getElementById('tfCustomAdd');

    function selectTimeframe(tf, fromMenuItem) {
      tfGroup.querySelectorAll('.tf-btn[data-tf]').forEach(b => b.classList.remove('active'));
      tfMoreMenu.querySelectorAll('.pop-item[data-tf]').forEach(b => b.classList.remove('selected'));
      if (fromMenuItem) {
        tfMoreTrigger.classList.add('active');
        tfMoreLabel.textContent = tf;
        fromMenuItem.classList.add('selected');
      } else {
        tfMoreTrigger.classList.remove('active');
        tfMoreLabel.textContent = '';
        const btn = tfGroup.querySelector('.tf-btn[data-tf="' + tf + '"]');
        if (btn) btn.classList.add('active');
      }
    }
    tfGroup.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
      btn.addEventListener('click', () => selectTimeframe(btn.dataset.tf, null));
    });
    tfMoreTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = tfMoreMenu.classList.contains('show');
      openNear(tfMoreMenu, tfMoreTrigger.getBoundingClientRect(), 'left', tfMoreTrigger);
      if (!wasOpen) showCustomForm(false);
    });

    function bindMenuItem(item) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTimeframe(item.dataset.tf, item);
        closeAllPopovers();
      });
    }
    tfMoreMenu.querySelectorAll('.pop-item[data-tf]').forEach(bindMenuItem);

    /* ---------- custom timeframe creation ---------- */
    function timeframeExists(code) {
      return !!tfGroup.querySelector('.tf-btn[data-tf="' + code + '"]') ||
        !!tfMoreMenu.querySelector('.pop-item[data-tf="' + code + '"]');
    }
    function buildCustomCode(type, n) {
      switch (type) {
        case 'minutes': return n + 'm';
        case 'hours': return n + 'h';
        case 'days': return n === 1 ? 'D' : n + 'D';
        case 'weeks': return n === 1 ? 'W' : n + 'W';
        case 'months': return n === 1 ? 'M' : n + 'M';
        case 'range': return n + 'R';
        default: return String(n);
      }
    }
    function showCustomForm(show) {
      tfCustomForm.style.display = show ? 'block' : 'none';
      tfCustomError.style.display = 'none';
      if (show) {
        tfCustomInterval.value = '';
        positionPopover(tfMoreMenu, tfMoreTrigger.getBoundingClientRect(), 'left');
        tfCustomInterval.focus();
      }
    }
    /* Convert a timeframe code to a numeric sort key (in seconds) */
    function tfSortKey(code) {
      const match = code.match(/^(\d*)([mhDWMYR])$/);
      if (!match) return Infinity;
      const n = parseInt(match[1] || '1', 10);
      const multipliers = { m: 60, h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000, R: 1 };
      return n * (multipliers[match[2]] ?? Infinity);
    }
    function insertMenuItemSorted(item) {
      const newKey = tfSortKey(item.dataset.tf);
      const existing = [...tfMoreMenu.querySelectorAll('.pop-item[data-tf]')];
      const insertBefore = existing.find(el => tfSortKey(el.dataset.tf) > newKey);
      tfMoreMenu.insertBefore(item, insertBefore ?? tfMenuDivider);
    }

    function commitCustomTimeframe() {
      const n = parseInt(tfCustomInterval.value, 10);
      if (!n || n < 1) { tfCustomInterval.focus(); return; }
      const code = buildCustomCode(tfCustomType.value, n);
      if (timeframeExists(code)) {
        tfCustomError.textContent = 'Interval already exists, please use a different value';
        tfCustomError.style.display = 'block';
        positionPopover(tfMoreMenu, tfMoreTrigger.getBoundingClientRect(), 'left');
        tfCustomInterval.focus();
        return;
      }
      const item = document.createElement('button');
      item.className = 'pop-item';
      item.dataset.tf = code;
      item.textContent = code;
      insertMenuItemSorted(item);
      bindMenuItem(item);
      showCustomForm(false);
      selectTimeframe(code, item);
      closeAllPopovers();
      showToast('Custom timeframe "' + code + '" added', 'add_circle');
    }

    tfAddCustomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCustomForm(tfCustomForm.style.display !== 'block');
    });
    tfCustomCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      showCustomForm(false);
    });
    tfCustomAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      commitCustomTimeframe();
    });
    tfCustomType.addEventListener('change', () => { tfCustomError.style.display = 'none'; });
    tfCustomInterval.addEventListener('click', (e) => e.stopPropagation());
    tfCustomInterval.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitCustomTimeframe(); }
      if (e.key === 'Escape') { e.preventDefault(); showCustomForm(false); }
    });
  })();

  /* ---------- symbol selector dropdown ---------- */
  const SYMBOL_LIST = [
    ...['ETHUSD', 'BTCUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD', 'DOGEUSD', 'ADAUSD', 'AVAXUSD', 'LINKUSD', 'MATICUSD',
      'LTCUSD', 'DOTUSD', 'TRXUSD', 'ATOMUSD', 'NEARUSD', 'UNIUSD', 'FILUSD', 'APTUSD', 'ARBUSD', 'OPUSD',
      'SUIUSD', 'ICPUSD', 'ETCUSD'].map(sym => ({ sym, cat: 'crypto' })),
    ...['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'JPM',
      'BAC', 'DIS', 'KO', 'PEP', 'WMT', 'V', 'MA', 'XOM', 'CVX', 'INTC',
      'ORCL', 'CRM', 'ADBE'].map(sym => ({ sym, cat: 'stocks' })),
    ...['NQU5', 'ESU5', 'YMU5', 'RTYU5', 'CLN5', 'GCQ5', 'SIN5', 'ZBU5', 'ZNU5', 'ZCU5',
      'HGU5', 'NGU5', 'PLU5', 'KCU5', 'ZSU5', 'ZWU5', '6BU5'].map(sym => ({ sym, cat: 'futures' })),
    ...['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'USDCHF', 'EURGBP', 'EURJPY', 'GBPJPY',
      'USDTRY', 'USDMXN', 'USDZAR', 'EURCHF', 'AUDJPY', 'CHFJPY', 'EURAUD'].map(sym => ({ sym, cat: 'forex' })),
  ];
  const symSelectTrigger = document.getElementById('symSelectTrigger');
  const symSelectMenu = document.getElementById('symSelectMenu');
  const symSelectSearch = document.getElementById('symSelectSearch');
  const symSelectList = document.getElementById('symSelectList');
  const symSelectLabel = document.getElementById('symSelectLabel');
  const symSelectTabs = document.querySelectorAll('#symSelectTabs .wl-tab');
  let symSelectCat = 'all';
  /* cosmetic symbol switch — relabels the topbar/watchlist without loading new chart data */
  function switchSymbol(sym) {
    symSelectLabel.textContent = sym;
    document.querySelectorAll('.wl-row.selected').forEach(r => r.classList.remove('selected'));
    const wlRow = document.querySelector('.wl-row[data-sym="' + sym + '"]');
    if (wlRow) wlRow.classList.add('selected');
    showToast('Switched to ' + sym, 'sync_alt');
  }
  function renderSymSelectList(filter) {
    const q = (filter || '').trim().toUpperCase();
    const items = SYMBOL_LIST.filter(s => (symSelectCat === 'all' || s.cat === symSelectCat) && (!q || s.sym.includes(q)));
    symSelectList.innerHTML = items.length
      ? items.map(s => '<button class="sym-select-item" data-sym="' + s.sym + '">' + s.sym + '</button>').join('')
      : '<div class="sym-select-empty">No symbols found</div>';
    symSelectList.querySelectorAll('.sym-select-item').forEach(it => {
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        switchSymbol(it.dataset.sym);
        closeAllPopovers();
      });
    });
  }
  if (symSelectTrigger) symSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (symSelectMenu.classList.contains('show') && symSelectMenu._openTrigger === symSelectTrigger) {
      closeAllPopovers();
      return;
    }
    openNear(symSelectMenu, symSelectTrigger.getBoundingClientRect(), 'left', symSelectTrigger);
    symSelectSearch.value = '';
    renderSymSelectList('');
    symSelectSearch.focus();
  });
  symSelectSearch.addEventListener('input', () => renderSymSelectList(symSelectSearch.value));
  symSelectSearch.addEventListener('click', (e) => e.stopPropagation());
  symSelectTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      symSelectTabs.forEach(t => t.classList.toggle('active', t === tab));
      symSelectCat = tab.dataset.cat;
      renderSymSelectList(symSelectSearch.value);
    });
  });

  /* ---------- indicators modal ---------- */
  const indicatorsTrigger = document.getElementById('indicatorsTrigger');
  const indicatorsMenu = document.getElementById('indicatorsMenu');
  const indicatorsCount = document.getElementById('indicatorsCount');
  const indicatorSearch = document.getElementById('indicatorSearch');
  const indicatorSearchClear = document.getElementById('indicatorSearchClear');
  const indicatorList = document.getElementById('indicatorList');
  const indEmpty = document.getElementById('indEmpty');
  const indEmptyIcon = document.getElementById('indEmptyIcon');
  const indEmptyText = document.getElementById('indEmptyText');
  const indActiveLabel = document.getElementById('indActiveLabel');
  const indActiveOnlyToggle = document.getElementById('indActiveOnlyToggle');
  const indActiveOnlyCheck = document.getElementById('indActiveOnlyCheck');
  const indPremiumList = document.getElementById('indPremiumList');
  const indPremiumEmpty = document.getElementById('indPremiumEmpty');
  const indPremiumEmptyIcon = document.getElementById('indPremiumEmptyIcon');
  const indPremiumEmptyText = document.getElementById('indPremiumEmptyText');
  const indProLockOverlay = document.getElementById('indProLockOverlay');
  const indGetProBtn = document.getElementById('indGetProBtn');

  const IND_DATA = [
    { name: 'Moving Average', desc: 'Smooths price to show overall trend direction.', cat: 'classic' },
    { name: 'EMA', desc: 'Faster moving average that reacts quicker to price.', cat: 'classic' },
    { name: 'SMA', desc: 'Simple average price over a selected period.', cat: 'classic' },
    { name: 'VWAP', desc: 'Shows average price weighted by volume.', cat: 'classic' },
    { name: 'RSI', desc: 'Measures overbought and oversold momentum.', cat: 'classic' },
    { name: 'Stochastic RSI', desc: 'More sensitive RSI for spotting momentum extremes.', cat: 'classic' },
    { name: 'MACD', desc: 'Shows trend momentum and possible trend shifts.', cat: 'classic' },
    { name: 'Bollinger Bands', desc: 'Shows volatility and price expansion or contraction.', cat: 'classic' },
    { name: 'ATR', desc: 'Measures market volatility and average price range.', cat: 'classic' },
    { name: 'Volume', desc: 'Shows how much trading activity is happening.', cat: 'classic' },
    { name: 'Volume Profile', desc: 'Shows where most trading volume occurred by price.', cat: 'classic' },
    { name: 'Support & Resistance', desc: 'Marks key levels where price may react.', cat: 'classic' },
    { name: 'Pivot Points', desc: 'Pre-calculated support and resistance levels.', cat: 'classic' },
    { name: 'Supertrend', desc: 'Trend-following indicator for direction and trailing stops.', cat: 'classic' },
    { name: 'Ichimoku Cloud', desc: 'Shows trend, momentum, support, and resistance.', cat: 'classic' },
    { name: 'Parabolic SAR', desc: 'Helps identify trend direction and possible reversals.', cat: 'classic' },
    { name: 'ADX', desc: 'Measures trend strength, not direction.', cat: 'classic' },
    { name: 'CCI', desc: 'Finds momentum extremes and potential reversals.', cat: 'classic' },
    { name: 'Williams %R', desc: 'Shows overbought and oversold conditions.', cat: 'classic' },
    { name: 'Fibonacci Retracement', desc: 'Highlights possible pullback and reaction zones.', cat: 'classic' },

    { name: 'Large Lot / Block Trade Detector', desc: 'Highlights unusually large executed trades that may indicate institutional participation.', cat: 'l1' },
    { name: 'Aggressive Order Flow', desc: 'Measures whether buyers or sellers are controlling the tape through sustained market orders.', cat: 'l1' },
    { name: 'Smart Volume Spike Detector', desc: 'Detects abnormal volume and classifies whether it supports continuation, exhaustion, absorption, liquidation, or a fake breakout.', cat: 'l1' },

    { name: 'Limit Order Heatmap', desc: 'Shows resting bid/ask liquidity to identify support, resistance, liquidity walls, and breakout zones.', cat: 'l2' },
    { name: 'Iceberg Detector', desc: 'Detects hidden or refreshing institutional orders.', cat: 'l2' },
    { name: 'Spoofing Detector', desc: 'Detects large fake orders intended to influence price before being canceled.', cat: 'l2' },
    { name: 'Liquidity Vacuum', desc: 'Identifies thin liquidity zones where price can move rapidly.', cat: 'l2' },
    { name: 'Liquidation Heatmap', desc: 'Shows estimated liquidation zones where leveraged traders may be forced to buy or sell.', cat: 'l2' },
    { name: 'Open Interest Analysis', desc: 'Shows whether new money is entering or leaving the market and helps classify move participation.', cat: 'l2' },
    { name: 'Institutional Order Blocks', desc: 'Identifies high-probability institutional buying and selling zones by combining order flow and liquidity signals.', cat: 'l2' },
    { name: 'Absorption Detector', desc: 'Detects aggressive buying or selling being absorbed by large passive orders.', cat: 'l2' },
    { name: 'Trap Detector', desc: 'Detects failed breakouts or breakdowns where traders become trapped.', cat: 'l2' },
    { name: 'Exhaustion Detector', desc: 'Detects when aggressive buying or selling stops moving price efficiently.', cat: 'l2' },
    { name: 'Smart Liquidity Sweep Detector', desc: 'Detects liquidity sweeps and determines whether the move is likely reversal or breakout continuation.', cat: 'l2' },
    { name: 'Delta Divergence Signal', desc: 'Detects when price and aggressive buying/selling pressure diverge, warning that momentum may be weakening.', cat: 'l2' },

    { name: 'Market Oracle', desc: 'A trend and signal toolkit that helps traders act with more clarity as price moves.', cat: 'chartprime' },
    { name: 'Market Dynamics', desc: 'A liquidity and structure toolkit that maps reaction zones, breakouts, gaps, and institutional areas in real time.', cat: 'chartprime' },
    { name: 'Prime Oscillators', desc: 'A momentum toolkit that shows when momentum is building, fading, or flipping.', cat: 'chartprime' },
    { name: 'Prime Screener', desc: 'An on-chart dashboard for scanning different assets and spotting opportunities at a glance.', cat: 'chartprime' },
  ];

  const CAT_LABELS = { classic: 'Classic Indicators', l1: 'Trade Flow Intelligence (L1)', l2: 'Order Book Intelligence (L2)', chartprime: 'ChartPrime' };
  const FLAGSHIP_CATS = ['l1', 'l2'];
  const indState = new Map(IND_DATA.map(d => [d.name, false]));

  let indShowActiveOnly = false;
  let indProUnlocked = false;

  function buildIndRow(d, isFlagship) {
    const row = document.createElement('div');
    row.className = 'ind-row' + (indState.get(d.name) ? ' active' : '') + (isFlagship ? ' flagship' : '');
    row.dataset.name = d.name;
    const flagshipBadge = isFlagship ? '<span class="ind-pro-badge">PRO</span>' : '';
    row.innerHTML = `<div class="ind-row-info"><span class="ind-row-name">${d.name}${flagshipBadge}</span><span class="ind-row-desc">${d.desc}</span></div><button class="ui-toggle" aria-label="Toggle ${d.name}"><span class="ui-toggle-track"><span class="ui-toggle-thumb"></span></span></button>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isFlagship && !indProUnlocked) { showIndLockOverlay(); return; }
      const on = !indState.get(d.name);
      indState.set(d.name, on);
      updateIndicatorsCount();
      showToast(d.name + (on ? ' enabled' : ' disabled'), 'function');
      if (indShowActiveOnly) {
        renderIndList(getIndSearch(), indActiveCat);
      } else {
        row.classList.toggle('active', on);
      }
    });
    return row;
  }

  function renderIndLeftPane(query, cat) {
    indicatorList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    const showCat = cat === 'all' ? null : cat;
    let anyVisible = false;
    const groups = showCat ? [showCat] : ['classic', 'chartprime'];
    groups.forEach(g => {
      const rows = IND_DATA.filter(d => {
        if (d.cat !== g) return false;
        if (indShowActiveOnly && !indState.get(d.name)) return false;
        if (q && !d.name.toLowerCase().includes(q) && !d.desc.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!rows.length) return;
      anyVisible = true;
      if (!showCat) {
        const lbl = document.createElement('div');
        lbl.className = 'ind-group-label';
        lbl.textContent = CAT_LABELS[g];
        indicatorList.appendChild(lbl);
      }
      rows.forEach(d => indicatorList.appendChild(buildIndRow(d, false)));
    });
    const noActiveYet = indShowActiveOnly && !q && !anyVisible;
    indEmptyIcon.textContent = noActiveYet ? 'toggle_off' : 'search_off';
    indEmptyText.textContent = noActiveYet ? 'No active indicators yet' : 'No indicators match your search';
    indEmpty.style.display = anyVisible ? 'none' : 'flex';
  }

  function renderIndRightPane(query, cats) {
    indPremiumList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    let anyVisible = false;
    cats.forEach(g => {
      const rows = IND_DATA.filter(d => {
        if (d.cat !== g) return false;
        if (indShowActiveOnly && !indState.get(d.name)) return false;
        if (q && !d.name.toLowerCase().includes(q) && !d.desc.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!rows.length) return;
      anyVisible = true;
      const lbl = document.createElement('div');
      lbl.className = 'ind-group-label flagship';
      lbl.textContent = CAT_LABELS[g];
      indPremiumList.appendChild(lbl);
      rows.forEach(d => indPremiumList.appendChild(buildIndRow(d, true)));
    });
    const noActiveYet = indShowActiveOnly && !q && !anyVisible;
    indPremiumEmptyIcon.textContent = noActiveYet ? 'toggle_off' : 'search_off';
    indPremiumEmptyText.textContent = noActiveYet ? 'No active indicators yet' : 'No indicators match your search';
    indPremiumEmpty.style.display = anyVisible ? 'none' : 'flex';
  }

  const indPanes = document.querySelector('.ind-panes');
  function renderIndList(query, cat) {
    hideIndLockOverlay();
    const isAll = cat === 'all';
    const isFlagshipCat = FLAGSHIP_CATS.includes(cat);
    indPanes.classList.toggle('show-left-only', !isAll && !isFlagshipCat);
    indPanes.classList.toggle('show-right-only', !isAll && isFlagshipCat);
    if (isAll || !isFlagshipCat) renderIndLeftPane(query, cat);
    if (isAll || isFlagshipCat) renderIndRightPane(query, isAll ? FLAGSHIP_CATS : [cat]);
  }

  /* the lock overlay starts hidden so users can see the real ChartPrime Intelligence
     indicators behind it — it only appears when they try to activate one while locked */
  function showIndLockOverlay() { indProLockOverlay.classList.remove('hidden'); }
  function hideIndLockOverlay() { indProLockOverlay.classList.add('hidden'); }
  hideIndLockOverlay();
  indProLockOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.ind-lock-card')) return;
    hideIndLockOverlay();
  });

  indGetProBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    indProLockOverlay.classList.add('removing');
    setTimeout(() => {
      indProUnlocked = true;
      hideIndLockOverlay();
      indProLockOverlay.classList.remove('removing');
      showToast('Pro unlocked — ChartPrime Intelligence™ is now active', 'workspace_premium');
    }, 200);
  });

  function updateIndicatorsCount() {
    const n = [...indState.values()].filter(Boolean).length;
    indicatorsCount.style.display = n > 0 ? 'inline-flex' : 'none';
    indicatorsCount.textContent = n;
    indActiveLabel.textContent = n + ' active';
  }

  let indActiveCat = 'all';
  function getIndSearch() { return indicatorSearch.value; }

  indActiveOnlyToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    indShowActiveOnly = !indShowActiveOnly;
    indActiveOnlyCheck.classList.toggle('checked', indShowActiveOnly);
    indActiveOnlyToggle.classList.toggle('on', indShowActiveOnly);
    renderIndList(getIndSearch(), indActiveCat);
  });

  indicatorsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (indicatorsMenu.classList.contains('show') && indicatorsMenu._openTrigger === indicatorsTrigger) {
      closeAllPopovers(); return;
    }
    renderIndList(getIndSearch(), indActiveCat);
    openNear(indicatorsMenu, indicatorsTrigger.getBoundingClientRect(), 'left', indicatorsTrigger);
    indicatorSearch.focus();
  });

  document.getElementById('indicatorsModalClose').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
  });

  indicatorSearch.addEventListener('input', () => {
    const q = indicatorSearch.value;
    indicatorSearchClear.style.display = q ? 'flex' : 'none';
    renderIndList(q, indActiveCat);
  });
  indicatorSearch.addEventListener('click', (e) => e.stopPropagation());
  indicatorSearchClear.addEventListener('click', (e) => {
    e.stopPropagation();
    indicatorSearch.value = '';
    indicatorSearchClear.style.display = 'none';
    renderIndList('', indActiveCat);
    indicatorSearch.focus();
  });

  document.getElementById('indCatTabs').querySelectorAll('.ind-cat').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('indCatTabs').querySelectorAll('.ind-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      indActiveCat = btn.dataset.cat;
      renderIndList(getIndSearch(), indActiveCat);
    });
  });

  /* ---------- order type dropdown ---------- */
  const orderTypeMenu = document.getElementById('orderTypeMenu');
  function openOrderTypeMenu(anchorRect, trigger) {
    if (trigger && orderTypeMenu.classList.contains('show') && orderTypeMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    orderTypeMenu.querySelectorAll('.pop-item').forEach(it => {
      it.classList.toggle('selected', it.dataset.type === order.orderType);
    });
    openNear(orderTypeMenu, anchorRect, 'left', trigger);
  }
  orderTypeMenu.querySelectorAll('.pop-item').forEach(it => {
    it.addEventListener('click', () => {
      order.orderType = it.dataset.type;
      closeAllPopovers();
      render();
    });
  });

  /* ---------- TP gear menu ---------- */
  const tpGearMenu = document.getElementById('tpGearMenu');
  function activeGearTp() { return order && order.tps.find(t => t.id === activeGearTpId); }
  function renderTpGearMenu() {
    const tp = activeGearTp();
    if (!tp) return;
    document.getElementById('tpTrail').classList.toggle('selected', !!tp.trailing);
    document.getElementById('tpTrailOverrideTune').classList.toggle('active', !!tp.trailOverride);
  }
  function openTpGearMenu(anchorRect, trigger) {
    if (trigger && tpGearMenu.classList.contains('show') && tpGearMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    renderTpGearMenu();
    openNear(tpGearMenu, anchorRect, 'right', trigger);
  }
  document.getElementById('tpAdd').addEventListener('click', () => {
    if (!order) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const farthest = order.tps.reduce((m, t) => Math.max(m, dir * (t.price - order.entry)), 0);
    const newPrice = roundTick(order.entry + dir * (farthest + 50 / PX_PER_POINT));
    const newId = 'tp' + (tpCounter++);
    order.tps.push({ id: newId, price: newPrice, pct: 25, trailing: false, trailOverride: null });
    rebalanceTpAllocations(newId);
    closeAllPopovers(); render();
    showToast('Take profit added', 'add_circle');
  });
  document.getElementById('tpTrail').addEventListener('click', (e) => {
    e.stopPropagation();
    const tp = activeGearTp();
    if (tp) { tp.trailing = !tp.trailing; }
    renderTpGearMenu(); render();
  });
  document.getElementById('tpRemove').addEventListener('click', () => {
    order.tps = order.tps.filter(t => t.id !== activeGearTpId);
    closeAllPopovers(); render();
    showToast('Take profit removed', 'delete');
  });

  /* -- Trailing Take Profit override -- */
  const tpTrailOvActivation = document.getElementById('tpTrailOvActivation');
  const tpTrailOvMethod = document.getElementById('tpTrailOvMethod');
  const tpTrailOvDistanceUnit = document.getElementById('tpTrailOvDistanceUnit');
  function updateTpTrailOvConditional() {
    document.getElementById('tpTrailOvActivationCustomRWrap').style.display = tpTrailOvActivation.value === 'customR' ? '' : 'none';
    document.getElementById('tpTrailOvDistanceWrap').style.display = tpTrailOvMethod.value === 'atr' ? 'none' : '';
  }
  function ensureTpTrailOverride(tp) {
    if (!tp) return null;
    if (!tp.trailOverride) {
      const base = chartSettings.trailingTp;
      tp.trailOverride = {
        activation: base.activation, activationCustomR: base.activationCustomR,
        method: base.method, distanceValue: base.distanceValue, distanceUnit: base.distanceUnit
      };
    }
    return tp.trailOverride;
  }
  function populateTpTrailOverrideForm() {
    const tp = activeGearTp();
    if (!tp) return;
    const cfg = ensureTpTrailOverride(tp);
    tpTrailOvActivation.value = cfg.activation;
    document.getElementById('tpTrailOvActivationCustomRValue').value = cfg.activationCustomR;
    tpTrailOvMethod.value = cfg.method;
    document.getElementById('tpTrailOvDistanceValue').value = cfg.distanceValue;
    tpTrailOvDistanceUnit.value = cfg.distanceUnit;
    updateTpTrailOvConditional();
    refreshAllCsDropdownLabels(document.getElementById('tpTrailOverridePanel'));
  }
  document.getElementById('tpTrailOverrideTune').addEventListener('click', (e) => {
    e.stopPropagation();
    const tp = activeGearTp();
    if (!tp) return;
    const panel = document.getElementById('tpTrailOverridePanel');
    const willOpen = !panel.classList.contains('open');
    document.querySelectorAll('.gear-override-panel').forEach(p => p.classList.remove('open'));
    if (willOpen) populateTpTrailOverrideForm();
    panel.classList.toggle('open', willOpen);
  });
  [tpTrailOvActivation, tpTrailOvMethod, tpTrailOvDistanceUnit].forEach(el => el.addEventListener('change', (e) => {
    e.stopPropagation();
    if (el === tpTrailOvActivation || el === tpTrailOvMethod) updateTpTrailOvConditional();
    const ov = ensureTpTrailOverride(activeGearTp());
    if (ov) {
      ov.activation = tpTrailOvActivation.value;
      ov.method = tpTrailOvMethod.value;
      ov.distanceUnit = tpTrailOvDistanceUnit.value;
    }
    renderTpGearMenu();
  }));
  function bindTpTrailOverrideStepper(prefix, min, max, step, field, percentOverride) {
    const input = document.getElementById(prefix + 'Value');
    const dec = document.getElementById(prefix + 'Dec');
    const inc = document.getElementById(prefix + 'Inc');
    const unitSelect = document.getElementById(prefix + 'Unit');
    function activeParams() {
      if (percentOverride && unitSelect && unitSelect.value === 'percent') return percentOverride;
      return { min, max, step };
    }
    function clampVal(v) {
      const p = activeParams();
      v = Math.round(v / p.step) * p.step;
      v = Number.isInteger(p.step) ? Math.round(v) : +v.toFixed(2);
      return Math.min(p.max, Math.max(p.min, v));
    }
    function commit() { const ov = ensureTpTrailOverride(activeGearTp()); if (ov) ov[field] = parseFloat(input.value) || 0; renderTpGearMenu(); }
    input.removeAttribute('readonly');
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(parseFloat(input.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal(parseFloat(input.value || '0') - activeParams().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal(parseFloat(input.value || '0') + activeParams().step); commit(); });
  }
  bindTpTrailOverrideStepper('tpTrailOvActivationCustomR', 0.1, 50, 0.1, 'activationCustomR');
  bindTpTrailOverrideStepper('tpTrailOvDistance', 1, 2000, 5, 'distanceValue', PERCENT_DISTANCE_STEP);

  /* ---------- SL gear menu (special-behavior settings) ---------- */
  const slGearMenu = document.getElementById('slGearMenu');
  const slTrailRow = document.getElementById('slTrailRow');
  const slAtrRow = document.getElementById('slAtrRow');
  const slBeToggle = document.getElementById('slBeToggle');
  const slBeSub = document.getElementById('slBeSub');
  const slDistanceUnitSel = document.getElementById('slDistanceUnit');
  const slStartSel = document.getElementById('slStart');
  const slBeOvTrigger = document.getElementById('slBeOvTrigger');
  const slBeOvOffsetValue = document.getElementById('slBeOvOffsetValue');
  const slBeOvOffsetUnit = document.getElementById('slBeOvOffsetUnit');
  /* resolves which TP arms breakeven, using the global default set in Chart Settings > Trade Management */
  function resolveBreakevenTpId() {
    if (!order || !order.tps.length) return null;
    const cfg = getEffectiveBeConfig();
    if (cfg.trigger === 'tp1') return order.tps[0].id;
    if (cfg.trigger === 'tp2') return (order.tps[1] || order.tps[order.tps.length - 1]).id;
    if (cfg.trigger === 'tp3') return (order.tps[2] || order.tps[order.tps.length - 1]).id;
    if (cfg.trigger === 'customR') {
      const dir = order.side === 'buy' ? 1 : -1;
      const riskTotal = order.sl ? Math.abs(order.entry - order.sl.price) * POINT_VALUE : null;
      if (riskTotal) {
        const match = order.tps.find(tp => {
          const pts = dir * (tp.price - order.entry);
          return (pts * POINT_VALUE) / riskTotal >= cfg.customR;
        });
        if (match) return match.id;
      }
      return order.tps[order.tps.length - 1].id;
    }
    return order.tps[0].id;
  }
  /* every SL gets its own editable breakeven settings, seeded from the global default */
  function ensureBeOverride() {
    if (!order || !order.sl) return null;
    if (!order.sl.beOverride) {
      const base = chartSettings.moveSlToBreakeven;
      order.sl.beOverride = { trigger: base.trigger, customR: base.customR, offsetValue: base.offsetValue, offsetUnit: base.offsetUnit };
    }
    return order.sl.beOverride;
  }
  /* reflect the SL's settings in the gear-menu fields */
  function populateSlSettings() {
    const cfg = ensureSlConfig();
    if (!cfg) return;
    document.getElementById('slDistanceValue').value = cfg.distanceUnit === 'percent'
      ? (+cfg.distanceValue).toFixed(2) : Math.round(cfg.distanceValue);
    slDistanceUnitSel.value = cfg.distanceUnit;
    slStartSel.value = cfg.start;
    document.getElementById('slAtrMultiplier').value = slAtrMult().toFixed(1);
    const be = ensureBeOverride();
    slBeOvTrigger.value = be.trigger;
    slBeOvOffsetValue.value = be.offsetValue;
    slBeOvOffsetUnit.value = be.offsetUnit;
    refreshAllCsDropdownLabels(slGearMenu);
  }
  function renderSlGearMenu() {
    if (!order || !order.sl) return;
    const noTps = order.tps.length < 2; // breakeven needs at least 2 TPs set
    if (noTps && order.sl.mode === 'breakeven' && !order.sl.beActive) order.sl.beTpId = null;
    const mode = order.sl.mode, on = order.sl.enabled;
    slTrailRow.classList.toggle('selected', on && mode === 'trailing');
    slAtrRow.classList.toggle('selected', on && mode === 'atr');
    slBeToggle.classList.toggle('selected', on && mode === 'breakeven');
    slBeToggle.classList.toggle('disabled', noTps);
    slBeSub.textContent = (on && mode === 'breakeven' && order.sl.beActive)
      ? 'Active — SL moved to entry'
      : noTps ? 'Requires at least 2 take profits'
        : (on && mode === 'breakeven' && order.sl.beTpId) ? 'Triggers on TP' + (order.tps.findIndex(t => t.id === order.sl.beTpId) + 1)
          : 'Move SL to entry once a TP is hit';
    // a section's settings only expand once that behavior is actually enabled
    document.getElementById('slTrailSettings').style.display = (on && mode === 'trailing') ? '' : 'none';
    document.getElementById('slAtrSettings').style.display = (on && mode === 'atr') ? '' : 'none';
    document.getElementById('slBeSettings').style.display = (on && mode === 'breakeven') ? '' : 'none';
    populateSlSettings();
  }
  function openSlGearMenu(anchorRect, trigger) {
    if (trigger && slGearMenu.classList.contains('show') && slGearMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    renderSlGearMenu();
    openNear(slGearMenu, anchorRect, 'right', trigger);
  }
  /* place/adopt the SL for the currently-selected mode */
  function applySlModePlacement() {
    if (!order || !order.sl) return;
    if (order.sl.mode === 'trailing') {
      const cfg = ensureSlConfig();
      cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(cfg.distanceUnit === 'percent' ? 2 : 0);
    } else if (order.sl.mode === 'atr') {
      placeAtrStop();
    } else if (order.sl.mode === 'breakeven') {
      order.sl.beActive = false;
      order.sl.beTpId = resolveBreakevenTpId();
    }
  }
  /* select a special behavior (mutually exclusive) and turn it on */
  function selectSlMode(mode) {
    if (!order || !order.sl) return;
    if (mode === 'breakeven' && order.tps.length < 2) { showToast('Breakeven needs at least 2 take profits', 'info'); return; }
    order.sl.mode = mode;
    order.sl.enabled = true;
    if (mode !== 'breakeven') { order.sl.beActive = false; order.sl.beTpId = null; }
    applySlModePlacement();
    renderSlGearMenu(); render();
  }
  /* master on/off for the SL chip toggle */
  function toggleSlEnabled() {
    if (!order || !order.sl) return;
    if (!order.sl.enabled) {
      if (order.sl.mode === 'breakeven' && order.tps.length < 2) { showToast('Breakeven needs at least 2 take profits', 'info'); return; }
      order.sl.enabled = true;
      applySlModePlacement();
    } else {
      order.sl.enabled = false;
      order.sl.beActive = false; order.sl.beTpId = null;
    }
    renderSlGearMenu(); render();
  }
  slTrailRow.addEventListener('click', (e) => { e.stopPropagation(); selectSlMode('trailing'); });
  slAtrRow.addEventListener('click', (e) => { e.stopPropagation(); selectSlMode('atr'); });
  slBeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (slBeToggle.classList.contains('disabled')) return;
    selectSlMode('breakeven');
  });
  /* Trailing distance unit: re-express the current gap so the SL line doesn't jump */
  slDistanceUnitSel.addEventListener('change', (e) => {
    e.stopPropagation();
    const cfg = ensureSlConfig();
    if (!cfg) return;
    cfg.distanceUnit = slDistanceUnitSel.value;
    cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(cfg.distanceUnit === 'percent' ? 2 : 0);
    populateSlSettings();
  });
  /* Start-trailing trigger */
  slStartSel.addEventListener('change', (e) => {
    e.stopPropagation();
    const cfg = ensureSlConfig();
    if (cfg) cfg.start = slStartSel.value;
  });
  /* Breakeven trigger / offset unit */
  [slBeOvTrigger, slBeOvOffsetUnit].forEach(el => el.addEventListener('change', (e) => {
    e.stopPropagation();
    const ov = ensureBeOverride();
    if (!ov) return;
    ov.trigger = slBeOvTrigger.value;
    ov.offsetUnit = slBeOvOffsetUnit.value;
    if (slBeActiveMode() && !order.sl.beActive) { order.sl.beTpId = resolveBreakevenTpId(); renderSlGearMenu(); }
  }));
  /* Trailing distance value stepper (% or ticks) */
  {
    const input = document.getElementById('slDistanceValue');
    const inc = document.getElementById('slDistanceInc');
    const dec = document.getElementById('slDistanceDec');
    function params() {
      const cfg = ensureSlConfig();
      return (cfg && cfg.distanceUnit === 'ticks') ? { min: 1, max: 2000, step: 1, dp: 0 } : { min: 0.1, max: 50, step: 0.1, dp: 2 };
    }
    function clampVal(v) { const p = params(); v = Math.round(v / p.step) * p.step; v = p.dp ? +v.toFixed(p.dp) : Math.round(v); return Math.min(p.max, Math.max(p.min, v)); }
    function commit() { const cfg = ensureSlConfig(); if (cfg) cfg.distanceValue = parseFloat(input.value) || 0; repositionSlFromConfig(); render(); }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(parseFloat(input.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 0) - params().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 0) + params().step); commit(); });
  }
  /* ATR multiplier stepper */
  {
    const input = document.getElementById('slAtrMultiplier');
    const inc = document.getElementById('slAtrMultiplierInc');
    const dec = document.getElementById('slAtrMultiplierDec');
    function clampVal(v) { return Math.min(20, Math.max(0.1, +parseFloat(v).toFixed(1))); }
    function commit() {
      if (!order || !order.sl) return;
      order.sl.atrMult = parseFloat(input.value) || 2;
      if (slAtrActive() && !order.filled) placeAtrStop();
      render();
    }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(input.value || '2'); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 2) - 0.1); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 2) + 0.1); commit(); });
  }
  /* Breakeven offset stepper */
  {
    const input = document.getElementById('slBeOvOffsetValue');
    const inc = document.getElementById('slBeOvOffsetInc');
    const dec = document.getElementById('slBeOvOffsetDec');
    function params() { return slBeOvOffsetUnit.value === 'percent' ? PERCENT_DISTANCE_STEP : { min: 0, max: 200, step: 1 }; }
    function clampVal(v) { const p = params(); v = Math.round(v / p.step) * p.step; v = Number.isInteger(p.step) ? Math.round(v) : +v.toFixed(2); return Math.min(p.max, Math.max(p.min, v)); }
    function commit() { const ov = ensureBeOverride(); if (ov) ov.offsetValue = parseFloat(input.value) || 0; }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(parseFloat(input.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 0) - params().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 0) + params().step); commit(); });
  }

  document.getElementById('slRemove').addEventListener('click', () => {
    order.sl = null;
    closeAllPopovers(); render();
    showToast('Stop loss removed', 'delete');
  });

  /* ---------- size & mode dropdown ---------- */
  const sizeMenu = document.getElementById('sizeMenu');
  const smTabs = document.getElementById('smTabs');
  function openSizeMenu(anchorRect, trigger) {
    if (trigger && sizeMenu.classList.contains('show') && sizeMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    smTabs.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === order.sizeMode));
    sizeMenu.querySelectorAll('.sm-body').forEach(b => b.classList.toggle('active', b.dataset.mode === order.sizeMode));
    refreshSizeBodies();
    openNear(sizeMenu, anchorRect, 'left', trigger);
  }
  smTabs.querySelectorAll('.sm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      order.sizeMode = tab.dataset.mode;
      smTabs.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t === tab));
      sizeMenu.querySelectorAll('.sm-body').forEach(b => b.classList.toggle('active', b.dataset.mode === tab.dataset.mode));
      if (tab.dataset.mode === 'risk') syncQtyFromRisk();
      refreshSizeBodies();
      render();
    });
  });

  // contracts mode
  const smQtyInput = document.getElementById('smQtyInput');
  document.getElementById('smQtyDec').addEventListener('click', () => { order.qty = Math.max(1, order.qty - 1); smQtyInput.value = order.qty; render(); });
  document.getElementById('smQtyInc').addEventListener('click', () => { order.qty = order.qty + 1; smQtyInput.value = order.qty; render(); });
  smQtyInput.addEventListener('click', (e) => e.stopPropagation());
  smQtyInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseInt((e.target.value || '').replace(/[^0-9]/g, '')) || 1;
    order.qty = Math.max(1, v);
    smQtyInput.value = order.qty;
    render();
  });
  document.getElementById('smQtyQuick').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { order.qty = parseInt(b.textContent); smQtyInput.value = order.qty; render(); });
  });

  // dollar mode
  const smDolInput = document.getElementById('smDolInput');
  function setDollar(v) { order.sizeValues.dollar = Math.max(500, v); refreshSizeBodies(); render(); }
  document.getElementById('smDolDec').addEventListener('click', () => setDollar(order.sizeValues.dollar - 500));
  document.getElementById('smDolInc').addEventListener('click', () => setDollar(order.sizeValues.dollar + 500));
  smDolInput.addEventListener('click', (e) => e.stopPropagation());
  smDolInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat((e.target.value || '').replace(/[$,]/g, '')) || 500;
    setDollar(v);
  });

  // percent mode
  const smPctSlider = document.getElementById('smPctSlider');
  smPctSlider.addEventListener('input', () => {
    order.sizeValues.percent = parseInt(smPctSlider.value);
    refreshSizeBodies(); render();
  });

  function refreshSizeBodies() {
    if (!order) return;
    smQtyInput.value = order.qty;
    // dollar
    smDolInput.value = '$' + fmt(order.sizeValues.dollar, 0);
    const dolQty = +(order.sizeValues.dollar / MARGIN_PER_CONTRACT).toFixed(2);
    const dolMargin = +(dolQty * MARGIN_PER_CONTRACT).toFixed(2);
    document.getElementById('smDolQty').textContent = fmt(dolQty, 2) + ' ETH';
    document.getElementById('smDolMargin').textContent = fmtMoney(dolMargin);
    document.getElementById('smDolBp').textContent = fmtMoney(BUYING_POWER - dolMargin);

    // percent
    document.getElementById('smPctDisplay').textContent = order.sizeValues.percent + '%';
    smPctSlider.value = order.sizeValues.percent;
    const posVal = ACCOUNT_BALANCE * order.sizeValues.percent / 100;
    const pctQty = +(posVal / MARGIN_PER_CONTRACT).toFixed(2);
    const pctMargin = +(pctQty * MARGIN_PER_CONTRACT).toFixed(2);
    document.getElementById('smPctBal').textContent = fmtMoney(ACCOUNT_BALANCE);
    document.getElementById('smPctPos').textContent = fmtMoney(posVal);
    document.getElementById('smPctQty').textContent = fmt(pctQty, 2) + ' ETH';
    document.getElementById('smPctMargin').textContent = fmtMoney(pctMargin);

    // risk — rebuilt each time since it has 3 distinct states
    const body = document.getElementById('smRiskBody');
    if (!order.sl) {
      body.innerHTML =
        '<div class="sm-state-banner warn"><span class="material-symbols-outlined">hourglass_empty</span>Waiting for Stop Loss</div>' +
        '<div class="sm-empty"><span class="material-symbols-outlined">south</span><br>Drag the stop loss line on the chart<br>to calculate position size.</div>';
    } else {
      const stopDist = Math.abs(order.entry - order.sl.price);
      const riskPerContract = stopDist * POINT_VALUE;
      body.innerHTML =
        '<label class="sm-amount-lbl">Risk Amount (USD)</label>' +
        '<div class="sm-stepper"><button id="smRiskDec">−</button><input type="text" id="smRiskInput" value="$' + fmt(order.sizeValues.risk, 0) + '"><button id="smRiskInc">+</button></div>' +
        '<div class="sm-divider"></div>' +
        '<div class="sm-stat-row"><span class="l">Stop Distance</span><span class="v">' + fmt(stopDist, 2) + ' pts</span></div>' +
        '<div class="sm-stat-row"><span class="l">Risk per Contract</span><span class="v">' + fmtMoney(riskPerContract) + '</span></div>' +
        '<div id="smRiskCalcSlot"></div>';
      const calcQty = riskPerContract > 0 ? Math.floor(order.sizeValues.risk / riskPerContract) : 0;
      const marginReq = calcQty * MARGIN_PER_CONTRACT;
      const sufficient = marginReq <= BUYING_POWER;
      const slot = body.querySelector('#smRiskCalcSlot');
      if (sufficient) {
        slot.innerHTML =
          '<div class="sm-stat-row"><span class="l">Calculated Quantity</span><span class="v">' + calcQty.toFixed(2) + ' ETH</span></div>' +
          '<div class="sm-stat-row"><span class="l">Margin Required</span><span class="v">' + fmtMoney(marginReq) + '</span></div>' +
          '<div class="sm-stat-row"><span class="l">Buying Power Available</span><span class="v up">' + fmtMoney(BUYING_POWER - marginReq) + '</span></div>' +
          '<div class="sm-divider"></div>' +
          '<div class="sm-state-banner ok"><span class="material-symbols-outlined">check_circle</span>Sufficient Buying Power</div>' +
          '<div class="sm-note">Position size auto-adjusts when the stop loss is moved.</div>';
      } else {
        const maxQty = Math.floor(BUYING_POWER / MARGIN_PER_CONTRACT);
        const actualRisk = maxQty * riskPerContract;
        slot.innerHTML =
          '<div class="sm-stat-row"><span class="l">Calculated Quantity</span><span class="v">' + calcQty.toFixed(2) + ' ETH</span></div>' +
          '<div class="sm-stat-row"><span class="l">Max Available Quantity</span><span class="v">' + maxQty.toFixed(2) + ' ETH</span></div>' +
          '<div class="sm-stat-row"><span class="l">Actual Risk</span><span class="v">' + fmtMoney(actualRisk) + '</span></div>' +
          '<div class="sm-divider"></div>' +
          '<div class="sm-state-banner bad"><span class="material-symbols-outlined">error</span>Insufficient Buying Power</div>' +
          '<div class="sm-options">' +
          '<span class="sm-options-lbl">Options</span>' +
          '<button class="sm-opt-btn primary" id="smUseMax">Use Maximum Available (' + maxQty + ' ETH)</button>' +
          '<button class="sm-opt-btn ghost" id="smReduceRisk">Reduce Risk Amount</button>' +
          '</div>';
      }
      document.getElementById('smRiskDec').addEventListener('click', (e) => { e.stopPropagation(); order.sizeValues.risk = Math.max(250, order.sizeValues.risk - 250); syncQtyFromRisk(); refreshSizeBodies(); render(); });
      document.getElementById('smRiskInc').addEventListener('click', (e) => { e.stopPropagation(); order.sizeValues.risk += 250; syncQtyFromRisk(); refreshSizeBodies(); render(); });
      document.getElementById('smRiskInput').addEventListener('click', (e) => e.stopPropagation());
      document.getElementById('smRiskInput').addEventListener('change', (e) => {
        e.stopPropagation();
        const val = parseFloat((e.target.value || '').replace(/[$,]/g, '')) || 0;
        order.sizeValues.risk = Math.max(250, Math.round(val));
        syncQtyFromRisk();
        refreshSizeBodies();
        render();
      });
      const useMax = document.getElementById('smUseMax');
      if (useMax) useMax.addEventListener('click', (e) => {
        e.stopPropagation();
        const mq = Math.floor(BUYING_POWER / MARGIN_PER_CONTRACT);
        order.sizeValues.risk = Math.round(mq * riskPerContract);
        syncQtyFromRisk(); refreshSizeBodies(); render();
        showToast('Risk set to maximum available size', 'check_circle');
      });
      const reduceRisk = document.getElementById('smReduceRisk');
      if (reduceRisk) reduceRisk.addEventListener('click', (e) => {
        e.stopPropagation();
        order.sizeValues.risk = Math.max(250, Math.round(order.sizeValues.risk / 2 / 250) * 250);
        syncQtyFromRisk(); refreshSizeBodies(); render();
      });
    }
  }

  /* ---------- edit exit amount modal ---------- */
  const editBackdrop = document.getElementById('editExitBackdrop');
  const exitModeGroup = document.getElementById('exitModeGroup');
  const exitPctSlider = document.getElementById('exitPctSlider');
  const exitPctDisplay = document.getElementById('exitPctDisplay');
  const exitBodies = editBackdrop.querySelectorAll('.sm-body');
  const exitQtyInput = document.getElementById('exitQtyInput');
  const exitDolInput = document.getElementById('exitDolInput');

  function exitMarkPrice() {
    const el = document.getElementById('hdrLast');
    const v = el ? parseFloat(el.textContent.replace(/,/g, '')) : NaN;
    return isNaN(v) ? BASE_PRICE : v;
  }
  function exitPositionValue() { return order.qty * exitMarkPrice(); }
  function exitPctToQty(pct) { return Math.round(order.qty * clamp(pct, 0, 100) / 100); }
  function exitQtyToPct(qty) { return order.qty > 0 ? clamp(Math.round(qty / order.qty * 100), 0, 100) : 0; }
  function exitPctToDollar(pct) { return Math.round(exitPositionValue() * clamp(pct, 0, 100) / 100); }
  function exitDollarToPct(dollar) {
    const pv = exitPositionValue();
    return pv > 0 ? clamp(Math.round(dollar / pv * 100), 0, 100) : 0;
  }

function syncExitModeInputs() {
    if (!exitModal) return;
    exitPctSlider.value = exitModal.pct;
    exitPctDisplay.textContent = exitModal.pct + '%';
    exitQtyInput.value = exitPctToQty(exitModal.pct).toFixed(2);
    exitDolInput.value = '$' + exitPctToDollar(exitModal.pct).toLocaleString();
  }

  function setExitMode(mode) {
    exitModal.mode = mode;
    exitModeGroup.querySelectorAll('.modal-radio-row').forEach(r => {
      r.classList.toggle('checked', r.dataset.exitmode === mode);
      r.querySelector('.sm-radio').classList.toggle('checked', r.dataset.exitmode === mode);
    });
    exitBodies.forEach(b => b.classList.toggle('active', b.dataset.exitbody === mode));
    syncExitModeInputs();
  }

  function openEditExitModal(tpId, anchorRect, trigger) {
    const tp = order.tps.find(t => t.id === tpId);
    if (!tp) return;
    if (exitModal && exitModal.tpId === tpId && editBackdrop.classList.contains('show')) {
      closeEditExitModal();
      return;
    }
    const idx = order.tps.indexOf(tp);
    exitModal = { tpId, mode: 'percent', pct: tp.pct };
    document.getElementById('exitModalTpName').textContent = 'TP' + (idx + 1);
    setExitMode('percent');
    refreshExitSummary();
    if (anchorRect) openNear(editBackdrop, anchorRect, 'right', trigger);
    else editBackdrop.classList.add('show');
  }
  function closeEditExitModal() { closeAllPopovers(); exitModal = null; }

  function refreshExitSummary() {
    if (!exitModal) return;
    const pct = clamp(exitModal.pct, 0, 100);
    const contracts = exitPctToQty(pct);
    const remaining = order.qty - contracts;
    const totalOther = order.tps.filter(t => t.id !== exitModal.tpId).reduce((s, t) => s + t.pct, 0);
    const total = totalOther + pct;
    document.getElementById('exitCurrent').textContent = pct + '% (' + contracts.toFixed(2) + ' ETH)';
    document.getElementById('exitThis').textContent = contracts.toFixed(2) + ' ETH';
    document.getElementById('exitRemaining').textContent = remaining.toFixed(2) + ' ETH (' + (100 - pct) + '%)';
    const totalEl = document.getElementById('exitTotal');
    if (total === 100) {
      totalEl.innerHTML = total + '% <span class="material-symbols-outlined">check_circle</span>';
      totalEl.classList.remove('warn');
    } else {
      totalEl.innerHTML = total + '% <span class="material-symbols-outlined">warning</span>';
      totalEl.classList.add('warn');
    }
  }
  exitModeGroup.querySelectorAll('.modal-radio-row').forEach(row => {
    row.addEventListener('click', () => setExitMode(row.dataset.exitmode));
  });
  exitPctSlider.addEventListener('input', () => {
    exitModal.pct = parseInt(exitPctSlider.value);
    exitPctDisplay.textContent = exitModal.pct + '%';
    exitQtyInput.value = exitPctToQty(exitModal.pct).toFixed(2);
    exitDolInput.value = '$' + exitPctToDollar(exitModal.pct).toLocaleString();
    refreshExitSummary();
  });
  document.getElementById('exitQtyDec').addEventListener('click', () => {
    exitModal.pct = exitQtyToPct(clamp(exitPctToQty(exitModal.pct) - 1, 0, order.qty));
    syncExitModeInputs(); refreshExitSummary();
  });
  document.getElementById('exitQtyInc').addEventListener('click', () => {
    exitModal.pct = exitQtyToPct(clamp(exitPctToQty(exitModal.pct) + 1, 0, order.qty));
    syncExitModeInputs(); refreshExitSummary();
  });
  const exitDolStep = 50;
  document.getElementById('exitDolDec').addEventListener('click', () => {
    const dollar = Math.max(0, exitPctToDollar(exitModal.pct) - exitDolStep);
    exitModal.pct = exitDollarToPct(dollar);
    syncExitModeInputs(); refreshExitSummary();
  });
  document.getElementById('exitDolInc').addEventListener('click', () => {
    const dollar = Math.min(exitPositionValue(), exitPctToDollar(exitModal.pct) + exitDolStep);
    exitModal.pct = exitDollarToPct(dollar);
    syncExitModeInputs(); refreshExitSummary();
  });
  exitQtyInput.addEventListener('click', (e) => e.stopPropagation());
  exitQtyInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const qty = parseFloat(e.target.value) || 0;
    exitModal.pct = exitQtyToPct(qty);
    syncExitModeInputs();
    refreshExitSummary();
  });
  exitDolInput.addEventListener('click', (e) => e.stopPropagation());
  exitDolInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const dollar = parseFloat((e.target.value || '').replace(/[$,]/g, '')) || 0;
    exitModal.pct = exitDollarToPct(dollar);
    syncExitModeInputs();
    refreshExitSummary();
  });
  document.getElementById('exitModalClose').addEventListener('click', closeEditExitModal);
  document.getElementById('exitCancel').addEventListener('click', closeEditExitModal);
  document.getElementById('exitSave').addEventListener('click', () => {
    const tp = order.tps.find(t => t.id === exitModal.tpId);
    if (tp) { tp.pct = clamp(exitModal.pct, 0, 100); }
    closeEditExitModal();
    render();
    showToast('Exit amount updated', 'check_circle');
  });
  renderOpenOrders();
  renderOrderHistory();
  renderTradeHistory();
  renderAlerts();

})();
