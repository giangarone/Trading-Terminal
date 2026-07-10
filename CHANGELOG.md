# Changelog

All notable changes to the Trading Terminal are documented here.

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
