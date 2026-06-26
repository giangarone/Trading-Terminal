# Trading Terminal

An HTML/CSS/JS trading terminal UI designed to simulate a real trading platform, but functioning purely as a mockup.

## Design mandate

Every new feature and every edit to an existing one must match the current design exactly. The terminal has a deliberate, premium aesthetic; new elements must feel visually integrated, not bolted on.


### Consistency rules

- **Match the existing design.** New UI must look and feel part of the same system — spacing, typography, colors, and components should be consistent with what's already there.
- **Preserve layout integrity.** The terminal uses a fixed three-column layout with a draggable bottom panel and floating modals. New UI must not break or shift existing layout regions.


## Removing elements from the Settings panel

When removing any element from `index.html` that has an `id`:

1. Search `js/app.js` for every reference to that `id` and remove the corresponding JS (event listeners, `getElementById` calls, populate/collect mappings).
2. If the element is a form field referenced in `populateChartSettingsForm` or `collectChartSettingsForm`, remove it from both functions.
3. Failure to do this crashes the entire settings initialization block silently — the settings gear stops opening, and no JS wired up after the broken line will work.


## Git

Do not push to GitHub unless explicitly asked to.


## Code quality

- **Readable code.** HTML, CSS, and JS must be easy to read at a glance. Avoid clever one-liners, deeply nested selectors, or compressed logic that requires effort to parse.
- **Clear class names.** CSS classes must be descriptive and self-explanatory. A reader should understand what an element is and where it belongs from the class name alone.

