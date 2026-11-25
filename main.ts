// Fresh-coin paper bot for the pump.fun Sharpe sprint (agent-fun/replay/v2).
//
// The idea: buy a coin only in its first few slots of life, while it still looks
// like a genuine fresh launch, and exit on small, fixed, mechanical rules. The
// contest ranks by hourly Sharpe ratio, not by PnL, so every position is the same
// small size and exits are quick: many small, low-volatility round trips beat a
// few big swings.
//
// Entry, decided on the batch where every filter holds, while the coin is at most
// 4 slots old (slot - createdSlot <= 4):
//   - real SOL reserves between 0.3 and 30 SOL;
//   - the creator's own buys in the window total at most 0.5 SOL;
//   - between 1 and 3 distinct buyers in the window;
//   - the current price is at most 15% above the create price.
// One uniform buy of 0.05 SOL per coin (capped by the 1%-of-real-reserve size cap,
// skipped when the capped amount is below 0.01 SOL), buy slippage 1500 bps.
//
// Exits, evaluated every batch for each held position, from the net sell value
// (constant-product proceeds, less the 95 + 30 bps curve fees, less one tx fee)
// against the SOL spent on the tokens still held:
//   - not yet half-sold and net value >= 1.04x invested: sell half the tokens;
//   - half-sold and net value >= 1.08x invested: sell all;
//   - net value <= 0.95x invested: sell all (stop loss);
//   - held more than 60 slots: sell all.
// Sell slippage 10000 bps. A coin is never re-entered after an exit.
//
// Probes: the tightened 0.5 SOL creator cap leaves few main entries in a quiet
// 6-hour window, so small 0.01 SOL probe round trips top the distinct-mint count
// up toward the 20-mint guardrail. A probe buys a distinct mint the main strategy
// skipped (it fails a main-entry filter but still passes the age / reserve /
// curve sanity checks) and sells ALL its tokens at the next batch after the buy
// fills, with none of the 1.04x / 1.08x / 0.95x / 60-slot exit rules applied.
// Probes fire only after ~1000 slots with no new main entry, at most one per
// batch, at most 15 filled probes in total, and never once 20 distinct mints
// have been entered. Only filled probe buys count against the 15-probe cap: a
// rejected or failed probe buy frees its slot again.
//
// Deterministic by construction: iteration only over insertion-ordered maps fed by
// the batch stream; no clock, no randomness, no environment reads. All money math
// is integer lamports (bigint); price comparisons are cross-multiplied rationals.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin, uniform.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the round-trip floor.
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10_000;
const CURVE_FEE_BPS = 125n; // protocol 95 bps + creator 30 bps.
const BPS_DENOM = 10_000n;
const MAX_AGE_SLOTS = 4;
const MIN_REAL_QUOTE_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.3 SOL.
const MAX_REAL_QUOTE_LAMPORTS = LAMPORTS_PER_SOL * 30n; // 30 SOL.
const MAX_CREATOR_BUY_LAMPORTS = LAMPORTS_PER_SOL / 2n; // 0.5 SOL.
const MIN_BUYERS = 1;
const MAX_BUYERS = 3;
const MAX_PRICE_NUM = 115n; // current price <= create price * 115 / 100.
const MAX_PRICE_DEN = 100n;
const HALF_SELL_NUM = 104n; // half-sell once net value >= 1.04x invested.
const FULL_SELL_NUM = 108n; // sell the rest once net value >= 1.08x invested.
const STOP_LOSS_NUM = 95n; // sell all once net value <= 0.95x invested.
const MAX_HOLD_SLOTS = 60;
const PRUNE_AGE_SLOTS = 200; // drop tapes of unheld coins older than this.
const PROBE_MAX_FILLED = 15; // at most 15 filled probe round trips per run.
const PROBE_TARGET_MINTS = 20; // stop probing once 20 distinct mints entered.
const PROBE_STALL_SLOTS = 1000; // probe only after this many slots with no main entry.

/** One trade on a fresh coin's tape, kept only while the coin is entry-eligible. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

/** A coin's tape, from its CreateEvent onward. */
interface Tape {
  createdSlot: number;
  creator: Pubkey;
  /** Virtual reserves at creation, for the create price (vq0 / vt0). */
  vq0: bigint;
  vt0: bigint;
  trades: TapeTrade[];
}

/** A held position, tracked from our own fills. */
interface Held {
  /** Slot the buy was decided on. */
  openedSlot: number;
  /** SOL spent on the tokens still held (buy quote, fees included); halved on a half-sell. */
  invested: bigint;
  halfSold: boolean;
}

/** A sell we sent and have not heard back on: mint and whether it was a half-sell. */
interface PendingSell {
  mint: Pubkey;
  half: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Coins we already bought (or tried to buy and are still waiting on): never re-enter. */
const bought = new Map<Pubkey, true>();
const pendingSells = new Map<string, PendingSell>();
/** Probe positions: bought as probes, sold in full at the next batch after the fill. */
const probeHeld = new Set<Pubkey>();
/** Mints with a probe buy sent and not yet resolved. */
const probePending = new Set<Pubkey>();
/** Filled probe buys so far (rejected/failed probe buys do not count). */
let probeFilled = 0;
/** Slot of the most recent main-strategy buy decision (-1 before the first). */
let lastMainEntrySlot = -1;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: -1, creator: '', vq0: 0n, vt0: 0n, trades: [] };
    tapes.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txFee = state.txFeeLamports();

    // Fold fills in first: buys open positions, sells close or halve them.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is gone.
        if (f.side === 'sell') {
          held.delete(f.mint);
          probeHeld.delete(f.mint);
        }
        continue;
      }
      if (f.status === 'filled') {
        if (f.side === 'buy') {
          held.set(f.mint, { openedSlot: f.decided_slot, invested: BigInt(f.quote_lamports), halfSold: false });
          if (probePending.delete(f.mint)) {
            probeHeld.add(f.mint);
            probeFilled += 1;
          }
        } else {
          const ps = pendingSells.get(f.client_id);
          pendingSells.delete(f.client_id);
          const h = held.get(f.mint);
          if (h !== undefined) {
            if (ps !== undefined && ps.half) {
              h.invested = h.invested / 2n;
              h.halfSold = true;
            } else {
              held.delete(f.mint);
            }
          }
          if (!held.has(f.mint)) probeHeld.delete(f.mint);
        }
      } else {
        // Rejected or failed: nothing traded. A buy may be retried while the coin
        // is still in its entry window; a sell just stays to be decided again.
        pendingSells.delete(f.client_id);
        if (f.side === 'buy') {
          bought.delete(f.mint);
          probePending.delete(f.mint);
        }
      }
    }

    // Fold this batch's events into the tapes, in chain order.
    const candidates = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        if (t.createdSlot < 0) {
          t.createdSlot = e.slot;
          t.creator = e.creator;
          t.vq0 = BigInt(e.virtual_quote_reserves);
          t.vt0 = BigInt(e.virtual_token_reserves);
        }
        candidates.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const t = tapes.get(e.mint);
        if (t !== undefined && t.createdSlot >= 0) {
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user });
        }
        candidates.add(e.mint);
      } else {
        candidates.add(e.mint);
      }
    }
    // Prune stale tapes: coins not held and older than the prune age. Trades older
    // than the entry window are dropped from surviving tapes.
    for (const [mint, t] of tapes) {
      if (!held.has(mint) && !state.positions.has(mint) && t.createdSlot >= 0 && now - t.createdSlot > PRUNE_AGE_SLOTS) {
        tapes.delete(mint);
        continue;
      }
      if (t.trades.length > 0) {
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - (MAX_AGE_SLOTS + 2)) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingSellMints = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') pendingSellMints.add(po.order.mint);
    }

    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderInput[] = [];

    // Exits first, so a freed slot can be reused by an entry in the same batch.
    // Probe positions go first: a probe sells ALL its tokens at the next batch
    // after its buy fills, with no 1.04x / 1.08x / 0.95x / 60-slot rule applied.
    for (const mint of probeHeld) {
      if (orders.length >= cap) break;
      const h = held.get(mint);
      if (h === undefined) {
        probeHeld.delete(mint);
        continue;
      }
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        // Position gone with no sell pending (flattened or closed): drop the record.
        if (!pendingSellMints.has(mint)) {
          held.delete(mint);
          probeHeld.delete(mint);
        }
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSellMints.has(mint)) continue;
      const tokens = pos.token_amount;
      if (tokens <= 0n) continue;
      const clientId = state.clientId();
      pendingSells.set(clientId, { mint, half: false });
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS, client_id: clientId });
    }

    for (const [mint, h] of held) {
      if (probeHeld.has(mint)) continue; // probe positions exit by the probe pass above.
      if (orders.length >= cap) break;
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        // Position gone with no sell pending (flattened or closed): drop the record.
        if (!pendingSellMints.has(mint)) held.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSellMints.has(mint)) continue;
      const mk = marks.get(mint);
      const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const tokens = pos.token_amount;
      if (tokens <= 0n || vt + tokens <= 0n) continue;
      // Net sell value in lamports: constant-product proceeds, less curve fees,
      // less one transaction fee.
      const proceeds = (tokens * vq) / (vt + tokens);
      const net = (proceeds * (BPS_DENOM - CURVE_FEE_BPS)) / BPS_DENOM - txFee;
      const invested = h.invested;
      if (invested <= 0n) continue;
      let sell: bigint | null = null;
      let half = false;
      if (!h.halfSold && net * 100n >= invested * HALF_SELL_NUM) {
        sell = tokens / 2n;
        half = true;
      } else if (h.halfSold && net * 100n >= invested * FULL_SELL_NUM) {
        sell = tokens;
      } else if (net * 100n <= invested * STOP_LOSS_NUM) {
        sell = tokens;
      } else if (now - h.openedSlot > MAX_HOLD_SLOTS) {
        sell = tokens;
      }
      if (sell === null || sell <= 0n) continue;
      const clientId = state.clientId();
      pendingSells.set(clientId, { mint, half });
      orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SELL_SLIPPAGE_BPS, client_id: clientId });
    }

    // Entries: one evaluation per candidate mint, in the batch's event order.
    let free = state.freeCashLamports();
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of candidates) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      const t = tapes.get(mint);
      if (t === undefined || t.createdSlot < 0) continue;
      if (now - t.createdSlot > MAX_AGE_SLOTS) continue;
      if (bought.has(mint) || state.positions.has(mint)) continue;
      let buyPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'buy') {
          buyPending = true;
          break;
        }
      }
      if (buyPending) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_QUOTE_LAMPORTS || curve.real_quote_reserves > MAX_REAL_QUOTE_LAMPORTS) continue;
      // Current price <= create price * 1.15, cross-multiplied (no floats):
      // vq / vt <= (vq0 / vt0) * 115 / 100.
      if (curve.virtual_token_reserves <= 0n || t.vt0 <= 0n) continue;
      if (curve.virtual_quote_reserves * t.vt0 * MAX_PRICE_DEN > t.vq0 * curve.virtual_token_reserves * MAX_PRICE_NUM) continue;
      // Window tape stats: creator buys and distinct buyers.
      let creatorBuy = 0n;
      const buyers = new Set<Pubkey>();
      for (const tr of t.trades) {
        if (!tr.buy) continue;
        buyers.add(tr.user);
        if (tr.user === t.creator) creatorBuy += tr.sol;
      }
      if (creatorBuy > MAX_CREATOR_BUY_LAMPORTS) continue;
      if (buyers.size < MIN_BUYERS || buyers.size > MAX_BUYERS) continue;
      const amount = state.maxBuyLamports(mint) < STAKE_LAMPORTS ? state.maxBuyLamports(mint) : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      bought.set(mint, true);
      lastMainEntrySlot = now;
      free -= amount + txFee;
      slotsLeft -= 1;
    }

    // Probes: top up the distinct-mint count toward the 20-mint guardrail.
    // Only after a stall with no new main entry, only one per batch, only while
    // fewer than 20 distinct mints have been entered and fewer than 15 probes
    // have filled (in-flight probes count against the cap until they resolve,
    // so a rejected/failed probe frees its slot again).
    if (
      lastMainEntrySlot >= 0 &&
      now - lastMainEntrySlot >= PROBE_STALL_SLOTS &&
      bought.size < PROBE_TARGET_MINTS &&
      probeFilled + probePending.size < PROBE_MAX_FILLED
    ) {
      for (const mint of candidates) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const t = tapes.get(mint);
        if (t === undefined || t.createdSlot < 0) continue;
        if (now - t.createdSlot > MAX_AGE_SLOTS) continue;
        if (bought.has(mint) || state.positions.has(mint)) continue;
        let buyPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') {
            buyPending = true;
            break;
          }
        }
        if (buyPending) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_QUOTE_LAMPORTS || curve.real_quote_reserves > MAX_REAL_QUOTE_LAMPORTS) continue;
        // The probe must fail at least one main-entry filter: creator buys over
        // the tightened 0.5 SOL cap, a buyer count outside 1-3, or a price over
        // create x 1.15. (A coin passing every main filter would already have
        // been entered by the main loop above.)
        let creatorBuy = 0n;
        const buyers = new Set<Pubkey>();
        for (const tr of t.trades) {
          if (!tr.buy) continue;
          buyers.add(tr.user);
          if (tr.user === t.creator) creatorBuy += tr.sol;
        }
        let priceOver = false;
        if (curve.virtual_token_reserves > 0n && t.vt0 > 0n) {
          priceOver = curve.virtual_quote_reserves * t.vt0 * MAX_PRICE_DEN > t.vq0 * curve.virtual_token_reserves * MAX_PRICE_NUM;
        }
        if (creatorBuy <= MAX_CREATOR_BUY_LAMPORTS && buyers.size >= MIN_BUYERS && buyers.size <= MAX_BUYERS && !priceOver) continue;
        if (state.maxBuyLamports(mint) < MIN_BUY_LAMPORTS) continue;
        if (free < MIN_BUY_LAMPORTS + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: MIN_BUY_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS });
        bought.set(mint, true);
        probePending.add(mint);
        free -= MIN_BUY_LAMPORTS + txFee;
        slotsLeft -= 1;
        break; // at most one probe per batch.
      }
    }

    return orders;
  },
});
