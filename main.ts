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
//   - real SOL reserve at least MIN_RESERVE (demand has actually arrived)
//   - at least MIN_BUYERS distinct non-creator buyers and MIN_TRADES trades
//   - the creator has not sold
//   - others have sold at most half of what they bought, and no single sell
//     took more than MAX_BIG_SELL_BPS of the reserve before it
//   - buy min(STAKE_TARGET, the 1%-of-real-reserve size cap), so the stake
//     scales with the demand the coin has already shown
//
// Exits (checked every batch on every held position):
//   - staged take-profit: at +100% of basis sell half, let the rest ride
//   - hard stop at -40% of basis
//   - trailing stop: once the position is +20% at its best, exit on a 30%
//     fall from that best
//   - creator sells while we hold -> exit at once
//   - no trade for STALE_SLOTS slots -> exit (a stalled coin blocks a slot)
//   - held longer than MAX_HOLD_SLOTS -> exit
//   - the harness itself closes a position when its curve completes, which
//     is the win this bot is built to catch.
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
const MIN_RESERVE = 5_000_000_000n; // 5 SOL of real reserve before entry
const MIN_BUYERS = 8;
const MIN_TRADES = 12;
const MAX_ENTRY_AGE = 1800; // slots since creation (~12 min)
const MAX_SELL_RATIO_BPS = 5000n; // sold by others / bought, at most 50%
const MAX_BIG_SELL_BPS = 3000n; // biggest single sell, bps of reserve
const BUY_SLIPPAGE_BPS = 10_000;

// ---- exit knobs ----------------------------------------------------------
const TP1_BPS = 10_000n; // value >= 2x basis -> sell TP1_PART of tokens
const TP1_PART_BPS = 5000n; // half the position
const HARD_STOP_BPS = 4000n; // exit when value <= basis * (1 - 40%)
const TRAIL_ARM_BPS = 2000n; // trailing stop arms at +20% over basis
const TRAIL_BPS = 3000n; // exit on a 30% fall from the best value
const STALE_SLOTS = 1500; // no trade for this long -> exit
const MAX_HOLD_SLOTS = 30_000; // absolute max hold, slots (~3.3 h)
const SELL_SLIPPAGE_BPS = 10_000;

// Curve fees on a sell: protocol 95 bps + creator 30 bps (fallbacks).
const FEE_BPS = 125n;

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
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const out = (tokens * vq) / (vt + tokens);
  return out - (out * FEE_BPS + BPS - 1n) / BPS;
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
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, {
        vq: BigInt(m.virtual_quote_reserves),
        vt: BigInt(m.virtual_token_reserves),
      });
    }
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        registry.selling.delete(f.mint);
        continue;
      }
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        if (!held.has(f.mint)) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: registry.coins.get(f.mint)?.devSold ?? false,
          });
        }
      } else {
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
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
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (registry.selling.has(mint)) continue;
      const c = registry.coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = {
          openedSlot: state.slot,
          txPaid: tx,
          best: 0n,
          tookTp1: false,
          devSoldAtOpen: c?.devSold ?? false,
        };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (basis <= 0n) continue;
      if (value > h.best) h.best = value;

      // Staged take-profit: bank half at +100%, keep riding the rest.
      if (!h.tookTp1 && value * BPS >= basis * (BPS + TP1_BPS)) {
        const part = (pos.token_amount * TP1_PART_BPS) / BPS;
        if (part > 0n && part < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: SELL_SLIPPAGE_BPS });
          registry.selling.add(mint);
          h.tookTp1 = true;
          h.best = 0n;
          continue;
        }
      }

      let exit = false;
      if (value * BPS <= basis * (BPS - HARD_STOP_BPS)) exit = true;
      if (
        h.best * BPS >= basis * (BPS + TRAIL_ARM_BPS) &&
        value * BPS <= h.best * (BPS - TRAIL_BPS)
      ) {
        exit = true;
      }
      if (c !== undefined) {
        if (c.devSold && !h.devSoldAtOpen) exit = true;
        if (state.slot - c.lastTradeSlot >= STALE_SLOTS) exit = true;
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
} {
  const s = state as unknown as Record<string, unknown>;
  let r = s.__rider as
    | { coins: Map<Pubkey, Coin>; held: Map<Pubkey, Held>; selling: Set<Pubkey> }
    | undefined;
  if (r === undefined) {
    r = { coins: new Map(), held: new Map(), selling: new Set() };
    s.__rider = r;
  }
  return r;
}
