# Changelog

All notable changes to the Trading Terminal are documented here.

## [Unreleased] — 2026-07-09

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

### Warnings
- Stop-loss risk-limit warning: "The selected stop-loss exceeds your risk limit. Move the stop-loss closer or increase your risk amount."
- Warning shown when Risk $ is selected but no stop loss is set.
