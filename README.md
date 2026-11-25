# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nadanese93/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nadanese93/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the six-hour pump.fun replay in the
Pump.fun Sharpe Sprint bounty on make.fun.

The entry point is `main.ts`, run by the grader as `node /bot/main.ts` on
Node 22. It speaks the agent-fun replay protocol through the vendored SDK
shim in `vendor/makefun-bot.ts` and trades paper funds only, on the replay
data the house provides. No network access, no real funds, no randomness:
every decision follows from the batch stream alone, so two runs of the same
entry produce identical action logs.

## Layout

- `main.ts` — the bot: entry and exit logic for the replay.
- `vendor/makefun-bot.ts` — the kit SDK shim, vendored byte for byte.
- `LICENSE` — MIT license.
