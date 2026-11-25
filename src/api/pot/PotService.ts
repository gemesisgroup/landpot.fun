import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import { randomBytes } from "node:crypto";
import type { AcceptResult, PotRoundRow, Store } from "../Store";
import {
  InsufficientBalanceError,
  RoundPhase,
  type EscrowChain,
  type TokenInfo,
} from "./EscrowChain";
import { roundIdOf, type Hex } from "./RoundId";
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
 * archived match, finalizes after the review hold, cancels rounds whose
 * deadline passed so entries can be claimed back, and closes fully claimed
 * rounds so their rent returns to the operator.
 */

export interface PotRules {
  /** Entry per player, in whole tokens. */
  cupHourUTC?: number;
  stakeTokens: bigint;
  /** Allowed entry tiers in whole tokens (sorted ascending); defaults to [stakeTokens]. */
  stakeTiersTokens?: readonly bigint[];
  minPlayers: number;
  maxPlayers: number;
  /** How long a lobby takes deposits, at most a day (contract bound). */
  fundingSeconds: number;
}

export interface PotServiceDeps {
  chain: EscrowChain;
  store: Store;
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
  pairs?: string[][];
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
  /** refund_pending: a void result; the refund opens at releaseAt. */
  kind: "winnings" | "refund" | "refund_pending";
  amount: string;
  /**
   * Final/Refunding: claim now. Proposed: claimable after releaseAt.
   * Started (refund_pending): refundable after releaseAt, or sooner if the
   * guardian cancels the round.
   */
  phase: RoundPhase;
  releaseAt: number;
  frozen: boolean;
  /** Why a Cup round pays nothing out: tie, unverified, or cancelled. */
  reason?: CupVoidReason;
}

export type CupVoidReason = "tie" | "unverified" | "cancelled";

/** What a Cup invite link shows before anyone confirms anything. */
export interface InviteView {
  gameId: string;
  inviter: string;
  stake: string;
  burnBps: number;
  treasuryBps: number;
  fundingEnds: number;
  pairs: number;
  state:
    | "open"
    | "accepted"
    | "self"
    | "taken"
    | "you_paired"
    | "full"
    | "expired"
    | "revoked";
}

export interface CupStats {
  gameId: string;
  invitesCreated: number;
  invitesAccepted: number;
  pairs: number;
  /** Pairs where both wallets paid. */
  pairsPaid: number;
  openedAt: number;
  filledAt: number | null;
  fillSeconds: number | null;
  rematch: { yes: number; no: number };
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
  private readonly openingCupHours = new Set<number>();
  private readonly starting = new Map<string, Promise<string[]>>();
  /** The host asked for the next lobby to be a Cup, outside the schedule. */
  private cupArmed = false;

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

  /** The escrow's burn and treasury cuts (bps) and review hold (s). */
  fees(): Promise<{
    burnBps: number;
    treasuryBps: number;
    reviewDelay: number;
  }> {
    return this.chain.fees();
  }

  async stakeUnits(stakeTokens = this.deps.rules.stakeTokens): Promise<bigint> {
    const { decimals } = await this.chain.token();
    return stakeTokens * 10n ** BigInt(decimals);
  }

  allowedStakeTiersTokens(): readonly bigint[] {
    const tiers = this.deps.rules.stakeTiersTokens;
    return tiers && tiers.length > 0 ? tiers : [this.deps.rules.stakeTokens];
  }

  async stakeTiersUnits(): Promise<bigint[]> {
    const { decimals } = await this.chain.token();
    const factor = 10n ** BigInt(decimals);
    return this.allowedStakeTiersTokens().map((t) => t * factor);
  }

  // ── lobby lifecycle, asked by the game server ──

  /**
   * Make the next paid lobby opened a Cup, whatever the schedule says: for
   * a closed playtest at an agreed time, and for tests.
   */
  armCup(): void {
    this.cupArmed = true;
  }

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

  /** Open a 2-player paid Caldera duel round (minPlayers = maxPlayers = 2). */
  openDuel(
    gameId: string,
    playerIds?: string[],
    stakeTokens?: bigint,
  ): Promise<PotRoundRow> {
    const existing = this.store.getRound(gameId);
    if (existing) return Promise.resolve(existing);
    const chosenStake = stakeTokens ?? this.deps.rules.stakeTokens;
    if (!this.allowedStakeTiersTokens().includes(chosenStake)) {
      throw new PotError(400, "invalid stake tier");
    }
    let duelWallets: string[] | undefined;
    if (playerIds && playerIds.length > 0) {
      if (playerIds.length !== 2 || new Set(playerIds).size !== 2) {
        throw new PotError(400, "duel requires two distinct players");
      }
      const wallets = playerIds.map((pid) => this.store.getUser(pid)?.wallet);
      if (wallets.some((w) => !w) || new Set(wallets).size !== 2) {
        throw new PotError(409, "both duel players must have linked wallets");
      }
      duelWallets = wallets as string[];
    }
    let p = this.opening.get(gameId);
    if (!p) {
      p = this.openRound(
        gameId,
        "duel",
        this.now(),
        duelWallets,
        chosenStake,
      ).finally(() => this.opening.delete(gameId));
      this.opening.set(gameId, p);
    }
    return p;
  }

  private async doOpen(gameId: string): Promise<PotRoundRow> {
    const rules = this.deps.rules;
    const date = new Date(this.now());
    const hourStart = Math.floor(date.getTime() / 3_600_000) * 3_600_000;
    const armed = this.cupArmed;
    this.cupArmed = false;
    const cup =
      armed ||
      (rules.cupHourUTC === date.getUTCDay() * 24 + date.getUTCHours() &&
        !this.openingCupHours.has(hourStart) &&
        !this.store.recentRounds(hourStart).some((round) => round.cup));
    if (cup) this.openingCupHours.add(hourStart);
    try {
      return await this.openRound(gameId, cup ? "cup" : "ffa", date.getTime());
    } finally {
      if (cup) this.openingCupHours.delete(hourStart);
    }
  }

  private async openRound(
    gameId: string,
    mode: "ffa" | "cup" | "duel",
    createdAt: number,
    duelWallets?: string[],
    stakeTokens?: bigint,
  ): Promise<PotRoundRow> {
    const rules = this.deps.rules;
    const cup = mode === "cup";
    const duel = mode === "duel";
    const minPlayers = duel ? 2 : cup ? 8 : rules.minPlayers;
    const maxPlayers = duel ? 2 : cup ? 8 : rules.maxPlayers;
    const fundingSeconds = rules.fundingSeconds;
    const roundId = roundIdOf(gameId);
    const stake = await this.stakeUnits(stakeTokens);
    // The round keeps the terms it opened with, so its card stays right
    // after the settings for the next one change.
    const { burnBps, treasuryBps } = await this.chain.fees();
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
      ...(cup ? { cup: true } : {}),
      ...(duel ? { duel: true } : {}),
      ...(duelWallets ? { duelWallets } : {}),
      gameId,
      roundId,
      stake: stake.toString(),
      minPlayers,
      maxPlayers,
      fundingEnds: Number(fundingEnds),
      resultEnds: Number(resultEnds),
      state: "funding",
      createdAt,
      burnBps,
      treasuryBps,
    };
    this.store.putRound(row);
    this.log("pot round opened", { gameId, roundId, mode });
    return row;
  }

  private round(gameId: string): PotRoundRow {
    const row = this.store.getRound(gameId);
    if (!row) throw new PotError(404, "not a paid game");
    return row;
  }

  /** persistentIDs of the accounts behind these wallets. */
  private accountsOf(wallets: readonly string[]): string[] {
    const out: string[] = [];
    for (const w of wallets) {
      const user = this.store.getUserByWallet(w);
      if (user) out.push(user.id);
    }
    return out;
  }

  nominate(gameId: string, wallet: string, partner: string): void {
    const row = this.round(gameId);
    if (
      !row.cup ||
      row.state !== "funding" ||
      row.fundingEnds <= this.now() / 1000
    )
      throw new PotError(409, "Registration closed");
    if (wallet === partner) throw new PotError(400, "Choose another wallet");
    const pairs = this.store.cupPairs(gameId);
    if (pairs.some((pair) => pair.includes(wallet) && pair.includes(partner)))
      return;
    if (
      pairs.length >= 4 ||
      pairs.some((pair) => pair.includes(wallet) || pair.includes(partner))
    )
      throw new PotError(409, "Team slot unavailable");
    this.store.pickPartner(gameId, wallet, partner);
  }

  // ── Cup invite links ──

  private cupFunding(gameId: string): PotRoundRow {
    const row = this.round(gameId);
    if (
      !row.cup ||
      row.state !== "funding" ||
      row.fundingEnds <= this.now() / 1000
    )
      throw new PotError(409, "Registration closed");
    return row;
  }

  /** The wallet's open invite link for a Cup round, made if needed. */
  invite(gameId: string, wallet: string): { token: string } {
    this.cupFunding(gameId);
    if (this.store.cupPairs(gameId).some((p) => p.includes(wallet)))
      throw new PotError(409, "Already in a pair");
    const live = this.store.liveInvite(gameId, wallet);
    if (live) return { token: live.token };
    const token = randomBytes(12).toString("base64url");
    this.store.putInvite({
      token,
      gameId,
      inviter: wallet,
      createdAt: this.now(),
      acceptedBy: null,
      acceptedAt: null,
    });
    return { token };
  }

  /** What an invite link is for and whether `wallet` can accept it now. */
  inviteView(token: string, wallet?: string): InviteView {
    const invite = this.store.getInvite(token);
    if (!invite) throw new PotError(404, "Invite not found");
    const row = this.store.getRound(invite.gameId);
    if (!row?.cup) throw new PotError(404, "Invite not found");
    const pairs = this.store.cupPairs(invite.gameId);
    const theirs = pairs.find((p) => p.includes(invite.inviter));
    const mine = wallet ? pairs.find((p) => p.includes(wallet)) : undefined;
    const open = row.state === "funding" && row.fundingEnds > this.now() / 1000;
    let state: InviteView["state"];
    if (wallet !== undefined && theirs?.includes(wallet)) state = "accepted";
    else if (!open) state = "expired";
    else if (wallet === invite.inviter) state = "self";
    else if (theirs || invite.acceptedBy !== null) state = "taken";
    else if (mine) state = "you_paired";
    else if (pairs.length >= 4) state = "full";
    else state = "open";
    return {
      gameId: invite.gameId,
      inviter: invite.inviter,
      stake: row.stake,
      burnBps: row.burnBps ?? 0,
      treasuryBps: row.treasuryBps ?? 0,
      fundingEnds: row.fundingEnds,
      pairs: pairs.length,
      state,
    };
  }

  /** Confirm an invite: the inviter and `wallet` become a locked pair. */
  acceptInvite(token: string, wallet: string): AcceptResult {
    const invite = this.store.getInvite(token);
    if (!invite) throw new PotError(404, "Invite not found");
    this.cupFunding(invite.gameId);
    const result = this.store.acceptInvite(token, wallet, this.now());
    if (result !== "ok") throw new PotError(409, result);
    return result;
  }

  /** Invites, pairs, fill time and rematch answers, for the host. */
  async cupStats(gameId: string): Promise<CupStats> {
    const row = this.round(gameId);
    const invites = this.store.invites(gameId);
    const pairs = this.store.cupPairs(gameId);
    const paid = new Set(await this.depositors(row));
    const rematch = this.store.rematches(gameId);
    return {
      gameId,
      invitesCreated: invites.length,
      invitesAccepted: invites.filter((i) => i.acceptedBy !== null).length,
      pairs: pairs.length,
      pairsPaid: pairs.filter((p) => p.every((w) => paid.has(w))).length,
      openedAt: row.createdAt,
      filledAt: row.filledAt ?? null,
      fillSeconds:
        row.filledAt === undefined
          ? null
          : Math.round((row.filledAt - row.createdAt) / 1000),
      rematch: {
        yes: rematch.filter((r) => r.again).length,
        no: rematch.filter((r) => !r.again).length,
      },
    };
  }

  /**
   * Who paid into a round. A closed round's account is gone from the chain,
   * so after that the settlement's own record of the players answers.
   */
  private async depositors(row: PotRoundRow): Promise<string[]> {
    const live = await this.chain.players(row.roundId as Hex);
    if (live.length > 0) return live;
    const settled = this.store.getSettlement(row.gameId);
    const players = settled
      ? (JSON.parse(settled.detail) as { players?: unknown }).players
      : undefined;
    return Array.isArray(players) ? players.map(String) : [];
  }

  /** "Play again with the same partner?" from a wallet that played. */
  async rematch(gameId: string, wallet: string, again: boolean) {
    const row = this.round(gameId);
    if (!row.cup) throw new PotError(404, "not a cup game");
    const players = await this.depositors(row);
    if (!players.includes(wallet)) throw new PotError(403, "not a player");
    this.store.putRematch(gameId, wallet, again);
  }

  cupAccounts(gameId: string): string[][] | undefined {
    if (!this.round(gameId).cup) return undefined;
    return this.store.cupPairs(gameId).map((pair) => this.accountsOf(pair));
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
      ...(row.cup ? { pairs: this.cupAccounts(gameId) } : {}),
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
    if (
      !wallet ||
      (row.cup && !this.store.cupPairs(gameId).flat().includes(wallet)) ||
      (row.duel &&
        row.duelWallets &&
        row.duelWallets.length > 0 &&
        !row.duelWallets.includes(wallet))
    )
      return false;
    const players = await this.chain.players(row.roundId as Hex);
    return players.includes(wallet);
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
      if (row.cup) {
        const roster = new Set(this.store.cupPairs(gameId).flat());
        const paid = await this.chain.players(roundId);
        if (
          roster.size !== 8 ||
          paid.length !== 8 ||
          !paid.every((w) => roster.has(w))
        ) {
          throw new PotError(409, "Incomplete cup roster");
        }
      }
      await this.chain.start(roundId);
    } else if (status.phase !== RoundPhase.Started) {
      throw new PotError(409, `round is ${RoundPhase[status.phase]}`);
    }
    this.store.setRoundState(gameId, "started");
    this.log("pot round started", { gameId, players: status.playerCount });
    return this.accountsOf(await this.chain.players(roundId));
  }

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
  async openLobbies(wallet?: string): Promise<
    {
      gameId: string;
      roundId: string;
      stake: string;
      minPlayers: number;
      maxPlayers: number;
      fundingEnds: number;
      deposited: number;
      cup?: boolean;
      partner?: string;
      /** Whether the signed-in wallet's partner has paid. */
      partnerPaid?: boolean;
      /** Locked pairs so far (Cup). */
      pairs?: number;
      burnBps?: number;
      treasuryBps?: number;
      joined: boolean;
    }[]
  > {
    const nowS = Math.floor(this.now() / 1000);
    const rows = this.store
      .roundsIn(["funding"])
      .filter((r) => !r.duel && r.fundingEnds > nowS);
    const views = await Promise.all(
      rows.map(async (r) => {
        const roundId = r.roundId as Hex;
        const [status, players] = await Promise.all([
          this.chain.status(roundId),
          this.chain.players(roundId),
        ]);
        if (status.phase !== RoundPhase.Funding) return null;
        if (players.length >= r.maxPlayers)
          this.store.setRoundFilled(r.gameId, this.now());
        const pairs = r.cup ? this.store.cupPairs(r.gameId) : [];
        const partner = pairs
          .find((pair) => wallet && pair.includes(wallet))
          ?.find((w) => w !== wallet);
        return {
          ...(r.cup
            ? {
                cup: true,
                partner,
                partnerPaid: partner ? players.includes(partner) : false,
                pairs: pairs.length,
              }
            : {}),
          ...(r.burnBps === undefined
            ? {}
            : { burnBps: r.burnBps, treasuryBps: r.treasuryBps }),
          gameId: r.gameId,
          roundId: r.roundId,
          stake: r.stake,
          minPlayers: r.minPlayers,
          maxPlayers: r.maxPlayers,
          fundingEnds: r.fundingEnds,
          deposited: players.length,
          joined: wallet !== undefined && players.includes(wallet),
        };
      }),
    );
    return views.filter((v) => v !== null);
  }

  /** What the escrow owes this wallet, from recent rounds. */
  async claims(wallet: string): Promise<Claimable[]> {
    const rows = this.store.recentRounds(this.now() - CLAIMS_LOOKBACK_MS);
    const out: Claimable[] = [];
    await Promise.all(
      rows.map(async (r) => {
        const roundId = r.roundId as Hex;
        const status = await this.chain.status(roundId);
        const settlement = this.store.getSettlement(r.gameId);
        const voidReason = (): CupVoidReason => {
          const code = settlement
            ? (JSON.parse(settlement.detail) as { code?: string }).code
            : undefined;
          return code === "tie" ? "tie" : "unverified";
        };
        // A void result: entries come back once the result window ends.
        if (
          status.phase === RoundPhase.Started &&
          settlement?.status === "void"
        ) {
          const owed = await this.chain.owed(roundId, wallet);
          if (owed.deposit === 0n) return;
          out.push({
            gameId: r.gameId,
            roundId,
            kind: "refund_pending",
            amount: owed.deposit.toString(),
            phase: status.phase,
            releaseAt: r.resultEnds,
            frozen: false,
            ...(r.cup || r.duel ? { reason: voidReason() } : {}),
          });
          return;
        }
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
          ...((r.cup || r.duel) && refund
            ? {
                reason:
                  settlement?.status === "void" ? voidReason() : "cancelled",
              }
            : {}),
        });
      }),
    );
    return out.sort((a, b) => a.gameId.localeCompare(b.gameId));
  }

  // ── transactions the player's wallet signs ──

  /** A deposit into a lobby that is still taking them. */
  async depositTx(gameId: string, wallet: string): Promise<string> {
    const row = this.round(gameId);
    if (row.cup && !this.store.cupPairs(gameId).flat().includes(wallet))
      throw new PotError(409, "Confirm your partner before depositing");
    if (
      row.duel &&
      row.duelWallets &&
      row.duelWallets.length > 0 &&
      !row.duelWallets.includes(wallet)
    )
      throw new PotError(403, "Not a participant in this duel");
    if (row.state !== "funding") throw new PotError(409, "lobby is closed");
    const roundId = row.roundId as Hex;
    const [status, players] = await Promise.all([
      this.chain.status(roundId),
      this.chain.players(roundId),
    ]);
    if (status.phase !== RoundPhase.Funding) {
      throw new PotError(409, `round is ${RoundPhase[status.phase]}`);
    }
    if (players.includes(wallet)) throw new PotError(409, "already in");
    if (status.playerCount >= row.maxPlayers) {
      throw new PotError(409, "lobby is full");
    }
    try {
      return await this.chain.depositTx(roundId, wallet);
    } catch (e) {
      if (e instanceof InsufficientBalanceError) {
        throw new PotError(402, e.message);
      }
      throw e;
    }
  }

  /** Claim winnings or a refund the escrow holds for this wallet. */
  async claimTx(gameId: string, wallet: string): Promise<string> {
    const roundId = this.round(gameId).roundId as Hex;
    const [status, owed] = await Promise.all([
      this.chain.status(roundId),
      this.chain.owed(roundId, wallet),
    ]);
    const amount =
      status.phase === RoundPhase.Refunding
        ? owed.deposit
        : status.phase === RoundPhase.Final
          ? owed.payout
          : 0n;
    if (amount === 0n) throw new PotError(409, "nothing to claim");
    return this.chain.claimTx(roundId, wallet);
  }

  txStatus(signature: string): Promise<"confirmed" | "failed" | "pending"> {
    return this.chain.txStatus(signature);
  }

  // ── settlement ──

  /** Replay, split and propose one archived paid match. */
  async settle(gameId: string): Promise<SettleOutcome> {
    const archived = this.deps.archived(gameId);
    if (!archived) throw new PotError(404, "no archived record");
    const parsed = GameRecordSchema.safeParse(archived.full);
    if (!parsed.success) throw new PotError(422, "stored record is invalid");
    if (parsed.data.info.gameID !== gameId)
      throw new PotError(422, "Archived game ID mismatch");
    const roundId = roundIdOf(gameId);
    const round = this.round(gameId);
    let outcome: SettleOutcome;
    try {
      outcome = await settleGame(
        {
          chain: this.chain,
          replay: this.deps.replay,
          cupPairs: round.cup ? this.store.cupPairs(gameId) : undefined,
          duel: Boolean(round.duel),
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

  async finalize(gameId: string): Promise<string | null> {
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
    await this.reclaimRent();
  }

  /**
   * Close settled rounds nobody is owed anything from: the round and vault
   * accounts' rent goes back to the operator. Unclaimed winnings keep a
   * round open; this looks again on later passes.
   */
  private async reclaimRent(): Promise<void> {
    const since = this.now() - CLAIMS_LOOKBACK_MS;
    for (const row of this.store.recentRounds(since)) {
      if (row.state !== "closed" && row.state !== "cancelled") continue;
      const roundId = row.roundId as Hex;
      try {
        const s = await this.chain.status(roundId);
        const settled =
          s.phase === RoundPhase.Final || s.phase === RoundPhase.Refunding;
        if (settled && s.balance === 0n) {
          await this.chain.close(roundId);
          this.log("pot round closed, rent reclaimed", { gameId: row.gameId });
        }
      } catch (e) {
        this.log("pot rent reclaim failed", {
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
