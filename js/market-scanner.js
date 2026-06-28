/* =====================================================================
   MARKET SCANNER — full-screen workspace modal
   ---------------------------------------------------------------------
   A data-driven scanner. Every tab renders from a JS dataset through a
   single generic table renderer, so search / filter / sort / pagination /
   the detail pane / AI results all share one path. This is a mockup — the
   action buttons and AI scan are visual only (no backend).
   ===================================================================== */
(function marketScanner() {
  'use strict';

  const backdrop = document.getElementById('marketScannerModal');
  const trigger = document.getElementById('marketScannerTrigger');
  if (!backdrop || !trigger) return;

  /* ---------------------------------------------------------------
     Asset universe — each entry holds the full breakdown used by the
     detail pane. Tab datasets are derived from these objects below.
     --------------------------------------------------------------- */
  const ASSETS = [
    {
      sym: 'NVDA', name: 'NVIDIA Corp', cls: 'equity', price: '142.50', change: 3.24,
      bias: 'bullish', evidence: 8, strength: 3, signal: 'Buy', setup: 'Breakout', tf: '4H + Live',
      classes: ['equity'], biasTags: ['bullish', 'breakout', 'highvol'],
      why: [
        'Earnings beat expectations, price up +12.4%',
        'Dark pool buying $148M in the last hour',
        'Breaking out above key daily resistance at $140',
        'RSI bouncing from oversold levels'
      ],
      news: { headline: 'Earnings Beat', sub: 'Revenue, EPS above estimates', reaction: 12.4, impact: 'high', time: '2h ago', cat: 'earnings', sector: 'Technology' },
      intel: { signal: 'Dark Pool Buying', sub: 'Unusual institutional accumulation', value: '$148M', time: '1h ago', cat: 'darkpool' },
      technical: { setup: 'Breakout', detail: 'Above $140 resistance', level: 'Above $140', tf: 'Daily', quality: 4, cat: 'breakouts' },
      indicator: { signal: 'RSI Bounce', detail: 'RSI 38 → 52', value: '52', tf: '4H', cat: 'oscillators' }
    },
    {
      sym: 'BTCUSDT', name: 'Bitcoin', cls: 'crypto', price: '67,842.50', change: -1.32,
      bias: 'bearish', evidence: 7, strength: 3, signal: 'Sell', setup: 'At Resistance', tf: '4H + Live',
      classes: ['crypto'], biasTags: ['bearish', 'nearresistance', 'highvol'],
      why: [
        'ETF flows turned negative -4.6% on the session',
        'Heavy sell walls stacking at $69,200',
        'Bearish RSI + price divergence on 4H',
        'Rejected from prior range high'
      ],
      news: { headline: 'ETF Flows Negative', sub: 'Net outflows accelerate', reaction: -4.6, impact: 'high', time: '1h ago', cat: 'economic', sector: 'Crypto' },
      intel: { signal: 'Heavy Sell Walls', sub: 'Large asks at key levels', value: '$230M', time: '30m ago', cat: 'liquidity' },
      technical: { setup: 'At Resistance', detail: 'Testing $69,200', level: '$69,200', tf: '4H', quality: 4, cat: 'supportresistance' },
      indicator: { signal: 'Bearish Divergence', detail: 'RSI + Price', value: '64', tf: '4H', cat: 'oscillators' }
    },
    {
      sym: 'TSLA', name: 'Tesla Inc', cls: 'equity', price: '252.80', change: -0.62,
      bias: 'bearish', evidence: 5, strength: 2, signal: 'Sell', setup: 'Below VWAP', tf: '1D + Live',
      classes: ['equity'], biasTags: ['bearish', 'reversal'],
      why: [
        'Sold off on otherwise good news -6.8%',
        'Put flow $98M skewed bearish',
        'Trading below daily VWAP at $259.10',
        'RSI oversold but no bounce yet'
      ],
      news: { headline: 'Sold Off On Good News', sub: 'EPS beat, guidance weak', reaction: -6.8, impact: 'high', time: '3h ago', cat: 'earnings', sector: 'Consumer Cyclical' },
      intel: { signal: 'Put Flow', sub: 'Unusual put buying detected', value: '$98M', time: '2h ago', cat: 'unusualflow' },
      technical: { setup: 'Below VWAP', detail: 'VWAP $259.10', level: '$259.10', tf: '1D', quality: 3, cat: 'supportresistance' },
      indicator: { signal: 'RSI Oversold', detail: 'RSI 28', value: '28', tf: '1D', cat: 'oscillators' }
    },
    {
      sym: 'SOLUSDT', name: 'Solana', cls: 'crypto', price: '162.34', change: 2.11,
      bias: 'bullish', evidence: 7, strength: 3, signal: 'Buy', setup: 'Breakout', tf: '4H + Live',
      classes: ['crypto'], biasTags: ['bullish', 'breakout', 'highvol'],
      why: [
        'Network upgrade catalyst, price +5.3%',
        'Strong absorption of sell orders',
        'Breaking out above $158',
        'MACD bullish histogram expanding'
      ],
      news: { headline: 'Network Upgrade', sub: 'Throughput improvements ship', reaction: 5.3, impact: 'medium', time: '1h ago', cat: 'product', sector: 'Crypto' },
      intel: { signal: 'Absorption', sub: 'Buy orders absorbing sells', value: 'Strong', time: '15m ago', cat: 'absorption' },
      technical: { setup: 'Breakout', detail: 'Above $158', level: 'Above $158', tf: '4H', quality: 4, cat: 'breakouts' },
      indicator: { signal: 'MACD Bull Cross', detail: 'Histogram +', value: '12,26,9', tf: '4H', cat: 'momentum' }
    },
    {
      sym: 'AAPL', name: 'Apple Inc', cls: 'equity', price: '196.41', change: 1.12,
      bias: 'bullish', evidence: 6, strength: 2, signal: 'Buy', setup: 'Trend Continuation', tf: '1D + Live',
      classes: ['equity'], biasTags: ['bullish', 'pullback'],
      why: [
        'iPhone demand reading strong, +3.1%',
        'Institutional buying $112M accumulation',
        'Trend continuation above VWAP',
        'EMA20 holding above EMA50'
      ],
      news: { headline: 'iPhone Demand Strong', sub: 'Preorder estimates up', reaction: 3.1, impact: 'medium', time: '5h ago', cat: 'product', sector: 'Technology' },
      intel: { signal: 'Institutional Buying', sub: 'Accumulation pattern', value: '$112M', time: '1h ago', cat: 'blocktrades' },
      technical: { setup: 'Trend Continuation', detail: 'Above VWAP', level: 'Above VWAP', tf: '1D', quality: 4, cat: 'patterns' },
      indicator: { signal: 'EMA20 > EMA50', detail: 'Bullish stack', value: 'Bullish', tf: '1D', cat: 'trend' }
    },
    {
      sym: 'ETHUSDT', name: 'Ethereum', cls: 'crypto', price: '3,452.18', change: 0.85,
      bias: 'mixed', evidence: 5, strength: 2, signal: 'Watch', setup: 'Range Bound', tf: '4H + Live',
      classes: ['crypto'], biasTags: ['mixed', 'nearsupport'],
      why: [
        'Staking ETF filed, modest +1.2% reaction',
        'Whale accumulation $76M noted',
        'Range bound between $3,300 and $3,600',
        'Stochastic neutral at 52'
      ],
      news: { headline: 'Staking ETF Filed', sub: 'Issuer files for staking ETF', reaction: 1.2, impact: 'medium', time: '2h ago', cat: 'regulatory', sector: 'Crypto' },
      intel: { signal: 'Whale Accumulation', sub: 'Large wallets increasing', value: '$76M', time: '1h ago', cat: 'darkpool' },
      technical: { setup: 'Range Bound', detail: '$3,300 – $3,600', level: '$3,300 – $3,600', tf: '4H', quality: 3, cat: 'channels' },
      indicator: { signal: 'Stoch Neutral', detail: 'Stochastic 52', value: '52', tf: '4H', cat: 'oscillators' }
    },
    {
      sym: 'CL1!', name: 'Crude Oil Futures', cls: 'future', price: '78.62', change: 1.05,
      bias: 'bullish', evidence: 5, strength: 2, signal: 'Buy', setup: 'At Support', tf: '1H + Live',
      classes: ['future'], biasTags: ['bullish', 'nearsupport'],
      why: [
        'OPEC+ supply cuts, price +2.7%',
        'Oil futures buying $65M flow',
        'Bouncing from support at $77.80',
        'Volume confirmation on the bounce'
      ],
      news: { headline: 'OPEC+ Cuts Supply', sub: 'Output reduction extended', reaction: 2.7, impact: 'medium', time: '4h ago', cat: 'economic', sector: 'Energy' },
      intel: { signal: 'Oil Futures Buying', sub: 'Directional flow detected', value: '$65M', time: '3h ago', cat: 'unusualflow' },
      technical: { setup: 'At Support', detail: 'Bounce from $77.80', level: '$77.80', tf: '1H', quality: 3, cat: 'supportresistance' },
      indicator: { signal: 'Bounce Confirmed', detail: 'Volume +', value: 'Volume +', tf: '1H', cat: 'volume' }
    },
    {
      sym: 'SPY', name: 'SPDR S&P 500 ETF', cls: 'equity', price: '532.18', change: -0.18,
      bias: 'mixed', evidence: 4, strength: 1, signal: 'Watch', setup: 'Range Bound', tf: '1D + Live',
      classes: ['equity'], biasTags: ['mixed', 'nearresistance'],
      why: [
        'Fed speakers on deck, flat 0.0% reaction',
        'Mixed order flow, no clear bias',
        'Range bound $529 – $535',
        'RSI neutral at 48'
      ],
      news: { headline: 'Fed Speakers Today', sub: 'Multiple FOMC members speak', reaction: 0.0, impact: 'low', time: '1h ago', cat: 'economic', sector: 'Index' },
      intel: { signal: 'Mixed Flow', sub: 'Neutral positioning', value: 'Neutral', time: '1h ago', cat: 'unusualflow' },
      technical: { setup: 'Range Bound', detail: '$529 – $535', level: '$529 – $535', tf: '1D', quality: 2, cat: 'channels' },
      indicator: { signal: 'RSI Neutral', detail: 'RSI 48', value: '48', tf: '1D', cat: 'oscillators' }
    },
    {
      sym: 'AMZN', name: 'Amazon.com', cls: 'equity', price: '178.92', change: 2.43,
      bias: 'bullish', evidence: 7, strength: 3, signal: 'Buy', setup: 'Breakout', tf: '1D + Live',
      classes: ['equity'], biasTags: ['bullish', 'breakout', 'highvol'],
      why: [
        'Strong Prime Day sales, +3.8%',
        'Block trades $94M on the bid',
        'Breaking out of multi-week base',
        'ADX trending strongly'
      ],
      news: { headline: 'Strong Prime Day Sales', sub: 'Record breaking event', reaction: 3.8, impact: 'high', time: '3h ago', cat: 'earnings', sector: 'Consumer Cyclical' },
      intel: { signal: 'Block Trades', sub: 'Large prints on the bid', value: '$94M', time: '40m ago', cat: 'blocktrades' },
      technical: { setup: 'Breakout', detail: 'Multi-week base', level: 'Above $176', tf: '1D', quality: 4, cat: 'breakouts' },
      indicator: { signal: 'ADX Trending', detail: 'ADX 31', value: '31', tf: '1D', cat: 'trend' }
    },
    {
      sym: 'COIN', name: 'Coinbase Global', cls: 'equity', price: '241.55', change: 5.61,
      bias: 'bullish', evidence: 6, strength: 2, signal: 'Buy', setup: 'Reversal', tf: '1D + Live',
      classes: ['equity'], biasTags: ['bullish', 'reversal', 'highvol'],
      why: [
        'SEC investigation closed, +5.6%',
        'Iceberg buying detected at lows',
        'Reversal off prior support',
        'Volume spike 2.4x average'
      ],
      news: { headline: 'SEC Investigation Closed', sub: 'No enforcement action', reaction: 5.6, impact: 'medium', time: '5h ago', cat: 'regulatory', sector: 'Financial Services' },
      intel: { signal: 'Iceberg Orders', sub: 'Hidden buyers at lows', value: '$58M', time: '1h ago', cat: 'iceberg' },
      technical: { setup: 'Reversal', detail: 'Off prior support', level: 'From $228', tf: '1D', quality: 3, cat: 'patterns' },
      indicator: { signal: 'Volume Spike', detail: '2.4x average', value: '2.4x', tf: '1D', cat: 'volume' }
    },
    {
      sym: 'GC1!', name: 'Gold Futures', cls: 'future', price: '2,346.30', change: -0.18,
      bias: 'bearish', evidence: 5, strength: 2, signal: 'Sell', setup: 'Near Resistance', tf: '4H + Live',
      classes: ['future'], biasTags: ['bearish', 'nearresistance'],
      why: [
        'Stronger dollar pressuring metals',
        'Sell-side liquidity stacking overhead',
        'Rejected near resistance',
        'Stochastic rolling over from overbought'
      ],
      news: { headline: 'Dollar Strengthens', sub: 'DXY breaks higher', reaction: -0.18, impact: 'low', time: '2h ago', cat: 'economic', sector: 'Metals' },
      intel: { signal: 'Sell Liquidity', sub: 'Resting asks overhead', value: '$41M', time: '1h ago', cat: 'liquidity' },
      technical: { setup: 'Near Resistance', detail: 'Rejection wick', level: '$2,360', tf: '4H', quality: 3, cat: 'supportresistance' },
      indicator: { signal: 'Stoch Overbought', detail: 'Rolling over', value: '82', tf: '4H', cat: 'oscillators' }
    },
    {
      sym: 'MSFT', name: 'Microsoft Corp', cls: 'equity', price: '438.10', change: 0.92,
      bias: 'bullish', evidence: 6, strength: 2, signal: 'Buy', setup: 'Pullback', tf: '1D + Live',
      classes: ['equity'], biasTags: ['bullish', 'pullback'],
      why: [
        'Cloud growth narrative intact, +0.9%',
        'Steady institutional accumulation',
        'Pullback to rising 20-EMA holding',
        'Bollinger band squeeze resolving up'
      ],
      news: { headline: 'Cloud Growth Steady', sub: 'Azure momentum continues', reaction: 0.9, impact: 'low', time: '6h ago', cat: 'product', sector: 'Technology' },
      intel: { signal: 'Institutional Buying', sub: 'Accumulation pattern', value: '$130M', time: '2h ago', cat: 'darkpool' },
      technical: { setup: 'Pullback', detail: 'To rising 20-EMA', level: '20-EMA', tf: '1D', quality: 4, cat: 'patterns' },
      indicator: { signal: 'BB Squeeze', detail: 'Resolving up', value: 'Squeeze', tf: '1D', cat: 'volatility' }
    }
  ];

  const ASSET_BY_SYM = {};
  ASSETS.forEach(function (a) { ASSET_BY_SYM[a.sym] = a; });

  /* ---------------------------------------------------------------
     Saved scans (their own shape — not asset-backed)
     --------------------------------------------------------------- */
  const SAVED_SCANS = [
    { name: 'Earnings Breakout', desc: 'Earnings beat + breakout', freq: 'Real-time', lastRun: '1m ago', results: 14, cat: 'myscans' },
    { name: 'Dark Pool Buying', desc: 'Dark pool buys > $50M', freq: 'Real-time', lastRun: '2m ago', results: 23, cat: 'myscans' },
    { name: 'RSI Oversold Bounce', desc: 'RSI < 30 bouncing', freq: '15m', lastRun: '10m ago', results: 8, cat: 'myscans' },
    { name: 'Bullish Divergence', desc: 'Price lower low, RSI higher low', freq: 'Real-time', lastRun: '1m ago', results: 11, cat: 'alerts' },
    { name: 'High Volume Breakout', desc: 'Breakout on high volume', freq: 'Real-time', lastRun: '3m ago', results: 19, cat: 'alerts' },
    { name: 'Crypto Majors Watchlist', desc: 'BTC, ETH, SOL key levels', freq: 'Real-time', lastRun: '30s ago', results: 6, cat: 'watchlists' }
  ];

  /* ---------------------------------------------------------------
     Small render helpers (return HTML strings)
     --------------------------------------------------------------- */
  function changeStr(n) {
    const cls = n > 0 ? 'msx-up' : n < 0 ? 'msx-down' : 'msx-muted';
    const sign = n > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + n.toFixed(2) + '%</span>';
  }

  function assetCell(a) {
    return '<div class="msx-asset">' +
      '<span class="msx-asset-badge">' + a.sym.slice(0, 2) + '</span>' +
      '<span class="msx-asset-text">' +
      '<span class="msx-asset-sym">' + a.sym + '</span>' +
      '<span class="msx-asset-name">' + a.name + '</span>' +
      '</span></div>';
  }

  function biasCell(bias) {
    const icon = bias === 'bullish' ? 'arrow_upward' : bias === 'bearish' ? 'arrow_downward' : 'remove';
    const label = bias.charAt(0).toUpperCase() + bias.slice(1);
    return '<span class="msx-bias ' + bias + '"><span class="material-symbols-outlined">' + icon + '</span>' + label + '</span>';
  }

  function dots(n, total) {
    total = total || 3;
    let out = '<span class="strength-dots">';
    for (let i = 0; i < total; i++) out += '<span class="dot' + (i < n ? ' on' : '') + '"></span>';
    return out + '</span>';
  }

  function evidenceCell(a) {
    const label = a.evidence >= 7 ? 'High' : a.evidence >= 5 ? 'Medium' : 'Low';
    return '<div class="msx-evidence">' + dots(Math.round(a.evidence / 2), 5) +
      '<span class="msx-ev-text"><span class="msx-ev-label">' + label + '</span>' +
      '<span class="msx-ev-score">' + a.evidence + '/10</span></span></div>';
  }

  function signalBadge(sig) {
    const cls = sig === 'Buy' ? 'buy' : sig === 'Sell' ? 'sell' : 'neutral';
    return '<span class="signal-badge ' + cls + '">' + sig + '</span>';
  }

  function stackCell(main, sub, cls) {
    return '<div class="msx-stack"><span class="msx-stack-main ' + (cls || '') + '">' + main + '</span>' +
      (sub ? '<span class="msx-stack-sub">' + sub + '</span>' : '') + '</div>';
  }

  function starsCell(q) {
    let out = '<span class="msx-stars">';
    for (let i = 0; i < 5; i++) {
      out += '<span class="material-symbols-outlined' + (i < q ? '' : ' off') + '">' + (i < q ? 'star' : 'star') + '</span>';
    }
    return out + '</span>';
  }

  function impactCell(level) {
    return '<span class="msx-impact ' + level + '">' + level + '</span>';
  }

  function rowActions() {
    return '<div class="msx-row-actions">' +
      '<button class="msx-row-btn" data-act="chart" title="Open chart"><span class="material-symbols-outlined">show_chart</span></button>' +
      '<button class="msx-row-btn" data-act="alert" title="Set alert"><span class="material-symbols-outlined">notifications</span></button>' +
      '<button class="msx-row-btn" data-act="watch" title="Add to watchlist"><span class="material-symbols-outlined">star</span></button>' +
      '</div>';
  }

  /* ---------------------------------------------------------------
     Tab configuration — columns, chips, and how rows are built
     --------------------------------------------------------------- */
  function buildRows(mapper) { return ASSETS.map(mapper); }

  const TABS = {
    livefeed: {
      chips: [['all', 'All'], ['bullish', 'Bullish'], ['bearish', 'Bearish'], ['breakout', 'Breakouts'], ['highvol', 'High Volume'], ['nearsupport', 'Near Support'], ['nearresistance', 'Near Resistance']],
      columns: [
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Price', cls: 'num', render: function (a) { return '$' + a.price; } },
        { label: 'Change', cls: 'num', render: function (a) { return changeStr(a.change); } },
        { label: 'Bias', render: function (a) { return biasCell(a.bias); } },
        { label: 'Evidence', render: function (a) { return evidenceCell(a); } },
        { label: 'Signal', render: function (a) { return signalBadge(a.signal); } },
        { label: 'Strength', render: function (a) { return dots(a.strength); } },
        { label: 'Timeframe', render: function (a) { return '<span class="msx-muted">' + a.tf + '</span>'; } },
        { label: '', cls: 'num', render: function () { return rowActions(); } }
      ],
      rows: function () { return ASSETS.map(function (a) { return { a: a, tags: a.biasTags, sortChange: a.change, sortStrength: a.strength }; }); }
    },
    indicators: {
      chips: [['all', 'All'], ['momentum', 'Momentum'], ['oscillators', 'Oscillators'], ['volume', 'Volume'], ['trend', 'Trend'], ['volatility', 'Volatility']],
      columns: [
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Signal', render: function (a) { return stackCell(a.indicator.signal, null, a.bias === 'bullish' ? 'msx-up' : a.bias === 'bearish' ? 'msx-down' : ''); } },
        { label: 'Detail', render: function (a) { return '<span class="msx-muted">' + a.indicator.detail + '</span>'; } },
        { label: 'Value', cls: 'num', render: function (a) { return '<span class="msx-value">' + a.indicator.value + '</span>'; } },
        { label: 'Timeframe', cls: 'num', render: function (a) { return '<span class="msx-muted">' + a.indicator.tf + '</span>'; } },
        { label: 'Strength', cls: 'num', render: function (a) { return dots(a.strength); } }
      ],
      rows: function () { return ASSETS.map(function (a) { return { a: a, tags: [a.indicator.cat], sortChange: a.change, sortStrength: a.strength }; }); }
    },
    chartprime: {
      chips: [['all', 'All'], ['darkpool', 'Dark Pool'], ['blocktrades', 'Block Trades'], ['iceberg', 'Iceberg'], ['absorption', 'Absorption'], ['unusualflow', 'Unusual Flow'], ['liquidity', 'Liquidity']],
      columns: [
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Signal', render: function (a) { return stackCell(a.intel.signal, null, 'msx-intel'); } },
        { label: 'Details', render: function (a) { return '<span class="msx-muted">' + a.intel.sub + '</span>'; } },
        { label: 'Value', cls: 'num', render: function (a) { return '<span class="msx-value">' + a.intel.value + '</span>'; } },
        { label: 'Time', cls: 'num', render: function (a) { return '<span class="msx-muted">' + a.intel.time + '</span>'; } },
        { label: 'Strength', cls: 'num', render: function (a) { return dots(a.strength); } }
      ],
      rows: function () { return ASSETS.map(function (a) { return { a: a, tags: [a.intel.cat], sortChange: a.change, sortStrength: a.strength }; }); }
    },
    news: {
      chips: [['all', 'All'], ['earnings', 'Earnings'], ['economic', 'Economic'], ['regulatory', 'Regulatory'], ['product', 'Product']],
      columns: [
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Headline', render: function (a) { return stackCell(a.news.headline, a.news.sub); } },
        { label: 'Impact', render: function (a) { return impactCell(a.news.impact); } },
        { label: 'Price Reaction', cls: 'num', render: function (a) { return changeStr(a.news.reaction); } },
        { label: 'Time', cls: 'num', render: function (a) { return '<span class="msx-muted">' + a.news.time + '</span>'; } },
        { label: 'Sector', cls: 'num', render: function (a) { return '<span class="msx-muted">' + a.news.sector + '</span>'; } }
      ],
      rows: function () { return ASSETS.map(function (a) { return { a: a, tags: [a.news.cat], sortChange: a.news.reaction, sortStrength: a.evidence }; }); }
    },
    technical: {
      chips: [['all', 'All'], ['patterns', 'Patterns'], ['supportresistance', 'Support/Resistance'], ['breakouts', 'Breakouts'], ['channels', 'Channels']],
      columns: [
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Setup', render: function (a) { return stackCell(a.technical.setup, null); } },
        { label: 'Details', render: function (a) { return '<span class="msx-muted">' + a.technical.detail + '</span>'; } },
        { label: 'Level', render: function (a) { return '<span class="msx-value">' + a.technical.level + '</span>'; } },
        { label: 'Timeframe', render: function (a) { return '<span class="msx-muted">' + a.technical.tf + '</span>'; } },
        { label: 'Quality', cls: 'num', render: function (a) { return starsCell(a.technical.quality); } }
      ],
      rows: function () { return ASSETS.map(function (a) { return { a: a, tags: [a.technical.cat], sortChange: a.change, sortStrength: a.technical.quality }; }); }
    },
    saved: {
      chips: [['all', 'All'], ['myscans', 'My Scans'], ['alerts', 'Alerts'], ['watchlists', 'Watchlists']],
      columns: [
        { label: 'Scan Name', render: function (s) { return '<span class="msx-stack-main">' + s.name + '</span>'; } },
        { label: 'Description', render: function (s) { return '<span class="msx-muted">' + s.desc + '</span>'; } },
        { label: 'Frequency', render: function (s) { return '<span class="msx-muted">' + s.freq + '</span>'; } },
        { label: 'Last Run', render: function (s) { return '<span class="msx-muted">' + s.lastRun + '</span>'; } },
        { label: 'Results', cls: 'num', render: function (s) { return '<span class="msx-value">' + s.results + '</span>'; } },
        { label: '', cls: 'num', render: function () { return '<button class="msx-run-btn"><span class="material-symbols-outlined">play_arrow</span>Run</button>'; } }
      ],
      rows: function () { return SAVED_SCANS.map(function (s) { return { s: s, tags: [s.cat], sortChange: s.results, sortStrength: s.results }; }); },
      noDetail: true
    },
    ai: {
      chips: [],
      columns: [
        { label: '#', cls: 'num', render: function (a, row) { return '<span class="msx-rank">' + row.rank + '</span>'; } },
        { label: 'Asset', render: function (a) { return assetCell(a); } },
        { label: 'Match', render: function (a, row) { return stackCell(row.match, null, 'msx-intel'); } },
        { label: 'Why it matched', render: function (a, row) { return '<span class="msx-muted">' + row.reason + '</span>'; } },
        { label: 'Change', cls: 'num', render: function (a) { return changeStr(a.change); } },
        { label: 'Score', cls: 'num', render: function (a, row) { return scoreCell(row.score); } }
      ],
      rows: function () { return (aiState.results || []).map(function (r) { return { a: r.a, rank: r.rank, match: r.match, reason: r.reason, score: r.score, tags: ['all'], sortChange: r.a.change, sortStrength: r.score }; }); }
    }
  };

  function scoreCell(score) {
    return '<span class="msx-score"><span class="msx-score-bar"><span class="msx-score-fill" style="width:' + score + '%"></span></span>' +
      '<span class="msx-score-num">' + score + '</span></span>';
  }

  /* ---------------------------------------------------------------
     State
     --------------------------------------------------------------- */
  const state = { tab: 'livefeed', filter: 'all', search: '', sort: 'rank', selected: 'NVDA' };
  const aiState = { results: null, query: '' };

  /* ---------------------------------------------------------------
     DOM refs
     --------------------------------------------------------------- */
  const tabsEl = document.getElementById('msxTabs');
  const chipsEl = document.getElementById('msxChips');
  const hostEl = document.getElementById('msxTableHost');
  const countEl = document.getElementById('msxCount');
  const detailEl = document.getElementById('msxDetail');
  const searchEl = document.getElementById('msxSearch');
  const sortSelect = document.getElementById('msxSort');
  const aiForm = document.getElementById('msxAiForm');
  const aiInput = document.getElementById('msxAiInput');

  /* ---------------------------------------------------------------
     Rendering
     --------------------------------------------------------------- */
  function renderChips() {
    const cfg = TABS[state.tab];
    chipsEl.innerHTML = cfg.chips.map(function (c) {
      return '<button class="filter-chip' + (state.filter === c[0] ? ' active' : '') + '" data-tag="' + c[0] + '">' + c[1] + '</button>';
    }).join('');
  }

  function filteredRows() {
    const cfg = TABS[state.tab];
    let rows = cfg.rows();
    if (state.filter !== 'all') {
      rows = rows.filter(function (r) { return (r.tags || []).indexOf(state.filter) !== -1; });
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        if (r.a) return r.a.sym.toLowerCase().indexOf(q) !== -1 || r.a.name.toLowerCase().indexOf(q) !== -1;
        if (r.s) return r.s.name.toLowerCase().indexOf(q) !== -1 || r.s.desc.toLowerCase().indexOf(q) !== -1;
        return true;
      });
    }
    if (state.sort === 'change') rows = rows.slice().sort(function (a, b) { return b.sortChange - a.sortChange; });
    else if (state.sort === 'strength') rows = rows.slice().sort(function (a, b) { return b.sortStrength - a.sortStrength; });
    else if (state.sort === 'symbol') rows = rows.slice().sort(function (a, b) { return (a.a ? a.a.sym : a.s.name).localeCompare(b.a ? b.a.sym : b.s.name); });
    return rows;
  }

  function renderTable() {
    const cfg = TABS[state.tab];

    // AI tab with no scan yet → friendly empty state
    if (state.tab === 'ai' && !aiState.results) {
      hostEl.innerHTML = aiEmptyHtml();
      countEl.textContent = '';
      pagerEl.innerHTML = '';
      wireAiExamples();
      return;
    }

    const all = filteredRows();

    const head = '<thead><tr>' + cfg.columns.map(function (c) {
      return '<th class="' + (c.cls || '') + '">' + c.label + '</th>';
    }).join('') + '</tr></thead>';

    const body = '<tbody>' + all.map(function (row) {
      const subject = row.a || row.s;
      const sym = row.a ? row.a.sym : '';
      const sel = sym && sym === state.selected ? ' class="selected"' : '';
      const cells = cfg.columns.map(function (c) {
        return '<td class="' + (c.cls || '') + '">' + c.render(subject, row) + '</td>';
      }).join('');
      return '<tr data-sym="' + sym + '"' + sel + '>' + cells + '</tr>';
    }).join('') + '</tbody>';

    const banner = (state.tab === 'ai' && aiState.results) ? aiBannerHtml() : '';
    hostEl.innerHTML = banner + '<table class="msx-table">' + head + body + '</table>';

    countEl.textContent = all.length + ' result' + (all.length === 1 ? '' : 's');
  }

  function renderDetail() {
    const cfg = TABS[state.tab];
    if (cfg.noDetail) {
      detailEl.innerHTML = '<div class="msx-d-empty"><span class="material-symbols-outlined">bookmark</span>' +
        'Select a saved scan and press Run to populate live results.</div>';
      return;
    }
    const a = ASSET_BY_SYM[state.selected];
    if (!a) {
      detailEl.innerHTML = '<div class="msx-d-empty"><span class="material-symbols-outlined">ads_click</span>' +
        'Select a row to see the full breakdown.</div>';
      return;
    }
    const evLabel = a.evidence >= 7 ? 'High' : a.evidence >= 5 ? 'Medium' : 'Low';
    detailEl.innerHTML =
      '<div class="msx-d-head">' +
      '<span class="msx-asset-badge">' + a.sym.slice(0, 2) + '</span>' +
      '<span class="msx-d-head-text"><span class="msx-d-sym">' + a.sym + '</span>' +
      '<span class="msx-d-name">' + a.name + '</span></span></div>' +

      '<div class="msx-d-meta">' +
      '<div class="msx-d-meta-col"><div class="msx-ov-lbl">Price</div>' +
      '<div class="msx-d-price">$' + a.price + '</div></div>' +
      '<div class="msx-d-meta-col"><div class="msx-ov-lbl">Change (1D)</div>' +
      '<div class="msx-d-change">' + changeStr(a.change) + '</div></div>' +
      '</div>' +

      '<div class="msx-d-section"><div class="msx-d-bias-row">' +
      biasCell(a.bias) + evidenceCell(a) + '</div></div>' +

      '<div class="msx-d-section"><div class="msx-d-label">Why it’s showing</div>' +
      '<div class="msx-d-why-list">' + a.why.map(function (w) {
        return '<div class="msx-d-why-item"><span class="msx-d-why-dot"></span>' + w + '</div>';
      }).join('') + '</div></div>' +

      detailRow('News (w/ price reaction)', a.news.headline, a.news.sub, changeStr(a.news.reaction), a.news.time) +
      detailRow('ChartPrime Intelligence', a.intel.signal, a.intel.sub, '<span class="msx-intel">' + a.intel.value + '</span>', a.intel.time) +
      detailRow('Technical Analysis', a.technical.setup, a.technical.detail, a.technical.level, a.technical.tf) +
      detailRow('Indicators', a.indicator.signal, a.indicator.detail, a.indicator.value, a.indicator.tf) +

      '<div class="msx-d-actions">' +
      '<button class="msx-d-btn primary"><span class="material-symbols-outlined">show_chart</span>Open Chart</button>' +
      '<div class="msx-d-btn-row">' +
      '<button class="msx-d-btn"><span class="material-symbols-outlined">notifications</span>Set Alert</button>' +
      '<button class="msx-d-btn"><span class="material-symbols-outlined">star</span>Watchlist</button>' +
      '</div></div>';
  }

  function detailRow(label, main, sub, val, time) {
    return '<div class="msx-d-section"><div class="msx-d-label">' + label + '</div>' +
      '<div class="msx-d-row"><div><div class="msx-d-row-main">' + main + '</div>' +
      '<div class="msx-d-row-sub">' + sub + '</div></div>' +
      '<div style="text-align:right"><div class="msx-d-row-val">' + val + '</div>' +
      '<div class="msx-d-row-sub">' + time + '</div></div></div></div>';
  }

  function render() {
    renderChips();
    renderTable();
    renderDetail();
  }

  /* ---------------------------------------------------------------
     AI scan (mock) — parses keywords into criteria chips and produces
     a ranked, scored result set.
     --------------------------------------------------------------- */
  const AI_EXAMPLES = [
    'Top 100 cryptos with bullish divergence near major support',
    'Large-cap stocks breaking out on 2x volume',
    'Oversold names with dark pool accumulation'
  ];

  function aiEmptyHtml() {
    return '<div class="msx-empty">' +
      '<div class="msx-empty-icon"><span class="material-symbols-outlined">auto_awesome</span></div>' +
      '<div class="msx-empty-title">Ask AI to scan the market</div>' +
      '<div class="msx-empty-sub">Describe the setup you want in plain language and the scanner will rank matching assets across every category.</div>' +
      '<div class="msx-empty-examples">' + AI_EXAMPLES.map(function (ex) {
        return '<button class="msx-example-chip" data-example="' + ex.replace(/"/g, '&quot;') + '">' + ex + '</button>';
      }).join('') + '</div></div>';
  }

  function wireAiExamples() {
    hostEl.querySelectorAll('.msx-example-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        aiInput.value = chip.dataset.example;
        runAiScan(chip.dataset.example);
      });
    });
  }

  function parseCriteria(query) {
    const q = query.toLowerCase();
    const found = [];
    const map = [
      ['crypto', 'tune', 'Asset class: Crypto'],
      ['stock', 'tune', 'Asset class: Stocks'],
      ['large-cap', 'tune', 'Large cap'],
      ['top 100', 'leaderboard', 'Universe: Top 100'],
      ['divergence', 'trending_down', 'Divergence'],
      ['support', 'south', 'Near support'],
      ['resistance', 'north', 'Near resistance'],
      ['breakout', 'open_in_full', 'Breakout'],
      ['volume', 'bar_chart', 'Elevated volume'],
      ['oversold', 'arrow_downward', 'Oversold'],
      ['overbought', 'arrow_upward', 'Overbought'],
      ['dark pool', 'visibility_off', 'Dark pool activity'],
      ['accumulation', 'add_circle', 'Accumulation']
    ];
    map.forEach(function (m) { if (q.indexOf(m[0]) !== -1) found.push([m[1], m[2]]); });
    if (!found.length) found.push(['auto_awesome', 'Best matching setups']);
    return found;
  }

  function runAiScan(query) {
    query = (query || '').trim();
    if (!query) return;
    aiState.query = query;
    const q = query.toLowerCase();

    // Asset class is a hard filter; everything else just boosts the rank.
    let pool = ASSETS.slice();
    if (q.indexOf('crypto') !== -1) pool = pool.filter(function (a) { return a.cls === 'crypto'; });
    else if (q.indexOf('stock') !== -1 || q.indexOf('large-cap') !== -1 || q.indexOf('equit') !== -1) pool = pool.filter(function (a) { return a.cls === 'equity'; });
    if (!pool.length) pool = ASSETS.slice();

    function relevance(a) {
      let s = a.evidence + Math.abs(a.change);
      if (q.indexOf('bullish') !== -1 && a.bias === 'bullish') s += 4;
      if (q.indexOf('bearish') !== -1 && a.bias === 'bearish') s += 4;
      if (q.indexOf('support') !== -1 && a.biasTags.indexOf('nearsupport') !== -1) s += 3;
      if (q.indexOf('resistance') !== -1 && a.biasTags.indexOf('nearresistance') !== -1) s += 3;
      if (q.indexOf('breakout') !== -1 && a.biasTags.indexOf('breakout') !== -1) s += 3;
      if (q.indexOf('volume') !== -1 && a.biasTags.indexOf('highvol') !== -1) s += 3;
      return s;
    }

    pool.sort(function (a, b) { return relevance(b) - relevance(a); });
    const results = pool.slice(0, 8).map(function (a, i) {
      return {
        a: a,
        rank: i + 1,
        score: Math.max(58, 97 - i * 5),
        match: a.technical.setup + ' · ' + (a.bias === 'bullish' ? 'Bullish' : a.bias === 'bearish' ? 'Bearish' : 'Mixed'),
        reason: a.why[0]
      };
    });

    aiState.results = results;
    state.tab = 'ai';
    state.filter = 'all';
    state.selected = results.length ? results[0].a.sym : null;
    syncTabs();
    render();
  }

  function clearAiScan() {
    aiState.results = null;
    aiState.query = '';
    aiInput.value = '';
    render();
  }

  function aiBannerHtml() {
    const criteria = parseCriteria(aiState.query).map(function (c) {
      return '<span class="msx-criteria-chip"><span class="material-symbols-outlined">' + c[0] + '</span>' + c[1] + '</span>';
    }).join('');
    return '<div class="msx-ai-banner">' +
      '<span class="msx-ai-banner-icon"><span class="material-symbols-outlined">auto_awesome</span></span>' +
      '<div class="msx-ai-banner-body">' +
      '<div class="msx-ai-banner-query">“' + aiState.query + '”</div>' +
      '<div class="msx-ai-criteria">' + criteria + '</div></div>' +
      '<button class="msx-ai-clear" id="msxAiClear"><span class="material-symbols-outlined">close</span>Clear</button>' +
      '</div>';
  }

  /* ---------------------------------------------------------------
     Tab + control wiring
     --------------------------------------------------------------- */
  function syncTabs() {
    tabsEl.querySelectorAll('.msx-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === state.tab);
    });
  }

  function setTab(tab) {
    if (!TABS[tab]) return;
    state.tab = tab;
    state.filter = 'all';
    // default-select the first asset-backed row of the new tab
    const rows = TABS[tab].rows();
    state.selected = rows.length && rows[0].a ? rows[0].a.sym : state.selected;
    syncTabs();
    render();
  }

  tabsEl.addEventListener('click', function (e) {
    const tab = e.target.closest('.msx-tab');
    if (tab) setTab(tab.dataset.tab);
  });

  chipsEl.addEventListener('click', function (e) {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    state.filter = chip.dataset.tag;
    render();
  });

  hostEl.addEventListener('click', function (e) {
    // clear AI scan
    if (e.target.closest('#msxAiClear')) { clearAiScan(); return; }
    // row selection (asset-backed rows only)
    const tr = e.target.closest('tr[data-sym]');
    if (tr && tr.dataset.sym) {
      state.selected = tr.dataset.sym;
      hostEl.querySelectorAll('tbody tr').forEach(function (r) { r.classList.toggle('selected', r.dataset.sym === state.selected); });
      renderDetail();
    }
  });

  searchEl.addEventListener('input', function () {
    state.search = searchEl.value;
    renderTable();
  });

  if (sortSelect) sortSelect.addEventListener('change', function () {
    state.sort = sortSelect.value;
    renderTable();
  });

  if (aiForm) aiForm.addEventListener('submit', function (e) {
    e.preventDefault();
    runAiScan(aiInput.value);
  });

  /* ---------------------------------------------------------------
     Open / close
     --------------------------------------------------------------- */
  let rendered = false;
  function openScanner() {
    backdrop.classList.add('show');
    trigger.classList.add('active');
    if (!rendered) { render(); rendered = true; }
  }
  function closeScanner() {
    backdrop.classList.remove('show');
    trigger.classList.remove('active');
  }
  function isOpen() { return backdrop.classList.contains('show'); }

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isOpen()) closeScanner(); else openScanner();
  });

  document.getElementById('msxClose').addEventListener('click', closeScanner);

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) closeScanner();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); closeScanner(); }
  });

  // header window-action stubs (visual only, consistent with the mockup)
  ['msxRefresh', 'msxColumns', 'msxExport'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', function (e) { e.stopPropagation(); });
  });
})();
