[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/sherrypubg128-blip/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/sherrypubg128-blip/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

# Steady Swing — a BTC trading bot

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
in make.fun's "Race a BTC trading bot live for 24 hours" bounty
([btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603)).
It starts with $1,000 of paper money and is ranked by net PnL on the 24-hour
race window.

## The strategy

cbBTC on 1-minute bars is mostly noise: a typical 1-minute move is about
6 bps, while a full round trip costs about 26 bps in fees, slippage and price
impact. Trading every wiggle is a guaranteed bleed. So this bot waits for the
slow, wide swings:

- It tracks the 120-bar (two-hour) simple moving average of closes.
- **Buy** with all its cash when the latest close sits at least 60 bps below
  that average — a real dip, not noise.
- **Sell** everything when the close climbs back to 60 bps above the average,
  or if the position falls 150 bps under what it paid (a stop-loss that caps
  a genuine downtrend).
- **Insurance:** the race requires at least 1 trade, so if the bot has made
  no filled trade by scored bar 1300 it buys half its cash and sells it on a
  40 bps move either way. That rule never fired on the dev window; it exists
  only so a very quiet race window cannot leave the bot with zero trades.

Wide bands are the point: on the published dev window every narrow-band and
fast-crossover variant tested lost money, while the wide swing made money at
every nearby parameter choice. It trades rarely and its worst drawdown on the
dev window was 1.3%. A 120-bar average (rather than 60) also keeps signalling
in a quiet stretch: the 60-bar version made no trade at all in the dev
window's second half, while the 120-bar version traded in both halves.

## Dev window grade

| | |
|---|---|
| Net PnL | **+$12.67** |
| Trades | 6 |
| Max drawdown | 1.3% |

Graded locally with the kit's `grade-local` on the frozen 24h dev window.

## How it runs

Node 22, standard library only. `main.ts` speaks the
`agent-fun/bars-replay/v1` protocol (NDJSON on stdin/stdout) through the kit
SDK shim vendored unchanged in `vendor/makefun-bars.ts`. All arithmetic is
exact integer math on the harness's own integer prices, so two runs on the
same bars produce byte-identical action logs. No network, no wall clock, no
environment, no randomness.

## Files

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — the kit SDK shim, byte-for-byte
- `LICENSE` — MIT
- `README.md` — this file
