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

  /* positions: derive per-position sensitivity from the figures already on screen,
     so the simulation continues smoothly from the values shown at page load */
  function makePosition(sym, qty, avgPrice, mark0, pnlOpen0, pnlDay0, pct0) {
    const pv = pnlOpen0 / ((mark0 - avgPrice) * qty); // implied $ per point for this mock position
    const unitBase = pct0 !== 0 ? pnlOpen0 / pct0 : 1; // $ per 1% move, scales with position size
    return {
      sym, qty, avgPrice, mark: mark0, pv, pnlOpen0, pnlDay0, unitBase, mark0,
      elQty: document.getElementById('posQty-' + sym),
      elAvg: document.getElementById('posAvg-' + sym),
      elMark: document.getElementById('posMark-' + sym),
      elPnlOpen: document.getElementById('posPnlOpen-' + sym),
      elPnlDay: document.getElementById('posPnlDay-' + sym),
      elPct: document.getElementById('posPct-' + sym),
    };
  }
  const positions = [
    makePosition('ETHUSD', 2, 4486.50, 4500.25, 2750.00, 1950.00, 0.74),
    makePosition('NQU5', 1, 18480.00, 18624.50, 1445.00, 980.00, 0.78),
  ];
  const totPnlOpenEl = document.getElementById('totPnlOpen');
  const totPnlDayEl = document.getElementById('totPnlDay');
  const totPctEl = document.getElementById('totPct');

  function fmtQty(q) {
    let s = q.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' || s === '-' ? '0' : s;
  }

  /* ---------- position row quick actions: partial/full close & reverse ---------- */
  window.closePositionPct = function (sym, pct) {
    const p = positions.find(x => x.sym === sym);
    if (!p) return false;
    if (pct >= 100) {
      positions.splice(positions.indexOf(p), 1);
      const row = document.querySelector('[data-pos-row="' + sym + '"]');
      if (row) row.remove();
      return true;
    }
    const remainFrac = 1 - pct / 100;
    p.qty *= remainFrac;
    p.pnlOpen0 *= remainFrac;
    p.pnlDay0 *= remainFrac;
    p.unitBase *= remainFrac;
    if (p.elQty) p.elQty.textContent = fmtQty(p.qty);
    return true;
  };

  window.reversePosition = function (sym) {
    const p = positions.find(x => x.sym === sym);
    if (!p) return false;
    p.pv = -p.pv;
    p.avgPrice = p.mark;
    p.mark0 = p.mark;
    p.pnlDay0 += p.pnlOpen0;
    p.pnlOpen0 = 0;
    if (p.elAvg) p.elAvg.textContent = fmt(p.avgPrice);
    return true;
  };

  function tick() {
    watchSyms.forEach(s => {
      const prevLast = s.last;
      const reversion = (s.anchor - s.last) * 0.05;
      let next = roundStep(s.last + noise() * s.step * 0.9 + reversion, s.step);
      if (next === s.last) next = roundStep(s.last + (rand() < 0.5 ? -s.step : s.step), s.step);
      s.last = Math.max(next, s.step);
      const isUp = s.last > prevLast;
      const chg = (s.last - s.prevClose) / s.prevClose * 100;
      const chgUp = chg >= 0;
      s.elLast.textContent = fmt(s.last, s.dec);
      s.elChg.textContent = (chgUp ? '+' : '') + fmt(chg) + '%';
      setUpDown(s.elChg, chgUp);
      flashEl(s.elLast, isUp);
    });

    // ETH position mark price mirrors the header/chart simulation already on screen
    const esLast = parseFloat(document.getElementById('hdrLast').textContent.replace(/,/g, ''));
    const nq = watchSyms.find(s => s.sym === 'NQU5');
    const markBySym = { ETHUSD: esLast, NQU5: nq.last };

    let sumPnlOpen = 0, sumPnlDay = 0, sumBase = 0;
    positions.forEach(p => {
      p.mark = markBySym[p.sym];
      const deltaMark = p.mark - p.mark0;
      const deltaPnl = deltaMark * p.qty * p.pv;
      const pnlOpen = p.pnlOpen0 + deltaPnl;
      const pnlDay = p.pnlDay0 + deltaPnl;
      const pct = p.unitBase !== 0 ? pnlOpen / p.unitBase : 0;
      p.elMark.textContent = fmt(p.mark);
      p.elPnlOpen.textContent = (pnlOpen >= 0 ? '+' : '') + fmt(pnlOpen);
      p.elPnlDay.textContent = (pnlDay >= 0 ? '+' : '') + fmt(pnlDay);
      p.elPct.textContent = (pct >= 0 ? '+' : '') + fmt(pct) + '%';
      setUpDown(p.elPnlOpen, pnlOpen >= 0);
      setUpDown(p.elPnlDay, pnlDay >= 0);
      setUpDown(p.elPct, pct >= 0);
      sumPnlOpen += pnlOpen; sumPnlDay += pnlDay; sumBase += p.unitBase;
    });
    const totPct = sumBase !== 0 ? sumPnlOpen / sumBase : 0;
    totPnlOpenEl.textContent = (sumPnlOpen >= 0 ? '+' : '') + fmt(sumPnlOpen);
    totPnlDayEl.textContent = (sumPnlDay >= 0 ? '+' : '') + fmt(sumPnlDay);
    totPctEl.textContent = (totPct >= 0 ? '+' : '') + fmt(totPct) + '%';
    setUpDown(totPnlOpenEl, sumPnlOpen >= 0);
    setUpDown(totPnlDayEl, sumPnlDay >= 0);
    setUpDown(totPctEl, totPct >= 0);
  }
  setInterval(tick, 1200);
})();
