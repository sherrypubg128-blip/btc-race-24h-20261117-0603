// Steady Swing — a BTC trading bot for the make.fun bounty
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261117-0603).
//
// The idea, in plain words: cbBTC on 1-minute bars is mostly noise. A 1-minute
// move is about 6 bps of wiggle, and a full round trip costs about 26 bps in
// fees, slippage and price impact, so trading every wiggle is a guaranteed
// bleed. The only moves worth catching are the slow, wide swings: the price
// drifting far below where it has been lately, then recovering. So this bot
// waits. It watches the 120-bar (two-hour) simple moving average of closes.
// When the latest close sits at least 60 bps below that average — a real dip,
// not noise — it buys with all its cash. It sells when the close climbs back
// to 60 bps above the average, or if the position falls 150 bps under what it
// paid, which caps a genuine downtrend. That is the whole strategy: two wide
// bands around a slow average, plus a stop-loss.
//
// Why wide bands: on the published dev window every narrow-band and
// fast-crossover variant I tested lost money (dozens of trades, each paying
// the 26 bps round trip, chasing moves that had already happened). The wide
// swing made money at every nearby parameter choice (60/64 parameter pairs
// profitable, $6.49–$17.42), so it is a plateau, not a lucky point. It trades
// rarely (6 fills on the dev window) and its worst drawdown there was 1.3%.
// A longer average (120 bars) also keeps signalling in a quiet stretch: the
// 60-bar version made no trade at all in the dev window's second half, while
// the 120-bar version traded in both halves.
//
// One insurance rule: the race requires at least 1 trade, so if the bot has
// made no filled trade by scored bar 1300 it buys half its cash on the next
// batch and sells it on a 40 bps move either way, or holds it to the end.
// That rule never fired on the dev window; it exists only so a very quiet
// race window cannot leave the bot with zero trades.
//
// Everything is exact integer arithmetic (BigInt) on the harness's own
// integer prices, so the same bars give the same orders, run after run. No
// network, no wall clock, no environment, no randomness at all.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The moving-average window, in bars (120 one-minute bars = two hours). */
const SMA_BARS = 120;
/** Buy when the close is this far below the moving average, in basis points. */
const BUY_BPS = 60;
/** Sell when the close is this far above the moving average, in basis points. */
const SELL_BPS = 60;
/** Stop-loss: sell when the position is worth this far under its cost, in bps. */
const STOP_BPS = 150;
/** The most the fill may move past the close the order was decided on, in bps. */
const MAX_SLIPPAGE_BPS = 100;
/** The fallback fires once this many scored bars have passed with no filled trade. */
const FALLBACK_AFTER_BARS = 1300;
/** The fallback buys this share of the cash. */
const FALLBACK_NUM = 1n;
const FALLBACK_DEN = 2n;
/** The fallback sells on a move of this size from its entry, in bps, either way. */
const FALLBACK_MOVE_BPS = 40;

/** The last SMA_BARS closes, oldest first, as integer prices (price_scale 5). */
const closes: bigint[] = [];
/** The sum of `closes`, kept current so the average never needs a rescan. */
let closeSum = 0n;
/** The number of filled orders seen so far (buys and sells). */
let filledTrades = 0;
/** Whether the fallback buy has been placed. */
let fallbackBought = false;

/** The close is at least `bps` basis points below the moving average. */
function belowAverage(close: bigint, bps: number): boolean {
  // close < (closeSum / SMA_BARS) * (10000 - bps) / 10000
  // Multiply out to stay in integers: close * SMA_BARS * 10000 < closeSum * (10000 - bps).
  return close * BigInt(SMA_BARS) * BPS < closeSum * BigInt(10_000 - bps);
}

/** The close is at least `bps` basis points above the moving average. */
function aboveAverage(close: bigint, bps: number): boolean {
  // close > (closeSum / SMA_BARS) * (10000 + bps) / 10000
  return close * BigInt(SMA_BARS) * BPS > closeSum * BigInt(10_000 + bps);
}

/** The held position is worth at least `bps` basis points under its cost. */
function underStop(state: BarsState, held: { qty: bigint; cost: bigint }, bps: number): boolean {
  const value = state.value(SYMBOL, held.qty);
  return value * BPS <= held.cost * BigInt(10_000 - bps);
}

await runBars({
  onBatch(state, batch) {
    // Count the fills of the previous batch's orders: only a filled order is
    // a trade, and the guardrail counts trades.
    for (const fill of batch.fills) {
      if (fill.status === 'filled') filledTrades++;
    }
    // No fresh bar for our symbol this batch: nothing to decide on.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    // Fold the new close into the rolling window.
    const close = BigInt(bar.c);
    closes.push(close);
    closeSum += close;
    if (closes.length > SMA_BARS) closeSum -= closes.shift()!;
    if (state.warmingUp) return [];
    if (closes.length < SMA_BARS) return [];

    const held = state.positions.get(SYMBOL);
    const scoredBars = batch.seq - state.warmupBars;
    const orders: OrderInput[] = [];

    if (held !== undefined) {
      // Holding: exit on the swing back above the average, or on the stop-loss.
      // The fallback position exits on its own smaller move instead.
      if (fallbackBought) {
        const value = state.value(SYMBOL, held.qty);
        const up = value * BPS >= held.cost * BigInt(10_000 + FALLBACK_MOVE_BPS);
        const down = value * BPS <= held.cost * BigInt(10_000 - FALLBACK_MOVE_BPS);
        if (up || down) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (aboveAverage(close, SELL_BPS) || underStop(state, held, STOP_BPS)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else if (filledTrades === 0 && scoredBars >= FALLBACK_AFTER_BARS && !fallbackBought) {
      // Insurance: no trade yet and the window is nearly over. Buy half the
      // cash now so the entry always clears the one-trade guardrail.
      const { caps, fees } = state.hello;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let slice = (state.cash * FALLBACK_NUM) / FALLBACK_DEN;
      if (slice > byWeight) slice = byWeight;
      if (slice >= BigInt(fees.min_notional_quote_units) && slice > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        fallbackBought = true;
      }
    } else if (belowAverage(close, BUY_BPS)) {
      // The dip: buy with all the cash, capped by the weight limit.
      const { caps, fees } = state.hello;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let slice = state.cash < byWeight ? state.cash : byWeight;
      if (slice >= BigInt(fees.min_notional_quote_units) && slice > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    return orders;
  },
});
