/* ================================================================
   LIVE MARKET DATA SIMULATION — watchlist & positions
   ================================================================ */
(function () {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(99821);
  function noise() { let s = 0; for (let i = 0; i < 3; i++) s += rand(); return (s - 1.5); }
  function fmt(n, dec) {
    dec = dec === undefined ? 2 : dec;
    const neg = n < 0; n = Math.abs(n);
    const parts = n.toFixed(dec).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function setUpDown(el, isUp) { el.classList.remove('up', 'down'); el.classList.add(isUp ? 'up' : 'down'); }
  function flashEl(el, isUp) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(isUp ? 'flash-up' : 'flash-down'); }
  function roundStep(p, step) { return Math.round(p / step) * step; }

  /* watchlist symbols (ETH is driven separately, alongside the chart) */
  const watchSyms = [
    { sym: 'NQU5', last: 18624.50, chgPct: 0.52, step: 0.25, dec: 2 },
    { sym: 'YMU5', last: 39865.00, chgPct: 0.27, step: 1, dec: 2 },
    { sym: 'RTYU5', last: 2078.40, chgPct: -0.12, step: 0.10, dec: 2 },
    { sym: 'CLN5', last: 78.24, chgPct: -0.45, step: 0.01, dec: 2 },
    { sym: 'GCQ5', last: 2346.20, chgPct: 0.18, step: 0.10, dec: 2 },
    { sym: '6EU5', last: 1.0843, chgPct: -0.21, step: 0.0001, dec: 4 },
    { sym: 'BTCUSD', last: 63245.0, chgPct: 1.18, step: 0.5, dec: 1 },
    { sym: 'SOLUSD', last: 142.30, chgPct: 3.10, step: 0.05, dec: 2 },
    { sym: 'XRPUSD', last: 0.5210, chgPct: 1.40, step: 0.0005, dec: 4 },
    { sym: 'BNBUSD', last: 589.40, chgPct: 0.85, step: 0.05, dec: 2 },
    { sym: 'DOGEUSD', last: 0.1620, chgPct: 2.30, step: 0.0005, dec: 4 },
    { sym: 'AAPL', last: 187.42, chgPct: 0.55, step: 0.05, dec: 2 },
    { sym: 'TSLA', last: 248.50, chgPct: -1.20, step: 0.10, dec: 2 },
    { sym: 'NVDA', last: 924.10, chgPct: 2.05, step: 0.20, dec: 2 },
    { sym: 'MSFT', last: 415.30, chgPct: 0.33, step: 0.05, dec: 2 },
    { sym: 'AMZN', last: 186.20, chgPct: 0.95, step: 0.05, dec: 2 },
    { sym: 'GOOGL', last: 175.80, chgPct: -0.40, step: 0.05, dec: 2 },
    { sym: 'EURUSD', last: 1.0843, chgPct: -0.12, step: 0.0001, dec: 4 },
    { sym: 'GBPUSD', last: 1.2674, chgPct: -0.08, step: 0.0001, dec: 4 },
    { sym: 'USDJPY', last: 149.82, chgPct: 0.21, step: 0.01, dec: 2 },
    { sym: 'AUDUSD', last: 0.6512, chgPct: -0.15, step: 0.0001, dec: 4 },
    { sym: 'USDCAD', last: 1.3625, chgPct: 0.05, step: 0.0001, dec: 4 },
    { sym: 'NZDUSD', last: 0.6022, chgPct: -0.30, step: 0.0001, dec: 4 },
  ];
  watchSyms.forEach(s => {
    s.prevClose = s.last / (1 + s.chgPct / 100);
    s.anchor = s.last;
    s.elLast = document.getElementById('wlLast-' + s.sym);
    s.elChg = document.getElementById('wlChg-' + s.sym);
  });

  /* positions — each carries its own mark price noise so they're independent
     of watchlist symbols and continue to animate correctly as positions close */
  function makePosition(sym, qty, avgPrice, mark0, pnlOpen0, pct0, step, dec) {
    const pv = Math.abs(mark0 - avgPrice) > 1e-9
      ? pnlOpen0 / ((mark0 - avgPrice) * qty)
      : 1;
    const unitBase = pct0 !== 0 ? pnlOpen0 / pct0 : 1;
    return {
      sym, qty, avgPrice,
      mark: mark0, mark0, anchor: mark0, step: step || 0.01, dec: dec || 2,
      pv, pnlOpen0, unitBase,
      elQty: document.getElementById('posQty-' + sym),
      elAvg: document.getElementById('posAvg-' + sym),
      elMark: document.getElementById('posMark-' + sym),
      elPnlOpen: document.getElementById('posPnlOpen-' + sym),
      elPct: document.getElementById('posPct-' + sym),
    };
  }

  const positions = [
    //                sym        qty       avgPrice   mark0      pnlOpen0  pct0   step    dec
    makePosition('NQU5', 8, 29748.00, 29704.75, -692.00, -0.15, 0.25, 2),
    makePosition('ESU5', 5, 6015.25, 6028.00, -63.75, -0.21, 0.25, 2),
    makePosition('SOLUSD', 3084.19, 0.2136, 0.2195, -83.55, -8.35, 0.0001, 4),
    makePosition('BTCUSD', 0.125, 66245.10, 67121.50, 109.55, 1.32, 0.5, 2),
    makePosition('ETHUSD', 2.0, 3125.40, 3210.75, 170.70, 2.73, 0.05, 2),
    makePosition('AAPL', 100, 185.27, 188.45, 318.00, 1.72, 0.05, 2),
  ];

  const totPnlOpenEl = document.getElementById('totPnlOpen');
  const totPctEl = document.getElementById('totPct');

  function fmtQty(q) {
    let s = q.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' || s === '-' ? '0' : s;
  }

  /* ---------- position actions: partial/full close & reverse ---------- */
  window.closePositionPct = function (sym, pct) {
    const p = positions.find(x => x.sym === sym);
    if (!p) return false;
    if (pct >= 100) {
      positions.splice(positions.indexOf(p), 1);
      const row = document.querySelector('.pos-row[data-pos-id="' + sym + '"]');
      if (row) row.remove();
      return true;
    }
    const remainFrac = 1 - pct / 100;
    p.qty *= remainFrac;
    p.pnlOpen0 *= remainFrac;
    p.unitBase *= remainFrac;
    if (p.elQty) p.elQty.textContent = fmtQty(p.qty);
    return true;
  };

  /* close a custom amount (Market tab custom-amount field); returns 'closed' | 'reduced' | false */
  window.closePositionAmount = function (sym, amount) {
    const p = positions.find(x => x.sym === sym);
    if (!p || !(amount > 0)) return false;
    if (amount >= p.qty - 1e-9) {
      positions.splice(positions.indexOf(p), 1);
      const row = document.querySelector('.pos-row[data-pos-id="' + sym + '"]');
      if (row) row.remove();
      return 'closed';
    }
    const remainFrac = 1 - amount / p.qty;
    p.qty *= remainFrac;
    p.pnlOpen0 *= remainFrac;
    p.unitBase *= remainFrac;
    if (p.elQty) p.elQty.textContent = fmtQty(p.qty);
    return 'reduced';
  };

  /* Reverse a position exactly like the chart entry bar's Reverse control: market-close the
     current side, then instantly open a fresh position of the same size in the opposite
     direction at the current mark price. Returns the new side/price so callers can toast it. */
  window.reversePosition = function (sym) {
    const p = positions.find(x => x.sym === sym);
    if (!p) return false;
    p.pv = -p.pv;
    p.avgPrice = p.mark;
    p.mark0 = p.mark;
    p.anchor = p.mark;
    p.pnlOpen0 = 0;
    if (p.elAvg) p.elAvg.textContent = fmt(p.avgPrice, p.dec);
    const newSide = p.pv > 0 ? 'buy' : 'sell';
    const badge = document.querySelector('.pos-row[data-pos-id="' + sym + '"] .pos-side-badge');
    if (badge) {
      badge.classList.remove('long', 'short');
      badge.classList.add(newSide === 'buy' ? 'long' : 'short');
      badge.textContent = newSide === 'buy' ? 'Long' : 'Short';
    }
    return { newSide, price: p.avgPrice, dec: p.dec };
  };

  /* ---------- graduate a filled chart order into a Positions-tab row ---------- */
  function quickCloseRowHtml() {
    return '<div class="pos-quick-btn-row">' +
      '<button class="pos-quick-btn pos-quick-reverse" data-pos-reverse>Reverse</button>' +
      '<button class="pos-quick-btn pos-quick-close" data-pos-close-pct="100">Close</button></div>';
  }
  /* Market/Limit close controls for a dynamically-created (chart/quick-trade) position row */
  function detailCloseHtml(sym, qtyStr, unit, priceStr, amtStep, pxStep) {
    function stepper(id, value, step, fieldUnit) {
      return '<div class="price-stepper">' +
        '<input type="text" id="' + id + '" value="' + value + '" data-step="' + step + '">' +
        '<span class="qty-unit">' + fieldUnit + '</span>' +
        '<div class="price-stepper-arrows">' +
        '<button type="button" class="ps-up" data-target="' + id + '"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>' +
        '<button type="button" class="ps-down" data-target="' + id + '"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>' +
        '</div></div>';
    }
    const initLbl = '100% · ' + qtyStr + ' ' + unit;
    function amtRow(lblId, lblText, sliderId) {
      return '<div class="pos-close-amount-row">' +
        '<span class="pos-close-field-label">Amount</span>' +
        '<span class="pos-close-pct-label" id="' + lblId + '">' + lblText + '</span></div>' +
        '<input type="range" class="pos-close-slider" id="' + sliderId + '" min="0" max="100" step="1" value="100">';
    }
    return '<div class="pos-detail-label">Close Position</div>' +
      '<div class="pos-close-tabs">' +
      '<button class="pos-close-tab active" data-close-tab="market">Market</button>' +
      '<button class="pos-close-tab" data-close-tab="limit">Limit</button></div>' +
      '<div class="pos-close-pane active" data-close-pane="market">' +
      amtRow('posClosePctLbl-' + sym, initLbl, 'posCloseSlider-' + sym) +
      '<button class="pos-close-primary" data-pos-close-market>Close Position</button></div>' +
      '<div class="pos-close-pane" data-close-pane="limit">' +
      amtRow('posClosePctLblLimit-' + sym, initLbl, 'posCloseSliderLimit-' + sym) +
      '<div class="pos-close-field-label">Limit price</div>' +
      stepper('posCloseLimitPx-' + sym, priceStr, pxStep, 'USD') +
      '<button class="pos-close-primary" data-pos-close-limit>Place Close Limit</button></div>';
  }
  /* leverage currently chosen in the Quick Trade panel — stamped onto positions opened from a fill */
  function currentLeverage() {
    const el = document.getElementById('qtLeverageInput');
    return Math.max(1, parseInt(el && el.value, 10) || 1);
  }
  function createPositionRow(sym, side, qty, price, dec) {
    const row = document.createElement('div');
    row.className = 'pos-row';
    row.dataset.posId = sym;
    const sideCls = side === 'buy' ? 'long' : 'short';
    const sideLabel = side === 'buy' ? 'Long' : 'Short';
    row.innerHTML =
      '<div class="pos-row-summary">' +
      '<div class="pos-col pos-col-symbol">' +
      '<div class="pos-sym-icon pos-icon-crypto">' + sym.slice(0, 2) + '</div>' +
      '<div class="pos-sym-info"><div class="pos-sym-top">' +
      '<span class="pos-sym-ticker">' + sym + '</span>' +
      '<span class="pos-side-badge ' + sideCls + '">' + sideLabel + '</span>' +
      '<span class="pos-type-badge">Crypto</span>' +
      '<span class="pos-lev-badge">' + currentLeverage() + '×</span></div>' +
      '<span class="pos-sym-sub">' + sym + ' (from chart)</span></div></div>' +
      '<div class="pos-col pos-col-size"><span class="pos-size-qty" id="posQty-' + sym + '">' + fmtQty(qty) + '</span><span class="pos-size-unit">Units</span></div>' +
      '<div class="pos-col pos-col-price"><span class="pos-entry" id="posAvg-' + sym + '">' + fmt(price, dec) + '</span><span class="pos-mark" id="posMark-' + sym + '">' + fmt(price, dec) + '</span></div>' +
      '<div class="pos-col pos-col-pnl"><span class="pos-pnl-dollar up" id="posPnlOpen-' + sym + '">+0.00</span><span class="pos-pnl-pct up" id="posPct-' + sym + '">+0.00%</span></div>' +
      '<div class="pos-col pos-col-margin"><span class="pos-margin faint" id="posMargin-' + sym + '">—</span></div>' +
      '<div class="pos-col pos-col-liq"><span class="pos-liq faint">—</span></div>' +
      '<div class="pos-col pos-col-quickclose">' + quickCloseRowHtml() + '</div>' +
      '<div class="pos-col pos-col-actions"><button class="pos-expand-btn" title="Expand details"><span class="material-symbols-outlined pos-chevron">expand_more</span></button></div>' +
      '</div>' +
      '<div class="pos-row-detail"><div class="pos-detail-close">' +
      detailCloseHtml(sym, fmtQty(qty), 'Units', fmt(price, dec), '0.001',
        price < 1 ? '0.0001' : price < 100 ? '0.01' : '0.5') +
      '</div></div>';
    row.querySelector('.pos-row-summary').addEventListener('click', (e) => {
      if (e.target.closest('.pos-col-quickclose') || e.target.closest('.pos-sym-ticker')) return;
      row.classList.toggle('is-expanded');
    });
    document.querySelector('.pos-rows-scroll').prepend(row);
    row.querySelectorAll('.pos-close-slider').forEach(s => {
      if (window.decoratePosCloseSlider) window.decoratePosCloseSlider(s);
      if (window.posCloseSliderFill) window.posCloseSliderFill(s);
      if (window.updatePosCloseLabel) window.updatePosCloseLabel(s);
    });
  }
  window.upsertPositionFromFill = function (sym, side, qty, price) {
    const dir = side === 'buy' ? 1 : -1;
    const existing = positions.find(x => x.sym === sym);
    if (existing) {
      const newQty = existing.qty + qty;
      existing.avgPrice = (existing.avgPrice * existing.qty + price * qty) / newQty;
      existing.qty = newQty;
      existing.mark0 = existing.mark;
      existing.pnlOpen0 = (existing.mark - existing.avgPrice) * newQty * dir;
      existing.unitBase = (newQty * price) / 100;
      existing.pv = dir;
      if (existing.elQty) existing.elQty.textContent = fmtQty(existing.qty);
      if (existing.elAvg) existing.elAvg.textContent = fmt(existing.avgPrice, existing.dec);
      return;
    }
    const dec = price < 1 ? 4 : 2;
    const step = price < 1 ? 0.0001 : price < 100 ? 0.01 : 0.5;
    createPositionRow(sym, side, qty, price, dec);
    const pos = makePosition(sym, qty, price, price, 0, 0, step, dec);
    pos.pv = dir;
    pos.unitBase = (qty * price) / 100;
    positions.push(pos);
  };

  function tick() {
    /* watchlist */
    watchSyms.forEach(s => {
      const prevLast = s.last;
      const reversion = (s.anchor - s.last) * 0.05;
      let next = roundStep(s.last + noise() * s.step * 0.9 + reversion, s.step);
      if (next === s.last) next = roundStep(s.last + (rand() < 0.5 ? -s.step : s.step), s.step);
      s.last = Math.max(next, s.step);
      const isUp = s.last > prevLast;
      const chg = (s.last - s.prevClose) / s.prevClose * 100;
      const chgUp = chg >= 0;
      if (s.elLast) s.elLast.textContent = fmt(s.last, s.dec);
      if (s.elChg) { s.elChg.textContent = (chgUp ? '+' : '') + fmt(chg) + '%'; setUpDown(s.elChg, chgUp); }
      if (s.elLast) flashEl(s.elLast, isUp);
    });

    /* positions — self-contained noise per position */
    let sumPnlOpen = 0, sumBase = 0;
    positions.forEach(p => {
      try {
        const reversion = (p.anchor - p.mark) * 0.04;
        let next = roundStep(p.mark + noise() * p.step * 0.6 + reversion, p.step);
        if (next === p.mark) next = roundStep(p.mark + (rand() < 0.5 ? -p.step : p.step), p.step);
        p.mark = Math.max(next, p.step);

        const deltaMark = p.mark - p.mark0;
        const deltaPnl = deltaMark * p.qty * p.pv;
        const pnlOpen = p.pnlOpen0 + deltaPnl;
        const pct = p.unitBase !== 0 ? pnlOpen / p.unitBase : 0;

        if (p.elMark) p.elMark.textContent = fmt(p.mark, p.dec);
        if (p.elPnlOpen) {
          p.elPnlOpen.textContent = (pnlOpen >= 0 ? '+' : '') + fmt(pnlOpen);
          setUpDown(p.elPnlOpen, pnlOpen >= 0);
        }
        if (p.elPct) {
          p.elPct.textContent = (pct >= 0 ? '+' : '') + fmt(pct) + '%';
          setUpDown(p.elPct, pct >= 0);
        }

        sumPnlOpen += pnlOpen;
        sumBase += p.unitBase;
      } catch (_) { /* guard against stale element refs mid-tick */ }
    });

    /* totals bar */
    const totPct = sumBase !== 0 ? sumPnlOpen / sumBase : 0;
    if (totPnlOpenEl) {
      totPnlOpenEl.textContent = (sumPnlOpen >= 0 ? '+' : '') + fmt(sumPnlOpen);
      setUpDown(totPnlOpenEl, sumPnlOpen >= 0);
    }
    if (totPctEl) {
      totPctEl.textContent = (totPct >= 0 ? '+' : '') + fmt(totPct) + '%';
      setUpDown(totPctEl, totPct >= 0);
    }
  }
  setInterval(tick, 1200);
})();
