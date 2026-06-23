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

/* makeDraggableFixed: drag a fixed-position popup (market scanner, AI popup) by its header */
function makeDraggableFixed(popup) {
  const head = popup.querySelector('.chart-popup-head, .scnm-head, .ms-head');
  if (!head) return;
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.chart-popup-close, .ct-icon')) return;
    dragging = true;
    const rect = popup.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    popup.style.right = 'auto';
    popup.style.left = startLeft + 'px';
    popup.style.top = startTop + 'px';
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = startLeft + (e.clientX - startX);
    let top = startTop + (e.clientY - startY);
    left = Math.min(Math.max(0, left), vw - popup.offsetWidth);
    top = Math.min(Math.max(0, top), vh - popup.offsetHeight);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    e.stopPropagation();
  }, true);
  document.addEventListener('mouseup', () => { dragging = false; });
}

function makeDraggablePopup(popup) { makeDraggableFixed(popup); }
