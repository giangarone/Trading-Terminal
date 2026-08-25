/* ================================================================
   ORDER MANAGEMENT ENGINE
   ================================================================ */
(function () {
  const POINT_VALUE = 50;          // $ per point per contract (ES)
  const FEE_RATE_MARKET = 0.0006;  // 0.06% taker fee (market / stop-market fills)
  const FEE_RATE_LIMIT = 0.0002;  // 0.02% maker fee (limit / stop-limit fills)
  // Round-trip taker fee as a percentage of entry (entry fill + exit fill). This is what Dynamic Fee
  // Offset auto-fills into the breakeven 'Fee Amount' field so the SL lands at a true net-zero exit.
  const BE_ROUND_TRIP_FEE_PCT = FEE_RATE_MARKET * 2 * 100; // 0.12%
  let TICK = 0.25;
  const PX_PER_POINT = 22;         // vertical px per 1.0 point
  const BASE_PRICE = 4500.25;      // anchors chart's vertical price scale
  const CHART_SYMBOL = 'ETHUSD';   // the instrument the chart draws — the symbol selector is cosmetic
  const AXIS_RIGHT_W = 68;         // width reserved for the price axis gutter
  const AXIS_BOTTOM_H = 24;        // height reserved for the time axis gutter
  const BAR_INTERVAL_MIN = 15;     // minutes per candle, matches the active "15m" timeframe
  const FUTURE_BARS = 24;          // empty bar-slots reserved on the right so the time axis continues past "now"
  const VISIBLE_BARS = 90;         // default on-screen candle density; older bars sit off to the left, reachable by panning
  const MARGIN_PER_CONTRACT = 13200; // mock margin / contract (ballpark ES futures margin)
  const BUYING_POWER = 87643.20;   // matches Order Entry panel
  // Single source of truth for the active account's balance. Seeded to the default account (BloFin) and
  // kept in sync by the topbar account switcher (renderAccountSelect). Everything that needs the account
  // balance — chart % sizing, the Quick Trade panel, the quick-order overlay, the Default Size readout —
  // reads this so they can never disagree again. Exposed on window for the overlays.js IIFE.
  let ACCOUNT_BALANCE = 52430.00;
  window.getAccountBalance = () => ACCOUNT_BALANCE;

  const chart = document.getElementById('chartPlaceholder');
  const layer = document.getElementById('orderLineLayer');
  const newsMarkerLayer = document.getElementById('newsMarkerLayer');
  const eventLineLayer = document.getElementById('eventLineLayer');
  const toastStack = document.getElementById('toastStack');
  const priceCanvas = document.getElementById('priceChartCanvas');

  let orders = [];          // every chart order, pending + filled (the chart trades ETHUSD only)
  let orderCounter = 0;     // id source for orders: 'ord' + orderCounter++
  let order = null;         // focus pointer: the one order the current interaction/render concerns
  let tpCounter = 1;
  // Static mockup: a partially-filled AAPL limit order that demonstrates the fill pill
  // in the Open Orders tab. Dismissable via its cancel (✕); does not affect real trading.
  let mockAaplOrder = { sym: 'AAPL', side: 'buy', qty: 20, filledQty: 12, price: 187.50, avgFill: 187.42, orderType: 'Limit' };
  let pendingClickPrice = BASE_PRICE;
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
    moveSlToBreakeven: { trigger: 'tp1', customR: 1, pctToTp: 50, offsetValue: BE_ROUND_TRIP_FEE_PCT, offsetUnit: 'fee', dynamicFee: true },
    breakevenLine: { enabled: false },
    trailingStop: { enabledByDefault: false, distanceUnit: 'percent', start: 'immediate', startCustomR: 1 },
    atrStop: { multiplier: 2.0 },
    trailingTp: { enabledByDefault: false, distanceValue: 0.05, distanceUnit: 'percent' },
    globalBehavior: { cancelOnManualClose: true, recalcOnSizeChange: true, persist: true, lockRR: false },
    // sizingMethod + defaultSize drive the size of chart right-click "Buy/Sell @ price" trades (the
    // Default Size card). quickMarketSize is separate — it only sizes the right-click "Buy/Sell Market" actions.
    positionDefaults: { orderType: 'limit', quickMarketSize: '1', sizingMethod: 'quantity', defaultSize: '1' },
    // How a price clicked on the chart is turned into a price on the execution venue when the two
    // are different exchanges. 'relative' shifts the whole trade structure by the venue basis so
    // every distance (and therefore R:R) survives the crossing; 'exact' sends the chart price as-is.
    crossVenue: { mode: 'relative', warnEnabled: true, warnBps: 25 },
    news: {
      catalystScope: 'both',
      position: 'by-sentiment',
      sentimentFilter: 'all',
      timeRange: 'all',
      maxEvents: 20,
      showPast: true,
      showUpcoming: true,
      importance: { high: true, medium: true, low: true },
      types: { news: true, social: true, geopolitical: true, corporate: true }
    }
  };
  /* maps the Order Behavior card's generic order-type options to the actual order type strings used by the order object */
  const PD_ORDER_TYPE_MAP = { market: 'Market', limit: 'Limit', mit: 'Trigger Market' };
  function cloneCsDefaults() { return JSON.parse(JSON.stringify(CS_DEFAULTS)); }
  function loadChartSettings() {
    try {
      const raw = localStorage.getItem('tt_chartSettings');
      if (raw) {
        const merged = Object.assign(cloneCsDefaults(), JSON.parse(raw));
        // Object.assign is shallow, so a save from before a breakeven field existed (e.g. 'pctToTp')
        // would otherwise wipe it out entirely, leaving it undefined (renders as "NaN" in the UI).
        merged.moveSlToBreakeven = Object.assign({}, CS_DEFAULTS.moveSlToBreakeven, merged.moveSlToBreakeven);
        merged.breakevenLine = Object.assign({}, CS_DEFAULTS.breakevenLine, merged.breakevenLine);
        merged.positionDefaults = Object.assign({}, CS_DEFAULTS.positionDefaults, merged.positionDefaults);
        merged.trailingTp = Object.assign({}, CS_DEFAULTS.trailingTp, merged.trailingTp);
        merged.trailingStop = Object.assign({}, CS_DEFAULTS.trailingStop, merged.trailingStop);
        merged.crossVenue = Object.assign({}, CS_DEFAULTS.crossVenue, merged.crossVenue);
        // 'Points' was removed as a trailing-distance unit — migrate any persisted value to %
        if (merged.trailingStop && merged.trailingStop.distanceUnit === 'points') merged.trailingStop.distanceUnit = 'percent';
        // Trailing TP now mirrors the tp-trail-menu (only % / Ticks) — migrate any persisted 'points' to %
        if (merged.trailingTp && merged.trailingTp.distanceUnit === 'points') merged.trailingTp.distanceUnit = 'percent';
        // Migrate old news type keys (breaking/marketMoving → news) and remove removed settings
        if (merged.news) {
          if (!merged.news.types) merged.news.types = {};
          if (merged.news.types.news === undefined) {
            merged.news.types.news = !!(merged.news.types.breaking !== false && merged.news.types.marketMoving !== false);
            delete merged.news.types.breaking;
            delete merged.news.types.marketMoving;
          }
          delete merged.news.showCatalysts;
          // "Show markers at bottom" toggle was folded into Marker Position as a 4th option
          if (merged.news.showMarkersAtBottom) merged.news.position = 'bottom';
          delete merged.news.showMarkersAtBottom;
          // Catalyst Scope was added after this pane shipped — saves without it default to showing both.
          if (!merged.news.catalystScope) merged.news.catalystScope = CS_DEFAULTS.news.catalystScope;
        }
        return merged;
      }
    } catch (e) { /* ignore corrupt storage */ }
    return cloneCsDefaults();
  }
  let chartSettings = loadChartSettings();

  /* ---------- cross-venue layer ----------
     js/venues.js owns the chart-venue / execution-venue split and every price translation
     between them. It deliberately knows nothing about this file, so hand it the two things it
     needs — the live chart mark and the trader's Cross-Venue Pricing preference — and read
     everything else back through the TTVenues API.

     A no-op stand-in keeps the whole engine working if venues.js ever fails to load: every
     translation becomes the identity and the app behaves exactly as it did single-venue. */
  const Venues = window.TTVenues || {
    isCrossVenue: () => false,
    toExec: (p) => p, toChart: (p) => p,
    basisAbs: () => 0, basisBps: () => 0,
    execMark: () => 0, execBbo: null,
    divergence: () => ({ bps: 0, abs: 0, level: 'none', signedBps: 0, signedAbs: 0 }),
    dataLabel: () => '', execLabel: () => '', execVenue: () => '',
    setExecVenue: () => { }, setDataVenue: () => { },
    venuesFor: () => [], venueLabel: (id) => id,
  };
  if (window.TTVenues) {
    window.TTVenues.configure({
      chartMark: () => qtCurrentPrice(),
      settings: () => chartSettings.crossVenue,
    });
  }
  /* True only when the execution venue's prices are far enough from the chart's to be worth
     showing a trader — the gate for every venue badge and dual-price readout. */
  function venueSplitVisible() {
    return Venues.isCrossVenue() && Venues.divergence().level !== 'none';
  }
  /* The venue tag carried by every execution object drawn on the chart. It rides the far LEFT edge
     of its own line, opposite the controls: the right-hand half of a line is already crowded with
     chips a trader clicks, and a filled pill wedged in among them read as one more control. On the
     left there is nothing but empty line, so the tags stack into a single quiet column that says
     "everything here is BloFin" at a glance without ever competing with the controls.

     Hovering one states the level on this chart and the price it works at on its own venue. That
     lives here rather than on the price axis because the axis is the chart's own price scale — a
     tag on it claims a level sits at that position, and an execution price does not sit there.

     Returns null when there is no split to explain, so a single-venue chart is untouched. */
  function venueTagEl(key, y, venueId, chartPrice, execPrice) {
    // Judged per line against that line's OWN venue, frozen at placement — not against whatever
    // the account happens to be now. An order working on the venue the chart is drawn from has
    // nothing to explain, even if the account has since moved elsewhere.
    const venue = venueId || Venues.execVenue();
    if (venue === Venues.dataVenue()) return null;
    const label = Venues.venueLabel(venue);
    const chartLabel = Venues.dataLabel();
    // The two prices are only listed when THIS line's own prices actually differ, rather than
    // whenever the market-wide spread happens to be wide. The explanation above them is shown
    // either way: the tag exists precisely because two exchanges are in play, and that is the
    // thing a trader seeing it needs told.
    const showPrices = typeof chartPrice === 'number' && typeof execPrice === 'number'
      && Math.abs(chartPrice - execPrice) >= 0.005;
    const tag = document.createElement('div');
    tag.className = 'ol-venue-tag has-tip';
    tag.dataset.venueKey = key;
    tag.style.top = y + 'px';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined ol-venue-icon';
    icon.textContent = 'account_balance';
    tag.appendChild(icon);
    tag.appendChild(document.createTextNode(label));
    const tip = document.createElement('span');
    tip.className = 'ol-fee-tip ol-venue-tip';
    tip.innerHTML =
      '<span class="ol-venue-tip-head">' +
      '<span class="material-symbols-outlined">swap_horiz</span>' +
      chartLabel + ' chart · ' + label + ' account</span>' +
      '<span class="ol-venue-tip-text">You\u2019re viewing ' + chartLabel + ' prices, but your orders go to ' +
      label + '. You can trade as usual \u2014 this one works on ' + label + '\u2019s book, at ' + label + '\u2019s price.</span>' +
      (showPrices
        ? '<span class="ol-fee-row ol-venue-tip-row"><span class="ol-fee-lbl">Chart · ' + chartLabel + '</span>' +
          '<span class="ol-fee-val">' + fmt(chartPrice) + '</span></span>' +
          '<span class="ol-fee-row"><span class="ol-fee-lbl">Order · ' + label + '</span>' +
          '<span class="ol-fee-val ol-venue-tip-exec">' + fmt(execPrice) + '</span></span>'
        : '');
    tag.appendChild(tip);
    return tag;
  }
  /* Appends a line's venue tag, if there is one to draw. Deliberately appended after the row rather
     than between line and row — updateAllTpSlLinePositionsLive finds a row's line by
     previousElementSibling, and slipping an element in there would break it. */
  function appendVenueTag(container, key, y, venueId, chartPrice, execPrice) {
    const tag = venueTagEl(key, y, venueId, chartPrice, execPrice);
    if (tag) container.appendChild(tag);
  }
  /* Keeps a tag on its line while that line is dragged. Looked up by key rather than by DOM
     position so it can't be knocked loose by the order elements are appended in. */
  function moveVenueTag(scope, key, y) {
    const tag = (scope || layer).querySelector('.ol-venue-tag[data-venue-key="' + key + '"]');
    if (tag) tag.style.top = y + 'px';
  }

  /* Every history row is a record of something that happened on a venue, so each one is stamped
     with the venue it happened on and re-priced into that venue's terms. Call sites push the price
     they know — the one on the chart — and this is the single place that translates it, so no
     individual fill/close/reverse path has to remember the venue exists. */
  function stampVenueRecord(rec) {
    const owner = order;
    if (!rec.venue) rec.venue = (owner && owner.execVenue) || Venues.execVenue();
    if (typeof rec.price === 'number') {
      rec.price = Venues.toExec(rec.price, owner ? { basisAbs: owner.basisAtPlace } : undefined);
    }
    return rec;
  }

  /* Recompute every execution-side price on an order from its chart levels. Exec prices are
     derived, never authored: the chart is where a trader places things, this is what the venue
     receives. Pinned to the basis captured at placement so a live order's ticket doesn't wander
     as the venue spread drifts underneath it. */
  function syncOrderExecPrices(o) {
    if (!o) return;
    const opts = { basisAbs: o.basisAtPlace };
    o.execEntry = Venues.toExec(o.entry, opts);
    (o.tps || []).forEach(tp => { tp.execPrice = Venues.toExec(tp.price, opts); });
    if (o.sl) o.sl.execPrice = Venues.toExec(o.sl.price, opts);
  }
  function persistChartSettingsIfEnabled() {
    if (!chartSettings.globalBehavior.persist) return;
    try { localStorage.setItem('tt_chartSettings', JSON.stringify(chartSettings)); } catch (e) { /* storage unavailable */ }
  }

  /* ---------- order history & alerts state ---------- */
  let alertCounter = 1;
  let alerts = [];
  function nowTimeStr() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  let orderHistory = [
    { symbol: 'ETHUSD', side: 'buy', qty: 2, price: 4486.50, status: 'filled', type: 'Market', time: '09:15:32 AM', pnl: null },
    { symbol: 'NQU5', side: 'buy', qty: 1, price: 18480.00, status: 'filled', type: 'Market', time: '09:18:47 AM', pnl: null },
    { symbol: 'RTYU5', side: 'buy', qty: 3, price: 2070.00, status: 'cancelled', type: 'Market', time: '08:55:10 AM', pnl: null },
  ];

  /* ---------- trade history state ----------
     Only actual fill executions — no cancels, no pending orders.
     pnl: realized P&L in dollars for closing trades; null for opening trades. */
  let tradeHistory = [
    { symbol: 'ETHUSD', side: 'buy', qty: 2, price: 4486.50, pnl: null, role: 'open', type: 'Market', time: '09:15:32 AM', fee: 2.50 },
    { symbol: 'NQU5', side: 'buy', qty: 1, price: 18480.00, pnl: null, role: 'open', type: 'Market', time: '09:18:47 AM', fee: 1.25 },
    { symbol: 'ETHUSD', side: 'sell', qty: 1, price: 4562.25, pnl: 3787.50, role: 'close', type: 'Limit (TP)', time: '10:03:18 AM', fee: 1.25 },
    { symbol: 'NQU5', side: 'sell', qty: 1, price: 18560.00, pnl: 4000.00, role: 'close', type: 'Limit (TP)', time: '10:41:55 AM', fee: 1.25 },
    { symbol: 'ETHUSD', side: 'sell', qty: 1, price: 4495.00, pnl: 425.00, role: 'close', type: 'Market', time: '11:12:40 AM', fee: 1.25 },
    { symbol: 'SOLUSD', side: 'buy', qty: 5, price: 182.40, pnl: null, role: 'open', type: 'Market', time: '11:35:10 AM', fee: 1.25 },
    { symbol: 'SOLUSD', side: 'sell', qty: 5, price: 179.80, pnl: -910.00, role: 'close', type: 'Stop (SL)', time: '12:04:22 PM', fee: 1.25 },
  ];
  window.tradeHistory = tradeHistory; // read by the Trading Journal (workspace.js) to build real journal entries

  /* ---------- helpers ---------- */
  // fmt, escapeHtml, setUpDown, flashEl, mulberry32 are shared globals from js/utils.js
  function fmtMoney(n) { return (n < 0 ? '-$' : '$') + fmt(Math.abs(n)); }
  function roundTick(p) { return Math.round(p / TICK) * TICK; }
  function rectH() { return chart.getBoundingClientRect().height; }
  let panX = 0, panY = 0; // panX: px shift of candles; panY: price shift applied to whole scale
  let panXInitialized = false; // on first draw, panX is set to push candles left, leaving more empty space on the right
  let crosshair = null; // {x,y} in CSS px relative to chart, within plot bounds, or null when not hovering
  let hoveredHandle = null; // 'entry' | 'sl' | 'tp:<id>' | 'offset:<id>' | 'tp-add' | 'sl-add' | null — which order-line handle is currently hovered/dragged
  let hoveredSide = null; // 'buy' | 'sell' | null — the side under the cursor; the opposing side's orders fade (see setHoveredSide)
  let isDraggingOrderLine = false; // true for the duration of any order-line drag — blocks the price-tick auto-render from wiping live drag visuals
  let isHoveringBarControls = false; // true when pointer is over a non-drag interactive element inside an entry/TP/SL bar — suppresses the chart crosshair
  let isHoveringIndLegend = false; // true when pointer is over an indicator row in the chart legend — suppresses the chart crosshair
  let isHoveringClHeader = false; // true when pointer is over the chart legend header (.cl-header) — suppresses the chart crosshair
  layer.addEventListener('mouseover', (e) => {
    if (e.target.closest('.ol-pill-seg, .ol-gear, .ol-amt, .ol-tp-meta, .ol-entry-pnl')) {
      isHoveringBarControls = true;
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); }
    }
  });
  layer.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest('.ol-pill-seg, .ol-gear, .ol-amt, .ol-tp-meta, .ol-entry-pnl')) {
      isHoveringBarControls = false;
    }
  });
  function priceToY(price, h) { const ih = h - AXIS_BOTTOM_H; return ih / 2 - (price - BASE_PRICE - panY) * PX_PER_POINT; }
  function yToPrice(y, h) { const ih = h - AXIS_BOTTOM_H; return BASE_PRICE + panY - (y - ih / 2) / PX_PER_POINT; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  /* Toast notifications. De-dups against the most recent toast (a rapid repeat just refreshes
     its timer instead of stacking a copy) and caps the stack at 3 so a burst of actions can't
     pile up off-screen. Dismiss timers are stored on the node and cleared if it's removed early. */
  const TOAST_MAX = 3;
  function clearToastTimers(t) {
    clearTimeout(t._showTimer);
    clearTimeout(t._hideTimer);
    clearTimeout(t._removeTimer);
  }
  function scheduleToastDismiss(t) {
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => {
      t.classList.remove('show');
      t._removeTimer = setTimeout(() => t.remove(), 300);
    }, 2600);
  }
  function showToast(msg, icon) {
    icon = icon || 'info';
    const key = icon + '|' + msg;
    const last = toastStack.lastElementChild;
    if (last && last.dataset.toastKey === key) {
      last.classList.add('show'); // in case it had started fading out
      scheduleToastDismiss(last);
      return;
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.dataset.toastKey = key;
    t.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span><span>' + msg + '</span>';
    toastStack.appendChild(t);
    while (toastStack.children.length > TOAST_MAX) {
      const oldest = toastStack.firstElementChild;
      clearToastTimers(oldest);
      oldest.remove();
    }
    t._showTimer = setTimeout(() => t.classList.add('show'), 10);
    scheduleToastDismiss(t);
  }
  /* exposed so other modules (e.g. the watchlist row × in js/resize.js) can toast */
  window.showToast = showToast;

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
    /* Prefer opening downward. If the popover is too tall to fit below the anchor,
       flip it above — but only when that actually keeps it on-screen. For a very
       tall panel (e.g. Market Sessions) flipping above would push the top off the
       viewport, so clamp it to the bottom edge instead and keep it fully visible. */
    if (y + h > vh - 12) {
      const above = anchorRect.top - h - 8;
      y = above >= 12 ? above : Math.max(12, vh - h - 12);
    }
    if (x + w > vw - 12) x = vw - w - 12;
    if (x < 8) x = 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
  function openNear(el, anchorRect, align, trigger) {
    if (trigger && el.classList.contains('show') && el._openTrigger === trigger) {
      /* Toggle just this popover closed. Don't call closeAllPopovers() here — it would also
         close any parent float panel (e.g. the indicator settings window) the trigger lives in. */
      if (!el.dataset.persistent) el.classList.remove('show');
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
  /* Opens a floating panel centered in the viewport (rather than anchored to its trigger).
     Used for draggable window panels like the Indicators dropdown. Toggles closed if the
     same trigger reopens it, mirroring openNear's behaviour. */
  function openCentered(el, trigger) {
    if (trigger && el.classList.contains('show') && el._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    const parentMenu = trigger ? trigger.closest('.pop-menu, .ctx-menu') : null;
    closeAllPopoversExcept(el, parentMenu);
    el.classList.add('show');
    el._openTrigger = trigger || null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px';
    el.style.top = Math.max(8, Math.round((vh - h) / 2)) + 'px';
  }
  /* Makes a floating panel draggable by its header. Dragging is ignored when it starts on
     an interactive control (the search field, its buttons, or the close button) so those
     stay clickable; only the title/empty header area acts as the grab handle. */
  function makeFloatPanelDraggable(panel) {
    const header = panel.querySelector('.float-panel-header');
    if (!header) return;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, button')) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      header.classList.add('dragging');
      function onMove(ev) {
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = ev.clientX - grabX;
        let y = ev.clientY - grabY;
        x = Math.max(8, Math.min(x, vw - panel.offsetWidth - 8));
        y = Math.max(8, Math.min(y, vh - panel.offsetHeight - 8));
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
      }
      function onUp() {
        header.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
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
    if (csEl && csEl.classList.contains('show')) {
      /* An active search query is backed out of first, so Escape doesn't discard the draft. */
      if (csSearchEscape()) return;
      closeChartSettings(false);
      return;
    }
    /* Dialog-style modals are .show backdrops, not .pop-menu/.ctx-menu, so closeAllPopovers()
       doesn't reach them. Dismiss the open one via its own close fn (which resets pending
       state), matching how Escape already closes Chart Settings / Journal / Scanner. */
    const oc = document.getElementById('ocBackdrop');
    if (oc && oc.classList.contains('show')) { closeOrderConfirm(); return; }
    const rc = document.getElementById('rcBackdrop');
    if (rc && rc.classList.contains('show')) { closeReverseConfirm(); return; }
    const hb = document.getElementById('hedgeBlockBackdrop');
    if (hb && hb.classList.contains('show')) { closeHedgeBlock(); return; }
    const bc = document.getElementById('bcConnectBackdrop');
    if (bc && bc.classList.contains('show')) { closeBcConnectModal(); return; }
    closeAllPopovers();
  });

  /* ---------- keyboard operability for custom (non-native) controls ----------
     The dropdown/menu triggers are <div>/<span> elements with click handlers but no native
     button semantics, so they can't be Tab-focused or activated by keyboard. Make them
     focusable and announce them as buttons, then translate Enter/Space into a click so each
     control's existing click handler runs — no per-control wiring. Native <button>/<a>/<input>
     controls already handle this and are left untouched. (cs-dd dropdowns are also stamped in
     refreshCsDropdownTriggerLabel, which covers ones created dynamically.) */
  document.querySelectorAll('.pop-trigger').forEach(el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.matches('button, a, input, select, textarea')) return; // native elements handle this
    const control = e.target.closest('[role="button"]');
    if (!control) return;
    e.preventDefault(); // Space must not scroll the page
    control.click();
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
    /* These custom <div> dropdowns need button semantics to be keyboard-reachable/operable.
       Stamping here (rather than only in a one-time pass) also covers dropdowns built
       dynamically — broker rules, chart-settings targets, SL draft — since every render
       routes through refreshAllCsDropdownLabels. */
    if (!trigger.hasAttribute('tabindex')) trigger.setAttribute('tabindex', '0');
    if (!trigger.hasAttribute('role')) trigger.setAttribute('role', 'button');
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
  const ctxQuickMarketLongLbl = document.getElementById('ctxQuickMarketLongLbl');
  const ctxQuickMarketShortLbl = document.getElementById('ctxQuickMarketShortLbl');
  chart.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = chart.getBoundingClientRect();
    pendingClickPrice = roundTick(yToPrice(e.clientY - rect.top, rect.height));
    const priceStr = fmt(pendingClickPrice);
    const quickMarketQtyStr = quickMarketSize().toFixed(2);
    ctxLongLbl.textContent = 'Plan Buy ETHUSD @ ' + priceStr;
    ctxShortLbl.textContent = 'Plan Sell ETHUSD @ ' + priceStr;
    ctxQuickMarketLongLbl.textContent = 'Market Buy ' + quickMarketQtyStr + ' ETHUSD';
    ctxQuickMarketShortLbl.textContent = 'Market Sell ' + quickMarketQtyStr + ' ETHUSD';
    openAt(ctxMenu, e.clientX, e.clientY);
  });
  // Chart right-click "Buy/Sell @ price" trades size themselves from the Position Sizing default (Default
  // Size card in Trade Defaults). createOrder reads the shared qtyInput, so bridge the resolved quantity
  // through it and restore the panel value afterward (same pattern as the quick-market fills).
  function placeChartLimitTrade(side) {
    guardedPlace(side, () => {
      const prevVal = qtyInput.value;
      qtyInput.value = resolveChartTradeQty();
      createOrder(side, pendingClickPrice);
      qtyInput.value = prevVal;
    });
  }
  document.getElementById('ctxLong').addEventListener('click', () => { placeChartLimitTrade('buy'); closeAllPopovers(); });
  document.getElementById('ctxShort').addEventListener('click', () => { placeChartLimitTrade('sell'); closeAllPopovers(); });
  document.getElementById('ctxQuickMarketLong').addEventListener('click', () => { fillQuickMarketOrder('buy'); closeAllPopovers(); });
  document.getElementById('ctxQuickMarketShort').addEventListener('click', () => { fillQuickMarketOrder('sell'); closeAllPopovers(); });

  /* ---------- positions panel: expand/collapse & in-row actions ---------- */
  /* When a row is expanded while the bottom panel is too short to show the whole row,
     grow the panel just enough for the expanded row to be fully visible (capped at the
     same max height the vertical resize handle allows). Collapsing never shrinks it back. */
  function fitBottomPanelToExpandedRow(row) {
    const panel = document.querySelector('.bottom-panel');
    const scroll = row.closest('.pos-rows-scroll');
    if (!panel || !scroll || panel.classList.contains('bp-collapsed')) return;
    const MAX_PANEL_HEIGHT = 560; // matches the vertical resize handle's max in resize.js
    const rowHeight = row.getBoundingClientRect().height;
    const viewportHeight = scroll.clientHeight;
    if (rowHeight > viewportHeight) {
      const panelHeight = panel.getBoundingClientRect().height;
      const needed = panelHeight + (rowHeight - viewportHeight);
      panel.style.height = Math.min(MAX_PANEL_HEIGHT, needed) + 'px';
    }
    /* keep the expanded row anchored in view after any growth */
    requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
  }
  window.fitBottomPanelToExpandedRow = fitBottomPanelToExpandedRow;

  document.querySelectorAll('.pos-row-summary').forEach(summary => {
    summary.addEventListener('click', (e) => {
      if (e.target.closest('.pos-col-quickclose') || e.target.closest('.pos-sym-ticker')) return;
      const row = summary.closest('.pos-row');
      row.classList.toggle('is-expanded');
      if (row.classList.contains('is-expanded')) fitBottomPanelToExpandedRow(row);
    });
  });

  /* ---------- BBO on a limit close ----------
     Same rule as the Quick Trade panel, with the side already decided: a long is closed by selling
     into the best bid, a short by buying the best ask. With BBO on the field states which of the two
     it is instead of a price, and the Close Limit button carries the live number — the price you get
     is written on the button you press. Typing, clicking into the field or nudging the steppers is
     how you opt out. It's per-row and per-order state, held on the row's close section. */
  function posCloseBboOn(row) {
    const wrap = row && row.querySelector('.pos-detail-close');
    return !!wrap && wrap.classList.contains('is-bbo');
  }

  function posCloseQuoteFor(row) {
    return (row && window.positionCloseQuote) ? window.positionCloseQuote(row.dataset.posId) : null;
  }

  function setPosCloseBbo(row, on) {
    const wrap = row.querySelector('.pos-detail-close');
    const input = document.getElementById('posCloseLimitPx-' + row.dataset.posId);
    const btn = wrap.querySelector('[data-pos-close-bbo]');
    const quote = posCloseQuoteFor(row);
    wrap.classList.toggle('is-bbo', on);
    if (btn) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    if (window.refreshPositionCloseQuote) window.refreshPositionCloseQuote(row.dataset.posId);
    if (!input) return;
    input.readOnly = on;
    // The rule replaces the price while BBO is on; leaving it hands the quote back as a starting point.
    input.placeholder = on && quote ? quote.label : 'Limit price';
    if (on) input.value = '';
    else if (!input.value && quote) input.value = quote.text;
  }

  /* Writes the quote this close would trade against into a row's limit price field. */
  function seedPositionCloseLimitPrice(row) {
    if (!row || posCloseBboOn(row)) return;
    const quote = posCloseQuoteFor(row);
    if (!quote) return;
    const input = document.getElementById('posCloseLimitPx-' + row.dataset.posId);
    if (input) input.value = quote.text;
  }

  const posPanel = document.getElementById('bpPanel-positions');

  // Reaching for the limit price field is opting out of the rule, so it turns BBO off rather than
  // silently ignoring the keystrokes against a read-only input.
  function leaveBboOnFieldReach(e) {
    const input = e.target.closest('.pos-detail-close input[id^="posCloseLimitPx-"]');
    if (!input) return;
    const row = input.closest('.pos-row');
    if (posCloseBboOn(row)) setPosCloseBbo(row, false);
  }
  posPanel.addEventListener('mousedown', leaveBboOnFieldReach);
  posPanel.addEventListener('focusin', leaveBboOnFieldReach);

  posPanel.addEventListener('click', e => {
    const tickerEl = e.target.closest('.pos-sym-ticker');
    if (tickerEl) {
      e.stopPropagation();
      switchSymbol(tickerEl.closest('.pos-row').dataset.posId);
      return;
    }
    /* Market / Limit tab switch inside an expanded row's close section */
    const closeTab = e.target.closest('.pos-close-tab');
    if (closeTab) {
      const wrap = closeTab.closest('.pos-detail-close');
      const tab = closeTab.dataset.closeTab;
      wrap.querySelectorAll('.pos-close-tab').forEach(t => t.classList.toggle('active', t === closeTab));
      wrap.querySelectorAll('.pos-close-pane').forEach(p => p.classList.toggle('active', p.dataset.closePane === tab));
      // Opening the Limit tab hands over the quote the close would actually trade against, so the
      // field never offers a price the market has since walked away from.
      if (tab === 'limit') seedPositionCloseLimitPrice(closeTab.closest('.pos-row'));
      return;
    }
    /* BBO toggle on the limit close */
    const bboBtn = e.target.closest('[data-pos-close-bbo]');
    if (bboBtn) {
      const row = bboBtn.closest('.pos-row');
      setPosCloseBbo(row, !posCloseBboOn(row));
      return;
    }
    /* stepper arrows on the close-amount / limit-price fields (delegated so dynamic rows work) */
    const stepBtn = e.target.closest('.pos-detail-close .ps-up, .pos-detail-close .ps-down');
    if (stepBtn) {
      const stepRow = stepBtn.closest('.pos-row');
      // Nudging the limit price is picking a price of your own, so it leaves BBO.
      if (stepBtn.dataset.target.startsWith('posCloseLimitPx-') && posCloseBboOn(stepRow)) {
        setPosCloseBbo(stepRow, false);
      }
      const input = document.getElementById(stepBtn.dataset.target);
      if (!input) return;
      const raw = (input.value || '0').replace(/,/g, '');
      const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
      const step = parseFloat(input.dataset.step) || 1;
      const cur = parseFloat(raw) || 0;
      const next = stepBtn.classList.contains('ps-up') ? cur + step : Math.max(0, cur - step);
      input.value = fmt(next, decimals);
      return;
    }
    /* percentage chips + collapsed "Close" — immediate market close by percent */
    const closeBtn = e.target.closest('[data-pos-close-pct]');
    if (closeBtn) {
      const row = closeBtn.closest('.pos-row');
      const sym = row.dataset.posSym || row.dataset.posId;
      const side = row.dataset.posSide;
      const pct = parseInt(closeBtn.dataset.posClosePct, 10);
      // Fully closing the chart's own (ETHUSD) position must also remove that side's entry/TP/SL lines
      // from the chart — close every matching chart order (which also clears the row).
      if (pct >= 100 && sym === 'ETHUSD' && closeFilledChartOrdersBySide(side)) return;
      if (!window.closePositionPct(sym, pct, side)) return;
      showToast(sym + ' position ' + (pct >= 100 ? 'closed' : 'reduced by ' + pct + '%'), 'check_circle');
      return;
    }
    /* Market tab — close by the percentage set on the slider */
    const marketBtn = e.target.closest('[data-pos-close-market]');
    if (marketBtn) {
      const row = marketBtn.closest('.pos-row');
      const posId = row.dataset.posId;
      const sym = row.dataset.posSym || posId;
      const side = row.dataset.posSide;
      const slider = document.getElementById('posCloseSlider-' + posId);
      const pct = slider ? parseInt(slider.value, 10) : 0;
      if (pct <= 0) { showToast('Select an amount to close', 'error'); return; }
      // A full close of the chart's own (ETHUSD) position also clears that side's lines from the chart.
      if (pct >= 100 && sym === 'ETHUSD' && closeFilledChartOrdersBySide(side)) return;
      if (!window.closePositionPct(sym, pct, side)) return;
      showToast(sym + ' position ' + (pct >= 100 ? 'closed' : 'reduced by ' + pct + '%'), 'check_circle');
      return;
    }
    /* Limit tab — rest a working close order at a price (the position stays open until it fills) */
    const limitBtn = e.target.closest('[data-pos-close-limit]');
    if (limitBtn) {
      const row = limitBtn.closest('.pos-row');
      const posId = row.dataset.posId;
      const sym = row.dataset.posSym || posId;
      const limitSlider = document.getElementById('posCloseSliderLimit-' + posId);
      const pct = limitSlider ? parseInt(limitSlider.value, 10) : 100;
      if (pct <= 0) { showToast('Select an amount to close', 'error'); return; }
      // With BBO on the order rests at the quote it's shown at; otherwise at the typed price.
      const bboQuote = posCloseBboOn(row) ? posCloseQuoteFor(row) : null;
      const input = document.getElementById('posCloseLimitPx-' + posId);
      const typed = input ? parseFloat((input.value || '').replace(/,/g, '')) : NaN;
      const price = bboQuote ? bboQuote.price : typed;
      if (!(price > 0)) { showToast('Enter a limit price', 'error'); return; }
      const placed = window.placePositionCloseOrder(posId, pct, price);
      if (!placed) { showToast('Could not place the close order', 'error'); return; }
      const pctStr = pct < 100 ? ' (' + pct + '%)' : '';
      // Over-committing is allowed — closes are reduce-only and cap at what's left when they fill —
      // but the trader should know the working closes now add up to more than the position.
      const overCommitted = placed.coverPct > 100.5;
      const coverStr = overCommitted
        ? ' — working closes now cover ' + Math.round(placed.coverPct) + '% of the position'
        : '';
      showToast(sym + ' limit close order placed at ' + placed.priceText + pctStr + coverStr, 'pending_actions');
      return;
    }
    const reverseBtn = e.target.closest('[data-pos-reverse]');
    if (reverseBtn) {
      const revRow = reverseBtn.closest('.pos-row');
      const sym = revRow.dataset.posSym || revRow.dataset.posId;
      const side = revRow.dataset.posSide;
      /* ETHUSD's row is driven by the chart's order object — route it through the same
         market-close-then-reopen logic as the entry bar's Reverse control so the two stay in sync,
         which means it clears the same one-way guard too. Other symbols have no chart order, and the
         guard is ETHUSD-scoped, so they reverse through the panel's own path unguarded. */
      const chartOrder = sym === 'ETHUSD' ? findMainPosition(side) : null;
      /* Gate the reverse behind the same confirmation popup as the entry bar's Reverse control,
         so both entry points behave consistently. Panel rows are always live positions. */
      const confirmThenReverse = () => requestReverseConfirmation(true, () => {
        if (chartOrder) {
          order = chartOrder;
          reverseFilledPosition();
          return;
        }
        const result = window.reversePosition(sym);
        if (!result) return;
        showToast(sym + ' reversed to ' + (result.newSide === 'buy' ? 'Long' : 'Short') + ' at ' + fmt(result.price, result.dec), 'swap_vert');
      });
      if (chartOrder) {
        const newSide = chartOrder.side === 'buy' ? 'sell' : 'buy';
        guardedPlace(newSide, confirmThenReverse, chartOrder);
      } else {
        confirmThenReverse();
      }
    }
  });
  /* wrap a raw .range-slider with its track (idempotent) — for sliders inserted at runtime;
     statically-declared ones (e.g. alertVolume) already have the wrap in index.html */
  function decorateRangeSlider(slider) {
    if (slider.parentElement && slider.parentElement.classList.contains('range-slider-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = slider.classList.contains('pos-close-slider') ? 'range-slider-wrap pos-close-slider-wrap' : 'range-slider-wrap';
    slider.parentNode.insertBefore(wrap, slider);
    const track = document.createElement('div');
    track.className = 'range-slider-track';
    wrap.appendChild(track);
    wrap.appendChild(slider);
  }
  window.decorateRangeSlider = decorateRangeSlider;

  function fillRangeSlider(slider) {
    const wrap = slider.closest('.range-slider-wrap');
    if (!wrap) return;
    const pct = parseInt(slider.value, 10);
    /* fill transition lands exactly at the thumb centre (thumb is 14px) */
    const pos = 'calc(7px + (100% - 14px) * ' + (pct / 100) + ')';
    const track = wrap.querySelector('.range-slider-track');
    if (track) {
      track.style.background = 'linear-gradient(to right, var(--text-secondary) ' + pos + ', var(--border-default) ' + pos + ')';
    }
  }
  window.fillRangeSlider = fillRangeSlider;

  function updatePosCloseLabel(slider) {
    const pane = slider.closest('.pos-close-pane');
    const lbl = pane && pane.querySelector('.pos-close-pct-label');
    if (!lbl) return;
    const pct = parseInt(slider.value, 10);
    const row = slider.closest('.pos-row');
    const qtyEl = row && document.getElementById('posQty-' + row.dataset.posId);
    const unitEl = row && row.querySelector('.pos-size-unit');
    if (qtyEl && unitEl) {
      const qty = parseFloat(qtyEl.textContent.replace(/,/g, '')) || 0;
      const amt = qty * pct / 100;
      const amtStr = Number.isInteger(amt) ? String(Math.round(amt))
        : parseFloat(amt.toFixed(4)).toString();
      lbl.innerHTML = '<span>' + pct + '%</span><span class="pos-close-pct-amt"> · ' + amtStr + ' ' + unitEl.textContent.trim() + '</span>';
    } else {
      lbl.innerHTML = '<span>' + pct + '%</span>';
    }
  }
  window.updatePosCloseLabel = updatePosCloseLabel;

  posPanel.addEventListener('input', e => {
    const slider = e.target.closest('.pos-close-slider');
    if (!slider) return;
    fillRangeSlider(slider);
    updatePosCloseLabel(slider);
  });

  document.querySelectorAll('.pos-close-slider').forEach(s => {
    decorateRangeSlider(s);
    fillRangeSlider(s);
    updatePosCloseLabel(s);
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
      ? (fillAbove ? 'Trigger Market' : 'Limit')
      : (fillAbove ? 'Limit' : 'Trigger Market');
    const orderType = isChartTrade ? (PD_ORDER_TYPE_MAP[chartSettings.positionDefaults.orderType] || 'Market') : autoOrderType;
    // Market chart trades snap to live price immediately so TPs/SL are calculated correctly
    const entry = roundTick((isChartTrade && orderType === 'Market') ? currentPrice : entryPrice);
    // An order placed onto a side that already has one is an add-on: it will merge into that
    // direction's position on fill, so it never gets TP/SL of its own. Asked before the push below,
    // so tpSlOwner can't match the order being created.
    const mergesIntoOpenPosition = !!tpSlOwner(side);
    const expanded = chartSettings.tpSlDisplayMode === 'expanded' && !mergesIntoOpenPosition;
    let tps = [];
    let sl = null;
    if (expanded) {
      const baseR = 2; // price distance representing 1.0R, used to price default targets/SL from their R Multiple
      tps = (chartSettings.defaultTargets || []).map(t => ({
        id: 'tp' + (tpCounter++),
        price: roundTick(entry + dir * t.r * baseR),
        pct: t.pct,
        trailing: !!chartSettings.trailingTp.enabledByDefault,
        trailOffset: makeTpTrailOffset(),
        activated: false,
        exitPrice: null
      }));
      if (chartSettings.defaultStopLoss) {
        sl = { price: roundTick(entry - dir * chartSettings.defaultStopLoss.r * baseR), enabled: !!chartSettings.trailingStop.enabledByDefault, mode: 'trailing', autoTrailing: false, atrMult: (chartSettings.atrStop.multiplier || 2.0), beTpId: null, beActive: false, beOverride: null, trailOverride: makeSlConfig() };
      }
    }
    // Chart trades inherit the full Position Sizing default — both the method and its value. Each saved sizing
    // method maps to the order's sizeMode, and the default value seeds that mode's entry in sizeValues (so the
    // size pill and size menu open in that mode showing that value). Risk modes additionally size the qty live
    // from the stop loss (syncQtyFromRisk, blocking placement until one exists); the other modes keep the fixed
    // qty placeChartLimitTrade resolved into qtyInput. Quick Trade panel orders (source==='quick') stay 'contracts'.
    const pd = chartSettings.positionDefaults;
    const PD_METHOD_TO_SIZE_MODE = { quantity: 'contracts', dollar: 'dollar', pct_equity: 'percent', risk_pct: 'risk_pct', risk_dollar: 'risk' };
    const sizeMode = isChartTrade ? (PD_METHOD_TO_SIZE_MODE[pd.sizingMethod] || 'contracts') : 'contracts';
    const useRiskSizing = isRiskMode(sizeMode);
    const pdVal = parseFloat(String(pd.defaultSize).replace(/[$,%\s]/g, '')) || 0;
    order = {
      id: 'ord' + (orderCounter++),
      side, entry, qty: parseFloat(qtyInput.value) || 1, orderType, fillAbove,
      sizeMode, filled: false, filledQty: 0,
      pendingConfirm: isChartTrade,
      sizeValues: {
        dollar: sizeMode === 'dollar' ? pdVal : 5000,
        percent: sizeMode === 'percent' ? pdVal : 25,
        risk: sizeMode === 'risk' ? pdVal : 500,
        riskPct: sizeMode === 'risk_pct' ? pdVal : 1
      },
      tps, sl, tpsHitCount: 0,
      initialRisk: sl ? Math.abs(entry - sl.price) * POINT_VALUE : null,
      // The venue this order is routed to, frozen at placement: switching the execution venue
      // later must never silently re-home an order that is already working. basisAtPlace pins the
      // chart↔venue price translation to what it was when the trade was structured, so the whole
      // structure keeps the shape the trader drew even as the live venue spread drifts.
      execVenue: Venues.execVenue(),
      basisAtPlace: Venues.basisAbs(),
      execEntry: null,
      execFillPrice: null
    };
    syncOrderExecPrices(order);
    // Add to the chart's order list instead of replacing — multiple orders coexist. The opposite-side
    // guard (hedge mode) runs before this in the placement paths, so conflicting orders never get here
    // in one-way mode.
    orders.push(order);
    if (order.sl) applySlModePlacement(); // the placement gap is the trail distance
    if (useRiskSizing) syncQtyFromRisk(); // compute qty now if Expanded auto-attached an SL; no-op without one
    render();
  }

  // Chart right-click "Market Buy/Sell" trades go straight to a market fill (no pending entry chip), same as the Quick Trade panel's Market tab
  // The chart right-click Buy Market / Sell Market actions use their own default size, set in
  // Trade Defaults (positionDefaults.quickMarketSize), independent of the Quick Trade panel amount.
  function quickMarketSize() {
    const v = parseFloat(chartSettings.positionDefaults.quickMarketSize);
    return (v && v > 0) ? v : 1;
  }
  function fillQuickMarketOrder(side) {
    guardedPlace(side, () => {
      const currentPrice = (() => {
        const el = document.getElementById('hdrLast');
        return el ? parseFloat(el.textContent.replace(/,/g, '')) : BASE_PRICE;
      })();
      const details = {
        side,
        orderType: 'Market',
        amount: quickMarketSize() + ' ' + qtInstrumentUnit,
        leverage: qtLeverageForOrder(),
        price: '$' + fmt(currentPrice),
        chartPrice: currentPrice
      };
      requestOrderConfirmation(details, () => fillQuickMarketOrderExecute(side, currentPrice));
    });
  }
  // createOrder reads the shared qtyInput, so apply the quick-market default for the fill and
  // restore the panel's amount afterward (same bridge pattern as placeQuickMarketOrder below).
  function fillQuickMarketOrderExecute(side, currentPrice) {
    addOrCreateMarketFill(side, currentPrice, quickMarketSize());
  }

  // Bridge for the floating Quick Market Order bar (wired in js/overlays.js). Places a market
  // order at the live price using the amount typed in the bar, reusing the same confirmation +
  // fill path as the Quick Trade panel. createOrder reads the shared qtyInput, so set it inside
  // the confirm callback (the fill runs after the user confirms) and restore it afterward.
  window.placeQuickMarketOrder = function (side, amount) {
    guardedPlace(side, () => {
      const currentPrice = qtCurrentPrice();
      const amt = (amount != null && String(amount).trim() !== '') ? String(amount).trim() : '1';
      const details = {
        side,
        orderType: 'Market',
        amount: amt + ' ' + qtInstrumentUnit,
        leverage: qtLeverageForOrder(),
        price: '$' + fmt(currentPrice),
        chartPrice: currentPrice
      };
      requestOrderConfirmation(details, () => addOrCreateMarketFill(side, currentPrice, amt));
    });
  };

  /* ---------- Quick Trade panel ---------- */
  let qtInstrumentUnit = 'ETH';          // amount unit for the Quick Trade panel — reset per asset class on symbol switch
  const QT_FEE_PER_CONTRACT = 1.25;
  const QT_MAINT_MARGIN_RATE = 0.005; // mockup maintenance-margin rate for the Liq. Price estimate

  /* The Quick Trade panel reconfigures itself for the selected symbol's asset class:
       - marginMode  → show the Cross/Isolated toggle (a crypto-perp concept, crypto only)
       - leverage    → show the Leverage control (crypto perps + leveraged retail forex)
       - unit        → amount unit; crypto derives the coin from the symbol (see qtApplyAssetConfig)
       - quickAmounts → preset quantity pills for discrete-unit instruments (crypto uses the %/USD slider instead) */
  const QT_ASSET_CONFIG = {
    crypto: { marginMode: true, leverage: true, unit: 'ETH', quickAmounts: null },
    futures: { marginMode: false, leverage: false, unit: 'Contracts', quickAmounts: [1, 2, 5, 10, 20] },
    stocks: { marginMode: false, leverage: false, unit: 'Shares', quickAmounts: [1, 10, 50, 100, 500] },
    forex: { marginMode: false, leverage: true, unit: 'Lots', quickAmounts: [0.1, 0.5, 1, 2, 5] },
  };

  /* ---------- Level 1 quote ----------
     How wide the book is for an instrument. This is the quote's spread only — deliberately separate
     from the global TICK, which drives price rounding and every stop/target offset, so a realistic
     stock or futures book doesn't disturb order maths tuned around 0.25.

     Futures carry their contract's real tick; stocks quote in pennies; crypto and forex books are
     tighter than the 0.25 TICK the mock rounds prices to, and aren't bound to that grid anyway.
     Values are floored at 0.01 because prices render to two decimals. */
  const QUOTE_SPREAD_BY_CAT = { crypto: 0.05, forex: 0.05, stocks: 0.01, futures: 0.25 };
  const QUOTE_SPREAD_BY_SYMBOL = {
    ESU5: 0.25, NQU5: 0.25, YMU5: 1, RTYU5: 0.10,
    CLN5: 0.01, GCQ5: 0.10, SIN5: 0.01, ZBU5: 0.03, ZNU5: 0.02,
    ZCU5: 0.25, HGU5: 0.01, NGU5: 0.01, PLU5: 0.10, KCU5: 0.05,
    ZSU5: 0.25, ZWU5: 0.25, '6BU5': 0.01,
  };
  function quoteSpreadFor(sym) {
    if (QUOTE_SPREAD_BY_SYMBOL[sym]) return QUOTE_SPREAD_BY_SYMBOL[sym];
    const cat = symbolCategory(sym);
    return QUOTE_SPREAD_BY_CAT[cat] || TICK;
  }
  let qtAsset = QT_ASSET_CONFIG.crypto;  // current asset config — the panel defaults to ETHUSD (crypto)
  let qtCryptoMode = 'spot';             // crypto only: 'spot' (1×, no liquidation) or 'perp' (leverage + margin) — defaults to spot on launch
  function qtCurrentPrice() {
    const lastEl = document.getElementById('hdrLast');
    return lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : BASE_PRICE;
  }

  /* ---------- order type tabs (Limit / Market / advanced dropdown) ---------- */
  const qtOrderTabs = document.getElementById('qtOrderTabs');
  const qtBuyBtn = document.getElementById('qtBuyBtn');
  const qtSellBtn = document.getElementById('qtSellBtn');
  const QT_TAB_LABELS = { limit: 'Limit', market: 'Market' };
  const QT_ADVANCED_LABELS = { stopLimit: 'Stop Limit', mit: 'Trigger Market' };
  // Shorter text for the advanced tab pill only (space-constrained); the dropdown item and the
  // recorded order.orderType still read the full "Trigger Market" everywhere else.
  const QT_ADVANCED_TAB_LABELS = { stopLimit: 'Stop Limit', mit: 'Trigger' };
  let qtAdvancedType = 'stopLimit';
  // Price fields that snap back to the live market price each time their panel is shown, so a
  // revisited tab never offers a price the market has since walked away from. Fields left out are
  // not prices (qtMitSlippage) or have no input at all (the Market panel is a static label).
  // Stop Limit seeds both legs to the raw market price: the panel has no side yet — Buy/Sell is
  // chosen at placement — so there is no direction to offset the stop and limit around.
  const QT_SEEDED_PRICE_IDS = {
    limit: ['qtLimitPrice'],
    stopLimit: ['qtStopLimitTrigger', 'qtStopLimitPrice'],
    mit: ['qtMitTrigger'],
  };

  /* ---------- BBO (best bid / offer) ----------
     BBO is a placement rule, not a price: buying takes the best ask, selling takes the best bid, so
     each side is priced at the quote it actually trades against. The direction isn't
     known while the trader is deciding — Buy and Sell are both the submit action — so the field can't
     show a single honest number. With BBO on it states the rule instead, and the Buy/Sell buttons carry
     the live price for each side. Typing a price is how you opt out: the toggle flips off and the
     typed price is used verbatim. With BBO off the field tracks the last traded price instead.

     The toggle is per-order and isn't persisted — every session starts with BBO off. It is one
     setting shared by every panel that rests a limit price (see QT_BBO_FIELDS), so switching between
     them doesn't quietly change how the order will be placed. */
  const qtLimitPriceInput = document.getElementById('qtLimitPrice');
  const qtBuySellRow = document.getElementById('qtBuySellRow');
  let qtBboEnabled = false;
  let qtLimitPriceEdited = false;

  /* The resting limit price of each panel that has one: the Limit tab's price and the limit leg of a
     Stop Limit. Market has no price field and Trigger Market prices off a trigger the trader sets, so
     neither takes a BBO toggle. */
  const QT_BBO_FIELDS = {
    limit: { inputId: 'qtLimitPrice', rowSel: '#qtTabPanel-limit .qt-bbo-price-row' },
    stopLimit: { inputId: 'qtStopLimitPrice', rowSel: '#qtTabPanel-stopLimit .qt-bbo-price-row' },
  };

  /* Every trade prints at one side of the book or the other: a buyer lifting the offer prints at the
     ask, a seller hitting the bid prints at the bid. So the last price is pinned to whichever side the
     tape last moved towards, and the other side sits one spread away. That keeps both quotes on the
     instrument's own price grid — a straddle around the last price would put ES on half-ticks — and
     makes the strip visibly alternate as the tape moves, the way a real Level 1 quote does. */
  let qtTapeLiftedOffer = true; // last print was an up-tick (hit the ask)
  function qtBestAsk() {
    const last = qtCurrentPrice();
    return qtTapeLiftedOffer ? last : last + quoteSpreadFor(currentSymbol());
  }
  function qtBestBid() {
    const last = qtCurrentPrice();
    return qtTapeLiftedOffer ? last - quoteSpreadFor(currentSymbol()) : last;
  }
  /* The chart venue's own book. Kept separate from the executable quote below so the
     instrument's spread rules live in exactly one place. */
  function qtChartBbo(side) { return side === 'buy' ? qtBestAsk() : qtBestBid(); }
  /* What the order will actually trade against. BBO is an execution rule, so it has to be
     priced on the execution venue — on a single-venue chart this is the same number. */
  function qtBboPriceFor(side) {
    return Venues.execBbo ? Venues.execBbo(side) : qtChartBbo(side);
  }
  if (window.TTVenues) window.TTVenues.configureBbo(qtChartBbo);

  function qtActivePanelName() {
    const panel = document.querySelector('.qt-tab-panel.active');
    return panel ? panel.dataset.tabPanel : null;
  }
  function qtLimitTabActive() { return qtActivePanelName() === 'limit'; }
  /* The limit price BBO governs right now, or null on a panel that doesn't rest one. */
  function qtBboFieldId() {
    const field = QT_BBO_FIELDS[qtActivePanelName()];
    return field ? field.inputId : null;
  }
  function qtBboActive() { return qtBboEnabled && !!qtBboFieldId(); }

  function qtSetBboEnabled(on) {
    qtBboEnabled = !!on;
    const input = document.getElementById(qtBboFieldId());
    if (qtBboEnabled) {
      if (input) input.value = '';
      qtLimitPriceEdited = false;
    } else if (input && !input.value) {
      // Coming off BBO with an empty field: hand the trader the last traded price to edit from.
      input.value = fmt(roundTick(qtCurrentPrice()));
    }
    qtRefreshBboUi();
  }

  /* Paints everything BBO controls: both toggles, each field's read-only state, and the Buy/Sell
     buttons. Every BBO field is painted, not just the visible one, so a panel switch reveals a field
     that already matches the setting. */
  function qtRefreshBboUi() {
    document.querySelectorAll('.qt-bbo-btn').forEach(btn => {
      btn.classList.toggle('active', qtBboEnabled);
      btn.setAttribute('aria-pressed', String(qtBboEnabled));
    });
    Object.keys(QT_BBO_FIELDS).forEach(name => {
      const field = QT_BBO_FIELDS[name];
      const row = document.querySelector(field.rowSel);
      const input = document.getElementById(field.inputId);
      if (row) row.classList.toggle('bbo-on', qtBboEnabled);
      if (!input) return;
      input.readOnly = qtBboEnabled;
      // "Best Bid / Ask" states the rule BBO applies — with BBO off an empty field is just an empty field.
      input.placeholder = qtBboEnabled ? 'Best Bid / Ask' : 'Limit price';
    });
    qtBuySellRow.classList.toggle('bs-row--bbo', qtBboActive());
    qtRefreshBboButtonPrices();
  }

  function qtRefreshBboButtonPrices() {
    if (!qtBboActive()) return;
    const price = qtCurrentPrice();
    if (isNaN(price)) return;
    document.getElementById('qtBuyBtnPrice').textContent = fmt(qtBboPriceFor('buy'));
    document.getElementById('qtSellBtnPrice').textContent = fmt(qtBboPriceFor('sell'));
  }

  /* With BBO off, the field tracks the last traded price until the trader takes it over. */
  function qtSyncLimitPanelPrices() {
    qtRefreshBboButtonPrices();
    if (qtBboEnabled || qtLimitPriceEdited || !qtLimitTabActive()) return;
    if (document.activeElement === qtLimitPriceInput) return;
    const price = qtCurrentPrice();
    if (!isNaN(price)) qtLimitPriceInput.value = fmt(roundTick(price));
  }

  function qtSetTapeDirection(up) { qtTapeLiftedOffer = up; }

  /* ---------- quote strip ---------- */
  /* The quote a trader clicks to price an order, so it quotes the venue the order goes to. */
  function qtRefreshQuoteStrip() {
    if (isNaN(qtCurrentPrice())) return;
    document.getElementById('qtQuoteBidVal').textContent = fmt(qtBboPriceFor('sell'));
    document.getElementById('qtQuoteAskVal').textContent = fmt(qtBboPriceFor('buy'));
  }

  /* Every instrument with a book has a best bid and ask — spot included — so the quote shows on any
     tab that prices off the book; only the spread behind it changes per symbol (see quoteSpreadFor). */

  /* Market and Trigger Market both fill at whatever the book offers when they fire, so a bid/ask
     caption would be quoting a price the order never uses. Those panels hide the quote line. */
  const QT_PANELS_WITHOUT_QUOTE = ['market', 'mit'];
  const qtQuoteLine = document.querySelector('.qt-quote-line');

  function qtRefreshQuoteLineVisibility(panelName) {
    qtQuoteLine.hidden = QT_PANELS_WITHOUT_QUOTE.includes(panelName);
  }

  /* The price field a clicked quote should land in: the one the trader is already working in. Market
     has no price field of its own, so a click there means "make this a limit order at that price". */
  function qtQuotePriceTarget() {
    const tab = qtActiveTab();
    if (tab === 'limit') return qtLimitPriceInput;
    if (tab === 'advanced') return document.getElementById(QT_ADVANCED_ENTRY_IDS[qtAdvancedType]);
    return null;
  }

  /* Clicking a side of the quote is asking to trade at that price. On the Limit tab that also means
     leaving BBO — a rule — for a price the trader picked themselves. */
  function qtUseQuotePrice(price) {
    let input = qtQuotePriceTarget();
    if (!input) {
      qtSetActiveTab('limit');
      input = qtLimitPriceInput;
    }
    if (input.disabled) return;
    if (input === qtLimitPriceInput) {
      if (qtBboEnabled) qtSetBboEnabled(false);
      qtLimitPriceEdited = true;
    }
    input.value = fmt(price);
  }
  /* The strip quotes the execution venue's book, but the field it fills is a level on this chart —
     so a click lands the chart price that translates to the quote the trader just took. */
  document.getElementById('qtQuoteBid').addEventListener('click', () => qtUseQuotePrice(qtChartBbo('sell')));
  document.getElementById('qtQuoteAsk').addEventListener('click', () => qtUseQuotePrice(qtChartBbo('buy')));

  document.querySelectorAll('.qt-bbo-btn')
    .forEach(btn => btn.addEventListener('click', () => qtSetBboEnabled(!qtBboEnabled)));

  /* Typing a price is opting out of the rule, so reaching for a BBO field turns BBO off rather than
     silently ignoring the keystrokes against a read-only input. Same for its steppers. */
  Object.keys(QT_BBO_FIELDS).forEach(name => {
    const inputId = QT_BBO_FIELDS[name].inputId;
    const input = document.getElementById(inputId);
    const leaveBbo = () => { if (qtBboEnabled) qtSetBboEnabled(false); };
    if (input) {
      input.addEventListener('mousedown', leaveBbo);
      input.addEventListener('focus', leaveBbo);
    }
    document.querySelectorAll('.ps-up[data-target="' + inputId + '"], .ps-down[data-target="' + inputId + '"]')
      .forEach(btn => btn.addEventListener('click', leaveBbo));
  });
  // Only the Limit tab's price tracks the market until it's taken over, so only it tracks edits.
  qtLimitPriceInput.addEventListener('input', () => { qtLimitPriceEdited = true; });
  document.querySelectorAll('.ps-up[data-target="qtLimitPrice"], .ps-down[data-target="qtLimitPrice"]')
    .forEach(btn => btn.addEventListener('click', () => { qtLimitPriceEdited = true; }));

  function qtSeedPanelPrices(panelName) {
    const mkt = qtCurrentPrice();
    if (isNaN(mkt)) return; // no live price to read yet — leave the field alone rather than write "NaN"
    const price = fmt(roundTick(mkt));
    (QT_SEEDED_PRICE_IDS[panelName] || []).forEach(id => {
      const input = document.getElementById(id);
      if (!input) return;
      // The BBO field holds no price of its own — leave it empty so the rule stays readable.
      const bboField = QT_BBO_FIELDS[panelName];
      const isBboField = !!bboField && bboField.inputId === id;
      input.value = (isBboField && qtBboEnabled) ? '' : price;
    });
    if (panelName === 'limit') qtLimitPriceEdited = false;
  }
  function qtSetActiveTab(tabName) {
    const panelName = tabName === 'advanced' ? qtAdvancedType : tabName;
    qtOrderTabs.querySelectorAll('.qt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.qt-tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.tabPanel === panelName);
    });
    qtSeedPanelPrices(panelName);
    qtRefreshQuoteLineVisibility(panelName);
    const lbl = QT_TAB_LABELS[tabName] || QT_ADVANCED_LABELS[qtAdvancedType] || 'Market';
    qtBuyBtn.querySelector('.bs-lbl').textContent = 'Buy ' + lbl;
    qtSellBtn.querySelector('.bs-lbl').textContent = 'Sell ' + lbl;
    qtRefreshBboUi();
  }
  qtOrderTabs.querySelectorAll('.qt-tab:not(.qt-tab-dropdown)').forEach(tab => {
    tab.addEventListener('click', () => qtSetActiveTab(tab.dataset.tab));
  });
  qtSetActiveTab('limit');
  qtSetBboEnabled(false); // the panel opens with an ordinary typable limit price; BBO is opted into

  /* ---------- advanced order type dropdown (Stop Limit / Trigger Market) ---------- */
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
      qtAdvancedTabLabel.textContent = QT_ADVANCED_TAB_LABELS[qtAdvancedType];
      closeAllPopovers();
      qtSetActiveTab('advanced');
    });
  });

  /* Price fields are typed into constantly, so the browser builds up a history for them and offers it
     back as an autofill dropdown over the panel. These are live market prices, not saved form data —
     a remembered value is never the one you want. */
  document.querySelectorAll('.price-stepper input').forEach(input => {
    input.setAttribute('autocomplete', 'off');
  });

  /* ---------- generic price stepper arrows (Stop / Limit / Trailing Delta / Trigger / Activation fields) ---------- */
  const QT_SLIPPAGE_IDS = ['qtMitSlippage'];
  document.querySelectorAll('.price-stepper-arrows .ps-up, .price-stepper-arrows .ps-down').forEach(btn => {
    btn.addEventListener('click', () => {
      /* position close fields are handled by their own delegated stepper in the positions panel */
      if (btn.closest('.pos-detail-close')) return;
      const input = document.getElementById(btn.dataset.target);
      if (!input || input.disabled) return;
      const isSlippage = QT_SLIPPAGE_IDS.includes(input.id);
      const dataStep = input.dataset.step ? parseFloat(input.dataset.step) : null;
      const step = dataStep !== null ? dataStep : input.id === 'qtTrailDelta' ? 0.1 : isSlippage ? 0.05 : 0.25;
      const min = isSlippage ? 0.1 : 0;
      const cur = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
      const next = btn.classList.contains('ps-up') ? cur + step : Math.max(min, cur - step);
      const decimals = input.dataset.decimals ? parseInt(input.dataset.decimals, 10) : null;
      if (decimals !== null) {
        input.value = next.toFixed(decimals);
      } else if (dataStep !== null) {
        input.value = Number.isInteger(step) ? String(Math.round(next)) : next.toFixed(2);
      } else {
        input.value = input.id === 'qtTrailDelta' ? next.toFixed(1) : isSlippage ? next.toFixed(2) : fmt(next);
      }
    });
  });

  /* ensure all data-step stepper inputs accept typed values */
  document.querySelectorAll('.price-stepper input[data-step]').forEach(input => {
    /* position close fields keep their own decimals/units; skip the QT snap-to-step rule */
    if (input.closest('.pos-detail-close')) return;
    input.addEventListener('change', () => {
      const step = parseFloat(input.dataset.step) || 1;
      const v = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
      const decimals = input.dataset.decimals ? parseInt(input.dataset.decimals, 10) : null;
      /* fields that allow decimals keep the typed precision instead of snapping to step */
      if (decimals !== null) {
        input.value = Math.max(0, v).toFixed(decimals);
        return;
      }
      const snapped = Math.round(v / step) * step;
      input.value = Number.isInteger(step) ? String(Math.max(0, Math.round(snapped))) : Math.max(0, snapped).toFixed(2);
    });
  });

  /* ---------- press-and-hold auto-repeat for every stepper arrow ----------
     One delegated handler covers all stepper variants (Quick Trade, positions panel, chart
     settings, order-line edit) without touching their per-button step logic: while a .ps-up /
     .ps-down is held past 400ms, re-fire its click every 90ms. A single tap still steps once
     via the native click; keyboard (Enter/Space) is unaffected. */
  (function () {
    let holdTimer, repeatTimer;
    const stopRepeat = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); };
    document.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // left button / touch only
      const btn = e.target.closest('.ps-up, .ps-down');
      if (!btn) return;
      holdTimer = setTimeout(() => {
        repeatTimer = setInterval(() => {
          if (!document.contains(btn)) { stopRepeat(); return; } // row/menu closed mid-hold
          btn.click();
        }, 90);
      }, 400);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => document.addEventListener(ev, stopRepeat));
  })();

  /* ---------- Margin mode + leverage controls ----------
     Two full-width buttons above the order tabs: the Cross/Isolated button flips
     margin mode on click; the Leverage button opens a popup with the slider/presets.
     Both feed the single source of truth read back into every order-confirmation dialog. */
  const qtMarginBar = document.getElementById('qtMarginBar');
  const qtModeToggle = document.getElementById('qtModeToggle');
  const qtMarginModeBtn = document.getElementById('qtMarginModeBtn');
  const qtMarginModeLabel = document.getElementById('qtMarginModeLabel');
  const qtLeverageBtn = document.getElementById('qtLeverageBtn');
  const qtLeverageBtnVal = document.getElementById('qtLeverageBtnVal');
  const qtMarginMenu = document.getElementById('qtMarginMenu');
  const qtLevInput = document.getElementById('qtLevInput');
  const qtLevSlider = document.getElementById('qtLevSlider');
  const qtLevPresets = document.getElementById('qtLevPresets');
  const QT_MIN_LEVERAGE = parseInt(qtLevSlider.min, 10) || 1;
  const QT_MAX_LEVERAGE = parseInt(qtLevSlider.max, 10) || 100;

  function qtLeverageValue() {
    return parseInt(qtLevSlider.value, 10) || QT_MIN_LEVERAGE;
  }
  function qtMarginMode() {
    return qtMarginModeBtn.dataset.mode || 'cross';
  }
  /* value shown on the leverage row of the order-confirmation dialog */
  function qtLeverageDetail() {
    return qtLeverageValue() + '×';
  }
  /* Leverage only makes sense for crypto perps and forex — suppress the confirmation
     dialog's leverage row for cash stocks, exchange-margined futures, and crypto spot. */
  function qtLeverageForOrder() {
    if (qtAsset.marginMode && qtCryptoMode === 'spot') return null; // spot = 1×, no leverage
    return qtAsset.leverage ? qtLeverageDetail() : null;
  }
  /* Whether leverage-driven summary stats (Cost, Liq. Price, Max) apply — the asset must
     support leverage (crypto perp / forex) AND actually be leveraged (>1×). At 1× there is
     no liquidation and cost equals value, so the extra rows add nothing. */
  function qtLeverageApplies() {
    return qtAsset.leverage
      && !(qtAsset.marginMode && qtCryptoMode === 'spot')
      && qtLeverageValue() > 1;
  }
  /* Quote currency shown next to panel amounts/prices — crypto settles in USDT, everything
     else in USD. (marginMode is crypto-only, so it doubles as the crypto check.) */
  function qtQuoteCurrency() {
    return qtAsset.marginMode ? 'USDT' : 'USD';
  }

  /* keep the leverage button, editable input, slider fill and preset highlight in sync.
     writeInput is skipped while the user is typing in the field so we don't fight them. */
  function qtSyncLeverageUI(writeInput = true) {
    const lev = qtLeverageValue();
    qtLeverageBtnVal.textContent = lev + '×';
    if (writeInput) qtLevInput.value = lev;
    fillRangeSlider(qtLevSlider);
    qtLevPresets.querySelectorAll('.qt-lev-chip').forEach(chip => {
      chip.classList.toggle('active', parseInt(chip.dataset.lev, 10) === lev);
    });
  }

  /* Cross/Isolated toggles directly on click */
  qtMarginModeBtn.addEventListener('click', () => {
    const next = qtMarginMode() === 'cross' ? 'isolated' : 'cross';
    qtMarginModeBtn.dataset.mode = next;
    qtMarginModeLabel.textContent = next === 'cross' ? 'Cross' : 'Isolated';
    qtUpdateEstimates(); // margin mode changes the Liq. Price
  });

  /* Fill the margin bar for the current asset + crypto Spot/Perp mode. Spot hides Cross +
     Leverage, leaving just the toggle (spot is always 1×, so no extra info is needed). */
  function qtApplyMarginMode(cfg) {
    cfg = cfg || qtAsset;
    const spot = cfg.marginMode && qtCryptoMode === 'spot';
    qtMarginModeBtn.hidden = !cfg.marginMode || spot; // Cross/Isolated: crypto perp only
    qtLeverageBtn.hidden = !cfg.leverage || spot;     // Leverage: crypto perp + forex
    qtModeToggle.querySelectorAll('.qt-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === (spot ? 'spot' : 'perp'));
    });
  }

  /* Spot/Perp toggle (crypto only) */
  qtModeToggle.querySelectorAll('.qt-mode-btn').forEach(b => {
    b.addEventListener('click', () => {
      qtCryptoMode = b.dataset.mode;
      qtApplyMarginMode();
      qtUpdateEstimates(); // Spot hides the leverage stats; Perp reveals them
    });
  });

  /* Leverage opens the popup */
  qtLeverageBtn.addEventListener('click', () => {
    openNear(qtMarginMenu, qtLeverageBtn.getBoundingClientRect(), 'right', qtLeverageBtn);
  });

  qtLevSlider.addEventListener('input', () => { qtSyncLeverageUI(); qtUpdateEstimates(); });

  qtLevPresets.querySelectorAll('.qt-lev-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      qtLevSlider.value = chip.dataset.lev;
      qtSyncLeverageUI();
      qtUpdateEstimates();
    });
  });

  /* custom typed leverage — keep only digits, drive the slider live without
     reformatting the field mid-keystroke, then clamp/normalize on blur or Enter */
  qtLevInput.addEventListener('input', () => {
    const digits = qtLevInput.value.replace(/[^\d]/g, '');
    if (qtLevInput.value !== digits) qtLevInput.value = digits;
    if (digits === '') return;
    const clamped = Math.min(QT_MAX_LEVERAGE, Math.max(QT_MIN_LEVERAGE, parseInt(digits, 10)));
    qtLevSlider.value = clamped;
    qtSyncLeverageUI(false);
    qtUpdateEstimates();
  });
  function qtCommitLeverageInput() {
    const parsed = parseInt(qtLevInput.value, 10);
    const clamped = isNaN(parsed) ? qtLeverageValue()
      : Math.min(QT_MAX_LEVERAGE, Math.max(QT_MIN_LEVERAGE, parsed));
    qtLevSlider.value = clamped;
    qtSyncLeverageUI();
    qtUpdateEstimates();
  }
  qtLevInput.addEventListener('change', qtCommitLeverageInput);
  qtLevInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { qtCommitLeverageInput(); qtLevInput.blur(); }
  });

  qtSyncLeverageUI();

  function qtPlaceOrder(side, price) {
    guardedPlace(side, () => {
      const { qty } = qtComputeAmount();
      const amount = Math.max(1, Math.round(qty));
      const tab = qtActiveTab();
      const details = {
        side,
        orderType: QT_TAB_LABELS[tab] || QT_ADVANCED_LABELS[qtAdvancedType] || 'Market',
        amount: amount + ' ' + qtInstrumentUnit,
        leverage: qtLeverageForOrder(),
        price: '$' + fmt(price),
        chartPrice: price
      };
      requestOrderConfirmation(details, () => qtPlaceOrderExecute(side, price, amount, tab));
    });
  }
  function qtPlaceOrderExecute(side, price, amount, tab) {
    // Market tab: add to an existing same-side position (or open a fresh one) — never a duplicate.
    if (tab === 'market') { addOrCreateMarketFill(side, price, amount); return; }
    const prevVal = qtyInput.value;
    qtyInput.value = amount;
    createOrder(side, price, 'quick');
    if (order && tab === 'limit') order.orderType = 'Limit';
    if (order && tab === 'advanced') {
      // Honor the explicit advanced selection instead of the direction-inferred type from createOrder
      order.orderType = QT_ADVANCED_LABELS[qtAdvancedType]; // 'Stop Limit' | 'Trigger Market'
      // Capture the slippage tolerance (Trigger Market only) so the fill can slip past the trigger
      const slipId = qtAdvancedType === 'mit' ? 'qtMitSlippage' : null;
      if (slipId) {
        const slipEl = document.getElementById(slipId);
        order.slippageTol = slipEl ? (parseFloat((slipEl.value || '').replace(/,/g, '')) || 0) : 0; // percent, e.g. 0.10
      }
      // Stop Limit: the entry is the limit/fill price (the Price field, already used as the entry
      // via qtActivePrice); capture the Stop field as the trigger and arm it from the current side.
      if (qtAdvancedType === 'stopLimit') {
        const trigEl = document.getElementById('qtStopLimitTrigger');
        const trig = trigEl ? parseFloat((trigEl.value || '').replace(/,/g, '')) : NaN;
        order.triggerPrice = roundTick(isNaN(trig) ? order.entry : trig);
        order.fillAbove = order.triggerPrice > qtCurrentPrice();
        order.stopTriggered = false;
      }
    }
    // createOrder already rendered with its direction-inferred type; re-render so the corrected
    // type shows on the working-order pill (the market tab returned early via addOrCreateMarketFill).
    if (order && !order.filled && (tab === 'limit' || tab === 'advanced')) render();
    qtyInput.value = prevVal;
  }
  function qtActiveTab() {
    const active = qtOrderTabs.querySelector('.qt-tab.active');
    return active ? active.dataset.tab : 'market';
  }
  // The price createOrder uses as the entry line: for Stop Limit that's the limit/fill (Price field);
  // for Trigger Market it's the trigger; for a plain Limit it's the limit price.
  const QT_ADVANCED_ENTRY_IDS = { stopLimit: 'qtStopLimitPrice', mit: 'qtMitTrigger' };
  function qtActivePrice() {
    const tab = qtActiveTab();
    if (tab === 'limit') {
      const val = parseFloat(document.getElementById('qtLimitPrice').value.replace(/,/g, ''));
      return isNaN(val) ? qtCurrentPrice() : val;
    }
    if (tab === 'advanced') {
      const inputId = QT_ADVANCED_ENTRY_IDS[qtAdvancedType];
      const input = document.getElementById(inputId);
      const val = input && !input.disabled ? parseFloat((input.value || '').replace(/,/g, '')) : NaN;
      return isNaN(val) ? qtCurrentPrice() : val;
    }
    return qtCurrentPrice();
  }
  /* The entry price a Buy/Sell click places at. The click is the first moment the direction is known,
     which is where BBO resolves to that side's best price — the same quote shown on the button.
     Deliberately the chart-space price: everything the trader authors is a level on this chart, and
     the venue translation is applied when the order is recorded and shown, not here. */
  function qtEntryPrice(side) {
    return qtBboActive() ? qtChartBbo(side) : qtActivePrice();
  }
  /* Clearing the field with BBO off leaves nothing to place at, and qtActivePrice would quietly fall
     back to the market price — a price the trader never chose. Ask for one instead. Covers every
     panel that rests a limit price, so a blank Stop Limit leg is caught the same way. */
  function qtLimitPriceMissing() {
    if (qtBboEnabled) return false;
    const input = document.getElementById(qtBboFieldId());
    if (!input) return false;
    const raw = input.value.replace(/,/g, '').trim();
    if (raw !== '' && !isNaN(parseFloat(raw))) return false;
    showToast('Enter a limit price', 'error');
    return true;
  }
  qtBuyBtn.addEventListener('click', () => { if (!qtLimitPriceMissing()) qtPlaceOrder('buy', qtEntryPrice('buy')); });
  qtSellBtn.addEventListener('click', () => { if (!qtLimitPriceMissing()) qtPlaceOrder('sell', qtEntryPrice('sell')); });
  /* the symbol currently shown in the top-bar selector — Close/Cancel All are scoped to it */
  function currentSymbol() {
    const el = document.getElementById('symSelectLabel');
    return el ? el.textContent.trim() : '';
  }
  document.getElementById('qtFlatten').addEventListener('click', () => {
    const sym = currentSymbol();
    let closedRow = false;
    // Close every filled chart order for ETHUSD (each cancelOrder logs it, closes its row + toasts).
    const closedChart = sym === 'ETHUSD' && allOrders().some(o => o.filled);
    if (sym === 'ETHUSD') allOrders().filter(o => o.filled).forEach(o => { order = o; cancelOrder(); });
    // Close any positions-tab rows for this symbol (static or graduated; both long and short sides).
    while (window.closePositionPct(sym, 100)) closedRow = true;
    if (closedRow) showToast(sym + ' position closed', 'check_circle');
    else if (!closedChart) showToast('No open ' + sym + ' positions to close', 'info');
  });
  document.getElementById('qtCancelAll').addEventListener('click', () => {
    const sym = currentSymbol();
    // Cancel every pending (unfilled) chart order for ETHUSD; each shows its own "cancelled" toast.
    const pending = sym === 'ETHUSD' ? allOrders().filter(o => !o.filled) : [];
    if (pending.length) pending.forEach(o => { order = o; cancelOrder(); });
    else showToast('No pending ' + sym + ' orders to cancel', 'info');
  });
  /* ---------- amount type (Units / USD / % of Balance) ---------- */
  const QT_MODES = {
    Units: { unit: qtInstrumentUnit, label: 'Units', step: 1, default: '1' },
    USD: { unit: 'USD', label: 'USD Amount', step: 50, default: '100' },
    '% of Balance': { unit: '%', label: '% of Balance', step: 5, default: '10' },
  };
  let qtAmountMode = 'Units';
  const qtAmountInput = document.getElementById('qtAmountInput');
  const qtAmountLabel = document.getElementById('qtAmountLabel');
  const qtQtyUnit = document.getElementById('qtQtyUnit');
  const qtSlider = document.getElementById('qtSlider');
  const qtSliderWrap = document.getElementById('qtSliderWrap');
  const qtSliderBubble = document.getElementById('qtSliderBubble');
  const qtEstSize = document.getElementById('qtEstSize');
  const qtEstValue = document.getElementById('qtEstValue');
  const qtEstFees = document.getElementById('qtEstFees');
  const qtLeverageSummary = document.getElementById('qtLeverageSummary');
  const qtCost = document.getElementById('qtCost');
  const qtLiqPrice = document.getElementById('qtLiqPrice');
  const qtAvailable = document.getElementById('qtAvailable');

  function qtModeMax(mode) {
    const price = qtCurrentPrice() || 1;
    if (mode === 'Units') return Math.max(0.01, ACCOUNT_BALANCE / price);
    if (mode === 'USD') return ACCOUNT_BALANCE;
    return 100;
  }
  function qtComputeAmount() {
    const amt = Math.max(0, parseFloat(qtAmountInput.value) || 0);
    const price = qtCurrentPrice() || 1;
    if (qtAmountMode === 'Units') return { qty: amt, usdValue: amt * price };
    if (qtAmountMode === 'USD') return { qty: amt / price, usdValue: amt };
    const usdValue = ACCOUNT_BALANCE * (amt / 100);
    return { qty: usdValue / price, usdValue };
  }
  function qtFmtQty(q) {
    return q.toFixed(2);
  }
  function qtSliderFill(pct) {
    qtSlider.style.background = 'linear-gradient(to right, var(--text-secondary) 0%, var(--text-secondary) ' + pct + '%, var(--border-default) ' + pct + '%, var(--border-default) 100%)';
  }
  // Position the percentage bubble over the thumb centre. The thumb (16px wide)
  // travels from 8px to (trackWidth - 8px), so map the value across that range.
  function qtUpdateSliderBubble() {
    const pct = parseInt(qtSlider.value, 10);
    qtSliderBubble.textContent = pct + '%';
    const thumbWidth = 16;
    const trackWidth = qtSlider.offsetWidth;
    const usable = trackWidth - thumbWidth;
    qtSliderBubble.style.left = (thumbWidth / 2 + usable * pct / 100) + 'px';
  }
  function qtUpdateEstimates(syncSlider) {
    const { qty, usdValue } = qtComputeAmount();
    const qtyDisp = qtFmtQty(qty);
    const quote = qtQuoteCurrency(); // 'USD' or 'USDT' — no dollar sign, just the code
    qtEstSize.textContent = qtyDisp + ' ' + qtInstrumentUnit;
    qtEstValue.textContent = fmt(usdValue) + ' ' + quote;
    qtEstFees.textContent = fmt(Math.max(0, qty) * QT_FEE_PER_CONTRACT) + ' ' + quote;
    qtAvailable.textContent = fmt(ACCOUNT_BALANCE) + ' ' + quote;

    // Leverage-driven stats: Cost (margin posted) and Liq. Price.
    const applies = qtLeverageApplies();
    qtLeverageSummary.hidden = !applies;
    if (applies) {
      const lev = qtLeverageValue();
      const price = qtCurrentPrice() || 1;
      const fees = Math.max(0, qty) * QT_FEE_PER_CONTRACT;
      const margin = usdValue / lev + fees;            // collateral actually posted
      // Liq. Price assumes a Long (Buy is the primary side; no side is committed while
      // the form is open). Isolated liquidates off just the position margin (drop);
      // Cross backs the position with free balance, pushing the liq further from entry.
      // The cross cushion is bounded so the estimate stays a sane positive number.
      const drop = (1 / lev) - QT_MAINT_MARGIN_RATE; // fractional distance entry → liq
      let cushion = 0;
      if (qtMarginMode() === 'cross' && usdValue > 0) {
        cushion = Math.min(drop, (ACCOUNT_BALANCE / usdValue) * QT_MAINT_MARGIN_RATE * lev);
      }
      const liq = price * (1 - drop - cushion);
      qtCost.textContent = fmt(margin) + ' ' + quote;
      qtLiqPrice.textContent = liq > 0 ? fmt(liq) + ' ' + quote : '—';
    }
    if (syncSlider !== false) {
      const max = qtModeMax(qtAmountMode) || 1;
      const amt = Math.max(0, parseFloat(qtAmountInput.value) || 0);
      qtSlider.value = Math.min(100, Math.round(amt / max * 100));
    }
    qtSliderFill(parseInt(qtSlider.value, 10));
    qtUpdateSliderBubble();
  }
  // Convert a USD value into the amount shown for a given mode — the inverse of qtComputeAmount.
  function qtAmountForMode(usdValue, mode) {
    const price = qtCurrentPrice() || 1;
    if (mode === 'Units') return parseFloat((usdValue / price).toFixed(2));
    if (mode === 'USD') return Math.max(0, Math.round(usdValue));
    return Math.max(0, parseFloat((usdValue / ACCOUNT_BALANCE * 100).toFixed(1))); // % of Balance
  }
  function qtSetAmountMode(mode) {
    // Preserve the entered value across modes by converting through its USD value
    // (captured before the mode flips) instead of resetting to the mode's default.
    const { usdValue } = qtComputeAmount();
    qtAmountMode = mode;
    const cfg = QT_MODES[mode];
    qtAmountLabel.textContent = cfg.label;
    qtQtyUnit.textContent = cfg.unit;
    qtAmountInput.value = qtAmountForMode(usdValue, mode);
    qtUpdateEstimates();
  }

  const qtAmountTypeTrigger = document.getElementById('qtAmountTypeTrigger');
  const qtAmountTypeMenu = document.getElementById('qtAmountTypeMenu');
  qtAmountTypeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    qtAmountTypeMenu.querySelectorAll('.pop-item').forEach(it => {
      it.classList.toggle('selected', it.dataset.amountType === qtAmountMode);
    });
    openNear(qtAmountTypeMenu, qtAmountTypeTrigger.getBoundingClientRect(), 'left', qtAmountTypeTrigger);
  });
  qtAmountTypeMenu.querySelectorAll('.pop-item').forEach(it => {
    it.addEventListener('click', () => {
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
    qtAmountInput.value = qtAmountMode === 'Units' ? parseFloat(raw.toFixed(2)) : Math.max(0, Math.round(raw));
    qtUpdateEstimates(false);
  });
  // Keep the bubble visible while dragging, even if the pointer leaves the track.
  qtSlider.addEventListener('pointerdown', () => qtSliderWrap.classList.add('dragging'));
  window.addEventListener('pointerup', () => qtSliderWrap.classList.remove('dragging'));
  qtUpdateEstimates();

  /* ---------- preset amount pills + per-asset panel reconfiguration ---------- */
  const qtQuickAmounts = document.getElementById('qtQuickAmounts');

  /* Render the preset quantity pills for the current asset (or clear them for crypto). */
  function qtRenderQuickAmounts(amounts) {
    if (!amounts || !amounts.length) {
      qtQuickAmounts.hidden = true;
      qtQuickAmounts.innerHTML = '';
      return;
    }
    qtQuickAmounts.hidden = false;
    qtQuickAmounts.innerHTML = amounts
      .map(a => '<button type="button" class="qt-quick-amount" data-amt="' + a + '">' + a + '</button>')
      .join('');
  }

  /* Preset pills are absolute quantities, so clicking one forces Units amount type. */
  qtQuickAmounts.addEventListener('click', (e) => {
    const btn = e.target.closest('.qt-quick-amount');
    if (!btn) return;
    if (qtAmountMode !== 'Units') qtSetAmountMode('Units');
    qtAmountInput.value = btn.dataset.amt;
    qtQuickAmounts.querySelectorAll('.qt-quick-amount').forEach(b => b.classList.toggle('active', b === btn));
    qtUpdateEstimates();
  });

  /* Reconfigure the panel for the selected symbol's asset class. Called from switchSymbol. */
  function qtApplyAssetConfig(sym) {
    const cat = symbolCategory(sym);
    const cfg = QT_ASSET_CONFIG[cat] || QT_ASSET_CONFIG.crypto;
    qtAsset = cfg;
    // Crypto shows the coin (ETHUSD → ETH); the others use a fixed unit label.
    qtInstrumentUnit = cat === 'crypto' ? (sym.replace(/USDT?$/, '') || 'ETH') : cfg.unit;
    QT_MODES.Units.unit = qtInstrumentUnit;

    // Margin controls: hide the whole bar when neither applies. The Spot/Perp toggle is
    // crypto-only; qtApplyMarginMode fills in Cross/Leverage vs the spot hint.
    const anyMargin = cfg.marginMode || cfg.leverage;
    qtMarginBar.hidden = !anyMargin;
    qtModeToggle.hidden = !cfg.marginMode;
    // Note: qtCryptoMode (Spot/Perp) persists across symbol switches — changing symbol
    // keeps the user's chosen mode rather than resetting it. It defaults to spot on launch.
    qtApplyMarginMode(cfg);

    qtRefreshQuoteStrip(); // the new symbol's book is a different width

    qtRenderQuickAmounts(cfg.quickAmounts);

    // Price-input unit labels track the instrument's quote currency (USD / USDT).
    document.querySelectorAll('.qt-quote-unit').forEach(el => { el.textContent = qtQuoteCurrency(); });

    // Refresh the amount unit + estimates for the new instrument.
    if (qtAmountMode === 'Units') qtQtyUnit.textContent = qtInstrumentUnit;
    qtUpdateEstimates();
  }

  function cancelOrder() {
    if (order) {
      if (order.filled) {
        const lastEl = document.getElementById('hdrLast');
        const closePrice = lastEl ? parseFloat(lastEl.textContent.replace(/,/g, '')) : order.entry;
        const dir = order.side === 'buy' ? 1 : -1;
        const closeSide = order.side === 'buy' ? 'sell' : 'buy';
        const closePnl = (closePrice - order.entry) * order.qty * dir * POINT_VALUE;
        orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'closed', type: order.orderType, time: nowTimeStr(), pnl: closePnl }));
        tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closeSide, qty: order.qty, price: closePrice, pnl: closePnl, role: 'close', type: 'Market', time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT }));
        window.refreshTodayJournalCard();
        window.closePositionPct('ETHUSD', 100, order.side);
        showToast((order.side === 'buy' ? 'Long' : 'Short') + ' position closed at ' + fmt(closePrice), 'check_circle');
      } else {
        orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'cancelled', type: order.orderType, time: nowTimeStr(), pnl: null }));
        showToast('Pending order cancelled', 'cancel');
      }
    }
    // Remove just this order from the chart; focus falls back to another live order (or none).
    const idx = orders.indexOf(order);
    if (idx !== -1) orders.splice(idx, 1);
    order = orders.length ? orders[orders.length - 1] : null;
    render(); closeAllPopovers();
  }
  // Re-point the focus to `o` before filling: the global `order` may be pointing at a different
  // order than the one that reached its fill condition, so every caller passes the order that filled.
  /* Resolve the realized fill price for the focused order. Runs before any merge, since the merge
     needs the final price to weight the average entry with. Reads the module-level `order` because
     the helpers it calls (syncQtyFromRisk, netRiskPerContract) do the same. */
  function applyFillPriceAdjustments() {
    // Limit and Stop Limit both fill at the entry (limit) line or better: the entry snaps onto the
    // market when the market offers a better price. A marketable buy at 4600 with market 4500 fills
    // at 4500; a Stop Limit, once its trigger is touched, fills at its entry/limit line the same way.
    if (order.orderType === 'Limit' || order.orderType === 'Stop Limit') {
      const mkt = qtCurrentPrice();
      order.entry = order.side === 'buy'
        ? roundTick(Math.min(order.entry, mkt))
        : roundTick(Math.max(order.entry, mkt));
      if (order.sl) order.initialRisk = Math.abs(order.entry - order.sl.price) * POINT_VALUE;
    }
    // Trigger Market fills as market once the trigger is touched, slipping past it up to the
    // tolerance (the touch means price is already at the trigger, so this is the realized fill).
    if (order.slippageTol > 0) {
      const dir = order.side === 'buy' ? 1 : -1;                  // buys slip up (worse), sells slip down (worse)
      const slipFrac = Math.random() * (order.slippageTol / 100); // realized slip in [0, tolerance], like a real stop
      order.entry = roundTick(order.entry * (1 + dir * slipFrac));
      if (order.sl) order.initialRisk = Math.abs(order.entry - order.sl.price) * POINT_VALUE; // risk reflects real entry
    }
  }

  /* This order just became its direction's main position. If a different pending order on the same side
     was holding the direction's TP/SL — it was the owner until this fill took that role from it — hand
     the lines over rather than discarding them and leaving the new position unprotected. The main is
     always empty here (a filled main would itself have been the owner, so every other same-side order
     would already be a TP/SL-less add-on), so nothing is ever overwritten.
     Only levels still live at THIS fill come across: they were placed against the prior owner's entry,
     and a different fill price can leave one the wrong side of the market — a TP under a long's fill, a
     stop above it — where it would close the position on the next tick. For a filled order tpSlSideOk
     measures against live market, which is exactly that test.
     Returns what happened, so the caller can report it after the fill's own toast. */
  function takeTpSlFromPriorOwner() {
    const priorOwner = allOrders().find(x =>
      !x.filled && x.side === order.side && x !== order && (x.tps.length || x.sl));
    if (!priorOwner) return null;
    const main = order;
    main.tps = priorOwner.tps.filter(tp => tpSlSideOk('tp', tp.price));
    main.sl = (priorOwner.sl && tpSlSideOk('sl', priorOwner.sl.price)) ? priorOwner.sl : null;
    priorOwner.tps = [];
    priorOwner.sl = null;
    main.initialRisk = main.sl ? Math.abs(main.entry - main.sl.price) * POINT_VALUE : null;
    reconcileTrailStart();   // a dropped target can strand a 'start trailing at TPn'
    // The demoted owner is a risk-sized add-on now if it sizes that way; render's resyncRiskSizedAddOns
    // re-derives its quantity off the stop that just moved, so there's nothing to do for it here.
    return (main.tps.length || main.sl) ? 'moved' : 'cleared';
  }

  function confirmOrderFill(o) {
    order = o || order;
    if (!order || order.filled) return;
    // Set before anything else. The tick loop calls this synchronously while iterating a snapshot of
    // the orders, so an order that fills — including one merged away and removed below — is still
    // visited again in that same pass; this flag is what makes the re-entry a no-op.
    order.filled = true;
    applyFillPriceAdjustments();

    // An open position on this side already owns the direction: merge into it rather than opening a
    // second block. The add-on is dropped from `orders` first so the merge's `order = main` lands last
    // and survives render()'s focus restore.
    const main = findMainPosition(order.side, order);
    if (main) {
      const addOn = order;
      removeOrder(addOn);
      mergeFillIntoMain(main, addOn.side, addOn.qty, addOn.entry, addOn.orderType);
      return;
    }

    // Anchor trailing stop to actual fill price so it starts trailing from there. Runs before the
    // handoff so it only ever re-anchors a stop this order already owned — lines inherited from a
    // demoted owner keep the prices they were placed at.
    if (slTrailActive()) {
      const dir = order.side === 'buy' ? 1 : -1;
      const cfg = ensureSlConfig();
      order.sl.price = roundTick(order.entry - dir * computeTrailDist(cfg, order.entry));
      syncQtyFromRisk();
    }
    // Runs before the panel upsert below, so a brand-new Positions row is built with the inherited levels.
    const handoff = takeTpSlFromPriorOwner();
    // Once an order is live, the venue's own price is the price of record. The chart level is what
    // the trader drew; this is what the exchange actually filled, so it is what the ticket, the
    // history rows and the position all report from here on.
    syncOrderExecPrices(order);
    order.execFillPrice = order.execEntry;
    const fillVenue = order.execVenue || Venues.execVenue();
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'filled', type: order.orderType, time: nowTimeStr(), pnl: null }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, pnl: null, role: 'open', type: order.orderType, time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT }));
    window.upsertPositionFromFill('ETHUSD', order.side, order.qty, order.entry, { tps: order.tps, sl: order.sl, venue: fillVenue, basisAbs: order.basisAtPlace });
    render();
    showToast((order.side === 'buy' ? 'Long' : 'Short') + ' position opened at ' + fmt(order.execFillPrice)
      + (Venues.isCrossVenue() ? ' on ' + Venues.venueLabel(fillVenue) : ''), 'check_circle');
    if (handoff === 'moved') {
      showToast('TP/SL moved onto the position — your other order now adds to it', 'swap_vert');
    } else if (handoff === 'cleared') {
      showToast('Your other order\'s TP/SL were already past this fill and were cleared', 'error');
    }
  }

  /* ---------- one net position per direction ----------
     The chart carries at most one FILLED long and one FILLED short (two only ever coexist as a
     long/short pair in hedge mode). The first order to fill in a direction is that direction's MAIN
     position and owns all of its management — take profits, stop loss, and their modes. Every other
     same-side entry order is an ADD-ON: it carries no TP/SL of its own and, when it fills, merges into
     the main at a size-weighted average entry instead of opening a second block. */

  /* The filled position on `side`, if any. `exclude` skips one order — the caller passes the order
     that is filling (or reversing), which is still in `orders` under its old state. */
  function findMainPosition(side, exclude) {
    return allOrders().find(o => o.filled && o.side === side && o !== exclude) || null;
  }
  /* The one order on `side` that owns TP/SL: the filled main if there is one, otherwise the
     first-added pending order (`orders` is push-ordered, so the first match is the earliest).
     Ownership is derived rather than stored, so it re-settles on its own when orders fill, cancel,
     or close — a pending order left alone on its side becomes the owner and regains its controls. */
  function tpSlOwner(side) {
    return allOrders().find(o => o.filled && o.side === side)
      || allOrders().find(o => !o.filled && o.side === side)
      || null;
  }
  /* Every same-side order that isn't the owner — no TP/SL, and it merges into the main on fill. */
  function isAddOn(o) {
    return !!o && tpSlOwner(o.side) !== o;
  }

  /* Merge a fill into an existing same-side position: average the entry by size, sum the quantity.
     The main's TP/SL keep their absolute prices — they were placed at price levels the user meant —
     so only initialRisk is re-derived from the new average entry. History and the Positions panel
     both receive the ADD's qty/price, not the merged total: the panel runs its own weighted average
     (upsertPositionFromFill), and passing the total would double-count it.
     `toast` overrides the default message for callers where "added to" undersells what happened
     (reversing into an existing opposite position closes one side as well as growing the other). */
  function mergeFillIntoMain(main, side, qty, price, orderType, toast) {
    const newQty = main.qty + qty;
    main.entry = roundTick((main.entry * main.qty + price * qty) / newQty);
    main.qty = newQty;
    if (main.sl) main.initialRisk = Math.abs(main.entry - main.sl.price) * POINT_VALUE;
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side, qty, price, status: 'filled', type: orderType, time: nowTimeStr(), pnl: null }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side, qty, price, pnl: null, role: 'open', type: orderType, time: nowTimeStr(), fee: qty * QT_FEE_PER_CONTRACT }));
    window.upsertPositionFromFill('ETHUSD', side, qty, price, { tps: main.tps, sl: main.sl });
    order = main;
    render();
    showToast(
      toast ? toast.msg : 'Added to ' + (side === 'buy' ? 'long' : 'short') + ' at ' + fmt(price),
      toast ? toast.icon : 'add'
    );
  }

  /* A market order on a side that already has an open position adds to it instead of opening a
     duplicate. In hedge mode a buy adds to the long and a sell to a separate short (each matches only
     its own side); in one-way mode the guard has already blocked the opposing case, so only same-side
     adds reach here. No same-side position → a fresh filled market order is created. */
  function addOrCreateMarketFill(side, price, qty) {
    qty = parseFloat(qty) || 1;
    const main = findMainPosition(side);
    if (main) { mergeFillIntoMain(main, side, qty, price, 'Market'); return; }
    const prevVal = qtyInput.value;
    qtyInput.value = qty;
    createOrder(side, price, 'quick');
    order.orderType = 'Market';
    confirmOrderFill(order);
    qtyInput.value = prevVal;
  }

  /* Reverse a working (unfilled) order in place: flip the side and mirror any TP/SL across the entry
     so they stay on the valid side (a buy's TP above / SL below becomes a sell's TP below / SL above). */
  function flipWorkingOrderSide() {
    if (!order || order.filled) return;
    const e = order.entry;
    order.side = order.side === 'buy' ? 'sell' : 'buy';
    order.tps.forEach(tp => { tp.price = roundTick(2 * e - tp.price); });
    if (order.triggerPrice != null) {
      order.triggerPrice = roundTick(2 * e - order.triggerPrice); // mirror the trigger across the entry (limit)
      order.fillAbove = order.triggerPrice > qtCurrentPrice();    // re-arm from the flipped trigger's side
    }
    if (order.sl) {
      order.sl.price = roundTick(2 * e - order.sl.price);
      order.initialRisk = Math.abs(e - order.sl.price) * POINT_VALUE;
    }
    render();
    showToast('Order flipped to ' + (order.side === 'buy' ? 'Buy' : 'Sell'), 'swap_vert');
  }

  /* Reverse a filled position: market-close the current side, then immediately open a fresh
     market position in the opposite direction (same qty, at the current price, no TP/SL). */
  function reverseFilledPosition() {
    if (!order || !order.filled) return;
    const price = qtCurrentPrice();
    const oldSide = order.side, qty = order.qty;
    const dir = oldSide === 'buy' ? 1 : -1;
    const newSide = oldSide === 'buy' ? 'sell' : 'buy';
    const closePnl = (price - order.entry) * qty * dir * POINT_VALUE;
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: oldSide, qty, price: order.entry, status: 'closed', type: order.orderType, time: nowTimeStr(), pnl: closePnl }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: newSide, qty, price, pnl: closePnl, role: 'close', type: 'Market', time: nowTimeStr(), fee: qty * QT_FEE_PER_CONTRACT }));
    window.closePositionPct('ETHUSD', 100, oldSide);
    const entry = roundTick(price);
    const oldOrder = order;

    // Hedge mode can already have a position on the side we're reversing into. Reversing must add to
    // it, not open a second block beside it — the chart carries one filled position per direction.
    const opposingMain = findMainPosition(newSide, oldOrder);
    if (opposingMain) {
      removeOrder(oldOrder);
      mergeFillIntoMain(opposingMain, newSide, qty, entry, 'Market', {
        msg: 'Reversed into your open ' + (newSide === 'buy' ? 'long' : 'short') + ' at ' + fmt(entry),
        icon: 'swap_vert'
      });
      window.refreshTodayJournalCard();
      closeAllPopovers();
      return;
    }

    order = {
      id: 'ord' + (orderCounter++),
      side: newSide, entry, qty, orderType: 'Market', fillAbove: false,
      sizeMode: 'contracts', filled: true, pendingConfirm: false,
      sizeValues: { dollar: 5000, percent: 25, risk: 500, riskPct: 1 },
      tps: [], sl: null, tpsHitCount: 0, initialRisk: null
    };
    // Replace the reversed position in place (same slot) rather than appending a second one.
    const ri = orders.indexOf(oldOrder);
    if (ri !== -1) orders.splice(ri, 1, order); else orders.push(order);
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: newSide, qty, price: entry, status: 'filled', type: 'Market', time: nowTimeStr(), pnl: null }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: newSide, qty, price: entry, pnl: null, role: 'open', type: 'Market', time: nowTimeStr(), fee: qty * QT_FEE_PER_CONTRACT }));
    window.upsertPositionFromFill('ETHUSD', newSide, qty, entry, { tps: order.tps, sl: order.sl });
    window.refreshTodayJournalCard();
    render(); closeAllPopovers();
    showToast('Reversed to ' + (newSide === 'buy' ? 'Long' : 'Short') + ' at ' + fmt(entry), 'swap_vert');
  }

  /* ---------- chart close-controls popup (filled position → partial/full market close) ---------- */
  const chartClosePopup = document.getElementById('chartClosePopup');
  const chartCloseSlider = document.getElementById('chartCloseSlider');
  const chartClosePctLabel = document.getElementById('chartClosePctLabel');
  const chartCloseQuick = document.getElementById('chartCloseQuick');

  function setChartClosePct(pct) {
    pct = clamp(Math.round(pct), 0, 100);
    chartCloseSlider.value = pct;
    if (window.fillRangeSlider) window.fillRangeSlider(chartCloseSlider);
    const qty = order ? Math.max(1, Math.round(order.qty * pct / 100)) : 0;
    chartClosePctLabel.textContent = pct + '% · ' + qty + (qty === 1 ? ' contract' : ' contracts');
    chartCloseQuick.querySelectorAll('[data-close-pct]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.closePct, 10) === pct);
    });
  }

  function openChartClosePopup(rect, trigger) {
    if (!order || !order.filled) return;
    if (window.decorateRangeSlider) window.decorateRangeSlider(chartCloseSlider);
    setChartClosePct(100);
    openNear(chartClosePopup, rect, 'right', trigger);
  }

  function executeChartClose(pct) {
    if (!order || !order.filled) return;
    if (pct <= 0) { showToast('Select an amount to close', 'error'); return; }
    const closePrice = qtCurrentPrice();
    const dir = order.side === 'buy' ? 1 : -1;
    const closeSide = order.side === 'buy' ? 'sell' : 'buy';
    if (pct >= 100) {
      const closePnl = (closePrice - order.entry) * order.qty * dir * POINT_VALUE;
      orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: order.qty, price: order.entry, status: 'closed', type: order.orderType, time: nowTimeStr(), pnl: closePnl }));
      tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closeSide, qty: order.qty, price: closePrice, pnl: closePnl, role: 'close', type: 'Market', time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT }));
      window.refreshTodayJournalCard();
      window.closePositionPct('ETHUSD', 100, order.side);
      showToast((order.side === 'buy' ? 'Long' : 'Short') + ' position closed at ' + fmt(closePrice), 'check_circle');
      removeOrder(order); render(); closeAllPopovers();
      return;
    }
    const closeQty = Math.max(1, Math.round(order.qty * pct / 100));
    const closePnl = (closePrice - order.entry) * closeQty * dir * POINT_VALUE;
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: order.side, qty: closeQty, price: order.entry, status: 'closed', type: order.orderType, time: nowTimeStr(), pnl: closePnl }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closeSide, qty: closeQty, price: closePrice, pnl: closePnl, role: 'close', type: 'Market', time: nowTimeStr(), fee: closeQty * QT_FEE_PER_CONTRACT }));
    window.refreshTodayJournalCard();
    window.closePositionPct('ETHUSD', pct, order.side);
    order.qty = Math.max(1, order.qty - closeQty);
    render(); closeAllPopovers();
    showToast('Position reduced by ' + pct + '%', 'check_circle');
  }

  chartCloseQuick.querySelectorAll('[data-close-pct]').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); setChartClosePct(parseInt(b.dataset.closePct, 10)); });
  });
  chartCloseSlider.addEventListener('input', () => setChartClosePct(parseInt(chartCloseSlider.value, 10)));
  document.getElementById('chartCloseCancel').addEventListener('click', (e) => { e.stopPropagation(); closeAllPopovers(); });
  document.getElementById('chartCloseConfirm').addEventListener('click', (e) => {
    e.stopPropagation();
    executeChartClose(parseInt(chartCloseSlider.value, 10));
  });

  /* ---------- Order Confirmation modal: gates every order placement behind a review step ---------- */
  const ORDER_CONFIRM_KEY = 'tt_orderConfirm';
  function orderConfirmEnabled() {
    try { return localStorage.getItem(ORDER_CONFIRM_KEY) !== '0'; } catch (e) { return true; }
  }
  function setOrderConfirmEnabled(on) {
    try { localStorage.setItem(ORDER_CONFIRM_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    const row = document.getElementById('csConfirmMarketOrders');
    if (row) row.classList.toggle('active', on);
  }

  const ocBackdrop = document.getElementById('ocBackdrop');
  let ocPendingProceed = null;

  function requestOrderConfirmation(details, proceed) {
    if (!orderConfirmEnabled()) { proceed(); return; }
    openOrderConfirm(details, proceed);
  }
  function openOrderConfirm(details, proceed) {
    ocPendingProceed = proceed;
    const isSell = details.side === 'sell';
    document.getElementById('ocSideText').textContent = isSell ? 'Sell' : 'Buy';
    document.getElementById('ocSidePill').classList.toggle('sell', isSell);
    document.getElementById('ocType').textContent = details.orderType;
    document.getElementById('ocAmount').textContent = details.amount;
    document.getElementById('ocPrice').textContent = details.price;
    // The price above is the level on the chart. When the order is going to a different venue,
    // spell out what it will actually rest at there and whose book it lands in.
    const execRow = document.getElementById('ocExecPriceRow');
    const venueRow = document.getElementById('ocVenueRow');
    const crossVenue = Venues.isCrossVenue();
    venueRow.hidden = !crossVenue;
    if (crossVenue) document.getElementById('ocVenue').textContent = Venues.execLabel();
    const showExec = crossVenue && venueSplitVisible() && typeof details.chartPrice === 'number';
    execRow.hidden = !showExec;
    if (showExec) {
      document.getElementById('ocExecPrice').textContent =
        '$' + fmt(Venues.toExec(details.chartPrice)) + ' · ' + Venues.execLabel();
    }
    const leverageRow = document.getElementById('ocLeverageRow');
    leverageRow.style.display = details.leverage ? '' : 'none';
    if (details.leverage) document.getElementById('ocLeverage').textContent = details.leverage;
    const confirmBtn = document.getElementById('ocConfirm');
    confirmBtn.classList.toggle('buy', !isSell);
    confirmBtn.classList.toggle('sell', isSell);
    document.getElementById('ocDontShow').classList.remove('checked');
    ocBackdrop.classList.add('show');
  }
  function closeOrderConfirm() {
    ocBackdrop.classList.remove('show');
    ocPendingProceed = null;
  }
  document.querySelector('.oc-dontshow').addEventListener('click', () => {
    document.getElementById('ocDontShow').classList.toggle('checked');
  });
  document.getElementById('ocConfirm').addEventListener('click', () => {
    if (document.getElementById('ocDontShow').classList.contains('checked')) setOrderConfirmEnabled(false);
    const proceed = ocPendingProceed;
    closeOrderConfirm();
    if (proceed) proceed();
  });
  document.getElementById('ocCancel').addEventListener('click', closeOrderConfirm);
  document.getElementById('ocClose').addEventListener('click', closeOrderConfirm);
  ocBackdrop.addEventListener('click', (e) => { if (e.target === ocBackdrop) closeOrderConfirm(); });

  /* ---------- Flip/Reverse Confirmation modal: gates the entry bar's Flip Direction / Reverse Position button ---------- */
  const REVERSE_CONFIRM_KEY = 'tt_reverseConfirm';
  function reverseConfirmEnabled() {
    try { return localStorage.getItem(REVERSE_CONFIRM_KEY) !== '0'; } catch (e) { return true; }
  }
  function setReverseConfirmEnabled(on) {
    try { localStorage.setItem(REVERSE_CONFIRM_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    const row = document.getElementById('csConfirmReverse');
    if (row) row.classList.toggle('active', on);
  }

  /* ---------- Hedge Mode (crypto) ---------- */
  // Off = one-way: a symbol can only be long OR short at once, so an opposing order/position is blocked
  // (see the guardedPlace flow). On = hedge: a long and a short coexist as separate orders/positions.
  // Default off. Set from the General settings pane's Position Mode card, or from the one-way block
  // popup's "Enable Hedge Mode" button — both route through setHedgeModeEnabled.
  const HEDGE_MODE_KEY = 'tt_hedgeMode';
  function hedgeModeEnabled() {
    try { return localStorage.getItem(HEDGE_MODE_KEY) === '1'; } catch (e) { return false; }
  }
  function syncHedgeModeGroup(on) {
    const group = document.getElementById('csHedgeModeGroup');
    if (!group) return;
    group.querySelectorAll('.cs-seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.hedge === (on ? 'on' : 'off'));
    });
  }
  function setHedgeModeEnabled(on) {
    try { localStorage.setItem(HEDGE_MODE_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    syncHedgeModeGroup(on);
  }
  /* True when an opposing order (pending or filled) or position already exists on the same crypto symbol
     — the strict one-way rule: any live long blocks a new short, and vice versa.
     `exclude` is the order being reversed or flipped, which is a special case: it's still on the chart
     under its OLD side, so without skipping it a lone position would count as its own opposition and
     block its own reversal. The ETHUSD Positions row is backed by that same chart order, so the panel
     check has to be skipped along with it — the chart scan already covers this symbol. */
  function opposingExistsOnChart(newSide, exclude) {
    const opposedOnChart = allOrders().some(o => o !== exclude && o.side !== newSide);
    if (exclude) return opposedOnChart;
    return opposedOnChart
      || (window.hasOpposingPosition && window.hasOpposingPosition('ETHUSD', newSide));
  }

  /* One-way-mode block popup. `guardedPlace` is the single funnel every placement path runs through:
     in one-way mode with an opposing order/position it opens the popup instead of placing, and the
     popup's "Enable Hedge Mode" button flips the mode then resumes the exact same placement. */
  const hedgeBlockBackdrop = document.getElementById('hedgeBlockBackdrop');
  let hbPendingProceed = null;
  function openHedgeBlock(proceed) {
    hbPendingProceed = proceed;
    if (hedgeBlockBackdrop) hedgeBlockBackdrop.classList.add('show');
  }
  function closeHedgeBlock() {
    if (hedgeBlockBackdrop) hedgeBlockBackdrop.classList.remove('show');
    hbPendingProceed = null;
  }
  /* ---------- wide venue spread guard ----------
     When the chart venue and the execution venue have drifted a long way apart, the price a trader
     clicked and the price their order will rest at are meaningfully different numbers. Rather than
     let that surprise them after the fact, placement pauses and shows both sides. Hooked into
     guardedPlace below so every placement path — Quick Trade, chart right-click, the floating
     quick-order bar — is covered by one check. */
  const vsBackdrop = document.getElementById('vsBackdrop');
  let vsPendingProceed = null;

  function venueSpreadTooWide() {
    if (!Venues.isCrossVenue()) return false;
    if (!chartSettings.crossVenue.warnEnabled) return false;
    return Venues.divergence().level === 'wide';
  }
  function openVenueSpreadWarning(proceed) {
    vsPendingProceed = proceed;
    const div = Venues.divergence();
    const chartPx = Venues.chartMark();
    document.getElementById('vsChartVenue').textContent = Venues.dataLabel();
    document.getElementById('vsExecVenue').textContent = Venues.execLabel();
    document.getElementById('vsChartPrice').textContent = fmtMoney(chartPx);
    document.getElementById('vsExecPrice').textContent = fmtMoney(Venues.execMark());
    document.getElementById('vsSpread').textContent =
      Venues.execLabel() + ' is trading ' + fmtMoney(div.abs) + ' (' + fmt(div.bps, 1) + ' bps) '
      + (div.signedAbs < 0 ? 'below ' : 'above ') + Venues.dataLabel() + ' right now.';
    document.getElementById('vsProceed').textContent = 'Place on ' + Venues.execLabel();
    if (vsBackdrop) vsBackdrop.classList.add('show');
  }
  function closeVenueSpreadWarning() {
    if (vsBackdrop) vsBackdrop.classList.remove('show');
    vsPendingProceed = null;
  }
  if (vsBackdrop) {
    document.getElementById('vsProceed').addEventListener('click', () => {
      const proceed = vsPendingProceed;
      closeVenueSpreadWarning();
      if (proceed) proceed();   // resume the paused placement
    });
    document.getElementById('vsCancel').addEventListener('click', closeVenueSpreadWarning);
    document.getElementById('vsClose').addEventListener('click', closeVenueSpreadWarning);
    vsBackdrop.addEventListener('click', (e) => { if (e.target === vsBackdrop) closeVenueSpreadWarning(); });
  }

  function guardedPlace(side, proceed, exclude) {
    // Hedge check first: whether you're allowed to hold this direction at all is a harder stop than
    // what the order will cost, and answering it first keeps the two dialogs from stacking.
    if (!hedgeModeEnabled() && opposingExistsOnChart(side, exclude)) { openHedgeBlock(proceed); return; }
    if (venueSpreadTooWide()) { openVenueSpreadWarning(proceed); return; }
    proceed();
  }
  if (hedgeBlockBackdrop) {
    document.getElementById('hbEnable').addEventListener('click', () => {
      setHedgeModeEnabled(true);
      const proceed = hbPendingProceed;
      closeHedgeBlock();
      showToast('Hedge mode enabled', 'swap_vert');
      // Resume the blocked placement, now allowed — but run it back through the venue-spread check
      // so clearing one guard can't skip the other.
      if (proceed) {
        if (venueSpreadTooWide()) openVenueSpreadWarning(proceed);
        else proceed();
      }
    });
    document.getElementById('hbCancel').addEventListener('click', closeHedgeBlock);
    document.getElementById('hbClose').addEventListener('click', closeHedgeBlock);
    hedgeBlockBackdrop.addEventListener('click', (e) => { if (e.target === hedgeBlockBackdrop) closeHedgeBlock(); });
  }

  const rcBackdrop = document.getElementById('rcBackdrop');
  let rcPendingProceed = null;

  function requestReverseConfirmation(isFilled, proceed) {
    if (!reverseConfirmEnabled()) { proceed(); return; }
    openReverseConfirm(isFilled, proceed);
  }
  function openReverseConfirm(isFilled, proceed) {
    rcPendingProceed = proceed;
    document.getElementById('rcTitle').textContent = isFilled ? 'Reverse Position' : 'Flip Direction';
    document.getElementById('rcDesc').textContent = isFilled
      ? 'This will close your current position at the best available market price and immediately open a new position of the same size in the opposite direction.'
      : "This will switch your pending order from a buy to a sell (or vice versa). Its take-profit and stop-loss levels will be mirrored to stay on the correct side of your entry price.";
    document.getElementById('rcDontShow').classList.remove('checked');
    rcBackdrop.classList.add('show');
  }
  function closeReverseConfirm() {
    rcBackdrop.classList.remove('show');
    rcPendingProceed = null;
  }
  document.querySelector('#rcBackdrop .oc-dontshow').addEventListener('click', () => {
    document.getElementById('rcDontShow').classList.toggle('checked');
  });
  document.getElementById('rcConfirm').addEventListener('click', () => {
    if (document.getElementById('rcDontShow').classList.contains('checked')) setReverseConfirmEnabled(false);
    const proceed = rcPendingProceed;
    closeReverseConfirm();
    if (proceed) proceed();
  });
  document.getElementById('rcCancel').addEventListener('click', closeReverseConfirm);
  document.getElementById('rcClose').addEventListener('click', closeReverseConfirm);
  rcBackdrop.addEventListener('click', (e) => { if (e.target === rcBackdrop) closeReverseConfirm(); });

  /* clicking the BUY/SELL entry chip places a pending chart order — blocked while TP/SL sit on the wrong side of entry */
  function placeOrder() {
    if (!order || !order.pendingConfirm || orderPlaceBlocked()) return;
    const details = {
      side: order.side,
      orderType: order.orderType,
      amount: order.qty + ' ' + qtInstrumentUnit,
      leverage: qtLeverageForOrder(),
      price: '$' + fmt(order.entry),
      chartPrice: order.entry
    };
    requestOrderConfirmation(details, placeOrderExecute);
  }
  function placeOrderExecute() {
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
    if (order.sl && !order.sl.beActive && (order.tps.length < 1 || order.sl.beTpId === id)) {
      order.sl.beTpId = null;
    }
    reconcileTrailStart();
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
    orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closingSide, qty: order.qty, price: order.sl.price, status: 'filled', type: 'Stop (SL)', time: nowTimeStr(), pnl: slPnl }));
    tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closingSide, qty: order.qty, price: order.sl.price, pnl: slPnl, role: 'close', type: 'Stop (SL)', time: nowTimeStr(), fee: order.qty * QT_FEE_PER_CONTRACT }));
    window.refreshTodayJournalCard();
    window.closePositionPct('ETHUSD', 100, order.side);
    showToast('Stop loss hit at ' + fmt(order.sl.price) + ' — position closed', 'stop_circle');
    removeOrder(order);
    render();
    return true;
  }

  /* ---------- TP fill detection (drives "Move to Break Even" once the chosen TP is hit) ---------- */
  function checkTpFills(prevPrice, currentPrice) {
    if (!order || !order.filled || !order.tps.length) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const hitTps = order.tps.filter(tp => {
      if (tp.trailing) {
        // Trailing TP not yet activated: reaching tp.price just triggers the trail — don't close.
        if (!tp.activated || tp.exitPrice == null) return false;
        // Activated trailing TP: close when price retraces to the trailing exit line.
        return dir === 1
          ? (prevPrice > tp.exitPrice && currentPrice <= tp.exitPrice)
          : (prevPrice < tp.exitPrice && currentPrice >= tp.exitPrice);
      }
      // Normal TP: close when price reaches tp.price.
      return dir === 1
        ? (prevPrice < tp.price && currentPrice >= tp.price)
        : (prevPrice > tp.price && currentPrice <= tp.price);
    });
    if (!hitTps.length) return;
    hitTps.forEach(tp => {
      const idx = order.tps.indexOf(tp);
      const closingSide = order.side === 'buy' ? 'sell' : 'buy';
      const tpQty = Math.max(1, Math.round(order.qty * tp.pct / 100));
      const exitPrice = (tp.trailing && tp.exitPrice != null) ? tp.exitPrice : tp.price;
      const tpPnl = (exitPrice - order.entry) * tpQty * dir * POINT_VALUE;
      const tradeType = tp.trailing ? 'Trail TP' : 'Limit (TP)';
      const toastMsg = tp.trailing
        ? 'TP' + (idx + 1) + ' trail exit at ' + fmt(exitPrice)
        : 'TP' + (idx + 1) + ' hit at ' + fmt(tp.price);
      orderHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closingSide, qty: tpQty, price: exitPrice, status: 'filled', type: tradeType, time: nowTimeStr(), pnl: tpPnl }));
      tradeHistory.unshift(stampVenueRecord({ symbol: 'ETHUSD', side: closingSide, qty: tpQty, price: exitPrice, pnl: tpPnl, role: 'close', type: tradeType, time: nowTimeStr(), fee: tpQty * QT_FEE_PER_CONTRACT }));
      window.refreshTodayJournalCard();
      window.closePositionPct('ETHUSD', tp.pct, order.side);
      showToast(toastMsg, 'check_circle');
      if (order.sl && order.sl.beTpId === tp.id && !order.sl.beActive) {
        moveSlToBreakevenLevel(currentPrice);
      }
    });
    order.tpsHitCount = (order.tpsHitCount || 0) + hitTps.length;
    order.tps = order.tps.filter(tp => !hitTps.includes(tp));
    if (order.tps.length === 0) {
      showToast('All targets hit — position fully closed', 'check_circle');
      removeOrder(order);
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
    if (triggerKey === 'pct') {
      const trigPrice = breakevenTriggerPrice(getEffectiveBeConfig());
      if (trigPrice === null) return false;
      const dir = order.side === 'buy' ? 1 : -1;
      return dir * (currentPrice - trigPrice) >= 0;
    }
    return false;
  }
  /* effective config = this SL's own override if set, otherwise the global Chart Settings default */
  function getEffectiveBeConfig() { return (order && order.sl && order.sl.beOverride) || chartSettings.moveSlToBreakeven; }
  /* price distance for a breakeven offset config. The 'fee' unit's value is a percentage of entry, applied
     exactly like 'percent' — Dynamic Fee Offset auto-fills it with the round-trip entry+exit fee (0.12%),
     so the SL lands a fraction beyond entry that covers both fills and nets to zero. */
  function breakevenOffsetPrice(beCfg) {
    if (beCfg.offsetUnit === 'points') return beCfg.offsetValue;
    if (beCfg.offsetUnit === 'percent') return order.entry * beCfg.offsetValue / 100;
    if (beCfg.offsetUnit === 'fee') return order.entry * beCfg.offsetValue / 100;
    return beCfg.offsetValue * TICK; // ticks
  }
  /* Breakeven Price overlay line (Chart settings): the price at which the position nets zero after the
     round-trip exchange fee (entry fill + exit fill). Entry fee depends on the order type (maker vs taker);
     the exit is a taker fill. Long breaks even above entry, short below. */
  function breakevenLinePrice() {
    if (!order) return null;
    const dir = order.side === 'buy' ? 1 : -1;
    const entryFeeRate = /Market/.test(order.orderType) ? FEE_RATE_MARKET : FEE_RATE_LIMIT;
    const exitFeeRate = FEE_RATE_MARKET; // exit fills as a taker order
    const roundTripFee = entryFeeRate + exitFeeRate;
    return roundTick(order.entry + dir * order.entry * roundTripFee);
  }
  /* step config for the breakeven offset field — allows 0 (SL lands exactly at entry) and decimals for
     fine control. Ticks stay whole since a fractional tick is meaningless. */
  function beOffsetParams(unit) {
    if (unit === 'ticks') return { min: 0, max: 200, step: 1 };
    if (unit === 'points') return { min: 0, max: 200, step: 0.25 };
    if (unit === 'percent') return { min: 0, max: 50, step: 0.1 };
    return { min: 0, max: 10, step: 0.1 }; // fee percentage (of entry)
  }
  /* the reference target the '% to TP1' breakeven trigger measures against — the first take-profit. */
  function breakevenRefTp() { return (order && order.tps.length) ? order.tps[0] : null; }
  /* the two price-based BE triggers ('% to TP1' and 'Custom R Multiple') draw a draggable line and
     arm from applyBreakeven on price — unlike tp1/tp2/tp3, which arm from checkTpFills on a TP hit. */
  function isPriceBasedBeTrigger(trigger) { return trigger === 'pct' || trigger === 'customR'; }
  /* risk distance in points, used by the 'Custom R Multiple' trigger. Once filled the risk is locked to
     the fill-time value (matches currentRMultiple); before then it tracks the live SL placement. */
  function beRiskPoints() {
    if (!order || !order.sl) return null;
    if (order.filled && order.initialRisk) return order.initialRisk / POINT_VALUE;
    return Math.abs(order.entry - order.sl.price);
  }
  /* price at which a price-based breakeven trigger fires. '% to TP1' sits a fraction of the way from
     entry to TP1; 'Custom R Multiple' sits N times the initial risk beyond entry. Both land on the
     profit side of entry for longs and shorts alike. */
  function breakevenTriggerPrice(beCfg) {
    const dir = order && order.side === 'buy' ? 1 : -1;
    if (beCfg.trigger === 'customR') {
      const riskPts = beRiskPoints();
      if (!riskPts) return null;
      const r = beCfg.customR != null ? beCfg.customR : 1;
      return roundTick(order.entry + dir * r * riskPts);
    }
    const refTp = breakevenRefTp();
    if (!refTp) return null;
    const pct = (beCfg.pctToTp != null ? beCfg.pctToTp : 50) / 100;
    return roundTick(order.entry + pct * (refTp.price - order.entry));
  }
  /* short label for what arms breakeven — shown on the SL badge as "<label> → BE" so the
     trigger source is visible at a glance instead of a bare "BE". */
  function breakevenTriggerLabel(beCfg) {
    if (beCfg.trigger === 'tp1') return 'TP1';
    if (beCfg.trigger === 'tp2') return 'TP2';
    if (beCfg.trigger === 'tp3') return 'TP3';
    if (beCfg.trigger === 'customR') return (beCfg.customR != null ? +beCfg.customR : 1).toFixed(1) + 'R';
    return Math.round(beCfg.pctToTp != null ? beCfg.pctToTp : 50) + '%'; // pct
  }
  function getEffectiveAtrConfig() { return chartSettings.atrStop; }
  /* ---- Trailing-TP model: each TP carries a simple { offsetValue, offsetUnit } config.
     The offset is the distance between the TP level and its draggable Offset line. ---- */
  /* A new TP's trailing offset is seeded from the Trailing Take Profit card (Global Settings).
     Once created, a TP owns its offset — later settings changes don't touch it. */
  function makeTpTrailOffset() {
    return { offsetValue: chartSettings.trailingTp.distanceValue, offsetUnit: chartSettings.trailingTp.distanceUnit };
  }
  function ensureTpTrailOffset(tp) {
    if (!tp) return null;
    if (!tp.trailOffset) tp.trailOffset = makeTpTrailOffset();
    if (tp.activated === undefined) tp.activated = false;
    if (tp.exitPrice === undefined) tp.exitPrice = null;
    return tp.trailOffset;
  }
  function tpTrailActive(tp) { return !!(tp && tp.trailing); }
  /* the price a TP currently shows/tracks on the chart: once trailing has activated, that's the
     live trailing exit (tp.exitPrice), not the original static trigger (tp.price) */
  function tpDisplayPrice(tp) {
    return (tp.trailing && tp.activated && tp.exitPrice != null) ? tp.exitPrice : tp.price;
  }
  /* once an activated trailing TP's automatic ratchet has moved it past entry, that's not a
     misplacement — only a manual drag past entry (which clears this flag) should still warn */
  function tpSideWarningSuppressed(tp) { return tpTrailActive(tp) && !!tp.autoTrailing; }
  /* min/step/decimal-places for an offset value, by unit (percent default, ticks optional) */
  function tpOffsetParams(unit) {
    if (unit === 'ticks') return { min: 1, max: 2000, step: 1, dp: 0 };
    return { min: 0.01, max: 50, step: 0.01, dp: 2 }; // percent — fine-grained so small offsets stay precise
  }
  /* offset distance in price units, measured from the TP price */
  function tpOffsetDist(tp) {
    const cfg = ensureTpTrailOffset(tp);
    if (cfg.offsetUnit === 'ticks') return cfg.offsetValue * TICK;
    return tp.price * cfg.offsetValue / 100; // percent of the TP level
  }
  /* express a raw price gap (points) in the given offset unit */
  function tpGapToOffset(gapPts, refPrice, unit) {
    if (unit === 'ticks') return gapPts / TICK;
    return gapPts / refPrice * 100; // percent
  }
  /* short label for an offset, e.g. "0.25%" or "20t" */
  function formatTpOffset(value, unit) {
    if (unit === 'ticks') return Math.round(value) + 't';
    return (+value).toFixed(2) + '%';
  }
  function tpOffsetLabel(tp) {
    const cfg = ensureTpTrailOffset(tp);
    return formatTpOffset(cfg.offsetValue, cfg.offsetUnit);
  }
  // Before activation the badge marks the price that arms trailing ('TRL TRIGGER').
  // Once activated, the TP has moved to its offset level and is actively trailing, so it reads just 'TRL'.
  function tpBadgeText(tp) { return (tp && tp.activated && tp.exitPrice != null) ? 'TRL' : 'TRL TRIGGER'; }
  /* live-patch a trailing-TP badge label + its Offset line during a drag (no full re-render) */
  function refreshTpBadgeOnChart(tpId) {
    const labelEl = orderScope().querySelector('[data-tp-badge-edit="' + tpId + '"]');
    const tp = order && order.tps.find(t => t.id === tpId);
    if (labelEl && tp) labelEl.textContent = tpBadgeText(tp);
  }
  /* ---- SL special-behavior model: one master toggle (enabled) + one selected mode ---- */
  function slTrailActive() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'trailing'); }
  function slAtrActive() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'atr'); }
  function slBeActiveMode() { return !!(order && order.sl && order.sl.enabled && order.sl.mode === 'breakeven'); }
  /* Each SL carries its own trailing config. The distance is the entry↔SL gap — where the stop is
     placed is the room the trader wants trailed — so it's adopted from placement rather than
     configured globally. Callers building a new SL attach it first, then call applySlModePlacement()
     to fill this in, since the gap can't be measured until the SL is on the order. */
  function makeSlConfig() {
    const b = chartSettings.trailingStop;
    const unit = b.distanceUnit === 'points' ? 'percent' : b.distanceUnit;
    return {
      distanceValue: +slGapDistance(unit).toFixed(slDistanceParams(unit).dp),
      distanceUnit: unit,
      start: b.start,
      startCustomR: b.startCustomR
    };
  }
  function ensureSlConfig() {
    if (!order || !order.sl) return null;
    if (!order.sl.trailOverride) order.sl.trailOverride = makeSlConfig();
    return order.sl.trailOverride;
  }
  function trailStartMaxTp() {
    // Highest TP-hit level still reachable: already-hit TPs + pending TPs, capped at 3.
    return Math.min(3, (order.tpsHitCount || 0) + order.tps.length);
  }
  function reconcileTrailStart() {
    // Clamp an unreachable Start-Trailing trigger down to the highest valid option; keep trailing on.
    if (!order || !order.sl || !order.sl.trailOverride) return; // nothing configured to fix
    const cfg = order.sl.trailOverride;
    const m = /^tp(\d)$/.exec(cfg.start);
    if (!m) return; // 'immediate' is always valid
    const maxTp = trailStartMaxTp();
    if (+m[1] > maxTp) cfg.start = maxTp >= 1 ? 'tp' + maxTp : 'immediate';
  }
  function slAtrMult() { return (order && order.sl && order.sl.atrMult) || chartSettings.atrStop.multiplier || 2.0; }
  /* min/max/step/decimal-places for a trailing distance value, by unit */
  function slDistanceParams(unit) {
    if (unit === 'ticks') return { min: 1, max: 2000, step: 1, dp: 0 };
    if (unit === 'atr') return { min: 0.01, max: 20, step: 0.1, dp: 2 };
    return { min: 0.1, max: 50, step: 0.1, dp: 2 }; // percent
  }
  function atrStopDistance(cfg) {
    cfg = cfg || getEffectiveAtrConfig();
    return 7.5 * (cfg.multiplier / 2);
  }
  /* current Entry↔SL gap expressed in the given unit (% of entry, ticks, or ATR multiples) */
  function slGapDistance(unit) {
    if (!order || !order.sl) return 0;
    const gapPts = Math.abs(order.entry - order.sl.price);
    if (unit === 'percent') return gapPts / order.entry * 100;
    if (unit === 'atr') return gapPts / atrStopDistance({ multiplier: 1 });
    return gapPts / TICK;
  }
  /* short label for an SL's distance value, e.g. "1.25%", "8t", or "ATR 2.0x" */
  function slDistanceLabel(cfg) {
    if (cfg.distanceUnit === 'percent') return (+cfg.distanceValue).toFixed(2) + '%';
    if (cfg.distanceUnit === 'atr') return 'ATR ' + (+cfg.distanceValue).toFixed(2) + 'x';
    return Math.round(cfg.distanceValue) + 't';
  }
  /* The special (non-Fixed) SL modes, shown as neutral buttons beside the SL chip. */
  const SL_MODE_BUTTONS = [
    { mode: 'trailing', label: 'TRL', cls: 'trail', tip: 'Trailing Stop' },
    { mode: 'atr', label: 'ATR', cls: 'atr', tip: 'ATR Stop' },
    { mode: 'breakeven', label: 'BE', cls: 'be', tip: 'Break-Even Stop' },
  ];
  /* badge shown inside the SL chip — text + style class, and it opens the SL settings.
     A plain (non-special-mode) SL has no badge at all — null means "don't show one". */
  function slBadgeInfo() {
    if (!order || !order.sl || !order.sl.enabled) return null;
    if (order.sl.mode === 'breakeven') {
      if (order.sl.beActive) return { text: 'SL → BE', cls: 'be' };
      const beCfg = getEffectiveBeConfig();
      return { text: breakevenTriggerLabel(beCfg) + ' → BE', cls: 'be' };
    }
    if (order.sl.mode === 'atr') return { text: 'ATR ' + slAtrMult().toFixed(2) + 'x', cls: 'atr' };
    return { text: 'TRL ' + slDistanceLabel(ensureSlConfig()), cls: 'trail' };
  }
  /* live-patch the on-chart SL chip badge without a full re-render (used by drag and by gear-menu field edits).
     If a drag detaches a special mode (e.g. manually dragging an ATR stop), the badge is removed outright
     instead of relabeled, since a plain SL never shows a badge. */
  function refreshSlBadgeOnChart() {
    const shellEl = orderScope().querySelector('#slBadgeShell');
    const info = slBadgeInfo();
    if (!info) { if (shellEl) shellEl.remove(); return; }
    if (!shellEl) return;
    orderScope().querySelector('#slBadgeTrigger').textContent = info.text;
    shellEl.className = 'ol-badge sl-badge ' + info.cls;
  }
  let simTickCounter = 0;
  /* Shared helper: compute trailing distance in price units from a reference price */
  function computeTrailDist(cfg, refPrice) {
    if (cfg.distanceUnit === 'percent') return refPrice * cfg.distanceValue / 100;
    if (cfg.distanceUnit === 'atr') return atrStopDistance({ multiplier: cfg.distanceValue });
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
    const cfg = ensureSlConfig();
    if (cfg.start !== 'immediate' && !meetsTriggerCondition(cfg.start, cfg.startCustomR, currentPrice)) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const candidate = roundTick(currentPrice - dir * computeTrailDist(cfg, currentPrice));
    const improvement = dir * (candidate - order.sl.price);
    if (improvement > 0) {
      order.sl.price = candidate;
      order.sl.autoTrailing = true; // this move was the automation ratcheting, not a manual drag
      syncQtyFromRisk();
    }
  }

  /* For unfilled orders: keep the trailing SL at the configured distance from entry reference */
  function applyTrailingStopPreview() {
    if (!slTrailActive() || order.filled) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const cfg = ensureSlConfig();
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
      const distPrice = tpOffsetDist(tp);
      if (!tp.activated) {
        // Phase 1 — wait for price to reach the activation trigger (tp.price).
        if (dir * (currentPrice - tp.price) >= 0) {
          tp.activated = true;
          tp.exitPrice = roundTick(currentPrice - dir * distPrice);
          tp.autoTrailing = true;
        }
      } else {
        // Phase 2 — trail the exit price behind market; ratchet in the favorable direction only.
        const candidate = roundTick(currentPrice - dir * distPrice);
        if (dir * (candidate - tp.exitPrice) > 0) { tp.exitPrice = candidate; tp.autoTrailing = true; }
      }
    });
  }
  /* Move the SL to its breakeven level (entry ± the fee/offset) once a trigger arms it. The offset
     sits on the profit side so the stop covers round-trip fees. Crucially, a stop can never be placed
     beyond the current market price — that would fill instantly and close the whole position. When the
     offset would overshoot the market (e.g. a tight target with a large fee offset), clamp the stop to
     one tick inside the current price so breakeven still reduces risk without triggering an exit. */
  function moveSlToBreakevenLevel(currentPrice) {
    if (!order || !order.sl) return;
    const dir = order.side === 'buy' ? 1 : -1;
    const target = order.entry + dir * breakevenOffsetPrice(getEffectiveBeConfig());
    const marketCap = currentPrice - dir * TICK; // furthest the stop may sit and stay a valid protective stop
    const clamped = dir === 1 ? Math.min(target, marketCap) : Math.max(target, marketCap);
    order.sl.price = roundTick(clamped);
    order.sl.beActive = true;
    syncQtyFromRisk();
    showToast('Stop loss moved to breakeven', 'vertical_align_center');
  }
  /* Price-based breakeven: the '% to TP1' and 'Custom R Multiple' triggers fire once price reaches
     their level. The TP-hit triggers (tp1/tp2/tp3) fire from checkTpFills on the mapped TP hit instead. */
  function applyBreakeven(currentPrice) {
    if (!order || !order.filled || !slBeActiveMode() || order.sl.beActive) return;
    const cfg = getEffectiveBeConfig();
    if (!isPriceBasedBeTrigger(cfg.trigger)) return;
    if (!meetsTriggerCondition(cfg.trigger, cfg.customR, currentPrice)) return;
    moveSlToBreakevenLevel(currentPrice);
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
    if (/AAPL|TSLA|NVDA|MSFT|AMZN|GOOGL/.test(u)) return { cls: 'pos-icon-stock', init: u.slice(0, 2) };
    if (/USD|BTC|ETH|SOL|XRP|BNB|DOGE|JUP/.test(u)) return { cls: 'pos-icon-crypto', init: u.slice(0, 2) };
    return { cls: 'pos-icon-futures', init: u.slice(0, 2) };
  }

  /* Build the reusable symbol cell used across all three tabs */
  /* Bottom-panel rows name their venue with the same badge the side, asset type and leverage pills
     use, so it reads as one more fact about the row. Unlike the chart's own lines (which describe a
     single instrument on a single venue, and so only speak up when there's a split to explain —
     see venueBadgeHtml), these tables list many instruments held across several exchanges at once,
     so the venue is always worth stating. */
  function venueRowBadgeHtml(venue) {
    if (!venue) return '';
    return '<span class="pos-venue-badge">' + Venues.venueLabel(venue) + '</span>';
  }
  function symCell(sym, sideCls, sideLabel, subText, venue) {
    const m = symMeta(sym);
    return (
      '<div class="ord-sym-cell">' +
      '<div class="pos-sym-icon ' + m.cls + '">' + m.init + '</div>' +
      '<div class="pos-sym-info">' +
      '<div class="pos-sym-top">' +
      '<span class="pos-sym-ticker">' + sym + '</span>' +
      (sideCls ? '<span class="pos-side-badge ' + sideCls + '">' + sideLabel + '</span>' : '') +
      (venue ? venueRowBadgeHtml(venue) : '') +
      '</div>' +
      (subText ? '<span class="pos-sym-sub">' + subText + '</span>' : '') +
      '</div>' +
      '</div>'
    );
  }

  /* Build one pending-entry row for the Open Orders tab (live order or static mock).
     Shows the fill-progress pill + "Partial" status when partially filled, else "Pending". */
  function openOrderEntryRow(o, cancelAttr) {
    const sideCls = o.side === 'buy' ? 'long' : 'short';
    const sideLabel = o.side === 'buy' ? 'Buy' : 'Sell';
    const partial = o.filledQty > 0 && o.filledQty < o.qty;
    const fillPct = Math.round(o.filledQty / o.qty * 100);
    const qtyCell = partial
      ? '<span class="ord-val-primary">' + o.qty + '</span>' +
      '<span class="fill-progress" data-fill-status="Partially filled" data-fill-pct="' + fillPct + '"' +
      ' data-fill-filled="' + o.filledQty + '" data-fill-total="' + o.qty + '" data-fill-unit="Shares"' +
      ' data-fill-avg="' + fmt(o.avgFill != null ? o.avgFill : o.price) + '">' +
      '<span class="ord-fill-frac">' + o.filledQty + ' / ' + o.qty + ' Shares</span>' +
      '<span class="ord-fill-track">' +
      '<span class="ord-fill-track-bar" style="width:' + fillPct + '%"></span>' +
      '</span></span>'
      : '<span class="ord-val-primary">' + o.qty + '</span>';
    const statusCell = partial
      ? '<span class="bp-status partial">Partial</span>'
      : '<span class="bp-status working">Pending</span>';
    return (
      '<tr>' +
      '<td>' + symCell(o.sym, sideCls, sideLabel, 'Entry · ' + o.orderType, o.venue) + '</td>' +
      '<td>' + qtyCell + '</td>' +
      '<td>' + fmt(o.price) + '</td>' +
      '<td>' + statusCell + '</td>' +
      '<td><span class="bp-action-icon" ' + cancelAttr + '><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
      '</tr>'
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

    /* Static AAPL mockup — a partially-filled resting order demonstrating the fill pill */
    if (mockAaplOrder) {
      rows.push(openOrderEntryRow(mockAaplOrder, 'data-cancel-mock="1"'));
    }

    /* One group per chart order: an entry row while unfilled, or its TP/SL working rows once filled.
       Each cancel control carries the owning order's id so the handler can focus it before acting. */
    allOrders().forEach(o => {
      const closeSideCls = o.side === 'buy' ? 'short' : 'long';
      const closeSideLabel = o.side === 'buy' ? 'Sell' : 'Buy';

      /* Entry row — only while still unfilled; once filled, it's a position, not an order */
      if (!o.filled) {
        rows.push(openOrderEntryRow(
          // Working, not yet filled: the price shown is the one the venue is resting it at.
          { sym: 'ETHUSD', side: o.side, qty: o.qty, filledQty: o.filledQty, price: o.execEntry != null ? o.execEntry : o.entry, orderType: o.orderType, venue: o.execVenue },
          'data-cancel-entry="' + o.id + '"'
        ));
      }

      if (o.filled) {
        o.tps.forEach((tp, i) => {
          const tpQty = Math.max(1, Math.round(o.qty * tp.pct / 100));
          rows.push(
            '<tr' + (i === 0 ? ' class="ord-group-sep"' : '') + '>' +
            '<td>' + symCell('ETHUSD', closeSideCls, closeSideLabel, 'TP ' + (i + 1) + ' · Limit', o.execVenue) + '</td>' +
            '<td><span class="ord-val-primary">' + tpQty + '</span></td>' +
            '<td>' + fmt(tp.execPrice != null ? tp.execPrice : tp.price) + '</td>' +
            '<td><span class="bp-status working">Working</span></td>' +
            '<td><span class="bp-action-icon" data-cancel-tp="' + tp.id + '"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
            '</tr>'
          );
        });

        if (o.sl) {
          rows.push(
            '<tr' + (o.tps.length === 0 ? ' class="ord-group-sep"' : '') + '>' +
            '<td>' + symCell('ETHUSD', closeSideCls, closeSideLabel, 'Stop Loss · Stop', o.execVenue) + '</td>' +
            '<td><span class="ord-val-primary">' + o.qty + '</span></td>' +
            '<td>' + fmt(o.sl.execPrice != null ? o.sl.execPrice : o.sl.price) + '</td>' +
            '<td><span class="bp-status working">Working</span></td>' +
            '<td><span class="bp-action-icon" data-cancel-sl="' + o.id + '"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
            '</tr>'
          );
        }
      }
    });

    /* Working limit closes placed from a position's Close Position panel */
    (window.positionCloseOrders ? window.positionCloseOrders() : []).forEach(o => {
      const sideCls = o.side === 'buy' ? 'long' : 'short';
      const sideLabel = o.side === 'buy' ? 'Buy' : 'Sell';
      rows.push(
        '<tr>' +
        '<td>' + symCell(o.sym, sideCls, sideLabel, 'Close · Limit', o.venue) + '</td>' +
        '<td><span class="ord-val-primary">' + o.qtyText + '</span></td>' +
        '<td>' + (o.execPriceText || o.priceText) + '</td>' +
        '<td><span class="bp-status working">Working</span></td>' +
        '<td><span class="bp-action-icon" data-cancel-close="' + o.id + '"><span class="material-symbols-outlined" style="font-size:15px;">close</span></span></td>' +
        '</tr>'
      );
    });

    body.innerHTML = rows.length ? rows.join('') : '<tr class="bp-empty-row"><td colspan="5">No open orders — right-click the chart to trade.</td></tr>';
    body.querySelectorAll('[data-cancel-entry]').forEach(el => el.addEventListener('click', () => { focusOrderById(el.dataset.cancelEntry); cancelOrder(); }));
    body.querySelectorAll('[data-cancel-mock]').forEach(el => el.addEventListener('click', () => { mockAaplOrder = null; renderOpenOrders(); }));
    body.querySelectorAll('[data-cancel-tp]').forEach(el => el.addEventListener('click', () => { focusOrderByTpId(el.dataset.cancelTp); removeTp(el.dataset.cancelTp); }));
    body.querySelectorAll('[data-cancel-sl]').forEach(el => el.addEventListener('click', () => { focusOrderById(el.dataset.cancelSl); removeSl(); }));
    body.querySelectorAll('[data-cancel-close]').forEach(el => el.addEventListener('click', () => {
      const cancelled = window.cancelPositionCloseOrder(el.dataset.cancelClose);
      if (cancelled) showToast(cancelled.sym + ' limit close cancelled', 'check_circle');
    }));
    const countEl = document.getElementById('bpCountOrders');
    if (countEl) countEl.textContent = rows.length > 0 ? '(' + rows.length + ')' : '';
  }

  /* Working limit closes live in the positions panel (js/right-panel.js); it announces every change
     so the Open Orders table, the history tables and the toast stay in step with them. */
  document.addEventListener('position-close-orders:changed', () => {
    renderOpenOrders();
    render(); // a close on the charted symbol has a line to draw or clear
  });
  document.addEventListener('position-close-order:filled', e => {
    const o = e.detail;
    // A working close carries its own venue and the basis it was placed against, so it is stamped
    // from the close order rather than from whatever chart order happens to be focused.
    orderHistory.unshift({
      symbol: o.sym, side: o.side, qty: o.qtyText, price: o.execPrice != null ? o.execPrice : o.price,
      status: 'filled', type: 'Limit', time: nowTimeStr(), pnl: null, venue: o.venue,
    });
    tradeHistory.unshift({
      symbol: o.sym, side: o.side, qty: o.qtyText, price: o.execPrice != null ? o.execPrice : o.price, pnl: o.pnl,
      role: 'close', type: 'Limit', time: nowTimeStr(), fee: QT_FEE_PER_CONTRACT, venue: o.venue,
    });
    renderOpenOrders();
    renderOrderHistory();
    renderTradeHistory();
    showToast(o.sym + ' limit close filled at ' + o.priceText +
      (o.closedPosition ? ' — position closed' : ''), 'check_circle');
  });

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
      const sideCls = h.side === 'buy' ? 'long' : 'short';
      const sideLabel = h.side === 'buy' ? 'Buy' : 'Sell';
      const statusLabel = h.status.charAt(0).toUpperCase() + h.status.slice(1);
      return (
        '<tr>' +
        '<td>' + symCell(h.symbol, sideCls, sideLabel, h.type || '', h.venue) + '</td>' +
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
      const sideCls = t.side === 'buy' ? 'long' : 'short';
      const sideLabel = t.side === 'buy' ? 'Buy' : 'Sell';
      const subText = t.role === 'open'
        ? 'Open · ' + t.type
        : t.type === 'Limit (TP)' ? 'Take Profit · Close'
          : t.type === 'Stop (SL)' ? 'Stop Loss · Close'
            : t.type === 'Limit' ? 'Limit Close'
              : 'Market Close';
      return (
        '<tr>' +
        '<td>' + symCell(t.symbol, sideCls, sideLabel, subText, t.venue) + '</td>' +
        '<td><span class="ord-val-primary">' + t.qty + '</span></td>' +
        '<td>' + fmt(t.price) + '</td>' +
        '<td>' + pnlCellHtml(t.pnl !== null ? t.pnl - t.fee : null) + '</td>' +
        '<td><span class="ord-val-sub" style="display:inline">' + fmtMoney(t.fee) + '</span></td>' +
        '<td><span class="ord-val-sub" style="display:inline">' + t.time + '</span></td>' +
        '</tr>'
      );
    }).join('');
  }

  // Risk $ and Risk % size the position the same way — from the stop-loss distance and a risk budget in
  // dollars. They differ only in how that budget is expressed: an absolute amount vs a % of the account.
  const RISK_MODES = ['risk', 'risk_pct'];
  function isRiskMode(mode) { return RISK_MODES.includes(mode); }
  function effectiveRiskDollars(sizeValues, mode) {
    return mode === 'risk_pct'
      ? ACCOUNT_BALANCE * (sizeValues.riskPct || 0) / 100
      : (sizeValues.risk || 0);
  }
  /* The stop that sizes `o`. An add-on has no stop of its own, so it sizes against its direction's
     owner — the stop that will actually protect it once it has merged in. Covers both shapes: an
     add-on under a filled main, and an add-on under a pending owner. */
  function sizingStopFor(o) {
    if (!o) return null;
    if (o.sl) return o.sl;
    const owner = tpSlOwner(o.side);
    return owner && owner !== o ? owner.sl : null;
  }
  /* A risk-sized add-on's quantity comes from a stop it doesn't own, so it has to follow that stop
     wherever it goes — dragged, trailed, moved to breakeven, or replaced when ownership changes.
     Re-derived here, from render, rather than at each of those call sites: they all end in a render,
     and syncQtyFromRisk on the owner alone would leave the add-on holding a stale size. Orders that
     size some other way, or own their stop, are left alone. */
  function resyncRiskSizedAddOns() {
    const keepFocus = order;
    allOrders().forEach(o => {
      if (o.filled || o.sl || !isRiskMode(o.sizeMode)) return;
      order = o;
      syncQtyFromRisk();
    });
    order = keepFocus;
  }
  /* Per-contract risk used to size Risk $ / Risk % orders. This is the NET loss a single
     contract takes if the stop is hit — the raw stop distance PLUS the round-trip fee (entry
     fill + stop-market exit) — so the sized position's loss at the stop matches the SL chip's
     net figure (slFeeCalc) exactly. Entry fee depends on order type (maker vs taker); the SL
     always exits as a taker/market fill. Takes the stop as an argument because an add-on sizes
     against another order's (see sizingStopFor); callers guard that it exists. */
  function netRiskPerContract(stop) {
    const stopDist = Math.abs(order.entry - stop.price);
    const grossRisk = stopDist * POINT_VALUE;
    const entryFeeRate = /Market/.test(order.orderType) ? FEE_RATE_MARKET : FEE_RATE_LIMIT;
    const feePerContract = order.entry * entryFeeRate + stop.price * FEE_RATE_MARKET;
    return grossRisk + feePerContract;
  }
  function syncQtyFromRisk() {
    const stop = sizingStopFor(order);
    if (!order || !isRiskMode(order.sizeMode) || !stop) return;
    const riskPerContract = netRiskPerContract(stop);
    const riskDollars = effectiveRiskDollars(order.sizeValues, order.sizeMode);
    if (riskPerContract > 0) { order.qty = Math.max(0, Math.floor(riskDollars / riskPerContract * 100) / 100); }
  }

  /* The unit count implied by a USD ($) or % Account position-size value. Both size off
     MARGIN_PER_CONTRACT — the single source of truth for the size menu's "Estimated Units"
     readout, the chart-trade default, and the size-menu Apply. Returns null for modes that
     derive qty another way (Units is verbatim; Risk modes size from the stop loss). */
  function unitsForSizeValue(mode, sizeValues) {
    if (mode === 'dollar') return +((sizeValues.dollar || 0) / MARGIN_PER_CONTRACT).toFixed(2);
    if (mode === 'percent') return +((ACCOUNT_BALANCE * (sizeValues.percent || 0) / 100) / MARGIN_PER_CONTRACT).toFixed(2);
    return null;
  }

  /* In a Risk mode, a stop-loss dragged too far (or a risk amount set too low) drives the
     floored quantity to 0 — no position can be opened. Shared by the size menu, the on-chart
     SL chip, and the live-drag toggle so the check stays in one place. */
  const RISK_LIMIT_MSG = 'The selected stop-loss exceeds your risk limit. Move the stop-loss closer or increase your risk amount.';
  /* Risk sizing derives quantity from the stop-loss distance, so with no stop the size can't be computed.
     Block placement and surface a warning (on the size pill) instead of a misleading number. An add-on
     has no stop handle of its own, so its message points at whichever order's stop would size it —
     telling it to "add a stop loss" would name a control it doesn't have. */
  const RISK_NO_SL_MSG = 'Add a stop loss to size this order by your risk amount.';
  /* Names the order whose stop sizes the focused one, for messages shown when that stop is missing.
     Null when the order sizes off a stop of its own — it just needs one dragged onto the chart. An
     add-on has no stop handle, so telling it to drag one would name a control it doesn't have. */
  function sizingStopOwnerLabel() {
    const owner = (order && isAddOn(order)) ? tpSlOwner(order.side) : null;
    if (!owner) return null;
    return owner.filled
      ? 'your open ' + (order.side === 'buy' ? 'long' : 'short')
      : 'your first ' + (order.side === 'buy' ? 'buy' : 'sell') + ' order';
  }
  function riskNoStopMsg() {
    const target = sizingStopOwnerLabel();
    return target
      ? 'Add a stop loss to ' + target + ' to size this order by your risk amount.'
      : RISK_NO_SL_MSG;
  }
  function riskNeedsStop() {
    return !!order && isRiskMode(order.sizeMode) && !sizingStopFor(order);
  }
  function riskLimitExceeded() {
    const stop = sizingStopFor(order);
    if (!order || !isRiskMode(order.sizeMode) || !stop) return false;
    const riskPerContract = netRiskPerContract(stop);
    const riskDollars = effectiveRiskDollars(order.sizeValues, order.sizeMode);
    return riskPerContract > 0
      && Math.floor(riskDollars / riskPerContract * 100) / 100 === 0;
  }

  /* Explains why a TP/SL chip is flagged invalid (wrong side of entry). Direction-aware so it
     names the side the level should be on. */
  function wrongSideTip(kind) {
    const isLong = order.side === 'buy';
    return kind === 'tp'
      ? 'Take profit is on the wrong side of price. Move it ' + (isLong ? 'above' : 'below') + ' price to lock in a profit.'
      : 'Stop loss is on the wrong side of price. Move it ' + (isLong ? 'below' : 'above') + ' price — otherwise it would trigger immediately.';
  }

  /* A Stop Limit's STOP is flagged when it sits on the side of the market it has already crossed:
     a buy stop must be ABOVE the market (to wait for a breakout up), a sell stop BELOW it. On the
     wrong side it can't wait for anything and just behaves like a plain limit. Suppressed once the
     stop has armed (stopTriggered), since a crossed stop below the market is then the valid state. */
  function stopLimitStopWrongSide() {
    if (!order || order.filled || order.stopTriggered || order.orderType !== 'Stop Limit') return false;
    if (order.triggerPrice == null) return false;
    const mkt = qtCurrentPrice();
    return order.side === 'buy' ? order.triggerPrice <= mkt : order.triggerPrice >= mkt;
  }
  function stopWrongSideTip() {
    return order.side === 'buy'
      ? 'Stop is at or below the market, so it will not wait for a breakout. Use a Buy Limit for a lower entry.'
      : 'Stop is at or above the market, so it will not wait for a breakdown. Use a Sell Limit for a higher entry.';
  }

  /* Builds the attribute string that turns a chip's warning icon into a wrapped hover tooltip.
     Shared by the wrong-side (TP/SL) and risk-limit (SL) warnings. */
  function warnTipAttr(msg) {
    return ' data-tooltip="' + msg + '" data-tooltip-wrap';
  }

  /* Label shown in the entry-bar size pill. Shared by render() and the live SL drag handler. */
  function sizePillLabel() {
    return order.sizeMode === 'dollar' ? '$' + fmt(order.sizeValues.dollar, 0)
      : order.sizeMode === 'percent' ? order.sizeValues.percent + '%'
        : fmt(order.qty, 2);            // 'contracts', 'risk' and 'risk_pct' all show qty
  }

  /* ---------- TP/SL fee & net PnL helpers ---------- */
  /* Entry fee depends on order type (market fill vs limit fill); TP exit is always a limit order. */
  function tpFeeCalc(tp, contracts, atPrice) {
    if (atPrice == null) atPrice = tp.price;
    const dir = order.side === 'buy' ? 1 : -1;
    const gross = dir * (atPrice - order.entry) * POINT_VALUE * contracts;
    const entryFeeRate = /Market/.test(order.orderType) ? FEE_RATE_MARKET : FEE_RATE_LIMIT;
    const fee = (order.entry * entryFeeRate + atPrice * FEE_RATE_LIMIT) * contracts;
    return { gross, fee, net: gross - fee };
  }
  /* SL exit is always a stop order (taker fill), unlike a TP's limit exit. */
  function slFeeCalc() {
    const dir = order.side === 'buy' ? 1 : -1;
    const gross = dir * (order.sl.price - order.entry) * POINT_VALUE * order.qty;
    const entryFeeRate = /Market/.test(order.orderType) ? FEE_RATE_MARKET : FEE_RATE_LIMIT;
    const fee = (order.entry * entryFeeRate + order.sl.price * FEE_RATE_MARKET) * order.qty;
    return { gross, fee, net: gross - fee };
  }
  function feeTooltipHtml(gross, fee, net) {
    const sign = v => v >= 0 ? '+' : '';
    const cls = v => v >= 0 ? 'up' : 'down';
    return '<span class="ol-fee-row"><span class="ol-fee-lbl">Gross</span><span class="ol-fee-val ' + cls(gross) + '">' + sign(gross) + fmtMoney(gross) + '</span></span>' +
      '<span class="ol-fee-row"><span class="ol-fee-lbl">Fee</span><span class="ol-fee-val">-' + fmtMoney(fee) + '</span></span>' +
      '<span class="ol-fee-row ol-fee-row-net"><span class="ol-fee-lbl">Net</span><span class="ol-fee-val ' + cls(net) + '">' + sign(net) + fmtMoney(net) + '</span></span>';
  }

  /* ---------- drag behaviour ---------- */
  /* the price a TP/SL's side is validated against. A working (unfilled) order validates against its
     entry, so you can't stage a TP/SL on the wrong side before the trade exists. A filled position
     validates against the live market: once you're in the trade a TP/SL that has drifted past entry is
     still perfectly valid — it only becomes unworkable if it crosses to the wrong side of the market. */
  function tpSlSideRef() { return (order && order.filled) ? qtCurrentPrice() : order.entry; }
  /* a TP/SL is only valid on the correct side of the reference price: long TP above / SL below,
     short TP below / SL above (reference = entry while working, live market once filled) */
  function tpSlSideOk(kind, price) {
    const dir = order.side === 'buy' ? 1 : -1;
    const ref = tpSlSideRef();
    return kind === 'tp' ? dir * (price - ref) > 0 : dir * (ref - price) > 0;
  }
  /* a trailing SL legitimately ratchets past entry once price has moved far enough in your favor —
     that's the stop automatically locking in profit, not a misconfiguration, so don't flag it as invalid.
     A manual drag past entry is still a mistake (the stop would trigger immediately) and stays flagged. */
  function slSideWarningSuppressed() { return slTrailActive() && !!order.sl.autoTrailing; }
  function orderTpSlValid() {
    if (!order) return true;
    return order.tps.every(tp => tpSlSideOk('tp', tp.price)) && (!order.sl || tpSlSideOk('sl', order.sl.price));
  }
  /* Reasons an otherwise-placeable order still can't be submitted: a TP/SL on the wrong side
     of price, or (Risk $ mode) a stop-loss so far it drives the quantity to 0. */
  function orderPlaceBlocked() {
    return !orderTpSlValid() || riskLimitExceeded() || riskNeedsStop();
  }
  /* toggle the entry chip's disabled state without a full render(), so it reacts live while dragging */
  function updateEntryPlaceableState() {
    if (!order) return;
    const handle = orderScope().querySelector('#entryPriceHandle');
    if (!handle) return;
    handle.classList.toggle('disabled', order.pendingConfirm && !order.filled && orderPlaceBlocked());
  }
  /* re-check every TP/SL chip's invalid state without a full render() — used while dragging Entry/TP/SL */
  function updateAllTpSlValidityLive() {
    if (!order) return;
    orderScope().querySelectorAll('.ol-side-row[data-tp-id]').forEach(row => {
      const tp = order.tps.find(t => t.id === row.dataset.tpId);
      if (tp) row.querySelector('.ol-chip').classList.toggle('invalid', !tpSlSideOk('tp', tpDisplayPrice(tp)) && !tpSideWarningSuppressed(tp));
    });
    if (order.sl) {
      const slChip = orderScope().querySelector('.ol-chip.sl');
      if (slChip) {
        slChip.classList.toggle('invalid', !tpSlSideOk('sl', order.sl.price) && !slSideWarningSuppressed());
        slChip.classList.toggle('risk-exceeded', riskLimitExceeded());
      }
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
    orderScope().querySelectorAll('.ol-side-row[data-tp-id]').forEach(row => {
      const tp = order.tps.find(t => t.id === row.dataset.tpId);
      if (!tp) return;
      const displayPrice = tpDisplayPrice(tp);
      const pts = dir * (displayPrice - order.entry);
      const amtEl = row.querySelector('.ol-amt');
      if (amtEl) {
        const contracts = Math.max(1, Math.round(order.qty * tp.pct / 100));
        const { gross, fee, net } = tpFeeCalc(tp, contracts, displayPrice);
        const valEl = amtEl.querySelector('.ol-amt-val');
        if (valEl) valEl.textContent = (net >= 0 ? '+' : '') + fmtMoney(net);
        amtEl.classList.toggle('up', net >= 0);
        amtEl.classList.toggle('down', net < 0);
        const tipEl = amtEl.querySelector('.ol-fee-tip');
        if (tipEl) tipEl.innerHTML = feeTooltipHtml(gross, fee, net);
      }
      const rEl = row.querySelector('.ol-tp-meta-r');
      if (rEl) {
        const rMultiple = riskPerContractTotal ? (pts * POINT_VALUE / riskPerContractTotal) : null;
        rEl.textContent = rMultiple !== null ? fmt(rMultiple, 1) + 'R' : '—R';
      }
    });
    if (order.sl) {
      const slAmtEl = orderScope().querySelector('.ol-chip.sl .ol-amt');
      if (slAmtEl) {
        const { gross, fee, net } = slFeeCalc();
        const valEl = slAmtEl.querySelector('.ol-amt-val');
        if (valEl) valEl.textContent = (net >= 0 ? '+' : '') + fmtMoney(net);
        slAmtEl.classList.toggle('up', net >= 0);
        slAmtEl.classList.toggle('down', net < 0);
        const tipEl = slAmtEl.querySelector('.ol-fee-tip');
        if (tipEl) tipEl.innerHTML = feeTooltipHtml(gross, fee, net);
      }
    }
  }
  /* repositions just the entry line/bar without a full render() — used while a TP/SL drag is in progress,
     since a pending Market order's entry tracks the live price tick but render() is suppressed mid-drag
     to avoid wiping the drag's own DOM (see isDraggingOrderLine) */
  function updateEntryLinePositionLive() {
    if (!order) return;
    const line = orderScope().querySelector('.ol-line.entry');
    const bar = orderScope().querySelector('.ol-entry-bar');
    if (!line || !bar) return;
    const H = rectH();
    const y = clamp(priceToY(order.entry, H), 10, H - 10);
    line.style.top = y + 'px';
    // Don't park the bar on the line directly — dodgeEntryBars owns the bar's `top` and may be holding
    // it off the line to clear a neighbouring order.
    bar.dataset.trueY = y;
    dodgeEntryBars();
    updateAllTpSlValidityLive();
    updateAllTpSlReadoutsLive();
  }
  /* Lock RR (Chart Trades > Global Behavior): shifts every TP and the SL by the same amount the
     entry just moved, so their distance from entry — and therefore their R-multiple — stays exactly
     what it was before the move. */
  function applyLockRRShift(deltaPrice) {
    if (!order || !deltaPrice || !chartSettings.globalBehavior.lockRR) return;
    order.tps.forEach(tp => { tp.price = roundTick(tp.price + deltaPrice); });
    if (order.sl) order.sl.price = roundTick(order.sl.price + deltaPrice);
  }
  /* single setter for order.entry so every caller — manual drag or the live-price tracking of a
     pending market order — gets the Lock RR shift applied consistently */
  function setOrderEntryPrice(newEntry) {
    const deltaPrice = newEntry - order.entry;
    order.entry = newEntry;
    applyLockRRShift(deltaPrice);
  }
  /* repositions every TP/SL line + row without a full render() — used alongside updateEntryLinePositionLive
     while the entry is moving, since Lock RR shifts their prices in lockstep with it */
  function updateAllTpSlLinePositionsLive() {
    if (!order) return;
    const H = rectH();
    order.tps.forEach(tp => {
      const row = orderScope().querySelector('.ol-side-row[data-tp-id="' + tp.id + '"]');
      const line = row && row.previousElementSibling;
      if (!row || !line) return;
      const y = clamp(priceToY(tp.price, H), 10, H - 10);
      row.style.top = y + 'px';
      line.style.top = y + 'px';
      moveVenueTag(orderScope(), 'tp:' + tp.id, y);
    });
    if (order.sl) {
      const slChip = orderScope().querySelector('.ol-chip.sl');
      const row = slChip && slChip.closest('.ol-side-row');
      const line = row && row.previousElementSibling;
      if (!row || !line) return;
      const y = clamp(priceToY(order.sl.price, H), 10, H - 10);
      row.style.top = y + 'px';
      line.style.top = y + 'px';
      moveVenueTag(orderScope(), 'sl', y);
    }
  }
  /* Reposition the Breakeven Price overlay while the entry is dragged — it's derived from entry, so its
     line and label track the entry live instead of only snapping back into place on drop. */
  function updateBreakevenLineLive() {
    if (!order || !chartSettings.breakevenLine.enabled) return;
    const line = orderScope().querySelector('.ol-line.breakeven-price');
    const label = orderScope().querySelector('.ol-offset-label.breakeven-price');
    if (!line || !label) return;
    const bePrice = breakevenLinePrice();
    if (bePrice === null) return;
    const y = clamp(priceToY(bePrice, rectH()), 10, rectH() - 10) + 'px';
    line.style.top = y;
    label.style.top = y;
    const txt = label.querySelector('.ol-offset-label-text');
    if (txt) txt.textContent = 'BREAKEVEN · ' + fmt(bePrice);
  }
  /* a plain click (no movement) on the handle falls through to onClick (if given) instead of dragging — */
  /* lets a handle double as both a drag target and a menu/edit/place trigger (e.g. the size/type pills, .ol-amt) */
  function makeDraggable(handle, onDrag, onDrop, excludeSelector, onClick, hoverKey) {
    handle.addEventListener('mousedown', (e) => {
      if (excludeSelector && e.target.closest(excludeSelector)) return;
      e.preventDefault(); e.stopPropagation();
      closeAllPopovers();
      isDraggingOrderLine = true;
      // Mark this handle as "hovered" for the drag's duration so the chart suppresses the
      // crosshair and highlights this line's right-axis label (same mechanism as chip hover).
      if (hoverKey) { hoveredHandle = hoverKey; if (crosshair) crosshair = null; scheduleDrawPriceChart(); }
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
        if (hoverKey && hoveredHandle === hoverKey) { hoveredHandle = null; scheduleDrawPriceChart(); }
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
        '<span class="material-symbols-outlined ol-chip-warning">error</span>' +
        '<span class="ol-drag-float-label">' + kind.toUpperCase() + '</span>' +
        '<span class="ol-drag-float-amt"></span>';
      layer.appendChild(floatChip);
      const amtEl = floatChip.querySelector('.ol-drag-float-amt');

      function isValid(rawPrice) {
        const ref = tpSlSideRef();
        const signedDist = kind === 'tp' ? dir * (rawPrice - ref) : dir * (ref - rawPrice);
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
          order.tps.push({ id: newId, price: finalPrice, pct: 100, trailing: !!chartSettings.trailingTp.enabledByDefault, trailOffset: makeTpTrailOffset(), activated: false, exitPrice: null });
          rebalanceTpAllocations(newId);
        } else {
          order.sl = { price: finalPrice, enabled: !!chartSettings.trailingStop.enabledByDefault, mode: 'trailing', autoTrailing: false, atrMult: (chartSettings.atrStop.multiplier || 2.0), beTpId: null, beActive: false, beOverride: null, trailOverride: makeSlConfig() };
          applySlModePlacement(); // the placement gap is the trail distance
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
  // mulberry32 is a shared global from js/utils.js
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
  // Point-in-time news — each marker anchors to a past candle (idxFromEnd >= 0) and
  // reads like a trade signal: bullish below the low, bearish above the high.
  // idxFromEnd values above ~60 sit just past the default-visible chart window on
  // first load — pan left to reveal them, same as scrolling back through older news.
  const newsEvents = [
    {
      idxFromEnd: 14,
      source: 'News',
      sentiment: 'bearish',
      importance: 'high',
      type: 'news',
      headline: 'SEC Delays Ruling on Ether ETF Options Listing',
      description: 'The regulator pushed its decision window on the pending spot Ether ETF options proposal, citing the need for further review of market manipulation safeguards. Traders had priced in approval this week, raising the odds of near-term volatility.',
    },
    {
      idxFromEnd: 4,
      source: 'X',
      sentiment: 'bullish',
      importance: 'medium',
      type: 'social',
      headline: '@realDonaldTrump: "We are going to make the United States the bitcoin and crypto capital of the world!"',
      description: 'Pro-crypto rhetoric reignites optimism around friendlier U.S. digital asset policy.',
    },
    {
      idxFromEnd: 9,
      source: 'News',
      sentiment: 'bullish',
      importance: 'high',
      type: 'news',
      headline: 'Fed Chair Signals Openness to September Rate Cut',
      description: 'Comments at a policy forum boosted bets on imminent easing, lifting risk assets broadly.',
    },
    {
      idxFromEnd: 20,
      source: 'X',
      sentiment: 'bullish',
      importance: 'high',
      type: 'social',
      headline: '@saylor: "MicroStrategy just added 10,000 more Bitcoin. Institutional conviction has never been higher."',
      description: 'Saylor\'s latest purchase announcement reinforces the institutional demand narrative, driving fresh optimism across crypto markets.',
    },
    {
      idxFromEnd: 27,
      source: 'X',
      sentiment: 'bullish',
      importance: 'medium',
      type: 'social',
      headline: '@elonmusk: "Had a constructive call with the SEC on crypto regulatory clarity."',
      description: 'Traders read the comment as a sign friendlier rules are coming.',
    },
    {
      idxFromEnd: 42,
      source: 'News',
      sentiment: 'bullish',
      importance: 'high',
      type: 'news',
      headline: 'Nonfarm Payrolls Crush Estimates, Unemployment Falls',
      description: 'A blowout jobs report initially weighed on rate-cut bets, but risk assets recovered as the soft-landing narrative held.',
    },
    {
      idxFromEnd: 58,
      source: 'X',
      sentiment: 'bearish',
      importance: 'high',
      type: 'geopolitical',
      headline: '@realDonaldTrump: "China is not living up to the deal. Tariffs going up substantially!"',
      description: 'Tariff-escalation rhetoric pressured risk assets across the board.',
    },
    {
      idxFromEnd: 78,
      source: 'News',
      sentiment: 'bearish',
      importance: 'high',
      type: 'news',
      headline: 'US Core CPI Comes In Above Expectations',
      description: 'A hotter-than-forecast inflation print pressured rate-cut bets and sent risk assets lower.',
    },
  ].map(ev => Object.assign(ev, { timeLabel: newsTimeLabel(ev.idxFromEnd) }));
  // Upcoming scheduled macro events — rendered as a neutral vertical line in the
  // future area (negative idxFromEnd = ahead of the last candle).
  const scheduledEvents = [
    {
      idxFromEnd: -20,
      name: 'FOMC Rate Decision',
      description: 'The Federal Reserve announces its benchmark interest rate decision, followed by Chair Powell’s press conference and updated economic projections. Markets expect rates to remain unchanged, with traders closely watching for any shift in guidance on the pace of future rate cuts.',
    },
  ];
  let newsMarkerEls = null;
  let hoveringNewsMarker = false;

  const NEWS_TYPE_LABELS = {
    'news': 'News',
    'social': 'Social',
    'geopolitical': 'Geopolitical',
    'corporate': 'Corporate',
  };

  function buildNewsMarkers() {
    if (!newsMarkerLayer) return [];
    const els = newsEvents.map(ev => {
      const el = document.createElement('div');
      el.className = 'news-marker ' + ev.sentiment;

      const iconGlyph = '<span class="material-symbols-outlined">article</span>';

      const sentimentIcon = ev.sentiment === 'bearish' ? 'arrow_downward' : 'arrow_upward';
      const categoryLabel = NEWS_TYPE_LABELS[ev.type] || 'News';

      el.innerHTML =
        '<div class="news-marker-signal">' +
        '<div class="news-marker-icon">' + iconGlyph + '</div>' +
        '<div class="news-marker-caret"></div>' +
        '</div>' +
        '<div class="news-marker-popup">' +
        '<div class="news-bar"></div>' +
        '<div class="news-main">' +
        '<div class="news-row-top">' +
        '<span class="news-category ' + ev.sentiment + '">' +
        '<span class="material-symbols-outlined news-sentiment-icon">' + sentimentIcon + '</span>' +
        categoryLabel + '</span>' +
        '<span class="news-time">' + ev.timeLabel + '</span>' +
        '</div>' +
        '<div class="news-headline">' + ev.headline + '</div>' +
        '<div class="news-desc">' + ev.description + '</div>' +
        '</div>' +
        '</div>';

      newsMarkerLayer.appendChild(el);

      const vline = document.createElement('div');
      vline.className = 'news-vline ' + ev.sentiment;
      newsMarkerLayer.appendChild(vline);
      el._vline = vline;

      const signal = el.querySelector('.news-marker-signal');

      signal.addEventListener('mouseenter', () => {
        el.classList.add('hovered');
        vline.classList.add('show');
        hoveringNewsMarker = true;
        if (crosshair) { crosshair = null; scheduleDrawPriceChart(); }
      });
      signal.addEventListener('mouseleave', () => {
        el.classList.remove('hovered');
        if (!el.classList.contains('active')) vline.classList.remove('show');
        hoveringNewsMarker = false;
      });
      signal.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasActive = el.classList.contains('active');
        els.forEach(m => {
          m.classList.remove('active');
          if (m._vline && !m.classList.contains('hovered')) m._vline.classList.remove('show');
        });
        if (!wasActive) {
          el.classList.add('active');
          vline.classList.add('show');
        }
      });

      return el;
    });
    return els;
  }
  document.addEventListener('click', () => {
    if (newsMarkerEls) newsMarkerEls.forEach(m => {
      m.classList.remove('active');
      if (m._vline && !m.classList.contains('hovered')) m._vline.classList.remove('show');
    });
  });
  function renderNewsMarkers(slot, baseIndexOffset, panX, plotW, ih, n, h) {
    if (!newsMarkerLayer) return;
    if (!newsMarkerEls) newsMarkerEls = buildNewsMarkers();

    const ns = (chartSettings && chartSettings.news) ? chartSettings.news : CS_DEFAULTS.news;
    const timeRangeHours = { '6h': 6, '24h': 24, '3d': 72, '7d': 168, 'all': Infinity }[ns.timeRange] ?? Infinity;

    // First pass: determine which indices pass all filters, track past events for maxEvents trimming.
    const filteredIndices = new Set();
    const pastCandidates = [];

    newsEvents.forEach((ev, i) => {
      if (ev.idxFromEnd >= 0 && !ns.showPast) return;
      if (ev.idxFromEnd < 0 && !ns.showUpcoming) return;
      if (ns.sentimentFilter !== 'all' && ev.sentiment !== ns.sentimentFilter) return;
      if (!ns.importance[ev.importance]) return;
      if (!ns.types[ev.type]) return;
      if (ev.idxFromEnd >= 0) {
        const ageHours = (ev.idxFromEnd * BAR_INTERVAL_MIN) / 60;
        if (ageHours > timeRangeHours) return;
        pastCandidates.push({ i, age: ev.idxFromEnd });
      } else {
        filteredIndices.add(i);
      }
    });

    pastCandidates.sort((a, b) => a.age - b.age);
    pastCandidates.slice(0, ns.maxEvents).forEach(({ i }) => filteredIndices.add(i));

    // Second pass: position or hide each marker.
    const posMode = ns.position || 'by-sentiment';
    newsEvents.forEach((ev, i) => {
      const el = newsMarkerEls[i];
      const vline = el._vline;

      if (!filteredIndices.has(i)) {
        el.style.display = 'none';
        if (vline) vline.classList.remove('show');
        return;
      }

      const barIndex = (n - 1) - ev.idxFromEnd;
      const bar = candleBars[barIndex];
      const x = slot * (barIndex - baseIndexOffset) + slot / 2 + panX;

      if (!bar || x < -slot || x > plotW + slot) {
        el.style.display = 'none';
        if (vline) vline.classList.remove('show');
        return;
      }

      el.classList.remove('pos-above', 'pos-below', 'bottom-bar');
      let anchorY;
      if (posMode === 'bottom') {
        anchorY = ih - 14;
        el.classList.add('bottom-bar');
      } else if (posMode === 'always-above') {
        anchorY = priceToY(bar.high, h);
        el.classList.add('pos-above');
      } else if (posMode === 'always-below') {
        anchorY = priceToY(bar.low, h);
        el.classList.add('pos-below');
      } else {
        anchorY = ev.sentiment === 'bullish' ? priceToY(bar.low, h) : priceToY(bar.high, h);
      }

      el.style.display = '';
      el.style.left = x + 'px';
      el.style.setProperty('--anchor-y', clamp(anchorY, 14, ih - 14) + 'px');
      if (vline) vline.style.left = x + 'px';
    });
  }
  let eventLineEls = null;
  function buildEventLines() {
    if (!eventLineLayer) return [];
    const els = scheduledEvents.map(ev => {
      const { date, time } = eventDateTime(ev.idxFromEnd);
      const el = document.createElement('div');
      el.className = 'event-line';
      el.innerHTML =
        '<div class="event-line-rule"></div>' +
        '<div class="event-line-card">' +
        '<div class="event-line-bar"></div>' +
        '<div class="event-line-main">' +
        '<div class="event-line-header">' +
        '<div class="event-line-name">' + ev.name + '</div>' +
        '<div class="event-line-when">' + date + ' · ' + time + '</div>' +
        '<div class="event-line-countdown">' + eventCountdown(ev.idxFromEnd) + '</div>' +
        '</div>' +
        '<div class="event-line-details">' +
        '<div class="event-line-desc">' + ev.description + '</div>' +
        '</div>' +
        '</div>' +
        '</div>';
      eventLineLayer.appendChild(el);
      const header = el.querySelector('.event-line-header');
      header.addEventListener('click', (e) => {
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
    if (eventLineEls) eventLineEls.forEach(m => m.classList.remove('active'));
  });
  function renderEventLines(slot, baseIndexOffset, panX, plotW, ih, n) {
    if (!eventLineLayer) return;
    if (!eventLineEls) eventLineEls = buildEventLines();
    const visible = [];
    scheduledEvents.forEach((ev, i) => {
      const el = eventLineEls[i];
      const barIndex = (n - 1) - ev.idxFromEnd;
      const x = slot * (barIndex - baseIndexOffset) + slot / 2 + panX;
      if (x < 0 || x > plotW) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = x + 'px';
      el.style.setProperty('--rule-h', ih + 'px');
      visible.push({ x, el });
    });
    // Cards are wider than the bar spacing, so stack collisions into vertical
    // lanes (left-to-right), growing upward from the bottom anchor.
    const cardW = 148, gap = 8, laneH = 38;
    const laneRightEdge = [];
    visible.sort((a, b) => a.x - b.x).forEach(({ x, el }) => {
      let lane = 0;
      while (lane < laneRightEdge.length && laneRightEdge[lane] > x - cardW / 2 - gap) lane++;
      laneRightEdge[lane] = x + cardW / 2;
      el.style.setProperty('--marker-bottom', (30 + lane * laneH) + 'px');
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
  function eventDateTime(idxFromEnd) {
    const d = new Date(Date.now() - idxFromEnd * BAR_INTERVAL_MIN * 60000);
    return {
      date: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
  }
  function eventCountdown(idxFromEnd) {
    const mins = -idxFromEnd * BAR_INTERVAL_MIN; // future events have negative idxFromEnd
    if (mins <= 0) return 'now';
    const hrs = mins / 60;
    if (hrs < 24) {
      const h = Math.round(hrs * 10) / 10;
      return 'in ' + (h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)) + 'h';
    }
    return 'in ' + Math.round(hrs / 24) + 'd';
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
    if (isPrimary) {
      renderNewsMarkers(slot, baseIndexOffset, panX, plotW, ih, n, h);
      renderEventLines(slot, baseIndexOffset, panX, plotW, ih, n);
    }

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
    /* The axis tag for one order level. Deliberately shows the chart price only, even when the
       execution venue is trading elsewhere: this axis IS the chart's price scale, so a tag on it is
       a positional claim — "this level sits here". An execution price is not at that position on
       this scale, so printing it here would assert something untrue about the geometry. The
       translation belongs to the order, not to the axis, and is read by hovering the line's venue
       badge (see venueBadgeHtml). */
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
    /* These tags only ever describe one order. While a side is hovered they follow it, so the axis
       agrees with the faded chart body instead of still showing the other position's prices; with
       nothing hovered they track the focused order as before. A side's TP/SL live on its owner, which
       is exactly what there is to tag. */
    const tagOrder = (hoveredSide ? tpSlOwner(hoveredSide) : null) || order;
    if (isPrimary && tagOrder) {
      const orderDir = tagOrder.side === 'buy' ? 1 : -1;
      const offsetColor = themeColor('--intel');
      tagOrder.tps.forEach(tp => {
        drawOrderAxisTagOutline(tp.price, upColor, hoveredHandle === 'tp:' + tp.id);
        if (tp.trailing) {
          const offsetPrice = (tp.activated && tp.exitPrice != null)
            ? tp.exitPrice
            : roundTick(tp.price - orderDir * tpOffsetDist(tp));
          drawOrderAxisTagOutline(offsetPrice, offsetColor, hoveredHandle === 'offset:' + tp.id);
        }
      });
      if (tagOrder.sl) drawOrderAxisTagOutline(tagOrder.sl.price, downColor, hoveredHandle === 'sl');
      drawOrderAxisTagOutline(tagOrder.entry, tagOrder.side === 'buy' ? upColor : downColor, hoveredHandle === 'entry');
    }

    /* Working limit closes get an axis tag like every other resting price. They hang off a position
       rather than a chart order, so they're read from the panel's list instead of the focused order. */
    if (isPrimary && window.positionCloseOrders) {
      const closeColor = themeColor('--info');
      window.positionCloseOrders().forEach(closeOrder => {
        if (closeOrder.sym !== CHART_SYMBOL) return;
        drawOrderAxisTagOutline(closeOrder.price, closeColor, hoveredHandle === 'close:' + closeOrder.id);
      });
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
    if (isPanning || hoveringNewsMarker || hoveredHandle || isHoveringBarControls || isHoveringIndLegend || isHoveringClHeader || x < 0 || x > plotW || y < 0 || y > ih) {
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); updateLegendValues(); }
      return;
    }
    crosshair = { x, y };
    scheduleDrawPriceChart();
    updateLegendValues();
  });
  chart.addEventListener('mouseleave', () => {
    if (!crosshair) return;
    crosshair = null;
    scheduleDrawPriceChart();
    updateLegendValues();
  });

  /* ---------- chart legend (top-left: symbol/timeframe/exchange, OHLC, indicators) ---------- */
  const clSymbol = document.getElementById('clSymbol');
  const clTimeframe = document.getElementById('clTimeframe');
  const clExchange = document.getElementById('clExchange');
  const clOhlc = document.getElementById('clOhlc');
  const clIndicators = document.getElementById('clIndicators');

  /* Hovering an indicator row in the legend suppresses the chart crosshair (same mechanism
     as the order-line bar controls) so the row reads as an interactive element, not chart space. */
  clIndicators.addEventListener('mouseover', (e) => {
    if (e.target.closest('.cl-ind-row')) {
      isHoveringIndLegend = true;
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); updateLegendValues(); }
    }
  });
  clIndicators.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest('.cl-ind-row')) {
      isHoveringIndLegend = false;
    }
  });

  /* Indicators that draw on the price scale ("overlays") show a numeric value in the legend
     that tracks the current bar (a moving average of closes over the instance's length).
     `abbr` is the short code shown; `period` is the fallback value window when an instance
     has no explicit length. Indicators not listed here render without a value (oscillators,
     order-flow tools that would live in a sub-pane). */
  const IND_LEGEND_OVERLAY = {
    'Moving Average': { abbr: 'MA', period: 60 },
    'EMA': { abbr: 'EMA', period: 20 },
    'SMA': { abbr: 'SMA', period: 50 },
    'VWAP': { abbr: 'VWAP', period: 30 },
    'Bollinger Bands': { abbr: 'BB', period: 20 },
    'Supertrend': { abbr: 'Supertrend', period: 10 },
    'Parabolic SAR': { abbr: 'PSAR', period: 6 },
    'Ichimoku Cloud': { abbr: 'Ichimoku', period: 26 },
    'Pivot Points': { abbr: 'Pivots', period: 20 },
    'Support & Resistance': { abbr: 'S/R', period: 40 },
  };
  const IND_LEGEND_PALETTE = ['--info', '--purple', '--intel', '--accent', '--long', '--short'];

  /* ---- indicator instances on the chart ----
     Each entry is an independent instance {id, name, hidden, settings}; the same indicator can
     appear multiple times, each with its own settings. Rendered top→bottom in the legend. */
  let chartIndicators = [];
  let indInstanceSeq = 0;
  const indFavorites = new Set(); // favorited indicator names (starts empty)
  function instanceById(id) { return chartIndicators.find(i => i.id === id); }

  /* IND_DATA is declared later in this scope; guard the indicator rows until the deferred init
     below runs so early callers (e.g. renderAccountSelect at startup) don't hit the temporal
     dead zone. OHLC + header still populate before then. */
  let chartLegendReady = false;

  /* Stable fallback color per indicator, keyed off its position in the master IND_DATA list.
     Only used when an instance has no explicit color in its settings. */
  function legendColorFor(name) {
    const idx = Math.max(0, IND_DATA.findIndex(d => d.name === name));
    return IND_LEGEND_PALETTE[idx % IND_LEGEND_PALETTE.length];
  }

  /* ---- per-instance settings schema (the settings design system) ----
     A small vocabulary of field types (number / select / color / toggle) rendered with the
     global cs-* settings components, so every indicator's settings share one design language.
     Indicators without a specific schema fall back to GENERIC_SCHEMA so all are editable. */
  const SRC_OPTS = [
    { value: 'close', label: 'Close' }, { value: 'open', label: 'Open' },
    { value: 'high', label: 'High' }, { value: 'low', label: 'Low' },
    { value: 'hl2', label: 'HL2' }, { value: 'hlc3', label: 'HLC3' }, { value: 'ohlc4', label: 'OHLC4' },
  ];
  const MA_METHOD_OPTS = [
    { value: 'SMA', label: 'SMA' }, { value: 'EMA', label: 'EMA' },
    { value: 'WMA', label: 'WMA' }, { value: 'RMA', label: 'RMA' },
  ];
  const numF = (key, label, def, opt = {}) => ({ type: 'number', key, label, default: def, step: opt.step ?? 1, decimals: opt.decimals ?? 0, min: opt.min ?? 0 });
  const selF = (key, label, options, def) => ({ type: 'select', key, label, options, default: def });
  const colF = (key, label, def = 'auto') => ({ type: 'color', key, label, default: def });
  const tglF = (key, label, desc, def) => ({ type: 'toggle', key, label, desc, default: def });
  const IND_SETTINGS_SCHEMA = {
    'Moving Average': { inputs: [numF('length', 'Length', 60), selF('method', 'Method', MA_METHOD_OPTS, 'SMA'), selF('source', 'Source', SRC_OPTS, 'close'), numF('offset', 'Offset', 0)], style: [colF('color', 'Line Color', 'var(--info)')] },
    'EMA': { inputs: [numF('length', 'Length', 20), selF('source', 'Source', SRC_OPTS, 'close'), numF('offset', 'Offset', 0)], style: [colF('color', 'Line Color', 'var(--purple)')] },
    'SMA': { inputs: [numF('length', 'Length', 50), selF('source', 'Source', SRC_OPTS, 'close'), numF('offset', 'Offset', 0)], style: [colF('color', 'Line Color', 'var(--intel)')] },
    'VWAP': { inputs: [selF('anchor', 'Anchor', [{ value: 'session', label: 'Session' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }], 'session'), selF('source', 'Source', SRC_OPTS, 'hlc3')], style: [colF('color', 'Line Color', 'var(--accent)')] },
    'Bollinger Bands': { inputs: [numF('length', 'Length', 20), selF('source', 'Source', SRC_OPTS, 'close'), numF('stdDev', 'StdDev', 2, { step: 0.1, decimals: 1 })], style: [colF('color', 'Basis Color', 'var(--info)'), tglF('showMiddle', 'Show Basis', 'Show the middle basis line.', true)] },
    'Supertrend': { inputs: [numF('atrLength', 'ATR Length', 10), numF('factor', 'Factor', 3, { step: 0.1, decimals: 1 })], style: [colF('color', 'Line Color', 'var(--long)')] },
    'RSI': { inputs: [numF('length', 'Length', 14), selF('source', 'Source', SRC_OPTS, 'close')], style: [colF('color', 'Line Color', 'var(--purple)')] },
    'MACD': { inputs: [numF('fast', 'Fast Length', 12), numF('slow', 'Slow Length', 26), numF('signal', 'Signal Smoothing', 9), selF('source', 'Source', SRC_OPTS, 'close')], style: [colF('color', 'Line Color', 'var(--info)')] },
  };
  const GENERIC_SCHEMA = { inputs: [numF('length', 'Length', 14), selF('source', 'Source', SRC_OPTS, 'close')], style: [colF('color', 'Color', 'auto')] };
  function getIndSchema(name) { return IND_SETTINGS_SCHEMA[name] || GENERIC_SCHEMA; }
  function defaultSettingsFor(name) {
    const schema = getIndSchema(name);
    const s = {};
    [...schema.inputs, ...schema.style].forEach(f => {
      let def = f.default;
      if (f.type === 'color' && (def == null || def === 'auto')) def = 'var(' + legendColorFor(name) + ')';
      s[f.key] = def;
    });
    return s;
  }

  /* Adds a fresh instance of `name` to the chart (always adds — never toggles off). */
  function addIndicatorInstance(name) {
    chartIndicators.push({ id: ++indInstanceSeq, name, hidden: false, settings: defaultSettingsFor(name) });
    renderLegendIndicators();
    showToast(name + ' added to chart', 'function');
  }

  function indLegendMeta(name) {
    const o = IND_LEGEND_OVERLAY[name];
    return o ? { abbr: o.abbr, overlay: true, period: o.period } : { abbr: name, overlay: false, period: 14 };
  }
  function legendColorForInst(inst) {
    return inst.settings.color || ('var(' + legendColorFor(inst.name) + ')');
  }
  function legendPeriodFor(inst) {
    const s = inst.settings;
    return s.length || s.atrLength || s.slow || indLegendMeta(inst.name).period;
  }
  /* Compact params string shown after the abbreviation (e.g. "60 close 0"). Only indicators
     with a real schema get params; generic-schema ones show just their name. */
  function legendParamsFor(inst) {
    const schema = IND_SETTINGS_SCHEMA[inst.name];
    if (!schema) return '';
    const parts = [];
    schema.inputs.forEach(f => {
      const v = inst.settings[f.key];
      if (v == null || v === '') return;
      if (f.type === 'number') parts.push(String(v));
      else if (f.key === 'source') parts.push(v);
    });
    return parts.join(' ');
  }
  /* Average close over `period` bars ending at barIndex — the value shown for overlay indicators. */
  function legendMaValue(period, barIndex) {
    const end = clamp(barIndex, 0, candleBars.length - 1);
    const start = Math.max(0, end - period + 1);
    let sum = 0, count = 0;
    for (let i = start; i <= end; i++) { sum += candleBars[i].close; count++; }
    return count ? sum / count : candleBars[end].close;
  }
  /* Which candle the crosshair sits over (mirrors drawPriceChart's slot geometry); falls
     back to the latest candle when the cursor isn't over the chart. */
  function legendBarIndex() {
    if (!crosshair) return candleBars.length - 1;
    const rect = chart.getBoundingClientRect();
    const plotW = Math.max(0, rect.width - AXIS_RIGHT_W);
    if (plotW <= 0) return candleBars.length - 1;
    const slot = plotW / (VISIBLE_BARS + FUTURE_BARS);
    const baseIndexOffset = candleBars.length - VISIBLE_BARS;
    const i = Math.round((crosshair.x - slot / 2 - panX) / slot + baseIndexOffset);
    return clamp(i, 0, candleBars.length - 1);
  }
  function legendSymbolLabel() {
    return currentSymbol();
  }
  function legendTimeframe() {
    const activeBtn = document.querySelector('#tfGroup .tf-btn.active[data-tf]');
    if (activeBtn) return activeBtn.dataset.tf;
    const moreLabel = document.getElementById('tfMoreLabel');
    if (moreLabel && moreLabel.textContent.trim()) return moreLabel.textContent.trim();
    return '15m';
  }
  /* The legend describes the candles, so the exchange it names is the one supplying them — the
     chart data venue, not the account the orders go to. */
  function legendExchange() {
    return Venues.dataLabel();
  }

  function renderLegendOhlc(bar) {
    const dir = bar.close >= bar.open ? 'up' : 'down';
    const change = bar.close - bar.open;
    const changePct = bar.open ? (change / bar.open) * 100 : 0;
    const sign = change >= 0 ? '+' : '';
    const items = [['O', bar.open], ['H', bar.high], ['L', bar.low], ['C', bar.close]]
      .map(([label, val]) =>
        `<span class="cl-ohlc-item"><span class="cl-ohlc-label">${label}</span><span class="cl-ohlc-val ${dir}">${fmt(val)}</span></span>`)
      .join('');
    clOhlc.innerHTML = items +
      `<span class="cl-ohlc-change ${dir}">${sign}${fmt(change)} (${sign}${fmt(changePct)}%)</span>`;
  }

  /* Full rebuild of the indicator rows — one row per instance. Called when the instance set,
     hide state, or settings change. Live value refreshes go through updateLegendValues(). */
  function renderLegendIndicators() {
    if (!chartLegendReady) return;
    const barIndex = legendBarIndex();
    clIndicators.innerHTML = '';
    chartIndicators.forEach(inst => {
      const meta = indLegendMeta(inst.name);
      const color = legendColorForInst(inst);
      const hidden = inst.hidden;
      const row = document.createElement('div');
      row.className = 'cl-ind-row' + (hidden ? ' hidden' : '');
      row.dataset.id = inst.id;
      row.dataset.name = inst.name;
      const paramsStr = legendParamsFor(inst);
      const params = paramsStr ? `<span class="cl-ind-params">${paramsStr}</span>` : '';
      /* Always render the value span for overlays (CSS hides it while hidden or hovered). Keeping
         it in the DOM lets the Hide toggle flip state in place without a rebuild. */
      const value = meta.overlay
        ? `<span class="cl-ind-value" style="color:${color}">${fmt(legendMaValue(legendPeriodFor(inst), barIndex))}</span>`
        : '';
      /* On hover the action buttons simply appear to the right of the params/value (which stay
         visible). The row only grows on hover — it never shrinks — so it can't pull its edge out
         from under the cursor, which is what caused the old hide/unhide flicker loop. */
      row.innerHTML =
        `<span class="cl-ind-label"><span class="cl-ind-name">${meta.abbr}</span>${params}${value}</span>` +
        `<span class="cl-ind-actions">` +
        `<button class="cl-ind-btn" data-act="hide" data-tooltip="${hidden ? 'Show' : 'Hide'}"><span class="material-symbols-outlined">${hidden ? 'visibility_off' : 'visibility'}</span></button>` +
        `<button class="cl-ind-btn" data-act="settings" data-tooltip="Settings"><span class="material-symbols-outlined">tune</span></button>` +
        `<button class="cl-ind-btn danger" data-act="remove" data-tooltip="Remove"><span class="material-symbols-outlined">delete</span></button>` +
        `</span>`;
      clIndicators.appendChild(row);
    });
  }

  /* Lightweight refresh of the OHLC line + indicator values for the current bar, without
     rebuilding the DOM (so hovering an action button isn't interrupted). */
  function updateLegendValues() {
    const barIndex = legendBarIndex();
    renderLegendOhlc(candleBars[barIndex]);
    clIndicators.querySelectorAll('.cl-ind-row').forEach(row => {
      const inst = instanceById(+row.dataset.id);
      if (!inst || inst.hidden) return;
      const valEl = row.querySelector('.cl-ind-value');
      if (indLegendMeta(inst.name).overlay && valEl) {
        valEl.textContent = fmt(legendMaValue(legendPeriodFor(inst), barIndex));
      }
    });
  }

  /* Header (symbol/timeframe/exchange) + values + indicator rows. Used on init and whenever
     the symbol, timeframe, or account changes. */
  function updateChartLegend() {
    clSymbol.textContent = legendSymbolLabel();
    clTimeframe.textContent = legendTimeframe();
    clExchange.textContent = legendExchange();
    renderLegendIndicators();
    updateLegendValues();
  }
  window.updateChartLegend = updateChartLegend;
  window.renderLegendIndicators = renderLegendIndicators;
  /* Deferred to a macrotask so IND_DATA (declared later in this scope) is ready. setTimeout is used
     rather than requestAnimationFrame so this one-time init still runs when the tab isn't painting
     (a paused rAF would leave the legend permanently un-initialized). */
  setTimeout(() => { chartLegendReady = true; updateChartLegend(); }, 0);

  /* Double-clicking a legend row (anywhere but its action buttons) opens that instance's settings. */
  clIndicators.addEventListener('dblclick', (e) => {
    if (e.target.closest('.cl-ind-btn')) return;
    const row = e.target.closest('.cl-ind-row');
    if (!row) return;
    e.stopPropagation();
    openIndicatorSettings(+row.dataset.id, row);
  });

  clIndicators.addEventListener('click', (e) => {
    const btn = e.target.closest('.cl-ind-btn');
    if (!btn) return;
    e.stopPropagation();
    const row = btn.closest('.cl-ind-row');
    const id = +row.dataset.id;
    const inst = instanceById(id);
    if (!inst) return;
    const act = btn.dataset.act;
    if (act === 'hide') {
      /* Toggle in place (no rebuild) so the action buttons keep their position while the cursor
         stays on the row — lets the user hide/unhide rapidly without chasing moving buttons. */
      inst.hidden = !inst.hidden;
      row.classList.toggle('hidden', inst.hidden);
      const icon = btn.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = inst.hidden ? 'visibility_off' : 'visibility';
      btn.setAttribute('data-tooltip', inst.hidden ? 'Show' : 'Hide');
      updateLegendValues();
    } else if (act === 'settings') {
      openIndicatorSettings(id, row);
    } else if (act === 'remove') {
      chartIndicators = chartIndicators.filter(i => i.id !== id);
      if (settingsInst && settingsInst.id === id) closeAllPopovers();
      renderLegendIndicators();
      showToast(inst.name + ' removed', 'delete');
    }
  });

  /* ---------- per-instance settings editor (TradingView-style: centered, tabbed, compact) ----------
     One shared modal (#indSettingsPopup), repopulated per open. Compact label-left rows grouped under
     plain uppercase section headers (no card chrome). Edits apply live; Cancel/✕ revert to the snapshot
     taken on open, Ok keeps them, Defaults resets to the schema defaults. */
  const indSettingsPopup = document.getElementById('indSettingsPopup');
  const indSettingsBody = document.getElementById('indSettingsBody');
  const indSettingsTitle = document.getElementById('indSettingsTitle');
  const indSettingsTabs = document.getElementById('indSettingsTabs');
  const indColorMenu = document.getElementById('indColorMenu');
  const IND_COLOR_NAMES = {
    'var(--info)': 'Blue', 'var(--purple)': 'Purple', 'var(--intel)': 'Teal', 'var(--accent)': 'Gold',
    'var(--long)': 'Green', 'var(--short)': 'Red', '#f472b6': 'Pink', '#94a3b8': 'Gray',
  };
  /* Shared option sets + generic sections appended to every indicator (standard across indicators,
     so they live here rather than bloating each schema). */
  const opts = arr => arr.map(v => Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v });
  const SMOOTH_TYPE_OPTS = opts(['None', 'SMA', 'EMA', 'WMA', 'RMA']);
  const CALC_TF_OPTS = opts([['chart', 'Chart'], ['1', '1 minute'], ['5', '5 minutes'], ['15', '15 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['D', '1 day'], ['W', '1 week']]);
  const PRECISION_OPTS = opts(['Default', '0', '1', '2', '3', '4']);
  const LINE_STYLE_OPTS = opts(['Solid', 'Dashed', 'Dotted']);
  const VIS_TIMEFRAMES = [['ticks', 'Ticks'], ['seconds', 'Seconds'], ['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months'], ['ranges', 'Ranges']];
  const sec = label => ({ type: 'section', label });

  let settingsInst = null;         // instance currently being edited
  let settingsSnapshot = null;     // deep clone of settings at open time (for Cancel/revert)
  let settingsTab = 'inputs';      // active tab: inputs | style | visibility
  let settingsColorTrigger = null; // color field awaiting a swatch pick

  /* Assemble the field list for the active tab, folding in the generic sections. */
  function settingsFieldsForTab(inst) {
    const schema = getIndSchema(inst.name);
    if (settingsTab === 'inputs') {
      return [...schema.inputs,
      sec('Smoothing'), selF('_smoothType', 'Type', SMOOTH_TYPE_OPTS, 'None'), numF('_smoothLength', 'Length', 14),
      sec('Calculation'), selF('_calcTf', 'Timeframe', CALC_TF_OPTS, 'chart'), tglF('_waitClose', 'Wait for timeframe closes', '', true)];
    }
    if (settingsTab === 'style') {
      return [...schema.style,
      sec('Line'), numF('_lineWidth', 'Line Width', 1, { min: 1 }), selF('_lineStyle', 'Line Style', LINE_STYLE_OPTS, 'Solid'), selF('_precision', 'Precision', PRECISION_OPTS, 'Default')];
    }
    return [sec('Show On'), ...VIS_TIMEFRAMES.map(([k, label]) => tglF('_vis_' + k, label, '', true))];
  }
  function settingValue(f) {
    const v = settingsInst.settings[f.key];
    return v == null ? f.default : v;
  }
  /* --- field builders: compact label-left rows, no card wrappers --- */
  function fieldRow(label, controlHtml) {
    return `<div class="ind-set-row"><label class="ind-set-label">${label}</label><div class="ind-set-control">${controlHtml}</div></div>`;
  }
  function buildSettingsNumberField(f) {
    const id = 'is_' + f.key;
    const stepper =
      `<div class="price-stepper ind-set-stepper"><input type="text" id="${id}" data-key="${f.key}" value="${settingValue(f)}" data-step="${f.step}" data-decimals="${f.decimals}" data-min="${f.min}">` +
      `<div class="price-stepper-arrows">` +
      `<button type="button" class="ps-up" data-target="${id}"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>` +
      `<button type="button" class="ps-down" data-target="${id}"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>` +
      `</div></div>`;
    return fieldRow(f.label, stepper);
  }
  function buildSettingsSelectField(f) {
    const selId = 'is_sel_' + f.key;
    const value = settingValue(f);
    const options = f.options.map(o => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${o.label}</option>`).join('');
    const control =
      `<div class="select-input pop-trigger cs-dd-trigger" data-target="${selId}"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div>` +
      `<select id="${selId}" data-key="${f.key}" style="display:none;">${options}</select>`;
    return fieldRow(f.label, control);
  }
  function buildSettingsColorField(f) {
    const value = settingValue(f);
    const name = IND_COLOR_NAMES[value] || 'Custom';
    const control =
      `<div class="select-input pop-trigger ind-color-trigger" data-key="${f.key}"><span class="cs-color-swatch" style="background:${value};"></span><span class="cs-color-name">${name}</span><span class="material-symbols-outlined">expand_more</span></div>`;
    return fieldRow(f.label, control);
  }
  /* booleans render as TradingView-style checkbox rows (full width, no label column) */
  function buildSettingsCheckRow(f) {
    const on = settingValue(f);
    return `<label class="ind-set-check-row" data-key="${f.key}"><span class="ind-set-check${on ? ' checked' : ''}"><span class="material-symbols-outlined">check</span></span><span class="ind-set-check-label">${f.label}</span></label>`;
  }
  function buildSettingsField(f) {
    if (f.type === 'section') return `<div class="ind-set-section">${f.label}</div>`;
    if (f.type === 'number') return buildSettingsNumberField(f);
    if (f.type === 'select') return buildSettingsSelectField(f);
    if (f.type === 'color') return buildSettingsColorField(f);
    if (f.type === 'toggle') return buildSettingsCheckRow(f);
    return '';
  }
  function renderSettingsBody() {
    if (!settingsInst) return;
    indSettingsBody.innerHTML = settingsFieldsForTab(settingsInst).map(buildSettingsField).join('');
    refreshAllCsDropdownLabels(indSettingsBody);
  }
  function updateSettingsTabs() {
    indSettingsTabs.querySelectorAll('.ind-settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === settingsTab));
  }
  function openIndicatorSettings(id, row) {
    const inst = instanceById(id);
    if (!inst) return;
    settingsInst = inst;
    settingsSnapshot = JSON.parse(JSON.stringify(inst.settings));
    settingsTab = 'inputs';
    indSettingsTitle.textContent = inst.name;
    updateSettingsTabs();
    renderSettingsBody();
    openIndSettingsAtChartLeft(row);
  }
  /* Opens the settings window pinned to the chart's leftmost edge, just below the legend row
     that opened it (falls back to centered if no anchor row is available). */
  function openIndSettingsAtChartLeft(row) {
    const el = indSettingsPopup;
    const chartArea = document.getElementById('chartPaneArea');
    if (!row || !chartArea) { openCentered(el); return; }
    closeAllPopoversExcept(el);
    el.classList.add('show');
    el._openTrigger = null;
    const chartRect = chartArea.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = chartRect.left + 8;
    let y = rowRect.bottom + 6;
    if (x + w > vw - 12) x = vw - w - 12;
    if (x < 8) x = 8;
    if (y + h > vh - 12) y = Math.max(8, vh - h - 12);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }
  function revertSettings() {
    if (settingsInst && settingsSnapshot) {
      settingsInst.settings = JSON.parse(JSON.stringify(settingsSnapshot));
      renderLegendIndicators();
      updateLegendValues();
    }
  }
  /* commit a numeric field's typed/stepped value back to the instance and refresh the legend */
  function commitSettingsNumber(input) {
    if (!settingsInst) return;
    const decimals = parseInt(input.dataset.decimals, 10) || 0;
    const min = parseFloat(input.dataset.min) || 0;
    let v = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
    v = Math.max(min, v);
    v = decimals > 0 ? parseFloat(v.toFixed(decimals)) : Math.round(v);
    input.value = decimals > 0 ? v.toFixed(decimals) : String(v);
    settingsInst.settings[input.dataset.key] = v;
    renderLegendIndicators();
    updateLegendValues();
  }

  indSettingsTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.ind-settings-tab');
    if (!tab) return;
    settingsTab = tab.dataset.tab;
    updateSettingsTabs();
    renderSettingsBody();
  });
  indSettingsBody.addEventListener('click', (e) => {
    const arrow = e.target.closest('.ps-up, .ps-down');
    if (arrow) {
      const input = document.getElementById(arrow.dataset.target);
      if (!input) return;
      const step = parseFloat(input.dataset.step) || 1;
      const cur = parseFloat((input.value || '0').replace(/,/g, '')) || 0;
      input.value = arrow.classList.contains('ps-up') ? cur + step : cur - step;
      commitSettingsNumber(input);
      return;
    }
    const colorTrigger = e.target.closest('.ind-color-trigger');
    if (colorTrigger) {
      e.stopPropagation();
      settingsColorTrigger = colorTrigger;
      openNear(indColorMenu, colorTrigger.getBoundingClientRect(), 'left', colorTrigger);
      return;
    }
    const checkRow = e.target.closest('.ind-set-check-row[data-key]');
    if (checkRow) {
      const chk = checkRow.querySelector('.ind-set-check');
      const on = !chk.classList.contains('checked');
      chk.classList.toggle('checked', on);
      if (settingsInst) settingsInst.settings[checkRow.dataset.key] = on;
      renderLegendIndicators();
    }
  });
  indSettingsBody.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-key]');
    if (sel) {
      if (settingsInst) settingsInst.settings[sel.dataset.key] = sel.value;
      renderLegendIndicators();
      updateLegendValues();
      return;
    }
    const input = e.target.closest('input[data-key]');
    if (input) commitSettingsNumber(input);
  });
  indColorMenu.querySelectorAll('.pop-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!settingsColorTrigger || !settingsInst) return;
      const color = item.dataset.color;
      settingsColorTrigger.querySelector('.cs-color-swatch').style.background = color;
      settingsColorTrigger.querySelector('.cs-color-name').textContent = item.querySelector('.pt-title').textContent;
      settingsInst.settings[settingsColorTrigger.dataset.key] = color;
      renderLegendIndicators();
      updateLegendValues();
      closeAllPopoversExcept(indSettingsPopup);
    });
  });
  /* ✕ and Cancel revert; Ok keeps. */
  document.getElementById('indSettingsClose').addEventListener('click', (e) => { e.stopPropagation(); revertSettings(); closeAllPopovers(); });
  document.getElementById('indSettingsCancel').addEventListener('click', (e) => { e.stopPropagation(); revertSettings(); closeAllPopovers(); });
  document.getElementById('indSettingsOk').addEventListener('click', (e) => { e.stopPropagation(); closeAllPopovers(); });
  /* Defaults is a mockup-only menu — its items just show a toast. The label always stays "Defaults". */
  const indSettingsDefaultsTrigger = document.getElementById('indSettingsDefaults');
  const indSettingsDefaultsMenu = document.getElementById('indSettingsDefaultsMenu');
  indSettingsDefaultsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openNear(indSettingsDefaultsMenu, indSettingsDefaultsTrigger.getBoundingClientRect(), 'left', indSettingsDefaultsTrigger);
  });
  /* Only dismiss the Defaults menu itself — the indicator settings popup stays open. */
  document.getElementById('indDefaultsReset').addEventListener('click', (e) => {
    e.stopPropagation();
    indSettingsDefaultsMenu.classList.remove('show');
    showToast('Settings reset to defaults', 'restart_alt');
  });
  document.getElementById('indDefaultsSave').addEventListener('click', (e) => {
    e.stopPropagation();
    indSettingsDefaultsMenu.classList.remove('show');
    showToast('Saved as default', 'bookmark_add');
  });
  /* Close the Defaults menu on any click outside it. The global outside-click handler can't do
     this: it early-returns for clicks inside the indicator settings popup (itself a .pop-menu),
     so clicking elsewhere in the settings window would otherwise leave this dropdown open. The
     trigger and menu items stopPropagation, so this only fires for genuine outside clicks. */
  document.addEventListener('click', (e) => {
    if (!indSettingsDefaultsMenu.classList.contains('show')) return;
    if (e.target.closest('#indSettingsDefaultsMenu')) return;
    indSettingsDefaultsMenu.classList.remove('show');
  });
  makeFloatPanelDraggable(indSettingsPopup);

  /* ---------- live price simulation: primary symbol (ETH) ---------- */
  (function () {
    const simRand = mulberry32(7777);
    function noise() { let s = 0; for (let i = 0; i < 3; i++) s += simRand(); return (s - 1.5); }
    // setUpDown, flashEl are shared globals from js/utils.js
    function fmtVol(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(Math.round(v)); }

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
      wlChgAbs: document.getElementById('wlChgAbs-ETHUSD'),
      wlVol: document.getElementById('wlVol-ETHUSD'),
      qopBuyPrice: document.getElementById('quickOrderBuyPrice'),
      qopSellPrice: document.getElementById('quickOrderSellPrice'),
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
      qtSetTapeDirection(tickUp);
      els.hdrBid.textContent = fmt(qtBestBid());
      els.hdrAsk.textContent = fmt(qtBestAsk());

      qtSyncLimitPanelPrices();
      qtRefreshQuoteStrip();

      // Floating Quick Order bar: buy fills at the ask, sell at the bid
      if (els.qopBuyPrice) els.qopBuyPrice.textContent = fmt(last);
      if (els.qopSellPrice) els.qopSellPrice.textContent = fmt(roundTick(last - TICK));
      els.hdrDayHigh.textContent = fmt(dayHigh);
      els.hdrDayLow.textContent = fmt(dayLow);

      els.wlLast.textContent = fmt(last);
      els.wlChg.textContent = (dayUp ? '+' : '') + fmt(dayChgPct) + '%';
      setUpDown(els.wlChg, dayUp);

      /* Change (abs) & Volume cells are injected by right-panel.js after this
         module loads, so resolve them lazily on the first tick they exist. */
      if (!els.wlChgAbs) els.wlChgAbs = document.getElementById('wlChgAbs-ETHUSD');
      if (!els.wlVol) els.wlVol = document.getElementById('wlVol-ETHUSD');
      if (els.wlChgAbs) {
        els.wlChgAbs.textContent = (dayUp ? '+' : '') + fmt(dayChg);
        setUpDown(els.wlChgAbs, dayUp);
      }
      if (els.wlVol) els.wlVol.textContent = fmtVol(vol);

      flashEl(els.hdrLast, tickUp);
      flashEl(els.wlLast, tickUp);

      const lastBar = candleBars[candleBars.length - 1];
      lastBar.close = last;
      lastBar.high = Math.max(lastBar.high, last);
      lastBar.low = Math.min(lastBar.low, last);
      scheduleDrawPriceChart();
      updateLegendValues();
      // While the user is dragging a TP/SL/Entry line, its price is being updated live but
      // is not yet committed — skip fill/trigger evaluation so dragging a line across the
      // current market price can't fire an unintended fill mid-gesture. The tick right after
      // release (isDraggingOrderLine is cleared before onDrop) evaluates the final price.
      // Evaluate fills, trailing, and breakeven for every chart order this tick. `order` is re-pointed
      // to each order in turn so the shared helpers (checkTpFills, applyTrailingStop, …) act on it;
      // confirmOrderFill takes the order explicitly because it re-points `order` itself — to the
      // position it merged into, when the fill was an add-on. Trailing/breakeven re-renders are
      // collapsed into a single render() after the loop; a fill renders on the spot instead.
      let orderNeedsRender = false;
      const focusedBefore = order;   // preserve the user's focus across the loop's re-pointing
      // Iterate a snapshot: a fill (checkTpFills/checkSlHit) can remove its order mid-loop, and
      // splicing the live array during forEach would skip the next order.
      allOrders().slice().forEach(o => {
        order = o;
        if (!isDraggingOrderLine) {
          checkTpFills(prevLast, last);
          // A take profit that closes the last of the position removes its order, and removeOrder
          // leaves `order` null when nothing is left to focus. Everything below this point reads
          // `order`, so the rest of the pass has nothing to act on.
          if (!order) return;
          if (order.filled) checkSlHit(last);
        }
        if (!order.filled && order.pendingConfirm && order.orderType === 'Market') {
          setOrderEntryPrice(last);
          if (slTrailActive()) applyTrailingStopPreview();
          else if (slAtrActive()) placeAtrStop();
          if (!isDraggingOrderLine) orderNeedsRender = true;
          else { updateEntryLinePositionLive(); updateAllTpSlLinePositionsLive(); }
        }
        if (!order.filled && !order.pendingConfirm && !isDraggingOrderLine) {
          if (order.orderType === 'Limit') {
            // Limit fills at its price or better, so it's marketable: a buy fills at/under the limit,
            // a sell at/over it. Placed on the far side it rests; placed through the market it fills at once.
            const limitHit = order.side === 'buy' ? last <= order.entry : last >= order.entry;
            if (limitHit) confirmOrderFill(o);
          } else if (order.orderType === 'Trigger Market') {
            // Market-if-touched: stays pending and fires only when the market price actually reaches
            // (touches) the trigger, approaching from whichever side price was on at placement.
            // It never fires while price is still away from the trigger, so it can't execute early.
            const triggerHit = order.fillAbove ? last >= order.entry : last <= order.entry;
            if (triggerHit) confirmOrderFill(o);
          } else if (order.orderType === 'Stop Limit') {
            // Two-stage: price must touch the TRIGGER line (same touch rule as Trigger Market) to arm
            // the order, then it fills at the entry (limit) line or better — just like a Limit order.
            if (!order.stopTriggered) {
              const trigger = order.triggerPrice != null ? order.triggerPrice : order.entry;
              const triggerHit = order.fillAbove ? last >= trigger : last <= trigger;
              if (triggerHit) order.stopTriggered = true;
            }
            if (order.stopTriggered) {
              const limitHit = order.side === 'buy' ? last <= order.entry : last >= order.entry;
              if (limitHit) confirmOrderFill(o);
            }
          } else {
            // Market / any other fallback: reach the level from its placement side.
            const hitEntry = order.fillAbove ? last >= order.entry : last <= order.entry;
            if (hitEntry) confirmOrderFill(o);
          }
        }
        applyTrailingStop(last);
        applyTrailingTp(last);
        // Skip breakeven arming mid-drag: dragging the BE trigger line updates its price live,
        // so evaluating it here would fire breakeven the instant the line sweeps across market.
        // The tick after release (isDraggingOrderLine cleared before onDrop) arms it normally.
        if (!isDraggingOrderLine) applyBreakeven(last);
        if (order.filled && !isDraggingOrderLine) orderNeedsRender = true;
      });
      simTickCounter++;
      // A working close line has no order object behind it to request a render, but it still has to
      // sit at the right height as the chart is panned, resized or first laid out.
      if (chartHasCloseLines()) orderNeedsRender = true;
      if (orderNeedsRender && !isDraggingOrderLine) render();
      // Restore the user's focus after the loop's per-order re-pointing, so an in-progress drag or an
      // open per-order menu keeps acting on the order it started on — unless that order was just closed.
      order = orders.includes(focusedBefore) ? focusedBefore : (orders.length ? orders[orders.length - 1] : null);

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

  /* Every live chart order. Once createOrder starts pushing (multi-order), `orders` is the source of
     truth; until then it falls back to the legacy singleton so the transition stays behavior-neutral. */
  function allOrders() { return orders.length ? orders : (order ? [order] : []); }
  /* Re-point the focus `order` to a specific order before an id-scoped action (panel cancels, etc.). */
  function focusOrderById(id) { const o = allOrders().find(x => x.id === id); if (o) order = o; }
  /* Close every filled chart order on a side, so a full Positions-tab close clears that side's chart
     lines. The chart nets to one filled position per direction, so this is normally a single order —
     it stays a filter so a stale duplicate could never be stranded. Returns true if any existed. */
  function closeFilledChartOrdersBySide(side) {
    const matches = allOrders().filter(o => o.filled && o.side === side);
    if (!matches.length) return false;
    matches.forEach(o => { order = o; cancelOrder(); });
    return true;
  }
  function focusOrderByTpId(tpId) { const o = allOrders().find(x => x.tps.some(t => t.id === tpId)); if (o) order = o; }
  /* DOM query root for the focused order — its own container when rendered, else the whole layer.
     The live-drag helpers query through this so they touch only the order being edited, not every
     order's chips/rows on the chart. */
  function orderScope() { return (order && order._el) ? order._el : layer; }

  /* ---------- Entry-bar dodge ----------
     Every .ol-entry-bar is pinned to the same right edge, so `top` is the only thing separating two
     orders' control bars: any two entries within a bar-height of each other draw on top of one
     another. A hedged long + short at nearby prices does this every time.

     Each bar's entry LINE stays at its true price — the line is what carries the meaning, so it must
     never lie. Only the bar is nudged into a free vertical slot, with a tether drawn back to the line
     when the two come apart. Same idea as the event-marker lane packing in renderEventLines(). */
  const OL_BAR_H = 24;               // .ol-entry-bar height
  const OL_BAR_GAP = 6;              // breathing room between two stacked bars
  const OL_BAR_PITCH = OL_BAR_H + OL_BAR_GAP;

  /* Bars whose true prices are closer than one pitch get spread apart around the centre of the group
     they form, so a cluster stays visually anchored to where its orders actually are (rather than
     drifting off in whichever direction we happened to sweep). */
  function dodgeEntryBars() {
    const bars = [...layer.querySelectorAll('.ol-entry-bar')].map(el => ({
      el,
      trueY: parseFloat(el.dataset.trueY),
      side: el.dataset.side,
    }));
    // A lone bar always sits exactly on its line — nothing to clear, so skip the slotting entirely.
    if (bars.length < 2) {
      bars.forEach(b => layoutEntryBar(b, b.trueY));
      return;
    }
    // Slots follow price order, so the labels never read out of sequence. A hedged long and short at
    // the same price tie on trueY; the long takes the upper slot.
    bars.sort((a, b) => a.trueY - b.trueY || (a.side === 'buy' ? -1 : 1));

    // Chain neighbours that are too close into one cluster, then centre each cluster on its own mean.
    const clusters = [];
    bars.forEach(bar => {
      const current = clusters[clusters.length - 1];
      const previous = current && current[current.length - 1];
      if (previous && bar.trueY - previous.trueY < OL_BAR_PITCH) current.push(bar);
      else clusters.push([bar]);
    });

    const H = rectH();
    clusters.forEach(cluster => {
      const mean = cluster.reduce((sum, b) => sum + b.trueY, 0) / cluster.length;
      const top = mean - ((cluster.length - 1) * OL_BAR_PITCH) / 2;
      cluster.forEach((bar, i) => {
        const slot = clamp(top + i * OL_BAR_PITCH, OL_BAR_H / 2, H - OL_BAR_H / 2);
        layoutEntryBar(bar, slot);
      });
    });
  }

  /* Park one bar at `slot`, and show its tether only while the bar is off its line. */
  function layoutEntryBar(bar, slot) {
    bar.el.style.top = slot + 'px';
    const tether = bar.el.parentElement.querySelector('.ol-entry-tether');
    if (!tether) return;
    const drop = Math.abs(slot - bar.trueY);
    tether.hidden = drop < 1;
    tether.style.top = Math.min(slot, bar.trueY) + 'px';
    tether.style.height = drop + 'px';
  }

  /* Remove one order from the chart (fully closed / cancelled); focus falls back to another, or none. */
  function removeOrder(o) {
    const idx = orders.indexOf(o);
    if (idx !== -1) orders.splice(idx, 1);
    if (order === o) order = orders.length ? orders[orders.length - 1] : null;
  }
  /* One capture-phase listener focuses whichever order the user is about to touch, before that order's
     own drag/click handlers run — so every interaction (and any drag that follows) acts on the right
     order even with several on the chart. Registered once; harmless clicks outside an order box no-op. */
  function focusOrderFromEvent(e) {
    const boxEl = e.target && e.target.closest && e.target.closest('.ol-order');
    if (!boxEl) return;
    const o = allOrders().find(x => x.id === boxEl.dataset.orderId);
    if (o) order = o;
  }
  layer.addEventListener('mousedown', focusOrderFromEvent, true);
  layer.addEventListener('click', focusOrderFromEvent, true);

  /* ---------- hover focus: fade the side you aren't pointing at ----------
     A long and a short draw the same kinds of lines across the same chart, so hovering either one fades
     everything on the other and the hovered position reads as a single object. This is by SIDE, not by
     order: a side is often several orders (the filled main that owns the TP/SL plus its pending add-ons),
     and an add-on is part of that position — fading the main while pointing at its own add-on would say
     otherwise. Unrelated to the `order` focus pointer, which tracks what you last clicked. */
  function orderIsDimmed(o) {
    return !!hoveredSide && !!o && o.side !== hoveredSide;
  }
  function orderSideFromNode(node) {
    const boxEl = node && node.closest && node.closest('.ol-order');
    const o = boxEl && allOrders().find(x => x.id === boxEl.dataset.orderId);
    return o ? o.side : null;
  }
  function setHoveredSide(side) {
    if (side === hoveredSide) return;
    hoveredSide = side;
    layer.querySelectorAll('.ol-order').forEach(el => {
      const o = allOrders().find(x => x.id === el.dataset.orderId);
      el.classList.toggle('dim', orderIsDimmed(o));
    });
    scheduleDrawPriceChart();   // the right-axis price tags follow the hovered side
  }
  /* Delegated on the layer rather than bound per node, since a tick re-render replaces every order's
     DOM (same reason as initOrderLineTooltips). #orderLineLayer is itself pointer-events:none, so these
     only fire from children that opt in — which makes mouseleave fire the moment the cursor leaves the
     last order element, even into empty chart space inside the layer's bounds. Between the two, every
     exit is covered: onto another order (mouseover re-points), onto a non-order child like an alert
     (mouseover finds no box and clears), or off the orders entirely (mouseleave clears). */
  layer.addEventListener('mouseover', (e) => setHoveredSide(orderSideFromNode(e.target)));
  layer.addEventListener('mouseleave', () => setHoveredSide(null));

  /* ---------- working limit close editor ----------
     Clicking a close chip's amount amends the resting order: how much of the position it closes, and
     the price it rests at. Dragging the line is the coarse version of the price field; this is the
     exact one, and it's the only way to change the amount without cancelling and re-placing. */
  const closeEditPopup = document.getElementById('closeOrderEditPopup');
  const closeEditSlider = document.getElementById('closeEditSlider');
  const closeEditPrice = document.getElementById('closeEditPrice');
  const closeEditAmountLabel = document.getElementById('closeEditAmountLabel');
  let closeEditOrderId = null;   // the order being edited, or null when the popup is closed
  let closeEditPositionQty = 0;  // the position size the percentage is measured against

  function closeEditQtyFor(pct) {
    return closeEditPositionQty * clamp(pct, 0, 100) / 100;
  }
  function refreshCloseEditAmount() {
    const pct = parseInt(closeEditSlider.value, 10) || 0;
    const unit = CHART_SYMBOL.replace(/USDT?$/, '');
    // This slider lives outside the positions panel, so the panel's delegated fill doesn't reach it.
    fillRangeSlider(closeEditSlider);
    closeEditAmountLabel.textContent = pct + '% · ' + fmt(closeEditQtyFor(pct), 2) + ' ' + unit;
    document.querySelectorAll('#closeEditQuick [data-close-edit-pct]').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.closeEditPct, 10) === pct);
    });
  }

  function openCloseOrderEditor(id, anchorRect, trigger) {
    const size = window.positionCloseOrderSize && window.positionCloseOrderSize(id);
    if (!size) return;
    closeEditOrderId = id;
    closeEditPositionQty = size.positionQty;
    // A close resting on more than the position holds still edits as 100% — the slider measures the
    // position, and the amount it can be raised to is the whole of it.
    closeEditSlider.value = Math.max(1, Math.min(100, Math.round(size.pct)));
    closeEditPrice.value = fmt(size.price, size.dec);
    decorateRangeSlider(closeEditSlider);
    refreshCloseEditAmount();
    openNear(closeEditPopup, anchorRect, 'right', trigger);
  }

  closeEditSlider.addEventListener('input', refreshCloseEditAmount);
  document.querySelectorAll('#closeEditQuick [data-close-edit-pct]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeEditSlider.value = btn.dataset.closeEditPct;
      refreshCloseEditAmount();
    });
  });
  document.getElementById('closeEditCancel').addEventListener('click', () => closeAllPopovers());
  document.getElementById('closeEditApply').addEventListener('click', () => {
    if (!closeEditOrderId) return;
    const pct = parseInt(closeEditSlider.value, 10) || 0;
    const price = parseFloat((closeEditPrice.value || '').replace(/,/g, ''));
    if (!(price > 0)) { showToast('Enter a limit price', 'error'); return; }
    const amended = window.amendPositionCloseOrder(closeEditOrderId, { pct, price });
    closeAllPopovers();
    closeEditOrderId = null;
    if (!amended) return;
    // Raising the amount can push the working closes past the position, same as placing one does.
    const coverStr = amended.coverPct > 100.5
      ? ' — working closes now cover ' + Math.round(amended.coverPct) + '% of the position'
      : '';
    showToast('Close order modified' + coverStr, 'edit');
  });

  /* Working limit closes drawn on this chart — see the close-line block in render(). */
  function chartHasCloseLines() {
    return !!window.positionCloseOrders &&
      window.positionCloseOrders().some(o => o.sym === CHART_SYMBOL);
  }

  /* ---------- main render ---------- */
  /* Chart tooltips hang below whatever they annotate, which puts them outside the pane when their
     anchor sits near its bottom edge — a readout you can't read. One delegated handler flips any
     .ol-fee-tip that wouldn't fit, so the TP/SL fee breakdowns and the venue badge's price readout
     share the placement rule instead of each growing its own. Measured on mouseover, when :hover
     has already revealed the panel and its real height can be read. */
  layer.addEventListener('mouseover', (e) => {
    const host = e.target.closest('.ol-amt, .ol-venue-tag.has-tip');
    const tip = host && host.querySelector('.ol-fee-tip');
    if (!tip) return;
    tip.classList.remove('above');
    // The panel is display:none until :hover paints it, so its height is measured directly rather
    // than read off a rect that may still be collapsed — the decision has to hold whether or not
    // the pointer has landed yet.
    const prevDisplay = tip.style.display;
    tip.style.display = 'flex';
    const tipH = tip.offsetHeight;
    tip.style.display = prevDisplay;
    const anchor = host.getBoundingClientRect();
    if (anchor.bottom + 6 + tipH > chart.getBoundingClientRect().bottom - 4) {
      tip.classList.add('above');
    }
  });

  function render() {
    // renderOrder re-points `order` to each order it draws; save the caller's focus and restore it at
    // the end so `order = X; render();` (fills, menu edits) leaves X focused, not the last-drawn order.
    const keepFocus = order;
    resyncRiskSizedAddOns();
    // Every chart level has settled by the time we redraw, so this is the one place that has to
    // re-derive the execution-side prices — no drag handler needs to remember to do it.
    allOrders().forEach(syncOrderExecPrices);
    renderOpenOrders();
    renderOrderHistory();
    renderTradeHistory();
    isHoveringBarControls = false;
    // hoveredSide deliberately survives the wipe below — the cursor hasn't moved, so renderOrder
    // re-applies the fade to the rebuilt boxes. Only drop it when the side it points at is gone
    // entirely (its last order filled and merged away, or closed): a removed node fires no mouseout,
    // so nothing else would ever clear it.
    if (hoveredSide && !allOrders().some(o => o.side === hoveredSide)) hoveredSide = null;
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
      const alertPriceEl = hit.querySelector('.ol-alert-price');
      // The alert is draggable from anywhere along its line (the full-width hit band), not just
      // its chip — same as TP/SL lines. The delete button is excluded so it stays clickable.
      function onDragAlert(cy, h) {
        hit.classList.add('dragging');
        hit.style.top = cy + 'px';
        a.price = roundTick(yToPrice(cy, h));
        alertPriceEl.textContent = fmt(a.price);
        drawPriceChart();
      }
      function onDropAlert(cy, h) {
        a.price = roundTick(yToPrice(cy, h));
        render();
      }
      makeDraggable(hit, onDragAlert, onDropAlert, '.ol-alert-del');
    });
    /* Working limit closes on the charted symbol. Every other resting price on this chart — entry,
       TP, SL, alerts — draws a line, and a close order rests at a price like any of them; what the
       trader needs to see is how far away it is. Closes on other symbols have no chart to sit on, so
       they stay in the Open Orders table. They aren't take-profits: a close below entry on a long is
       a perfectly ordinary scratch, so they get their own neutral line rather than the profit-side
       green (and stay out of the TP numbering and R maths). Anchored to the chart's own instrument
       rather than the symbol label, which is cosmetic here — chart orders stay put through a switch,
       so a close line has no business vanishing behind one. */
    (window.positionCloseOrders ? window.positionCloseOrders() : []).forEach(closeOrder => {
      if (closeOrder.sym !== CHART_SYMBOL) return;
      const y = clamp(priceToY(closeOrder.price, H0), 10, H0 - 10);

      const line = document.createElement('div');
      line.className = 'ol-line close';
      line.style.top = y + 'px';
      layer.appendChild(line);

      const row = document.createElement('div');
      row.className = 'ol-side-row';
      row.style.top = y + 'px';
      const pctLabel = Math.round(closeOrder.pct) + '%';
      // The chart only ever draws its own instrument, so the unit is that symbol's coin (ETHUSD → ETH).
      const unit = CHART_SYMBOL.replace(/USDT?$/, '');
      row.innerHTML =
        '<span class="ol-chip close">CLOSE' +
        '<span class="ol-close-amt" data-edit-close="' + closeOrder.id + '" title="Edit close order">' +
        fmt(closeOrder.qty, 2) + ' ' + unit + ' ∙ ' + pctLabel + '</span></span>' +
        '<span class="ol-gear ol-danger" data-cancel-close-line="' + closeOrder.id + '" data-tooltip="Cancel close order">' +
        '<span class="material-symbols-outlined">close</span></span>';
      layer.appendChild(row);

      // The amount opens the editor; the chip around it still drags, exactly as a TP chip does.
      appendVenueTag(layer, 'close:' + closeOrder.id, y, closeOrder.venue, closeOrder.price, closeOrder.execPrice);

      row.querySelector('[data-edit-close]').addEventListener('mousedown', e => e.stopPropagation());
      row.querySelector('[data-edit-close]').addEventListener('click', e => {
        e.stopPropagation();
        openCloseOrderEditor(closeOrder.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
      });

      row.querySelector('[data-cancel-close-line]').addEventListener('click', e => {
        e.stopPropagation();
        const cancelled = window.cancelPositionCloseOrder(closeOrder.id);
        if (cancelled) showToast(cancelled.sym + ' limit close cancelled', 'check_circle');
      });

      /* Drag to reprice, from the line or its chip — the same gesture that moves a TP or SL. The
         drag moves the DOM itself and only repaints the canvas, so the node survives the gesture;
         the drop hands the new price back to the panel, which re-renders both. */
      function onDragClose(cy, h) {
        line.style.top = cy + 'px';
        row.style.top = cy + 'px';
        moveVenueTag(layer, 'close:' + closeOrder.id, cy);
        window.movePositionCloseOrder(closeOrder.id, roundTick(yToPrice(cy, h)), false);
        drawPriceChart(); // keeps the axis tag on the line as it moves
      }
      function onDropClose(cy, h) {
        window.movePositionCloseOrder(closeOrder.id, roundTick(yToPrice(cy, h)), true);
        showToast('Close order moved', 'edit');
      }
      const closeHoverKey = 'close:' + closeOrder.id;
      makeDraggable(line, onDragClose, onDropClose, null, null, closeHoverKey);
      makeDraggable(row, onDragClose, onDropClose, '[data-cancel-close-line], [data-edit-close]', null, closeHoverKey);
    });

    // Draw every chart order (each with full drag + TP/SL parity). One drawPriceChart() after the loop.
    const renderList = allOrders();
    renderList.forEach(o => renderOrder(o));
    dodgeEntryBars(); // runs once every bar exists, since it spreads them relative to each other
    if (renderList.length || chartHasCloseLines()) drawPriceChart(); // close lines carry an axis tag too
    // Restore focus to the order the caller was working on (renderOrder left it on the last one drawn).
    order = renderList.includes(keepFocus) ? keepFocus : (renderList.length ? renderList[renderList.length - 1] : null);
  }

  /* Render a single order `o` — its entry line + control bar, TP/SL brackets, and any Stop-Limit
     trigger / breakeven overlays. `order` is re-pointed to `o` up front so every helper and drag
     closure below (which all read the module-level `order`) operates on this order. */
  function renderOrder(o) {
    order = o;
    // Per-order DOM container: every line/chip/row for this order lives inside its own box so the
    // live-update helpers can scope their queries to one order (o._el) instead of the whole layer,
    // which now holds several orders. The box uses display:contents, so it adds no box of its own and
    // the absolutely-positioned children lay out against the layer exactly as before.
    // The hover fade is re-applied here, not just when the cursor moves: this rebuilds every order's
    // DOM on each tick, which would otherwise drop the class mid-hover with no mouseout to restore it.
    const box = document.createElement('div');
    box.className = 'ol-order' + (orderIsDimmed(o) ? ' dim' : '');
    box.dataset.orderId = o.id;
    layer.appendChild(box);
    o._el = box;
    const H = rectH();

    // ---- TP lines (sorted nearest-to-entry first, so labels renumber TP1, TP2, TP3... by proximity) ----
    {
      const tpSortDir = order.side === 'buy' ? 1 : -1;
      const sortedTps = order.tps.slice().sort((a, b) => tpSortDir * (a.price - b.price));
      const lastTp = sortedTps[sortedTps.length - 1];
      // Only the single TP furthest from entry may ever trail. If TP membership or prices changed
      // since the last render and a different TP is now furthest, hand trailing off automatically.
      sortedTps.forEach(tp => {
        if (tp !== lastTp && tp.trailing) {
          tp.trailing = false;
          tp.activated = false;
          tp.exitPrice = null;
          tp.autoTrailing = false;
        }
      });
      sortedTps.forEach((tp, idx) => {
        const isLastTp = tp === lastTp;
        const dir = order.side === 'buy' ? 1 : -1;
        // Once trailing has activated, the TP line itself becomes the live trailing exit —
        // it displays and tracks tp.exitPrice instead of the original static trigger price.
        const tpTrailing = tpTrailActive(tp);
        const tpActivatedTrailing = tpTrailing && tp.activated && tp.exitPrice != null;
        const displayPrice = tpDisplayPrice(tp);

        const y = clamp(priceToY(displayPrice, H), 10, H - 10);
        const line = document.createElement('div');
        line.className = 'ol-line tp';
        line.style.top = y + 'px';
        box.appendChild(line);

        const pts = dir * (displayPrice - order.entry);
        const contracts = Math.max(1, Math.round(order.qty * tp.pct / 100));
        const { gross: tpGross, fee: tpFee, net: tpNet } = tpFeeCalc(tp, contracts, displayPrice);
        const riskPerContractTotal = order.sl ? Math.abs(order.entry - order.sl.price) * POINT_VALUE : null;
        const rMultiple = riskPerContractTotal ? (pts * POINT_VALUE / riskPerContractTotal) : null;
        const tpInvalid = !tpSlSideOk('tp', displayPrice) && !tpSideWarningSuppressed(tp);

        // When trailing is active, the Trail button is replaced by a colored badge inside the
        // chip (mirrors the SL mode flow); otherwise a neutral Trail button sits to the left.
        const modeBtnHtml = (tpTrailing || !isLastTp) ? '' :
          '<button type="button" class="ol-tp-mode-btn" data-tp-trail="' + tp.id + '" data-tooltip="Trailing Take-Profit">TRL</button>';
        const badgeHtml = !tpTrailing ? '' :
          '<span class="ol-badge tp-badge trail" data-tp-badge="' + tp.id + '">' +
          '<span class="ol-badge-label" data-tp-badge-edit="' + tp.id + '" title="Edit trailing TP">' + tpBadgeText(tp) + '</span>' +
          '<button type="button" class="ol-badge-remove" data-tp-badge-remove="' + tp.id + '" title="Disable trailing" aria-label="Disable">' +
          '<span class="material-symbols-outlined">close</span>' +
          '</button>' +
          '</span>';

        const row = document.createElement('div');
        row.className = 'ol-side-row';
        row.dataset.tpId = tp.id;
        row.style.top = y + 'px';
        const tpSign = tpNet >= 0 ? '+' : '';
        row.innerHTML =
          '<span class="ol-chip tp' + (tpInvalid ? ' invalid' : '') + '"><span class="material-symbols-outlined ol-chip-warning"' + (tpInvalid ? warnTipAttr(wrongSideTip('tp')) : '') + '>error</span>TP' + (idx + 1) + '<span class="ol-amt ' + (tpNet >= 0 ? 'up' : 'down') + '" data-edit-tp="' + tp.id + '"><span class="ol-amt-val">' + tpSign + fmtMoney(tpNet) + '</span><span class="ol-fee-tip">' + feeTooltipHtml(tpGross, tpFee, tpNet) + '</span></span>' + badgeHtml + '</span>' +
          modeBtnHtml +
          '<span class="ol-tp-meta">' +
          '<span class="ol-tp-meta-pct" data-pct-tp="' + tp.id + '">' + tp.pct + '%</span>' +
          '<span class="ol-tp-meta-r">' + (rMultiple !== null ? fmt(rMultiple, 1) + 'R' : '—R') + '</span>' +
          '</span>' +
          '<span class="ol-gear ol-danger" data-remove-tp="' + tp.id + '" data-tooltip="Remove TP"><span class="material-symbols-outlined">close</span></span>';
        box.appendChild(row);
        appendVenueTag(box, 'tp:' + tp.id, y, order.execVenue, tp.price, tp.execPrice);

        // Offset line: a second draggable line sitting at the trailing offset distance toward entry.
        // Only one TP can ever trail at a time, so the label doesn't need to name which TP it's for.
        // Only shown before activation — once activated, the TP line itself IS the trailing exit.
        let offsetLineEl = null, offsetLabelEl = null;
        if (tpTrailing && !tpActivatedTrailing) {
          const offsetPrice = roundTick(tp.price - dir * tpOffsetDist(tp));
          const oy = clamp(priceToY(offsetPrice, H), 10, H - 10);
          offsetLineEl = document.createElement('div');
          offsetLineEl.className = 'ol-line offset';
          offsetLineEl.style.top = oy + 'px';
          box.appendChild(offsetLineEl);

          offsetLabelEl = document.createElement('span');
          offsetLabelEl.className = 'ol-offset-label';
          offsetLabelEl.innerHTML = '<span class="ol-offset-label-text">TRL OFFSET · ' + tpOffsetLabel(tp) + '</span>';
          offsetLabelEl.style.top = oy + 'px';
          box.appendChild(offsetLabelEl);
          // Drag wiring is registered below (once onDragOffset/onDropOffset exist) so the
          // label repositions the offset; it's drag-only (the trail menu lives on the TP chip).
        }
        function repositionOffsetLine(h) {
          if (!offsetLineEl) return;
          const op = roundTick(tp.price - dir * tpOffsetDist(tp));
          const oy = clamp(priceToY(op, h), 10, h - 10) + 'px';
          offsetLineEl.style.top = oy;
          offsetLabelEl.style.top = oy;
          const txtEl = offsetLabelEl.querySelector('.ol-offset-label-text');
          if (txtEl) txtEl.textContent = 'TRL OFFSET · ' + tpOffsetLabel(tp);
        }

        const tpChipEl = row.querySelector('.ol-chip');
        bindHandleHover(tpChipEl, 'tp:' + tp.id);
        function onDragTp(cy, h) {
          row.style.top = cy + 'px'; line.style.top = cy + 'px';
          moveVenueTag(box, 'tp:' + tp.id, cy);
          if (tpActivatedTrailing) {
            // Activated: the TP line IS the trailing exit — drag repositions exitPrice directly.
            // A manual override is no longer "automatic," so the side-of-entry check re-applies.
            tp.exitPrice = roundTick(yToPrice(cy, h));
            tp.autoTrailing = false;
          } else {
            tp.price = roundTick(yToPrice(cy, h));
            repositionOffsetLine(h); // the offset line follows the TP, preserving the offset
          }
          updateAllTpSlValidityLive();
          updateAllTpSlReadoutsLive();
          drawPriceChart();
        }
        function onDropTp(cy, h) {
          if (tpActivatedTrailing) {
            tp.exitPrice = roundTick(yToPrice(cy, h));
            tp.autoTrailing = false;
          } else {
            tp.price = roundTick(yToPrice(cy, h));
            // Moving the activation trigger resets trailing state so it re-evaluates from scratch.
            if (tp.trailing) { tp.activated = false; tp.exitPrice = null; tp.autoTrailing = false; }
          }
          if (order) showToast('Order modified', 'edit');
          render();
        }
        makeDraggable(tpChipEl, onDragTp, onDropTp, '.ol-badge');
        makeDraggable(line, onDragTp, onDropTp, undefined, undefined, 'tp:' + tp.id);

        // Dragging the offset line (only present pre-activation) redefines the offset distance from the TP.
        if (offsetLineEl) {
          function onDragOffset(cy, h) {
            const p = roundTick(yToPrice(cy, h));
            const gapPts = Math.abs(tp.price - p);
            const cfg = ensureTpTrailOffset(tp);
            const params = tpOffsetParams(cfg.offsetUnit);
            // Clamp only — don't round to the unit's display precision, or the line would
            // snap to a coarse grid (in percent, 0.01% can span ~2 ticks). The dragged price
            // is already tick-snapped, so the line tracks the tick grid smoothly.
            let v = tpGapToOffset(gapPts, tp.price, cfg.offsetUnit);
            v = Math.max(params.min, Math.min(params.max, v));
            cfg.offsetValue = v;
            repositionOffsetLine(h);
            refreshTpBadgeOnChart(tp.id);
            syncTpTrailMenuValue(tp.id);
            drawPriceChart();
          }
          function onDropOffset(cy, h) {
            onDragOffset(cy, h);
            if (order) showToast('Order modified', 'edit');
            render();
          }
          makeDraggable(offsetLineEl, onDragOffset, onDropOffset, undefined, undefined, 'offset:' + tp.id);
          // The label is a grab target too — drag-only; the trail menu stays on the TP chip's TRL badge.
          makeDraggable(offsetLabelEl, onDragOffset, onDropOffset, undefined, undefined, 'offset:' + tp.id);
        }

        row.querySelector('[data-edit-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditExitModal(tp.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        row.querySelector('[data-pct-tp]').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditExitModal(tp.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        // The Trail button: a plain click enables trailing at the default offset; dragging it
        // instead sets the offset in one gesture, with a live offset line + label as feedback.
        const tpTrailBtn = row.querySelector('[data-tp-trail]');
        if (tpTrailBtn) {
          let dragLine = null, dragLabel = null;
          function onTrailBtnDrag(cy, h) {
            if (!dragLine) {
              dragLine = document.createElement('div');
              dragLine.className = 'ol-line offset';
              box.appendChild(dragLine);
              dragLabel = document.createElement('span');
              dragLabel.className = 'ol-offset-label';
              box.appendChild(dragLabel);
            }
            dragLine.style.top = cy + 'px';
            dragLabel.style.top = cy + 'px';
            const gapPts = Math.abs(tp.price - roundTick(yToPrice(cy, h)));
            const cfg = ensureTpTrailOffset(tp);
            const params = tpOffsetParams(cfg.offsetUnit);
            let v = tpGapToOffset(gapPts, tp.price, cfg.offsetUnit);
            v = Math.max(params.min, Math.min(params.max, v));
            dragLabel.innerHTML = '<span class="ol-offset-label-text">TRL OFFSET · ' + formatTpOffset(v, cfg.offsetUnit) + '</span>';
            drawPriceChart();
          }
          function onTrailBtnDrop(cy, h) {
            const gapPts = Math.abs(tp.price - roundTick(yToPrice(cy, h)));
            const cfg = ensureTpTrailOffset(tp);
            const params = tpOffsetParams(cfg.offsetUnit);
            // Clamp only (no display-precision rounding) so the offset line lands exactly on the
            // tick where it was dropped, matching the smooth offset-line drag.
            let v = tpGapToOffset(gapPts, tp.price, cfg.offsetUnit);
            v = Math.max(params.min, Math.min(params.max, v));
            cfg.offsetValue = v;
            tp.trailing = true;
            tp.activated = false;
            tp.exitPrice = null;
            tp.autoTrailing = false;
            if (dragLine) dragLine.remove();
            if (dragLabel) dragLabel.remove();
            render();
          }
          makeDraggable(tpTrailBtn, onTrailBtnDrag, onTrailBtnDrop, null, () => selectTpTrail(tp.id));
        }
        const tpBadgeEdit = row.querySelector('[data-tp-badge-edit]');
        if (tpBadgeEdit) tpBadgeEdit.addEventListener('click', (e) => {
          e.stopPropagation();
          openTpTrailMenu(tp.id, e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
        const tpBadgeRemove = row.querySelector('[data-tp-badge-remove]');
        if (tpBadgeRemove) tpBadgeRemove.addEventListener('click', (e) => {
          e.stopPropagation();
          selectTpTrail(tp.id); // re-toggle off → disables trailing, back to a plain TP
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
        box.appendChild(line);

        const slInvalid = !tpSlSideOk('sl', order.sl.price) && !slSideWarningSuppressed();

        // Which special mode (if any) is currently active — it shows as a badge inside the
        // chip; every other mode shows as a neutral button to the left of the chip.
        const activeMode = order.sl.enabled ? order.sl.mode : null;

        let modeBtns = '';
        SL_MODE_BUTTONS.forEach(m => {
          if (m.mode === activeMode) return;
          const locked = m.mode === 'breakeven' && order.tps.length < 1;
          modeBtns +=
            '<button type="button" class="ol-sl-mode-btn' + (locked ? ' disabled' : '') +
            '" data-mode="' + m.mode + '" data-tooltip="' + m.tip + '">' + m.label + '</button>';
        });

        let badgeHtml = '';
        if (activeMode) {
          const badge = slBadgeInfo();
          badgeHtml =
            '<span class="ol-badge sl-badge ' + badge.cls + '" id="slBadgeShell">' +
            '<span class="ol-badge-label" id="slBadgeTrigger" title="Edit stop loss">' + badge.text + '</span>' +
            '<button type="button" class="ol-badge-remove" id="slBadgeRemove" title="Disable — back to Fixed SL" aria-label="Disable">' +
            '<span class="material-symbols-outlined">close</span>' +
            '</button>' +
            '</span>';
        }

        const { gross: slGross, fee: slFee, net: slNet } = slFeeCalc();
        const slSign = slNet >= 0 ? '+' : '';

        const row = document.createElement('div');
        row.className = 'ol-side-row';
        row.style.top = y + 'px';
        row.innerHTML =
          '<span class="ol-chip sl' + (slInvalid ? ' invalid' : '') + (riskLimitExceeded() ? ' risk-exceeded' : '') + '">' +
          '<span class="material-symbols-outlined ol-chip-warning"' + (slInvalid ? warnTipAttr(wrongSideTip('sl')) : riskLimitExceeded() ? warnTipAttr(RISK_LIMIT_MSG) : '') + '>error</span>SL' +
          '<span class="ol-amt ' + (slNet >= 0 ? 'up' : 'down') + '"><span class="ol-amt-val">' + slSign + fmtMoney(slNet) + '</span><span class="ol-fee-tip">' + feeTooltipHtml(slGross, slFee, slNet) + '</span></span>' +
          badgeHtml +
          '</span>' +
          modeBtns +
          '<span class="ol-gear ol-danger" id="slDeleteTrigger" data-tooltip="Remove SL"><span class="material-symbols-outlined">close</span></span>';
        box.appendChild(row);
        appendVenueTag(box, 'sl', y, order.execVenue, order.sl.price, order.sl.execPrice);

        const slChipEl = row.querySelector('.ol-chip');
        bindHandleHover(slChipEl, 'sl');
        // Dragging the SL line: trailing redefines its distance; a manual drag detaches an ATR stop
        function syncSlOnDrag() {
          order.sl.autoTrailing = false; // a manual drag is never exempt from the side-of-entry check
          if (slTrailActive()) {
            const cfg = ensureSlConfig();
            cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(slDistanceParams(cfg.distanceUnit).dp);
          } else if (slAtrActive()) {
            order.sl.enabled = false;
          }
          refreshSlBadgeOnChart();
        }
        function onDragSl(cy, h) {
          row.style.top = cy + 'px'; line.style.top = cy + 'px';
          moveVenueTag(box, 'sl', cy);
          order.sl.price = roundTick(yToPrice(cy, h));
          syncSlOnDrag();
          syncQtyFromRisk();                 // live qty in Risk $ mode (no-op in other modes)
          updateAllTpSlValidityLive();
          updateAllTpSlReadoutsLive();
          const sizePill = orderScope().querySelector('#sizePillTrigger');
          if (sizePill) sizePill.textContent = sizePillLabel();
          drawPriceChart();
        }
        function onDropSl(cy, h) {
          order.sl.price = roundTick(yToPrice(cy, h));
          syncSlOnDrag();
          syncQtyFromRisk();
          if (order) showToast('Order modified', 'edit');
          render();
        }
        makeDraggable(slChipEl, onDragSl, onDropSl, '.ol-badge');
        makeDraggable(line, onDragSl, onDropSl, undefined, undefined, 'sl');

        const slBadgeTrigger = row.querySelector('#slBadgeTrigger');
        if (slBadgeTrigger) {
          slBadgeTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            openSlGearMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
          });
        }
        const slBadgeRemove = row.querySelector('#slBadgeRemove');
        if (slBadgeRemove) {
          slBadgeRemove.addEventListener('click', (e) => {
            e.stopPropagation();
            selectSlMode(order.sl.mode); // re-selecting the active mode turns it off → Fixed
          });
        }
        row.querySelectorAll('.ol-sl-mode-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectSlMode(btn.dataset.mode);
          });
        });
        row.querySelector('#slDeleteTrigger').addEventListener('click', (e) => {
          e.stopPropagation();
          removeSl();
        });

        // ---- Breakeven price-based ghost trigger line (draggable, shown pre-fire only) ----
        // Both '% to TP1' (a fraction of the way from entry to TP1) and 'Custom R Multiple' (N times
        // the initial risk beyond entry) show a line at the price that arms breakeven (applyBreakeven).
        const beCfg = getEffectiveBeConfig();
        const beShowLine = isPriceBasedBeTrigger(beCfg.trigger) && breakevenTriggerPrice(beCfg) !== null;
        if (slBeActiveMode() && !order.sl.beActive && beShowLine) {
          const trigY = clamp(priceToY(breakevenTriggerPrice(beCfg), H), 10, H - 10);
          const beLine = document.createElement('div');
          beLine.className = 'ol-line be-trigger';
          beLine.style.top = trigY + 'px';
          box.appendChild(beLine);

          const beLabel = document.createElement('span');
          beLabel.className = 'ol-offset-label be-trigger';
          beLabel.innerHTML = '<span class="ol-offset-label-text">BE TRIGGER · ' + breakevenTriggerLabel(beCfg) + '</span>';
          beLabel.style.top = trigY + 'px';
          box.appendChild(beLabel);

          function repositionBeLine(h) {
            const ov = ensureBeOverride();
            const yy = clamp(priceToY(breakevenTriggerPrice(ov), h), 10, h - 10) + 'px';
            beLine.style.top = yy;
            beLabel.style.top = yy;
            const txt = beLabel.querySelector('.ol-offset-label-text');
            if (txt) txt.textContent = 'BE TRIGGER · ' + breakevenTriggerLabel(ov);
          }
          function onDragBe(cy, h) {
            const ov = ensureBeOverride();
            const p = roundTick(yToPrice(cy, h));
            const dir = order.side === 'buy' ? 1 : -1;
            if (ov.trigger === 'customR') {
              // distance from entry expressed in multiples of the initial risk
              const riskPts = beRiskPoints();
              const r = riskPts ? dir * (p - order.entry) / riskPts : ov.customR;
              ov.customR = +Math.max(0.1, Math.min(20, r)).toFixed(1);
              syncBeCustomRField();
            } else {
              // fraction of the entry→TP1 distance; clamp so the trigger stays strictly between them
              const refTp = breakevenRefTp();
              const span = refTp ? refTp.price - order.entry : 0;
              const pct = span ? (p - order.entry) / span * 100 : ov.pctToTp;
              ov.pctToTp = Math.round(Math.max(1, Math.min(99, pct)));
              syncBePctField();
            }
            repositionBeLine(h);
            refreshSlBadgeOnChart();
            drawPriceChart();
          }
          function onDropBe(cy, h) { onDragBe(cy, h); if (order) showToast('Order modified', 'edit'); render(); }
          // Both the thin line and the visible label pill are draggable; a click (no drag) on the
          // label opens the SL settings, so the pill is a proper grab target and adjusts the value live.
          const openBeMenu = () => openSlGearMenu(beLabel.getBoundingClientRect(), beLabel);
          makeDraggable(beLine, onDragBe, onDropBe, undefined, undefined, 'be');
          makeDraggable(beLabel, onDragBe, onDropBe, undefined, openBeMenu, 'be');
        }
      }
    }

    // ---- Entry line + control bar (always visible in full edit mode) ----
    {
      const y = clamp(priceToY(order.entry, H), 10, H - 10);
      const canDragEntry = !order.filled && !(order.pendingConfirm && order.orderType === 'Market');
      const placeable = !order.filled && order.pendingConfirm;
      const blocked = placeable && orderPlaceBlocked();

      const line = document.createElement('div');
      // An entry line that can't be dragged still has to be hoverable, or pointing at a filled
      // position's entry line — the case most likely to be paired against an opposing one — wouldn't
      // focus it. `hoverable` buys the same grab band without the drag affordance.
      // `draft` dashes the line while the order is still awaiting placement — nothing exists on the
      // exchange yet. It goes solid once placed.
      line.className = 'ol-line entry ' + order.side
        + (canDragEntry ? ' draggable' : ' hoverable')
        + (placeable ? ' draft' : '');
      line.style.top = y + 'px';
      box.appendChild(line);
      appendVenueTag(box, 'entry', y, order.execVenue, order.entry, order.execEntry);

      function onDragEntry(cy, h) {
        // The line tracks the cursor exactly; the bar re-dodges around it, so dragging one order
        // into another pushes their bars apart live rather than stacking until release.
        bar.dataset.trueY = cy;
        line.style.top = cy + 'px';
        moveVenueTag(box, 'entry', cy);
        dodgeEntryBars();

        setOrderEntryPrice(roundTick(yToPrice(cy, h)));

        // Keep an automated SL anchored to entry while dragging for non-market orders
        if (order.orderType !== 'Market') {
          if (slTrailActive()) applyTrailingStopPreview();
          else if (slAtrActive()) placeAtrStop();
        }

        updateAllTpSlLinePositionsLive();
        updateAllTpSlValidityLive();
        updateAllTpSlReadoutsLive();
        updateBreakevenLineLive();
        drawPriceChart();
      }

      function onDropEntry(cy, h) {
        setOrderEntryPrice(roundTick(yToPrice(cy, h)));
        // Re-arm a pending Trigger Market around its new position: recompute which side of the market
        // the trigger (its entry line) now sits on so it waits for a fresh touch of the new price,
        // instead of firing just because the drag carried it across the current price. Stop Limit's
        // trigger is a separate line (re-armed in its own drop handler); its entry line is the fill,
        // so moving it must not re-arm. (Limit ignores this flag.)
        if (order && !order.filled && order.orderType !== 'Stop Limit') {
          order.fillAbove = order.entry > qtCurrentPrice();
        }
        syncQtyFromRisk();
        if (order) showToast('Order modified', 'edit');
        render();
      }

      if (canDragEntry) {
        makeDraggable(line, onDragEntry, onDropEntry, undefined, undefined, 'entry');
      }

      const bar = document.createElement('div');
      bar.className = 'ol-entry-bar';
      bar.style.top = y + 'px';
      // dodgeEntryBars() may park the bar off its line; trueY is where the line (and the price) is.
      bar.dataset.trueY = y;
      bar.dataset.side = order.side;

      // Drawn only while the dodge has pulled the bar off its line — see layoutEntryBar().
      const tether = document.createElement('div');
      tether.className = 'ol-entry-tether ' + order.side;
      tether.hidden = true;
      box.appendChild(tether);

      const side = order.side;
      const sideLabel = side === 'buy' ? 'BUY' : 'SELL';

      // An add-on merges into its direction's position on fill, so it never carries TP/SL of its own:
      // it shows neither ghost handle, and its levels are managed on the position instead.
      const addOn = isAddOn(order);
      const tpAddHandleHtml = addOn ? '' : '<span class="ol-chip ghost tp-add" id="tpAddHandle">TP</span>';
      const slAddHandleHtml = (!addOn && !order.sl)
        ? '<span class="ol-chip ghost sl-add" id="slAddHandle">SL</span>'
        : '';

      // Risk $ with no stop loss can't be sized: show the same amber warning icon used for invalid TP/SL chips
      // in the Quantity segment (with a hover tooltip) instead of a misleading number.
      const sizeSegHtml = riskNeedsStop()
        ? '<span class="ol-pill-seg ol-pill-seg--warn" id="sizePillTrigger"' + warnTipAttr(riskNoStopMsg()) + '>' +
        '<span class="material-symbols-outlined ol-pill-warning">error</span></span>'
        : '<span class="ol-pill-seg" id="sizePillTrigger" data-tooltip="Quantity">' + sizePillLabel() + '</span>';

      if (!order.filled) {
        // Resting/working order: placed and waiting for price to reach entry
        // Not yet filled, no longer awaiting placement
        const working = !placeable;

        const entryClass = 'ol-chip entry ' + side
          + (placeable ? ' placeable' : '')
          + (working ? ' working' : '')
          + (blocked ? ' disabled' : '');

        bar.innerHTML =
          '<span class="ol-gear ol-reverse" id="reverseOrderBtn" data-tooltip="Switch to ' + (side === 'buy' ? 'Sell' : 'Buy') + '">' +
          '<span class="material-symbols-outlined">swap_vert</span>' +
          '</span>' +

          '<span class="' + entryClass + '" id="entryPriceHandle"' + (riskNeedsStop() ? warnTipAttr(riskNoStopMsg()) : '') + '>' +
          sideLabel +
          '</span>' +

          '<span class="ol-pill neutral combo" id="orderConfigPill">' +
          sizeSegHtml +
          '<span class="ol-pill-divider"></span>' +
          '<span class="ol-pill-seg" id="typePillTrigger" data-tooltip="Order Type">' + order.orderType + '</span>' +
          '</span>' +

          tpAddHandleHtml +
          slAddHandleHtml +
          '<span class="ol-gear ol-danger" id="cancelOrderBtn" data-tooltip="Cancel Order">' +
          '<span class="material-symbols-outlined">close</span>' +
          '</span>';

      } else {
        const dir = order.side === 'buy' ? 1 : -1;
        const currentPrice = qtCurrentPrice();
        const pnl = dir * (currentPrice - order.entry) * POINT_VALUE * order.qty;

        const pnlHtml =
          '<span class="ol-entry-pnl ' + (pnl >= 0 ? 'up' : 'down') + '">' +
          (pnl >= 0 ? '+' : '') + fmtMoney(pnl) +
          '</span>';

        bar.innerHTML =
          '<span class="ol-gear ol-reverse" id="reverseOrderBtn" data-tooltip="Reverse Position">' +
          '<span class="material-symbols-outlined">swap_vert</span>' +
          '</span>' +

          '<span class="ol-chip entry locked ' + side + '" id="entryPriceHandle">' +
          fmt(order.qty, 2) + ' ' + qtInstrumentUnit + pnlHtml +
          '</span>' +

          '<span class="ol-pill neutral combo locked" id="orderConfigPill">' +
          '<span class="ol-pill-seg" id="sizePillTrigger" data-tooltip="Quantity">' + fmt(order.qty, 2) + '</span>' +
          '<span class="ol-pill-divider"></span>' +
          '<span class="ol-pill-seg" id="typePillTrigger" data-tooltip="Order Type">' + order.orderType + '</span>' +
          '</span>' +

          tpAddHandleHtml +
          slAddHandleHtml +
          '<span class="ol-gear accent" id="pctCloseBtn" data-tooltip="Close % of Position">' +
          '<span class="material-symbols-outlined">percent</span>' +
          '</span>' +

          '<span class="ol-gear ol-danger" id="cancelOrderBtn" data-tooltip="Close Position">' +
          '<span class="material-symbols-outlined">close</span>' +
          '</span>';
      }

      box.appendChild(bar);

      const tpAddHandle = bar.querySelector('#tpAddHandle');
      if (tpAddHandle) {
        makeAddHandleDraggable(tpAddHandle, 'tp');
        bindHandleHover(tpAddHandle, 'tp-add');
      }

      const slAddHandle = bar.querySelector('#slAddHandle');
      if (slAddHandle) {
        makeAddHandleDraggable(slAddHandle, 'sl');
        bindHandleHover(slAddHandle, 'sl-add');
      }

      const entryPriceHandle = bar.querySelector('#entryPriceHandle');
      if (entryPriceHandle) {
        bindHandleHover(entryPriceHandle, 'entry');

        if (canDragEntry) {
          makeDraggable(entryPriceHandle, onDragEntry, onDropEntry, undefined, placeOrder);
        } else if (placeable) {
          entryPriceHandle.addEventListener('click', (e) => {
            e.stopPropagation();
            placeOrder();
          });
        }
      }

      if (!order.filled) {
        bar.querySelector('#sizePillTrigger').addEventListener('click', (e) => {
          e.stopPropagation();
          openSizeMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });

        bar.querySelector('#typePillTrigger').addEventListener('click', (e) => {
          e.stopPropagation();
          openOrderTypeMenu(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
      }

      bar.querySelector('#reverseOrderBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        // Reversing lands this order on the other side, so it has to clear the same one-way guard a
        // fresh order there would — otherwise it's a back door to opposing positions. Guard first:
        // there's no point confirming a reverse that's about to be blocked.
        // Both popups hand back control on a later tick, by which point the focus pointer may have
        // moved to another order — so capture this one and re-point before acting on it.
        const revOrder = order;
        const newSide = revOrder.side === 'buy' ? 'sell' : 'buy';
        guardedPlace(newSide, () => {
          requestReverseConfirmation(revOrder.filled, () => {
            order = revOrder;
            if (revOrder.filled) {
              reverseFilledPosition();
            } else {
              flipWorkingOrderSide();
            }
          });
        }, revOrder);
      });

      const pctCloseBtn = bar.querySelector('#pctCloseBtn');
      if (pctCloseBtn) {
        pctCloseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openChartClosePopup(e.currentTarget.getBoundingClientRect(), e.currentTarget);
        });
      }

      bar.querySelector('#cancelOrderBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        cancelOrder();
      });
    }

    // ---- Stop Limit: subordinate TRIGGER line (styled like BE TRIGGER / TRL OFFSET) ----
    // The entry line above is the limit/fill (order.entry); this second line is the TRIGGER
    // (order.triggerPrice) that arms the order when price touches it. Drag the line or its label
    // to adjust; clicking the label opens a small price popup for exact entry.
    if (!order.filled && order.orderType === 'Stop Limit') {
      if (order.triggerPrice == null) order.triggerPrice = order.entry;

      // TRIGGER line + value tag at the trigger price
      const triggerY = clamp(priceToY(order.triggerPrice, H), 10, H - 10);
      const triggerLine = document.createElement('div');
      triggerLine.className = 'ol-line stop-limit-trigger ' + order.side;
      triggerLine.style.top = triggerY + 'px';
      box.appendChild(triggerLine);

      // Builds the label content: a warning glyph (only when the stop is on the already-crossed side
      // of the market) followed by the STOP price. Rebuilt on drag so the warning toggles live.
      function stopLabelInner() {
        const warn = stopLimitStopWrongSide()
          ? '<span class="material-symbols-outlined ol-offset-label-warn"' + warnTipAttr(stopWrongSideTip()) + '>error</span>'
          : '';
        return warn + '<span class="ol-offset-label-text">STOP · ' + fmt(order.triggerPrice) + '</span>';
      }

      // pop-trigger keeps the global outside-click handler from closing the popup this label opens
      const triggerLabel = document.createElement('span');
      triggerLabel.className = 'ol-offset-label stop-limit pop-trigger ' + order.side;
      triggerLabel.innerHTML = stopLabelInner();
      triggerLabel.style.top = triggerY + 'px';
      box.appendChild(triggerLabel);

      function repositionTrigger(h) {
        const yy = clamp(priceToY(order.triggerPrice, h), 10, h - 10) + 'px';
        triggerLine.style.top = yy;
        triggerLabel.style.top = yy;
        triggerLabel.innerHTML = stopLabelInner();
      }
      function onDragTrigger(cy, h) {
        order.triggerPrice = roundTick(yToPrice(cy, h));
        repositionTrigger(h);
        drawPriceChart();
      }
      // On release, re-arm the trigger around its new spot: recompute which side of the market it
      // sits on and clear the arm flag, so dragging it across the price waits for a fresh touch
      // instead of firing from the drag.
      function onDropTrigger(cy, h) {
        onDragTrigger(cy, h);
        if (order && !order.filled) {
          order.fillAbove = order.triggerPrice > qtCurrentPrice();
          order.stopTriggered = false;
        }
        if (order) showToast('Order modified', 'edit');
        render();
      }
      makeDraggable(triggerLine, onDragTrigger, onDropTrigger, undefined, undefined, 'trigger');
      makeDraggable(triggerLabel, onDragTrigger, onDropTrigger, undefined,
        () => openOlPriceEdit('trigger', triggerLabel.getBoundingClientRect(), triggerLabel), 'trigger');
    }

    // ---- Breakeven Price line (Chart settings overlay, styled like TRL OFFSET / BE TRIGGER) ----
    // A gray, non-draggable reference line at the fee-adjusted entry price; its label carries the value.
    if (chartSettings.breakevenLine.enabled) {
      const bePrice = breakevenLinePrice();
      if (bePrice !== null) {
        const beY = clamp(priceToY(bePrice, H), 10, H - 10);
        const beLine = document.createElement('div');
        beLine.className = 'ol-line breakeven-price';
        beLine.style.top = beY + 'px';
        box.appendChild(beLine);

        const beLabel = document.createElement('span');
        beLabel.className = 'ol-offset-label breakeven-price';
        beLabel.innerHTML = '<span class="ol-offset-label-text">BREAKEVEN · ' + fmt(bePrice) + '</span>';
        beLabel.style.top = beY + 'px';
        box.appendChild(beLabel);
      }
    }
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
  // The account is the execution venue — the same thing named twice would only ever drift apart,
  // so the venue layer takes its execution venue from whichever account is selected.
  function venueIdForAccount(accountId) { return String(accountId).toLowerCase(); }
  function renderAccountSelect() {
    const acct = ACCOUNTS.find(a => a.id === selectedAccountId);
    // Keep the single balance source of truth in sync with the selected account so chart % sizing,
    // Quick Trade, the quick-order overlay, and the Default Size readout all reflect the same figure.
    ACCOUNT_BALANCE = acct.balance;
    Venues.setExecVenue(venueIdForAccount(acct.id));
    document.getElementById('accountSelectName').textContent = acct.id;
    document.getElementById('accountSelectBalance').textContent = fmtMoney(acct.balance);
    if (window.updateChartLegend) window.updateChartLegend();
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
        // The active balance just changed — refresh anything that displays or sizes off it.
        qtUpdateEstimates();
        updatePdBalanceDisplay();
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

  /* One listener for every consequence of a venue change, whichever end it came from — the chart
     venue following a symbol switch, or the execution venue following an account switch. */
  document.addEventListener('venue:changed', () => {
    if (chartLegendReady) updateChartLegend();
    qtRefreshQuoteStrip();
    qtRefreshBboButtonPrices();
    render();
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

  /* ---------- Broker routing: Asset Type Defaults + Custom Rules ---------- */

  const BC_ROUTING_DEFAULTS = {
    spotCrypto: { primary: 'bitget', backup: 'blofin' },
    perpFutures: { primary: 'bitget', backup: 'blofin' },
    usStocks: { primary: 'tradestation', backup: '' },
    options: { primary: 'tradestation', backup: '' },
    futures: { primary: 'tradestation', backup: '' },
    forex: { primary: 'tradestation', backup: '' },
    commodities: { primary: 'tradestation', backup: '' },
  };

  // Direct map of routing keys → select element IDs (avoids camelCase capitalisation mismatches)
  const BC_ROUTING_IDS = {
    spotCrypto: { rp: 'bcRpSpotCrypto', rb: 'bcRbSpotCrypto' },
    perpFutures: { rp: 'bcRpPerpFutures', rb: 'bcRbPerpFutures' },
    usStocks: { rp: 'bcRpUSStocks', rb: 'bcRbUSStocks' },
    options: { rp: 'bcRpOptions', rb: 'bcRbOptions' },
    futures: { rp: 'bcRpFutures', rb: 'bcRbFutures' },
    forex: { rp: 'bcRpForex', rb: 'bcRbForex' },
    commodities: { rp: 'bcRpCommodities', rb: 'bcRbCommodities' },
  };

  // Reset an asset row back to its compiled defaults
  document.querySelectorAll('.bc-routing-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.bc-routing-row');
      const key = row.dataset.routingKey;
      const def = BC_ROUTING_DEFAULTS[key];
      const ids = BC_ROUTING_IDS[key];
      if (!def || !ids) return;
      const rpId = ids.rp;
      const rbId = ids.rb;
      const rpSelect = document.getElementById(rpId);
      const rbSelect = document.getElementById(rbId);
      if (rpSelect) {
        rpSelect.value = def.primary;
        const rpTrigger = document.querySelector('[data-target="' + rpId + '"]');
        if (rpTrigger) refreshCsDropdownTriggerLabel(rpTrigger);
      }
      if (rbSelect) {
        rbSelect.value = def.backup;
        const rbTrigger = document.querySelector('[data-target="' + rbId + '"]');
        if (rbTrigger) refreshCsDropdownTriggerLabel(rbTrigger);
      }
    });
  });

  // Custom rules state — two pre-seeded examples
  let bcCustomRules = [
    { type: 'symbol', value: 'BTCUSD', broker: 'bitget' },
    { type: 'symbol', value: 'AAPL', broker: 'tradestation' },
  ];

  const BC_RULE_ASSET_OPTIONS = [
    { value: 'spotCrypto', label: 'Spot Crypto' },
    { value: 'perpFutures', label: 'Perpetual Futures' },
    { value: 'usStocks', label: 'US Stocks' },
    { value: 'options', label: 'Options' },
    { value: 'futures', label: 'Futures' },
    { value: 'forex', label: 'Forex' },
    { value: 'commodities', label: 'Commodities' },
  ];

  function renderBcCustomRules() {
    const container = document.getElementById('bcCustomRulesContainer');
    const badge = document.getElementById('bcRuleCountBadge');
    if (!container) return;
    if (badge) badge.textContent = bcCustomRules.length;

    if (bcCustomRules.length === 0) {
      container.innerHTML = '<div class="bc-rules-empty">No custom rules — asset type defaults apply to all trades.</div>';
      return;
    }

    const brokerOpts = [
      { value: 'bitget', label: 'Bitget' },
      { value: 'tradestation', label: 'TradeStation' },
      { value: 'blofin', label: 'BloFin' },
    ];

    function brokerSelectHtml(id, selected) {
      return '<select id="' + id + '" style="display:none;" data-rule-field="broker">' +
        brokerOpts.map(o => '<option value="' + o.value + '"' + (o.value === selected ? ' selected' : '') + '>' + o.label + '</option>').join('') +
        '</select>';
    }

    let html = '<div class="bc-rules-header"><span>Condition</span><span>Match</span><span>Route To</span><span></span></div>';

    bcCustomRules.forEach((rule, i) => {
      const typeId = 'bcRuleType' + i;
      const brokerId = 'bcRuleBroker' + i;

      const typeSelectHtml = '<select id="' + typeId + '" style="display:none;" data-rule-field="type" data-rule-idx="' + i + '">' +
        '<option value="symbol"' + (rule.type === 'symbol' ? ' selected' : '') + '>Symbol is</option>' +
        '<option value="assettype"' + (rule.type === 'assettype' ? ' selected' : '') + '>Asset type is</option>' +
        '</select>';

      let valueCell;
      if (rule.type === 'assettype') {
        const assetId = 'bcRuleAsset' + i;
        const assetSelectHtml = '<select id="' + assetId + '" style="display:none;" data-rule-field="value" data-rule-idx="' + i + '">' +
          BC_RULE_ASSET_OPTIONS.map(o => '<option value="' + o.value + '"' + (o.value === rule.value ? ' selected' : '') + '>' + o.label + '</option>').join('') +
          '</select>';
        valueCell = '<div><div class="select-input pop-trigger cs-dd-trigger" data-target="' + assetId + '"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div>' + assetSelectHtml + '</div>';
      } else {
        valueCell = '<input type="text" class="bc-rule-value-input" placeholder="e.g. AAPL" value="' + escapeHtml(rule.value) + '" data-rule-idx="' + i + '">';
      }

      html += '<div class="bc-rule-row" data-idx="' + i + '">' +
        '<div>' +
        '<div class="select-input pop-trigger cs-dd-trigger" data-target="' + typeId + '"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div>' +
        typeSelectHtml +
        '</div>' +
        valueCell +
        '<div>' +
        '<div class="select-input pop-trigger cs-dd-trigger" data-target="' + brokerId + '"><span class="cs-select-label"></span><span class="material-symbols-outlined">expand_more</span></div>' +
        brokerSelectHtml(brokerId, rule.broker) +
        '</div>' +
        '<button type="button" class="cs-target-del bc-rule-del" data-idx="' + i + '"><span class="material-symbols-outlined">delete</span></button>' +
        '</div>';
    });

    container.innerHTML = html;
    refreshAllCsDropdownLabels(container);

    // Condition type change → re-render
    container.querySelectorAll('[data-rule-field="type"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.ruleIdx);
        bcCustomRules[idx].type = sel.value;
        bcCustomRules[idx].value = '';
        renderBcCustomRules();
      });
    });

    // Symbol value change
    container.querySelectorAll('.bc-rule-value-input').forEach(inp => {
      inp.addEventListener('change', () => {
        bcCustomRules[parseInt(inp.dataset.ruleIdx)].value = inp.value.trim();
      });
    });

    // Asset type value change
    container.querySelectorAll('[data-rule-field="value"]').forEach(sel => {
      sel.addEventListener('change', () => {
        bcCustomRules[parseInt(sel.dataset.ruleIdx)].value = sel.value;
      });
    });

    // Broker change
    container.querySelectorAll('[data-rule-field="broker"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const row = sel.closest('.bc-rule-row');
        if (row) bcCustomRules[parseInt(row.dataset.idx)].broker = sel.value;
      });
    });

    // Delete
    container.querySelectorAll('.bc-rule-del').forEach(btn => {
      btn.addEventListener('click', () => {
        bcCustomRules.splice(parseInt(btn.dataset.idx), 1);
        renderBcCustomRules();
      });
    });
  }

  document.getElementById('bcAddRuleBtn').addEventListener('click', () => {
    bcCustomRules.push({ type: 'symbol', value: '', broker: 'bitget' });
    renderBcCustomRules();
    const inputs = document.querySelectorAll('.bc-rule-value-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  renderBcCustomRules();

  /* ---------- trade templates selector (UI-only — no settings are actually applied) ---------- */
  const TEMPLATE_SAVE_OPTIONS = [
    { key: 'symbols', label: 'Symbols' },
    { key: 'timeframe', label: 'Timeframe' },
    { key: 'tradeDefaults', label: 'Trade defaults' },
    { key: 'exchanges', label: 'Active exchanges' },
    { key: 'drawings', label: 'Chart drawings' },
    { key: 'news', label: 'News layout settings' },
    { key: 'layout', label: 'Chart layout' }
  ];
  function defaultSavedOptions() {
    return Object.fromEntries(TEMPLATE_SAVE_OPTIONS.map(o => [o.key, true]));
  }
  let templates = [
    { id: 'tpl1', name: 'Scalping', saved: defaultSavedOptions() },
    { id: 'tpl2', name: 'Swing Trading', saved: defaultSavedOptions() }
  ];
  let selectedTemplateId = 'tpl1';
  let templateIdCounter = 3;
  let templateSettingsMode = null; // 'create' | 'edit'
  let templateSettingsTargetId = null;
  const templatesSelectTrigger = document.getElementById('templatesSelectTrigger');
  const templatesSelectMenu = document.getElementById('templatesSelectMenu');
  const templatesSelectList = document.getElementById('templatesSelectList');
  const templateSettingsMenu = document.getElementById('templateSettingsMenu');
  const templateSettingsTitle = document.getElementById('templateSettingsTitle');
  const templateSettingsName = document.getElementById('templateSettingsName');
  const templateSettingsOptions = document.getElementById('templateSettingsOptions');
  const templateSettingsSelectAll = document.getElementById('templateSettingsSelectAll');
  const templateSettingsSaveBtn = document.getElementById('templateSettingsSave');
  function renderTemplatesSelect() {
    const active = templates.find(t => t.id === selectedTemplateId) || templates[0];
    const activeName = active ? active.name : 'Templates';
    document.getElementById('templatesSelectName').textContent = activeName;
    const canDelete = templates.length > 1;
    templatesSelectList.innerHTML = templates.map(t => {
      const isSelected = t.id === selectedTemplateId;
      return '<div class="pop-item template-item' + (isSelected ? ' selected' : '') + '" data-template-id="' + t.id + '">' +
        '<span class="pop-text"><span class="pt-title">' + escapeHtml(t.name) + '</span></span>' +
        '<span class="template-item-right">' +
        '' +
        '<span class="template-item-actions">' +
        '<button type="button" class="template-action-btn" data-action="settings" data-template-id="' + t.id + '" title="Template settings"><span class="material-symbols-outlined">settings</span></button>' +
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
    templatesSelectList.querySelectorAll('[data-action="settings"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTemplateSettings('edit', btn.dataset.templateId, btn.getBoundingClientRect(), btn);
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
  function renderTemplateSettingsOptions(saved) {
    templateSettingsOptions.innerHTML = TEMPLATE_SAVE_OPTIONS.map(o =>
      '<div class="tpl-opt-row' + (saved[o.key] ? ' active' : '') + '" data-opt-key="' + o.key + '">' +
      '<span class="tpl-opt-label">' + o.label + '</span>' +
      '<button type="button" class="ui-toggle" aria-label="Toggle ' + o.label + '"><span class="ui-toggle-track"><span class="ui-toggle-thumb"></span></span></button>' +
      '</div>'
    ).join('');
    templateSettingsOptions.querySelectorAll('.tpl-opt-row').forEach(row => {
      row.querySelector('.ui-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        row.classList.toggle('active');
        refreshTemplateSelectAllLabel();
      });
    });
    refreshTemplateSelectAllLabel();
  }
  function refreshTemplateSelectAllLabel() {
    const rows = templateSettingsOptions.querySelectorAll('.tpl-opt-row');
    const allOn = rows.length > 0 && Array.from(rows).every(r => r.classList.contains('active'));
    templateSettingsSelectAll.textContent = allOn ? 'Deselect all' : 'Select all';
  }
  function openTemplateSettings(mode, targetId, anchorRect, trigger) {
    templateSettingsMode = mode;
    templateSettingsTargetId = targetId;
    if (mode === 'create') {
      templateSettingsTitle.textContent = 'New Template';
      templateSettingsName.value = '';
      renderTemplateSettingsOptions(defaultSavedOptions());
    } else {
      const t = templates.find(x => x.id === targetId);
      templateSettingsTitle.textContent = 'Template Settings';
      templateSettingsName.value = t ? t.name : '';
      renderTemplateSettingsOptions(t ? t.saved : defaultSavedOptions());
    }
    templateSettingsSaveBtn.textContent = 'Save';
    openNear(templateSettingsMenu, anchorRect, 'left', trigger);
    templateSettingsName.focus();
    templateSettingsName.select();
  }
  function closeTemplateSettings() { closeAllPopoversExcept(templatesSelectMenu); }
  function collectTemplateSavedOptions() {
    const saved = {};
    templateSettingsOptions.querySelectorAll('.tpl-opt-row').forEach(row => {
      saved[row.dataset.optKey] = row.classList.contains('active');
    });
    return saved;
  }
  function commitTemplateSettings() {
    const name = templateSettingsName.value.trim();
    if (!name) { templateSettingsName.focus(); return; }
    const saved = collectTemplateSavedOptions();
    if (templateSettingsMode === 'create') {
      const id = 'tpl' + (templateIdCounter++);
      templates.push({ id, name, saved });
      selectedTemplateId = id;
      showToast('Template "' + name + '" created', 'bookmark_added');
    } else if (templateSettingsMode === 'edit') {
      const t = templates.find(x => x.id === templateSettingsTargetId);
      if (t) { t.name = name; t.saved = saved; showToast('Template "' + name + '" updated', 'check_circle'); }
    }
    closeTemplateSettings();
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
  document.getElementById('templateSaveCurrent').addEventListener('click', (e) => {
    e.stopPropagation();
    openTemplateSettings('create', null, e.currentTarget.getBoundingClientRect(), e.currentTarget);
  });
  document.getElementById('templateApplyDefaults').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
    showToast('Defaults applied', 'restart_alt');
  });
  templateSettingsSelectAll.addEventListener('click', (e) => {
    e.stopPropagation();
    const rows = templateSettingsOptions.querySelectorAll('.tpl-opt-row');
    const allOn = Array.from(rows).every(r => r.classList.contains('active'));
    rows.forEach(r => r.classList.toggle('active', !allOn));
    refreshTemplateSelectAllLabel();
  });
  templateSettingsSaveBtn.addEventListener('click', (e) => { e.stopPropagation(); commitTemplateSettings(); });
  document.getElementById('templateSettingsCancel').addEventListener('click', (e) => { e.stopPropagation(); closeTemplateSettings(); });
  document.getElementById('templateSettingsClose').addEventListener('click', (e) => { e.stopPropagation(); closeTemplateSettings(); });
  templateSettingsName.addEventListener('click', (e) => e.stopPropagation());
  templateSettingsName.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitTemplateSettings(); }
    if (e.key === 'Escape') { e.preventDefault(); closeTemplateSettings(); }
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
  document.querySelectorAll('.md-upgrade-btn, .md-compare-btn').forEach(btn => {
    btn.addEventListener('click', () => setCsTab('plans'));
  });
  /* ---------- Settings search ----------
     Searches every setting in every pane, not just the sidebar nav labels. All panes live in the
     DOM at all times (.cs-pane is hidden by class, not by being absent), so the index is built by
     crawling the modal once — there's no separate list to keep in sync as settings are added. */
  const csSearchInput = document.getElementById('csSearchInput');
  const csSearchResults = document.getElementById('csSearchResults');
  const csSidebar = document.querySelector('.cs-sidebar');
  /* Where each kind of settings row keeps its name and its sub-text. The settings-form panes are
     built from the cs-* components; the account-flavored panes (Security, Cloud & Sync) have their
     own row components, and some reuse a cs-* base class while relocating the label — .sec-row is
     a .cs-switch-row whose title is .acct-action-title, not .cs-switch-title. First match wins, so
     those variants are listed before the base shapes they build on.
     Rows that are read-only content rather than settings — the Security activity log, broker and
     exchange lists — deliberately match nothing here and stay out of the index. */
  const CS_ROW_SHAPES = [
    { match: '.acct-action-row, .sec-row', title: '.acct-action-title', desc: '.acct-action-desc' },
    { match: '.sync-item-row', title: '.sync-item-title', desc: '.sync-item-desc' },
    { match: '.cs-switch-row', title: '.cs-switch-title', desc: '.cs-switch-desc' },
    { match: '.cs-radio-row', title: '.cs-radio-title', desc: '.cs-radio-desc' },
    /* A checkbox row's label is a bare text node beside its .chk-box, so there's nothing to select. */
    { match: '.cs-checkbox-row', title: '', desc: '' },
    { match: '.cs-field', title: ':scope > label:not(.cs-checkbox-row)', desc: '.cs-field-hint' },
  ];
  const CS_ROW_SELECTOR = CS_ROW_SHAPES.map(shape => shape.match).join(', ');
  const CS_MAX_RESULTS = 30;
  let csSearchIndex = null;
  let csSearchHits = [];
  let csSearchCursor = -1;

  /* The text a row owns directly, ignoring its controls. Checkbox rows keep their label in a bare
     text node next to the .chk-box span, so there's no element to query for. */
  function csOwnText(el) {
    return [...el.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
  }

  function csRowShape(row) {
    return CS_ROW_SHAPES.find(shape => row.matches(shape.match));
  }

  /* Falls back rather than giving up, so a row shape that turns up with its label somewhere
     unanticipated still lands in the index under some usable name instead of vanishing from it. */
  function csRowTitle(row) {
    const shape = csRowShape(row);
    const titled = shape && shape.title ? csTextOf(row, shape.title) : '';
    if (titled) return titled;
    const own = csOwnText(row);
    if (own) return own;
    /* A row with no name of its own (a .cs-field that only wraps checkbox rows, say) — name it
       after the rows inside it. */
    return [...row.querySelectorAll(CS_ROW_SELECTOR)].map(csRowTitle).filter(Boolean).join(' · ');
  }

  /* An element's text as a reader sees it. Material Symbols icons render from their ligature name,
     so their textContent ("show_chart") would otherwise end up glued to every label it sits next to. */
  function csVisibleText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.material-symbols-outlined').forEach(icon => icon.remove());
    return clone.textContent.trim().replace(/\s+/g, ' ');
  }

  function csTextOf(root, selector) {
    return root ? csVisibleText(root.querySelector(selector)) : '';
  }

  function csRowDesc(row) {
    const shape = csRowShape(row);
    return shape && shape.desc ? csTextOf(row, shape.desc) : '';
  }

  function csBuildSearchIndex() {
    const entries = [];
    document.querySelectorAll('.cs-nav-item').forEach(navItem => {
      const pane = document.querySelector('.cs-pane[data-cs-pane="' + navItem.dataset.csTab + '"]');
      if (!pane) return;
      const paneLabel = csVisibleText(navItem);
      const groupLabel = csTextOf(navItem.closest('.cs-nav-group'), '.cs-nav-label');

      /* Each level matches on its own name and description only — a pane's name is not searchable
         text for the cards inside it, nor a card's for its rows. Otherwise every level's name
         drags its whole subtree into the results: "General" would return all 16 rows of the
         General pane, each a separate result pointing at the same place. */

      /* The pane itself, so a query like "webhooks" still surfaces the section. */
      const paneHead = pane.querySelector('.cs-pane-head');
      if (paneHead) {
        entries.push(csMakeEntry(paneHead, navItem.dataset.csTab, paneLabel, groupLabel,
          [paneLabel, csTextOf(paneHead, 'p')]));
      }

      /* Cards in their own right, not only through their rows: several (Security Score, Active
         Sessions) hold read-only content and have no indexed rows for a title to ride in on. */
      pane.querySelectorAll('.cs-card').forEach(card => {
        if (card.closest('.pop-menu, .ctx-menu')) return;
        const cardTitle = csTextOf(card, '.cs-card-title');
        if (!cardTitle) return;
        entries.push(csMakeEntry(card, navItem.dataset.csTab, cardTitle, paneLabel,
          [cardTitle, csTextOf(card, ':scope > .cs-helper')]));
      });

      pane.querySelectorAll(CS_ROW_SELECTOR).forEach(row => {
        /* Index only the outermost row: a .cs-checkbox-row can sit inside a .cs-field, and both
           match the selector. The outer one carries the inner's text via csRowTitle anyway. */
        if (row.parentElement.closest(CS_ROW_SELECTOR)) return;
        /* Popover and context menus are transient overlays, not part of the pane's settings. */
        if (row.closest('.pop-menu, .ctx-menu')) return;
        const title = csRowTitle(row);
        if (!title) return;
        /* The card is only the breadcrumb here, not searchable text — see the note above. */
        const card = row.closest('.cs-card');
        const cardTitle = card ? csTextOf(card, '.cs-card-title') : '';
        const path = cardTitle ? paneLabel + ' › ' + cardTitle : paneLabel;
        /* Rows folded in by the dedup above still contribute their text. Radio rows always sit
           inside a .cs-field, so without this a query for an option's name ("Custom R") would
           match nothing. Their titles/descs only — deliberately not <select> option values. */
        const nested = [...row.querySelectorAll(CS_ROW_SELECTOR)]
          .flatMap(inner => [csRowTitle(inner), csRowDesc(inner)]);
        entries.push(csMakeEntry(row, navItem.dataset.csTab, title, path,
          [title, csRowDesc(row), ...nested]));
      });
    });
    return entries;
  }

  function csMakeEntry(el, pane, title, path, haystackParts) {
    return { el, pane, title, path, haystack: haystackParts.filter(Boolean).join(' ').toLowerCase() };
  }

  /* Conditional rows (csBeCustomRWrap and friends) are shown/hidden inline by
     csUpdateConditionalFields, so this is checked per query rather than baked into the index.
     Walking up to the pane is safe: the pane's own hiding is a class, not an inline style. */
  function csRowHidden(row) {
    for (let el = row; el && !el.classList.contains('cs-pane'); el = el.parentElement) {
      if (el.style.display === 'none') return true;
    }
    return false;
  }

  /* Every term must match somewhere, but matches in a setting's own name outrank ones that only
     hit its description or card title. */
  function csScoreEntry(entry, terms) {
    const title = entry.title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!entry.haystack.includes(term)) return -1;
      if (title.startsWith(term)) score += 3;
      else if (title.includes(term)) score += 2;
      else score += 1;
    }
    return score;
  }

  function csSearchQuery(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    if (!csSearchIndex) csSearchIndex = csBuildSearchIndex();
    return csSearchIndex
      .filter(entry => !csRowHidden(entry.el))
      .map(entry => ({ entry, score: csScoreEntry(entry, terms) }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, CS_MAX_RESULTS)
      .map(hit => hit.entry);
  }

  function csRenderSearch() {
    const query = csSearchInput.value.trim();
    csSidebar.classList.toggle('searching', !!query);
    csSearchCursor = -1;
    if (!query) {
      csSearchHits = [];
      csSearchResults.innerHTML = '';
      return;
    }
    csSearchHits = csSearchQuery(query);
    if (!csSearchHits.length) {
      csSearchResults.innerHTML = '<div class="cs-result-empty">No settings match “'
        + escapeHtml(query) + '”</div>';
      return;
    }
    csSearchResults.innerHTML = csSearchHits.map((entry, i) =>
      '<button type="button" class="cs-result" data-cs-hit="' + i + '">'
      + '<span class="cs-result-title">' + escapeHtml(entry.title) + '</span>'
      + '<span class="cs-result-path">' + escapeHtml(entry.path) + '</span>'
      + '</button>').join('');
  }

  function csClearSearch() {
    csSearchInput.value = '';
    csRenderSearch();
  }

  /* Escape clears the query before it closes the modal, so backing out of a search doesn't
     discard the settings draft. Returns whether it consumed the keypress. */
  function csSearchEscape() {
    if (!csSearchInput.value) return false;
    csClearSearch();
    return true;
  }

  function csGoToResult(entry) {
    setCsTab(entry.pane);
    csClearSearch();
    /* A pane result just means "go to this page": setCsTab already lands at the top of it, which is
       the header itself, and a heading has no card box worth lighting up. */
    if (entry.el.classList.contains('cs-pane-head')) return;
    /* The card is what gets marked and scrolled to, not the row itself — see .cs-search-hit in
       chart-settings.css. Every indexed row currently sits in one; the fallback is just belt and
       braces for a row added outside a card later. */
    const target = entry.el.closest('.cs-card') || entry.el;
    /* Deferred because setCsTab resets .cs-content scrollTop and the pane has no layout until it's
       the active one — scrolling now would measure a hidden element and then be undone. */
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' });
      target.classList.remove('cs-search-hit');
      void target.offsetWidth;
      target.classList.add('cs-search-hit');
      /* animationend won't fire under prefers-reduced-motion, so drop the class on a timer too. */
      setTimeout(() => target.classList.remove('cs-search-hit'), 2000);
    });
  }

  function csMoveSearchCursor(delta) {
    if (!csSearchHits.length) return;
    csSearchCursor = (csSearchCursor + delta + csSearchHits.length) % csSearchHits.length;
    csSearchResults.querySelectorAll('.cs-result').forEach((btn, i) => {
      btn.classList.toggle('selected', i === csSearchCursor);
      if (i === csSearchCursor) btn.scrollIntoView({ block: 'nearest' });
    });
  }

  csSearchInput.addEventListener('input', csRenderSearch);
  csSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); csMoveSearchCursor(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); csMoveSearchCursor(-1); }
    else if (e.key === 'Enter' && csSearchHits.length) {
      e.preventDefault();
      csGoToResult(csSearchHits[Math.max(csSearchCursor, 0)]);
    }
  });
  csSearchResults.addEventListener('click', (e) => {
    const btn = e.target.closest('.cs-result');
    if (btn) csGoToResult(csSearchHits[+btn.dataset.csHit]);
  });
  /* The ⌘K badge next to the input has always advertised this; now it does something. */
  document.addEventListener('keydown', (e) => {
    if (!csBackdrop.classList.contains('show')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      csSearchInput.focus();
      csSearchInput.select();
    }
  });
  document.getElementById('getPlanProBtn').addEventListener('click', () => {
    showToast('Terminal Pro activated', 'workspace_premium');
  });
  document.getElementById('getPlanEliteBtn').addEventListener('click', () => {
    showToast('Terminal Elite activated', 'workspace_premium');
  });
  function csActiveRadioUnit(groupId) {
    const activeRow = document.querySelector('#' + groupId + ' .cs-radio-row.active');
    return activeRow ? activeRow.dataset.unit : null;
  }
  function csUpdateConditionalFields() {
    const beTrigger = csActiveRadioUnit('csBeTriggerToggle');
    const tsStart = csActiveRadioUnit('csTsStartToggle');
    document.getElementById('csBeCustomRWrap').style.display = beTrigger === 'customR' ? '' : 'none';
    document.getElementById('csBePctWrap').style.display = beTrigger === 'pct' ? '' : 'none';
    document.getElementById('csTsStartCustomRWrap').style.display = tsStart === 'customR' ? '' : 'none';
    csSyncBeDynamicFee();
  }
  /* Dynamic Fee Offset (global default): only shown for the 'Fee Amount' unit. While on, it auto-fills
     the round-trip fee offset (0.12%) and locks the offset input — matching the per-trade breakeven popup. */
  function csSyncBeDynamicFee() {
    const row = document.getElementById('csBeDynamicFee');
    if (!row) return;
    const isFee = csActiveRadioUnit('csBeOffsetUnitToggle') === 'fee';
    row.style.display = isFee ? '' : 'none';
    const locked = isFee && row.classList.contains('active');
    const input = document.getElementById('csBeOffsetValue');
    if (locked) input.value = BE_ROUND_TRIP_FEE_PCT;
    input.disabled = locked;
    document.getElementById('csBeOffsetInc').disabled = locked;
    document.getElementById('csBeOffsetDec').disabled = locked;
  }
  /* percentOverride/atrOverride let a field use a finer min/step/decimals when its unit dropdown is set to "%" or "ATR" —
     ticks/points distances are sensibly whole numbers, but percent and ATR-multiple distances need sub-1 decimals (e.g. 0.5%, 2.0x) */
  function bindCsStepper(prefix, min, max, step, percentOverride, atrOverride, feeOverride) {
    const input = document.getElementById(prefix + 'Value');
    const dec = document.getElementById(prefix + 'Dec');
    const inc = document.getElementById(prefix + 'Inc');
    const unitSelect = document.getElementById(prefix + 'Unit');
    const unitToggle = document.getElementById(prefix + 'UnitToggle');
    function currentUnit() {
      if (unitSelect) return unitSelect.value;
      if (unitToggle) {
        const activeRow = unitToggle.querySelector('.cs-radio-row.active');
        return activeRow ? activeRow.dataset.unit : null;
      }
      return null;
    }
    function activeParams() {
      const unit = currentUnit();
      if (percentOverride && unit === 'percent') return percentOverride;
      if (atrOverride && unit === 'atr') return atrOverride;
      if (feeOverride && unit === 'fee') return feeOverride;
      return { min, max, step };
    }
    /* Arrow clicks snap to the step grid; manual typing only clamps to min/max and allows up to 2 decimals */
    function clampStep(v) {
      const p = activeParams();
      v = Math.round(v / p.step) * p.step;
      v = Number.isInteger(p.step) ? Math.round(v) : +v.toFixed(2);
      return Math.min(p.max, Math.max(p.min, v));
    }
    function clampManual(v) {
      const p = activeParams();
      v = Math.min(p.max, Math.max(p.min, v));
      return Number.isInteger(p.step) ? Math.round(v) : +v.toFixed(2);
    }
    input.removeAttribute('readonly');
    input.addEventListener('change', () => { input.value = clampManual(parseFloat(input.value) || 0); });
    dec.addEventListener('click', () => { input.value = clampStep(parseFloat(input.value || '0') - activeParams().step); });
    inc.addEventListener('click', () => { input.value = clampStep(parseFloat(input.value || '0') + activeParams().step); });
  }
  // The trailing TP's percent offset mirrors tpOffsetParams, which the per-TP Offset popover on the
  // chart uses, so both ends of the setting accept the same values.
  const TTP_PERCENT_OFFSET_STEP = { min: 0.01, max: 50, step: 0.01 };
  const FEE_MULTIPLIER_STEP = { min: 0.1, max: 10, step: 0.1 };
  // breakeven offset allows 0 (SL exactly at entry) and decimals for percent/fee — its own params, not the shared distance ones
  bindCsStepper('csBeOffset', 0, 200, 1, { min: 0, max: 50, step: 0.1 }, undefined, { min: 0, max: 10, step: 0.1 });
  bindCsStepper('csTtpDistance', 1, 2000, 5, TTP_PERCENT_OFFSET_STEP);
  function bindPlainStepper(valueId, min, max, step, onChange) {
    const input = document.getElementById(valueId);
    const dec = document.getElementById(valueId + 'Dec');
    const inc = document.getElementById(valueId + 'Inc');
    const isIntegerStep = Number.isInteger(step);
    /* Arrow clicks snap to the step grid; manual typing only clamps to min/max and allows up to 2 decimals — same pattern as the SL gear menu's steppers */
    function clampStep(v) { v = Math.round(v / step) * step; v = isIntegerStep ? Math.round(v) : +v.toFixed(2); return Math.min(max, Math.max(min, v)); }
    function clampManual(v) { v = Math.min(max, Math.max(min, v)); return isIntegerStep ? Math.round(v) : +v.toFixed(2); }
    function set(v) { input.value = clampStep(v); if (onChange) onChange(); }
    input.removeAttribute('readonly');
    input.addEventListener('change', () => { input.value = clampManual(parseFloat(input.value) || 0); if (onChange) onChange(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); set(parseFloat(input.value || '0') - step); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); set(parseFloat(input.value || '0') + step); });
  }
  bindPlainStepper('csAtrMultiplier', 0.01, 20, 0.1);
  document.querySelectorAll('#chartSettingsBackdrop .cs-checkbox-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      if (row.classList.contains('sync-item-row--disabled')) return;
      row.querySelector('.chk-box').classList.toggle('checked');
    });
  });

  /* ---------- Cloud & Sync: Sync Now ---------- */
  const syncNowBtn = document.getElementById('syncNowBtn');
  const syncLastSyncTime = document.getElementById('syncLastSyncTime');
  const syncLastSyncRelative = document.getElementById('syncLastSyncRelative');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', () => {
      if (syncNowBtn.classList.contains('syncing')) return;
      syncNowBtn.classList.add('syncing');
      syncNowBtn.disabled = true;
      syncNowBtn.lastChild.textContent = 'Syncing...';
      setTimeout(() => {
        syncNowBtn.classList.remove('syncing');
        syncNowBtn.disabled = false;
        syncNowBtn.lastChild.textContent = 'Sync Now';
        if (syncLastSyncRelative) syncLastSyncRelative.lastChild.textContent = 'Just now';
        if (syncLastSyncTime) {
          const now = new Date();
          const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          syncLastSyncTime.textContent = `Today, ${time}`;
        }
      }, 1200);
    });
  }

  /* ---------- General / Appearance settings panes (visual only, no persistence) ---------- */
  document.querySelectorAll('#chartSettingsBackdrop .cs-switch-row .ui-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.closest('.cs-switch-row').classList.toggle('active');
    });
  });
  /* "Confirm Orders" toggle persists separately, since it gates the Order Confirmation modal */
  const csConfirmMarketOrdersRow = document.getElementById('csConfirmMarketOrders');
  if (csConfirmMarketOrdersRow) {
    csConfirmMarketOrdersRow.classList.toggle('active', orderConfirmEnabled());
    csConfirmMarketOrdersRow.querySelector('.ui-toggle').addEventListener('click', () => {
      setOrderConfirmEnabled(csConfirmMarketOrdersRow.classList.contains('active'));
    });
  }
  /* "Confirm Flip / Reverse" toggle persists separately, since it gates the Flip/Reverse Confirmation modal */
  const csConfirmReverseRow = document.getElementById('csConfirmReverse');
  if (csConfirmReverseRow) {
    csConfirmReverseRow.classList.toggle('active', reverseConfirmEnabled());
    csConfirmReverseRow.querySelector('.ui-toggle').addEventListener('click', () => {
      setReverseConfirmEnabled(csConfirmReverseRow.classList.contains('active'));
    });
  }
  /* Position Mode persists separately (it gates the one-way block popup), so it seeds from the
     stored value and writes back on select rather than being visual-only. */
  syncHedgeModeGroup(hedgeModeEnabled());
  /* Dynamic Fee Offset row re-syncs the offset input's locked state after the generic toggle flips it */
  const csBeDynamicFeeRow = document.getElementById('csBeDynamicFee');
  if (csBeDynamicFeeRow) {
    csBeDynamicFeeRow.querySelector('.ui-toggle').addEventListener('click', () => csSyncBeDynamicFee());
  }
  document.querySelectorAll('#chartSettingsBackdrop .cs-radio-group').forEach(group => {
    group.querySelectorAll('.cs-radio-row').forEach(row => {
      row.addEventListener('click', () => {
        group.querySelectorAll('.cs-radio-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        csUpdateConditionalFields();
      });
    });
  });
  /* Moves .active to the clicked button. `onSelect` receives the clicked button for groups that
     also need to persist the choice; omit it for groups that are visual-only. */
  function bindSimpleSegmented(groupId, onSelect) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.cs-seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        group.querySelectorAll('.cs-seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        if (onSelect) onSelect(b);
      });
    });
  }
  bindSimpleSegmented('csTimeFormatGroup');
  bindSimpleSegmented('csScalePositionGroup');
  bindSimpleSegmented('qtDisplayModeGroup');
  bindSimpleSegmented('ctCrossIsolatedGroup');
  bindSimpleSegmented('ctDisplayModeGroup');
  bindSimpleSegmented('pdCrossIsolatedGroup');
  bindSimpleSegmented('csHedgeModeGroup', (btn) => setHedgeModeEnabled(btn.dataset.hedge === 'on'));

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

  /* ---------- My Account: Email / Username change buttons ---------- */
  function bindAcctSaveBtn(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.textContent = 'Saved!';
      btn.classList.add('saved');
      setTimeout(() => {
        btn.textContent = 'Change';
        btn.classList.remove('saved');
      }, 2000);
    });
  }
  bindAcctSaveBtn('acctEmailSave');
  bindAcctSaveBtn('acctUsernameSave');

  /* ---------- My Account: copy account ID ---------- */
  const acctCopyIdBtn = document.getElementById('acctCopyIdBtn');
  const acctIdValue = document.getElementById('acctIdValue');
  if (acctCopyIdBtn && acctIdValue) {
    acctCopyIdBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(acctIdValue.textContent.trim());
      const icon = acctCopyIdBtn.querySelector('.material-symbols-outlined');
      acctCopyIdBtn.classList.add('copied');
      icon.textContent = 'check';
      setTimeout(() => {
        acctCopyIdBtn.classList.remove('copied');
        icon.textContent = 'content_copy';
      }, 1500);
    });
  }

  /* ---------- My Account: jump to Plans & Pricing ---------- */
  const acctManagePlanBtn = document.getElementById('acctManagePlanBtn');
  if (acctManagePlanBtn) {
    acctManagePlanBtn.addEventListener('click', () => setCsTab('plans'));
  }

  /* ---------- Security: 2FA status pill follows its row's toggle state ---------- */
  const secTwoFactorBtn = document.getElementById('secTwoFactorBtn');
  const secTwoFactorStatus = document.getElementById('secTwoFactorStatus');
  if (secTwoFactorBtn && secTwoFactorStatus) {
    secTwoFactorBtn.addEventListener('click', () => {
      const enabled = secTwoFactorStatus.textContent === 'Enabled';
      secTwoFactorStatus.textContent = enabled ? 'Disabled' : 'Enabled';
      secTwoFactorStatus.classList.toggle('badge--good', !enabled);
      secTwoFactorStatus.classList.toggle('badge--bad', enabled);
    });
  }

  /* ---------- Security: Active Sessions overflow menu ---------- */
  const sessOverflowMenu = document.getElementById('sessOverflowMenu');
  if (sessOverflowMenu) {
    document.querySelectorAll('.sess-overflow-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNear(sessOverflowMenu, btn.getBoundingClientRect(), 'right', btn);
        sessOverflowMenu._row = btn.closest('.bc-broker-row');
      });
    });
    const sessMenuLogOut = document.getElementById('sessMenuLogOut');
    if (sessMenuLogOut) {
      sessMenuLogOut.addEventListener('click', () => {
        const row = sessOverflowMenu._row;
        if (row && row.dataset.current !== 'true') {
          row.style.opacity = '0';
          setTimeout(() => row.remove(), 200);
        }
        closeAllPopovers();
      });
    }
  }

  /* ---------- Security: log out of all other sessions ---------- */
  const sessLogOutAllBtn = document.getElementById('sessLogOutAllBtn');
  if (sessLogOutAllBtn) {
    sessLogOutAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.sess-list .bc-broker-row').forEach(row => {
        if (row.dataset.current === 'true') return;
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 200);
      });
    });
  }

  /* ---------- Alert volume slider ---------- */
  const alertVolumeSlider = document.getElementById('alertVolume');
  const alertVolumeValue = document.getElementById('alertVolumeValue');
  if (alertVolumeSlider && alertVolumeValue) {
    fillRangeSlider(alertVolumeSlider);
    alertVolumeSlider.addEventListener('input', () => {
      alertVolumeValue.textContent = alertVolumeSlider.value + '%';
      fillRangeSlider(alertVolumeSlider);
    });
  }

  /* ---------- Chart Trades: Default Size field tracks the selected sizing method ---------- */
  // csSlDraft is declared here (ahead of the targets/SL table below) because the risk-sizing note reads it.
  let csSlDraft = null;
  const PD_SIZE_MODES = {
    // Quantity is a universal unit count — these are global defaults, so the unit stays neutral ("units")
    // rather than borrowing a specific asset's term (contracts / shares / lots). On a trade it becomes
    // that many of whatever the symbol uses.
    quantity: { label: 'Default Units', unit: 'units', step: 1, default: '1' },
    dollar: { label: 'Default USD Amount', unit: '$', step: 50, default: '500' },
    pct_equity: { label: 'Default Account %', unit: '%', step: 1, default: '5' },
    risk_pct: { label: 'Default Risk %', unit: '%', step: 0.25, default: '1' },
    risk_dollar: { label: 'Default Risk $', unit: '$', step: 50, default: '250' },
  };
  // Modes whose default is expressed relative to the account balance. The balance readout and the
  // size↔balance translation apply only to these — Quantity is an absolute unit count with nothing to translate.
  const PD_BALANCE_RELATIVE_MODES = ['dollar', 'pct_equity', 'risk_pct', 'risk_dollar'];
  const pdSizingMethodGroup = document.getElementById('pdSizingMethodGroup');
  const pdDefaultSize = document.getElementById('pdDefaultSize');
  const pdDefaultSizeUnit = document.getElementById('pdDefaultSizeUnit');
  const pdDefaultSizeLabel = document.getElementById('pdDefaultSizeLabel');
  function pdActiveSizingMethod() {
    const activeRow = pdSizingMethodGroup.querySelector('.cs-radio-row.active');
    return activeRow ? activeRow.dataset.sizing : 'quantity';
  }
  /* Refresh the account-balance readout: keep it current with the active account. The Account Balance
     row shows for every mode; the conversion equation only for balance-relative modes (Quantity is an
     absolute unit count with nothing to translate, so it displays the balance alone). */
  function updatePdBalanceDisplay() {
    const panel = document.getElementById('pdSizeConvert');
    const value = document.getElementById('pdBalanceValue');
    if (!panel || !value) return;
    const eq = panel.querySelector('.cs-size-convert-eq');
    value.textContent = fmtMoney(ACCOUNT_BALANCE);
    panel.style.display = '';
    if (eq) eq.style.display = PD_BALANCE_RELATIVE_MODES.includes(pdActiveSizingMethod()) ? '' : 'none';
  }
  function pdParseSize() {
    return parseFloat((pdDefaultSize.value || '0').replace(/[$,%\s]/g, '')) || 0;
  }
  function pdPctOfBalance(amount) {
    const p = ACCOUNT_BALANCE > 0 ? amount / ACCOUNT_BALANCE * 100 : 0;
    return (p < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }
  /* Render the conversion as an equation: echo the entered value on the left, its balance-equivalent on
     the right, so it clearly reads as a conversion of the size typed above. Dollars / % of balance only
     — these are global defaults, so no per-asset quantity is shown. */
  function updatePdSizeConversion() {
    const inEl = document.getElementById('pdConvertInput');
    const outEl = document.getElementById('pdConvertOutput');
    if (!inEl || !outEl) return;
    const method = pdActiveSizingMethod();
    if (!PD_BALANCE_RELATIVE_MODES.includes(method)) return; // panel hidden for absolute modes
    const val = pdParseSize();
    let echo = '', equiv = '';
    if (method === 'dollar') {
      echo = fmtMoney(val);
      equiv = pdPctOfBalance(val) + ' of account';
    } else if (method === 'pct_equity') {
      echo = val + '% of account';
      equiv = fmtMoney(ACCOUNT_BALANCE * val / 100);
    } else if (method === 'risk_pct') {
      echo = val + '% risk';
      equiv = fmtMoney(ACCOUNT_BALANCE * val / 100);
    } else if (method === 'risk_dollar') {
      echo = fmtMoney(val) + ' risk';
      equiv = pdPctOfBalance(val) + ' of account';
    }
    inEl.textContent = echo;
    outEl.textContent = equiv;
  }
  /* Apply a sizing mode's label / unit / step to the Default Size field. valueOverride restores a persisted
     value (used when loading saved settings); without it the field resets to the mode's own default. */
  function pdApplyModeConfig(method, valueOverride) {
    const cfg = PD_SIZE_MODES[method] || PD_SIZE_MODES.quantity;
    pdDefaultSizeLabel.textContent = cfg.label;
    pdDefaultSizeUnit.textContent = cfg.unit;
    pdDefaultSize.dataset.step = cfg.step;
    pdDefaultSize.value = (valueOverride != null && valueOverride !== '') ? valueOverride : cfg.default;
    updatePdBalanceDisplay();
    updatePdSizeConversion();
  }
  // Radio click: switch to the clicked mode and reset the value to that mode's default.
  function pdApplySizeMode() {
    pdApplyModeConfig(pdActiveSizingMethod());
  }
  pdSizingMethodGroup.querySelectorAll('.cs-radio-row').forEach(row => {
    row.addEventListener('click', pdApplySizeMode);
  });
  // Keep the conversion live as the size is typed or stepped (the generic stepper mutates the value
  // without firing an input event, so also listen on its arrows — they run after the generic handler).
  pdDefaultSize.addEventListener('input', updatePdSizeConversion);
  pdDefaultSize.addEventListener('change', updatePdSizeConversion);
  document.querySelectorAll('.ps-up[data-target="pdDefaultSize"], .ps-down[data-target="pdDefaultSize"]')
    .forEach(btn => btn.addEventListener('click', updatePdSizeConversion));
  pdApplySizeMode();

  /* Resolve the quantity for a chart right-click "Buy/Sell @ price" trade from the saved Position Sizing
     default. Quantity mode uses the number verbatim; Dollar / % Account convert to a unit count with
     unitsForSizeValue (same MARGIN_PER_CONTRACT basis as the size menu, so preview and placed order agree).
     Risk modes don't resolve to a fixed number here — the pending order carries the risk-$ intent and sizes
     live from its stop loss (see createOrder / syncQtyFromRisk); this returns only a preview/fallback matching
     the default stop-loss distance when Expanded auto-attaches one, else 1. Risk preview rounds down, floor 1. */
  const PD_BASE_R_POINTS = 2; // price distance representing 1.0R — matches createOrder's baseR
  function resolveChartTradeQty() {
    const pd = chartSettings.positionDefaults;
    const method = pd.sizingMethod || 'quantity';
    const value = parseFloat(String(pd.defaultSize).replace(/[$,%\s]/g, '')) || 0;
    if (method === 'quantity') return value > 0 ? value : 1;
    if (method === 'dollar') return unitsForSizeValue('dollar', { dollar: value });
    if (method === 'pct_equity') return unitsForSizeValue('percent', { percent: value });

    const floorQty = (q) => (q > 0 && isFinite(q)) ? Math.max(1, Math.floor(q)) : 1;

    // Risk-mode preview: matches the qty the pending order will show once the default stop attaches (Expanded).
    // Condensed attaches no stop, so there's nothing to preview against → 1 (the order shows a warning instead).
    const sl = chartSettings.tpSlDisplayMode === 'expanded' ? chartSettings.defaultStopLoss : null;
    if (!sl) return 1;
    const riskPerUnit = sl.r * PD_BASE_R_POINTS * POINT_VALUE;
    const riskDollars = pdDefaultRiskDollars(pd);
    return riskPerUnit > 0 ? floorQty(riskDollars / riskPerUnit) : 1;
  }
  /* The risk budget (in $) a Risk-mode default represents: Risk $ verbatim, Risk % as a share of balance. */
  function pdDefaultRiskDollars(pd) {
    const value = parseFloat(String(pd.defaultSize).replace(/[$,%\s]/g, '')) || 0;
    return pd.sizingMethod === 'risk_pct' ? (ACCOUNT_BALANCE * value / 100) : value;
  }

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
        '<button type="button" class="cs-target-del" data-idx="' + i + '"><span class="material-symbols-outlined">close</span></button>' +
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
        '<button type="button" class="cs-target-del" id="csSlDraftDel"><span class="material-symbols-outlined">close</span></button>' +
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
    document.querySelectorAll('#csBeTriggerToggle .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === s.moveSlToBreakeven.trigger));
    document.getElementById('csBeCustomRValue').value = s.moveSlToBreakeven.customR;
    document.getElementById('csBePctValue').value = s.moveSlToBreakeven.pctToTp;
    document.getElementById('csBeOffsetValue').value = s.moveSlToBreakeven.offsetValue;
    document.querySelectorAll('#csBeOffsetUnitToggle .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === s.moveSlToBreakeven.offsetUnit));
    document.getElementById('csBeDynamicFee').classList.toggle('active', s.moveSlToBreakeven.dynamicFee !== false);

    document.getElementById('csShowBreakevenLine').classList.toggle('active', !!s.breakevenLine.enabled);

    document.getElementById('csTsEnabledByDefault').classList.toggle('active', !!s.trailingStop.enabledByDefault);
    document.querySelectorAll('#csTsDistanceUnitToggle .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === s.trailingStop.distanceUnit));
    document.querySelectorAll('#csTsStartToggle .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === s.trailingStop.start));
    document.getElementById('csTsStartCustomRValue').value = s.trailingStop.startCustomR;

    document.getElementById('csAtrMultiplier').value = s.atrStop.multiplier;

    document.getElementById('csTtpEnabledByDefault').classList.toggle('active', !!s.trailingTp.enabledByDefault);
    document.getElementById('csTtpDistanceValue').value = s.trailingTp.distanceValue;
    document.querySelectorAll('#csTtpDistanceUnitToggle .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === s.trailingTp.distanceUnit));

    document.querySelectorAll('#csCrossVenueModeGroup .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.crossvenue === s.crossVenue.mode));
    document.getElementById('csVenueWarnEnabled').classList.toggle('active', s.crossVenue.warnEnabled !== false);
    document.getElementById('csVenueWarnBps').value = s.crossVenue.warnBps;

    document.querySelectorAll('#csDisplayModeGroup .cs-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === s.tpSlDisplayMode));
    csTargetsDraft = JSON.parse(JSON.stringify(s.defaultTargets || []));
    csSlDraft = s.defaultStopLoss ? JSON.parse(JSON.stringify(s.defaultStopLoss)) : null;
    renderTargetsTable();
    csUpdateTargetTableVisibility();

    document.getElementById('csGbCancelOnClose').classList.toggle('checked', s.globalBehavior.cancelOnManualClose);
    document.getElementById('csGbRecalc').classList.toggle('checked', s.globalBehavior.recalcOnSizeChange);
    document.getElementById('csGbPersist').classList.toggle('checked', s.globalBehavior.persist);
    document.getElementById('csGbLockRR').classList.toggle('checked', s.globalBehavior.lockRR);

    document.getElementById('pdOrderType').value = s.positionDefaults.orderType;
    document.getElementById('pdQuickMarketSize').value = s.positionDefaults.quickMarketSize;

    // Restore the Default Size card: activate the saved sizing method, then apply its saved value (not the
    // mode default). csSlDraft is already set above, so the risk note reflects the correct SL state.
    const pdMethod = s.positionDefaults.sizingMethod || 'quantity';
    pdSizingMethodGroup.querySelectorAll('.cs-radio-row')
      .forEach(r => r.classList.toggle('active', r.dataset.sizing === pdMethod));
    pdApplyModeConfig(pdMethod, s.positionDefaults.defaultSize);

    const sn = s.news || CS_DEFAULTS.news;
    document.querySelectorAll('#csNewsScopeGroup .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.mode === sn.catalystScope));
    document.querySelectorAll('#csNewsPositionGroup .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.mode === sn.position));
    document.querySelectorAll('#csNewsSentimentGroup .cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.mode === sn.sentimentFilter));
    document.getElementById('csNewsTimeRange').value = sn.timeRange;
    document.getElementById('csNewsMaxEvents').value = sn.maxEvents;
    document.getElementById('csNewsImpHigh').classList.toggle('checked', sn.importance.high);
    document.getElementById('csNewsImpMedium').classList.toggle('checked', sn.importance.medium);
    document.getElementById('csNewsImpLow').classList.toggle('checked', sn.importance.low);
    document.getElementById('csNewsTypeNews').classList.toggle('checked', sn.types.news);
    document.getElementById('csNewsTypeSocial').classList.toggle('checked', sn.types.social);
    document.getElementById('csNewsTypeGeo').classList.toggle('checked', sn.types.geopolitical);
    document.getElementById('csNewsTypeCorp').classList.toggle('checked', sn.types.corporate);
    document.getElementById('csNewsShowPast').classList.toggle('active', sn.showPast);
    document.getElementById('csNewsShowUpcoming').classList.toggle('active', sn.showUpcoming);

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
        trigger: document.querySelector('#csBeTriggerToggle .cs-radio-row.active').dataset.unit,
        customR: parseFloat(document.getElementById('csBeCustomRValue').value) || 1,
        pctToTp: parseFloat(document.getElementById('csBePctValue').value) || 50,
        offsetValue: parseFloat(document.getElementById('csBeOffsetValue').value) || 0,
        offsetUnit: document.querySelector('#csBeOffsetUnitToggle .cs-radio-row.active').dataset.unit,
        dynamicFee: document.getElementById('csBeDynamicFee').classList.contains('active'),
      },
      breakevenLine: {
        enabled: document.getElementById('csShowBreakevenLine').classList.contains('active'),
      },
      trailingStop: {
        enabledByDefault: document.getElementById('csTsEnabledByDefault').classList.contains('active'),
        distanceUnit: document.querySelector('#csTsDistanceUnitToggle .cs-radio-row.active').dataset.unit,
        start: document.querySelector('#csTsStartToggle .cs-radio-row.active').dataset.unit,
        startCustomR: parseFloat(document.getElementById('csTsStartCustomRValue').value) || 1,
      },
      atrStop: {
        multiplier: parseFloat(document.getElementById('csAtrMultiplier').value) || 2,
      },
      trailingTp: {
        enabledByDefault: document.getElementById('csTtpEnabledByDefault').classList.contains('active'),
        distanceValue: parseFloat(document.getElementById('csTtpDistanceValue').value) || 1,
        distanceUnit: document.querySelector('#csTtpDistanceUnitToggle .cs-radio-row.active').dataset.unit,
      },
      crossVenue: {
        mode: document.querySelector('#csCrossVenueModeGroup .cs-radio-row.active').dataset.crossvenue,
        warnEnabled: document.getElementById('csVenueWarnEnabled').classList.contains('active'),
        warnBps: parseFloat(document.getElementById('csVenueWarnBps').value) || CS_DEFAULTS.crossVenue.warnBps,
      },
      globalBehavior: {
        cancelOnManualClose: document.getElementById('csGbCancelOnClose').classList.contains('checked'),
        recalcOnSizeChange: document.getElementById('csGbRecalc').classList.contains('checked'),
        persist: document.getElementById('csGbPersist').classList.contains('checked'),
        lockRR: document.getElementById('csGbLockRR').classList.contains('checked'),
      },
      positionDefaults: {
        orderType: document.getElementById('pdOrderType').value,
        quickMarketSize: (parseFloat(document.getElementById('pdQuickMarketSize').value) > 0
          ? document.getElementById('pdQuickMarketSize').value
          : '1'),
        sizingMethod: pdActiveSizingMethod(),
        defaultSize: (pdParseSize() > 0
          ? pdDefaultSize.value
          : (PD_SIZE_MODES[pdActiveSizingMethod()] || PD_SIZE_MODES.quantity).default),
      },
      news: {
        catalystScope: document.querySelector('#csNewsScopeGroup .cs-radio-row.active')?.dataset.mode || 'both',
        position: document.querySelector('#csNewsPositionGroup .cs-radio-row.active')?.dataset.mode || 'by-sentiment',
        sentimentFilter: document.querySelector('#csNewsSentimentGroup .cs-radio-row.active')?.dataset.mode || 'all',
        timeRange: document.getElementById('csNewsTimeRange').value,
        maxEvents: parseInt(document.getElementById('csNewsMaxEvents').value) || 20,
        showPast: document.getElementById('csNewsShowPast').classList.contains('active'),
        showUpcoming: document.getElementById('csNewsShowUpcoming').classList.contains('active'),
        importance: {
          high: document.getElementById('csNewsImpHigh').classList.contains('checked'),
          medium: document.getElementById('csNewsImpMedium').classList.contains('checked'),
          low: document.getElementById('csNewsImpLow').classList.contains('checked'),
        },
        types: {
          news: document.getElementById('csNewsTypeNews').classList.contains('checked'),
          social: document.getElementById('csNewsTypeSocial').classList.contains('checked'),
          geopolitical: document.getElementById('csNewsTypeGeo').classList.contains('checked'),
          corporate: document.getElementById('csNewsTypeCorp').classList.contains('checked'),
        },
      },
    };
    // Rebuild the order-line overlay (Breakeven Price line reads these settings), then redraw the canvas.
    render();
    scheduleDrawPriceChart();
    // Cross-Venue Pricing changes what every executable price resolves to, so the quotes and the
    // Buy/Sell button prices have to be re-read as well.
    qtRefreshQuoteStrip();
    qtRefreshBboButtonPrices();
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
    csClearSearch();
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
  /* The search box is exempt for the same reason it's exempt from the click handler above —
     typing a query isn't a settings change and shouldn't flip Save out of its saved state. */
  csBackdrop.addEventListener('input', (e) => {
    if (e.target.closest('.cs-search')) return;
    csMarkUnsaved();
  });
  document.getElementById('csResetBtn').addEventListener('click', () => {
    chartSettings = cloneCsDefaults();
    populateChartSettingsForm();
    // Position Mode lives outside chartSettings under its own key, so cloneCsDefaults() can't reach
    // it — reset it by hand, back to the one-way default.
    setHedgeModeEnabled(false);
    showToast('Reset to defaults', 'restart_alt');
  });

  /* ---------- layout picker (topbar) ---------- */
  const chartPaneArea = document.getElementById('chartPaneArea');

  const LAYOUT_CSS = {
    'Single': '',
    '2 Columns': 'layout-2col',
    '2 Rows': 'layout-2row',
    '4 Grid': 'layout-4grid',
    'Large + 2': 'layout-large2',
    '2 + Large': 'layout-2large',
    '3 Columns': 'layout-3col',
    'Top + 2': 'layout-top2',
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
      if (window.updateChartLegend) window.updateChartLegend();
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

  /* ---------- fullscreen (maximize) chart mode ---------- */
  /* Toggles an in-app maximize: the .is-chart-maximized class on .app hides the
     side and bottom panels (CSS) so the chart fills the window. Session-only —
     not persisted, so a reload always starts in the normal layout. */
  (function initChartFullscreen() {
    const btn = document.getElementById('chartFullscreenToggle');
    if (!btn) return;
    const app = document.querySelector('.app');
    const icon = btn.querySelector('.material-symbols-outlined');

    function setMaximized(maximized) {
      app.classList.toggle('is-chart-maximized', maximized);
      if (icon) icon.textContent = maximized ? 'fullscreen_exit' : 'fullscreen';
      const label = maximized ? 'Exit fullscreen chart' : 'Fullscreen chart';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      if (maximized) {
        showToast('Fullscreen chart · Press Esc to exit', 'fullscreen');
      } else {
        showToast('Exited fullscreen chart', 'fullscreen_exit');
      }
    }

    btn.addEventListener('click', () => {
      setMaximized(!app.classList.contains('is-chart-maximized'));
    });

    /* Escape exits the maximized view, mirroring the usual fullscreen gesture. */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.classList.contains('is-chart-maximized')) {
        setMaximized(false);
      }
    });
  })();

  /* ---------- toolbar icon collapse ---------- */
  /* When a bar runs low on room, its controls progressively drop their label to
     an icon-only state instead of overflowing. Every tool stays visible and one
     click away; the hidden label is surfaced via an instant tooltip. Each step
     toggles `cls` (default 'ct-collapsed'; the timeframe group uses
     'tf-condensed'). A ResizeObserver keeps each bar in sync with window and
     (resizable) side-panel width changes.

     The chart tools and the account/template selectors live in two separate,
     independently-sized bars (the center panel's chart tools bar and the full-
     width top bar), so each gets its own collapse pass. */

  /* Tooltip text for the .tb-account selectors, built from their current value. */
  function accountTooltip(el) {
    const name = el.querySelector('.tb-account-name');
    const balance = el.querySelector('.tb-account-balance');
    return [name, balance].filter(Boolean).map(n => n.textContent.trim()).filter(Boolean).join(' · ');
  }

  /* Wire one bar: `container` is the element observed for available width,
     `flexEl` is the flex child whose overflow is measured, and `stepDefs` lists
     the controls to condense in order (first = first to condense). */
  function initBarCollapse(container, flexEl, stepDefs) {
    if (!container || !flexEl) return;

    const collapseSteps = stepDefs
      .map(step => ({ el: document.getElementById(step.id), cls: step.cls || 'ct-collapsed' }))
      .filter(step => step.el);

    function isOverflowing() {
      return flexEl.scrollWidth > flexEl.clientWidth + 1;
    }

    function relayout() {
      /* Reset to full labels, then condense one step at a time until the bar fits.
         Refresh account tooltips here so they track the current account/template. */
      collapseSteps.forEach(step => {
        step.el.classList.remove(step.cls);
        if (step.el.classList.contains('tb-account')) step.el.dataset.tooltip = accountTooltip(step.el);
      });
      if (!isOverflowing()) return;
      for (const step of collapseSteps) {
        step.el.classList.add(step.cls);
        if (!isOverflowing()) break;
      }
    }

    /* Observe the container, not the flex child: its width is set by the window
       and side panels, and does NOT change when we collapse items — so relayout
       can never re-trigger the observer (no loop, no warning). Runs synchronously;
       a boolean still guards re-entrancy. Deliberately no requestAnimationFrame —
       rAF is throttled in background tabs and would strand the layout. */
    let running = false;
    const safeRelayout = () => {
      if (running) return;
      running = true;
      relayout();
      running = false;
    };
    new ResizeObserver(safeRelayout).observe(container);
    relayout();
    /* Re-measure once the Material Symbols icon font finishes loading — button
       widths change when it swaps in, and the observer won't otherwise re-fire. */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(safeRelayout);
  }

  (function initToolbarCollapse() {
    /* Chart tools bar: collapse right-to-left (Layout is rightmost), then the two
       core chart controls (Indicators, Candles), and finally — only in extreme-
       narrow cases — the timeframe group condenses to just the selected timeframe
       plus its dropdown. The whole bar is the flex child of the center panel. */
    const chartToolsBar = document.querySelector('.chart-tools-bar');
    initBarCollapse(chartToolsBar, chartToolsBar, [
      { id: 'layoutPickerTrigger' },
      { id: 'quickOrderToggle' },
      { id: 'newsToggle' },
      { id: 'marketSessionsTrigger' },
      { id: 'marketScannerTrigger' },
      { id: 'replayToggle' },
      { id: 'indicatorsTrigger' },
      { id: 'candleTypeTrigger' },
      { id: 'tfGroup', cls: 'tf-condensed' },
    ]);

    /* Top bar: the account/template selectors condense to icons only if the full-
       width bar ever runs out of room (e.g. a very narrow window). */
    const topbar = document.querySelector('.topbar');
    const tbRight = document.querySelector('.tb-right');
    initBarCollapse(topbar, tbRight, [
      { id: 'templatesSelectTrigger' },
      { id: 'accountSelectTrigger' },
    ]);
  })();

  /* ---------- chart tools bar tooltips ---------- */
  /* The chart tools bar scrolls horizontally once its controls have condensed
     and it still overflows. A scroll container clips overflow on both axes, so
     the collapsed buttons can't surface their hidden label via a CSS ::after
     tooltip (it renders below the button, outside the clip). Instead we render a
     single shared tooltip at the body level with fixed positioning, so it always
     escapes the clip. Styling mirrors the ::after tooltips (see .floating-tooltip
     in center-panel.css). */
  (function initChartToolsTooltips() {
    const bar = document.querySelector('.chart-tools-bar');
    if (!bar) return;

    const tip = document.createElement('div');
    tip.className = 'floating-tooltip';
    document.body.appendChild(tip);

    /* Only collapsed (icon-only) controls need a tooltip — an expanded control
       already shows its label. Matches the old CSS selector's intent. */
    function tooltipTarget(node) {
      const el = node.closest && node.closest('.ct-collapsed[data-tooltip]');
      return el && bar.contains(el) ? el : null;
    }

    function showTooltip(el) {
      tip.textContent = el.dataset.tooltip;
      const rect = el.getBoundingClientRect();
      tip.style.left = (rect.left + rect.width / 2) + 'px';
      tip.style.top = (rect.bottom + 8) + 'px';
      tip.classList.add('show');
    }

    function hideTooltip() {
      tip.classList.remove('show');
    }

    bar.addEventListener('mouseover', (e) => {
      const el = tooltipTarget(e.target);
      if (el) showTooltip(el);
    });
    bar.addEventListener('mouseout', (e) => {
      const el = tooltipTarget(e.target);
      /* Ignore moves that stay inside the same control (e.g. onto its icon). */
      if (el && !el.contains(e.relatedTarget)) hideTooltip();
    });
    /* A fixed tooltip would detach from its button while the bar scrolls. */
    bar.addEventListener('scroll', hideTooltip, { passive: true });
  })();

  /* Chart-trade controls (the gears and TP/SL mode buttons on the order lines)
     sit inside the overflow-hidden chart pane, so — exactly like the chart tools
     bar — they surface their label through a shared body-level .floating-tooltip
     instead of a CSS ::after that the pane would clip. The order line layer is
     re-rendered on every tick, so hover is handled by delegation on the stable
     layer element rather than per-button listeners. */
  (function initOrderLineTooltips() {
    const olLayer = document.getElementById('orderLineLayer');
    if (!olLayer) return;

    const tip = document.createElement('div');
    tip.className = 'floating-tooltip';
    document.body.appendChild(tip);

    function tooltipTarget(node) {
      const el = node.closest && node.closest('[data-tooltip]');
      return el && olLayer.contains(el) ? el : null;
    }

    function showTooltip(el) {
      tip.textContent = el.dataset.tooltip;
      tip.classList.toggle('wrap', el.hasAttribute('data-tooltip-wrap'));
      const rect = el.getBoundingClientRect();
      tip.style.left = (rect.left + rect.width / 2) + 'px';
      tip.style.top = (rect.bottom + 8) + 'px';
      tip.classList.add('show');
    }

    function hideTooltip() {
      tip.classList.remove('show');
    }

    olLayer.addEventListener('mouseover', (e) => {
      const el = tooltipTarget(e.target);
      if (el) showTooltip(el);
    });
    olLayer.addEventListener('mouseout', (e) => {
      const el = tooltipTarget(e.target);
      /* Ignore moves that stay inside the same control (e.g. onto its icon). */
      if (el && !el.contains(e.relatedTarget)) hideTooltip();
    });
    /* Safety net: a tick re-render can swap the hovered node without firing
       mouseout, so always clear when the cursor leaves the layer entirely. */
    olLayer.addEventListener('mouseleave', hideTooltip);
  })();

  /* Partially-filled orders in the Positions / Open Orders tabs surface their
     fill detail (percent, remaining, average fill) on hover of the progress bar.
     Those tabs live in scroll containers that clip overflow, so — like the chart
     tools bar — the tooltip is a single body-level element positioned with fixed
     coords. The Open Orders body re-renders on updates, so hover is delegated on
     the stable bottom panel rather than per-row listeners. */
  (function initFillProgressTooltips() {
    const panel = document.querySelector('.bottom-panel');
    if (!panel) return;

    const tip = document.createElement('div');
    tip.className = 'fill-tooltip';
    document.body.appendChild(tip);

    function tooltipTarget(node) {
      const el = node.closest && node.closest('.fill-progress[data-fill-status]');
      return el && panel.contains(el) ? el : null;
    }

    function buildTooltip(d) {
      const remaining = parseFloat(d.fillTotal) - parseFloat(d.fillFilled);
      const remainingStr = Number.isInteger(remaining) ? remaining : fmt(remaining);
      return (
        '<div class="fill-tt-title"><span>' + d.fillStatus + '</span>' +
        '<span class="fill-tt-pct">' + d.fillPct + '%</span></div>' +
        '<div class="fill-tt-row"><span class="fill-tt-k">Filled</span>' +
        '<span class="fill-tt-v">' + d.fillFilled + ' / ' + d.fillTotal + ' ' + d.fillUnit + '</span></div>' +
        '<div class="fill-tt-row"><span class="fill-tt-k">Remaining</span>' +
        '<span class="fill-tt-v">' + remainingStr + ' ' + d.fillUnit + '</span></div>' +
        '<div class="fill-tt-row"><span class="fill-tt-k">Avg fill</span>' +
        '<span class="fill-tt-v">' + d.fillAvg + '</span></div>'
      );
    }

    function showTooltip(el) {
      tip.innerHTML = buildTooltip(el.dataset);
      tip.classList.add('show');
      const rect = el.getBoundingClientRect();
      /* Prefer above the bar (these rows sit low on screen); flip below if cramped. */
      let top = rect.top - tip.offsetHeight - 8;
      if (top < 8) top = rect.bottom + 8;
      tip.style.left = (rect.left + rect.width / 2) + 'px';
      tip.style.top = top + 'px';
    }

    function hideTooltip() {
      tip.classList.remove('show');
    }

    panel.addEventListener('mouseover', (e) => {
      const el = tooltipTarget(e.target);
      if (el) showTooltip(el);
    });
    panel.addEventListener('mouseout', (e) => {
      const el = tooltipTarget(e.target);
      if (el && !el.contains(e.relatedTarget)) hideTooltip();
    });
    /* A fixed tooltip would detach from its bar while the tab scrolls, so hide it
       on any scroll inside the panel (capture catches the inner scroll wraps). */
    panel.addEventListener('scroll', hideTooltip, { capture: true, passive: true });
  })();

  /* ---------- symbol selector dropdown ---------- */
  const SYMBOL_LIST = [
    ...['ETHUSD', 'BTCUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD', 'DOGEUSD', 'ADAUSD', 'AVAXUSD', 'LINKUSD', 'MATICUSD',
      'LTCUSD', 'DOTUSD', 'TRXUSD', 'ATOMUSD', 'NEARUSD', 'UNIUSD', 'FILUSD', 'APTUSD', 'ARBUSD', 'OPUSD',
      'SUIUSD', 'ICPUSD', 'ETCUSD', 'TONUSD', 'INJUSD', 'SEIUSD', 'TIAUSD', 'RNDRUSD',
      'STXUSD', 'IMXUSD', 'GRTUSD', 'AAVEUSD', 'MKRUSD', 'PEPEUSD'].map(sym => ({ sym, cat: 'crypto' })),
    ...['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'JPM',
      'BAC', 'DIS', 'KO', 'PEP', 'WMT', 'V', 'MA', 'XOM', 'CVX', 'INTC',
      'ORCL', 'CRM', 'ADBE', 'PLTR', 'COIN', 'MU', 'QCOM', 'SHOP',
      'UBER', 'ABNB', 'BA', 'GS'].map(sym => ({ sym, cat: 'stocks' })),
    ...['NQU5', 'ESU5', 'YMU5', 'RTYU5', 'CLN5', 'GCQ5', 'SIN5', 'ZBU5', 'ZNU5', 'ZCU5',
      'HGU5', 'NGU5', 'PLU5', 'KCU5', 'ZSU5', 'ZWU5', '6BU5', '6EU5', '6JU5',
      'LEU5', 'HEU5', 'RBU5'].map(sym => ({ sym, cat: 'futures' })),
    ...['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'USDCHF', 'EURGBP', 'EURJPY', 'GBPJPY',
      'USDTRY', 'USDMXN', 'USDZAR', 'EURCHF', 'AUDJPY', 'CHFJPY', 'EURAUD',
      'EURNZD', 'GBPCHF', 'CADJPY', 'NZDJPY', 'USDSEK'].map(sym => ({ sym, cat: 'forex' })),
  ];
  /* asset class for a symbol — drives the per-asset Quick Trade panel; defaults to crypto */
  function symbolCategory(sym) {
    const found = SYMBOL_LIST.find(s => s.sym === sym);
    return found ? found.cat : 'crypto';
  }
  /* Broker / exchange each symbol trades on — the five venues the terminal supports.
     Most symbols fall back to their asset class's default venue; the override map
     spreads a realistic mix across the crypto exchanges (and a few futures venues). */
  const SYMBOL_BROKERS = {
    ETHUSD: 'BloFin', SOLUSD: 'Bybit', XRPUSD: 'BloFin', BNBUSD: 'Bybit',
    DOGEUSD: 'BloFin', AVAXUSD: 'Bybit', LINKUSD: 'BloFin', DOTUSD: 'Bybit',
    NEARUSD: 'BloFin', APTUSD: 'Bybit', ARBUSD: 'BloFin', SUIUSD: 'Bybit',
    BTCUSD: 'Binance', LTCUSD: 'Binance', ATOMUSD: 'Binance', FILUSD: 'Binance',
    ADAUSD: 'Coinbase', UNIUSD: 'Coinbase', ICPUSD: 'Coinbase', ETCUSD: 'Coinbase',
    ESU5: 'TradeStation', RTYU5: 'TradeStation', GCQ5: 'TradeStation',
  };
  const CAT_BROKER_DEFAULT = { crypto: 'Bitget', futures: 'Tradovate', stocks: 'TradeStation', forex: 'TradeStation' };
  function brokerFor(sym, cat) {
    return Venues.venueLabel(venueForSymbol(sym, cat));
  }
  /* The venue a symbol trades on, as a registry id. The override map above is the intent, but it is
     checked against what the venue actually lists before being honoured: a crypto exchange can't
     hold a stock and a futures broker can't hold a perp, so a mismatch falls back to the asset
     class's default venue rather than labelling a position with a venue that couldn't carry it.
     Exported because js/right-panel.js badges its positions with the same answer. */
  function venueForSymbol(sym, cat) {
    const category = cat || symbolCategory(sym);
    const mapped = (SYMBOL_BROKERS[sym] || '').toLowerCase();
    if (mapped && Venues.venueSupports(mapped, category)) return mapped;
    const fallback = (CAT_BROKER_DEFAULT[category] || 'TradeStation').toLowerCase();
    return fallback;
  }
  window.venueForSymbol = venueForSymbol;

  /* ---------- cross-listed instruments ----------
     A major pair doesn't trade in one place: BTCUSD has a book on every large exchange, and each
     one has its own price and its own tape. So the picker lists an instrument once per venue that
     carries it, and picking a row picks BOTH the instrument and the exchange to chart it on.

     This map holds the ADDITIONAL venues for a symbol; its primary listing (venueForSymbol) is
     always included and always sorts first. Only venues that support the symbol's asset class are
     honoured, so a stock can't be cross-listed onto a crypto exchange by a typo here. */
  const SYMBOL_CROSS_LISTINGS = {
    BTCUSD: ['bybit', 'coinbase', 'blofin', 'bitget'],
    ETHUSD: ['binance', 'bybit', 'coinbase', 'bitget'],
    SOLUSD: ['binance', 'coinbase', 'bitget'],
    XRPUSD: ['binance', 'bitget'],
    DOGEUSD: ['binance', 'bybit'],
    ADAUSD: ['binance', 'bybit'],
    LTCUSD: ['coinbase', 'bitget'],
    LINKUSD: ['binance', 'coinbase'],
    AVAXUSD: ['binance'],
    ATOMUSD: ['bybit'],
    DOTUSD: ['binance', 'coinbase'],
    UNIUSD: ['binance'],
    ARBUSD: ['bybit'],
    OPUSD: ['binance'],
    TONUSD: ['bybit'],
    INJUSD: ['binance'],
    PEPEUSD: ['binance', 'bybit'],
  };

  /* Every (instrument, venue) pair the picker can show — the rows it actually renders. Built once:
     the listings are static, and rebuilding per keystroke would re-sort 200-odd rows for nothing. */
  const SYMBOL_ROWS = SYMBOL_LIST.flatMap(s => {
    const primary = venueForSymbol(s.sym, s.cat);
    const extras = (SYMBOL_CROSS_LISTINGS[s.sym] || [])
      .filter(v => v !== primary && Venues.venueSupports(v, s.cat));
    return [primary, ...extras].map(venue => ({ sym: s.sym, cat: s.cat, venue }));
  });

  // The terminal opens on a symbol, so the chart opens on that symbol's venue.
  Venues.setDataVenue(venueForSymbol(currentSymbol()));

  /* The demo order and history rows the terminal opens with are real trades on real venues, so they
     carry one too. Stamped here rather than written into each literal because venueForSymbol needs
     the symbol list and the venue registry, both of which are set up after those arrays are built. */
  (function seedRowVenues() {
    if (mockAaplOrder && !mockAaplOrder.venue) mockAaplOrder.venue = venueForSymbol(mockAaplOrder.sym);
    [orderHistory, tradeHistory].forEach(list => {
      list.forEach(row => { if (!row.venue) row.venue = venueForSymbol(row.symbol); });
    });
    renderOpenOrders();
    renderOrderHistory();
    renderTradeHistory();
  })();
  const symSelectTrigger = document.getElementById('symSelectTrigger');
  const symSelectMenu = document.getElementById('symSelectMenu');
  const symSelectSearch = document.getElementById('symSelectSearch');
  const symSelectList = document.getElementById('symSelectList');
  const symSelectEmpty = document.getElementById('symSelectEmpty');
  const symSelectClose = document.getElementById('symSelectClose');
  const symSelectLabel = document.getElementById('symSelectLabel');
  const symSelectTabs = document.querySelectorAll('#symSelectTabs .ss-cat');
  const wlAddBtn = document.getElementById('wlAddBtn');
  let symSelectCat = 'all';
  /* column sort — key is null (natural list order) until a header is clicked;
     dir is 1 for ascending, -1 for descending. */
  let symSelectSort = { key: null, dir: 1 };
  /* cosmetic symbol switch — relabels the topbar/watchlist without loading new chart data */
  /* `venue` is the exchange the picker row was listed on. A cross-listed instrument has a row per
     venue, so the click carries which one was chosen; anything that only knows a symbol (the
     watchlist, a legend double-click) omits it and gets that symbol's primary listing. */
  function switchSymbol(sym, venue) {
    symSelectLabel.textContent = sym;
    document.querySelectorAll('.wl-row.selected').forEach(r => r.classList.remove('selected'));
    const wlRow = document.querySelector('.wl-row[data-sym="' + sym + '"]');
    if (wlRow) wlRow.classList.add('selected');
    qtApplyAssetConfig(sym);
    /* The chart draws the instrument on the venue that lists it — the Broker column of the symbol
       picker. There is no separate chart-venue control: picking ETHUSD is picking BloFin's ETHUSD.
       Fires venue:changed, which repaints the legend, so it runs before the update below. */
    const cat = symbolCategory(sym);
    const target = (venue && Venues.venueSupports(venue, cat)) ? venue : venueForSymbol(sym, cat);
    Venues.setDataVenue(target);
    /* keep the chart legend's symbol in sync with the selected asset (#symSelectLabel) */
    if (window.updateChartLegend) window.updateChartLegend();
    showToast('Switched to ' + sym + ' · ' + Venues.venueLabel(target), 'sync_alt');
  }
  // Exposed so the left-panel watchlist (js/resize.js) can switch symbols too.
  window.switchSymbol = switchSymbol;

  /* add/remove the symbol from the watchlist; the watchlist:changed listener below
     keeps every open toggle (and the panel) in sync, so we only fire the action here */
  /* The toggle acts on the LISTING the row shows, not just the ticker: bookmarking Binance's ETHUSD
     while the watchlist holds BloFin's moves the watchlist to Binance (the watchlist keeps one row
     per instrument), so the bookmark ends up lit on exactly one venue. */
  function toggleWatchlistSymbol(sym, cat, venue) {
    if (window.watchlistHasSymbol && window.watchlistHasSymbol(sym, venue)) {
      if (window.removeWatchlistSymbol) window.removeWatchlistSymbol(sym);
      showToast('Removed ' + sym + ' from watchlist', 'remove');
      return;
    }
    const moved = !!(window.watchlistHasSymbol && window.watchlistHasSymbol(sym));
    if (window.addWatchlistSymbol) window.addWatchlistSymbol(sym, cat, venue);
    const label = Venues.venueLabel(venue || venueForSymbol(sym, cat));
    if (moved) showToast('Moved ' + sym + ' to ' + label + ' in watchlist', 'sync_alt');
    else showToast('Added ' + sym + ' · ' + label + ' to watchlist', 'add');
  }

  /* one row of the Symbol Selector modal: symbol + name, live last / 24h% / 24h vol,
     and a watchlist toggle (star, gold-filled when the symbol is watchlisted). */
  /* One instrument as it looks on one venue. The market simulation quotes a single consolidated
     tape per symbol, so each venue's row is that tape shifted by the venue's basis and scaled by
     its share of the volume — which is what makes BTCUSD on Binance and BTCUSD on Coinbase read as
     two real, differently-priced books rather than the same row printed twice. */
  /* Matches the volume format the market data itself uses (fmtVol in js/right-panel.js) — the
     scaled figure has to sit in the same column as the unscaled ones and read identically. */
  function fmtSymVol(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function venueQuote(s) {
    const d = window.getMarketData ? window.getMarketData(s.sym, s.cat) : null;
    if (!d) return null;
    const last = d.last * (1 + Venues.venueBasisBps(s.venue) / 10000);
    const vol = d.vol * Venues.venueLiquidity(s.venue);
    return {
      name: d.name, up: d.up, chgPct: d.chgPct, chgPctText: d.chgPctText,
      last, lastText: fmt(last, d.dec),
      vol, volText: fmtSymVol(vol),
    };
  }

  function buildSymRow(s) {
    const d = venueQuote(s);
    /* venue-scoped: only the listing the watchlist actually holds reads as bookmarked, so the
       other venues carrying the same instrument stay unmarked */
    const inWl = !!(window.watchlistHasSymbol && window.watchlistHasSymbol(s.sym, s.venue));
    const name = d ? d.name : s.sym;
    const chgDir = d && !d.up ? 'down' : 'up';
    return '<div class="ss-row" data-sym="' + s.sym + '" data-cat="' + s.cat + '" data-venue="' + s.venue + '" tabindex="0" role="button">' +
      '<div class="ss-sym"><span class="ss-sym-ticker">' + s.sym + '</span>' +
      '<span class="ss-sym-name">' + name + '</span></div>' +
      '<span class="ss-broker">' + Venues.venueLabel(s.venue) + '</span>' +
      '<span class="ss-last">' + (d ? d.lastText : '') + '</span>' +
      '<span class="ss-chg ' + chgDir + '">' + (d ? d.chgPctText : '') + '</span>' +
      '<span class="ss-vol">' + (d ? d.volText : '') + '</span>' +
      '<button class="ss-wl-toggle' + (inWl ? ' on' : '') + '" data-sym="' + s.sym + '" data-cat="' + s.cat + '" ' +
      'data-venue="' + s.venue + '" ' +
      'data-tooltip="' + (inWl ? 'Remove from watchlist' : 'Add to watchlist') + '">' +
      '<span class="material-symbols-outlined">bookmark</span></button>' +
      '</div>';
  }

  /* comparable value for the active sort column (numeric for the value columns,
     the ticker string for the symbol column) */
  function sortValue(s, key) {
    if (key === 'sym') return s.sym;
    if (key === 'broker') return Venues.venueLabel(s.venue);
    const d = venueQuote(s);
    if (!d) return 0;
    if (key === 'last') return d.last;
    if (key === 'chg') return d.chgPct;
    if (key === 'vol') return d.vol;
    return 0;
  }

  /* reflect the active sort column + direction on the header cells */
  function updateSortHeaders() {
    symSelectMenu.querySelectorAll('.ss-cols .ss-col[data-sort]').forEach(col => {
      const active = col.dataset.sort === symSelectSort.key;
      col.classList.toggle('sorted', active);
      const arrow = col.querySelector('.ss-sort');
      if (arrow) arrow.textContent = (active && symSelectSort.dir === 1) ? 'arrow_upward' : 'arrow_downward';
    });
  }

  function renderSymSelectList(filter) {
    const q = (filter || '').trim().toUpperCase();
    // Searching matches the venue too, so typing "coinbase" lists everything Coinbase carries.
    const items = SYMBOL_ROWS.filter(s => (symSelectCat === 'all' || s.cat === symSelectCat)
      && (!q || s.sym.includes(q) || Venues.venueLabel(s.venue).toUpperCase().includes(q)));
    if (symSelectSort.key) {
      const key = symSelectSort.key, dir = symSelectSort.dir;
      items.sort((a, b) => {
        const av = sortValue(a, key), bv = sortValue(b, key);
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
    }
    symSelectList.innerHTML = items.map(buildSymRow).join('');
    updateSortHeaders();
    if (symSelectEmpty) symSelectEmpty.style.display = items.length ? 'none' : 'block';
    symSelectList.querySelectorAll('.ss-row').forEach(row => {
      row.addEventListener('click', (e) => {
        /* the toggle handles its own click; a row-body click switches the chart symbol */
        if (e.target.closest('.ss-wl-toggle')) return;
        // Picking a row picks the instrument AND the exchange to chart it on.
        switchSymbol(row.dataset.sym, row.dataset.venue);
        closeAllPopovers();
      });
      const tog = row.querySelector('.ss-wl-toggle');
      if (tog) tog.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWatchlistSymbol(tog.dataset.sym, tog.dataset.cat, tog.dataset.venue);
      });
    });
  }

  /* open the centered, draggable modal from any of its triggers (topbar ticker,
     chart-legend double-click, or the watchlist + button) */
  function openSymSelect(triggerEl) {
    if (symSelectMenu.classList.contains('show') && symSelectMenu._openTrigger === triggerEl) {
      closeAllPopovers();
      return;
    }
    symSelectSearch.value = '';
    symSelectCat = 'all';
    symSelectTabs.forEach(t => t.classList.toggle('active', t.dataset.cat === 'all'));
    renderSymSelectList('');
    openCentered(symSelectMenu, triggerEl);
    symSelectSearch.focus();
  }
  if (symSelectMenu) makeFloatPanelDraggable(symSelectMenu);

  if (symSelectTrigger) symSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openSymSelect(symSelectTrigger);
  });
  if (wlAddBtn) wlAddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSymSelect(wlAddBtn);
  });
  if (symSelectClose) symSelectClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
  });
  /* Double-clicking the chart legend header opens the same symbol selector. */
  const clHeaderEl = document.querySelector('.cl-header');
  if (clHeaderEl && symSelectMenu) {
    clHeaderEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openSymSelect(clHeaderEl);
    });
    /* Hovering the legend header suppresses the chart crosshair so the header reads as an
       interactive element, not chart space (same mechanism as the indicator legend rows). */
    clHeaderEl.addEventListener('mouseenter', () => {
      isHoveringClHeader = true;
      if (crosshair) { crosshair = null; scheduleDrawPriceChart(); updateLegendValues(); }
    });
    clHeaderEl.addEventListener('mouseleave', () => {
      isHoveringClHeader = false;
    });
  }
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
  /* click a column header to sort by it; click the active header again to flip the
     direction. The text columns (Symbol, Exchange) sort A→Z first; the numeric
     columns sort high→low first. */
  symSelectMenu.querySelectorAll('.ss-cols .ss-col[data-sort]').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = col.dataset.sort;
      if (symSelectSort.key === key) {
        symSelectSort.dir = -symSelectSort.dir;
      } else {
        symSelectSort.key = key;
        symSelectSort.dir = (key === 'sym' || key === 'broker') ? 1 : -1;
      }
      renderSymSelectList(symSelectSearch.value);
    });
  });
  /* live-refresh the visible rows' price/change/volume while the modal is open */
  document.addEventListener('market:tick', () => {
    if (!symSelectMenu.classList.contains('show')) return;
    symSelectList.querySelectorAll('.ss-row').forEach(row => {
      // Through venueQuote, not getMarketData directly: a cross-listed row shows its own venue's
      // price and tape, and repainting from the raw consolidated figures would flatten every
      // listing of an instrument back to one number on the next tick.
      const d = venueQuote({ sym: row.dataset.sym, cat: row.dataset.cat, venue: row.dataset.venue });
      if (!d) return;
      const last = row.querySelector('.ss-last');
      const chg = row.querySelector('.ss-chg');
      const vol = row.querySelector('.ss-vol');
      if (last) last.textContent = d.lastText;
      if (chg) { chg.textContent = d.chgPctText; chg.classList.toggle('up', d.up); chg.classList.toggle('down', !d.up); }
      if (vol) vol.textContent = d.volText;
    });
  });
  /* keep the modal's toggle in sync when the watchlist changes from anywhere
     (the modal itself, or the panel's row × ) */
  document.addEventListener('watchlist:changed', (e) => {
    if (!symSelectMenu.classList.contains('show')) return;
    const sym = e.detail && e.detail.sym;
    if (!sym) return;
    /* Every listing of the symbol is repainted, not just the one clicked: the bookmark belongs to
       one venue, so when it moves the venue it left has to go dark in the same pass. */
    const watchedVenue = window.watchlistVenueFor ? window.watchlistVenueFor(sym) : null;
    symSelectList.querySelectorAll('.ss-wl-toggle[data-sym="' + sym + '"]').forEach(tog => {
      const inWl = !!watchedVenue && tog.dataset.venue === watchedVenue;
      tog.classList.toggle('on', inWl);
      tog.setAttribute('data-tooltip', inWl ? 'Remove from watchlist' : 'Add to watchlist');
    });
  });

  /* ---------- watchlist: customize-columns menu (⋯ button) ---------- */
  const wlColsBtn = document.getElementById('wlColsBtn');
  const wlColsMenu = document.getElementById('wlColsMenu');
  const wlCard = document.getElementById('wlCard');
  if (wlColsBtn) wlColsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wlColsMenu.classList.contains('show') && wlColsMenu._openTrigger === wlColsBtn) {
      closeAllPopovers();
      return;
    }
    openNear(wlColsMenu, wlColsBtn.getBoundingClientRect(), 'right', wlColsBtn);
  });
  if (wlColsMenu) {
    /* column checkboxes toggle the matching wl-show-<col> class on #wlCard;
       keep the menu open so several columns can be toggled at once */
    wlColsMenu.querySelectorAll('.pop-item.checklist').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = item.classList.toggle('checked');
        wlCard.classList.toggle('wl-show-' + item.dataset.col, on);
      });
    });
    /* display-mode radios: ticker vs company name */
    const wlDisplayGroup = document.getElementById('wlDisplayModeGroup');
    if (wlDisplayGroup) {
      wlDisplayGroup.querySelectorAll('.cs-radio-row').forEach(row => {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          wlDisplayGroup.querySelectorAll('.cs-radio-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          wlCard.classList.toggle('wl-show-names', row.dataset.mode === 'name');
        });
      });
    }
  }

  /* ---------- indicators modal ---------- */
  const indicatorsTrigger = document.getElementById('indicatorsTrigger');
  const indicatorsMenu = document.getElementById('indicatorsMenu');
  const indicatorSearch = document.getElementById('indicatorSearch');
  const indicatorSearchClear = document.getElementById('indicatorSearchClear');
  const indicatorList = document.getElementById('indicatorList');
  const indEmpty = document.getElementById('indEmpty');
  const indEmptyIcon = document.getElementById('indEmptyIcon');
  const indEmptyText = document.getElementById('indEmptyText');
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
    { name: 'Whale Movement', desc: 'Detects large institutional orders that signal potential market moves', cat: 'l1' },

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

    { name: 'Market Oracle Plus', desc: 'A trend and signal toolkit that helps traders act with more clarity as price moves.', cat: 'chartprime' },
    { name: 'Market Dynamics', desc: 'A liquidity and structure toolkit that maps reaction zones, breakouts, gaps, and institutional areas in real time.', cat: 'chartprime' },
    { name: 'Prime Oscillators Plus', desc: 'A momentum toolkit that shows when momentum is building, fading, or flipping.', cat: 'chartprime' },
    { name: 'Prime Screener', desc: 'An on-chart dashboard for scanning different assets and spotting opportunities at a glance.', cat: 'chartprime' },

    { name: 'Adaptive Momentum Velocity Ribbon', desc: 'An adaptive ribbon that reacts to momentum and volatility, tightening as a move accelerates and widening when conditions quiet down.', cat: 'chartprimefree' },
    { name: 'HTF Candle Volume Profile', desc: 'Draws higher timeframe candles with their volume profiles on the current chart, revealing where activity concentrated in each period.', cat: 'chartprimefree' },
    { name: 'Power Order Blocks', desc: 'Finds supply and demand zones from institutional displacement and rates each one by the strength of the move that created it.', cat: 'chartprimefree' },
    { name: 'Volumetric Trend Ribbon Pro', desc: 'A volume-weighted volatility ribbon that expands in strong trends and contracts in indecision, with breakout targets and volume spike detection.', cat: 'chartprimefree' },
    { name: 'Macro Trend Split Profile', desc: 'Anchors a volume profile at the start of each macro trend leg and splits it into bullish and bearish sides to show where conviction sits.', cat: 'chartprimefree' },
    { name: 'Smart Money Fibonacci OTE Engine', desc: 'Detects trend shifts and projects Fibonacci retracements automatically, highlighting the Optimal Trade Entry zone.', cat: 'chartprimefree' },
    { name: 'Trend-Reset Cumulative Delta', desc: 'Tracks net buying versus selling pressure and resets on volatility band breaks, so delta reflects only the current trend.', cat: 'chartprimefree' },
    { name: 'Bollinger Bands Range RSI Oscillator', desc: 'Maps RSI momentum onto Bollinger Bands on the price chart, flagging divergences and shading momentum extremes without a separate panel.', cat: 'chartprimefree' },
    { name: 'Volume Liquidity Trend', desc: 'Maps the high-volume price points of the current trend as liquidity levels that update as price invalidates them.', cat: 'chartprimefree' },
    { name: 'Polynomial Regression Channel', desc: 'Fits a curved regression channel to price with forward projection and coloring that reflects directional bias.', cat: 'chartprimefree' },
    { name: 'Volume Channel Flow', desc: 'Tracks evolving trend channels and profiles how volume is distributed inside each segment to identify bias and breakout zones.', cat: 'chartprimefree' },
    { name: 'Swing Structure Bands', desc: 'Builds adaptive bands from swing highs and lows that stretch as price develops, marking structure-aligned support and resistance.', cat: 'chartprimefree' },
  ];

  /* Per-indicator documentation shown in the panel's in-panel "Read More" doc view.
     Keyed by IND_DATA name. Each section is optional — renderIndDoc skips any that's absent,
     so the content adapts to what's relevant for each indicator. Educational, not advice. */
  const IND_DOCS = {
    'Moving Average': {
      tagline: 'The foundational trend filter — a smoothed line of average price.',
      overview: 'A Moving Average (MA) plots the average closing price over a chosen number of bars, producing a smooth line that filters out short-term noise and reveals the underlying trend. It is the single most widely used indicator in technical analysis and the building block for dozens of others.',
      howItWorks: 'For each bar, the MA sums the closing prices of the last N bars and divides by N. As new bars form, the window slides forward, so the line continuously updates. A longer length produces a slower, smoother line; a shorter length hugs price more closely.',
      features: ['Works on any market and timeframe', 'Reveals trend direction at a glance', 'Acts as dynamic support and resistance', 'Foundation for crossovers and envelopes'],
      howToUse: ['Read trend from slope: rising = uptrend, falling = downtrend, flat = range', 'Use price crossing the MA as a simple trend-change cue', 'Combine a fast and slow MA and trade their crossovers', 'Treat the MA as a moving support/resistance level in trends'],
      settings: [{ name: 'Length', detail: 'Number of bars averaged. Common values: 20 (short), 50 (medium), 200 (long-term).' }, { name: 'Source', detail: 'Price used per bar — usually Close, but Open/High/Low/HL2 are available.' }],
      signals: ['Price crossing above the MA — potential shift to bullish', 'Price crossing below the MA — potential shift to bearish', 'Fast MA crossing a slow MA — momentum confirmation'],
      tips: ['Longer lengths lag more but whipsaw less', 'In ranging markets MAs give frequent false signals — pair with a trend-strength filter like ADX'],
    },
    'EMA': {
      tagline: 'A faster moving average that reacts quickly to recent price.',
      overview: 'The Exponential Moving Average (EMA) is a moving average that weights recent bars more heavily than older ones, so it turns faster than a Simple Moving Average. Traders use it when they want a trend line that responds quickly to fresh price action.',
      howItWorks: 'Rather than treating every bar in the window equally, the EMA applies an exponentially decaying weight, giving the most recent close the greatest influence. This makes it hug price more tightly and change direction sooner than an SMA of the same length.',
      features: ['Reacts faster than an SMA', 'Popular for the 9, 21, 50, and 200 lengths', 'Great for crossover systems', 'Smoother than raw price but responsive'],
      howToUse: ['Use short EMAs (9/21) for entries in trending markets', 'Trade 9/21 or 50/200 EMA crossovers for trend shifts', 'Use the EMA as a trailing support line to hold trends'],
      settings: [{ name: 'Length', detail: 'Bars in the average. 9 and 21 for scalping, 50 and 200 for the broader trend.' }, { name: 'Source', detail: 'Price input per bar, typically Close.' }],
      signals: ['Fast EMA crossing above slow EMA — bullish momentum', 'Fast EMA crossing below slow EMA — bearish momentum', 'Price rejecting off a rising EMA — trend continuation'],
      tips: ['Faster reaction means more false signals in chop', 'The 200 EMA is watched by many traders as a major trend line'],
    },
    'SMA': {
      tagline: 'The classic simple average of price over a period.',
      overview: 'The Simple Moving Average (SMA) averages closing prices over N bars with equal weight for each. It is the most straightforward trend line and the benchmark against which other averages are compared.',
      howItWorks: 'Every bar in the lookback window counts equally: sum the last N closes and divide by N. Because old and new bars matter the same, the SMA is smoother and slower to react than an EMA of the same length.',
      features: ['Equal weighting — very smooth', 'Predictable, well-understood behavior', 'Strong as a long-term trend reference'],
      howToUse: ['Use the 50 and 200 SMA to define the primary trend', 'Watch the "golden cross" (50 above 200) and "death cross" (50 below 200)', 'Use as a slow anchor alongside a faster EMA'],
      settings: [{ name: 'Length', detail: 'Bars averaged equally. 50 and 200 are the institutional standards.' }, { name: 'Source', detail: 'Usually Close.' }],
      signals: ['Golden cross — 50 SMA crossing above 200 SMA', 'Death cross — 50 SMA crossing below 200 SMA'],
      tips: ['Slower than EMA, so fewer whipsaws but later entries', 'Best for defining the big-picture trend rather than timing entries'],
    },
    'VWAP': {
      tagline: 'The volume-weighted average price — where the average trade filled.',
      overview: 'VWAP shows the average price of an asset weighted by the volume traded at each level. Because it reflects where the bulk of volume actually transacted, institutions use it as a fair-value benchmark and a reference for execution quality.',
      howItWorks: 'For each bar VWAP multiplies price by volume, keeps a running total, and divides by cumulative volume since the session start. Levels where a lot traded pull VWAP toward them, so it represents the volume-weighted "center of gravity" of the session.',
      features: ['Intraday fair-value benchmark', 'Resets each session by default', 'Optional standard-deviation bands', 'Heavily used by institutional desks'],
      howToUse: ['Treat price above VWAP as intraday bullish, below as bearish', 'Look for pullbacks to VWAP as trend-continuation entries', 'Use VWAP bands to gauge stretched, mean-reverting moves'],
      settings: [{ name: 'Anchor', detail: 'When the calculation resets — session, week, or a custom anchor point.' }, { name: 'Bands', detail: 'Optional standard-deviation envelopes around VWAP.' }],
      signals: ['Price reclaiming VWAP after a dip — intraday strength', 'Repeated rejection at VWAP — resistance overhead', 'Price far from VWAP — possible mean reversion'],
      tips: ['Most meaningful on intraday timeframes', 'VWAP is a magnet — extended moves often revisit it'],
    },
    'RSI': {
      tagline: 'The momentum oscillator for overbought and oversold conditions.',
      overview: 'The Relative Strength Index (RSI) measures the speed and magnitude of recent price changes on a 0–100 scale. It helps identify when a move may be overextended and when momentum is quietly shifting before price does.',
      howItWorks: 'RSI compares the average size of up-closes to the average size of down-closes over the lookback period, then normalizes the result to a 0–100 range. High readings mean up-moves dominate; low readings mean down-moves dominate.',
      features: ['Bounded 0–100 oscillator', 'Classic 70/30 overbought/oversold bands', 'Reveals momentum divergence', 'Works across all markets'],
      howToUse: ['Watch 70+ for overbought and 30- for oversold conditions', 'Hunt for divergence between RSI and price for early reversal warnings', 'In strong trends, use 50 as the bull/bear dividing line'],
      settings: [{ name: 'Length', detail: 'Lookback period. 14 is standard; shorter is more sensitive.' }, { name: 'Overbought / Oversold', detail: 'Threshold levels, default 70 and 30.' }],
      signals: ['Bearish divergence — price higher high, RSI lower high', 'Bullish divergence — price lower low, RSI higher low', 'RSI crossing back through 30 or 70'],
      tips: ['Overbought can stay overbought in strong trends — do not short blindly', 'Divergence is a warning, not a trigger — wait for price confirmation'],
    },
    'Stochastic RSI': {
      tagline: 'A more sensitive RSI for spotting short-term momentum extremes.',
      overview: 'Stochastic RSI applies the Stochastic formula to RSI values instead of price, producing a faster, more sensitive oscillator. It reaches overbought and oversold far more often than RSI, making it useful for timing short-term turns.',
      howItWorks: 'It measures where the current RSI sits within its own high-low range over a lookback window, scaling that to 0–100. Because it is an oscillator of an oscillator, it swings quickly and frequently.',
      features: ['Highly sensitive momentum reader', '%K and %D signal lines', 'Frequent overbought/oversold cycles', 'Good for short-term timing'],
      howToUse: ['Use %K/%D crossovers in oversold/overbought zones for entries', 'Confirm with the higher-timeframe trend to avoid counter-trend traps', 'Combine with support/resistance for higher-quality signals'],
      settings: [{ name: 'Stoch Length', detail: 'Lookback for the Stochastic calculation.' }, { name: 'RSI Length', detail: 'Underlying RSI period.' }, { name: 'K / D Smoothing', detail: 'Smoothing applied to the signal lines.' }],
      signals: ['%K crossing %D below 20 — potential bounce', '%K crossing %D above 80 — potential pullback'],
      tips: ['Very noisy — expect many signals, filter aggressively', 'Best used with a trend filter, not on its own'],
    },
    'MACD': {
      tagline: 'Trend and momentum in one — the moving-average convergence/divergence.',
      overview: 'MACD combines trend and momentum by measuring the relationship between two EMAs. Its line, signal, and histogram together show whether momentum is building, fading, or flipping, making it one of the most popular all-round indicators.',
      howItWorks: 'The MACD line is the difference between a fast and a slow EMA (default 12 and 26). A signal line (default 9-EMA of the MACD) is plotted on top, and the histogram shows the gap between them — expanding bars mean accelerating momentum, shrinking bars mean it is fading.',
      features: ['Combines trend and momentum', 'MACD line, signal line, and histogram', 'Zero-line context for trend bias', 'Divergence detection'],
      howToUse: ['Trade MACD/signal-line crossovers for momentum shifts', 'Use the zero line as the bull/bear boundary', 'Watch histogram divergence against price for early warnings'],
      settings: [{ name: 'Fast Length', detail: 'Fast EMA period, default 12.' }, { name: 'Slow Length', detail: 'Slow EMA period, default 26.' }, { name: 'Signal Length', detail: 'Signal-line EMA, default 9.' }],
      signals: ['MACD crossing above signal — bullish momentum', 'MACD crossing below signal — bearish momentum', 'Histogram divergence against price'],
      tips: ['Crossovers above zero (bullish) or below zero (bearish) carry more weight', 'Lags in fast markets — combine with a leading oscillator'],
    },
    'Bollinger Bands': {
      tagline: 'Volatility envelopes that expand and contract around price.',
      overview: 'Bollinger Bands wrap a moving average in an upper and lower band set a number of standard deviations away. The bands widen when volatility rises and narrow when it falls, framing price within a dynamic, statistically-derived channel.',
      howItWorks: 'A middle SMA is plotted, then the standard deviation of price over the same period is calculated and multiplied (default ×2) to place the outer bands. Because standard deviation tracks volatility, the envelope breathes with the market.',
      features: ['Adaptive volatility channel', 'Squeeze detection for breakouts', 'Mean-reversion reference', 'Works on any timeframe'],
      howToUse: ['Watch for a "squeeze" (narrow bands) preceding volatility expansion', 'Fade touches of the outer bands in ranging markets', 'In trends, riding the upper/lower band signals strength, not reversal'],
      settings: [{ name: 'Length', detail: 'Period of the middle SMA and standard deviation, default 20.' }, { name: 'StdDev', detail: 'Band width multiplier, default 2.' }],
      signals: ['Band squeeze — volatility contraction before a breakout', 'Price walking the upper band — strong uptrend', 'Repeated failure at a band in a range — mean reversion'],
      tips: ['A band touch is not automatically a reversal — read the trend first', 'Squeezes signal that a move is coming, not its direction'],
    },
    'ATR': {
      tagline: 'A pure volatility gauge — the average range price travels.',
      overview: 'Average True Range (ATR) measures how much an asset typically moves per bar, giving a single number for current volatility. It says nothing about direction; instead it is the go-to tool for sizing stops and targets to the market’s real movement.',
      howItWorks: 'For each bar, True Range is the largest of: high minus low, high minus previous close, or low minus previous close (capturing gaps). ATR is a moving average of True Range, so it rises in volatile conditions and falls in quiet ones.',
      features: ['Direction-agnostic volatility reading', 'Ideal for stop and target placement', 'Adapts position size to conditions', 'Foundation for Supertrend and Keltner Channels'],
      howToUse: ['Place stops a multiple of ATR away to avoid normal noise', 'Scale position size down when ATR is high', 'Set profit targets in ATR multiples for consistency'],
      settings: [{ name: 'Length', detail: 'Averaging period for True Range, default 14.' }],
      signals: ['Rising ATR — volatility expanding', 'Falling ATR — market calming into a range'],
      tips: ['ATR is absolute, not percentage — compare within the same asset', 'A 1.5–3× ATR stop is a common starting point'],
    },
    'Volume': {
      tagline: 'The fuel behind price — how much trading is happening.',
      overview: 'Volume shows the number of units traded per bar, revealing the conviction behind a price move. Moves on high volume carry more weight; moves on thin volume are more suspect. It is the oldest confirmation tool in the book.',
      howItWorks: 'Each bar’s volume is plotted as a column, often colored by whether the bar closed up or down. Optional moving averages of volume help distinguish genuinely elevated activity from the norm.',
      features: ['Confirms the strength of a move', 'Up/down colored columns', 'Optional volume moving average', 'Universal across markets'],
      howToUse: ['Confirm breakouts with a volume surge', 'Be wary of moves on shrinking volume', 'Watch climactic volume spikes for potential exhaustion'],
      settings: [{ name: 'MA Length', detail: 'Optional moving average of volume to define the "normal" baseline.' }],
      signals: ['Breakout on high volume — higher reliability', 'Rally on falling volume — weakening participation', 'Volume climax — possible exhaustion top or bottom'],
      tips: ['Volume leads price at turning points', 'Always judge volume relative to its recent average, not in absolute terms'],
    },
    'Volume Profile': {
      tagline: 'A horizontal map of where volume traded by price.',
      overview: 'Volume Profile displays trading volume horizontally across price levels rather than over time, revealing which prices the market accepted and which it rejected. High-volume nodes act as magnets and support/resistance; low-volume nodes are where price moves fast.',
      howItWorks: 'Over a chosen range, all volume is bucketed by the price at which it traded, forming a horizontal histogram. The Point of Control (POC) is the highest-volume price, and the Value Area contains the bulk (typically 70%) of traded volume.',
      features: ['Point of Control and Value Area', 'Reveals high- and low-volume nodes', 'Session, visible-range, or fixed-range modes', 'Structure-based support/resistance'],
      howToUse: ['Trade reactions at the POC and Value Area edges', 'Expect quick moves through low-volume gaps', 'Use high-volume nodes as targets and defensive levels'],
      settings: [{ name: 'Range', detail: 'What span the profile covers — session, visible range, or fixed range.' }, { name: 'Value Area %', detail: 'Share of volume defining the Value Area, default 70%.' }],
      signals: ['Rejection at the POC — strong support/resistance', 'Price accelerating through a low-volume node', 'Return to Value Area after leaving it'],
      tips: ['High-volume nodes attract price; low-volume nodes repel it', 'Great for choosing targets and defining risk around structure'],
    },
    'Support & Resistance': {
      tagline: 'Automatic marking of key levels where price tends to react.',
      overview: 'This tool identifies and draws the horizontal price levels where the market has repeatedly reversed or paused. Support and resistance are the backbone of price-action trading, defining where reactions, breakouts, and risk are placed.',
      howItWorks: 'The indicator scans recent swing highs and lows and clusters levels that price has tested multiple times, drawing zones that update as new structure forms. The more touches and volume a level has, the stronger it is considered.',
      features: ['Auto-detected key levels', 'Zones rather than single lines', 'Strength based on number of touches', 'Updates with new structure'],
      howToUse: ['Buy near support and sell near resistance in ranges', 'Trade breakouts through a level with a retest confirmation', 'Anchor stops just beyond the level you are trading'],
      settings: [{ name: 'Sensitivity', detail: 'How significant a swing must be to register as a level.' }, { name: 'Lookback', detail: 'How far back structure is scanned.' }],
      signals: ['Bounce off support/resistance — range trade', 'Break and retest of a level — continuation', 'Repeated tests weakening a level — impending break'],
      tips: ['Treat levels as zones, not exact prices', 'A broken resistance often becomes new support, and vice versa'],
    },
    'Pivot Points': {
      tagline: 'Pre-calculated intraday support and resistance from prior range.',
      overview: 'Pivot Points project a central pivot and a ladder of support and resistance levels for the current session from the previous period’s high, low, and close. Day traders use them as objective, widely-watched reference levels.',
      howItWorks: 'The central pivot is the average of the prior period’s high, low, and close. Support (S1–S3) and resistance (R1–R3) levels are then derived with fixed formulas. Because the levels are formulaic and popular, they can become self-fulfilling.',
      features: ['Objective, formula-based levels', 'Central pivot plus multiple S/R bands', 'Daily, weekly, or monthly anchoring', 'Multiple calculation methods'],
      howToUse: ['Use the central pivot as the intraday bull/bear line', 'Fade or take profit at R1/S1 in ranges', 'Trade extensions to R2/R3 or S2/S3 on trend days'],
      settings: [{ name: 'Type', detail: 'Calculation method — Traditional, Fibonacci, Camarilla, Woodie.' }, { name: 'Timeframe', detail: 'Anchor period — daily, weekly, monthly.' }],
      signals: ['Holding above the central pivot — intraday bullish bias', 'Rejection at R1/R2 — resistance', 'Reclaim of a lost pivot level'],
      tips: ['Most effective on intraday charts', 'Confluence with other levels makes a pivot far stronger'],
    },
    'Supertrend': {
      tagline: 'A clean trend-following line and trailing-stop tool.',
      overview: 'Supertrend plots a single line that flips above or below price to signal trend direction, using volatility to set its distance. Its simplicity — green line below price for up, red above for down — makes it a favorite for trend trading and trailing stops.',
      howItWorks: 'Using ATR to measure volatility, Supertrend places bands a multiple of ATR from price. When price closes through the band, the trend flips and the line jumps to the other side, trailing price at a volatility-adjusted distance.',
      features: ['Single, unambiguous trend line', 'ATR-based, volatility-adaptive', 'Built-in trailing stop', 'Clear flip signals'],
      howToUse: ['Trade in the direction of the line’s color', 'Use the line as a trailing stop to ride trends', 'Enter on flips confirmed by the higher-timeframe trend'],
      settings: [{ name: 'ATR Length', detail: 'Volatility lookback, default 10.' }, { name: 'Multiplier', detail: 'ATR distance for the bands, default 3.' }],
      signals: ['Line flipping below price — uptrend begins', 'Line flipping above price — downtrend begins'],
      tips: ['Whipsaws in ranges — best in trending conditions', 'A higher multiplier gives fewer, steadier signals'],
    },
    'Ichimoku Cloud': {
      tagline: 'A complete trend, momentum, and support/resistance system.',
      overview: 'Ichimoku Kinko Hyo is an all-in-one system whose five lines and shaded "cloud" convey trend, momentum, and support/resistance at a glance. Once its components are learned, it offers a full trading framework on a single overlay.',
      howItWorks: 'It plots the Conversion and Base lines (midpoints of recent ranges), a Lagging Span (price shifted back), and two Leading Spans that form the cloud (Kumo) projected forward. The cloud’s color and thickness show trend direction and strength.',
      features: ['Five-component all-in-one system', 'Forward-projected cloud', 'Dynamic support/resistance', 'Trend, momentum, and bias together'],
      howToUse: ['Trade long above the cloud, short below it', 'Use Conversion/Base crossovers for entries', 'Confirm with the Lagging Span clear of price'],
      settings: [{ name: 'Conversion', detail: 'Tenkan-sen period, default 9.' }, { name: 'Base', detail: 'Kijun-sen period, default 26.' }, { name: 'Lagging Span', detail: 'Displacement, default 26.' }],
      signals: ['Price breaking above the cloud — bullish', 'Price breaking below the cloud — bearish', 'Cloud twist — trend change ahead'],
      tips: ['A thick cloud is stronger support/resistance', 'Best signals come when all components align'],
    },
    'Parabolic SAR': {
      tagline: 'Trailing dots that flag trend direction and reversals.',
      overview: 'The Parabolic SAR ("stop and reverse") prints a trail of dots above or below price that flip sides when the trend reverses. It is a straightforward tool for staying with a trend and managing a trailing stop.',
      howItWorks: 'In an uptrend, dots sit below price and accelerate upward via an acceleration factor; when price crosses the dots, the SAR flips above and the trend is considered reversed. The acceleration factor tightens the trail as the trend extends.',
      features: ['Clear dot-based trend signal', 'Accelerating trailing stop', 'Simple reversal flags', 'Good for trending markets'],
      howToUse: ['Hold longs while dots are below price', 'Use the dots as a trailing stop level', 'Treat a dot flip as an exit or reversal cue'],
      settings: [{ name: 'Step', detail: 'Acceleration factor increment, default 0.02.' }, { name: 'Max', detail: 'Maximum acceleration factor, default 0.2.' }],
      signals: ['Dots flipping below price — uptrend', 'Dots flipping above price — downtrend'],
      tips: ['Poor in sideways markets — expect frequent flips', 'Pair with ADX to trade it only when a trend exists'],
    },
    'ADX': {
      tagline: 'A meter of trend strength — regardless of direction.',
      overview: 'The Average Directional Index (ADX) measures how strong a trend is, not which way it points. It is the classic filter for deciding whether to deploy trend-following tools or step aside during rangebound conditions.',
      howItWorks: 'ADX is derived from the Directional Movement indicators (+DI and −DI), which compare rising and falling ranges. ADX itself rises as one direction dominates and falls when the market is choppy, plotting on a 0–100 scale (usually read 0–50).',
      features: ['Pure trend-strength reading', '+DI / −DI directional components', 'Key 20/25 threshold', 'Filters trend vs. range'],
      howToUse: ['Trade trends only when ADX is above ~25', 'Avoid or fade breakouts when ADX is low and falling', 'Use +DI/−DI crossovers for directional bias'],
      settings: [{ name: 'Length', detail: 'Smoothing period, default 14.' }, { name: 'Threshold', detail: 'Trend cutoff level, commonly 20 or 25.' }],
      signals: ['ADX rising through 25 — trend strengthening', 'ADX falling below 20 — trend fading into a range', '+DI crossing −DI — directional shift'],
      tips: ['ADX says how strong, +DI/−DI say which way', 'A falling ADX in a trend warns of momentum loss'],
    },
    'CCI': {
      tagline: 'Finds momentum extremes and potential reversals.',
      overview: 'The Commodity Channel Index (CCI) measures how far price has strayed from its statistical average, oscillating around zero. Despite the name it works on any market and is used to spot overextended moves and emerging momentum.',
      howItWorks: 'CCI compares the current typical price to a moving average of typical price, scaled by mean deviation. Readings above +100 flag unusually strong up-moves; below −100 flag strong down-moves. Most action falls between ±100.',
      features: ['Unbounded momentum oscillator', '±100 extreme thresholds', 'Divergence detection', 'Works on all markets'],
      howToUse: ['Watch ±100 crosses for momentum entries', 'Use zero-line crosses for bias changes', 'Look for CCI/price divergence at extremes'],
      settings: [{ name: 'Length', detail: 'Lookback period, default 20.' }],
      signals: ['CCI crossing above +100 — strong bullish momentum', 'CCI crossing below −100 — strong bearish momentum', 'Divergence at extremes'],
      tips: ['In strong trends CCI can stay beyond ±100 — do not fade blindly', 'Best combined with structure and trend context'],
    },
    'Williams %R': {
      tagline: 'A fast overbought/oversold oscillator.',
      overview: 'Williams %R measures where the current close sits relative to the high-low range of the lookback period, on an inverted 0 to −100 scale. It is a quick read on overbought and oversold conditions and momentum shifts.',
      howItWorks: 'For the lookback window it plots how close price is to the recent high (near 0 = strong, overbought) versus the recent low (near −100 = weak, oversold). It is essentially the Stochastic’s %K on an inverted scale.',
      features: ['Fast momentum reader', '−20 / −80 extreme levels', 'Leading turn signals', 'Simple to interpret'],
      howToUse: ['Watch −20 for overbought and −80 for oversold', 'Use exits from extremes as timing cues', 'Confirm with the prevailing trend'],
      settings: [{ name: 'Length', detail: 'Lookback period, default 14.' }],
      signals: ['Rising back through −80 — potential bounce', 'Falling back through −20 — potential pullback'],
      tips: ['Very responsive — expect early and frequent signals', 'Overbought/oversold persists in strong trends'],
    },
    'Fibonacci Retracement': {
      tagline: 'Maps likely pullback and reaction zones within a move.',
      overview: 'Fibonacci Retracement overlays horizontal levels at key ratios between a swing high and low, marking where a pullback may find support or resistance before the trend resumes. It is one of the most widely watched pullback-timing tools.',
      howItWorks: 'You anchor the tool to a significant swing; it divides that range at the Fibonacci ratios (23.6%, 38.2%, 50%, 61.8%, 78.6%). Because so many traders watch these ratios, price frequently reacts around them.',
      features: ['Key 38.2 / 50 / 61.8% levels', 'Objective pullback zones', 'Extensions for targets', 'Works on any timeframe'],
      howToUse: ['Look for entries where price reacts at a Fib level', 'Treat the 61.8% "golden pocket" as a prime reaction zone', 'Use Fibonacci extensions to set profit targets'],
      settings: [{ name: 'Levels', detail: 'Which ratios to display; 61.8% is the most watched.' }, { name: 'Anchors', detail: 'The swing high and low the grid is drawn from.' }],
      signals: ['Reaction at 38.2% — shallow pullback, strong trend', 'Reaction at 61.8% — deep but valid pullback', 'Break beyond 78.6% — trend likely failing'],
      tips: ['Anchor to clear, significant swings for reliable levels', 'Confluence with support/resistance strengthens a Fib level'],
    },
    'Large Lot / Block Trade Detector': {
      tagline: 'Flags unusually large executed trades — the footprints of size.',
      overview: 'This L1 tool highlights individual executed trades that are far larger than normal, the kind of prints associated with institutional or "smart money" participation. It surfaces where big players are actually transacting, not just quoting.',
      howItWorks: 'It monitors the trade tape and compares each execution’s size to a rolling baseline of typical trade size. Prints that exceed the threshold are marked on the chart and colored by aggressor side, so outsized activity stands out immediately.',
      features: ['Real-time large-print detection', 'Buy/sell aggressor coloring', 'Adaptive size threshold', 'Institutional footprint mapping'],
      howToUse: ['Note where large prints cluster — those levels matter', 'Weigh clusters of aggressive buy prints as demand, sell prints as supply', 'Combine with structure to confirm defended levels'],
      settings: [{ name: 'Size Threshold', detail: 'How many times the baseline a trade must be to flag.' }, { name: 'Baseline Window', detail: 'Lookback that defines "normal" trade size.' }],
      signals: ['Cluster of large buy prints at support — accumulation', 'Large sell prints capping a rally — distribution'],
      tips: ['One big print is noise; clusters are signal', 'Aggressor side matters — who crossed the spread tells the story'],
    },
    'Aggressive Order Flow': {
      tagline: 'Reads whether aggressive buyers or sellers control the tape.',
      overview: 'This L1 indicator measures the balance of market (aggressor) orders to reveal which side is actively pushing price. It answers a simple but crucial question: are buyers or sellers the ones lifting offers and hitting bids right now?',
      howItWorks: 'By classifying each execution as buyer- or seller-initiated and summing the net over a window, it produces a running measure of aggression. Sustained positive flow means buyers are lifting offers; sustained negative flow means sellers are hitting bids.',
      features: ['Net aggressor-flow reading', 'Real-time buyer/seller balance', 'Momentum-of-flow view', 'Divergence detection vs. price'],
      howToUse: ['Trade with the dominant aggressor side in trends', 'Watch for flow flipping ahead of price', 'Flag divergence where price rises but buy-flow fades'],
      settings: [{ name: 'Window', detail: 'Lookback over which net aggression is summed.' }, { name: 'Smoothing', detail: 'Optional smoothing of the flow line.' }],
      signals: ['Rising buy aggression with price — healthy trend', 'Price up but aggression fading — weakening rally', 'Flow flip against the move — early reversal warning'],
      tips: ['Flow often turns before price — treat it as leading', 'Confirm with price structure before acting'],
    },
    'Smart Volume Spike Detector': {
      tagline: 'Flags abnormal volume and classifies what it means.',
      overview: 'This L1 tool detects abnormal volume bursts and, crucially, classifies each one — continuation, exhaustion, absorption, liquidation, or fake breakout — so a spike becomes actionable context rather than a raw number.',
      howItWorks: 'It compares each bar’s volume to an adaptive baseline to detect spikes, then reads the accompanying price behavior (range, close location, follow-through) to categorize the spike’s likely meaning and label it on the chart.',
      features: ['Adaptive spike detection', 'Contextual classification of spikes', 'On-chart labels', 'Separates continuation from exhaustion'],
      howToUse: ['Trust continuation spikes in the trend direction', 'Fade exhaustion and liquidation spikes at extremes', 'Treat absorption spikes as evidence of a defended level'],
      settings: [{ name: 'Sensitivity', detail: 'How large a spike must be to register.' }, { name: 'Baseline Window', detail: 'Lookback defining normal volume.' }],
      signals: ['Continuation spike — momentum likely persists', 'Exhaustion spike — move may be ending', 'Absorption spike — large passive orders holding a level'],
      tips: ['Classification is a probability, not a certainty', 'Combine with structure — an exhaustion spike at resistance is strongest'],
    },
    'Whale Movement': {
      tagline: 'Detects large institutional orders that can move markets.',
      overview: 'Whale Movement surfaces the activity of the largest participants — the "whales" whose orders are big enough to shift price. It aims to put retail traders on the same side as the size, rather than in front of it.',
      howItWorks: 'It aggregates unusually large orders and executions across the tape, tracks their aggressor side and persistence, and highlights when whale activity concentrates at a level or in a direction.',
      features: ['Whale-scale activity tracking', 'Directional bias of large players', 'Level concentration alerts', 'Real-time footprint'],
      howToUse: ['Align entries with net whale direction', 'Respect levels where whale activity concentrates', 'Be cautious taking the opposite side of persistent size'],
      settings: [{ name: 'Whale Threshold', detail: 'Minimum size to qualify as whale activity.' }, { name: 'Window', detail: 'Aggregation lookback.' }],
      signals: ['Whale buying into support — accumulation', 'Whale selling into strength — distribution'],
      tips: ['Follow persistent size, do not fight it', 'Whale prints at structure carry the most weight'],
    },
    'Limit Order Heatmap': {
      tagline: 'Visualizes resting bid/ask liquidity as a live heatmap.',
      overview: 'This L2 tool renders the order book as a color heatmap beside price, showing where large resting limit orders sit. Those pools of liquidity act as magnets, walls, and breakout fuel, and the heatmap makes them visible in real time.',
      howItWorks: 'It samples the depth of book over time and paints each price level by resting size — brighter/warmer where liquidity is thick. As orders are added or pulled, the heatmap updates, revealing walls forming and dissolving.',
      features: ['Live depth-of-book heatmap', 'Liquidity wall detection', 'Support/resistance from resting orders', 'Breakout-zone mapping'],
      howToUse: ['Expect reactions at thick liquidity walls', 'Watch walls being pulled as a sign a level will break', 'Target thin zones above/below current price'],
      settings: [{ name: 'Depth', detail: 'How far into the book to visualize.' }, { name: 'Intensity', detail: 'Color scaling for resting size.' }],
      signals: ['Price stalling at a bright wall — strong level', 'Wall pulled just before touch — likely break', 'Thin zone — fast move potential'],
      tips: ['Liquidity can be spoofed — corroborate with executed flow', 'Walls that absorb rather than pull are the real ones'],
    },
    'Iceberg Detector': {
      tagline: 'Uncovers hidden orders that refresh as they fill.',
      overview: 'Iceberg orders show only a small slice of a much larger hidden order, refreshing as each slice fills. This L2 tool detects that refreshing behavior, exposing large institutional interest that is deliberately concealed in the book.',
      howItWorks: 'It watches for a price level that keeps getting filled yet repeatedly replenishes with similar size — the signature of an iceberg. When the refresh pattern is detected, the hidden level is flagged.',
      features: ['Hidden-order detection', 'Refresh-pattern recognition', 'Reveals concealed institutional size', 'Level-defense alerts'],
      howToUse: ['Treat detected icebergs as strongly defended levels', 'Fade moves into a large buy iceberg (support)', 'Watch for the iceberg lifting as the level gives way'],
      settings: [{ name: 'Refresh Sensitivity', detail: 'How many refreshes qualify as an iceberg.' }, { name: 'Level Tolerance', detail: 'Price tolerance for grouping refills.' }],
      signals: ['Persistent refills at a level — iceberg support/resistance', 'Iceberg exhausted and pulled — level breaks'],
      tips: ['Icebergs mark where big players truly want to transact', 'When an iceberg disappears, the level often fails fast'],
    },
    'Spoofing Detector': {
      tagline: 'Flags large fake orders placed to mislead, then canceled.',
      overview: 'Spoofing is the placement of large orders with no intent to fill, meant to bait other traders before being canceled. This L2 tool detects that appear-then-vanish behavior so you are not fooled by manufactured pressure.',
      howItWorks: 'It tracks large orders that appear in the book and are canceled quickly without being filled, especially when they briefly move price. Repeated patterns at a level are flagged as probable spoofing.',
      features: ['Fake-order detection', 'Rapid place-and-cancel tracking', 'Manipulation alerts', 'Protects against false walls'],
      howToUse: ['Distrust walls that repeatedly appear and vanish', 'Avoid chasing moves driven by spoofed pressure', 'Wait for executed flow to confirm a level is real'],
      settings: [{ name: 'Cancel Window', detail: 'How fast an order must be pulled to count as spoofing.' }, { name: 'Size Threshold', detail: 'Minimum order size to monitor.' }],
      signals: ['Large order flashing then canceled — likely spoof', 'Repeated spoofing at a level — manufactured pressure'],
      tips: ['Executed volume never lies — resting size can', 'Spoofing often precedes a move the opposite way'],
    },
    'Liquidity Vacuum': {
      tagline: 'Identifies thin zones where price can move fast.',
      overview: 'A liquidity vacuum is a price region with little resting order book depth. When price enters one, it can travel quickly with little resistance. This L2 tool highlights those thin zones before price reaches them.',
      howItWorks: 'By scanning depth of book, it finds price ranges where resting liquidity is unusually sparse compared to surrounding levels, marking them as vacuum zones prone to rapid, low-friction moves.',
      features: ['Thin-liquidity zone mapping', 'Fast-move anticipation', 'Breakout target zones', 'Real-time depth scanning'],
      howToUse: ['Expect acceleration when price enters a vacuum', 'Use vacuum edges as quick targets', 'Avoid placing passive orders inside a vacuum'],
      settings: [{ name: 'Thinness Threshold', detail: 'How sparse depth must be to flag a vacuum.' }, { name: 'Depth', detail: 'How far into the book to scan.' }],
      signals: ['Price entering a vacuum — rapid move likely', 'Vacuum above/below — path of least resistance'],
      tips: ['Vacuums explain why price sometimes "gaps" without news', 'Great for setting realistic fast-move targets'],
    },
    'Liquidation Heatmap': {
      tagline: 'Maps estimated liquidation zones for leveraged traders.',
      overview: 'This L2 tool estimates where clusters of leveraged positions would be force-closed, drawing those liquidation zones on the chart. Price is often drawn to these pools, since triggering them creates cascades of forced buying or selling.',
      howItWorks: 'Using leverage tiers and recent positioning, it models where long and short liquidations would trigger and shades those price zones by estimated size. Larger pools are highlighted as stronger magnets.',
      features: ['Estimated liquidation zones', 'Long vs. short pool mapping', 'Cascade-risk highlighting', 'Magnet-level detection'],
      howToUse: ['Anticipate price hunting large liquidation pools', 'Expect sharp acceleration once a pool triggers', 'Use pools as targets and reversal areas'],
      settings: [{ name: 'Leverage Tiers', detail: 'Which leverage levels to model (e.g. 10x, 25x, 50x).' }, { name: 'Intensity', detail: 'Color scaling for pool size.' }],
      signals: ['Price approaching a large pool — magnet effect', 'Liquidation cascade — sharp, fast move', 'Reversal after a pool is swept'],
      tips: ['Liquidation zones are estimates, not certainties', 'Sweeps of a pool often mark local exhaustion'],
    },
    'Open Interest Analysis': {
      tagline: 'Shows whether new money is entering or leaving the market.',
      overview: 'Open Interest (OI) counts the total open derivative positions. This L2 tool reads OI alongside price to reveal whether a move is backed by fresh positioning or just short-covering — a key distinction for judging conviction.',
      howItWorks: 'It tracks changes in OI relative to price. Rising price with rising OI means new longs; rising price with falling OI means shorts covering. The tool classifies each combination to characterize the move’s participation.',
      features: ['Price/OI relationship classification', 'New-money vs. covering detection', 'Trend-conviction gauge', 'Squeeze-risk context'],
      howToUse: ['Trust trends where OI rises with price', 'Be cautious of rallies driven only by short-covering', 'Watch OI drops as positions unwind'],
      settings: [{ name: 'Window', detail: 'Lookback for OI change measurement.' }],
      signals: ['Price up + OI up — new longs, strong move', 'Price up + OI down — short covering, weaker', 'Price down + OI up — new shorts'],
      tips: ['OI reveals the quality behind a price move', 'Rapid OI build-up raises squeeze risk both ways'],
    },
    'Institutional Order Blocks': {
      tagline: 'Marks high-probability institutional buy/sell zones.',
      overview: 'Order blocks are the price zones where institutions likely built positions before a strong move. This L2 tool identifies them by combining order flow and liquidity, marking areas price often returns to and reacts from.',
      howItWorks: 'It locates the consolidation or last opposing candle before an impulsive move, corroborates it with order-flow and liquidity evidence, and draws the resulting zone. Revisits to these blocks are watched for reactions.',
      features: ['Auto order-block detection', 'Flow + liquidity confirmation', 'Bullish and bearish zones', 'Revisit reaction alerts'],
      howToUse: ['Look for entries when price returns to a fresh order block', 'Use block boundaries for tight risk placement', 'Favor blocks aligned with the higher-timeframe trend'],
      settings: [{ name: 'Sensitivity', detail: 'How strong the ensuing move must be to validate a block.' }, { name: 'Mitigation', detail: 'Whether to hide blocks once revisited.' }],
      signals: ['Reaction at a bullish block — demand', 'Rejection at a bearish block — supply', 'Clean break through a block — invalidation'],
      tips: ['Fresh, untested blocks tend to react best', 'Confluence with liquidity levels raises the odds'],
    },
    'Absorption Detector': {
      tagline: 'Spots aggressive orders being soaked up by passive size.',
      overview: 'Absorption occurs when heavy aggressive buying or selling fails to move price because large passive orders are absorbing it. This L2 tool detects that stall, which frequently precedes a reversal as the aggressors give up.',
      howItWorks: 'It compares aggressive order flow against the resulting price movement. When strong flow meets little price change at a level, absorption is flagged — evidence that a large passive player is defending that price.',
      features: ['Absorption detection at levels', 'Flow-vs-movement analysis', 'Reversal-warning signals', 'Defended-level mapping'],
      howToUse: ['Watch for reversals after clear absorption', 'Trade toward the absorbing side once flow flips', 'Respect the absorbed level as strong support/resistance'],
      settings: [{ name: 'Flow Threshold', detail: 'Aggressive flow needed to test for absorption.' }, { name: 'Movement Tolerance', detail: 'How little price may move to count as absorbed.' }],
      signals: ['Heavy selling, price holding — buyers absorbing', 'Heavy buying, price stalling — sellers absorbing'],
      tips: ['Absorption marks where big passive players defend price', 'Wait for flow to flip before trading the reversal'],
    },
    'Trap Detector': {
      tagline: 'Detects failed breakouts that trap traders.',
      overview: 'A trap is a breakout or breakdown that quickly fails, snapping back and leaving the traders who chased it offside. This L2 tool identifies those failures, which often fuel sharp moves as trapped positions are forced out.',
      howItWorks: 'It watches for price breaking a level and then reversing back through it without follow-through, corroborated by order-flow and liquidity behavior. The failed break is flagged as a bull or bear trap.',
      features: ['Failed-breakout detection', 'Bull and bear trap flags', 'Flow-confirmed reversals', 'Stop-run identification'],
      howToUse: ['Fade a confirmed trap back into the range', 'Target the far side where trapped traders exit', 'Avoid chasing breakouts into obvious liquidity'],
      settings: [{ name: 'Break Buffer', detail: 'How far beyond a level counts as a break.' }, { name: 'Reversal Window', detail: 'How quickly price must reverse to flag a trap.' }],
      signals: ['Break above resistance then failure — bull trap', 'Break below support then reclaim — bear trap'],
      tips: ['Traps often occur right at obvious levels where stops rest', 'The reclaim is the trade — not the initial break'],
    },
    'Exhaustion Detector': {
      tagline: 'Flags when aggressive flow stops moving price efficiently.',
      overview: 'Exhaustion is the point where continued aggressive buying or selling produces less and less price movement — the move is running out of fuel. This L2 tool detects that inefficiency, an early warning that a trend may be ending.',
      howItWorks: 'It measures how much price moves per unit of aggressive flow. When large flow yields diminishing price progress near an extreme, exhaustion is flagged as momentum decays.',
      features: ['Momentum-exhaustion detection', 'Efficiency-of-flow analysis', 'Trend-end warnings', 'Extreme-zone context'],
      howToUse: ['Tighten stops or take profit on exhaustion signals', 'Look for reversals when exhaustion meets structure', 'Avoid adding to a trend showing exhaustion'],
      settings: [{ name: 'Efficiency Threshold', detail: 'Price-per-flow level that defines exhaustion.' }, { name: 'Window', detail: 'Measurement lookback.' }],
      signals: ['Big buy flow, tiny price gain — buyer exhaustion', 'Big sell flow, tiny price drop — seller exhaustion'],
      tips: ['Exhaustion warns of a pause or reversal, not its exact timing', 'Strongest at prior highs/lows or major levels'],
    },
    'Smart Liquidity Sweep Detector': {
      tagline: 'Detects liquidity sweeps and judges reversal vs. continuation.',
      overview: 'A liquidity sweep is a quick push beyond a level to trigger resting stops before price decides its real direction. This L2 tool detects sweeps and, importantly, classifies whether the sweep is likely a reversal or a continuation.',
      howItWorks: 'It identifies price spiking through a known liquidity level and then reads the follow-through in order flow to judge intent — a sweep that reverses signals a stop-hunt, while one that continues signals genuine breakout momentum.',
      features: ['Sweep detection at liquidity levels', 'Reversal vs. continuation classification', 'Stop-hunt identification', 'Flow-confirmed intent'],
      howToUse: ['Fade sweeps flagged as reversals back through the level', 'Ride sweeps flagged as continuation in the break direction', 'Use swept levels as tight invalidation points'],
      settings: [{ name: 'Level Source', detail: 'Which liquidity levels are monitored for sweeps.' }, { name: 'Confirmation', detail: 'Flow follow-through required to classify intent.' }],
      signals: ['Sweep and reversal — stop-hunt, fade it', 'Sweep and continuation — real breakout'],
      tips: ['Not every sweep reverses — the classification is the edge', 'Sweeps cluster at obvious highs, lows, and round numbers'],
    },
    'Delta Divergence Signal': {
      tagline: 'Warns when price and aggressive flow disagree.',
      overview: 'Delta is the net of aggressive buying minus selling. This L2 tool flags when price makes a new extreme but delta does not confirm it — a divergence that warns the move is losing the flow behind it and may reverse.',
      howItWorks: 'It tracks cumulative delta against price. When price prints a higher high while delta prints a lower high (or the bearish mirror), the divergence is marked, signaling that aggressors are no longer supporting the move.',
      features: ['Price vs. delta divergence detection', 'Bullish and bearish signals', 'Early reversal warnings', 'Flow-confirmed weakness'],
      howToUse: ['Treat divergence as a heads-up to manage risk', 'Look for reversals when divergence meets a key level', 'Confirm with a price trigger before entering'],
      settings: [{ name: 'Lookback', detail: 'Window for comparing price and delta extremes.' }, { name: 'Sensitivity', detail: 'How pronounced the divergence must be.' }],
      signals: ['Price higher high, delta lower high — bearish divergence', 'Price lower low, delta higher low — bullish divergence'],
      tips: ['Divergence signals weakening momentum, not an instant reversal', 'Strongest at prior swing points and major levels'],
    },
    'Market Oracle Plus': {
      tagline: 'A ChartPrime trend and signal toolkit for clearer decisions.',
      overview: 'Market Oracle Plus is a ChartPrime all-in-one toolkit that blends trend detection, momentum, and on-chart signals into a single, clean overlay designed to help traders act with more clarity as conditions shift.',
      howItWorks: 'It fuses multiple trend and momentum models into a unified signal engine, filtering conflicting inputs and presenting concise buy/sell and trend-state cues rather than a cluttered stack of separate indicators.',
      features: ['Unified trend + signal engine', 'Adaptive to changing conditions', 'Clean on-chart cues', 'Reduces indicator clutter'],
      howToUse: ['Follow the toolkit’s trend state for directional bias', 'Use its signals as entries within that bias', 'Layer with your own structure for confirmation'],
      settings: [{ name: 'Sensitivity', detail: 'How reactive the signal engine is.' }, { name: 'Mode', detail: 'Preset profiles for different trading styles.' }],
      signals: ['Trend-state flip — directional change', 'In-trend signal — continuation entry'],
      tips: ['Best treated as a decision aid, not a black box', 'Align its bias with the higher timeframe'],
    },
    'Market Dynamics': {
      tagline: 'A ChartPrime liquidity and structure mapping toolkit.',
      overview: 'Market Dynamics is a ChartPrime toolkit that maps market structure in real time — reaction zones, breakouts, gaps, and institutional areas — giving traders a live picture of where price is likely to react.',
      howItWorks: 'It continuously analyzes structure and liquidity to draw and update zones as the market evolves, highlighting breakouts and fills and marking areas of institutional interest without manual charting.',
      features: ['Real-time structure mapping', 'Reaction and institutional zones', 'Breakout and gap detection', 'Auto-updating levels'],
      howToUse: ['Trade reactions at highlighted zones', 'Use breakout markers with retest confirmation', 'Watch institutional areas as high-probability levels'],
      settings: [{ name: 'Zone Sensitivity', detail: 'How significant structure must be to be drawn.' }, { name: 'Display', detail: 'Which zone types to show.' }],
      signals: ['Reaction at a mapped zone', 'Confirmed breakout of structure', 'Fill of a flagged gap'],
      tips: ['Confluence between zone types raises reliability', 'Keep the display uncluttered — show only what you trade'],
    },
    'Prime Oscillators Plus': {
      tagline: 'A ChartPrime momentum toolkit for building and fading moves.',
      overview: 'Prime Oscillators Plus is a ChartPrime momentum suite that shows when momentum is building, fading, or flipping, packaging several refined oscillators into a single, readable panel.',
      howItWorks: 'It combines multiple momentum measures with smoothing and divergence detection, presenting a consolidated read on momentum state so you are not juggling several separate oscillators.',
      features: ['Consolidated momentum panel', 'Build/fade/flip states', 'Built-in divergence detection', 'Configurable presets'],
      howToUse: ['Enter as momentum builds in the trend direction', 'Reduce risk as momentum fades', 'Use flips and divergences as reversal warnings'],
      settings: [{ name: 'Sensitivity', detail: 'Responsiveness of the momentum read.' }, { name: 'Divergence', detail: 'Toggle divergence detection.' }],
      signals: ['Momentum building — trend continuation', 'Momentum fading — caution', 'Momentum flip — potential reversal'],
      tips: ['Momentum is a context tool — combine with structure', 'Fading momentum warns before price turns'],
    },
    'Prime Screener': {
      tagline: 'A ChartPrime on-chart dashboard for scanning opportunities.',
      overview: 'Prime Screener is a ChartPrime on-chart dashboard that scans multiple assets at once and surfaces the ones lining up with your criteria, so opportunities can be spotted at a glance without flipping through charts.',
      howItWorks: 'It evaluates a set of assets against configurable conditions — trend, momentum, and signal states — and displays the results in a compact on-chart table that updates live as markets move.',
      features: ['Multi-asset scanning', 'On-chart dashboard table', 'Configurable criteria', 'Live updates'],
      howToUse: ['Define the conditions you care about', 'Scan the table for assets meeting them', 'Drill into flagged assets for a closer look'],
      settings: [{ name: 'Watchlist', detail: 'Which assets to scan.' }, { name: 'Criteria', detail: 'Conditions that flag an opportunity.' }],
      signals: ['Asset meeting all criteria — candidate', 'Criteria change — watchlist re-ranking'],
      tips: ['Keep criteria focused to avoid noise', 'Use it to shortlist, then confirm on the chart'],
    },
  };

  const CAT_LABELS = {
    classic: 'Classic Indicators',
    l1: 'Trade Flow Intelligence (L1)',
    l2: 'Order Book Intelligence (L2)',
    chartprime: 'ChartPrime Premium',
    chartprimefree: 'ChartPrime',
  };
  const FLAGSHIP_CATS = ['l1', 'l2'];
  /* Tabs that cover more than one category. The ChartPrime tab holds both tiers so they read as
     one family, separated by their group labels rather than by living in different tabs. */
  const CAT_TAB_GROUPS = { chartprime: ['chartprime', 'chartprimefree'] };
  /* The paid ChartPrime tier. Badged like the PRO tier but in purple, since this marks where an
     indicator comes from rather than gating it behind a plan — the gold PRO badge is the only
     mark that means "your plan doesn't include this". */
  const CHARTPRIME_PAID_CATS = ['chartprime'];
  /* Deterministic "users" count per indicator (social proof) — stable within a session. */
  function computeIndUsers(d) {
    let h = 0;
    for (let i = 0; i < d.name.length; i++) h = (h * 31 + d.name.charCodeAt(i)) >>> 0;
    const frac = (h % 1000) / 1000;
    const [lo, hi] = [100, 8000];
    return Math.round(lo + frac * (hi - lo));
  }
  IND_DATA.forEach(d => { d.users = computeIndUsers(d); });
  function fmtUsers(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  let indProUnlocked = false;

  /* A panel row no longer toggles on/off — clicking it adds a fresh instance to the chart.
     The star favorites/unfavorites without adding. */
  function buildIndRow(d, isFlagship) {
    const row = document.createElement('div');
    row.className = 'ind-row' + (isFlagship ? ' flagship' : '');
    row.dataset.name = d.name;
    const flagshipBadge = isFlagship ? '<span class="ind-pro-badge">PRO</span>' : '';
    /* Carried on the row itself so the tier stays visible in Favorites and search results,
       where the ChartPrime group labels aren't there to convey it. */
    const paidMark = CHARTPRIME_PAID_CATS.includes(d.cat)
      ? '<span class="ind-premium-badge">Premium</span>'
      : '';
    const fav = indFavorites.has(d.name);
    row.innerHTML =
      `<div class="ind-row-info"><span class="ind-row-name">${d.name}${flagshipBadge}${paidMark}</span><span class="ind-row-desc">${d.desc}</span></div>` +
      `<div class="ind-row-meta">` +
      `<span class="ind-users" title="${d.users.toLocaleString()} users"><span class="material-symbols-outlined">group</span>${fmtUsers(d.users)}</span>` +
      `<button class="ind-doc-btn" data-doc data-tooltip="Read More" aria-label="Read documentation"><span class="material-symbols-outlined">menu_book</span></button>` +
      `<button class="ind-fav-btn${fav ? ' on' : ''}" data-fav data-tooltip="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}"><span class="material-symbols-outlined">star</span></button>` +
      `</div>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-doc]')) { openIndDoc(d, isFlagship); return; }
      const favBtn = e.target.closest('[data-fav]');
      if (favBtn) {
        const isFav = indFavorites.has(d.name);
        if (isFav) indFavorites.delete(d.name); else indFavorites.add(d.name);
        favBtn.classList.toggle('on', !isFav);
        const favLabel = !isFav ? 'Remove from favorites' : 'Add to favorites';
        favBtn.setAttribute('aria-label', favLabel);
        favBtn.setAttribute('data-tooltip', favLabel);
        if (indActiveCat === 'favorites') renderIndList(getIndSearch(), indActiveCat);
        return;
      }
      if (isFlagship && !indProUnlocked) { showIndLockOverlay(); return; }
      addIndicatorInstance(d.name);
    });
    return row;
  }

  function renderIndLeftPane(query, cat) {
    indicatorList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    const showCat = cat === 'all' ? null : cat;
    let anyVisible = false;
    const groups = showCat
      ? (CAT_TAB_GROUPS[showCat] || [showCat])
      : ['classic', 'chartprime', 'chartprimefree'];
    /* A single-category tab needs no heading — the tab itself is the label. Multi-group views do. */
    const showLabels = groups.length > 1;
    groups.forEach(g => {
      const rows = IND_DATA.filter(d => {
        if (d.cat !== g) return false;
        if (q && !d.name.toLowerCase().includes(q) && !d.desc.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!rows.length) return;
      anyVisible = true;
      if (showLabels) {
        const lbl = document.createElement('div');
        lbl.className = 'ind-group-label';
        lbl.textContent = CAT_LABELS[g];
        indicatorList.appendChild(lbl);
      }
      rows.forEach(d => indicatorList.appendChild(buildIndRow(d, false)));
    });
    indEmptyIcon.textContent = 'search_off';
    indEmptyText.textContent = 'No indicators match your search';
    indEmpty.style.display = anyVisible ? 'none' : 'flex';
  }

  /* Favorites view — flat list of favorited indicators across every category (honouring search),
     shown full-width in the left pane. Flagship favorites keep their PRO badge + lock behaviour. */
  function renderIndFavoritesPane(query) {
    indicatorList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    const rows = IND_DATA.filter(d => {
      if (!indFavorites.has(d.name)) return false;
      if (q && !d.name.toLowerCase().includes(q) && !d.desc.toLowerCase().includes(q)) return false;
      return true;
    });
    rows.forEach(d => indicatorList.appendChild(buildIndRow(d, FLAGSHIP_CATS.includes(d.cat))));
    const noFavYet = !q && !rows.length;
    indEmptyIcon.textContent = noFavYet ? 'star' : 'search_off';
    indEmptyText.textContent = noFavYet ? 'No favorite indicators yet' : 'No favorites match your search';
    indEmpty.style.display = rows.length ? 'none' : 'flex';
  }

  function renderIndRightPane(query, cats) {
    indPremiumList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    let anyVisible = false;
    cats.forEach(g => {
      const rows = IND_DATA.filter(d => {
        if (d.cat !== g) return false;
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
    indPremiumEmptyIcon.textContent = 'search_off';
    indPremiumEmptyText.textContent = 'No indicators match your search';
    indPremiumEmpty.style.display = anyVisible ? 'none' : 'flex';
  }

  const indPanes = document.querySelector('.ind-panes');
  function renderIndList(query, cat) {
    hideIndLockOverlay();
    /* Favorites is a left-only view spanning all categories. */
    if (cat === 'favorites') {
      indPanes.classList.add('show-left-only');
      indPanes.classList.remove('show-right-only');
      renderIndFavoritesPane(query);
      return;
    }
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

  let indActiveCat = 'all';
  function getIndSearch() { return indicatorSearch.value; }

  indicatorsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (indicatorsMenu.classList.contains('show') && indicatorsMenu._openTrigger === indicatorsTrigger) {
      closeAllPopovers(); return;
    }
    indicatorsMenu.classList.remove('doc-mode'); // always open on the list, never mid-doc
    renderIndList(getIndSearch(), indActiveCat);
    openCentered(indicatorsMenu, indicatorsTrigger);
    indicatorSearch.focus();
  });
  makeFloatPanelDraggable(indicatorsMenu);

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

  /* ---------- indicator documentation ("Read More") in-panel doc view ---------- */
  const indDoc = document.getElementById('indDoc');
  const indDocTitle = document.getElementById('indDocTitle');
  const indDocBadge = document.getElementById('indDocBadge');
  const indDocBody = document.getElementById('indDocBody');
  const indDocAdd = document.getElementById('indDocAdd');
  const indDocFav = document.getElementById('indDocFav');
  const indDocFavLabel = document.getElementById('indDocFavLabel');
  let indDocTarget = null; // { d, isFlagship } currently shown

  /* Reflects the current indicator's favorite state onto the doc-view star. */
  function syncIndDocFav() {
    if (!indDocTarget) return;
    const fav = indFavorites.has(indDocTarget.d.name);
    const label = fav ? 'Remove from favorites' : 'Add to favorites';
    indDocFav.classList.toggle('on', fav);
    indDocFav.setAttribute('aria-label', label);
    indDocFavLabel.textContent = label;
  }

  /* Builds the doc body from an IND_DOCS entry, emitting only the sections that exist so the
     content adapts per indicator. Falls back to the row's short description when no doc exists. */
  function renderIndDoc(d) {
    const doc = IND_DOCS[d.name];
    if (!doc) return `<p class="ind-doc-p">${escapeHtml(d.desc)}</p>`;
    let html = '';
    const section = (title, inner) => `<div class="ind-doc-section"><h4 class="ind-doc-h">${title}</h4>${inner}</div>`;
    const para = (title, text) => text ? section(title, `<p class="ind-doc-p">${escapeHtml(text)}</p>`) : '';
    const list = (title, items) => (items && items.length)
      ? section(title, `<ul class="ind-doc-list">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`) : '';
    html += para('Overview', doc.overview);
    html += para('How it works', doc.howItWorks);
    html += list('Key features', doc.features);
    html += list('How to use it effectively', doc.howToUse);
    html += list('Signals to watch', doc.signals);
    html += list('Tips', doc.tips);
    return html;
  }

  function openIndDoc(d, isFlagship) {
    indDocTarget = { d, isFlagship };
    indDocTitle.textContent = d.name;
    indDocBadge.style.display = isFlagship ? 'inline-flex' : 'none';
    indDocBody.innerHTML = renderIndDoc(d);
    indDocBody.scrollTop = 0;
    syncIndDocFav();
    indicatorsMenu.classList.add('doc-mode');
  }

  function closeIndDoc() {
    indicatorsMenu.classList.remove('doc-mode');
    indDocTarget = null;
    /* Favorites view is a filtered list, so re-render it in case the doc-view star changed things. */
    if (indActiveCat === 'favorites') renderIndList(getIndSearch(), indActiveCat);
  }

  document.getElementById('indDocBack').addEventListener('click', (e) => {
    e.stopPropagation();
    closeIndDoc();
  });
  indDocAdd.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!indDocTarget) return;
    const { d, isFlagship } = indDocTarget;
    if (isFlagship && !indProUnlocked) { closeIndDoc(); showIndLockOverlay(); return; }
    addIndicatorInstance(d.name);
  });
  indDocFav.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!indDocTarget) return;
    const name = indDocTarget.d.name;
    const nowFav = !indFavorites.has(name);
    if (nowFav) indFavorites.add(name); else indFavorites.delete(name);
    syncIndDocFav();
    /* Keep the underlying panel row's star in sync so it's already updated on return. */
    const label = nowFav ? 'Remove from favorites' : 'Add to favorites';
    document.querySelectorAll(`.ind-row[data-name="${CSS.escape(name)}"] .ind-fav-btn`).forEach(btn => {
      btn.classList.toggle('on', nowFav);
      btn.setAttribute('aria-label', label);
      btn.setAttribute('data-tooltip', label);
    });
  });
  /* Escape backs out of the doc view first (rather than closing the whole panel). */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && indicatorsMenu.classList.contains('doc-mode')) {
      e.stopPropagation();
      closeIndDoc();
    }
  }, true);

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
      // Switching to Stop Limit seeds a valid breakout/breakdown off the market so the order is never
      // born in the degenerate "stop already crossed" state: the STOP goes just past the current
      // price and the LIMIT (entry line) just past the STOP. Buy → market < stop < limit; sell →
      // limit < stop < market. This repositions the entry line (the cost of guaranteeing validity);
      // the user drags both to real levels from there.
      if (order.orderType === 'Stop Limit' && !order.filled) {
        const dir = order.side === 'buy' ? 1 : -1;
        const mkt = qtCurrentPrice();
        order.triggerPrice = roundTick(mkt + dir * 2);
        setOrderEntryPrice(roundTick(mkt + dir * 4));
        order.fillAbove = order.triggerPrice > mkt;
        order.stopTriggered = false;
        if (slTrailActive()) applyTrailingStopPreview();
        else if (slAtrActive()) placeAtrStop();
      }
      // Switching to Market snaps the entry to the live price at once (rather than waiting for the
      // next chart tick to move it), mirroring the per-tick market-entry sync in the price loop.
      if (order.orderType === 'Market' && !order.filled) {
        setOrderEntryPrice(qtCurrentPrice());
        if (slTrailActive()) applyTrailingStopPreview();
        else if (slAtrActive()) placeAtrStop();
      }
      closeAllPopovers();
      render();
    });
  });

  /* ---------- Stop Limit price-edit popup (opened by clicking a STOP/LIMIT chart label) ---------- */
  const olPriceEditMenu = document.getElementById('olPriceEditMenu');
  const olPriceEditInput = document.getElementById('olPriceEditInput');
  const olPriceEditLabel = document.getElementById('olPriceEditLabel');
  let olPriceEditTarget = null; // 'entry' (limit/fill) | 'trigger'
  function olPriceEditCurrent() {
    return olPriceEditTarget === 'trigger' ? order.triggerPrice : order.entry;
  }
  function applyOlPriceEdit(price) {
    const p = roundTick(price);
    if (!order || isNaN(p)) return;
    if (olPriceEditTarget === 'trigger') {
      order.triggerPrice = p;
      if (!order.filled) order.fillAbove = order.triggerPrice > qtCurrentPrice(); // re-arm from the new side
    } else {
      setOrderEntryPrice(p);
    }
    render();
    olPriceEditInput.value = fmt(olPriceEditCurrent());
  }
  function openOlPriceEdit(target, anchorRect, trigger) {
    if (!order) return;
    olPriceEditTarget = target;
    olPriceEditLabel.textContent = target === 'trigger' ? 'Stop Price' : 'Limit Price';
    olPriceEditInput.value = fmt(olPriceEditCurrent());
    openNear(olPriceEditMenu, anchorRect, 'left', trigger);
    olPriceEditInput.focus();
    olPriceEditInput.select();
  }
  olPriceEditInput.addEventListener('click', (e) => e.stopPropagation());
  olPriceEditInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat((e.target.value || '').replace(/,/g, ''));
    if (!isNaN(v)) applyOlPriceEdit(v);
  });
  olPriceEditInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.target.blur(); closeAllPopovers(); }
  });
  olPriceEditMenu.querySelectorAll('.ps-up, .ps-down').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!order) return;
      applyOlPriceEdit(olPriceEditCurrent() + (btn.classList.contains('ps-up') ? 0.25 : -0.25));
    });
  });

  /* ---------- Trailing-TP settings popover (offset only) ---------- */
  const tpTrailMenu = document.getElementById('tpTrailMenu');
  const tpTrailRow = document.getElementById('tpTrailRow');
  const tpOffsetUnitToggle = document.getElementById('tpOffsetUnitToggle');
  const tpOffsetInput = document.getElementById('tpOffsetValue');
  let activeTrailTpId = null;
  function activeTrailTp() { return order && order.tps.find(t => t.id === activeTrailTpId); }
  /* toggle trailing on/off for a specific TP (mirrors the SL re-select-to-disable flow) */
  function selectTpTrail(id) {
    const tp = order && order.tps.find(t => t.id === id);
    if (!tp) return;
    tp.trailing = !tp.trailing;
    tp.activated = false;
    tp.exitPrice = null;
    tp.autoTrailing = false;
    if (tp.trailing) ensureTpTrailOffset(tp);
    else if (activeTrailTpId === id) closeAllPopovers();
    render();
  }
  /* reflect the active TP's offset in the popover fields */
  function populateTpTrailMenu() {
    const tp = activeTrailTp();
    if (!tp) return;
    const cfg = ensureTpTrailOffset(tp);
    tpOffsetInput.value = (+cfg.offsetValue).toFixed(tpOffsetParams(cfg.offsetUnit).dp);
    tpOffsetUnitToggle.querySelectorAll('.cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === cfg.offsetUnit));
    // The popover only opens while trailing is active, so the mode row always reads as selected
    // (mirrors the SL gear menu's checkmark pattern); clicking it again disables trailing.
    tpTrailRow.classList.toggle('selected', !!tp.trailing);
  }
  tpTrailRow.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeTrailTpId) selectTpTrail(activeTrailTpId);
  });
  /* keep the popover's Offset input in lock-step with the Offset line while it's dragged */
  function syncTpTrailMenuValue(id) {
    if (activeTrailTpId !== id || !tpTrailMenu.classList.contains('show')) return;
    const tp = activeTrailTp();
    if (tp) tpOffsetInput.value = (+tp.trailOffset.offsetValue).toFixed(tpOffsetParams(tp.trailOffset.offsetUnit).dp);
  }
  function openTpTrailMenu(id, anchorRect, trigger) {
    if (trigger && tpTrailMenu.classList.contains('show') && tpTrailMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    activeTrailTpId = id;
    populateTpTrailMenu();
    openNear(tpTrailMenu, anchorRect, 'right', trigger);
  }
  /* switching unit re-expresses the current offset so the line doesn't jump */
  tpOffsetUnitToggle.querySelectorAll('.cs-radio-row').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tp = activeTrailTp();
      if (!tp) return;
      const cfg = ensureTpTrailOffset(tp);
      if (btn.dataset.unit === cfg.offsetUnit) return;
      const distPts = tpOffsetDist(tp); // current offset in price points, before the unit change
      cfg.offsetUnit = btn.dataset.unit;
      const params = tpOffsetParams(cfg.offsetUnit);
      const v = tpGapToOffset(distPts, tp.price, cfg.offsetUnit);
      cfg.offsetValue = Math.max(params.min, Math.min(params.max, +v.toFixed(params.dp)));
      populateTpTrailMenu();
      refreshTpBadgeOnChart(tp.id);
      render();
    });
  });
  /* Offset value stepper — writes to the active TP's trailOffset, keeping line + badge synced */
  {
    const inc = document.getElementById('tpOffsetInc');
    const dec = document.getElementById('tpOffsetDec');
    function params() { const tp = activeTrailTp(); return tpOffsetParams(tp ? tp.trailOffset.offsetUnit : 'percent'); }
    /* Arrow clicks snap to the step grid; manual typing only clamps to min/max */
    function clampStep(v) { const p = params(); v = Math.round(v / p.step) * p.step; v = p.dp ? +v.toFixed(p.dp) : Math.round(v); return Math.min(p.max, Math.max(p.min, v)); }
    function clampManual(v) { const p = params(); v = Math.min(p.max, Math.max(p.min, v)); return +v.toFixed(p.dp); }
    function commit() { const tp = activeTrailTp(); if (!tp) return; tp.trailOffset.offsetValue = parseFloat(tpOffsetInput.value) || params().min; refreshTpBadgeOnChart(tp.id); render(); }
    tpOffsetInput.removeAttribute('readonly');
    tpOffsetInput.addEventListener('click', (e) => e.stopPropagation());
    tpOffsetInput.addEventListener('change', (e) => { e.stopPropagation(); tpOffsetInput.value = clampManual(parseFloat(tpOffsetInput.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); tpOffsetInput.value = clampStep((parseFloat(tpOffsetInput.value) || 0) - params().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); tpOffsetInput.value = clampStep((parseFloat(tpOffsetInput.value) || 0) + params().step); commit(); });
  }

  /* ---------- SL gear menu (special-behavior settings) ---------- */
  const slGearMenu = document.getElementById('slGearMenu');
  const slTrailRow = document.getElementById('slTrailRow');
  const slAtrRow = document.getElementById('slAtrRow');
  const slBeToggle = document.getElementById('slBeToggle');
  const slBeSub = document.getElementById('slBeSub');
  const slBeSubDefaultText = slBeSub.textContent;
  const slBeSubLockedText = 'Needs at least 1 take profit';
  const slDistanceUnitToggle = document.getElementById('slDistanceUnitToggle');
  const slStartToggle = document.getElementById('slStartToggle');
  const slBeOvTriggerToggle = document.getElementById('slBeOvTriggerToggle');
  const slBeOvOffsetUnitToggle = document.getElementById('slBeOvOffsetUnitToggle');
  const slBeOvOffsetValue = document.getElementById('slBeOvOffsetValue');
  /* show only the value field the selected breakeven trigger needs (Custom R / % to TP1) */
  function syncBeOvTriggerFields(trigger) {
    document.getElementById('slBeOvCustomRWrap').style.display = trigger === 'customR' ? '' : 'none';
    document.getElementById('slBeOvPctWrap').style.display = trigger === 'pct' ? '' : 'none';
  }
  /* Dynamic Fee Offset: only relevant for the 'Fee Amount' unit. While on, it auto-fills the round-trip
     fee offset (0.12%) and locks the offset input; switching units or toggling off makes it editable again. */
  const BE_DYNAMIC_FEE_VALUE = BE_ROUND_TRIP_FEE_PCT;
  function syncBeOvDynamicFee() {
    const ov = order && order.sl && order.sl.beOverride;
    if (!ov) return;
    const row = document.getElementById('slBeOvDynamicFee');
    const isFee = ov.offsetUnit === 'fee';
    row.style.display = isFee ? '' : 'none';
    row.classList.toggle('active', !!ov.dynamicFee);
    const locked = isFee && !!ov.dynamicFee;
    if (locked) {
      ov.offsetValue = BE_DYNAMIC_FEE_VALUE;
      slBeOvOffsetValue.value = BE_DYNAMIC_FEE_VALUE;
    }
    slBeOvOffsetValue.disabled = locked;
    document.getElementById('slBeOvOffsetInc').disabled = locked;
    document.getElementById('slBeOvOffsetDec').disabled = locked;
  }
  /* keep the gear-menu % field in step with a ghost-line drag (only if the menu is open) */
  function syncBePctField() {
    const el = document.getElementById('slBeOvPctValue');
    const ov = order && order.sl && order.sl.beOverride;
    if (el && ov) el.value = Math.round(ov.pctToTp);
  }
  /* keep the gear-menu Custom R field in step with a ghost-line drag (only if the menu is open) */
  function syncBeCustomRField() {
    const el = document.getElementById('slBeOvCustomRValue');
    const ov = order && order.sl && order.sl.beOverride;
    if (el && ov) el.value = (+ov.customR).toFixed(1);
  }
  /* resolves which TP arms breakeven, using the global default set in Chart Settings > Trade Management */
  function resolveBreakevenTpId() {
    if (!order || !order.tps.length) return null;
    const cfg = getEffectiveBeConfig();
    if (isPriceBasedBeTrigger(cfg.trigger)) return null; // price-based ('% to TP1' / 'Custom R') — armed by applyBreakeven, not a TP hit
    if (cfg.trigger === 'tp1') return order.tps[0].id;
    if (cfg.trigger === 'tp2') return (order.tps[1] || order.tps[order.tps.length - 1]).id;
    if (cfg.trigger === 'tp3') return (order.tps[2] || order.tps[order.tps.length - 1]).id;
    return order.tps[0].id;
  }
  /* every SL gets its own editable breakeven settings, seeded from the global default */
  function ensureBeOverride() {
    if (!order || !order.sl) return null;
    if (!order.sl.beOverride) {
      const base = chartSettings.moveSlToBreakeven;
      order.sl.beOverride = { trigger: base.trigger, customR: base.customR, pctToTp: base.pctToTp, offsetValue: base.offsetValue, offsetUnit: base.offsetUnit, dynamicFee: base.dynamicFee !== false };
    }
    return order.sl.beOverride;
  }
  /* reflect the SL's settings in the gear-menu fields */
  function populateSlSettings() {
    const cfg = ensureSlConfig();
    if (!cfg) return;
    document.getElementById('slDistanceValue').value = (+cfg.distanceValue).toFixed(slDistanceParams(cfg.distanceUnit).dp);
    slDistanceUnitToggle.querySelectorAll('.cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === cfg.distanceUnit));
    const maxTp = trailStartMaxTp();
    slStartToggle.querySelectorAll('.cs-radio-row').forEach(b => {
      const m = /^tp(\d)$/.exec(b.dataset.unit);
      b.classList.toggle('disabled', !!m && +m[1] > maxTp);
      b.classList.toggle('active', b.dataset.unit === cfg.start);
    });
    document.getElementById('slAtrMultiplier').value = slAtrMult().toFixed(2);
    const be = ensureBeOverride();
    slBeOvTriggerToggle.querySelectorAll('.cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === be.trigger));
    slBeOvOffsetUnitToggle.querySelectorAll('.cs-radio-row').forEach(b => b.classList.toggle('active', b.dataset.unit === be.offsetUnit));
    slBeOvOffsetValue.value = be.offsetValue;
    document.getElementById('slBeOvCustomRValue').value = (+be.customR).toFixed(1);
    document.getElementById('slBeOvPctValue').value = Math.round(be.pctToTp);
    syncBeOvTriggerFields(be.trigger);
    syncBeOvDynamicFee();
    refreshAllCsDropdownLabels(slGearMenu);
  }
  function renderSlGearMenu() {
    if (!order || !order.sl) return;
    const noTps = order.tps.length < 1; // breakeven needs at least 1 TP set
    if (noTps && order.sl.mode === 'breakeven' && !order.sl.beActive) order.sl.beTpId = null;
    const mode = order.sl.mode, on = order.sl.enabled;
    slTrailRow.classList.toggle('selected', on && mode === 'trailing');
    slAtrRow.classList.toggle('selected', on && mode === 'atr');
    slBeToggle.classList.toggle('selected', on && mode === 'breakeven');
    slBeToggle.classList.toggle('disabled', noTps);
    slBeSub.textContent = noTps ? slBeSubLockedText : slBeSubDefaultText;
    // a section's settings only expand once that behavior is actually enabled
    document.getElementById('slTrailSettings').style.display = (on && mode === 'trailing') ? '' : 'none';
    document.getElementById('slAtrSettings').style.display = (on && mode === 'atr') ? '' : 'none';
    document.getElementById('slBeSettings').style.display = (on && mode === 'breakeven') ? '' : 'none';
    reconcileTrailStart();
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
      cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(slDistanceParams(cfg.distanceUnit).dp);
    } else if (order.sl.mode === 'atr') {
      placeAtrStop();
    } else if (order.sl.mode === 'breakeven') {
      order.sl.beActive = false;
      const ov = ensureBeOverride();
      // Dynamic default: with a single TP, a TP-hit trigger is pointless (the TP closes the trade),
      // so fall back to the price-based '% to TP1'. A price-based trigger the user already picked
      // ('% to TP1' or 'Custom R Multiple') is kept as-is.
      if (ov && order.tps.length < 2 && !isPriceBasedBeTrigger(ov.trigger)) ov.trigger = 'pct';
      order.sl.beTpId = (ov && isPriceBasedBeTrigger(ov.trigger)) ? null : resolveBreakevenTpId();
    }
  }
  /* set the SL to a specific behavior ('fixed' = disabled/plain stop, otherwise enables that mode and places it) */
  function applySlCycleMode(mode) {
    if (mode === 'fixed') {
      order.sl.enabled = false;
      order.sl.autoTrailing = false;
      order.sl.beActive = false; order.sl.beTpId = null;
      return;
    }
    order.sl.mode = mode;
    order.sl.enabled = true;
    order.sl.autoTrailing = false; // the automation hasn't moved it yet under this newly-selected mode
    if (mode !== 'breakeven') { order.sl.beActive = false; order.sl.beTpId = null; }
    applySlModePlacement();
  }
  /* select a special behavior (mutually exclusive); clicking the active one again turns it off → plain Fixed SL */
  function selectSlMode(mode) {
    if (!order || !order.sl) return;
    if (order.sl.enabled && order.sl.mode === mode) {
      applySlCycleMode('fixed');
      renderSlGearMenu(); render();
      return;
    }
    if (mode === 'breakeven' && order.tps.length < 1) { showToast('Breakeven needs at least 1 take profit', 'info'); return; }
    applySlCycleMode(mode);
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
  slDistanceUnitToggle.querySelectorAll('.cs-radio-row').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cfg = ensureSlConfig();
      if (!cfg || btn.dataset.unit === cfg.distanceUnit) return;
      cfg.distanceUnit = btn.dataset.unit;
      cfg.distanceValue = +slGapDistance(cfg.distanceUnit).toFixed(slDistanceParams(cfg.distanceUnit).dp);
      populateSlSettings();
      refreshSlBadgeOnChart();
    });
  });
  /* Start-trailing trigger */
  slStartToggle.querySelectorAll('.cs-radio-row').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.classList.contains('disabled')) return;
      const cfg = ensureSlConfig();
      if (!cfg || btn.dataset.unit === cfg.start) return;
      cfg.start = btn.dataset.unit;
      populateSlSettings();
    });
  });
  /* Breakeven trigger — radio group. Re-resolves the armed TP and toggles the on-chart ghost line. */
  slBeOvTriggerToggle.querySelectorAll('.cs-radio-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const ov = ensureBeOverride();
      if (!ov || row.dataset.unit === ov.trigger) return;
      ov.trigger = row.dataset.unit;
      if (slBeActiveMode() && !order.sl.beActive) order.sl.beTpId = isPriceBasedBeTrigger(ov.trigger) ? null : resolveBreakevenTpId();
      renderSlGearMenu();
      render(); // reflect the ghost line + badge on the chart
    });
  });
  /* Breakeven offset unit — radio group */
  slBeOvOffsetUnitToggle.querySelectorAll('.cs-radio-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const ov = ensureBeOverride();
      if (!ov || row.dataset.unit === ov.offsetUnit) return;
      ov.offsetUnit = row.dataset.unit;
      populateSlSettings();
    });
  });
  /* Dynamic Fee Offset toggle — locks the offset to the exact fee amount while on */
  document.getElementById('slBeOvDynamicFee').querySelector('.ui-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const ov = ensureBeOverride();
    if (!ov) return;
    ov.dynamicFee = !ov.dynamicFee;
    populateSlSettings();
  });
  /* Trailing distance value stepper (%, ticks, or ATR multiples) */
  {
    const input = document.getElementById('slDistanceValue');
    const inc = document.getElementById('slDistanceInc');
    const dec = document.getElementById('slDistanceDec');
    function params() {
      const cfg = ensureSlConfig();
      return slDistanceParams(cfg && cfg.distanceUnit);
    }
    /* Arrow clicks snap to the step grid; manual typing only clamps to min/max and allows up to 2 decimals */
    function clampStep(v) { const p = params(); v = Math.round(v / p.step) * p.step; v = p.dp ? +v.toFixed(p.dp) : Math.round(v); return Math.min(p.max, Math.max(p.min, v)); }
    function clampManual(v) { const p = params(); v = Math.min(p.max, Math.max(p.min, v)); return +v.toFixed(p.dp ? 2 : 0); }
    function commit() { const cfg = ensureSlConfig(); if (cfg) cfg.distanceValue = parseFloat(input.value) || 0; repositionSlFromConfig(); render(); }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampManual(parseFloat(input.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampStep((parseFloat(input.value) || 0) - params().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampStep((parseFloat(input.value) || 0) + params().step); commit(); });
  }
  /* ATR multiplier stepper */
  {
    const input = document.getElementById('slAtrMultiplier');
    const inc = document.getElementById('slAtrMultiplierInc');
    const dec = document.getElementById('slAtrMultiplierDec');
    function clampVal(v) { return Math.min(20, Math.max(0.01, +parseFloat(v).toFixed(2))); }
    function commit() {
      if (!order || !order.sl) return;
      order.sl.atrMult = parseFloat(input.value) || 2;
      /* Re-place the stop whether or not the order is filled, so the line stays in sync with the
         multiplier (and its badge). placeAtrStop() anchors to order.entry, which is valid post-fill,
         and calls syncQtyFromRisk() — matching the manual SL-drag path. */
      if (slAtrActive()) placeAtrStop();
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
    function params() {
      const ov = ensureBeOverride();
      return beOffsetParams(ov ? ov.offsetUnit : 'fee');
    }
    /* Arrow clicks snap to the step grid; manual typing only clamps to min/max and allows up to 2 decimals */
    function clampStep(v) { const p = params(); v = Math.round(v / p.step) * p.step; v = Number.isInteger(p.step) ? Math.round(v) : +v.toFixed(2); return Math.min(p.max, Math.max(p.min, v)); }
    function clampManual(v) { const p = params(); v = Math.min(p.max, Math.max(p.min, v)); return +v.toFixed(Number.isInteger(p.step) ? 0 : 2); }
    function commit() { const ov = ensureBeOverride(); if (ov) ov.offsetValue = parseFloat(input.value) || 0; }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampManual(parseFloat(input.value) || 0); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampStep((parseFloat(input.value) || 0) - params().step); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampStep((parseFloat(input.value) || 0) + params().step); commit(); });
  }
  /* Breakeven Custom R Multiple stepper */
  {
    const input = document.getElementById('slBeOvCustomRValue');
    const inc = document.getElementById('slBeOvCustomRInc');
    const dec = document.getElementById('slBeOvCustomRDec');
    function clampVal(v) { return Math.min(20, Math.max(0.1, +parseFloat(v).toFixed(1))); }
    function commit() {
      const ov = ensureBeOverride();
      if (ov) ov.customR = parseFloat(input.value) || 1;
      if (slBeActiveMode() && !order.sl.beActive) render(); // reposition the on-chart trigger line
    }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(input.value || '1'); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 1) - 0.1); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 1) + 0.1); commit(); });
  }
  /* Breakeven % to TP1 stepper — mirrors the draggable ghost trigger line */
  {
    const input = document.getElementById('slBeOvPctValue');
    const inc = document.getElementById('slBeOvPctInc');
    const dec = document.getElementById('slBeOvPctDec');
    function clampVal(v) { return Math.min(99, Math.max(1, Math.round(parseFloat(v)))); }
    function commit() { const ov = ensureBeOverride(); if (ov) ov.pctToTp = parseFloat(input.value) || 50; render(); }
    input.removeAttribute('readonly');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => { e.stopPropagation(); input.value = clampVal(input.value || '50'); commit(); });
    dec.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 50) - 5); commit(); });
    inc.addEventListener('click', (e) => { e.stopPropagation(); input.value = clampVal((parseFloat(input.value) || 50) + 5); commit(); });
  }

  /* ---------- size & mode dropdown ---------- */
  const sizeMenu = document.getElementById('sizeMenu');
  const smTabs = document.getElementById('smTabs');
  /* The Entry Amount menu is a staged editor: edits mutate this draft snapshot, not the live
     order, so the chart is untouched until the user clicks Apply. Cancel (or any dismiss)
     discards it. Mirrors the Edit Exit Amount popup's exitModal pattern. */
  let sizeDraft = null;
  /* Draft copy of syncQtyFromRisk() — derives the staged qty from the draft's risk amount and the
     live entry / stop-loss on the chart (those aren't edited here). Resolves the stop the same way
     syncQtyFromRisk does, so an add-on sizes off its direction's owner rather than reading as unsized. */
  function syncDraftQtyFromRisk() {
    const stop = sizingStopFor(order);
    if (!sizeDraft || !isRiskMode(sizeDraft.sizeMode) || !stop) return;
    const riskPerContract = Math.abs(order.entry - stop.price) * POINT_VALUE;
    const riskDollars = effectiveRiskDollars(sizeDraft.sizeValues, sizeDraft.sizeMode);
    if (riskPerContract > 0) { sizeDraft.qty = Math.max(0, Math.floor(riskDollars / riskPerContract * 100) / 100); }
  }
  function openSizeMenu(anchorRect, trigger) {
    if (trigger && sizeMenu.classList.contains('show') && sizeMenu._openTrigger === trigger) {
      closeAllPopovers();
      return;
    }
    sizeDraft = { sizeMode: order.sizeMode, qty: order.qty, sizeValues: { ...order.sizeValues } };
    smTabs.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === sizeDraft.sizeMode));
    sizeMenu.querySelectorAll('.sm-body').forEach(b => b.classList.toggle('active', b.dataset.mode === sizeDraft.sizeMode));
    refreshSizeBodies();
    openNear(sizeMenu, anchorRect, 'left', trigger);
    // The pre-open refresh runs while the slider is hidden (offsetWidth 0); reposition the bubble now that it's laid out.
    requestAnimationFrame(smUpdatePctSlider);
  }
  smTabs.querySelectorAll('.sm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      sizeDraft.sizeMode = tab.dataset.mode;
      smTabs.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t === tab));
      sizeMenu.querySelectorAll('.sm-body').forEach(b => b.classList.toggle('active', b.dataset.mode === tab.dataset.mode));
      if (isRiskMode(tab.dataset.mode)) syncDraftQtyFromRisk();
      refreshSizeBodies();
    });
  });

  // contracts mode
  const smQtyInput = document.getElementById('smQtyInput');
  document.getElementById('smQtyDec').addEventListener('click', () => { sizeDraft.qty = Math.max(1, sizeDraft.qty - 1); smQtyInput.value = sizeDraft.qty; });
  document.getElementById('smQtyInc').addEventListener('click', () => { sizeDraft.qty = sizeDraft.qty + 1; smQtyInput.value = sizeDraft.qty; });
  smQtyInput.addEventListener('click', (e) => e.stopPropagation());
  smQtyInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat((e.target.value || '').replace(/[^0-9.]/g, ''));
    sizeDraft.qty = Math.max(0.01, +(v || 0).toFixed(2));
    smQtyInput.value = sizeDraft.qty;
  });
  document.getElementById('smQtyQuick').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { sizeDraft.qty = parseInt(b.textContent); smQtyInput.value = sizeDraft.qty; });
  });

  // dollar mode
  const smDolInput = document.getElementById('smDolInput');
  function setDollar(v) { sizeDraft.sizeValues.dollar = Math.max(500, +(Number(v) || 0).toFixed(2)); refreshSizeBodies(); }
  document.getElementById('smDolDec').addEventListener('click', () => setDollar(sizeDraft.sizeValues.dollar - 500));
  document.getElementById('smDolInc').addEventListener('click', () => setDollar(sizeDraft.sizeValues.dollar + 500));
  smDolInput.addEventListener('click', (e) => e.stopPropagation());
  smDolInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat((e.target.value || '').replace(/[$,]/g, '')) || 500;
    setDollar(v);
  });

  // percent mode — a custom-entry stepper and a Quick-Trade-styled slider share one percent value
  const smPctInput = document.getElementById('smPctInput');
  const smPctSlider = document.getElementById('smPctSlider');
  const smPctSliderWrap = document.getElementById('smPctSliderWrap');
  const smPctSliderBubble = document.getElementById('smPctSliderBubble');
  function setPercent(v) { sizeDraft.sizeValues.percent = Math.max(0, Math.min(100, +(Number(v) || 0).toFixed(2))); refreshSizeBodies(); }
  smPctSlider.addEventListener('input', () => setPercent(parseInt(smPctSlider.value, 10)));
  document.getElementById('smPctInc').addEventListener('click', () => setPercent(sizeDraft.sizeValues.percent + 1));
  document.getElementById('smPctDec').addEventListener('click', () => setPercent(sizeDraft.sizeValues.percent - 1));
  smPctInput.addEventListener('click', (e) => e.stopPropagation());
  smPctInput.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat((e.target.value || '').replace(/[^0-9.]/g, ''));
    setPercent(v || 0);
  });
  // Keep the bubble visible while dragging, even if the pointer leaves the track (matches qtSlider).
  smPctSlider.addEventListener('pointerdown', () => smPctSliderWrap.classList.add('dragging'));
  window.addEventListener('pointerup', () => smPctSliderWrap.classList.remove('dragging'));

  // Fill the slider track up to the thumb and position the percentage bubble over it,
  // mirroring the Quick Trade panel slider (qtSliderFill / qtUpdateSliderBubble).
  function smUpdatePctSlider() {
    const pct = sizeDraft ? sizeDraft.sizeValues.percent : 0;
    smPctSlider.style.background = 'linear-gradient(to right, var(--text-secondary) 0%, var(--text-secondary) ' + pct + '%, var(--border-default) ' + pct + '%, var(--border-default) 100%)';
    smPctSliderBubble.textContent = pct + '%';
    const thumbWidth = 16;
    const usable = smPctSlider.offsetWidth - thumbWidth;
    smPctSliderBubble.style.left = (thumbWidth / 2 + usable * pct / 100) + 'px';
  }

  function refreshSizeBodies() {
    if (!sizeDraft) return;
    smQtyInput.value = sizeDraft.qty;
    // dollar
    smDolInput.value = '$' + fmt(sizeDraft.sizeValues.dollar, Number.isInteger(sizeDraft.sizeValues.dollar) ? 0 : 2);
    const dolQty = unitsForSizeValue('dollar', sizeDraft.sizeValues);
    const dolMargin = +(dolQty * MARGIN_PER_CONTRACT).toFixed(2);
    document.getElementById('smDolQty').textContent = fmt(dolQty, 2) + ' ETH';
    document.getElementById('smDolMargin').textContent = fmtMoney(dolMargin);
    document.getElementById('smDolBp').textContent = fmtMoney(BUYING_POWER - dolMargin);

    // percent
    smPctInput.value = sizeDraft.sizeValues.percent + '%';
    smPctSlider.value = sizeDraft.sizeValues.percent;
    smUpdatePctSlider();
    const posVal = ACCOUNT_BALANCE * sizeDraft.sizeValues.percent / 100;
    const pctQty = unitsForSizeValue('percent', sizeDraft.sizeValues);
    const pctMargin = +(pctQty * MARGIN_PER_CONTRACT).toFixed(2);
    document.getElementById('smPctBal').textContent = fmtMoney(ACCOUNT_BALANCE);
    document.getElementById('smPctPos').textContent = fmtMoney(posVal);
    document.getElementById('smPctQty').textContent = fmt(pctQty, 2) + ' ETH';
    document.getElementById('smPctMargin').textContent = fmtMoney(pctMargin);

    // risk / risk % — both rebuilt each time; renderRiskBody handles the $ vs % input and the shared stats.
    renderRiskBody(document.getElementById('smRiskBody'), 'risk');
    renderRiskBody(document.getElementById('smRiskPctBody'), 'risk_pct');
  }

  /* Renders one of the two Risk bodies (Risk $ or Risk %). Both size the position identically from the
     stop-loss distance and a dollar risk budget; they differ only in the input control and how the budget
     is expressed. Element ids are prefixed per mode so both bodies can coexist in the DOM. */
  function renderRiskBody(body, mode) {
    if (!body) return;
    // The sizing stop isn't always this order's own: an add-on has none and sizes against the stop on
    // its direction's owner, so ask for that one rather than reading as unsized whenever it's set there.
    const stop = sizingStopFor(order);
    if (!stop) {
      const stopOwner = sizingStopOwnerLabel();
      body.innerHTML =
        '<div class="sm-state-banner warn"><span class="material-symbols-outlined">hourglass_empty</span>Waiting for Stop Loss</div>' +
        '<div class="sm-empty"><span class="material-symbols-outlined">south</span><br>' +
        (stopOwner
          ? 'Add a stop loss to ' + stopOwner + '<br>to calculate position size.'
          : 'Drag the stop loss line on the chart<br>to calculate position size.') +
        '</div>';
      return;
    }
    const isPct = mode === 'risk_pct';
    const p = isPct ? 'smRiskPct' : 'smRisk';
    const stopDist = Math.abs(order.entry - stop.price);
    const riskPerContract = stopDist * POINT_VALUE;
    const riskDollars = effectiveRiskDollars(sizeDraft.sizeValues, mode);

    const pctVal = sizeDraft.sizeValues.riskPct || 0;
    // Shared markup for the stacked-arrow price stepper; the buttons keep their per-mode ids so the existing handlers bind.
    const riskStepper = (value) =>
      '<div class="price-stepper">' +
      '<input type="text" id="' + p + 'Input" value="' + value + '">' +
      '<div class="price-stepper-arrows">' +
      '<button type="button" id="' + p + 'Inc"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>' +
      '<button type="button" id="' + p + 'Dec"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>' +
      '</div>' +
      '</div>';
    const inputBlock = isPct
      ? '<label class="sm-amount-lbl">Risk (% of Account)</label>' +
      riskStepper((Number.isInteger(pctVal) ? pctVal : pctVal.toFixed(2)) + '%') +
      '<div class="sm-stat-row"><span class="l">Risk Amount</span><span class="v">' + fmtMoney(riskDollars) + '</span></div>'
      : '<label class="sm-amount-lbl">Risk Amount (USD)</label>' +
      riskStepper('$' + fmt(sizeDraft.sizeValues.risk, Number.isInteger(sizeDraft.sizeValues.risk) ? 0 : 2));

    body.innerHTML =
      inputBlock +
      '<div class="sm-stat-row"><span class="l">Stop Distance</span><span class="v">' + fmt(stopDist, 2) + ' pts</span></div>' +
      '<div class="sm-stat-row"><span class="l">Risk per Unit</span><span class="v">' + fmtMoney(riskPerContract) + '</span></div>' +
      '<div id="' + p + 'CalcSlot"></div>';

    const calcQty = riskPerContract > 0 ? Math.floor(riskDollars / riskPerContract * 100) / 100 : 0;
    const marginReq = calcQty * MARGIN_PER_CONTRACT;
    const sufficient = marginReq <= BUYING_POWER;
    const slot = body.querySelector('#' + p + 'CalcSlot');
    if (calcQty === 0) {
      // Stop-loss too far (or risk amount too small): quantity floors to 0, no position possible.
      slot.innerHTML =
        '<div class="sm-state-banner warn"><span class="material-symbols-outlined">error</span>Stop-loss exceeds risk limit</div>' +
        '<div class="sm-note warn">Move the stop-loss closer or increase your risk amount to open a position.</div>';
    } else if (sufficient) {
      slot.innerHTML =
        '<div class="sm-stat-row"><span class="l">Calculated Units</span><span class="v">' + calcQty.toFixed(2) + ' ETH</span></div>' +
        '<div class="sm-stat-row"><span class="l">Margin Required</span><span class="v">' + fmtMoney(marginReq) + '</span></div>' +
        '<div class="sm-stat-row"><span class="l">Buying Power Available</span><span class="v up">' + fmtMoney(BUYING_POWER - marginReq) + '</span></div>' +
        '<div class="sm-state-banner ok"><span class="material-symbols-outlined">check_circle</span>Sufficient Buying Power</div>' +
        '<div class="sm-note">Position size auto-adjusts when the stop loss is moved.</div>';
    } else {
      const maxQty = Math.floor(BUYING_POWER / MARGIN_PER_CONTRACT);
      const actualRisk = maxQty * riskPerContract;
      slot.innerHTML =
        '<div class="sm-stat-row"><span class="l">Calculated Units</span><span class="v">' + calcQty.toFixed(2) + ' ETH</span></div>' +
        '<div class="sm-stat-row"><span class="l">Max Available Units</span><span class="v">' + maxQty.toFixed(2) + ' ETH</span></div>' +
        '<div class="sm-stat-row"><span class="l">Actual Risk</span><span class="v">' + fmtMoney(actualRisk) + '</span></div>' +
        '<div class="sm-state-banner bad"><span class="material-symbols-outlined">error</span>Insufficient Buying Power</div>' +
        '<div class="sm-options">' +
        '<span class="sm-options-lbl">Options</span>' +
        '<button class="sm-opt-btn primary" id="' + p + 'UseMax">Use Maximum Available (' + maxQty + ' ETH)</button>' +
        '<button class="sm-opt-btn ghost" id="' + p + 'ReduceRisk">Reduce Risk Amount</button>' +
        '</div>';
    }

    // Set the risk budget from a dollar figure, translating back to a % when in Risk % mode.
    const setBudgetDollars = (dollars) => {
      if (isPct) sizeDraft.sizeValues.riskPct = ACCOUNT_BALANCE > 0 ? Math.max(0, +(dollars / ACCOUNT_BALANCE * 100).toFixed(2)) : 0;
      else sizeDraft.sizeValues.risk = Math.max(0, dollars);
    };
    const stepBudget = (dir) => {
      if (isPct) sizeDraft.sizeValues.riskPct = Math.max(0, +((pctVal + dir * 0.25).toFixed(2)));
      else sizeDraft.sizeValues.risk = Math.max(0, sizeDraft.sizeValues.risk + dir * 50);
    };

    body.querySelector('#' + p + 'Dec').addEventListener('click', (e) => { e.stopPropagation(); stepBudget(-1); syncDraftQtyFromRisk(); refreshSizeBodies(); });
    body.querySelector('#' + p + 'Inc').addEventListener('click', (e) => { e.stopPropagation(); stepBudget(1); syncDraftQtyFromRisk(); refreshSizeBodies(); });
    const inp = body.querySelector('#' + p + 'Input');
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target.value || '').replace(/[$,%\s]/g, '')) || 0;
      if (isPct) sizeDraft.sizeValues.riskPct = Math.max(0, val);
      else sizeDraft.sizeValues.risk = Math.max(0, val);
      syncDraftQtyFromRisk();
      refreshSizeBodies();
    });
    const useMax = body.querySelector('#' + p + 'UseMax');
    if (useMax) useMax.addEventListener('click', (e) => {
      e.stopPropagation();
      const mq = Math.floor(BUYING_POWER / MARGIN_PER_CONTRACT);
      setBudgetDollars(Math.round(mq * riskPerContract));
      syncDraftQtyFromRisk(); refreshSizeBodies();
      showToast('Risk set to maximum available size', 'check_circle');
    });
    const reduceRisk = body.querySelector('#' + p + 'ReduceRisk');
    if (reduceRisk) reduceRisk.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPct) sizeDraft.sizeValues.riskPct = Math.max(0.25, +((pctVal / 2).toFixed(2)));
      else sizeDraft.sizeValues.risk = Math.max(250, Math.round(sizeDraft.sizeValues.risk / 2 / 250) * 250);
      syncDraftQtyFromRisk(); refreshSizeBodies();
    });
  }

  // Apply — commit the staged draft to the live order, then redraw the chart.
  document.getElementById('smApply').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sizeDraft) return;
    order.sizeMode = sizeDraft.sizeMode;
    order.qty = sizeDraft.qty;
    order.sizeValues = { ...sizeDraft.sizeValues };
    // USD / % Account modes carry their intent in sizeValues; re-derive the unit count from it so
    // fees/PnL/fill use the amount just entered (Risk modes are handled by syncQtyFromRisk below).
    const derivedQty = unitsForSizeValue(order.sizeMode, order.sizeValues);
    if (derivedQty !== null) order.qty = derivedQty;
    syncQtyFromRisk(); // keeps parity with the live SL-drag behavior in Risk $ mode
    closeAllPopovers();
    sizeDraft = null;
    render();
    showToast('Entry amount updated', 'check_circle');
  });
  // Cancel — discard the draft without touching the order (no render needed).
  document.getElementById('smCancel').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopovers();
    sizeDraft = null;
  });

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
  window.refreshTodayJournalCard(); // sync the Trading Journal with the seeded trade history on load

})();
