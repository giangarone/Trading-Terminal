# Changelog

## 2026-08-21

### Fixed

* **BBO side pricing** — The Buy and Sell buttons had the two sides of the book swapped. Buy now carries the best ask and Sell the best bid, matching the quote each side actually trades against.

* **Browser autofill over the trade panel** — Price fields no longer offer a dropdown of previously typed values. They carry live market prices, not saved form data, so a remembered value is never the one you want.

* **Empty limit price** — With BBO off, clearing the Limit Price field and pressing Buy or Sell no longer places at the market price. The panel asks for a price instead, and the field's placeholder only reads "Best Bid / Ask" while BBO is actually on.

### Changed

* **Bid / ask quote hidden on Market and Trigger Market** — Both order types fill at whatever the book offers when they fire, so a bid/ask caption would quote a price the order never uses. The quote line now shows only on the tabs that price off the book.

### Added

* **Limit close lines on the chart** — A working limit close on the charted instrument now draws its own line, the way every other resting price does. It's a dashed line in the neutral info blue — a close below entry on a long is an ordinary scratch, not a failed take-profit, so it stays out of the green/red profit language, the TP numbering and the R maths. The chip beside it carries the quantity and the share of the position it works out to, with a ✕ that cancels the order from the chart, and the price gets an outlined tag on the right axis like every other order line. The line drags to reprice — from anywhere along it or from its chip, the same gesture that moves a TP or SL — and the panel, the table and the axis tag all follow on release. Closes on symbols the chart doesn't draw stay in Open Orders.

* **Limit closes are real orders** — Close Limit no longer just toasts. It rests a working order at the price and amount you set: closing a long sells above the mark, closing a short buys below, and the position stays open until it's reached. Working closes appear in Open Orders with their own cancel control, and fill as soon as the position's mark reaches the price — reducing the position or closing it outright, and recording the fill in Order History and Trade History with its realized P&L. Closes on the charted instrument fill against the price shown on the chart, so the line and the fill agree. Closing, flattening or reversing a position cancels the closes still working against it. Resting more than the position holds is allowed — closes are reduce-only and cap at whatever is left when they fill, so bracketing an exit at two prices works — but the toast says how much of the position the working closes now cover once they add up past it.

* **BBO on Stop Limit** — The limit leg of a Stop Limit now carries the same BBO toggle as the Limit tab: with it on the field states the rule and the Buy/Sell buttons carry the price each side would rest at. BBO is one setting shared by both, so moving between them doesn't quietly change how the order will be placed. The blank-price guard now covers the limit leg too, instead of falling back to the market price.

* **BBO on a position's Limit close** — The Limit close now has a BBO toggle beside the price field, the same one the Quick Trade panel uses, with the side already decided: closing a long sells into the best bid, closing a short buys the best ask. With it on the field states which of the two it is and the Close Limit button carries the live price, so the price you get is written on the button you press. Clicking into the field or nudging the steppers turns it off and hands back a typable price. The quote tracks each position's own mark, so every row quotes its own instrument.

* **Bid / ask quote** — The Quick Trade panel now shows the best bid and the best ask as a caption under the active tab's price field, on every asset class and both crypto modes — anything with an order book has a spread, spot included. It matters most on futures and stocks, where the last traded price can sit stale between prints. Clicking the bid or the ask uses that price for the order you're building: the Limit price on the Limit tab, the limit leg on Stop Limit.

* **Per-instrument quote spreads** — Bid and ask are no longer a flat quarter-point on every symbol. Futures carry their contract's own tick (ES 0.25, CL 0.01, GC 0.10, YM 1.00), stocks quote in pennies, and crypto and forex get a tighter book than the price grid. The last price now prints at whichever side of the book the tape last moved towards, so both quotes stay on the instrument's price grid.

* **BBO toggle in the Quick Trade panel** — The Limit tab now has a BBO toggle beside the Limit Price field. With it on, the field states the rule ("Best Bid / Ask") instead of a price, and the Buy and Sell buttons carry the exact live price each side would rest at — the best bid for a buy, the best ask for a sell — so the price you get is written on the button you press. Clicking into the field or nudging the steppers turns BBO off and hands you an ordinary typable price.

## 2026-08-16

### Changed

* **Premium badge recoloured** — The Premium badge on paid ChartPrime indicators is now purple instead of gold. It previously matched the gold PRO badge on the L1/L2 indicators closely enough to read as the same plan gate, when it only marks which ChartPrime indicators are paid.

## 2026-08-14

### Added

* **ChartPrime free indicators** — Added twelve free ChartPrime indicators to the Indicators panel, including Power Order Blocks, HTF Candle Volume Profile, Smart Money Fibonacci OTE Engine and Polynomial Regression Channel.

### Changed

* **ChartPrime tiers separated** — The ChartPrime tab now splits into ChartPrime Premium and ChartPrime Free groups, with the paid indicators carrying a Premium badge so the tier stays visible in Favorites and search results. Only paid indicators are badged, so an unbadged row always means free.

## 2026-07-16

### Added

* **This Week in Trading Journal** — Added a weekly period alongside Today, This Month and This Year.
* **Position hover focus** — Hovering any part of a position now fades the opposite side, making its entry, TP, SL and related lines easier to identify.

### Changed

* **Draft order lines** — Draft orders now use dashed entry lines, which become solid once placed.
* **Position size on entry chips** — Filled position chips now show the position size instead of BUY or SELL.
* **Improved Settings search** — Search now finds individual settings, cards and options, not only section names. Results can be navigated with the keyboard.

### Fixed

* **Settings search no longer triggers unsaved changes** — Typing in search no longer activates the Save button.

## 2026-07-15

### Added

* **Trailing Stop enabled by default** — New setting to automatically enable trailing on newly created stop losses.
* **Trailing Take Profit enabled by default** — New setting to automatically enable trailing on newly created take profits.

### Changed

* **Reset to Defaults button moved** — The button now appears in the settings footer beside Cancel and Save.
* **Trailing Stop distance** — Trailing distance is now calculated directly from the distance between the entry and stop loss.
* **Pending orders fill instantly** — Removed the fill animation delay when price reaches an order.
* **Add-on orders use the main position’s TP/SL** — Additional same-side orders no longer have separate take-profit or stop-loss controls.
* **Risk sizing for add-ons** — Risk $ and Risk % add-ons now calculate their size using the main position’s stop loss.

### Fixed

* **Reset restores Position Mode** — Reset to Defaults now correctly restores One-way Mode.
* **Trailing TP settings applied correctly** — New trailing take profits now use the configured offset and unit.
* **Orders add to the existing position** — Same-side filled orders now merge into one position, combining size and recalculating the average entry.
* **Reverse respects Position Mode** — Reversing or flipping an order now follows One-way and Hedge Mode restrictions.

## 2026-07-14

### Added

* **News Catalyst Scope** — Choose between asset-specific news, global market news or both.
* **Hedge Mode** — Allows long and short positions on the same symbol at the same time.
* **Multiple chart orders** — Multiple pending orders can now exist and be managed independently.
* **Market orders add to positions** — Repeated same-side market orders increase the existing position instead of creating duplicates.
* **Order modified notification** — A toast now appears after manually moving an order line.

### Changed

* **Trading Journal improvements** — Added clearer win/loss summaries, improved period selection and more precise win-rate values.
* **Quick Trade prices** — Limit, Stop Limit and Trigger Market fields now load the current market price when opened.
* **News & Events settings reorganized** — Related settings are now grouped into clearer sections.
* **Chart order wording improved** — Right-click actions now clearly distinguish planned orders from instant market orders.
* **Stop Limit line roles corrected** — The solid line now represents the Limit price, while the dashed line represents the Stop trigger.
* **Order lines apply on release** — Dragged orders, TP and SL lines are only evaluated after the user releases them.
* **Trailing TP offset label draggable** — The offset can now be repositioned directly from its label.

### Fixed

* **Invalid Limit Price fallback** — Empty Limit Price fields now use the current market price instead of creating an invalid order.
* **Overlapping order controls** — Nearby chart order bars are now separated automatically.
* **Correct execution by order type** — Limit, Trigger Market and Stop Limit orders now follow their correct execution rules.
* **Dragged trigger orders re-arm correctly** — Moving a trigger across the current price no longer activates it immediately.

### Removed

* **General Status card** — Removed duplicated broker, market data, subscription and version information.
* **Unused styles** — Removed unused CSS and outdated style fallbacks.

## 2026-07-12

### Added

* **Keyboard support** — Custom dropdowns and menus can now be opened using Enter or Space.
* **Press-and-hold steppers** — Holding an increase or decrease arrow now repeats the action.
* **Watchlist controls in Symbol Selector** — Symbols can be added to or removed from the watchlist directly from the selector.
* **Quick removal from Watchlist** — Watchlist rows now show a remove button on hover.
* **Watchlist tooltips** — Added tooltips to the Watchlist header controls.

### Changed

* **Symbol Selector redesigned** — It is now a larger draggable modal with live price, change and volume data.
* **Sortable Symbol Selector** — Symbol, price, change and volume columns can now be sorted.
* **Indicator settings placement** — Indicator settings now open beside the selected chart legend row.

### Fixed

* **Symbol Selector alignment** — Headers now align correctly with their values.
* **Escape closes confirmations** — Order, reverse and broker confirmation dialogs can now be closed with Escape.
* **Toast stacking** — Duplicate toasts are combined and the visible stack is limited.
* **Popup closing behavior** — Reopening or clicking outside dropdowns no longer closes unrelated windows.

## 2026-07-11

### Added

* **Chart legend** — Added symbol, timeframe, exchange, live status and OHLC information to the chart.
* **Indicators in chart legend** — Active indicators now appear as separate legend rows with live values and controls.
* **Indicator usage counts** — The Indicators panel now displays how many traders use each indicator.
* **Indicator favorites** — Indicators can be saved and accessed from a Favorites tab.
* **Multiple indicator instances** — The same indicator can be added multiple times with independent settings.
* **Indicator documentation** — Each indicator now includes an in-app documentation view.

### Changed

* **Indicator settings redesigned** — Added Inputs, Style and Visibility tabs with clearer grouped settings.
* **Draggable indicator windows** — Indicators and settings panels can now be repositioned.
* **Indicators added by clicking** — Clicking an indicator adds it directly to the chart.
* **Simplified Indicators button** — Removed the count badge and dropdown arrow.

### Fixed

* **Crosshair interaction** — The chart crosshair is now hidden while hovering interactive legend elements.
* **Chrome scrollbars** — Custom thin scrollbars now display correctly in Chrome.

## 2026-07-10

### Changed

* **Trailing activation options validated** — TP-based trailing options are disabled when the required TP does not exist.
* **Trailing trigger adjusts after removing a TP** — Invalid selections automatically move to the highest available trigger.

## 2026-07-09

### Added

* **Collapsible side panels** — Added always-visible controls to collapse or expand both side panels.
* **Chart fullscreen mode** — Added a fullscreen button to the chart.
* **Breakeven line** — Displays the real breakeven price after accounting for exchange fees.
* **Entry Amount Apply button** — Entry Amount changes can now be explicitly saved.
* **Risk $ sizing** — Added Risk $ as a Trade Defaults option.
* **Account Balance setting** — Added position-size previews based on account balance.
* **Quick Market Order Size** — Added a separate default size for market orders without a stop loss.

### Changed

* **Risk $ disabled for Quick Market Orders** — Risk-based sizing is unavailable when no stop loss exists.
* **Chart order labels improved** — Order labels now use the full symbol and hide unknown quantities.
* **Account % naming** — Renamed “% Account” to “Account %” for consistency.
* **Size menu updated** — Increased width and improved tab hover states.

### Fixed

* **Breakeven fee calculation** — Breakeven now accounts for both entry and exit fees.
* **Move SL to Breakeven calculation** — The stop now moves to the true net-zero price.
* **Risk warnings** — Added warnings for missing stop losses and stops exceeding the selected risk limit.