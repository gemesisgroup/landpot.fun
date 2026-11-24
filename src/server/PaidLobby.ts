import {
  Difficulty,
  GameMapSize,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import {
  PAID_MATCH_CALDERA,
  PAID_MATCH_DISABLED_UNITS,
  PAID_MATCH_MAP,
  PAID_MATCH_MINUTES,
} from "@openfront/shared/PaidMatch";
import { z } from "zod";
import { ServerEnv } from "./ServerEnv";

/**
 * Paid lobbies (docs/LandpotPot.md). The game server never holds chain keys:
 * it asks the Landpot API, which runs the escrow. Every answer that lets a
 * player in, or starts a match, comes from there, and any failure keeps the
 * player out and the lobby waiting. Money paths fail closed.
 */

// ── the API calls ──

const LobbySchema = z.object({
  pairs: z.array(z.array(z.string())).optional(),
  gameId: z.string(),
  phase: z.number(),
  minPlayers: z.number(),
  maxPlayers: z.number(),
  fundingEnds: z.number(),
  deposited: z.number(),
  depositors: z.array(z.string()),
});
export type PaidLobbyStatus = z.infer<typeof LobbySchema>;

const OpenedSchema = z.object({
  cup: z.boolean().optional(),
  duel: z.boolean().optional(),
  fundingEnds: z.number(),
  minPlayers: z.number(),
  maxPlayers: z.number(),
});

export class PotApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PotApi {
  open(gameID: string): Promise<z.infer<typeof OpenedSchema>>;
  openDuel?(
    gameID: string,
    players?: string[],
  ): Promise<z.infer<typeof OpenedSchema>>;
  lobby(gameID: string): Promise<PaidLobbyStatus>;
  seat(gameID: string, persistentID: string): Promise<boolean>;
  /** Closes deposits on chain; resolves to the persistentIDs that are in. */
  start(gameID: string): Promise<string[]>;
  /** `deposited`: the count the decision was made on. */
  cancel(gameID: string, deposited: number): Promise<void>;
}

async function call(
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  const headers: Record<string, string> = { "x-api-key": ServerEnv.apiKey() };
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${ServerEnv.jwtIssuer()}${route}`, init);

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: unknown } | null)?.error;
    throw new PotApiError(
      res.status,
      typeof msg === "string" ? msg : `api returned ${res.status}`,
    );
  }
  return data;
}

export const httpPotApi: PotApi = {
  // Opening and starting wait for a mined transaction.
  open: async (id) =>
    OpenedSchema.parse(
      await call("POST", `/pot/open/${id}`, undefined, 60_000),
    ),
  openDuel: async (id, players) =>
    OpenedSchema.parse(
      await call(
        "POST",
        `/pot/open/${id}`,
        { mode: "duel", ...(players ? { players } : {}) },
        60_000,
      ),
    ),
  lobby: async (id) => LobbySchema.parse(await call("GET", `/pot/lobby/${id}`)),
  seat: async (id, persistentID) =>
    z
      .object({ seated: z.boolean() })
      .parse(await call("POST", `/pot/seat/${id}`, { persistentID })).seated,
  start: async (id) =>
    z
      .object({ depositors: z.array(z.string()) })
      .parse(await call("POST", `/pot/start/${id}`, undefined, 60_000))
      .depositors,
  cancel: async (id, deposited) => {
    await call("POST", `/pot/cancel/${id}`, { deposited }, 60_000);
  },
};

// ── the match ──

/**
 * Every paid match is the same contest: free for all, humans only (no bots,
 * no nations, which would take land nobody paid for), no alliances (which
 * would let wallets pool a pot), at most 16 seats.
 */
export function paidGameConfig(
  base: GameConfig,
  maxPlayers: number,
  cup = false,
): GameConfig {
  return {
    ...base,
    gameType: GameType.Private,
    ...(cup
      ? { newEra: undefined, rankedType: undefined, tutorial: undefined }
      : {}),
    gameMode: cup ? GameMode.Team : GameMode.FFA,
    playerTeams: cup ? 4 : undefined,
    gameMap: PAID_MATCH_MAP,
    gameMapSize: GameMapSize.Compact,
    // Land held at the end is the payout, so the end is a known time.
    maxTimerValue: cup ? PAID_MATCH_MINUTES + 2 : PAID_MATCH_MINUTES,
    // ...or earlier at the default 80%, never lowered by overtime.
    winThresholdTenths: undefined,
    overtime: undefined,
    doomsdayClock: undefined,
    // The crater is worth more, and the island erupts toward it at the end.
    caldera: cup
      ? {
          ...PAID_MATCH_CALDERA,
          teamCup: true,
          eruptionSeconds: PAID_MATCH_CALDERA.eruptionSeconds + 120,
        }
      : PAID_MATCH_CALDERA,
    disabledUnits: PAID_MATCH_DISABLED_UNITS,
    publicGameModifiers: undefined,
    difficulty: Difficulty.Medium,
    maxPlayers,
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

// ── when to start ──

export type PaidLobbyAction =
  | { type: "wait" }
  | { type: "start" }
  | { type: "cancel"; reason: string };

/** Close to the funding deadline the lobby decides: start or refund. */
export const DEADLINE_MARGIN_MS = 90_000;
/** After the last deposit, how long the lobby waits for more before starting. */
export const FILL_GRACE_MS = 60_000;
/** Depositors who must be here for a match to start at the deadline. */
export const MIN_PRESENT = 2;

/**
 * Starts as soon as the lobby is full and everyone who paid is here; once
 * enough have paid and everyone is here, after a minute without a new
 * deposit; and in any case shortly before deposits close, if enough paid
 * and at least two of them are here. Otherwise at that point: cancel, so
 * entries are refunded.
 *
 * A depositor who is not connected when the match starts gets their entry
 * back less fees at settlement (src/api/pot/Payouts.ts), so starting without
 * them costs them little and lets everyone else play.
 */
export function decidePaidLobby(input: {
  now: number;
  /** ms */
  fundingEnds: number;
  minPlayers: number;
  maxPlayers: number;
  /** Deposits on chain. */
  deposited: number;
  /** The depositors that have a Landpot account, as persistentIDs. */
  depositors: readonly string[];
  pairs?: string[][];
  connected: ReadonlySet<string>;
  /** When the depositor count last changed, ms. */
  lastDepositAt: number;
}): PaidLobbyAction {
  const deposited = input.deposited;
  const nearDeadline = input.now >= input.fundingEnds - DEADLINE_MARGIN_MS;
  if (deposited < input.minPlayers) {
    return nearDeadline
      ? {
          type: "cancel",
          reason: `${deposited} of ${input.minPlayers} deposited`,
        }
      : { type: "wait" };
  }
  if (input.pairs) {
    const roster = new Set(input.pairs.flat());
    const ready =
      input.pairs.length === 4 &&
      input.pairs.every((p) => p.length === 2) &&
      roster.size === 8 &&
      deposited === 8 &&
      input.depositors.length === 8 &&
      input.depositors.every((p) => roster.has(p) && input.connected.has(p));
    if (ready) return { type: "start" };
    return nearDeadline
      ? { type: "cancel", reason: "Cup needs four complete pairs" }
      : { type: "wait" };
  }
  if (nearDeadline) {
    const here = input.depositors.filter((p) => input.connected.has(p)).length;
    return here >= MIN_PRESENT
      ? { type: "start" }
      : { type: "cancel", reason: `${here} of ${deposited} here` };
  }
  // A wallet that paid without signing in here has no account yet, so it
  // can't be here: wait for it like for anyone else.
  const allHere =
    input.depositors.length >= deposited &&
    input.depositors.every((p) => input.connected.has(p));
  if (!allHere) return { type: "wait" };
  if (deposited >= input.maxPlayers) return { type: "start" };
  return input.now - input.lastDepositAt >= FILL_GRACE_MS
    ? { type: "start" }
    : { type: "wait" };
}

// ── the host loop ──

/** The slice of GameManager the host needs. */
export interface PaidGames {
  game(id: string): PaidGame | null;
  createGame(id: string, config: Partial<GameConfig>): PaidGame | null;
}

/** The slice of GameServer the host needs. */
export interface PaidGame {
  holdForPaidStart(): void;
  isPaidHeld(): boolean;
  hasStarted(): boolean;
  hasEnded(): boolean;
  connectedPersistentIDs(): Set<string>;
  releasePaidStart(depositors: ReadonlySet<string>, pairs?: string[][]): void;
  cancelPaidLobby(): void;
}

interface Tracked {
  fundingEnds: number; // ms
  minPlayers: number;
  maxPlayers: number;
  deposited: number;
  lastDepositAt: number;
  busy: boolean;
}

const POLL_MS = 5_000;
// After a failed open, wait before trying again.
const OPEN_RETRY_MS = 60_000;
// A positive seat answer is final for the round; a negative one is cached
// briefly so a reconnect storm can't flood the API.
const SEAT_DENY_TTL_MS = 3_000;

export class PaidLobbyHost {
  private readonly tracked = new Map<string, Tracked>();
  private readonly seated = new Map<string, Set<string>>();
  private readonly denied = new Map<string, number>();
  private opening = false;
  private nextOpenAt = 0;

  constructor(
    private readonly deps: {
      games: PaidGames;
      api: PotApi;
      /** A fresh game id this worker owns. */
      newGameId: () => string | null;
      baseConfig: () => Promise<GameConfig>;
      isActive: () => boolean;
      log: (msg: string, fields?: Record<string, unknown>) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  isPaid(gameID: string): boolean {
    return this.tracked.has(gameID) || this.seated.has(gameID);
  }

  /**
   * May this player sit in this paid game? Throws when the escrow could not
   * be asked: the caller must turn the player away, never let them in.
   */
  async admits(gameID: string, persistentID: string): Promise<boolean> {
    const seats = this.seated.get(gameID);
    if (seats?.has(persistentID)) return true;
    const key = `${gameID}\0${persistentID}`;
    const deniedAt = this.denied.get(key);
    if (deniedAt !== undefined && this.now() - deniedAt < SEAT_DENY_TTL_MS) {
      return false;
    }
    const ok = await this.deps.api.seat(gameID, persistentID);
    if (ok) {
      this.denied.delete(key);
      this.seated.get(gameID)?.add(persistentID);
    } else {
      this.denied.set(key, this.now());
    }
    return ok;
  }

  start(): void {
    const loop = () => {
      this.tick()
        .catch((e: unknown) =>
          this.deps.log("paid lobby tick failed", { error: String(e) }),
        )
        .finally(() => setTimeout(loop, POLL_MS).unref());
    };
    loop();
  }

  async tick(): Promise<void> {
    for (const [id, t] of this.tracked) {
      const game = this.deps.games.game(id);
      if (!game || game.hasEnded() || !game.isPaidHeld()) {
        // Started (or gone): stop driving it. Seats stay for reconnects
        // until the game itself is gone.
        this.tracked.delete(id);
        continue;
      }
      if (!t.busy) await this.drive(id, game, t);
    }
    for (const id of this.seated.keys()) {
      if (!this.tracked.has(id) && !this.deps.games.game(id)) {
        this.seated.delete(id);
      }
    }
    for (const [key, at] of this.denied) {
      if (this.now() - at >= SEAT_DENY_TTL_MS) this.denied.delete(key);
    }
    if (this.tracked.size === 0) await this.openOne();
  }

  private async openOne(): Promise<void> {
    if (this.opening || !this.deps.isActive() || this.now() < this.nextOpenAt) {
      return;
    }
    const id = this.deps.newGameId();
    if (id === null) return;
    this.opening = true;
    try {
      // The round first: nobody can find the lobby before the API lists it,
      // and a game without a round would be a free paid lobby.
      const round = await this.deps.api.open(id);
      const config = paidGameConfig(
        await this.deps.baseConfig(),
        round.maxPlayers,
        round.cup,
      );
      const game = this.deps.games.createGame(id, config);
      if (!game) {
        await this.deps.api.cancel(id, 0).catch(() => {});
        throw new Error("could not create the game");
      }
      game.holdForPaidStart();
      this.seated.set(id, new Set());
      this.tracked.set(id, {
        fundingEnds: round.fundingEnds * 1000,
        minPlayers: round.minPlayers,
        maxPlayers: round.maxPlayers,
        deposited: 0,
        lastDepositAt: this.now(),
        busy: false,
      });
      this.deps.log("paid lobby open", { gameID: id });
    } catch (e) {
      this.nextOpenAt = this.now() + OPEN_RETRY_MS;
      this.deps.log("could not open a paid lobby", {
        gameID: id,
        error: String(e),
      });
    } finally {
      this.opening = false;
    }
  }

  private async drive(id: string, game: PaidGame, t: Tracked): Promise<void> {
    t.busy = true;
    try {
      const status = await this.deps.api.lobby(id);
      if (status.deposited !== t.deposited) {
        t.deposited = status.deposited;
        t.lastDepositAt = this.now();
      }
      const action = decidePaidLobby({
        now: this.now(),
        fundingEnds: t.fundingEnds,
        minPlayers: t.minPlayers,
        maxPlayers: t.maxPlayers,
        deposited: status.deposited,
        depositors: status.depositors,
        pairs: status.pairs,
        connected: game.connectedPersistentIDs(),
        lastDepositAt: t.lastDepositAt,
      });
      if (action.type === "start") {
        // Only what the chain says after start is mined: a deposit that
        // landed in between is in the round, so it gets a seat too.
        const depositors = new Set(await this.deps.api.start(id));
        for (const p of depositors) this.seated.get(id)?.add(p);
        if (status.pairs) game.releasePaidStart(depositors, status.pairs);
        else game.releasePaidStart(depositors);
        this.tracked.delete(id);
        this.deps.log("paid match starting", {
          gameID: id,
          seated: depositors.size,
        });
      } else if (action.type === "cancel") {
        await this.deps.api.cancel(id, status.deposited);
        game.cancelPaidLobby();
        this.tracked.delete(id);
        this.deps.log("paid lobby cancelled", {
          gameID: id,
          reason: action.reason,
        });
      }
    } catch (e) {
      // Nothing changes on a failure: the lobby keeps waiting and the next
      // tick asks again. Past the deadline the API's keeper refunds anyway.
      this.deps.log("paid lobby step failed", { gameID: id, error: String(e) });
      if (this.now() >= t.fundingEnds) {
        game.cancelPaidLobby();
        this.tracked.delete(id);
      }
    } finally {
      t.busy = false;
    }
  }
}
