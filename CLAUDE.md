# Trading Terminal

A static HTML/CSS/JS trading terminal UI. No build system — all assets are loaded directly in `index.html`.

## Design mandate

Every new feature and every edit to an existing one must match the current design exactly. The terminal has a deliberate, premium aesthetic; new elements must feel visually integrated, not bolted on.

### Consistency rules

- **Reuse first.** Before writing new CSS, check whether an existing class already covers the pattern. Duplicate styles and one-off rules are not acceptable.
- **Tokens over raw values.** All font sizes, weights, letter-spacing, radii, heights, and transitions must reference the design tokens defined in `css/tokens.css`. Never hard-code a value that a token already covers.
- **Match spacing and typography.** Labels, table headers, badges, buttons, and input fields each have an established size/weight/spacing pattern — match it exactly. When in doubt, inspect a nearby similar element and copy its token usage.
- **No visual clutter.** The UI is intentionally minimal and dark. Avoid unnecessary borders, shadows, icons, or decorative elements that aren't already present in adjacent components.
- **Preserve layout integrity.** The terminal uses a fixed three-column layout (left watchlist / center chart / right panel) with a draggable bottom panel and floating modals. New UI must not break or shift existing layout regions.

## Code quality

- **Readable code.** HTML, CSS, and JS must be easy to read at a glance. Avoid clever one-liners, deeply nested selectors, or compressed logic that requires effort to parse.
- **Clear class names.** CSS classes must be descriptive and self-explanatory. A reader should understand what an element is and where it belongs from the class name alone.

