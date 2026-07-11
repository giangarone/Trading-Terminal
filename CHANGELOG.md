# Changelog

All notable changes to the Trading Terminal are documented here.

## 2026-07-11

### Added
- **Chart legend (top-left overlay)** — The chart now shows a legend in its top-left corner: the asset (`ETH / USD`), timeframe, and exchange on the first line with a live indicator dot, and the O/H/L/C values plus the candle's change (absolute and %) on the second line, color-coded by candle direction. The OHLC tracks the candle under the crosshair while hovering and falls back to the latest candle otherwise; it also reflects timeframe, symbol, and account changes.
- **Indicators in the chart legend** — Each indicator instance appears as its own legend row (e.g. `MA 60 close 0` with its live value). Hovering a row reveals **Hide**, **Settings**, and **Remove** action buttons (each with a tooltip). Overlay indicators (MA, EMA, SMA, VWAP, Bollinger Bands, etc.) show a numeric value tracking the current bar; others render as name-only rows.
- **Indicator users count** — Each row in the Indicators panel now shows how many traders use that indicator (e.g. `1.3M`), tiered by category.
- **Favorites tab & star** — The Indicators panel has a Favorites tab. Hovering any indicator reveals a star button to add/remove it from favorites; favorited rows show a gold filled star. Favorites start empty.
- **Per-instance indicator settings** — Clicking a legend row's **Settings** (⚙) opens a real editor for that instance. Edits apply live to that instance's legend row only.

### Changed
- **Indicator Settings modal redesign (TradingView-style)** — The per-instance settings editor now opens **centered** on screen with a **tabbed** layout (Inputs / Style / Visibility), compact **label-left rows** grouped under plain uppercase section headers (Smoothing, Calculation, Line, Show On) instead of bordered cards, and a footer with **Defaults / Cancel / Ok**. Cancel and ✕ revert to the settings as they were when opened; Ok keeps them; Defaults resets to the indicator's defaults. Cleaner and built to scale to indicators with many settings.
- **Indicators panel is now a draggable window** — The Indicators dropdown opens centered in the screen instead of anchored below the Indicators button, and can be repositioned by dragging its header. The search field and buttons stay clickable; only the title/empty header area acts as the grab handle.
- **Click an indicator to add it to the chart** — The on/off toggle has been removed from the Indicators panel. Clicking an indicator now adds it directly to the chart legend, and clicking again adds **another independent instance** (multiple instances supported, each with its own settings). Removing an instance is done from its legend row.
- **Removed the "Active only" filter** — The Indicators panel footer and its active-only toggle were removed, since active indicators are now visible directly on the chart.

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
