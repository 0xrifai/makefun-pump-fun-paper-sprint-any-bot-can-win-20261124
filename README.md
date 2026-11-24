# Completion Rider — Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/0xrifai/makefun-pump-fun-paper-sprint-any-bot-can-win-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/0xrifai/makefun-pump-fun-paper-sprint-any-bot-can-win-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A ride-to-completion paper-trading bot for the `agent-fun/replay/v2`
pump.fun replay harness. One program, `main.ts`, on Node 22 — no
dependencies, no network, no randomness, fully deterministic.

## Strategy

Most pump.fun coins die; a small share complete (migrate), and a coin bought
early that completes is worth many multiples of its entry price. But the
dev data shows a hard constraint: 27 of the 35 completions in the frozen
24-hour window happen in the coin's creation slot, and a bot that decides
once per batch with 2 slots of latency can never buy those. The only
completions a batch bot can catch are the handful that live for minutes
(7 here). This bot is built around that fact:

- **Entry (decided once per coin, age 250–3600 slots):** real SOL reserve
  ≥ 15 SOL, at least 5 trades and 3 distinct non-creator buyers. The age
  floor is a survivorship filter — a coin still holding ≥ 15 SOL a few
  hundred slots after creation has outlived the initial dump phase, and
  most of the slow completions are still buyable then. There are no rug
  filters: the slow completions show heavy selling and creator
  profit-taking all through their run-up, so sell-ratio, biggest-sell and
  creator-sold filters exclude exactly the coins worth catching. One buy
  per coin, `min(0.15 SOL, the 1%-of-real-reserve size cap)`.
- **Exits:** a reserve trailing stop (exit when the real SOL reserve falls
  20% from its peak since entry — reserve only falls on net selling, so
  this cuts losers while they still hold value) and an absolute max hold
  of 8000 slots. The harness itself closes a position when its curve
  completes — that is the win this bot is built to catch. No dev-sell
  exit, no price stop, no take-profit, no doubling down: replay testing
  showed every one of those cost money on this data.
- **Fees:** every round trip pays 1.25% curve fees each way plus one
  transaction fee per order, so the bot trades rarely and in size instead
  of churning small fills.
- **Guardrails:** every buy is at least 0.01 SOL (the round-trip minimum),
  at most 5 positions are open at once, and the small stakes keep the
  portfolio drawdown far below the 50% limit.

## Why this shape

A fast in/out sniper on the same harness family scored a positive gross PnL
that per-fill fees ate across dozens of small fills. This bot is the opposite
shape: a handful of large, selective entries held for the big move, so fees
are a small share of each round trip and a single completion can pay for many
losers.

## Run it

Grade locally with the kit's CLI (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
