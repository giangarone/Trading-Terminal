/* ----------------------------------------------------------------
   utils.js — shared utility functions used across multiple modules
   ---------------------------------------------------------------- */

/* setupGroup: toggle .active on exactly one item within each matching group */
function setupGroup(selector, itemSelector) {
  document.querySelectorAll(selector).forEach(group => {
    group.querySelectorAll(itemSelector).forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll(itemSelector).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
}

/* mulberry32: tiny seeded PRNG. Returns a function that yields deterministic
   pseudo-random floats in [0, 1). Used to make the mock price feeds repeatable. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* fmt: format a number with thousands separators and a fixed number of
   decimals (default 2), preserving a leading minus sign. */
function fmt(n, dec) {
  dec = dec === undefined ? 2 : dec;
  const neg = n < 0; n = Math.abs(n);
  const parts = n.toFixed(dec).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + parts.join('.');
}

/* setUpDown / flashEl: apply the shared green/red direction + flash classes
   used by every live-updating price cell. */
function setUpDown(el, isUp) { el.classList.remove('up', 'down'); el.classList.add(isUp ? 'up' : 'down'); }
function flashEl(el, isUp) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(isUp ? 'flash-up' : 'flash-down'); }

/* escapeHtml: escape the five HTML-significant characters so untrusted strings
   are safe to interpolate into innerHTML. */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
