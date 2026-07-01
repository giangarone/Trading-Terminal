(function () {
  const input = document.getElementById('askAiInput');
  const sendBtn = document.getElementById('askAiSend');
  const output = document.getElementById('askAiOutput');
  const responses = [
    "Based on your current ETH position (+$2,800 unrealized) and today's range, price is holding above the 4,495 support zone. Momentum is fading near session highs — consider tightening your stop if you want to protect gains, or waiting for a retest of support before adding size.",
    "Your win rate this week is running above your 90-day average. The main drag has been a handful of trades held past your planned exit — tightening time-based exits could improve expectancy without changing your setup selection.",
    "Volatility has compressed over the last few sessions, which typically precedes a directional move. Given your current long bias, a break above day high with rising volume would confirm continuation; a failure there favors fading back toward VWAP."
  ];
  let respIdx = 0;
  function submitAsk() {
    const q = input.value.trim();
    if (!q || sendBtn.disabled) return;
    sendBtn.disabled = true;
    output.innerHTML = '<div class="ai-thinking"><span class="dots"><span></span><span></span><span></span></span>Thinking about your trade…</div>';
    input.value = '';
    setTimeout(() => {
      const resp = responses[respIdx % responses.length];
      respIdx++;
      output.innerHTML =
        '<div class="ai-response-box"><div class="ai-resp-head"><span class="material-symbols-outlined">auto_awesome</span>AI Assistant</div>' +
        resp + '</div>';
      sendBtn.disabled = false;
    }, 1100);
  }
  sendBtn.addEventListener('click', submitAsk);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAsk(); } });
})();

/* ---------- trading journal: shared real-trade data helpers ----------
   Quick trades and chart trades both fill through app.js's order engine, which
   appends each closed round-trip to window.tradeHistory (role: 'close', with a
   realized pnl). The journal treats one such entry as one logged trade. Pieces
   below register a refresh callback so they all re-sync when app.js reports a
   new close via window.refreshTodayJournalCard(). */
function getJournalTrades() {
  return (window.tradeHistory || []).filter(t => t.role === 'close');
}
function computeJournalStats(trades) {
  if (!trades.length) return { pnl: 0, trades: 0, winRate: 0, best: 0, worst: 0 };
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p >= 0).length;
  return {
    pnl: pnls.reduce((sum, p) => sum + p, 0),
    trades: trades.length,
    winRate: Math.round((wins / trades.length) * 100),
    best: Math.max(...pnls),
    worst: Math.min(...pnls)
  };
}
const journalRefreshFns = [];
function registerJournalRefresh(fn) { journalRefreshFns.push(fn); }
window.refreshTodayJournalCard = function () { journalRefreshFns.forEach(fn => fn()); };

/* ---------- trading journal: day selector ---------- */
(function () {
  const journalDays = [
    { label: 'Today', pnl: 0, trades: 0, winRate: 0, best: 0, worst: 0 },
    { label: 'Jun 24', pnl: 1180.00, trades: 6, winRate: 67, best: 800.00, worst: -220.00 },
    { label: 'Jun 23', pnl: -640.00, trades: 5, winRate: 40, best: 510.00, worst: -560.00 },
    { label: 'Jun 20', pnl: 0.00, trades: 0, winRate: 0, best: 0.00, worst: 0.00 },
    { label: 'Jun 19', pnl: 2110.00, trades: 9, winRate: 78, best: 990.00, worst: -180.00 },
  ];
  let selectedDayIdx = 0;
  const tjDaySelect = document.getElementById('tjDaySelect');
  const tjDayMenu = document.getElementById('tjDayMenu');
  const tjDayLabel = document.getElementById('tjDayLabel');
  const tjPnl = document.getElementById('tjPnl');
  const tjTrades = document.getElementById('tjTrades');
  const tjWinRate = document.getElementById('tjWinRate');
  const tjBest = document.getElementById('tjBest');
  const tjWorst = document.getElementById('tjWorst');
  function fmtSigned(n) {
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function showJournalDay(idx) {
    const d = journalDays[idx];
    tjDayLabel.textContent = d.label;
    tjPnl.textContent = fmtSigned(d.pnl);
    tjPnl.classList.toggle('up', d.pnl >= 0);
    tjPnl.classList.toggle('down', d.pnl < 0);
    tjTrades.textContent = d.trades;
    tjWinRate.textContent = d.winRate + '%';
    tjBest.textContent = fmtSigned(d.best);
    tjWorst.textContent = fmtSigned(d.worst);
  }
  function closeAllPopoversLocal() {
    document.querySelectorAll('.pop-menu.show, .ctx-menu.show').forEach(m => m.classList.remove('show'));
  }
  tjDaySelect.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tjDayMenu.classList.contains('show')) {
      closeAllPopoversLocal();
      return;
    }
    closeAllPopoversLocal();
    const anchorRect = tjDaySelect.getBoundingClientRect();
    tjDayMenu.classList.add('show');
    const vh = window.innerHeight;
    const h = tjDayMenu.offsetHeight;
    let y = anchorRect.bottom + 8;
    if (y + h > vh - 12) y = anchorRect.top - h - 8;
    tjDayMenu.style.left = anchorRect.left + 'px';
    tjDayMenu.style.top = y + 'px';
  });
  tjDayMenu.querySelectorAll('.pop-item').forEach(item => {
    item.addEventListener('click', () => {
      selectedDayIdx = parseInt(item.dataset.day);
      tjDayMenu.querySelectorAll('.pop-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      showJournalDay(selectedDayIdx);
      closeAllPopoversLocal();
    });
  });

  registerJournalRefresh(function () {
    journalDays[0] = Object.assign({ label: 'Today' }, computeJournalStats(getJournalTrades()));
    if (selectedDayIdx === 0) showJournalDay(0);
  });
})();

/* ---------- trading journal: full calendar modal ---------- */
(function () {
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const SYMBOLS = ['ETHUSD', 'NQU5', 'BTCUSD', 'SOLUSD', 'EURUSD', 'NVDA', 'YMU5'];
  const today = new Date(2026, 5, 25); // Thursday June 25, 2026
  let viewYear = today.getFullYear(), viewMonth = today.getMonth();

  const backdrop = document.getElementById('tjModalBackdrop');
  const openBtn = document.getElementById('tjOpenModal');
  const closeBtn = document.getElementById('tjModalClose');
  const prevBtn = document.getElementById('tjModalPrevBtn');
  const nextBtn = document.getElementById('tjModalNextBtn');
  const monthLbl = document.getElementById('tjModalMonthLbl');
  const grid = document.getElementById('tjModalGrid');

  const statMonthPnl = document.getElementById('tjmMonthPnl');
  const statWinRate = document.getElementById('tjmWinRate');
  const statTrades = document.getElementById('tjmTrades');
  const statTradingDays = document.getElementById('tjmTradingDays');
  const statBestDay = document.getElementById('tjmBestDay');
  const statWorstDay = document.getElementById('tjmWorstDay');

  const sidebarDate = document.getElementById('tjSidebarDate');
  const sidebarDateHint = document.getElementById('tjSidebarDateHint');
  const sidebarPnl = document.getElementById('tjSidebarPnl');
  const sidebarWinRate = document.getElementById('tjSidebarWinRate');
  const sidebarTrades = document.getElementById('tjSidebarTrades');
  const sidebarAvg = document.getElementById('tjSidebarAvg');
  const sidebarTradesCount = document.getElementById('tjSidebarTradesCount');
  const sidebarTradeList = document.getElementById('tjSidebarTradeList');

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fmtSigned(n) {
    return (n < 0 ? '-' : '+') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }

  function generateTrades(data, rand) {
    const trades = [];
    for (let i = 0; i < data.trades; i++) {
      const isWin = i < data.wins;
      const hour = 8 + Math.floor(rand() * 9);
      const min = Math.floor(rand() * 60);
      const ampm = hour < 12 ? 'AM' : 'PM';
      const pnl = isWin ? Math.round(60 + rand() * 1100) : -Math.round(40 + rand() * 550);
      trades.push({
        time: (hour % 12 || 12) + ':' + String(min).padStart(2, '0') + ' ' + ampm,
        sym: SYMBOLS[Math.floor(rand() * SYMBOLS.length)],
        side: rand() > 0.5 ? 'Long' : 'Short',
        pnl
      });
    }
    return trades.sort((a, b) => a.time < b.time ? -1 : 1);
  }

  /* tradeHistory close entries record the side of the closing leg, not the
     position — flip it to show the position direction the journal trade represents. */
  function realTodayTrades() {
    return getJournalTrades().slice().reverse().map(t => ({
      time: t.time,
      sym: t.symbol,
      side: t.side === 'sell' ? 'Long' : 'Short',
      pnl: t.pnl
    }));
  }

  function showSidebarDay(data) {
    const isToday = data.day === today.getDate() && viewYear === today.getFullYear() && viewMonth === today.getMonth();
    sidebarDate.textContent = data.dateLbl + ', ' + viewYear;
    sidebarDateHint.textContent = isToday ? 'Today' : '';

    sidebarPnl.textContent = fmtSigned(data.pnl);
    sidebarPnl.className = 'tj-sidebar-kpi-val ' + (data.pnl >= 0 ? 'up' : 'down');

    sidebarWinRate.textContent = data.winRate + '%';
    sidebarWinRate.className = 'tj-sidebar-kpi-val';

    sidebarTrades.textContent = data.trades;
    sidebarTrades.className = 'tj-sidebar-kpi-val';

    const avg = data.trades > 0 ? data.pnl / data.trades : 0;
    sidebarAvg.textContent = fmtSigned(avg);
    sidebarAvg.className = 'tj-sidebar-kpi-val ' + (avg >= 0 ? 'up' : 'down');

    sidebarTradesCount.textContent = data.trades + ' trade' + (data.trades !== 1 ? 's' : '');

    const tradeList = isToday
      ? realTodayTrades()
      : generateTrades(data, mulberry32(8800 + viewYear * 100 + viewMonth * 31 + data.day));
    sidebarTradeList.innerHTML = tradeList.map(t => {
      return '<div class="tj-trade-row">' +
        '<span class="tj-trade-time">' + t.time + '</span>' +
        '<span class="tj-trade-sym">' + t.sym + '</span>' +
        '<span class="tj-trade-side ' + t.side.toLowerCase() + '">' + t.side + '</span>' +
        '<span class="tj-trade-pnl ' + (t.pnl >= 0 ? 'up' : 'down') + '">' + fmtSigned(t.pnl) + '</span>' +
        '</div>';
    }).join('');
  }

  function clearSidebar() {
    sidebarDate.textContent = 'Select a trading day';
    sidebarDateHint.textContent = '';
    ['sidebarPnl', 'sidebarWinRate', 'sidebarTrades', 'sidebarAvg'].forEach(id => {
      const el = { sidebarPnl, sidebarWinRate, sidebarTrades, sidebarAvg }[id];
      el.textContent = '—';
      el.className = 'tj-sidebar-kpi-val';
    });
    sidebarTradesCount.textContent = '';
    sidebarTradeList.innerHTML =
      '<div class="tj-sidebar-empty">' +
      '<span class="material-symbols-outlined">touch_app</span>' +
      '<span class="tj-sidebar-empty-text">Click a trading day<br>to view trade details</span>' +
      '</div>';
  }

  function buildCalendar() {
    const rand = mulberry32(5530 + viewYear * 100 + viewMonth);
    monthLbl.textContent = MONTH_NAMES[viewMonth] + ' ' + viewYear;
    grid.innerHTML = '';

    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
      const el = document.createElement('div');
      el.className = 'jc-dow';
      el.textContent = d;
      grid.appendChild(el);
    });

    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (let i = 0; i < firstDow; i++) {
      const el = document.createElement('div');
      el.className = 'jc-day empty';
      grid.appendChild(el);
    }

    let monthPnl = 0, totalTrades = 0, totalWins = 0, tradingDays = 0;
    let bestPnl = null, worstPnl = null, todayData = null;

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(viewYear, viewMonth, day);
      const isFuture = date > today;
      const isToday = viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();

      const el = document.createElement('div');
      el.className = 'jc-day';
      if (isFuture) el.classList.add('future');
      if (isToday) el.classList.add('today');

      const numRow = document.createElement('div');
      numRow.className = 'd-num-row';
      const numSpan = document.createElement('span');
      numSpan.className = 'd-num';
      numSpan.textContent = day;
      numRow.appendChild(numSpan);
      if (isToday) {
        const tag = document.createElement('span');
        tag.className = 'd-today-tag';
        tag.textContent = 'Today';
        numRow.appendChild(tag);
      }
      el.appendChild(numRow);

      if (!isFuture) {
        let data = null;

        if (isToday) {
          // Real trades placed this session, same source as the small card widget
          const realTrades = getJournalTrades();
          const stats = computeJournalStats(realTrades);
          if (stats.trades > 0) {
            const wins = realTrades.filter(t => t.pnl >= 0).length;
            data = { day, pnl: stats.pnl, trades: stats.trades, wins, losses: stats.trades - wins, winRate: stats.winRate, dateLbl: MONTH_NAMES[viewMonth].slice(0, 3) + ' ' + day };
          }
        } else {
          const hasTrades = rand() > 0.22;
          if (hasTrades) {
            const pnl = Math.round((rand() - 0.42) * 3200);
            const trades = Math.max(1, Math.round(1 + rand() * 7));
            const winRatio = pnl >= 0 ? (0.55 + rand() * 0.35) : (rand() * 0.35);
            const wins = Math.min(trades, Math.max(pnl >= 0 ? 1 : 0, Math.round(trades * winRatio)));
            const winRate = Math.round((wins / trades) * 100);
            data = { day, pnl, trades, wins, losses: trades - wins, winRate, dateLbl: MONTH_NAMES[viewMonth].slice(0, 3) + ' ' + day };
          }
        }

        if (data) {
          el.classList.add(data.pnl >= 0 ? 'up' : 'down', 'has-stats');
          monthPnl += data.pnl;
          totalTrades += data.trades;
          totalWins += data.wins;
          tradingDays++;
          if (bestPnl === null || data.pnl > bestPnl) bestPnl = data.pnl;
          if (worstPnl === null || data.pnl < worstPnl) worstPnl = data.pnl;
          if (isToday) todayData = data;

          const statsEl = document.createElement('div');
          statsEl.className = 'd-stats';

          const pnlEl = document.createElement('span');
          pnlEl.className = 'd-pnl ' + (data.pnl >= 0 ? 'up' : 'down');
          pnlEl.textContent = fmtSigned(data.pnl);
          statsEl.appendChild(pnlEl);

          const metaEl = document.createElement('div');
          metaEl.className = 'd-meta';
          const winrateEl = document.createElement('span');
          winrateEl.className = 'd-winrate';
          winrateEl.textContent = data.winRate + '% win';
          const tradesEl = document.createElement('span');
          tradesEl.className = 'd-trades';
          tradesEl.textContent = data.trades + (data.trades === 1 ? ' trade' : ' trades');
          metaEl.appendChild(winrateEl);
          metaEl.appendChild(tradesEl);
          statsEl.appendChild(metaEl);

          el.appendChild(statsEl);

          el.addEventListener('click', () => {
            grid.querySelectorAll('.jc-day.selected').forEach(c => c.classList.remove('selected'));
            el.classList.add('selected');
            showSidebarDay(data);
          });
        }
      }

      grid.appendChild(el);
    }

    // Update stats strip
    const overallWinRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;
    statMonthPnl.textContent = fmtSigned(monthPnl);
    statMonthPnl.className = 'tj-strip-val ' + (monthPnl >= 0 ? 'up' : 'down');
    statWinRate.textContent = overallWinRate + '%';
    statTrades.textContent = totalTrades;
    statTradingDays.textContent = tradingDays + ' days';
    statBestDay.textContent = bestPnl !== null ? fmtSigned(bestPnl) : '—';
    statWorstDay.textContent = worstPnl !== null ? fmtSigned(worstPnl) : '—';

    if (todayData) {
      const todayEl = grid.querySelector('.jc-day.today.has-stats');
      if (todayEl) { todayEl.classList.add('selected'); showSidebarDay(todayData); }
    } else {
      clearSidebar();
    }
  }

  function openModal() {
    // Close any small popovers (but TJ itself is persistent so it stays if already open)
    if (window.closeAllPopovers) window.closeAllPopovers();
    backdrop.classList.add('show');
    backdrop._openTrigger = openBtn;
    buildCalendar();
    // Center in viewport after content is built
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = backdrop.offsetWidth, ph = backdrop.offsetHeight;
    backdrop.style.left = Math.max(8, Math.round((vw - pw) / 2)) + 'px';
    backdrop.style.top = Math.max(8, Math.round((vh - ph) / 2)) + 'px';
  }

  function closeModal() {
    backdrop.classList.remove('show');
  }

  if (openBtn) openBtn.addEventListener('click', (e) => { e.stopPropagation(); openModal(); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeModal(); });
  prevBtn.addEventListener('click', () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } buildCalendar(); });
  nextBtn.addEventListener('click', () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } buildCalendar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && backdrop.classList.contains('show')) closeModal(); });

  registerJournalRefresh(function () {
    if (!backdrop.classList.contains('show')) return;
    if (viewYear !== today.getFullYear() || viewMonth !== today.getMonth()) return;
    buildCalendar();
  });

  /* Drag the panel by the header */
  (function enableDrag() {
    const header = backdrop.querySelector('.float-panel-header');
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.float-panel-close')) return;
      dragging = true;
      const rect = backdrop.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.min(Math.max(0, startLeft + (e.clientX - startX)), vw - backdrop.offsetWidth);
      const top = Math.min(Math.max(0, startTop + (e.clientY - startY)), vh - backdrop.offsetHeight);
      backdrop.style.left = left + 'px';
      backdrop.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();
})();
function applyScanFilters() {
  const activeTags = Array.from(document.querySelectorAll('#scanFilters .filter-chip.active')).map(c => c.dataset.tag);
  const query = (document.getElementById('scanSearch')?.value || '').trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('#scanTableBody tr[data-tags]').forEach(row => {
    const tags = row.dataset.tags.split(' ');
    const sym = (row.dataset.sym || row.querySelector('td')?.textContent || '').toLowerCase();
    const tagMatch = activeTags.length === 0 || activeTags.some(t => tags.includes(t));
    const searchMatch = query === '' || sym.includes(query);
    const show = tagMatch && searchMatch;
    row.classList.toggle('hide-row', !show);
    if (show) visible++;
  });
  const countEl = document.getElementById('scnRowCount');
  if (countEl) countEl.textContent = visible + ' symbol' + (visible !== 1 ? 's' : '');
}

document.querySelectorAll('#scanFilters .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
    applyScanFilters();
  });
});

const scanSearchEl = document.getElementById('scanSearch');
if (scanSearchEl) scanSearchEl.addEventListener('input', applyScanFilters);
const bottomPanel = document.querySelector('.bottom-panel');
document.querySelectorAll('#bpTabs .bp-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const alreadyActive = btn.classList.contains('active');
    document.querySelectorAll('#bpTabs .bp-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.bottom-panel .bp-table-wrap').forEach(p => p.classList.remove('active'));
    if (alreadyActive) {
      bottomPanel.classList.add('bp-collapsed');
      return;
    }
    bottomPanel.classList.remove('bp-collapsed');
    btn.classList.add('active');
    const panel = document.getElementById('bpPanel-' + btn.dataset.panel);
    if (panel) panel.classList.add('active');
  });
});
setupGroup('.range-bar .range-group', '.range-btn');

document.querySelectorAll('.toggle-pill').forEach(btn => {
  btn.addEventListener('click', () => btn.classList.toggle('active'));
});

const replayToggle = document.getElementById('replayToggle');
if (replayToggle) replayToggle.addEventListener('click', () => replayToggle.classList.toggle('active'));


/* ---- Broker connections ---- */

/* Set Active — event delegation so dynamically-replaced buttons always work */
document.querySelector('.bc-broker-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.bc-set-active-btn');
  if (!btn) return;
  const targetRow = btn.closest('.bc-broker-row');
  document.querySelectorAll('.bc-broker-row').forEach(row => {
    const isTarget = row === targetRow;
    row.classList.toggle('bc-row-active', isTarget);
    const cell = row.querySelector('.bc-active-cell');
    cell.innerHTML = isTarget
      ? '<span class="bc-active-badge">Active</span>'
      : '<button class="bc-set-active-btn">Set Active</button>';
  });
});

/* Overflow menu */
const bcOverflowMenu = document.getElementById('bcOverflowMenu');
if (bcOverflowMenu) {
  document.querySelectorAll('.bc-overflow-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openNear(bcOverflowMenu, btn.getBoundingClientRect(), 'right', btn);
    });
  });

  /* Permission checkboxes */
  bcOverflowMenu.querySelectorAll('.pop-item.checklist').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      item.classList.toggle('checked');
    });
  });
}

/* ---- Market Data pane tabs ---- */
document.getElementById('mdTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.md-tab');
  if (!tab) return;
  document.querySelectorAll('.md-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.md-pane').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('mdPane-' + tab.dataset.mdTab)?.classList.add('active');
});

/* ---- Quick Trade settings pane ---- */
(function () {
  const amountTypeSelect = document.getElementById('qtsAmountType');
  const sizeSlider = document.getElementById('qtsSizeSlider');
  const sliderTicks = document.getElementById('qtsSliderTicks');
  const sliderHelper = document.getElementById('qtsSliderHelper');
  const defaultQtyInput = document.getElementById('qtsDefaultQty');

  const sliderModes = {
    quantity: {
      min: 1, max: 50, value: 1, step: 1,
      ticks: ['1', '5', '10', '25', '50'],
      helper: 'Drag to set a default quantity. Updates the field above.',
      format: v => v
    },
    percent: {
      min: 0, max: 100, value: 25, step: 1,
      ticks: ['0%', '25%', '50%', '75%', '100%'],
      helper: 'Controls position size as a % of available buying power.',
      format: v => v + '%'
    },
    usd: {
      min: 0, max: 10000, value: 500, step: 50,
      ticks: ['$0', '$2,500', '$5,000', '$7,500', '$10,000'],
      helper: 'Controls position size as a fixed USD amount.',
      format: v => '$' + Number(v).toLocaleString()
    }
  };

  function applySliderMode(mode) {
    const cfg = sliderModes[mode] || sliderModes.quantity;
    if (!sizeSlider) return;
    sizeSlider.min = cfg.min;
    sizeSlider.max = cfg.max;
    sizeSlider.step = cfg.step;
    sizeSlider.value = cfg.value;
    if (sliderTicks) sliderTicks.innerHTML = cfg.ticks.map(t => `<span>${t}</span>`).join('');
    if (sliderHelper) sliderHelper.textContent = cfg.helper;
    if (defaultQtyInput) defaultQtyInput.value = cfg.value;
  }

  if (amountTypeSelect) {
    amountTypeSelect.addEventListener('change', () => applySliderMode(amountTypeSelect.value));
  }

  if (sizeSlider && defaultQtyInput) {
    sizeSlider.addEventListener('input', () => {
      defaultQtyInput.value = sizeSlider.value;
    });
  }

  /* Preset buttons — clicking sets active and updates the quantity input */
  document.querySelectorAll('.qt-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.qt-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.qty !== 'max' && defaultQtyInput) {
        defaultQtyInput.value = btn.dataset.qty;
      }
    });
  });
})();
