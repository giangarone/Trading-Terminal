(function marketSessions() {
  'use strict';

  const menu = document.getElementById('marketSessionsMenu');
  const trigger = document.getElementById('marketSessionsTrigger');
  if (!menu || !trigger) return;

  const viewSettings = document.getElementById('sessViewSettings');
  const viewWaiting = document.getElementById('sessViewWaiting');
  const viewDashboard = document.getElementById('sessViewDashboard');
  const closeBtn = document.getElementById('sessCloseBtn');
  const countEl = document.getElementById('sessWaitingCount');

  const dashboardToggleRow = document.getElementById('sessDashboardToggleRow');
  const dashboardToggle = document.getElementById('sessDashboardToggle');
  const orbMasterToggle = document.getElementById('sessOrbMasterToggle');
  const orbCard = document.getElementById('sessOrbCard');
  const orbBody = document.getElementById('sessOrbBody');
  const orbSegGroup = document.getElementById('sessOrbSegGroup');

  let countdownInterval = null;
  let dashboardTimeout = null;

  function showView(name) {
    viewSettings.hidden = name !== 'settings';
    viewWaiting.hidden = name !== 'waiting';
    viewDashboard.hidden = name !== 'dashboard';
  }

  function clearCountdownTimers() {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (dashboardTimeout) { clearTimeout(dashboardTimeout); dashboardTimeout = null; }
  }

  function startWaitingCountdown() {
    let remaining = 5;
    countEl.textContent = remaining;
    showView('waiting');
    countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(countdownInterval); countdownInterval = null; return; }
      countEl.textContent = remaining;
    }, 1000);
    dashboardTimeout = setTimeout(() => {
      clearCountdownTimers();
      showView('dashboard');
    }, 5000);
  }

  /* ORB Analysis Dashboard master toggle: on = simulate market open, off = back to settings */
  dashboardToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowActive = !dashboardToggleRow.classList.contains('active');
    dashboardToggleRow.classList.toggle('active', nowActive);
    if (nowActive) {
      startWaitingCountdown();
    } else {
      clearCountdownTimers();
      showView('settings');
    }
  });

  /* Opening Range master on/off: dims the sub-controls when off */
  orbMasterToggle.addEventListener('click', () => {
    const active = orbCard.classList.toggle('active');
    if (active) orbBody.removeAttribute('data-disabled');
    else orbBody.setAttribute('data-disabled', '');
  });

  /* generic .cs-switch-row toggles (ORB Intelligence rows) */
  menu.querySelectorAll('.cs-switch-row .ui-toggle').forEach(btn => {
    if (btn === dashboardToggle) return; // has its own dedicated handler above
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.closest('.cs-switch-row').classList.toggle('active');
    });
  });

  /* checkbox rows (Session Highlights, Chart Visuals) */
  menu.querySelectorAll('.cs-checkbox-row, .sess-session-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      row.querySelector('.chk-box').classList.toggle('checked');
    });
  });

  /* ORB segmented multi-select pills (NY / London / Asia) */
  orbSegGroup.addEventListener('click', (e) => {
    const pill = e.target.closest('.sess-seg-pill');
    if (!pill) return;
    pill.classList.toggle('active');
  });

  /* Panel open/close is handled by the shared pop-menu engine (openNear/closeAllPopovers,
     see js/app.js) — same mechanism as the Indicators panel. Whenever the panel is closed
     (close button, click outside, Escape, or another popover taking over), clean up any
     running countdown so it can't fire while hidden, and never resume on a dead waiting
     screen if reopened afterwards. */
  const observer = new MutationObserver(() => {
    if (!menu.classList.contains('show')) {
      if (!viewWaiting.hidden) showView('settings');
      clearCountdownTimers();
    }
  });
  observer.observe(menu, { attributes: true, attributeFilter: ['class'] });

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('show') && menu._openTrigger === trigger) {
      window.closeAllPopovers();
      return;
    }
    window.openNear(menu, trigger.getBoundingClientRect(), 'left', trigger);
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.closeAllPopovers();
  });
})();
