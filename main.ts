// Completion Rider v4 — a survivorship bot for agent-fun/replay/v2.
//
// What the dev data actually showed (24h frozen window, 1222 coins):
//   - 27 of the 35 coins that complete do so in their CREATION slot. A bot
//     that decides once per batch, with 2 slots of latency, can never buy
//     those: by decision time they are already complete. Chasing them is
//     wasted effort; the only completions a batch bot can catch are the
//     handful that live for minutes (7 here, living 345-2205 slots).
//   - Those slow completions are unmistakable in hindsight — huge reserves
//     and hundreds of buyers within minutes — but at entry time no
//     per-trade feature (buyers, trades, dev buy, biggest buy) separates
//     them from the coins that die. The market at this granularity is
//     mostly a lottery: ~20% of buyable coins ever reach 2x, the rest fade
//     to ~zero within minutes.
//   - The one filter that works is survivorship: a coin still holding
//     >= 15 SOL of real reserve a few hundred slots after creation has
//     outlived the initial dump phase, and most of the slow completions
//     are still buyable then. The classic rug filters (sell ratio, biggest
//     sell, creator-sold) actively HURT here: the slow completions have
//     heavy selling and creator profit-taking all through their run-up,
//     so those filters exclude exactly the coins worth catching.
//   - Doubling down on risers and take-profit exits both lost money in
//     replay; a plain reserve trailing stop plus a max hold was best.
//
// Shape: few selective entries, one stake per coin, hold toward completion.
//   - Entry (decided once per coin, age 250-3600 slots): real SOL reserve
//     >= 15 SOL, at least 5 trades and 3 distinct non-creator buyers.
//     No rug filters at all. Buy min(0.15 SOL, the 1%-of-real-reserve
//     size cap) — small enough that the ~80% of picks that die cost
//     little, big enough that a completion pays.
//   - Exits: a reserve trailing stop (exit when the real SOL reserve
//     falls 20% from its peak since entry — reserve only falls on net
//     selling, so this cuts losers while they still hold value) and an
//     absolute max hold of 8000 slots. The harness itself closes a
//     position when its curve completes — that is the win this bot is
//     built to catch. No dev-sell exit, no price stop, no take-profit,
//     no adds: on this data every one of those cost money.
//
// Fully deterministic: slot counts only, no clock, no randomness, no I/O.
// Slippage is left wide open (10_000 bps) so a fill is never refused for
// the price moving during the 2-slot latency.

import {
  BPS,
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---- entry knobs ---------------------------------------------------------
const STAKE_TARGET = 150_000_000n; // 0.15 SOL: buy min(this, size cap)
const MIN_RESERVE = 15_000_000_000n; // 15 SOL of real reserve before entry
const MIN_BUYERS = 3;
const MIN_TRADES = 5;
const MIN_ENTRY_AGE = 250; // slots since creation: survivorship filter
const MAX_ENTRY_AGE = 3600; // slots since creation
const BUY_SLIPPAGE_BPS = 10_000;

// ---- exit knobs ----------------------------------------------------------
const RQ_TRAIL_BPS = 2000n; // exit when real reserve falls 20% from peak
const MAX_HOLD_SLOTS = 8000; // absolute max hold, slots (~30 min)
const SELL_SLIPPAGE_BPS = 10_000;

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  trades: number;
  buyers: Set<Pubkey>;
  boughtOnce: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Real SOL reserve at entry; the trailing stop measures against its peak. */
  entryRq: bigint;
  peakRq: bigint;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Per-run registries, created once on the first batch.
    const registry = getRegistries(state);
    const held = registry.held;
    const tx = state.txFeeLamports();
    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderInput[] = [];

    // ---- fold this batch's events into the coin tape ---------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!registry.coins.has(e.mint)) {
          registry.coins.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            createSlot: e.slot,
            trades: 0,
            buyers: new Set(),
            boughtOnce: false,
            complete: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = registry.coins.get(e.mint);
        if (c === undefined) continue;
        c.trades += 1;
        // Distinct NON-creator buyers: the creator's own buys don't prove
        // outside demand.
        if (e.is_buy && e.user !== c.creator) c.buyers.add(e.user);
      } else {
        const c = registry.coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // ---- fold fills into held-position bookkeeping -----------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        registry.selling.delete(f.mint);
        continue;
      }
      if (f.status !== 'filled' || f.side !== 'buy') continue;
      if (!held.has(f.mint)) {
        const rq = registry.entryRq.get(f.mint) ?? state.curves.get(f.mint)?.real_quote_reserves ?? 0n;
        held.set(f.mint, {
          openedSlot: f.slot,
          entryRq: rq,
          peakRq: rq,
        });
      }
    }
    for (const mint of [...registry.selling]) {
      if (!hasPendingSell(state, mint)) registry.selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !registry.selling.has(mint)) {
        held.delete(mint);
      }
    }

    // ---- exits first ------------------------------------------------------
    // Only two exits: the reserve trailing stop and the absolute max hold.
    // Everything else is held toward completion, where the harness closes
    // the position for us.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (registry.selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        const rq = curve?.real_quote_reserves ?? 0n;
        h = { openedSlot: state.slot, entryRq: rq, peakRq: rq };
        held.set(mint, h);
      }
      let exit = false;
      if (curve !== undefined) {
        const rq = curve.real_quote_reserves;
        if (rq > h.peakRq) h.peakRq = rq;
        if (h.peakRq > 0n && rq * BPS <= h.peakRq * (BPS - RQ_TRAIL_BPS)) exit = true;
      }
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      registry.selling.add(mint);
    }

    // ---- entries ----------------------------------------------------------
    let free = state.freeCashLamports();
    let open = state.committedPositionCount();
    for (const c of registry.coins.values()) {
      if (orders.length >= cap) break;
      if (c.complete || c.boughtOnce) continue;
      const age = state.slot - c.createSlot;
      if (age < MIN_ENTRY_AGE || age > MAX_ENTRY_AGE) continue;
      if (open >= state.hello.caps.max_open_positions) break;
      if (c.trades < MIN_TRADES || c.buyers.size < MIN_BUYERS) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_RESERVE) continue;
      const sizeCap = state.maxBuyLamports(c.mint);
      const amount = STAKE_TARGET < sizeCap ? STAKE_TARGET : sizeCap;
      if (amount < 10_000_000n) continue; // round trips must be >= 0.01 SOL
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      registry.entryRq.set(c.mint, curve.real_quote_reserves);
      free -= amount + tx;
      open += 1;
      c.boughtOnce = true;
    }

    return orders;
  },
});

// Per-run registries, attached to the state object so onBatch stays a pure
// function of the batches it is fed. Created once, on the first batch.
function getRegistries(state: BotState): {
  coins: Map<Pubkey, Coin>;
  held: Map<Pubkey, Held>;
  selling: Set<Pubkey>;
  entryRq: Map<Pubkey, bigint>;
} {
  const s = state as unknown as Record<string, unknown>;
  let r = s.__rider as
    | { coins: Map<Pubkey, Coin>; held: Map<Pubkey, Held>; selling: Set<Pubkey>; entryRq: Map<Pubkey, bigint> }
    | undefined;
  if (r === undefined) {
    r = { coins: new Map(), held: new Map(), selling: new Set(), entryRq: new Map() };
    s.__rider = r;
  }
  return r;
}
