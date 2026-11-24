import {
  Difficulty,
  GameMapSize,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import {
  DUEL_CALDERA,
  DUEL_MINUTES,
  PAID_MATCH_DISABLED_UNITS,
  PAID_MATCH_MAP,
} from "@openfront/shared/PaidMatch";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { PaidGame, PaidGames, PotApi } from "./PaidLobby";

/**
 * Caldera duels (docs/CalderaDuel.md): 1v1, six minutes, free for now.
 *
 * Two ways in: a challenge link sent to a friend, or the open queue. Either
 * way both players first see each other and the terms, and each confirms on
 * their own (the step a stake will take later). Only then is a game made:
 * it waits for exactly these two and starts the moment both are in, or is
 * dropped if they aren't within START_WINDOW_MS. After the result each can
 * ask for a rematch; a new duel starts only when both say yes.
 *
 * Everything lives in memory on one worker. It also keeps the playtest's
 * numbers: time to start, found pairs that reach a match, rematch asks.
 */

export const INVITE_TTL_MS = 30 * 60_000;
/** A queued player who stops polling for this long leaves the queue. */
export const QUEUE_STALE_MS = 15_000;
/** Matched players have this long to both confirm. */
export const CONFIRM_WINDOW_MS = 2 * 60_000;
/** Confirmed players have this long to both be in the game. */
export const START_WINDOW_MS = 90_000;
/** After the result, rematch answers count for this long. */
export const REMATCH_WINDOW_MS = 3 * 60_000;

export type DuelPhase =
  | "invite" // a link is out, nobody took it yet
  | "confirm" // two players, waiting for both to confirm
  | "funding" // paid duel: escrow round open, waiting for both deposits
  | "starting" // game made, waiting for both to be in
  | "playing"
  | "ended"
  | "cancelled";

export interface DuelSide {
  pid: string;
  name: string;
  ready: boolean;
  /** Whether this side's escrow deposit is confirmed on chain (paid duels). */
  paid?: boolean;
  /** Rematch answer after the result: undefined until given. */
  rematch?: boolean;
  rematchAt?: number;
  /** From the side's own end-of-match report. */
  won?: boolean;
}

export interface Duel {
  id: string;
  kind: "friend" | "queue";
  sides: DuelSide[];
  phase: DuelPhase;
  /** True when backed by a 2-player Solana escrow round. */
  paid?: boolean;
  /** Chain timestamp (seconds) when deposits close (paid duels). */
  fundingEnds?: number;
  /** Last time the server polled the escrow lobby (ms). */
  lastPollAt?: number;
  createdAt: number;
  /** Second player found (link taken or queue matched). */
  matchedAt?: number;
  /** For a queue match: when the earlier of the two joined the queue. */
  queuedAt?: number;
  gameId?: string;
  /** Game made (both confirmed). */
  startedAt?: number;
  /** The match itself started (both in). */
  playingAt?: number;
  endedAt?: number;
  /** Why it was cancelled, for the player and the stats. */
  reason?: string;
  rematchOf?: string;
  rematchId?: string;
  report?: DuelReport;
}

export const DuelReportSchema = z.object({
  /** "tie" or the winning side's index. */
  winner: z.union([z.literal("tie"), z.literal(0), z.literal(1)]),
  sides: z
    .array(
      z.object({
        crater: z.number().int().min(0).max(10_000_000),
        rim: z.number().int().min(0).max(10_000_000),
        /** Seconds into the match it first held crater land; null: never. */
        firstCraterSecond: z.number().int().min(0).max(3600).nullable(),
      }),
    )
    .length(2),
  seconds: z.number().int().min(0).max(3600),
});
export type DuelReport = z.infer<typeof DuelReportSchema>;

/** The match itself: a Caldera duel on the paid-match map and units. */
export function duelGameConfig(base: GameConfig): GameConfig {
  return {
    ...base,
    gameType: GameType.Private,
    newEra: undefined,
    rankedType: undefined,
    tutorial: undefined,
    gameMode: GameMode.Team,
    playerTeams: 2,
    gameMap: PAID_MATCH_MAP,
    gameMapSize: GameMapSize.Compact,
    maxTimerValue: DUEL_MINUTES,
    winThresholdTenths: undefined,
    overtime: undefined,
    doomsdayClock: undefined,
    caldera: DUEL_CALDERA,
    disabledUnits: PAID_MATCH_DISABLED_UNITS,
    publicGameModifiers: undefined,
    difficulty: Difficulty.Medium,
    maxPlayers: 2,
    bots: 0,
    nations: "disabled",
    disableAlliances: true,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    trusted: undefined,
    allowedPublicIds: undefined,
    hostCheats: undefined,
  };
}

export class DuelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

interface QueueEntry {
  pid: string;
  name: string;
  since: number;
  seen: number;
}

export class DuelHost {
  private readonly duels = new Map<string, Duel>();
  private readonly byGame = new Map<string, Duel>();
  private readonly opening = new Map<string, Promise<void>>();
  private ticking = false;
  private queue: QueueEntry | null = null;
  /** Players who left the queue unmatched, for the stats. */
  private queueAbandoned = 0;

  constructor(
    private readonly deps: {
      games: PaidGames;
      /** When set, confirmed duels open a 2-player escrow round before starting. */
      pot?: PotApi;
      /** Optional JSON file path to persist completed duels across restarts. */
      statsFile?: string;
      newGameId: () => string | null;
      baseConfig: () => Promise<GameConfig>;
      log: (msg: string, fields?: Record<string, unknown>) => void;
      now?: () => number;
      newId?: () => string;
    },
  ) {
    this.loadHistory();
  }

  private loadHistory(): void {
    const file = this.deps.statsFile;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        queueAbandoned?: number;
        duels?: Duel[];
      };
      if (typeof raw.queueAbandoned === "number") {
        this.queueAbandoned = raw.queueAbandoned;
      }
      if (Array.isArray(raw.duels)) {
        for (const d of raw.duels) {
          if (d.phase === "ended" || d.phase === "cancelled") {
            this.duels.set(d.id, d);
          }
        }
      }
    } catch (e) {
      this.deps.log("duel stats load failed", { error: String(e) });
    }
  }

  private saveHistory(): void {
    const file = this.deps.statsFile;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const finished = [...this.duels.values()].filter(
        (d) => d.phase === "ended" || d.phase === "cancelled",
      );
      writeFileSync(
        file,
        JSON.stringify(
          { queueAbandoned: this.queueAbandoned, duels: finished },
          null,
          2,
        ),
        "utf8",
      );
    } catch (e) {
      this.deps.log("duel stats save failed", { error: String(e) });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomBytes(6).toString("base64url");
  }

  // ── finding an opponent ──

  /** A challenge link for a friend. One open link per player. */
  invite(pid: string, name: string): Duel {
    this.leaveQueue(pid);
    const open = this.active(pid);
    if (open?.phase === "invite") return open;
    if (open) throw new DuelError(409, "already_in_duel");
    const duel: Duel = {
      id: this.newId(),
      kind: "friend",
      sides: [{ pid, name, ready: false }],
      phase: "invite",
      createdAt: this.now(),
    };
    this.duels.set(duel.id, duel);
    return duel;
  }

  /**
   * What the link shows the friend: "open" (can accept), "self" (their own
   * link), "taken" (someone else accepted), "expired", or "joined" (they
   * already accepted it).
   */
  readInvite(
    id: string,
    pid: string | null,
  ): { state: string; inviter?: string } {
    const duel = this.duels.get(id);
    if (!duel || duel.kind !== "friend") return { state: "expired" };
    const inviter = duel.sides[0].name;
    if (pid !== null && duel.sides[0].pid === pid) {
      return { state: "self", inviter };
    }
    if (duel.phase === "invite") {
      return this.now() - duel.createdAt > INVITE_TTL_MS
        ? { state: "expired", inviter }
        : { state: "open", inviter };
    }
    if (pid !== null && duel.sides[1]?.pid === pid) {
      return { state: "joined", inviter };
    }
    return { state: duel.phase === "cancelled" ? "expired" : "taken", inviter };
  }

  acceptInvite(id: string, pid: string, name: string): Duel {
    const state = this.readInvite(id, pid).state;
    const duel = this.duels.get(id);
    if (state === "joined" && duel) return duel;
    if (state !== "open" || !duel) throw new DuelError(409, state);
    const mine = this.active(pid);
    if (mine && mine.id !== id) {
      if (mine.phase === "invite") this.cancel(mine, "replaced");
      else throw new DuelError(409, "already_in_duel");
    }
    this.leaveQueue(pid);
    duel.sides.push({ pid, name, ready: false });
    duel.phase = "confirm";
    duel.matchedAt = this.now();
    return duel;
  }

  /**
   * Join or stay in the open queue. Returns the duel once matched, else
   * null (keep polling). One fixed format, one queue: no split by stake.
   */
  joinQueue(pid: string, name: string): Duel | null {
    const now = this.now();
    const mine = this.active(pid);
    if (mine && mine.phase !== "invite") return mine;
    if (this.queue && now - this.queue.seen > QUEUE_STALE_MS) {
      this.queueAbandoned++;
      this.queue = null;
    }
    if (this.queue?.pid === pid) {
      this.queue.seen = now;
      this.queue.name = name;
      return null;
    }
    if (this.queue === null) {
      this.queue = { pid, name, since: now, seen: now };
      return null;
    }
    const other = this.queue;
    this.queue = null;
    if (mine?.phase === "invite") this.cancel(mine, "replaced");
    const duel: Duel = {
      id: this.newId(),
      kind: "queue",
      sides: [
        { pid: other.pid, name: other.name, ready: false },
        { pid, name, ready: false },
      ],
      phase: "confirm",
      createdAt: now,
      matchedAt: now,
      queuedAt: other.since,
    };
    this.duels.set(duel.id, duel);
    return duel;
  }

  leaveQueue(pid: string): void {
    if (this.queue?.pid === pid) {
      this.queue = null;
      this.queueAbandoned++;
    }
  }

  inQueue(pid: string): boolean {
    return this.queue?.pid === pid;
  }

  // ── confirming and starting ──

  /** This player's current duel, newest first; ended ones until answered. */
  active(pid: string): Duel | undefined {
    let best: Duel | undefined;
    for (const d of this.duels.values()) {
      if (!d.sides.some((s) => s.pid === pid)) continue;
      if (d.phase === "cancelled") continue;
      if (d.phase === "ended" && d.rematchId === undefined) {
        if (this.now() - (d.endedAt ?? 0) > REMATCH_WINDOW_MS) continue;
      } else if (d.phase === "ended") continue;
      if (!best || d.createdAt >= best.createdAt) best = d;
    }
    return best;
  }

  get(id: string): Duel | undefined {
    return this.duels.get(id);
  }

  async confirm(id: string, pid: string): Promise<Duel> {
    const duel = this.mustSide(id, pid);
    if (duel.phase !== "confirm") {
      if (
        duel.phase === "funding" ||
        duel.phase === "starting" ||
        duel.phase === "playing"
      ) {
        return duel;
      }
      throw new DuelError(409, duel.phase);
    }
    duel.sides.find((s) => s.pid === pid)!.ready = true;
    if (duel.sides.every((s) => s.ready)) {
      let p = this.opening.get(duel.id);
      if (!p) {
        p = (
          this.deps.pot ? this.openEscrow(duel) : this.makeGame(duel)
        ).finally(() => this.opening.delete(duel.id));
        this.opening.set(duel.id, p);
      }
      await p;
    }
    return duel;
  }

  async decline(id: string, pid: string): Promise<Duel> {
    const duel = this.mustSide(id, pid);
    if (duel.phase === "invite" || duel.phase === "confirm") {
      this.cancel(duel, "declined");
      return duel;
    }
    if (duel.phase === "funding" && duel.gameId && this.deps.pot) {
      try {
        const lobby = await this.deps.pot.lobby(duel.gameId);
        if (lobby.deposited >= 2) {
          // Both already paid on chain; let tick() start the match.
          return duel;
        }
        await this.deps.pot.cancel(duel.gameId, lobby.deposited);
      } catch (e) {
        this.deps.log("duel escrow cancel failed", {
          duel: duel.id,
          gameID: duel.gameId,
          error: String(e),
        });
      }
      this.cancel(duel, "declined");
    }
    return duel;
  }

  private async openEscrow(duel: Duel): Promise<void> {
    const pot = this.deps.pot!;
    const gameId = this.deps.newGameId();
    if (gameId === null) throw new DuelError(503, "no_game_id");
    const pids = duel.sides.map((s) => s.pid);
    const openFn = pot.openDuel ? pot.openDuel(gameId, pids) : pot.open(gameId);
    const opened = await openFn;
    duel.gameId = gameId;
    duel.paid = true;
    duel.fundingEnds = opened.fundingEnds;
    duel.phase = "funding";
    this.byGame.set(gameId, duel);
    this.deps.log("duel escrow opened", {
      duel: duel.id,
      gameID: gameId,
      fundingEnds: opened.fundingEnds,
    });
  }

  private async makeGame(duel: Duel, existingGameId?: string): Promise<void> {
    const gameId = existingGameId ?? this.deps.newGameId();
    if (gameId === null) throw new DuelError(503, "no_game_id");
    const game = this.deps.games.createGame(
      gameId,
      duelGameConfig(await this.deps.baseConfig()),
    );
    if (!game) throw new DuelError(503, "no_game");
    // Held: nobody else can start it, and it starts only with these two.
    game.holdForPaidStart();
    duel.gameId = gameId;
    duel.phase = "starting";
    duel.startedAt = this.now();
    this.byGame.set(gameId, duel);
    this.deps.log("duel game made", { duel: duel.id, gameID: gameId });
  }

  /** May this player sit in this game? Only the duel's two may. */
  isDuelGame(gameId: string): boolean {
    return this.byGame.has(gameId);
  }

  admits(gameId: string, pid: string): boolean {
    return this.byGame.get(gameId)?.sides.some((s) => s.pid === pid) ?? false;
  }

  /** Every second or so: start, drop or close games, expire stale states. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (this.queue && now - this.queue.seen > QUEUE_STALE_MS) {
        this.queue = null;
        this.queueAbandoned++;
      }
      for (const duel of this.duels.values()) {
        if (duel.phase === "invite" && now - duel.createdAt > INVITE_TTL_MS) {
          this.cancel(duel, "expired");
        } else if (
          duel.phase === "confirm" &&
          now - (duel.matchedAt ?? duel.createdAt) > CONFIRM_WINDOW_MS
        ) {
          this.cancel(duel, "not_confirmed");
        } else if (duel.phase === "funding") {
          await this.driveFunding(duel, now);
        } else if (duel.phase === "starting") {
          this.driveStart(duel, now);
        } else if (duel.phase === "playing") {
          const game = this.deps.games.game(duel.gameId!);
          if (!game || game.hasEnded()) {
            duel.phase = "ended";
            duel.endedAt = now;
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async driveFunding(duel: Duel, now: number): Promise<void> {
    const pot = this.deps.pot;
    if (!pot || !duel.gameId) return;
    if (duel.lastPollAt !== undefined && now - duel.lastPollAt < 2_000) return;
    duel.lastPollAt = now;
    try {
      const lobby = await pot.lobby(duel.gameId);
      const paid = new Set(lobby.depositors);
      for (const s of duel.sides) s.paid = paid.has(s.pid);
      if (duel.sides.every((s) => s.paid)) {
        await pot.start(duel.gameId);
        await this.makeGame(duel, duel.gameId);
      } else if (now / 1000 >= lobby.fundingEnds - 5) {
        await pot.cancel(duel.gameId, lobby.deposited);
        this.cancel(duel, "not_funded");
      }
    } catch (e) {
      this.deps.log("duel funding poll failed", {
        duel: duel.id,
        gameID: duel.gameId,
        error: String(e),
      });
    }
  }

  private driveStart(duel: Duel, now: number): void {
    const game = this.deps.games.game(duel.gameId!);
    if (!game) {
      this.cancel(duel, "game_gone");
      return;
    }
    const here = game.connectedPersistentIDs();
    const both = duel.sides.every((s) => here.has(s.pid));
    if (both) {
      const ids = new Set(duel.sides.map((s) => s.pid));
      // One team each, in side order: side 0 starts top-left.
      game.releasePaidStart(
        ids,
        duel.sides.map((s) => [s.pid]),
      );
      duel.phase = "playing";
      duel.playingAt = now;
      this.deps.log("duel starting", { duel: duel.id, gameID: duel.gameId });
    } else if (now - (duel.startedAt ?? now) > START_WINDOW_MS) {
      game.cancelPaidLobby();
      this.cancel(duel, "no_show");
    }
  }

  private cancel(duel: Duel, reason: string): void {
    duel.phase = "cancelled";
    duel.reason = reason;
    duel.endedAt = this.now();
    if (duel.gameId) {
      const game = this.deps.games.game(duel.gameId);
      if (game && !game.hasStarted()) game.cancelPaidLobby();
    }
    this.saveHistory();
  }

  // ── after the match ──

  report(id: string, pid: string, report: DuelReport): void {
    const duel = this.mustSide(id, pid);
    if (duel.phase !== "playing" && duel.phase !== "ended") {
      throw new DuelError(409, duel.phase);
    }
    // The first report stands: both clients ran the same simulation.
    duel.report ??= report;
    duel.sides.forEach((s, i) => {
      s.won = report.winner === i;
    });
    if (duel.phase === "playing") {
      duel.phase = "ended";
      duel.endedAt = this.now();
    }
    this.saveHistory();
  }

  /**
   * A rematch answer. When both say yes, the new duel goes straight to
   * "confirm": each still confirms it on their own, as with a stake.
   */
  rematch(id: string, pid: string, yes: boolean): Duel {
    const duel = this.mustSide(id, pid);
    if (duel.phase === "playing") {
      duel.phase = "ended";
      duel.endedAt = this.now();
    }
    if (duel.phase !== "ended") throw new DuelError(409, duel.phase);
    if (duel.rematchId) return this.duels.get(duel.rematchId)!;
    const side = duel.sides.find((s) => s.pid === pid)!;
    if (side.rematch === undefined) side.rematchAt = this.now();
    side.rematch = yes;
    if (duel.sides.every((s) => s.rematch === true)) {
      const next: Duel = {
        id: this.newId(),
        kind: duel.kind,
        sides: duel.sides.map((s) => ({
          pid: s.pid,
          name: s.name,
          ready: false,
        })),
        phase: "confirm",
        createdAt: this.now(),
        matchedAt: this.now(),
        rematchOf: duel.id,
      };
      this.duels.set(next.id, next);
      duel.rematchId = next.id;
      this.saveHistory();
      return next;
    }
    this.saveHistory();
    return duel;
  }

  private mustSide(id: string, pid: string): Duel {
    const duel = this.duels.get(id);
    if (!duel || !duel.sides.some((s) => s.pid === pid)) {
      throw new DuelError(404, "not_found");
    }
    return duel;
  }

  // ── the playtest's numbers ──

  stats() {
    const all = [...this.duels.values()];
    const isPlayed = (d: Duel) => d.phase === "playing" || d.phase === "ended";
    // New pairs only: a rematch is counted on its own.
    const found = all.filter(
      (d) => d.matchedAt !== undefined && d.rematchOf === undefined,
    );
    const played = all.filter(isPlayed);
    const waits = played
      .map((d) => (d.playingAt ?? 0) - (d.queuedAt ?? d.matchedAt ?? 0))
      .filter((ms) => ms >= 0)
      .map((ms) => Math.round(ms / 1000))
      .sort((a, b) => a - b);
    const decided = played.filter((d) => d.report && d.report.winner !== "tie");
    const loserAsked = decided.filter((d) =>
      d.sides.some((s) => s.won === false && s.rematch === true),
    ).length;
    const loserFirst = decided.filter((d) => {
      const loser = d.sides.find((s) => s.won === false);
      const winner = d.sides.find((s) => s.won === true);
      return (
        loser?.rematch === true &&
        (winner?.rematchAt === undefined ||
          (loser.rematchAt ?? 0) <= winner.rematchAt)
      );
    }).length;
    const reports = played.flatMap((d) => (d.report ? [d.report] : []));
    const cancelled: Record<string, number> = {};
    for (const d of all) {
      if (d.phase === "cancelled") {
        cancelled[d.reason ?? "?"] = (cancelled[d.reason ?? "?"] ?? 0) + 1;
      }
    }
    return {
      invites: all.filter((d) => d.kind === "friend").length,
      pairsFound: found.length,
      fromQueue: found.filter((d) => d.kind === "queue").length,
      reachedMatch: found.filter(isPlayed).length,
      queueAbandoned: this.queueAbandoned,
      secondsToStart: {
        median: waits.length ? waits[Math.floor(waits.length / 2)] : null,
        max: waits.length ? waits[waits.length - 1] : null,
      },
      decided: decided.length,
      ties: reports.filter((r) => r.winner === "tie").length,
      loserAskedRematch: loserAsked,
      loserAskedFirst: loserFirst,
      rematchesPlayed: played.filter((d) => d.rematchOf !== undefined).length,
      cancelled,
      // The playtest's question: does the crater pay, or the edge?
      winnerCraterShare: decided.map((d) => {
        const w = d.report!.sides[d.report!.winner as number];
        const total = w.crater + w.rim;
        return total ? Math.round((100 * w.crater) / total) : 0;
      }),
      loserCraterShare: decided.map((d) => {
        const l = d.report!.sides[1 - (d.report!.winner as number)];
        const total = l.crater + l.rim;
        return total ? Math.round((100 * l.crater) / total) : 0;
      }),
    };
  }
}

/** What a player sees of a duel: the opponent, the state, the terms. */
export function duelView(duel: Duel, pid: string) {
  const me = duel.sides.findIndex((s) => s.pid === pid);
  const them = duel.sides[1 - me];
  return {
    id: duel.id,
    kind: duel.kind,
    phase: duel.phase,
    paid: Boolean(duel.paid),
    fundingEnds: duel.fundingEnds,
    reason: duel.reason,
    side: me,
    opponent: them
      ? { name: them.name, ready: them.ready, funded: Boolean(them.paid) }
      : null,
    ready: duel.sides[me]?.ready ?? false,
    funded: Boolean(duel.sides[me]?.paid),
    gameId:
      duel.phase === "funding" ||
      duel.phase === "starting" ||
      duel.phase === "playing"
        ? duel.gameId
        : undefined,
    rematch: {
      mine: duel.sides[me]?.rematch,
      theirs: them?.rematch,
      next: duel.rematchId,
    },
    rematchOf: duel.rematchOf,
  };
}

// ── routes ──

const NameSchema = z.object({ name: z.string().trim().min(1).max(32) });

export function registerDuelRoutes(
  app: Express,
  host: DuelHost,
  auth: (req: Request) => Promise<string | null>,
  log: (msg: string, fields?: Record<string, unknown>) => void,
): void {
  const handle =
    (
      fn: (req: Request, pid: string) => Promise<unknown> | unknown,
      { optionalAuth = false } = {},
    ) =>
    async (req: Request, res: Response) => {
      try {
        const pid = await auth(req);
        if (pid === null && !optionalAuth) {
          res.status(401).json({ error: "sign_in" });
          return;
        }
        res.json(await fn(req, pid ?? ""));
      } catch (e) {
        if (e instanceof DuelError) {
          res.status(e.status).json({ error: e.code });
          return;
        }
        if (e instanceof z.ZodError) {
          res.status(400).json({ error: "bad_request" });
          return;
        }
        log("duel route failed", { error: String(e) });
        res.status(500).json({ error: "failed" });
      }
    };
  const name = (req: Request) => NameSchema.parse(req.body ?? {}).name;
  const view = (d: Duel | null | undefined, pid: string) =>
    d ? duelView(d, pid) : null;

  app.post(
    "/api/duel/invite",
    handle((req, pid) => view(host.invite(pid, name(req)), pid)),
  );
  app.get(
    "/api/duel/invite/:id",
    handle((req, pid) => host.readInvite(String(req.params.id), pid || null), {
      optionalAuth: true,
    }),
  );
  app.post(
    "/api/duel/invite/:id/accept",
    handle((req, pid) =>
      view(host.acceptInvite(String(req.params.id), pid, name(req)), pid),
    ),
  );
  app.post(
    "/api/duel/queue",
    handle((req, pid) => ({
      duel: view(host.joinQueue(pid, name(req)), pid),
      queued: host.inQueue(pid),
    })),
  );
  app.delete(
    "/api/duel/queue",
    handle((_req, pid) => {
      host.leaveQueue(pid);
      return { queued: false };
    }),
  );
  app.get(
    "/api/duel/me",
    handle((_req, pid) => ({
      duel: view(host.active(pid), pid),
      queued: host.inQueue(pid),
    })),
  );
  app.get(
    "/api/duel/:id",
    handle((req, pid) => {
      const d = host.get(String(req.params.id));
      if (!d || !d.sides.some((s) => s.pid === pid)) {
        throw new DuelError(404, "not_found");
      }
      return view(d, pid);
    }),
  );
  app.post(
    "/api/duel/:id/confirm",
    handle(async (req, pid) =>
      view(await host.confirm(String(req.params.id), pid), pid),
    ),
  );
  app.post(
    "/api/duel/:id/decline",
    handle(async (req, pid) =>
      view(await host.decline(String(req.params.id), pid), pid),
    ),
  );
  app.post(
    "/api/duel/:id/report",
    handle((req, pid) => {
      host.report(String(req.params.id), pid, DuelReportSchema.parse(req.body));
      return { ok: true };
    }),
  );
  app.post(
    "/api/duel/:id/rematch",
    handle((req, pid) => {
      const yes = z.object({ yes: z.boolean() }).parse(req.body ?? {}).yes;
      return view(host.rematch(String(req.params.id), pid, yes), pid);
    }),
  );
  app.get("/api/duel-stats", (_req, res) => {
    res.json(host.stats());
  });
}

export type { PaidGame };
