import { PublicKey } from "@solana/web3.js";
import { fromHex, keccakHex, type Hex } from "./RoundId";

/**
 * How a settled pot is split (docs/LandpotPot.md):
 *
 * - the contract takes floor(balance·burnBps/1e4) to burn and
 *   floor(balance·treasuryBps/1e4) for the treasury, each floored on its own;
 * - a depositor who was not in the match when it started gets their entry
 *   back less their share of those fees: floor(net / depositors);
 * - the rest is split in proportion to the land each depositor who played
 *   held when the match ended, by largest remainder so the shares sum to it
 *   exactly;
 * - leftover units go to the largest fractional remainders, ties to the
 *   lower keccak256(roundId ‖ wallet public key bytes), which nobody can
 *   choose in advance.
 *
 * Wallets are base58 public keys and compared exactly. Amounts come back in
 * the escrow's deposit order (`players(roundId)`),
 * which is the order `propose` expects. A depositor who played and held no
 * land gets 0.
 */

export interface FeeRules {
  burnBps: number;
  treasuryBps: number;
}

export function netPot(balance: bigint, rules: FeeRules): bigint {
  return (
    balance -
    (balance * BigInt(rules.burnBps)) / 10_000n -
    (balance * BigInt(rules.treasuryBps)) / 10_000n
  );
}

export class NoTerritoryError extends Error {
  constructor() {
    super("no depositor held any land; the round should be refunded");
  }
}

export function splitPot(opts: {
  net: bigint;
  roundId: Hex;
  /** Depositors, in escrow order. */
  players: readonly string[];
  /** Land per depositor. Missing means 0. */
  land: ReadonlyMap<string, bigint>;
  /**
   * Depositors who were in the match when it started.
   * The others are refunded. Omitted: everyone played.
   */
  played?: ReadonlySet<string>;
}): bigint[] {
  const { net, roundId, players } = opts;
  if (new Set(players).size !== players.length) {
    throw new Error("duplicate depositor");
  }
  const played = opts.played ?? null;
  const absent = players.map((p) => !!played && !played.has(p));
  const weights = players.map((p, i) => {
    if (absent[i]) return 0n;
    const w = opts.land.get(p) ?? 0n;
    if (w < 0n) throw new Error("negative land");
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new NoTerritoryError();

  // Entries are equal, so each absent depositor's refund is one share of net.
  const refund = net / BigInt(players.length);
  const prize = net - refund * BigInt(absent.filter(Boolean).length);
  const amounts = weights.map((w, i) =>
    absent[i] ? refund : (prize * w) / total,
  );
  const remainders = weights.map((w) => (prize * w) % total);
  let leftover = net - amounts.reduce((a, b) => a + b, 0n);

  const id = fromHex(roundId);
  const tie = players.map((p) => {
    const key = new PublicKey(p).toBytes();
    const bytes = new Uint8Array(id.length + key.length);
    bytes.set(id);
    bytes.set(key, id.length);
    return BigInt(keccakHex(bytes));
  });
  const order = players
    .map((_, i) => i)
    .filter((i) => weights[i] > 0n)
    .sort((a, b) => {
      if (remainders[a] !== remainders[b]) {
        return remainders[a] > remainders[b] ? -1 : 1;
      }
      return tie[a] < tie[b] ? -1 : tie[a] > tie[b] ? 1 : 0;
    });
  // leftover < number of players with land, so one pass is enough.
  for (const i of order) {
    if (leftover === 0n) break;
    amounts[i] += 1n;
    leftover -= 1n;
  }
  return amounts;
}
