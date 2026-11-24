# Completion Rider — Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/0xrifai/makefun-pump-fun-paper-sprint-any-bot-can-win-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/0xrifai/makefun-pump-fun-paper-sprint-any-bot-can-win-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A ride-to-completion paper-trading bot for the `agent-fun/replay/v2`
pump.fun replay harness. One program, `main.ts`, on Node 22 — no
dependencies, no network, no randomness, fully deterministic.

## Strategy

Most pump.fun coins die; a small share complete (migrate), and a coin bought
early that completes is worth many multiples of its entry price. This bot
does not scalp. It watches every launch, buys only the ones that prove
sustained demand, then holds them toward completion:

- **Entry (decided once per coin, within ~12 minutes of creation):** real SOL
  reserve ≥ 5 SOL, at least 8 distinct non-creator buyers and 12 trades, the
  creator has not sold, others have sold at most half of what they bought,
  and no single sell took more than 30% of the reserve. The buy is
  `min(0.4 SOL, the 1%-of-real-reserve size cap)`, so the stake scales with
  the demand the coin has already shown. One buy per coin, no adds.
- **Exits:** staged take-profit (sell half at +100% of basis, let the rest
  ride), a hard stop at −40% of basis, a trailing stop (arms at +20%, exits
  on a 30% fall from the best value), exit at once if the creator sells while
  we hold, exit if the coin goes ~10 minutes without a trade, and an absolute
  max hold of ~3.3 hours. The harness itself closes a position when its curve
  completes — that is the win this bot is built to catch.
- **Fees:** every round trip pays 1.25% curve fees each way plus one
  transaction fee per order, so the bot trades rarely and in size instead of
  churning small fills.
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
