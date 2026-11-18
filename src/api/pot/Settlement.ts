import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { GameRecord } from "@openfront/shared/WireSchemas";
import { RoundPhase, type EscrowChain } from "./EscrowChain";
import { netPot, NoTerritoryError, splitPot } from "./Payouts";
import { keccakHex, roundIdOf, type Hex } from "./RoundId";

/**
 * Settles a paid match (docs/LandpotPot.md): replay the archived record on
 * our own simulation, turn each depositor's final land into their share of
 * the pot and propose it to the escrow, co-signed by the oracle key. Nothing a
 * client reported is trusted: territory comes from the replay, identities
 * from our database, depositors from the chain.
 */

export type Replayer = (record: GameRecord) => Promise<ReplayedWinner | null>;

export interface SettlementDeps {
  chain: EscrowChain;
  replay: Replayer;
  /** The wallet signed in as this persistentID, or null. */
  walletOf: (persistentID: string) => string | null;
}

export type SettleOutcome =
  | {
      status: "proposed";
      roundId: Hex;
      tx: string;
      players: string[];
      amounts: bigint[];
      replayHash: Hex;
    }
  /** Already past the point settlement acts on; nothing sent. */
  | { status: "skipped"; roundId: Hex; reason: string }
  /** Could not settle; the guardian should cancel so entries are refunded. */
  | { status: "void"; roundId: Hex; reason: string };

export async function settleGame(
  deps: SettlementDeps,
  /** The record exactly as archived: its hash goes on chain with the result. */
  raw: Uint8Array,
  record: GameRecord,
): Promise<SettleOutcome> {
  const roundId = roundIdOf(record.info.gameID);
  const status = await deps.chain.status(roundId);
  if (status.phase !== RoundPhase.Started) {
    return {
      status: "skipped",
      roundId,
      reason: `round is ${RoundPhase[status.phase]}`,
    };
  }

  const replayed = await deps.replay(record);
  if (replayed === null) {
    return { status: "void", roundId, reason: "replay failed" };
  }

  // Land per wallet: a player's clientID → their persistentID (in the record)
  // → the wallet they signed in with (our database).
  // The record's players are exactly those connected when the match started
  // (nobody joins later); depositors not among them are refunded.
  const land = new Map<string, bigint>();
  const played = new Set<string>();
  for (const p of record.info.players) {
    if (p.persistentID === null) continue;
    const wallet = deps.walletOf(p.persistentID);
    if (!wallet) continue;
    played.add(wallet);
    const tiles = BigInt(replayed.territory[p.clientID] ?? 0);
    land.set(wallet, (land.get(wallet) ?? 0n) + tiles);
  }

  const players = await deps.chain.players(roundId);
  const fees = await deps.chain.fees();
  let amounts: bigint[];
  try {
    amounts = splitPot({
      net: netPot(status.balance, fees),
      roundId,
      players,
      land,
      played,
    });
  } catch (e) {
    if (e instanceof NoTerritoryError) {
      return { status: "void", roundId, reason: e.message };
    }
    throw e;
  }

  const replayHash = keccakHex(raw);
  const tx = await deps.chain.propose(roundId, amounts, replayHash);
  return { status: "proposed", roundId, tx, players, amounts, replayHash };
}

/** Release a proposed result once its review hold has passed. */
export async function finalizeIfDue(
  chain: EscrowChain,
  gameID: string,
  nowSeconds: bigint,
): Promise<string | null> {
  const roundId = roundIdOf(gameID);
  const s = await chain.status(roundId);
  if (s.phase !== RoundPhase.Proposed || s.frozen || nowSeconds < s.releaseAt) {
    return null;
  }
  return chain.finalize(roundId);
}
