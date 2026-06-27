# Trading Terminal

An HTML/CSS/JS trading terminal UI designed to simulate a real trading platform, but functioning purely as a mockup.

## Design mandate

- Every new feature and every edit to an existing one must match the current design exactly. The terminal has a deliberate, premium aesthetic; new elements must feel visually integrated, not bolted on.

- Avoid using font weights above 600, except in very specific cases.

- **The app supports both dark and light themes (`css/tokens.css`, toggled via the topbar sun/moon icon).** Every new implementation must be designed with both themes in mind and remain fully compatible with each. Use the semantic tokens (`--bg-*`, `--text-*`, `--border-*`, `--shadow-color`, and the functional `--long`/`--short`/`--accent`/`--intel`/`--purple`/`--info` colors and their `-dim`/`-border` variants) instead of hardcoded colors or the raw `--ink-*`/`--paper-*`/`--line-*` tokens — the raw tokens are dark-mode-only literals and will not adapt to light mode. If a new color need doesn't fit an existing token, add a themed pair (dark value in `:root`, light value in `[data-theme="light"]`) rather than hardcoding a literal value.


### Consistency rules

- **Match the existing design.** New UI must look and feel part of the same system — spacing, typography, colors, and components should be consistent with what's already there.
- **Preserve layout integrity.** The terminal uses a fixed three-column layout with a draggable bottom panel and floating modals. New UI must not break or shift existing layout regions.
- **Never use native browser styling for dropdowns or number inputs — including arrow/spinner controls.** Default `<select>` and `<input type="number">` rendering (option lists, spinner arrows) is OS-themed and breaks the dark, premium aesthetic. Always build on the existing custom components instead of styling a native control or inventing a new pattern:
  - **Dropdowns:** use the `.cs-dd-trigger` pattern — a hidden native `<select id="...">` (source of truth for value/options) paired with a visible `<div class="select-input pop-trigger cs-dd-trigger" data-target="..."><span class="cs-select-label">...</span><span class="material-symbols-outlined">expand_more</span></div>`. The generic engine in `js/app.js` (search `cs-dd-trigger`) wires it up automatically — no per-field JS needed.
  - **Number inputs:** use the `.price-stepper` pattern — a `type="text"` input (not `type="number"`, to avoid native spinners) inside `<div class="price-stepper">`, with `<div class="price-stepper-arrows"><button class="ps-up" data-target="...">` / `<button class="ps-down" data-target="...">` using `keyboard_arrow_up`/`keyboard_arrow_down` icons. The generic handler in `js/app.js` (search `price-stepper-arrows`) wires up the arrows automatically via `data-target` (and optional `data-step`) — no per-field JS needed.
  - If a field's behavior doesn't fit either generic engine, extend the existing engine rather than writing a parallel one-off implementation.


## Removing elements from the Settings panel

When removing any element from `index.html` that has an `id`:

1. Search `js/app.js` for every reference to that `id` and remove the corresponding JS (event listeners, `getElementById` calls, populate/collect mappings).
2. If the element is a form field referenced in `populateChartSettingsForm` or `collectChartSettingsForm`, remove it from both functions.
3. Failure to do this crashes the entire settings initialization block silently — the settings gear stops opening, and no JS wired up after the broken line will work.


## Editing CSS or JS files

Most `<link>`/`<script>` tags in `index.html` are versioned (`?v=N`). Bump that number when you edit the file, or browsers may keep serving a cached copy.


## Git

Do not push to GitHub unless explicitly asked to.


## Code quality

- **Readable code.** HTML, CSS, and JS must be easy to read at a glance. Avoid clever one-liners, deeply nested selectors, or compressed logic that requires effort to parse.
- **Clear class names.** CSS classes must be descriptive and self-explanatory. A reader should understand what an element is and where it belongs from the class name alone.

