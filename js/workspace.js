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

/* ---------- trading journal: day selector ---------- */
(function () {
  const journalDays = [
    { label: 'Today', pnl: 2975.00, trades: 7, winRate: 71, best: 1420.00, worst: -310.00 },
    { label: 'Jun 19', pnl: -640.00, trades: 5, winRate: 40, best: 510.00, worst: -560.00 },
    { label: 'Jun 18', pnl: 1180.00, trades: 6, winRate: 67, best: 800.00, worst: -220.00 },
    { label: 'Jun 17', pnl: 0.00, trades: 0, winRate: 0, best: 0.00, worst: 0.00 },
    { label: 'Jun 16', pnl: 2110.00, trades: 9, winRate: 78, best: 990.00, worst: -180.00 },
  ];
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
      tjDayMenu.querySelectorAll('.pop-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      showJournalDay(parseInt(item.dataset.day));
      closeAllPopoversLocal();
    });
  });
})();

/* ---------- trading journal: mini calendar view (toggled in place of the default widget view) ---------- */
(function () {
  const grid = document.getElementById('tjcGrid');
  const monthLbl = document.getElementById('tjcMonthLbl');
  const defaultView = document.getElementById('tjDefaultView');
  const calView = document.getElementById('tjCalView');
  const calToggleBtn = document.getElementById('tjCalToggleBtn');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date(2026, 5, 20);
  let viewYear = today.getFullYear(), viewMonth = today.getMonth();
  function mulberry32Local(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let jcRand = mulberry32Local(5530 + viewYear * 100 + viewMonth);
  function fmtSignedShort(n) {
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }

  function buildCalendar() {
    jcRand = mulberry32Local(5530 + viewYear * 100 + viewMonth);
    monthLbl.textContent = monthNames[viewMonth] + ' ' + viewYear;
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
      el.className = 'jc-day mini empty';
      grid.appendChild(el);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const isFuture = new Date(viewYear, viewMonth, day) > today;
      const el = document.createElement('div');
      el.className = 'jc-day mini';
      const isToday = viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();
      if (isToday) el.classList.add('today');
      if (isFuture) el.classList.add('future');

      const numEl = document.createElement('span');
      numEl.className = 'd-num';
      numEl.textContent = day;
      el.appendChild(numEl);

      if (!isFuture) {
        const hasTrades = jcRand() > 0.22;
        if (hasTrades) {
          const pnl = Math.round((jcRand() - 0.42) * 3200);
          el.classList.add(pnl >= 0 ? 'up' : 'down', 'has-stats');
          const pnlEl = document.createElement('span');
          pnlEl.className = 'd-pnl ' + (pnl >= 0 ? 'up' : 'down');
          pnlEl.textContent = fmtSignedShort(pnl);
          el.appendChild(pnlEl);

          const trades = Math.max(1, Math.round(1 + jcRand() * 7));
          const winRatio = pnl >= 0 ? (0.55 + jcRand() * 0.35) : (jcRand() * 0.35);
          const wins = Math.min(trades, Math.max(pnl >= 0 ? 1 : 0, Math.round(trades * winRatio)));
          const losses = trades - wins;
          const winRate = Math.round((wins / trades) * 100);
          const avgTrade = pnl / trades;
          el.dataset.dateLbl = monthNames[viewMonth].slice(0, 3) + ' ' + day + ', ' + viewYear;
          el.dataset.pnl = pnl;
          el.dataset.trades = trades;
          el.dataset.wins = wins;
          el.dataset.losses = losses;
          el.dataset.winRate = winRate;
          el.dataset.avgTrade = avgTrade.toFixed(2);
        }
      }
      grid.appendChild(el);
    }
  }

  document.getElementById('tjcPrevBtn').addEventListener('click', () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    buildCalendar();
  });
  document.getElementById('tjcNextBtn').addEventListener('click', () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    buildCalendar();
  });
  if (calToggleBtn) calToggleBtn.addEventListener('click', () => {
    const showCal = !calToggleBtn.classList.contains('active');
    calToggleBtn.classList.toggle('active', showCal);
    defaultView.style.display = showCal ? 'none' : 'block';
    calView.style.display = showCal ? 'block' : 'none';
  });

  /* ---------- per-day stats tooltip ---------- */
  const tjDayTooltip = document.getElementById('tjDayTooltip');
  grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.jc-day.mini.has-stats');
    if (!cell) return;
    const pnl = parseFloat(cell.dataset.pnl);
    const avgUp = parseFloat(cell.dataset.avgTrade) >= 0;
    tjDayTooltip.innerHTML =
      '<div class="jc-tt-title">' + cell.dataset.dateLbl + '</div>' +
      '<div class="jc-tt-row"><span class="l">P&amp;L</span><span class="v ' + (pnl >= 0 ? 'up' : 'down') + '">' + fmtSignedShort(pnl) + '</span></div>' +
      '<div class="jc-tt-row"><span class="l">Trades</span><span class="v">' + cell.dataset.trades + '</span></div>' +
      '<div class="jc-tt-row"><span class="l">Wins / Losses</span><span class="v">' + cell.dataset.wins + ' / ' + cell.dataset.losses + '</span></div>' +
      '<div class="jc-tt-row"><span class="l">Win Rate</span><span class="v">' + cell.dataset.winRate + '%</span></div>' +
      '<div class="jc-tt-row"><span class="l">Avg / Trade</span><span class="v ' + (avgUp ? 'up' : 'down') + '">' + fmtSignedShort(parseFloat(cell.dataset.avgTrade)) + '</span></div>';
    tjDayTooltip.classList.add('show');
    const rect = cell.getBoundingClientRect();
    const ttRect = tjDayTooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - ttRect.width / 2;
    let top = rect.top - ttRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
    tjDayTooltip.style.left = left + 'px';
    tjDayTooltip.style.top = top + 'px';
  });
  grid.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !grid.contains(e.relatedTarget)) tjDayTooltip.classList.remove('show');
  });

  buildCalendar();
})();
document.querySelectorAll('#scanFilters .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
    const activeTags = Array.from(document.querySelectorAll('#scanFilters .filter-chip.active')).map(c => c.dataset.tag);
    let visible = 0;
    document.querySelectorAll('#scanTableBody tr[data-tags]').forEach(row => {
      const tags = row.dataset.tags.split(' ');
      const show = activeTags.length === 0 || activeTags.some(t => tags.includes(t));
      row.classList.toggle('hide-row', !show);
      if (show) visible++;
    });
    const countEl = document.getElementById('scnRowCount');
    if (countEl) countEl.textContent = visible + ' symbol' + (visible !== 1 ? 's' : '');
  });
});
document.querySelectorAll('#bpTabs .bp-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bpTabs .bp-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.bottom-panel .bp-table-wrap').forEach(p => p.classList.remove('active'));
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

