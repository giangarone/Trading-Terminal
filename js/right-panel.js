/* ================================================================
   LIVE MARKET DATA SIMULATION — watchlist & positions
   ================================================================ */
(function () {
  // mulberry32, fmt, setUpDown, flashEl are shared globals from js/utils.js
  const rand = mulberry32(99821);
  function noise() { let s = 0; for (let i = 0; i < 3; i++) s += rand(); return (s - 1.5); }
  function roundStep(p, step) { return Math.round(p / step) * step; }
  function fmtVol(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function symHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }
  /* deterministic base volume per symbol (~200K … 40M) so rows differ but stay stable */
  function baseVolFor(sym) { return 200000 + (symHash(sym) % 40000000); }

  /* display names for the whole add-symbol universe (+ the futures shown in the
     static watchlist). Falls back to the ticker for anything unlisted. */
  const SYMBOL_NAMES = {
    ETHUSD: 'Ethereum', BTCUSD: 'Bitcoin', SOLUSD: 'Solana', XRPUSD: 'XRP', BNBUSD: 'BNB',
    DOGEUSD: 'Dogecoin', ADAUSD: 'Cardano', AVAXUSD: 'Avalanche', LINKUSD: 'Chainlink',
    MATICUSD: 'Polygon', LTCUSD: 'Litecoin', DOTUSD: 'Polkadot', TRXUSD: 'TRON',
    ATOMUSD: 'Cosmos', NEARUSD: 'NEAR Protocol', UNIUSD: 'Uniswap', FILUSD: 'Filecoin',
    APTUSD: 'Aptos', ARBUSD: 'Arbitrum', OPUSD: 'Optimism', SUIUSD: 'Sui',
    ICPUSD: 'Internet Computer', ETCUSD: 'Ethereum Classic',
    AAPL: 'Apple Inc.', TSLA: 'Tesla, Inc.', NVDA: 'NVIDIA Corp.', MSFT: 'Microsoft Corp.',
    AMZN: 'Amazon.com, Inc.', GOOGL: 'Alphabet Inc.', META: 'Meta Platforms, Inc.',
    NFLX: 'Netflix, Inc.', AMD: 'Advanced Micro Devices', JPM: 'JPMorgan Chase',
    BAC: 'Bank of America', DIS: 'Walt Disney Co.', KO: 'Coca-Cola Co.', PEP: 'PepsiCo, Inc.',
    WMT: 'Walmart Inc.', V: 'Visa Inc.', MA: 'Mastercard Inc.', XOM: 'Exxon Mobil Corp.',
    CVX: 'Chevron Corp.', INTC: 'Intel Corp.', ORCL: 'Oracle Corp.', CRM: 'Salesforce, Inc.',
    ADBE: 'Adobe Inc.',
    NQU5: 'E-mini Nasdaq-100', ESU5: 'E-mini S&P 500', YMU5: 'E-mini Dow',
    RTYU5: 'E-mini Russell 2000', CLN5: 'Crude Oil', GCQ5: 'Gold', SIN5: 'Silver',
    ZBU5: 'U.S. Treasury Bond', ZNU5: '10-Year T-Note', ZCU5: 'Corn', HGU5: 'Copper',
    NGU5: 'Natural Gas', PLU5: 'Platinum', KCU5: 'Coffee', ZSU5: 'Soybeans', ZWU5: 'Wheat',
    '6BU5': 'British Pound', '6EU5': 'Euro FX',
    EURUSD: 'Euro / US Dollar', GBPUSD: 'British Pound / US Dollar', USDJPY: 'US Dollar / Japanese Yen',
    AUDUSD: 'Australian Dollar / US Dollar', USDCAD: 'US Dollar / Canadian Dollar',
    NZDUSD: 'NZ Dollar / US Dollar', USDCHF: 'US Dollar / Swiss Franc', EURGBP: 'Euro / British Pound',
    EURJPY: 'Euro / Japanese Yen', GBPJPY: 'British Pound / Japanese Yen', USDTRY: 'US Dollar / Turkish Lira',
    USDMXN: 'US Dollar / Mexican Peso', USDZAR: 'US Dollar / South African Rand', EURCHF: 'Euro / Swiss Franc',
    AUDJPY: 'Australian Dollar / Japanese Yen', CHFJPY: 'Swiss Franc / Japanese Yen', EURAUD: 'Euro / Australian Dollar',
  };
  function nameFor(sym) { return SYMBOL_NAMES[sym] || sym; }

  /* plausible starting data for a symbol that isn't in the static watchlist,
     derived from its category + a stable per-symbol hash */
  const CAT_SEED = {
    crypto: { last: 50, step: 0.01, dec: 2 },
    stocks: { last: 200, step: 0.05, dec: 2 },
    futures: { last: 5000, step: 0.25, dec: 2 },
    forex: { last: 1.1, step: 0.0001, dec: 4 },
  };
  function seedSymbol(sym, cat) {
    const h = symHash(sym);
    const base = CAT_SEED[cat] || CAT_SEED.stocks;
    const mult = 0.5 + (h % 1000) / 1000 * 3;      /* 0.5× … 3.5× */
    const chgPct = ((h % 800) / 100) - 4;           /* −4% … +4% */
    const last = Math.max(+(base.last * mult).toFixed(base.dec), base.step);
    return { last, chgPct, step: base.step, dec: base.dec, vol: baseVolFor(sym) };
  }

  /* ensure a static/dynamic row carries ticker+name spans and Change/Volume cells */
  function normalizeWatchlistRow(row) {
    const sym = row.dataset.sym;
    const symEl = row.querySelector('.wl-sym');
    if (symEl && !symEl.querySelector('.wl-sym-ticker')) {
      const ticker = symEl.textContent.trim();
      symEl.innerHTML = '<span class="wl-sym-ticker">' + ticker + '</span>' +
        '<span class="wl-sym-name">' + nameFor(sym) + '</span>';
    }
    if (!row.querySelector('.wl-chgabs')) {
      const chgAbs = document.createElement('span');
      chgAbs.className = 'wl-chgabs';
      chgAbs.id = 'wlChgAbs-' + sym;
      row.insertBefore(chgAbs, row.querySelector('.wl-chg'));
    }
    if (!row.querySelector('.wl-vol')) {
      const vol = document.createElement('span');
      vol.className = 'wl-vol';
      vol.id = 'wlVol-' + sym;
      row.appendChild(vol);
    }
    if (!row.querySelector('.wl-remove')) {
      const rm = document.createElement('span');
      rm.className = 'wl-remove material-symbols-outlined';
      rm.setAttribute('data-tooltip', 'Remove from watchlist');
      rm.textContent = 'close';
      row.appendChild(rm);
    }
  }

  /* build a complete row for a newly added symbol using its seed meta */
  function buildWatchlistRow(sym, cat, meta) {
    const row = document.createElement('div');
    row.className = 'wl-row';
    row.dataset.sym = sym;
    row.dataset.cat = cat;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const up = meta.chgPct >= 0;
    const abs = meta.last - meta.last / (1 + meta.chgPct / 100);
    const dir = up ? 'up' : 'down';
    row.innerHTML =
      '<span class="wl-sym"><span class="wl-sym-ticker">' + sym + '</span>' +
      '<span class="wl-sym-name">' + nameFor(sym) + '</span></span>' +
      '<span class="wl-last" id="wlLast-' + sym + '">' + fmt(meta.last, meta.dec) + '</span>' +
      '<span class="wl-chgabs ' + dir + '" id="wlChgAbs-' + sym + '">' + (up ? '+' : '') + fmt(abs, meta.dec) + '</span>' +
      '<span class="wl-chg ' + dir + '" id="wlChg-' + sym + '">' + (up ? '+' : '') + fmt(meta.chgPct) + '%</span>' +
      '<span class="wl-vol" id="wlVol-' + sym + '">' + fmtVol(meta.vol) + '</span>' +
      '<span class="wl-remove material-symbols-outlined" data-tooltip="Remove from watchlist">close</span>';
    return row;
  }

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
  /* normalize every static row first so the Change/Volume cells + name spans exist */
  document.querySelectorAll('#wlRows .wl-row').forEach(normalizeWatchlistRow);

  /* ---------- unified market-data map (single source of truth) ----------
     Every price the app shows — the left-panel watchlist rows AND the Symbol
     Selector modal — reads from this one map. Watchlisted symbols bind their DOM
     cells so tick() paints them live; any other symbol is seeded on first request
     (by the modal, via getMarketData) and still random-walks so the modal feels live. */
  const market = new Map();

  function makeEntry(sym, cat, seed) {
    const e = {
      sym: sym, cat: cat || null,
      last: seed.last, chgPct: seed.chgPct, step: seed.step, dec: seed.dec,
      vol: seed.vol !== undefined ? seed.vol : baseVolFor(sym),
    };
    e.prevClose = e.last / (1 + e.chgPct / 100);
    e.anchor = e.last;
    e.elLast = e.elChg = e.elChgAbs = e.elVol = null;
    return e;
  }
  /* point an entry at its rendered watchlist row so tick() updates those cells */
  function bindEntryToRow(sym) {
    const e = market.get(sym);
    if (!e) return;
    e.elLast = document.getElementById('wlLast-' + sym);
    e.elChg = document.getElementById('wlChg-' + sym);
    e.elChgAbs = document.getElementById('wlChgAbs-' + sym);
    e.elVol = document.getElementById('wlVol-' + sym);
  }
  /* drop the DOM refs (row removed) but keep the data so the modal still shows it */
  function unbindEntry(sym) {
    const e = market.get(sym);
    if (!e) return;
    e.elLast = e.elChg = e.elChgAbs = e.elVol = null;
  }

  /* seed the map from the curated watchlist symbols (keeps their hand-picked
     starting values), then bind each to its already-rendered row. */
  watchSyms.forEach(s => {
    const e = makeEntry(s.sym, null, { last: s.last, chgPct: s.chgPct, step: s.step, dec: s.dec });
    market.set(s.sym, e);
    bindEntryToRow(s.sym);
    /* seed initial Change/Volume text so the columns aren't blank before first tick */
    const abs0 = e.last - e.prevClose;
    const up0 = abs0 >= 0;
    if (e.elChgAbs) { e.elChgAbs.textContent = (up0 ? '+' : '') + fmt(abs0, e.dec); setUpDown(e.elChgAbs, up0); }
    if (e.elVol) e.elVol.textContent = fmtVol(e.vol);
  });

  /* ETHUSD is driven separately (alongside the chart), so it isn't bound/painted
     here — but the modal still needs plausible data for it, seeded to match the
     static watchlist row rather than the generic crypto seed. */
  if (!market.has('ETHUSD')) {
    market.set('ETHUSD', makeEntry('ETHUSD', 'crypto', { last: 4500.25, chgPct: 0.41, step: 0.05, dec: 2 }));
  }

  /* positions — each carries its own mark price noise so they're independent
     of watchlist symbols and continue to animate correctly as positions close */
  // side ('buy'/'sell') and domKey let a long and a short on the same symbol be two independent rows.
  // domKey (defaults to sym) is the id/data-pos-id suffix; static seed rows use plain sym, dynamic
  // (chart) rows use sym-side. side defaults to the sign of the derived pv for the static seeds.
  function makePosition(sym, qty, avgPrice, mark0, pnlOpen0, pct0, step, dec, side, domKey) {
    const pv = Math.abs(mark0 - avgPrice) > 1e-9
      ? pnlOpen0 / ((mark0 - avgPrice) * qty)
      : 1;
    const unitBase = pct0 !== 0 ? pnlOpen0 / pct0 : 1;
    const k = domKey || sym;
    return {
      sym, side: side || (pv > 0 ? 'buy' : 'sell'), domKey: k, qty, avgPrice,
      mark: mark0, mark0, anchor: mark0, step: step || 0.01, dec: dec || 2,
      pv, pnlOpen0, unitBase,
      elQty: document.getElementById('posQty-' + k),
      elAvg: document.getElementById('posAvg-' + k),
      elMark: document.getElementById('posMark-' + k),
      elPnlOpen: document.getElementById('posPnlOpen-' + k),
      elPct: document.getElementById('posPct-' + k),
      elMarkD: document.getElementById('posMarkD-' + k),
      elUnrealD: document.getElementById('posUnrealD-' + k),
    };
  }

  const positions = [
    //                sym        qty       avgPrice   mark0      pnlOpen0  pct0   step    dec
    makePosition('NQU5', 8, 29748.00, 29704.75, -692.00, -0.15, 0.25, 2),
    makePosition('ESU5', 5, 6015.25, 6028.00, -63.75, -0.21, 0.25, 2),
    makePosition('SOLUSD', 3084.19, 0.2136, 0.2195, -83.55, -8.35, 0.0001, 4),
    makePosition('BTCUSD', 0.125, 66245.10, 67121.50, 109.55, 1.32, 0.5, 2),
    makePosition('AAPL', 100, 185.27, 188.45, 318.00, 1.72, 0.05, 2),
  ];

  const totPnlOpenEl = document.getElementById('totPnlOpen');
  const totPctEl = document.getElementById('totPct');

  function fmtQty(q) {
    let s = q.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' || s === '-' ? '0' : s;
  }

  /* ---------- close-side quote ----------
     Closing trades against the book: a long is closed by selling into the best bid, a short by
     buying the best ask. Both quotes come from the position's own mark, pinned to whichever side
     the last tick printed at so they stay on the instrument's price grid — the same rule the Quick
     Trade quote uses. */
  function positionCloseQuote(p) {
    const spread = p.step;
    const printedAtAsk = p.tickUp !== false;
    const bid = printedAtAsk ? p.mark - spread : p.mark;
    const ask = printedAtAsk ? p.mark : p.mark + spread;
    return p.side === 'buy'
      ? { price: bid, label: 'Best Bid', side: 'bid' }
      : { price: ask, label: 'Best Ask', side: 'ask' };
  }

  /* Keeps the Close Limit button's price and its "Best Bid"/"Best Ask" note on the live quote. Both
     are only visible while that row's BBO is on, but painting them regardless keeps them correct the
     moment it's switched on. */
  function paintCloseQuote(p) {
    const key = p.domKey || p.sym;
    const priceEl = document.getElementById('posCloseQuote-' + key);
    if (!priceEl) return;
    const quote = positionCloseQuote(p);
    priceEl.textContent = fmt(quote.price, p.dec);
    const noteEl = document.getElementById('posCloseNote-' + key);
    if (noteEl) noteEl.textContent = quote.label;
  }

  function findPositionByKey(domKey) {
    return positions.find(x => (x.domKey || x.sym) === domKey);
  }

  /* The close panel reads its own quote through this — the price a limit close should rest at. */
  window.positionCloseQuote = function (domKey) {
    const p = findPositionByKey(domKey);
    if (!p) return null;
    const quote = positionCloseQuote(p);
    return { price: quote.price, text: fmt(quote.price, p.dec), label: quote.label };
  };

  /* Repaints one row's caption between ticks — a row created or expanded mid-tick shouldn't sit on
     a placeholder for up to a second. */
  window.refreshPositionCloseQuote = function (domKey) {
    const p = findPositionByKey(domKey);
    if (p) paintCloseQuote(p);
  };

  positions.forEach(paintCloseQuote);

  /* ---------- resting limit closes ----------
     A limit close from a position's Close Position panel is a real working order: it sits in Open
     Orders until the position's mark reaches its price, then closes that much of the position.
     Closing a long is a sell, so it rests above the mark and fills when the mark trades up to it;
     closing a short is a buy and rests below. The panel places them, app.js renders them. */
  const closeOrders = [];
  let closeOrderSeq = 0;

  function closeOrderView(o) {
    return {
      id: o.id, sym: o.sym, domKey: o.domKey, side: o.side, pct: o.pct,
      qty: o.qty, qtyText: fmtQty(o.qty), price: o.price, priceText: fmt(o.price, o.dec),
    };
  }
  function closeOrdersChanged() {
    document.dispatchEvent(new CustomEvent('position-close-orders:changed'));
  }
  /* A position that's gone — closed, flattened or reversed — can't have working closes against it. */
  function dropCloseOrdersFor(domKey) {
    const before = closeOrders.length;
    for (let i = closeOrders.length - 1; i >= 0; i--) {
      if (closeOrders[i].domKey === domKey) closeOrders.splice(i, 1);
    }
    if (closeOrders.length !== before) closeOrdersChanged();
  }

  /* pct of the position's current size, at price. Returns the order for the caller to toast. */
  window.placePositionCloseOrder = function (domKey, pct, price) {
    const p = findPositionByKey(domKey);
    if (!p || !(pct > 0) || !(price > 0)) return null;
    const qty = pct >= 100 ? p.qty : p.qty * pct / 100;
    const order = {
      id: 'close-' + (++closeOrderSeq), domKey: domKey, sym: p.sym, dec: p.dec,
      positionSide: p.side, side: p.side === 'buy' ? 'sell' : 'buy',
      qty, price, pct,
    };
    closeOrders.push(order);
    closeOrdersChanged();
    // How much of the position every working close now adds up to. Closes are reduce-only — they're
    // capped at whatever is left when they fill — so resting more than 100% is allowed, but the
    // caller says so rather than letting it pass unremarked.
    const workingQty = closeOrders
      .filter(o => o.domKey === domKey)
      .reduce((sum, o) => sum + o.qty, 0);
    const view = closeOrderView(order);
    view.coverPct = p.qty > 0 ? workingQty / p.qty * 100 : 0;
    return view;
  };

  window.positionCloseOrders = function () {
    return closeOrders.map(closeOrderView);
  };

  /* Repricing a working close — the chart drags its line. `notify` is false for the live drag (the
     chart is already moving the line itself; a re-render would tear the dragged node out from under
     it) and true on drop, which repaints the table and the chart from the new price. */
  window.movePositionCloseOrder = function (id, price, notify) {
    const order = closeOrders.find(o => o.id === id);
    if (!order || !(price > 0)) return null;
    order.price = price;
    if (notify) closeOrdersChanged();
    return closeOrderView(order);
  };

  window.cancelPositionCloseOrder = function (id) {
    const i = closeOrders.findIndex(o => o.id === id);
    if (i < 0) return null;
    const [order] = closeOrders.splice(i, 1);
    closeOrdersChanged();
    return closeOrderView(order);
  };

  /* The price a working close is measured against. ETHUSD is the instrument the chart draws, and its
     closes are drawn there as lines, so they have to fill against the price shown on that chart —
     not this row's own mark, which carries independent noise. Every other symbol has no chart to
     disagree with, and fills against its mark. */
  const CHART_SYMBOL = 'ETHUSD';
  function closeFillPrice(p) {
    const lastEl = document.getElementById('hdrLast');
    if (p.sym === CHART_SYMBOL && lastEl) {
      const last = parseFloat(lastEl.textContent.replace(/,/g, ''));
      if (!isNaN(last)) return last;
    }
    return p.mark;
  }

  /* Called as each position's mark moves. Fills every working close the price has reached. */
  function fillReachedCloseOrders(p) {
    const key = p.domKey || p.sym;
    const last = closeFillPrice(p);
    for (let i = closeOrders.length - 1; i >= 0; i--) {
      const o = closeOrders[i];
      if (o.domKey !== key) continue;
      const reached = o.side === 'sell' ? last >= o.price : last <= o.price;
      if (!reached) continue;
      closeOrders.splice(i, 1);
      // Realized P&L on the closed slice, using the same per-unit scaling the row's open P&L uses.
      const pnl = (o.price - p.avgPrice) * o.qty * p.pv;
      const result = window.closePositionAmount(o.sym, o.qty, o.positionSide);
      if (result === 'closed') dropCloseOrdersFor(key); // nothing left to close
      document.dispatchEvent(new CustomEvent('position-close-order:filled', {
        detail: Object.assign(closeOrderView(o), { pnl, closedPosition: result === 'closed' }),
      }));
      closeOrdersChanged();
    }
  }

  /* ---------- position actions: partial/full close & reverse ---------- */
  // side is optional: given, it targets that specific long/short row; omitted, it closes the first
  // position for the symbol (used by flatten, which loops until every side is gone).
  function findPosition(sym, side) {
    return side
      ? positions.find(x => x.sym === sym && x.side === side)
      : positions.find(x => x.sym === sym);
  }
  function removePositionRow(p, sym) {
    const row = (p.elQty && p.elQty.closest('.pos-row')) ||
      document.querySelector('.pos-row[data-pos-id="' + (p.domKey || sym) + '"]');
    if (row) row.remove();
    dropCloseOrdersFor(p.domKey || sym);
  }
  window.closePositionPct = function (sym, pct, side) {
    const p = findPosition(sym, side);
    if (!p) return false;
    if (pct >= 100) {
      positions.splice(positions.indexOf(p), 1);
      removePositionRow(p, sym);
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
  window.closePositionAmount = function (sym, amount, side) {
    const p = findPosition(sym, side);
    if (!p || !(amount > 0)) return false;
    if (amount >= p.qty - 1e-9) {
      positions.splice(positions.indexOf(p), 1);
      removePositionRow(p, sym);
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
    // The position is about to face the other way — its working closes would be on the wrong side.
    dropCloseOrdersFor(p.domKey || sym);
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
      '<button class="pos-quick-btn pos-quick-reverse" data-pos-reverse title="Reverse"><span class="material-symbols-outlined">swap_vert</span></button>' +
      '<button class="pos-quick-btn pos-quick-close" data-pos-close-pct="100" title="Close"><span class="material-symbols-outlined">close</span></button></div>';
  }
  /* TP / SL rows for the expanded detail, built from the order's actual targets/stop.
     Distance is the signed % from entry; size is each target's close percentage. */
  function tpslListHtml(entry, dec, meta) {
    const tps = (meta && meta.tps) || [];
    const sl = meta && meta.sl;
    let rows = '';
    tps.forEach((tp, i) => {
      const dist = entry ? (tp.price - entry) / entry * 100 : 0;
      rows += '<div class="pos-tpsl-entry">' +
        '<span class="pos-tpsl-name">TP ' + (i + 1) + '</span>' +
        '<span class="pos-tpsl-price up">' + fmt(tp.price, dec) + '</span>' +
        '<span class="pos-tpsl-dist faint">' + (dist >= 0 ? '+' : '') + fmt(dist) + '%</span>' +
        '<span class="pos-tpsl-size faint">' + Math.round(tp.pct) + '%</span></div>';
    });
    if (sl) {
      const dist = entry ? (sl.price - entry) / entry * 100 : 0;
      rows += '<div class="pos-tpsl-entry pos-sl-entry">' +
        '<span class="pos-tpsl-name">SL</span>' +
        '<span class="pos-tpsl-price down">' + fmt(sl.price, dec) + '</span>' +
        '<span class="pos-tpsl-dist faint">' + (dist >= 0 ? '+' : '') + fmt(dist) + '%</span>' +
        '<span class="pos-tpsl-size faint">100%</span></div>';
    }
    return rows || '<div class="pos-tpsl-empty">No TP / SL set</div>';
  }
  /* Position / P&L / TP-SL detail sections for a dynamically-created row. Size, Avg Entry and
     TP/SL are real; Mark Price and Unrealized are wired to update live (see makePosition/tick);
     the remaining stats aren't tracked in this mockup, so they show placeholder values. */
  function detailSectionsHtml(sym, qtyStr, unit, price, priceStr, dec, meta) {
    const high24 = fmt(price * 1.01, dec);
    const low24 = fmt(price * 0.99, dec);
    return '<div class="pos-detail-section">' +
      '<div class="pos-detail-label">Position</div>' +
      '<div class="pos-kv">' +
      '<span class="pos-kv-k">Size</span><span class="pos-kv-v">' + qtyStr + ' ' + unit + '</span>' +
      '<span class="pos-kv-k">Avg Entry</span><span class="pos-kv-v">' + priceStr + '</span>' +
      '<span class="pos-kv-k">Mark Price</span><span class="pos-kv-v" id="posMarkD-' + sym + '">' + priceStr + '</span>' +
      '<span class="pos-kv-k">Break Even</span><span class="pos-kv-v">' + priceStr + '</span>' +
      '<span class="pos-kv-k">Margin</span><span class="pos-kv-v faint">—</span>' +
      '<span class="pos-kv-k">Liq. Price</span><span class="pos-kv-v faint">—</span>' +
      '</div></div>' +
      '<div class="pos-detail-section">' +
      '<div class="pos-detail-label">P&amp;L</div>' +
      '<div class="pos-kv">' +
      '<span class="pos-kv-k">Unrealized</span><span class="pos-kv-v" id="posUnrealD-' + sym + '">+0.00</span>' +
      '<span class="pos-kv-k">Realized</span><span class="pos-kv-v faint">—</span>' +
      '<span class="pos-kv-k">Funding</span><span class="pos-kv-v faint">—</span>' +
      '<span class="pos-kv-k">24h High</span><span class="pos-kv-v">' + high24 + '</span>' +
      '<span class="pos-kv-k">24h Low</span><span class="pos-kv-v">' + low24 + '</span>' +
      '</div></div>' +
      '<div class="pos-detail-section">' +
      '<div class="pos-detail-label">TP / SL</div>' +
      '<div class="pos-tpsl-list">' + tpslListHtml(price, dec, meta) + '</div>' +
      '</div>';
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
        '<input type="range" class="pos-close-slider range-slider" id="' + sliderId + '" min="0" max="100" step="1" value="100">';
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
      '<div class="pos-close-limit-row">' +
      stepper('posCloseLimitPx-' + sym, priceStr, pxStep, 'USD') +
      '<button type="button" class="pos-close-bbo-btn" data-pos-close-bbo aria-pressed="false" ' +
      'title="Close at the best bid on a long, the best ask on a short">BBO</button></div>' +
      // With BBO on the button carries the price this close would rest at — painted by the tick.
      '<button class="pos-close-primary" data-pos-close-limit>' +
      '<span class="pos-close-lbl">Close Limit</span>' +
      '<span class="pos-close-price" id="posCloseQuote-' + sym + '"></span>' +
      '<span class="pos-close-note" id="posCloseNote-' + sym + '">Best Bid</span></button></div>';
  }
  /* leverage currently chosen in the Quick Trade panel — stamped onto positions opened from a fill */
  function currentLeverage() {
    const el = document.getElementById('qtLevSlider');
    return Math.max(1, parseInt(el && el.value, 10) || 1);
  }
  function createPositionRow(sym, side, qty, price, dec, meta) {
    const row = document.createElement('div');
    row.className = 'pos-row';
    // Composite key so a long and a short on the same symbol get distinct element ids / rows. The real
    // symbol and side are kept as separate data attributes for the close/reverse handlers to read.
    const key = sym + '-' + side;
    row.dataset.posId = key;
    row.dataset.posSym = sym;
    row.dataset.posSide = side;
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
      '<div class="pos-col pos-col-size"><span class="pos-size-qty" id="posQty-' + key + '">' + fmtQty(qty) + '</span><span class="pos-size-unit">Units</span></div>' +
      '<div class="pos-col pos-col-price"><span class="pos-entry" id="posAvg-' + key + '">' + fmt(price, dec) + '</span><span class="pos-mark" id="posMark-' + key + '">' + fmt(price, dec) + '</span></div>' +
      '<div class="pos-col pos-col-pnl"><span class="pos-pnl-dollar up" id="posPnlOpen-' + key + '">+0.00</span><span class="pos-pnl-pct up" id="posPct-' + key + '">+0.00%</span></div>' +
      '<div class="pos-col pos-col-margin"><span class="pos-margin faint" id="posMargin-' + key + '">—</span></div>' +
      '<div class="pos-col pos-col-liq"><span class="pos-liq faint">—</span></div>' +
      '<div class="pos-col pos-col-quickclose">' + quickCloseRowHtml() + '</div>' +
      '<div class="pos-col pos-col-actions"><button class="pos-expand-btn" title="Expand details"><span class="material-symbols-outlined pos-chevron">expand_more</span></button></div>' +
      '</div>' +
      '<div class="pos-row-detail">' +
      detailSectionsHtml(key, fmtQty(qty), 'Units', price, fmt(price, dec), dec, meta) +
      '<div class="pos-detail-close">' +
      detailCloseHtml(key, fmtQty(qty), 'Units', fmt(price, dec), '0.001',
        price < 1 ? '0.0001' : price < 100 ? '0.01' : '0.5') +
      '</div></div>';
    row.querySelector('.pos-row-summary').addEventListener('click', (e) => {
      if (e.target.closest('.pos-col-quickclose') || e.target.closest('.pos-sym-ticker')) return;
      row.classList.toggle('is-expanded');
      if (row.classList.contains('is-expanded') && window.fitBottomPanelToExpandedRow) {
        window.fitBottomPanelToExpandedRow(row);
      }
    });
    document.querySelector('.pos-rows-scroll').prepend(row);
    row.querySelectorAll('.pos-close-slider').forEach(s => {
      if (window.decorateRangeSlider) window.decorateRangeSlider(s);
      if (window.fillRangeSlider) window.fillRangeSlider(s);
      if (window.updatePosCloseLabel) window.updatePosCloseLabel(s);
    });
  }
  window.upsertPositionFromFill = function (sym, side, qty, price, meta) {
    const dir = side === 'buy' ? 1 : -1;
    // Merge only into a same-side position; a long and a short on one symbol stay separate rows
    // (so hedge-mode opposite fills don't net into one). One-way mode never reaches here with an
    // opposing fill — the placement guard blocks that first.
    const existing = positions.find(x => x.sym === sym && x.side === side);
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
    const key = sym + '-' + side;
    createPositionRow(sym, side, qty, price, dec, meta);
    const pos = makePosition(sym, qty, price, price, 0, 0, step, dec, side, key);
    pos.pv = dir;
    pos.unitBase = (qty * price) / 100;
    positions.push(pos);
  };
  /* True when a position on the opposite side of `side` exists for `sym` (drives the one-way block). */
  window.hasOpposingPosition = function (sym, side) {
    return positions.some(p => p.sym === sym && p.side !== side);
  };

  function tick() {
    /* walk every symbol in the market map; paint DOM only where a watchlist row is
       bound, but move all of them so the Symbol Selector modal stays live too */
    market.forEach(s => {
      const prevLast = s.last;
      const reversion = (s.anchor - s.last) * 0.05;
      let next = roundStep(s.last + noise() * s.step * 0.9 + reversion, s.step);
      if (next === s.last) next = roundStep(s.last + (rand() < 0.5 ? -s.step : s.step), s.step);
      s.last = Math.max(next, s.step);
      const isUp = s.last > prevLast;
      const chg = (s.last - s.prevClose) / s.prevClose * 100;
      const chgAbs = s.last - s.prevClose;
      const chgUp = chg >= 0;
      s.vol += s.vol * 0.0008 + (rand() - 0.5) * s.vol * 0.004;
      if (s.vol < 1000) s.vol = 1000;
      if (s.elLast) s.elLast.textContent = fmt(s.last, s.dec);
      if (s.elChg) { s.elChg.textContent = (chgUp ? '+' : '') + fmt(chg) + '%'; setUpDown(s.elChg, chgUp); }
      if (s.elChgAbs) { s.elChgAbs.textContent = (chgUp ? '+' : '') + fmt(chgAbs, s.dec); setUpDown(s.elChgAbs, chgUp); }
      if (s.elVol) s.elVol.textContent = fmtVol(s.vol);
      if (s.elLast) flashEl(s.elLast, isUp);
    });

    /* positions — self-contained noise per position */
    let sumPnlOpen = 0, sumBase = 0;
    // Iterate a copy: a limit close that fills mid-tick removes its position from the live array.
    positions.slice().forEach(p => {
      try {
        const reversion = (p.anchor - p.mark) * 0.04;
        let next = roundStep(p.mark + noise() * p.step * 0.6 + reversion, p.step);
        if (next === p.mark) next = roundStep(p.mark + (rand() < 0.5 ? -p.step : p.step), p.step);
        p.tickUp = next > p.mark; // which side of the book this print landed on
        p.mark = Math.max(next, p.step);

        const deltaMark = p.mark - p.mark0;
        const deltaPnl = deltaMark * p.qty * p.pv;
        const pnlOpen = p.pnlOpen0 + deltaPnl;
        const pct = p.unitBase !== 0 ? pnlOpen / p.unitBase : 0;

        if (p.elMark) p.elMark.textContent = fmt(p.mark, p.dec);
        paintCloseQuote(p);
        fillReachedCloseOrders(p);
        if (p.elMarkD) p.elMarkD.textContent = fmt(p.mark, p.dec);
        if (p.elPnlOpen) {
          p.elPnlOpen.textContent = (pnlOpen >= 0 ? '+' : '') + fmt(pnlOpen);
          setUpDown(p.elPnlOpen, pnlOpen >= 0);
        }
        if (p.elUnrealD) {
          p.elUnrealD.textContent = (pnlOpen >= 0 ? '+' : '') + fmt(pnlOpen);
          setUpDown(p.elUnrealD, pnlOpen >= 0);
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

    /* let an open Symbol Selector modal repaint its visible rows from fresh data */
    document.dispatchEvent(new CustomEvent('market:tick'));
  }
  setInterval(tick, 1200);

  /* ---------- public API: market data + watchlist add/remove ---------- */
  window.watchlistHasSymbol = function (sym) {
    return !!document.querySelector('#wlRows .wl-row[data-sym="' + sym + '"]');
  };

  /* single source of truth for the Symbol Selector modal — returns a formatted
     snapshot, seeding + caching the symbol on first request. */
  window.getMarketData = function (sym, cat) {
    let e = market.get(sym);
    if (!e) {
      e = makeEntry(sym, cat, seedSymbol(sym, cat || 'crypto'));
      market.set(sym, e);
    } else if (cat && !e.cat) {
      e.cat = cat;
    }
    const chgPct = (e.last - e.prevClose) / e.prevClose * 100;
    const chgAbs = e.last - e.prevClose;
    const up = chgAbs >= 0;
    return {
      sym: e.sym, name: nameFor(e.sym), cat: e.cat,
      last: e.last, chgPct: chgPct, chgAbs: chgAbs, vol: e.vol, dec: e.dec, up: up,
      lastText: fmt(e.last, e.dec),
      chgPctText: (up ? '+' : '') + fmt(chgPct) + '%',
      chgAbsText: (up ? '+' : '') + fmt(chgAbs, e.dec),
      volText: fmtVol(e.vol),
    };
  };

  window.addWatchlistSymbol = function (sym, cat) {
    if (window.watchlistHasSymbol(sym)) return;
    const rowsWrap = document.getElementById('wlRows');
    if (!rowsWrap) return;
    /* ensure the symbol exists in the market map, then render the row from that
       shared entry so the watchlist and the modal always agree on the price */
    window.getMarketData(sym, cat);
    const e = market.get(sym);
    const chgPct = (e.last - e.prevClose) / e.prevClose * 100;
    rowsWrap.appendChild(buildWatchlistRow(sym, cat, { last: e.last, chgPct: chgPct, dec: e.dec, vol: e.vol }));
    bindEntryToRow(sym);
    /* apply the active category tab + search so the new row respects the filter */
    if (window.applyWatchlistFilter) window.applyWatchlistFilter();
    document.dispatchEvent(new CustomEvent('watchlist:changed', { detail: { sym: sym, inWatchlist: true } }));
  };

  window.removeWatchlistSymbol = function (sym) {
    const row = document.querySelector('#wlRows .wl-row[data-sym="' + sym + '"]');
    if (row) row.remove();
    unbindEntry(sym);   /* keep the data entry so the modal still shows it */
    if (window.applyWatchlistFilter) window.applyWatchlistFilter();
    document.dispatchEvent(new CustomEvent('watchlist:changed', { detail: { sym: sym, inWatchlist: false } }));
  };
})();
