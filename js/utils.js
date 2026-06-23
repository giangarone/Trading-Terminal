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
