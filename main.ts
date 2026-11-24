// Completion Rider — a ride-to-completion bot for agent-fun/replay/v2.
//
// Shape: far fewer trades, bigger stake per coin, hold winners a long time.
// Most pump.fun coins die; a small share complete (migrate), and a coin bought
// early that completes is worth many multiples of its entry price. So this bot
// does NOT scalp. It watches every launch, buys only the ones that prove
// sustained demand, then holds them toward completion and exits only on a
// clear failure signal (hard stop, trailing stop, creator sell, stall) or a
// staged take-profit. One buy per coin, no adds, no re-entry.
//
// Entry (all must hold, decided once per coin):
//   - age at most MAX_ENTRY_AGE slots since creation
//   - real SOL reserve at least MIN_RESERVE (demand has actually arrived:
//     reaching 15 SOL of real reserve in a handful of trades means a crowd
//     is buying, not one wallet; the count of distinct buyers matters less
//     than the reserve itself, so MIN_BUYERS is low)
//   - at least MIN_TRADES trades and MIN_BUYERS distinct non-creator buyers
//   - the creator has not sold
//   - others have sold at most half of what they bought, and no single sell
//     took more than MAX_BIG_SELL_BPS of the reserve before it
//   - buy min(STAKE_TARGET, the 1%-of-real-reserve size cap), so the stake
//     scales with the demand the coin has already shown
//
// Exits (checked every batch on every held position):
//   - reserve trailing stop: when the real SOL reserve falls 30% from its
//     peak since entry, the crowd is leaving — exit while value remains.
//     Reserve is a smoothed demand signal: it only falls on net selling,
//     so this cuts losers far earlier than a price stop, which on this data
//     realised losses on coins that later recovered.
//   - the creator sells while we hold -> exit at once (a rug signal)
//   - held longer than MAX_HOLD_SLOTS -> exit and free the slot
//   - the harness itself closes a position when its curve completes, which
//     is the win this bot is built to catch.
// Deliberately NO price stop-loss, price trailing stop, stale exit or staged
// take-profit: on this data those exits realised losses on coins that later
// recovered and cut winners before completion.
//
// Fully deterministic: slot counts only, no clock, no randomness, no I/O.
// Slippage is left wide open (10_000 bps) so a fill is never refused for the
// price moving during the 2-slot latency.

import {
  BPS,
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry knobs ---------------------------------------------------------
const STAKE_TARGET = 400_000_000n; // 0.4 SOL: buy min(this, size cap)
const MIN_RESERVE = 15_000_000_000n; // 15 SOL of real reserve before entry
const MIN_BUYERS = 3;
const MIN_TRADES = 5;
const MAX_ENTRY_AGE = 1800; // slots since creation (~12 min)
const MAX_SELL_RATIO_BPS = 5000n; // sold by others / bought, at most 50%
const MAX_BIG_SELL_BPS = 3000n; // biggest single sell, bps of reserve
const BUY_SLIPPAGE_BPS = 10_000;

// ---- exit knobs ----------------------------------------------------------
// v3: the only exits are the reserve trailing stop (below), a creator sell
// and an absolute max hold. v1's price stops and v2's hold-to-completion
// both lost money on this data; the reserve trailing stop is what cut the
// loser drag from ~-5 SOL to ~-0.3 SOL in offline replay while keeping
// most completions.
const RQ_TRAIL_BPS = 3000n; // exit when real reserve falls 30% from peak
const MAX_HOLD_SLOTS = 30_000; // absolute max hold, slots (~1.8 h)
const SELL_SLIPPAGE_BPS = 10_000;

// Curve fees on a sell: protocol 95 bps + creator 30 bps (fallbacks).
// (Kept for reference: exits no longer price positions, they hold to
// completion, so no sell-value math is needed on the hot path.)

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  lastTradeSlot: number;
  boughtOnce: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  devSoldAtOpen: boolean;
  /** Real SOL reserve at entry; the trailing stop measures against its peak. */
  entryRq: bigint;
  peakRq: bigint;
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
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
            devSold: false,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            lastTradeSlot: e.slot,
            boughtOnce: false,
            complete: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = registry.coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const before = BigInt(e.real_quote_reserves) + sol;
          if (before > 0n) {
            const bps = (sol * BPS) / before;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
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
          devSoldAtOpen: registry.coins.get(f.mint)?.devSold ?? false,
          entryRq: rq,
          peakRq: rq,
        });
      }
    }
    for (const mint of [...registry.selling]) {
      if (!hasPending(state, mint, 'sell')) registry.selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (
        !state.positions.has(mint) &&
        !registry.selling.has(mint) &&
        !hasPending(state, mint, 'buy')
      ) {
        held.delete(mint);
      }
    }

    // ---- exits first ------------------------------------------------------
    // Only three exits: the reserve trailing stop, a creator sell, and the
    // absolute max hold. Everything else is held toward completion, where
    // the harness closes the position for us.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (registry.selling.has(mint)) continue;
      const c = registry.coins.get(mint);
      const curve = state.curves.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        const rq = curve?.real_quote_reserves ?? 0n;
        h = {
          openedSlot: state.slot,
          devSoldAtOpen: c?.devSold ?? false,
          entryRq: rq,
          peakRq: rq,
        };
        held.set(mint, h);
      }
      let exit = false;
      if (curve !== undefined) {
        const rq = curve.real_quote_reserves;
        if (rq > h.peakRq) h.peakRq = rq;
        if (h.peakRq > 0n && rq * BPS <= h.peakRq * (BPS - RQ_TRAIL_BPS)) exit = true;
      }
      if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
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
      if (age > MAX_ENTRY_AGE) continue;
      if (open >= state.hello.caps.max_open_positions) break;
      if (c.devSold) continue;
      if (c.trades < MIN_TRADES || c.buyers.size < MIN_BUYERS) continue;
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * MAX_SELL_RATIO_BPS) continue;
      if (c.bigSellBps > MAX_BIG_SELL_BPS) continue;
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
