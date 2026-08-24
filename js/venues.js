/* ================================================================
   CROSS-VENUE PRICING LAYER
   ================================================================

   The terminal keeps two separate layers:

     Chart / Analysis layer  — the venue supplying the candles (e.g. Binance)
     Execution / Order layer — the venue the order is actually sent to (e.g. BloFin)

   They can be different venues, and the same instrument rarely trades at exactly
   the same price on both. This module owns the difference between them (the
   "basis") and is the ONLY place a chart price is turned into an executable
   price. Nothing else should add or subtract a venue offset by hand.

   ---------------------------------------------------------------
   Why the translation is additive
   ---------------------------------------------------------------
   toExec(chartPrice) is chartPrice + basisAbs(): a uniform shift of the whole
   trade structure. That matters because a shift leaves every *distance*
   untouched — entry-from-market, stop distance, target distance — and therefore
   leaves risk-to-reward mathematically unchanged. A trader who plans a setup on
   the Binance chart gets that exact setup on BloFin, just re-based.

     Binance mark   100,000     entry planned 100 below   ->  99,900
     BloFin  mark    99,970     same 100 below            ->  99,870

   Percentage distances move by a hair under this scheme (99,900/100,000 is not
   exactly 99,870/99,970), but at realistic venue spreads the difference is far
   below a tick and never reaches the display. Preserving absolute distances —
   and with them R:R — is the property traders actually plan around.

   ---------------------------------------------------------------
   Why the fill simulation stays in chart space
   ---------------------------------------------------------------
   The order engine in js/app.js compares the chart's last price against chart
   levels to decide fills, stops and targets. It is left that way on purpose:
   because the translation is a uniform shift, a level touched in chart space is
   touched in execution space at the very same instant. The two views can never
   disagree about *whether* something filled, only about the number printed on
   the ticket. Execution space is therefore a translated view plus the price of
   record — no second state machine.
   ================================================================ */
(function () {
  'use strict';

  /* Every venue the terminal knows about. `roles` gates which of the two selectors a venue can
     appear in; `supports` is the asset classes it actually trades — a crypto exchange has no US
     stocks and a futures broker has no perps, so a position can never be shown against a venue
     that couldn't hold it; `basisBps` is its resting offset from a notional global mid, in basis
     points. Adding an exchange is a row here. */
  const VENUES = [
    { id: 'binance',      label: 'Binance',      roles: ['data', 'exec'], supports: ['crypto'], basisBps: 0 },
    { id: 'blofin',       label: 'BloFin',       roles: ['data', 'exec'], supports: ['crypto'], basisBps: -3 },
    { id: 'bybit',        label: 'Bybit',        roles: ['data', 'exec'], supports: ['crypto'], basisBps: 2 },
    { id: 'coinbase',     label: 'Coinbase',     roles: ['data', 'exec'], supports: ['crypto'], basisBps: 6 },
    { id: 'bitget',       label: 'Bitget',       roles: ['data', 'exec'], supports: ['crypto'], basisBps: 1 },
    { id: 'aggregated',   label: 'Aggregated',   roles: ['data'],         supports: ['crypto'], basisBps: 0 },
    { id: 'tradestation', label: 'TradeStation', roles: ['exec'],         supports: ['stocks', 'futures', 'forex'], basisBps: 0 },
    { id: 'tradovate',    label: 'Tradovate',    roles: ['exec'],         supports: ['futures'], basisBps: 0 },
  ];

  const BY_ID = {};
  VENUES.forEach(v => { BY_ID[v.id] = v; });

  /* Below MINOR_BPS the two venues are close enough that showing a second price
     everywhere would be noise, so the UI stays single-priced. Above the user's
     configured warn threshold the spread is treated as wide and placement is
     interrupted. */
  const MINOR_BPS = 2;
  const DEFAULT_WARN_BPS = 25;

  let dataVenueId = 'binance';
  let execVenueId = 'blofin';

  /* ---------- host hooks ----------
     js/app.js owns the price tape and the settings object. Rather than reach
     into either from here, it registers two getters at init so this module stays
     independent of both. Sensible fallbacks keep it usable before that happens. */
  let readChartMark = () => 0;
  let readSettings = () => ({ mode: 'relative', warnEnabled: true, warnBps: DEFAULT_WARN_BPS });

  function configure(hooks) {
    if (hooks.chartMark) readChartMark = hooks.chartMark;
    if (hooks.settings) readSettings = hooks.settings;
  }

  function settings() {
    const s = readSettings() || {};
    return {
      mode: s.mode === 'exact' ? 'exact' : 'relative',
      warnEnabled: s.warnEnabled !== false,
      warnBps: (parseFloat(s.warnBps) > 0) ? parseFloat(s.warnBps) : DEFAULT_WARN_BPS,
    };
  }

  /* ---------- the live basis ----------
     The resting difference between the two venues, plus a slow mean-reverting
     wander so the spread visibly breathes the way a real cross-venue basis does.
     Driven off the market tick the rest of the app already broadcasts, so this
     adds no timer of its own. */
  const rand = window.mulberry32 ? window.mulberry32(31337) : Math.random;
  let basisDriftBps = 0;
  let testBasisBps = null;   // set by _setBasisBpsForTest to pin the spread

  function restingBps() {
    const d = BY_ID[dataVenueId];
    const e = BY_ID[execVenueId];
    if (!d || !e) return 0;
    return e.basisBps - d.basisBps;
  }

  function advanceBasisDrift() {
    // Random walk pulled back towards zero, so the drift wanders a point or two
    // either side of the resting spread without ever running away.
    const step = (rand() - 0.5) * 0.6;
    basisDriftBps = (basisDriftBps + step) * 0.94;
  }
  document.addEventListener('market:tick', advanceBasisDrift);

  function basisBps() {
    if (!isCrossVenue()) return 0;
    if (testBasisBps !== null) return testBasisBps;
    return restingBps() + basisDriftBps;
  }

  function chartMark() {
    return readChartMark() || 0;
  }

  function basisAbs() {
    return chartMark() * (basisBps() / 10000);
  }

  function execMark() {
    return chartMark() + basisAbs();
  }

  /* ---------- translation ----------
     `opts.basisAbs` lets a live order pin the basis it was placed at, so its
     ticket prices stay put while the market's basis drifts underneath it. */
  function offsetFor(opts) {
    if (settings().mode === 'exact') return 0;
    if (opts && typeof opts.basisAbs === 'number') return opts.basisAbs;
    return basisAbs();
  }

  function toExec(chartPrice, opts) {
    if (typeof chartPrice !== 'number' || !isFinite(chartPrice)) return chartPrice;
    return chartPrice + offsetFor(opts);
  }

  function toChart(execPrice, opts) {
    if (typeof execPrice !== 'number' || !isFinite(execPrice)) return execPrice;
    return execPrice - offsetFor(opts);
  }

  /* The executable quote on the execution venue: the chart's own book, re-based.
     js/app.js supplies its chart-side BBO through the hook so the spread rules
     for the instrument stay in one place. */
  let readChartBbo = null;
  function configureBbo(fn) { readChartBbo = fn; }
  function execBbo(side) {
    const chartSide = readChartBbo ? readChartBbo(side) : chartMark();
    return toExec(chartSide);
  }

  /* How far apart the two venues currently are, and whether that is far enough
     to change what the UI shows. */
  function divergence() {
    const bps = Math.abs(basisBps());
    const abs = Math.abs(basisAbs());
    const wide = settings().warnBps;
    let level = 'none';
    if (bps >= wide) level = 'wide';
    else if (bps >= MINOR_BPS) level = 'minor';
    return { bps, abs, level, signedBps: basisBps(), signedAbs: basisAbs() };
  }

  function isCrossVenue() {
    return dataVenueId !== execVenueId;
  }

  function announce() {
    document.dispatchEvent(new CustomEvent('venue:changed'));
  }

  function setDataVenue(id) {
    if (!BY_ID[id] || id === dataVenueId) return;
    dataVenueId = id;
    basisDriftBps = 0;
    announce();
  }

  function setExecVenue(id) {
    if (!BY_ID[id] || id === execVenueId) return;
    execVenueId = id;
    basisDriftBps = 0;
    announce();
  }

  function venueLabel(id) {
    return BY_ID[id] ? BY_ID[id].label : id;
  }

  /* Whether a venue trades a given asset class. The guard behind venueForSymbol in js/app.js, so
     a symbol can never be routed to — or labelled with — an exchange that doesn't list it. */
  function venueSupports(id, cat) {
    const v = BY_ID[id];
    return !!v && v.supports.indexOf(cat) !== -1;
  }

  window.TTVenues = {
    VENUES,
    venuesFor: (role) => VENUES.filter(v => v.roles.indexOf(role) !== -1),
    venueLabel,
    venueSupports,
    dataVenue: () => dataVenueId,
    execVenue: () => execVenueId,
    dataLabel: () => venueLabel(dataVenueId),
    execLabel: () => venueLabel(execVenueId),
    setDataVenue,
    setExecVenue,
    isCrossVenue,
    chartMark,
    execMark,
    basisBps,
    basisAbs,
    toExec,
    toChart,
    execBbo,
    divergence,
    pricingMode: () => settings().mode,
    warnEnabled: () => settings().warnEnabled,
    configure,
    configureBbo,
    // Test hook: pin the venue spread to a fixed bps so the wide-spread paths
    // can be exercised without waiting for the drift to get there.
    _setBasisBpsForTest: (bps) => { testBasisBps = (bps === null ? null : Number(bps)); announce(); },
  };
})();
