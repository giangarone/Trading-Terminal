# Changelog

All notable changes to the Trading Terminal are documented here.

## 2026-07-12

### Added
- **Keyboard-operable dropdowns & menus** — The custom `<div>`/`<span>` dropdown and menu triggers (templates, account, symbol, amount-type, chart-settings and broker-rule selects, etc.) are now focusable and can be opened with Enter/Space, matching the watchlist rows. A single global activator translates Enter/Space into the trigger's existing click, and the accent focus ring shows in both themes. (Menus that are already native `<button>`s — timeframe, candles, tabs, layout options — were already reachable.) Full arrow-key navigation *inside* an open menu is a separate follow-up.
- **Press-and-hold on stepper arrows** — Holding a stepper up/down arrow (Quick Trade prices, positions close amount, chart-settings distances, order-line price edit) now auto-repeats after a short delay instead of requiring one click per step. A single click still steps once.
- **Watchlist toggle in the Symbol Selector** — Every row in the redesigned Symbol Selector has an add/remove-from-watchlist button — a **star** that fills gold when the symbol is watchlisted, matching the favorite star in the Indicators window. Adding or removing there updates the Watchlist panel instantly, and the toggle always reflects the symbol's current watchlist status.
- **Remove from the Watchlist panel** — Watchlist rows now reveal a **×** on hover to remove the symbol directly from the panel. Removal stays in sync with the Symbol Selector's toggle in both directions.
- **Watchlist header tooltips** — The Add symbol (**+**) and Customize columns (**⋯**) buttons at the top of the Watchlist card now show the app's custom tooltips on hover.

### Changed
- **Indicator settings window opens beside its legend row** — The indicator settings window (`.ind-settings-popup`) now appears pinned to the chart's leftmost edge, just below the legend row that opened it, instead of centered in the viewport. Opened from a legend row double-click or its settings gear.
- **Sortable Symbol Selector columns** — Clicking a column header (Symbol, Last, 24h Chg, 24h Vol) sorts the list by that column; clicking the active header again flips the direction. Symbol sorts A→Z first, the numeric columns high→low first. An accent arrow marks the active column.
- **Symbol Selector redesigned as a centered modal** — The symbol picker is now a larger, centered, draggable window (matching the Indicators window) instead of a small dropdown. Each row shows the symbol and name, live last price, 24h change %, and 24h volume, with data that ticks live while the window is open. Clicking a row still switches the chart symbol; the per-row toggle manages the watchlist. The separate watchlist "add symbol" dropdown has been folded into this one window, so the Watchlist **+** button, the topbar ticker, and a chart-legend double-click all open the same modal.

### Fixed
- **Symbol Selector headers align with their columns** — The Last / 24h Chg / 24h Vol column headers now line up with the right-aligned numbers below them. The sort arrow moved to the left of the label on these columns, so it no longer pushes the header text off the column's right edge whether or not the column is the active sort.
- **Watchlist row × uses the custom tooltip** — The remove-from-watchlist × on each Watchlist row now shows the app's own dark tooltip on hover instead of the native browser `title` popup, matching the Add symbol / Customize columns header buttons.
- **Escape now closes the trade confirmation dialogs** — Pressing Escape dismisses the Order Confirmation, Reverse/Flip Confirmation, and Connect Broker modals (via each dialog's own close path, so pending state resets), consistent with how Escape already closes Chart Settings, the Journal, and the Scanner. These `.show` backdrops aren't `.pop-menu`/`.ctx-menu`, so the generic popover-closer had been skipping them.
- **Toasts no longer pile up** — `showToast` now de-dups against the most recent toast (a rapid repeat refreshes its timer instead of stacking a copy) and caps the stack at 3, so bursts of actions can't flood the screen. Dismiss timers are cleared when a toast is removed early. Applied to both the main and Market Scanner toast paths, which share one stack.
- **Reopening a dropdown no longer closes its parent window** — Clicking an open dropdown's trigger a second time (e.g. the Line Color dropdown in the indicator settings window) now toggles just that dropdown closed instead of dismissing the whole settings window. The generic `openNear` toggle path stopped calling `closeAllPopovers()`, which had been sweeping away the parent float panel the dropdown lived in.
- **Clicking outside the indicator settings Defaults menu closes it** — With the Defaults dropdown (Reset settings / Save as default) open, clicking elsewhere in the settings window now dismisses just that dropdown. The generic outside-click closer had been skipping it because the click landed inside the settings popup (itself a `.pop-menu`), so a dedicated handler now closes the Defaults menu while leaving the settings window open.

## 2026-07-11

### Fixed
- **Chart crosshair over legend header** — hovering the chart legend header (`.cl-header`) now suppresses the chart crosshair, so the header reads as an interactive element rather than chart space.

### Added
- **Chart legend (top-left overlay)** — The chart now shows a legend in its top-left corner: the asset (`ETHUSD`), timeframe, and exchange on the first line with a live indicator dot, and the O/H/L/C values plus the candle's change (absolute and %) on the second line, color-coded by candle direction. The OHLC tracks the candle under the crosshair while hovering and falls back to the latest candle otherwise; it also reflects timeframe, symbol, and account changes.
- **Indicators in the chart legend** — Each indicator instance appears as its own legend row (e.g. `MA 60 close 0` with its live value). Hovering a row reveals **Hide**, **Settings**, and **Remove** action buttons (each with a tooltip). Overlay indicators (MA, EMA, SMA, VWAP, Bollinger Bands, etc.) show a numeric value tracking the current bar; others render as name-only rows.
- **Indicator users count** — Each row in the Indicators panel now shows how many traders use that indicator, in a 100–8k range.
- **Favorites tab & star** — The Indicators panel has a Favorites tab. Hovering any indicator reveals a star button to add/remove it from favorites; favorited rows show a gold filled star. Favorites start empty.
- **Per-instance indicator settings** — Clicking a legend row's **Settings** (⚙) opens a real editor for that instance. Edits apply live to that instance's legend row only.
- **Indicator documentation ("Read More")** — Hovering an indicator row now reveals a **Doc** button (tooltip "Read More"). Clicking it opens per-indicator documentation **inside the same panel** — the category tabs and list panes are replaced by a scrollable doc view with a Back button, the indicator name (with PRO badge for flagship indicators), and an **Add to chart** button. Each of the indicators has its own adaptive content (overview, how it works, key features, how to use it effectively, settings, signals, and tips — shown only where relevant). Back or Escape returns to the list with the category, search, and scroll position preserved.

### Changed
- **Indicator Settings modal redesign (TradingView-style)** — The per-instance settings editor now opens **centered** on screen with a **tabbed** layout (Inputs / Style / Visibility), compact **label-left rows** grouped under plain uppercase section headers (Smoothing, Calculation, Line, Show On) instead of bordered cards, and a footer with **Defaults / Cancel / Ok**. Cancel and ✕ revert to the settings as they were when opened; Ok keeps them. Cleaner and built to scale to indicators with many settings.
- **Defaults menu in indicator settings** — The footer **Defaults** button now opens a small menu with **Reset settings** and **Save as default** (mockup-only — each shows a toast). The button label always reads "Defaults".
- **Simplified Indicators toolbar button** — Removed the count badge and dropdown caret from the chart toolbar's **Indicators** button, leaving just the icon and label.
- **Indicators panel is now a draggable window** — The Indicators dropdown opens centered in the screen instead of anchored below the Indicators button, and can be repositioned by dragging its header. The search field and buttons stay clickable; only the title/empty header area acts as the grab handle.
- **Click an indicator to add it to the chart** — The on/off toggle has been removed from the Indicators panel. Clicking an indicator now adds it directly to the chart legend, and clicking again adds **another independent instance** (multiple instances supported, each with its own settings). Removing an instance is done from its legend row.
- **Removed the "Active only" filter** — The Indicators panel footer and its active-only toggle were removed, since active indicators are now visible directly on the chart.
- **Crosshair suppressed over legend indicator rows** — Hovering an indicator row in the chart legend now hides the chart crosshair, so the row reads as an interactive control rather than chart space.

### Fixed
- **Thin scrollbars now apply in Chrome** — Removed the `scrollbar-width: thin` declarations that, since Chrome 121, silently overrode the custom `::-webkit-scrollbar` styling and forced the wide default scrollbar. Scrollbars across the terminal now render at the intended 5px.

## 2026-07-10

### Changed
- **Start Trailing options validated by take-profit count** — In the SL gear menu, "After TP1/TP2/TP3 Hit" options are now greyed out and unclickable when the trade doesn't have enough take profits to reach them (e.g. with 1 TP, only "Immediately" and "After TP1 Hit" are selectable). Reachability accounts for already-hit TPs, so a still-reachable trigger isn't greyed out after an earlier TP fills.
- **Start Trailing selection clamps when a TP is removed** — If the selected trigger becomes unreachable after removing a take profit (e.g. "After TP3 Hit" with TP3 removed), it clamps down to the highest still-valid option (TP3→TP2→TP1→Immediately) while keeping trailing enabled, instead of silently never starting.

## 2026-07-09

### Added
- **Panel collapse/expand** — Always-visible collapse/expand buttons for the left and right panels.
- **Chart Fullscreen Mode** — Accessible from the bottom-right button on the chart.
- **Breakeven Line** — On/off toggle in Chart Settings. Dynamically calculates the exchange fee percentage and displays the real breakeven level on the chart.
- **Entry Amount Settings — Apply button** — Save changes to Entry Amount Settings.
- **Risk $ option in Trade Defaults** — Adds Risk $ as a Trade Defaults option.
- **Account Balance in Trade Defaults** — Includes a calculated preview of the default position size based on the user's account balance.
- **Quick Market Order Size** — New Trade Defaults input to set the default size for Quick Market Orders.

### Changed
- **Risk $ disabled for Quick Market Orders** — Quick Market Orders do not include a stop loss by default, so Risk $ is disabled for them.
- **Chart right-click menu labels** — Trades are now labelled `ETHUSD` (was `ETH`). When Position Sizing is Risk $ or Risk %, the quantity is omitted (e.g. "Buy ETHUSD @ 4,499.75") since the size isn't known until a stop-loss distance is set.
- **Renamed "% Account" to "Account %"** — Across Trade Defaults (option + heading) and the chart size menu, for consistency with "Risk %" / "Risk $".
- **Size menu styling** — Widened to 380px and added a hover background on the size tabs.

### Fixed
- **Breakeven Line round-trip fee** — The breakeven line now accounts for the full round-trip fee (entry fill + exit fill), respecting maker/taker rates by order type, instead of only a single side.
- **Dynamic Fee Offset round-trip fee** — "Move SL to Breakeven" now uses the round-trip fee (0.12%) and applies it as a percentage of entry, so the stop lands at a true net-zero exit. Previously it only covered one side and the offset was miscalculated.

### Warnings
- Stop-loss risk-limit warning: "The selected stop-loss exceeds your risk limit. Move the stop-loss closer or increase your risk amount."
- Warning shown when Risk $ is selected but no stop loss is set.
