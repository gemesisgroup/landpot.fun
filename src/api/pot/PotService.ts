import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import { getAddress, type Address, type Hex } from "viem";
import type { PotRoundRow, Store } from "../Store";
import { RoundPhase, type EscrowChain, type TokenInfo } from "./EscrowChain";
import { roundIdOf } from "./Oracle";
import {
  finalizeIfDue,
  settleGame,
  type Replayer,
  type SettleOutcome,
} from "./Settlement";

/**
 * Runs paid lobbies against the escrow (docs/LandpotPot.md). The game server
 * asks; this service holds the operator and oracle keys and talks to the
 * chain:
 *
 *   open    a round for a new paid lobby
 *   seat    may this player take a seat? (their wallet deposited)
 *   start   close deposits on chain, then hand back exactly who is in
 *   cancel  refund a lobby that did not fill
 *
 * and `tick` keeps every round moving without anyone asking: settles an
 * archived match, finalizes after the review hold, and cancels rounds whose
 * deadline passed so entries can be claimed back.
 */

export interface PotRules {
  /** Entry per player, in whole tokens. */
  stakeTokens: bigint;
  minPlayers: number;
  maxPlayers: number;
  /** How long a lobby takes deposits, at most a day (contract bound). */
  fundingSeconds: number;
}

export interface PotServiceDeps {
  chain: EscrowChain;
  store: Store;
  oracleKey: Hex;
  replay: Replayer;
  rules: PotRules;
  /**
   * An archived game: the bytes /game/:id serves (what the result's
   * replayHash commits to) and the full record behind them, whose
   * persistentIDs map players to wallets. Null while it is not archived.
   */
  archived: (
    gameId: string,
  ) => { publicBytes: Uint8Array; full: unknown } | null;
  now?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class PotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LobbyView {
  gameId: string;
  roundId: Hex;
  state: PotRoundRow["state"];
  phase: RoundPhase;
  stake: string;
  minPlayers: number;
  maxPlayers: number;
  fundingEnds: number;
  deposited: number;
  /** Depositors who have a Landpot account, as persistentIDs. */
  depositors: string[];
}

export interface Claimable {
  gameId: string;
  roundId: Hex;
  kind: "winnings" | "refund";
  amount: string;
  /** Final/Refunding: claim now. Proposed: claimable after releaseAt. */
  phase: RoundPhase;
  releaseAt: number;
  frozen: boolean;
}

// open() caps resultEnds at fundingEnds + 2 days; a little under that keeps
// a slow open transaction inside the bound.
const RESULT_WINDOW_SECONDS = 2 * 86_400 - 600;
// A failed settlement is retried, but not on every tick.
const SETTLE_RETRY_MS = 2 * 60_000;
const CLAIMS_LOOKBACK_MS = 30 * 86_400_000;

export class PotService {
  private readonly chain: EscrowChain;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly log: NonNullable<PotServiceDeps["log"]>;
  private running: Promise<void> | null = null;
  private rerun = false;
  // gameId → in-flight open, so a retried request can't open twice.
  private readonly opening = new Map<string, Promise<PotRoundRow>>();
  private readonly starting = new Map<string, Promise<string[]>>();

  constructor(private readonly deps: PotServiceDeps) {
    this.chain = deps.chain;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    const r = deps.rules;
    if (
      r.stakeTokens <= 0n ||
      r.minPlayers < 8 ||
      r.maxPlayers < r.minPlayers ||
      r.maxPlayers > 16 ||
      r.fundingSeconds < 60 ||
      r.fundingSeconds > 86_400 - 600
    ) {
      throw new Error("invalid pot rules (see docs/LandpotPot.md)");
    }
  }

  get rules(): PotRules {
    return this.deps.rules;
  }

  token(): Promise<TokenInfo> {
    return this.chain.token();
  }

  async stakeUnits(): Promise<bigint> {
    const { decimals } = await this.chain.token();
    return this.deps.rules.stakeTokens * 10n ** BigInt(decimals);
  }

  // ── lobby lifecycle, asked by the game server ──

  open(gameId: string): Promise<PotRoundRow> {
    const existing = this.store.getRound(gameId);
    if (existing) return Promise.resolve(existing);
    let p = this.opening.get(gameId);
    if (!p) {
      p = this.doOpen(gameId).finally(() => this.opening.delete(gameId));
      this.opening.set(gameId, p);
    }
    return p;
  }

  private async doOpen(gameId: string): Promise<PotRoundRow> {
    const { minPlayers, maxPlayers, fundingSeconds } = this.deps.rules;
    const roundId = roundIdOf(gameId);
    const stake = await this.stakeUnits();
    const chainNow = await this.chain.now();
    const fundingEnds = chainNow + BigInt(fundingSeconds);
    const resultEnds = fundingEnds + BigInt(RESULT_WINDOW_SECONDS);
    await this.chain.open(
      roundId,
      stake,
      minPlayers,
      maxPlayers,
      fundingEnds,
      resultEnds,
    );
    const row: PotRoundRow = {
      gameId,
      roundId,
      stake: stake.toString(),
      minPlayers,
      maxPlayers,
      fundingEnds: Number(fundingEnds),
      resultEnds: Number(resultEnds),
      state: "funding",
      createdAt: this.now(),
    };
    this.store.putRound(row);
    this.log("pot round opened", { gameId, roundId });
    return row;
  }

  private round(gameId: string): PotRoundRow {
    const row = this.store.getRound(gameId);
    if (!row) throw new PotError(404, "not a paid game");
    return row;
  }

  /** persistentIDs of the accounts behind these wallets. */
  private accountsOf(wallets: readonly Address[]): string[] {
    const out: string[] = [];
    for (const w of wallets) {
      const user = this.store.getUserByWallet(getAddress(w));
      if (user) out.push(user.id);
    }
    return out;
  }

  async lobby(gameId: string): Promise<LobbyView> {
    const row = this.round(gameId);
    const roundId = row.roundId as Hex;
    const [status, players] = await Promise.all([
      this.chain.status(roundId),
      this.chain.players(roundId),
    ]);
    return {
      gameId,
      roundId,
      state: row.state,
      phase: status.phase,
      stake: row.stake,
      minPlayers: row.minPlayers,
      maxPlayers: row.maxPlayers,
      fundingEnds: row.fundingEnds,
      deposited: status.playerCount,
      depositors: this.accountsOf(players),
    };
  }

  /** Whether this account's wallet is one of the round's depositors. */
  async seat(gameId: string, persistentID: string): Promise<boolean> {
    const row = this.round(gameId);
    const wallet = this.store.getUser(persistentID)?.wallet;
    if (!wallet) return false;
    const players = await this.chain.players(row.roundId as Hex);
    const w = wallet.toLowerCase();
    return players.some((p) => p.toLowerCase() === w);
  }

  /**
   * Close deposits on chain and return the persistentIDs that are in. The
   * game server must seat exactly these: a deposit that lands before start
   * is mined is in the round, so the list is read after the receipt.
   * Throws 409 when too few deposited (the lobby should be cancelled).
   */
  start(gameId: string): Promise<string[]> {
    let p = this.starting.get(gameId);
    if (!p) {
      p = this.doStart(gameId).finally(() => this.starting.delete(gameId));
      this.starting.set(gameId, p);
    }
    return p;
  }

  private async doStart(gameId: string): Promise<string[]> {
    const row = this.round(gameId);
    const roundId = row.roundId as Hex;
    const status = await this.chain.status(roundId);
    if (status.phase === RoundPhase.Funding) {
      if (status.playerCount < row.minPlayers) {
        throw new PotError(
          409,
          `${status.playerCount} of ${row.minPlayers} deposited`,
        );
      }
      if (BigInt(row.fundingEnds) <= (await this.chain.now())) {
        throw new PotError(409, "funding window is over");
      }
      await this.chain.start(roundId);
    } else if (status.phase !== RoundPhase.Started) {
      throw new PotError(409, `round is ${RoundPhase[status.phase]}`);
    }
    this.store.setRoundState(gameId, "started");
    this.log("pot round started", { gameId, players: status.playerCount });
    return this.accountsOf(await this.chain.players(roundId));
  }

  /** Refund a lobby that is still taking deposits. */
  /**
   * Refund a lobby. `seen` is the deposit count the game server decided on:
   * deposits may have landed since, and then it must look again. Without it,
   * a round with enough deposits to start is not refunded while open.
   */
  async cancel(gameId: string, seen?: number): Promise<void> {
    const row = this.round(gameId);
    const roundId = row.roundId as Hex;
    const status = await this.chain.status(roundId);
    if (status.phase === RoundPhase.Funding) {
      const changed =
        seen === undefined
          ? status.playerCount >= row.minPlayers
          : status.playerCount > seen;
      if (changed && (await this.chain.now()) < BigInt(row.fundingEnds)) {
        throw new PotError(409, `${status.playerCount} deposited since`);
      }
      await this.chain.cancel(roundId);
    } else if (status.phase !== RoundPhase.Refunding) {
      throw new PotError(409, `round is ${RoundPhase[status.phase]}`);
    }
    this.store.setRoundState(gameId, "cancelled");
    this.log("pot round cancelled", { gameId });
  }

  // ── public reads ──

  /** Lobbies taking deposits now, with whether `wallet` is in each. */
  async openLobbies(wallet?: Address): Promise<
    {
      gameId: string;
      roundId: string;
      stake: string;
      minPlayers: number;
      maxPlayers: number;
      fundingEnds: number;
      deposited: number;
      joined: boolean;
    }[]
  > {
    const nowS = Math.floor(this.now() / 1000);
    const rows = this.store
      .roundsIn(["funding"])
      .filter((r) => r.fundingEnds > nowS);
    const views = await Promise.all(
      rows.map(async (r) => {
        const roundId = r.roundId as Hex;
        const [status, players] = await Promise.all([
          this.chain.status(roundId),
          this.chain.players(roundId),
        ]);
        if (status.phase !== RoundPhase.Funding) return null;
        const w = wallet?.toLowerCase();
        return {
          gameId: r.gameId,
          roundId: r.roundId,
          stake: r.stake,
          minPlayers: r.minPlayers,
          maxPlayers: r.maxPlayers,
          fundingEnds: r.fundingEnds,
          deposited: players.length,
          joined: w !== undefined && players.some((p) => p.toLowerCase() === w),
        };
      }),
    );
    return views.filter((v) => v !== null);
  }

  /** What the escrow owes this wallet, from recent rounds. */
  async claims(wallet: Address): Promise<Claimable[]> {
    const rows = this.store.recentRounds(this.now() - CLAIMS_LOOKBACK_MS);
    const out: Claimable[] = [];
    await Promise.all(
      rows.map(async (r) => {
        const roundId = r.roundId as Hex;
        const status = await this.chain.status(roundId);
        if (
          status.phase !== RoundPhase.Proposed &&
          status.phase !== RoundPhase.Final &&
          status.phase !== RoundPhase.Refunding
        ) {
          return;
        }
        const owed = await this.chain.owed(roundId, wallet);
        const refund = status.phase === RoundPhase.Refunding;
        const amount = refund ? owed.deposit : owed.payout;
        if (amount === 0n) return;
        out.push({
          gameId: r.gameId,
          roundId,
          kind: refund ? "refund" : "winnings",
          amount: amount.toString(),
          phase: status.phase,
          releaseAt: Number(status.releaseAt),
          frozen: status.frozen,
        });
      }),
    );
    return out.sort((a, b) => a.gameId.localeCompare(b.gameId));
  }

  // ── settlement ──

  /** Replay, split and propose one archived paid match. */
  async settle(gameId: string): Promise<SettleOutcome> {
    const archived = this.deps.archived(gameId);
    if (!archived) throw new PotError(404, "no archived record");
    const parsed = GameRecordSchema.safeParse(archived.full);
    if (!parsed.success) throw new PotError(422, "stored record is invalid");
    const roundId = roundIdOf(gameId);
    let outcome: SettleOutcome;
    try {
      outcome = await settleGame(
        {
          chain: this.chain,
          oracleKey: this.deps.oracleKey,
          replay: this.deps.replay,
          walletOf: (pid) => this.store.getUser(pid)?.wallet ?? null,
        },
        archived.publicBytes,
        parsed.data,
      );
    } catch (e) {
      this.store.putSettlement({
        gameId,
        roundId,
        status: "failed",
        detail: bigintJson({ reason: String(e) }),
        updatedAt: this.now(),
      });
      throw new PotError(502, `settlement failed: ${String(e)}`);
    }
    const { status, ...rest } = outcome;
    // A skip leaves an earlier, more useful row in place.
    if (status !== "skipped") {
      this.store.putSettlement({
        gameId,
        roundId,
        status,
        detail: bigintJson(rest),
        updatedAt: this.now(),
      });
      this.log(`pot settlement ${status}`, { gameId });
    }
    return outcome;
  }

  async finalize(gameId: string): Promise<Hex | null> {
    const tx = await finalizeIfDue(this.chain, gameId, await this.chain.now());
    if (tx !== null) {
      const prev = this.store.getSettlement(gameId);
      this.store.putSettlement({
        gameId,
        roundId: roundIdOf(gameId),
        status: "finalized",
        detail: bigintJson({
          ...(prev ? (JSON.parse(prev.detail) as object) : {}),
          finalizeTx: tx,
        }),
        updatedAt: this.now(),
      });
      this.store.setRoundState(gameId, "closed");
      this.log("pot finalized", { gameId });
    }
    return tx;
  }

  /**
   * One pass over every round still in play. Each step is what anyone could
   * send on chain; doing it here means nobody has to.
   */
  tick(): Promise<void> {
    // One pass at a time; a tick asked for during a pass (say, a record
    // just archived) gets one more pass right after it.
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const chainNow = await this.chain.now();
    for (const row of this.store.roundsIn(["funding", "started"])) {
      try {
        await this.advance(row, chainNow);
      } catch (e) {
        this.log("pot keeper step failed", {
          gameId: row.gameId,
          error: String(e),
        });
      }
    }
  }

  private async advance(row: PotRoundRow, chainNow: bigint): Promise<void> {
    const roundId = row.roundId as Hex;
    const status = await this.chain.status(roundId);
    switch (status.phase) {
      case RoundPhase.Funding:
        // Nobody started it in time: anyone may cancel now.
        if (chainNow >= BigInt(row.fundingEnds)) {
          await this.chain.cancel(roundId);
          this.store.setRoundState(row.gameId, "cancelled");
          this.log("pot round expired unstarted, refunding", {
            gameId: row.gameId,
          });
        }
        return;
      case RoundPhase.Started: {
        if (row.state !== "started") {
          this.store.setRoundState(row.gameId, "started");
        }
        if (chainNow >= BigInt(row.resultEnds)) {
          await this.chain.cancel(roundId);
          this.store.setRoundState(row.gameId, "cancelled");
          this.log("pot round got no result in time, refunding", {
            gameId: row.gameId,
          });
          return;
        }
        const prev = this.store.getSettlement(row.gameId);
        if (prev?.status === "void") return; // waits for resultEnds
        if (
          prev?.status === "failed" &&
          this.now() - prev.updatedAt < SETTLE_RETRY_MS
        ) {
          return;
        }
        if (this.deps.archived(row.gameId) === null) return; // still playing
        await this.settle(row.gameId).catch((e: unknown) => {
          this.log("pot settlement failed", {
            gameId: row.gameId,
            error: String(e),
          });
        });
        return;
      }
      case RoundPhase.Proposed:
        if (row.state !== "started") {
          this.store.setRoundState(row.gameId, "started");
        }
        if (!status.frozen && chainNow >= status.releaseAt) {
          await this.finalize(row.gameId);
        }
        return;
      case RoundPhase.Final:
        this.store.setRoundState(row.gameId, "closed");
        return;
      case RoundPhase.Refunding:
        this.store.setRoundState(row.gameId, "cancelled");
        return;
      case RoundPhase.None:
        // Never opened on this chain (a lost open, or a chain reset).
        if (chainNow >= BigInt(row.fundingEnds)) {
          this.store.setRoundState(row.gameId, "cancelled");
        }
        return;
    }
  }
}

export function bigintJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? x.toString() : x,
  );
}
