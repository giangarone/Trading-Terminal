# Changelog

## 2026-08-24

### Added

* **Cross-venue indicator in the chart legend** — When the account you trade through isn't the exchange the chart is drawn from, the legend now names both: `ETHUSD · 15m · BloFin ⇄ Bitget`, the second venue tinted like everything else on the execution side. Previously the two halves of that situation sat at opposite ends of the screen — the chart's exchange in the legend, the account's in the topbar — and noticing the mismatch was left to the trader. Hovering it states the split in full: "Chart is BloFin · orders go to your Bitget account". It appears only when the two differ, so a single-venue chart reads exactly as it always has.

* **Venue tag icon** — The venue tag on order lines (entry, TP, SL, working close) shows a `swap_horiz` icon — the same mark its own tooltip and the chart legend use for the venue split — styled to inherit the tag's `--info` color.

* **Cross-venue trading** — The chart you analyse on and the exchange you trade through are now two separate things. Picking a symbol picks its exchange — the Broker column of the symbol picker — so ETHUSD opens BloFin's ETHUSD and BTCUSD opens Binance's; the exchange orders are sent to is the account you choose in the topbar. When those differ you are analysing on one venue and executing on another. Watch Binance candles, execute on BloFin, and never leave your chart to place or manage a position. Orders, take profits, stop losses, working closes, quantities, position and P&L all draw on the analysis chart as before; each execution object carries a small venue tag on the left edge of its own line — opposite the controls, where several lines' tags stack into one quiet column — so it is never ambiguous whose book an order is in. Order placement, amendment and cancellation always go to the selected execution venue regardless of which exchange is supplying the candles. The execution venue is the account in the topbar, so it is named in exactly one place; connect another from the account menu.

* **Cross-venue price translation** — Because two exchanges rarely trade at the same price, a chart price is no longer sent verbatim to the execution venue. Entry, take profits and stop losses are translated through the live venue spread so the trade's relative structure survives the crossing: the distance from market, the stop distance, the target distances and the risk-to-reward all arrive on the execution venue exactly as they were drawn. With Binance at $100,000 and BloFin at $99,970, an entry planned $100 below market at $99,900 is placed at roughly $99,870 — still $100 below, still the same setup. The chart price stays the analysis reference; executable prices — the bid/ask strip, the Buy/Sell button prices — come from the execution venue's own book. Once an order is live, its venue price is the price of record in the order ticket, Open Orders, Order History and Trade History.

* **Execution price on hover** — When the two venues have drifted far enough apart for the difference to matter, hovering a line's venue tag — entry, take profit, stop loss or working close — states both numbers: the level on this chart, and the price the order actually works at on its venue. It's on hover rather than always-on so the control bar stays a row of controls, and it hangs off the order rather than the price axis: the axis is the chart's own price scale, so a tag on it is a claim about where a level sits, and an execution price isn't at that position on this scale. When the venues track closely, or when you are charting and executing on the same exchange, the chart looks exactly as it always has.

* **Cross-listed instruments in the symbol picker** — A major pair doesn't trade in one place, so the picker now lists an instrument once per exchange that carries it: BTCUSD appears on Binance, Bybit, Coinbase, BloFin and Bitget, ETHUSD on five venues, and so on down through the majors. Each listing shows that venue's own price and its own share of the volume, so the rows read as genuinely different books rather than the same row printed five times. Picking one picks both the instrument and the exchange to chart it on — BTCUSD on Coinbase opens Coinbase's BTCUSD — and the search matches venue names too, so typing "coinbase" lists everything Coinbase carries. Anything that only knows a symbol, like the watchlist, still opens that symbol's primary listing. The instrument list also grew by about 40 names across crypto, stocks, futures and forex.

* **Venue on every order and position** — Positions, Open Orders, Order History and Position History now carry a venue badge in the same family as the side, asset-class and leverage pills, so it's clear at a glance where each order lives. The venue is checked against what the exchange actually lists before it's shown — a crypto exchange never labels a stock, a futures broker never labels a perp — so BTCUSD sits on Bitget, AAPL on TradeStation and NQU5 on Tradovate. Unlike the chart's own lines, which stay quiet when there is no venue split to explain, these tables always name the venue: they list many instruments held across several exchanges at once, so it is always worth stating. The Positions symbol column was widened to hold the full badge run.

* **Cross-Venue Pricing setting** — A new card in Trade Defaults chooses how a chart price becomes an execution price: *Preserve relative distance from chart price* (the default — carries your distances and risk-to-reward across unchanged) or *Use exact chart price*. Alongside it, **Warn on Wide Venue Spread** interrupts placement with a chart-vs-execution comparison when the two venues have drifted past a threshold you set in basis points, so a surprising fill price is something you decline rather than discover.

### Changed

* **Venue tag tooltip explains the split** — Hovering an order line's venue tag used to answer only "what price is this on the other exchange", which assumed you already knew why there was another exchange. It now leads with the situation in plain words — which exchange the chart is showing, which one your orders go to, and that trading works as normal — with the chart and order prices listed underneath when the two actually differ. The tooltip now appears on every venue tag, not just the ones with a price difference to report: the tag exists precisely because two exchanges are in play, and that is the part worth explaining.

### Fixed

* **Venue badge stuck on an unplaced order** — An order drawn on the chart but not yet confirmed kept the venue it was created under, so switching to the account that matched the chart left it still badged for the exchange you had just moved off. An unplaced order isn't on any exchange yet, so it now follows the account: the badge updates the moment you switch, and disappears as soon as the account and the chart are the same venue. Orders already working still keep the venue frozen at placement — those really are on that exchange's book, and re-homing one would claim it had moved.

* **Venue tooltip drawn behind other order lines** — With several orders on the chart, a venue tag's tooltip could be punched through by the tags and control rows of the lines it hung across. The tag's own depth made it a stacking context, which capped its tooltip inside it — no z-index on the panel could lift it past a sibling. The whole tag now rises while it's hovered, carrying its tooltip clear of every other element on the chart's order lines.

* **Order controls covering the venue tag** — The control bar hangs off a fixed offset from the right edge of the chart, so on a narrow pane — a laptop with both side panels open — its left edge reached the venue tags riding the left edge of the same lines and painted straight over them, taking the tooltip with it. The bars now slide right together, staying aligned with each other, by exactly as much as it takes to clear the widest tag, and never far enough to reach the price axis. On a pane too narrow even for that, the buried tag steps aside rather than sitting unreadable under the controls.

* **Every listing of a symbol showing as bookmarked** — With an instrument cross-listed on five exchanges, watchlisting it lit the bookmark on all five, since the check only asked whether the ticker was in the watchlist. A watchlist row now records which venue's listing it holds, so exactly one row in the picker reads as bookmarked. Bookmarking a different exchange's listing of a symbol already in the watchlist moves the watchlist to that venue rather than adding a second row, and clicking a watchlist row now charts the instrument on the venue that row holds.

* **Chart venue stuck on the wrong exchange** — Switching to an instrument the chart venue doesn't list left the legend naming it anyway: charting AAPL still read "Binance". The chart is now drawn on the venue that lists the instrument, so it always names an exchange that actually quotes it.

* **Order lines tagged with the wrong venue** — A line's venue tag was decided from the current account rather than the venue its own order was placed on, so switching accounts made settled orders sprout tags naming a venue they had nothing to do with. Each line now judges against the venue frozen onto it at placement, and its price readout appears only when that line's own two prices actually differ.

* **Crash when a take profit closed the last position** — Filling the final take profit removed its order and left the tick loop dereferencing it, throwing and abandoning the rest of that pass (including every other order's stop and trailing logic). Pre-existing, unrelated to venues.

* **Chart tooltips clipped at the pane edge** — The fee breakdown on a TP/SL amount (and the new venue price readout) hangs below whatever it annotates, so it fell outside the chart pane when its line sat near the bottom. Any of them now flips above its anchor when there isn't room below.

## 2026-08-21

### Fixed

* **Close amount labels after a size change** — The Close Position panel's amount labels quoted the position's old size until the slider was next touched. They now repaint whenever the size actually changes — a limit close filling, a partial close, or adding to the position.

* **BBO side pricing** — The Buy and Sell buttons had the two sides of the book swapped. Buy now carries the best ask and Sell the best bid, matching the quote each side actually trades against.

* **Browser autofill over the trade panel** — Price fields no longer offer a dropdown of previously typed values. They carry live market prices, not saved form data, so a remembered value is never the one you want.

* **Empty limit price** — With BBO off, clearing the Limit Price field and pressing Buy or Sell no longer places at the market price. The panel asks for a price instead, and the field's placeholder only reads "Best Bid / Ask" while BBO is actually on.

### Changed

* **Bid / ask quote hidden on Market and Trigger Market** — Both order types fill at whatever the book offers when they fire, so a bid/ask caption would quote a price the order never uses. The quote line now shows only on the tabs that price off the book.

### Added

* **Limit close lines on the chart** — A working limit close on the charted instrument now draws its own line, the way every other resting price does. It's a dashed line in the neutral info blue — a close below entry on a long is an ordinary scratch, not a failed take-profit, so it stays out of the green/red profit language, the TP numbering and the R maths. The chip beside it carries the quantity and the share of the position it works out to, with a ✕ that cancels the order from the chart, and the price gets an outlined tag on the right axis like every other order line. The line drags to reprice — from anywhere along it or from its chip, the same gesture that moves a TP or SL — and the panel, the table and the axis tag all follow on release. Clicking the amount on the chip opens an editor for the resting order: how much of the position it closes and the exact price it rests at, amended in place rather than cancelled and re-placed. Raising the amount re-checks the cover warning, so it can't be sidestepped by placing small and editing up. Closes on symbols the chart doesn't draw stay in Open Orders.

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