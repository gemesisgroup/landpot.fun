import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * Persistence for the Landpot API. SQLite (node:sqlite, WAL) behind a small
 * interface: one process, synchronous queries measured in microseconds, no
 * native build. If the API ever needs several instances, a Postgres Store
 * implements the same interface.
 */

export interface User {
  id: string; // UUID, the game's persistentID
  publicId: string;
  wallet: string | null; // Solana public key, base58 (case-sensitive)
  role: string | null;
  createdAt: number;
}

export type RefreshResult =
  | { status: "ok"; userId: string; familyId: string }
  | { status: "reused"; familyId: string } // replay of a rotated token
  | { status: "invalid" }; // unknown, expired or revoked

export interface WalletChallenge {
  nonce: string;
  userId: string;
  address: string;
  message: string;
  expiresAt: number;
}

export interface GameMeta {
  id: string;
  kind: "public" | "private" | "singleplayer";
  start: number;
  end: number;
  map: string;
  numPlayers: number;
  winnerClientIds: string[];
}

export interface GamePlayerRow {
  userId: string;
  clientId: string;
}

export interface SettlementRow {
  gameId: string;
  roundId: string;
  /** proposed | skipped | void | failed | finalized */
  status: string;
  /** JSON: amounts, players, tx, reason... (bigints as strings). */
  detail: string;
  updatedAt: number;
}

/** A paid lobby's escrow round, as the API opened it. */
export interface PotRoundRow {
  cup?: boolean;
  gameId: string;
  roundId: string;
  /** In token base units, as a decimal string. */
  stake: string;
  minPlayers: number;
  maxPlayers: number;
  /** Chain time, seconds. */
  fundingEnds: number;
  resultEnds: number;
  /** funding → started → closed, or cancelled. */
  state: PotRoundState;
  createdAt: number;
}

export type PotRoundState = "funding" | "started" | "closed" | "cancelled";

export interface Store {
  createUser(): User;
  getUser(id: string): User | null;
  getUserByPublicId(publicId: string): User | null;
  getUserByWallet(address: string): User | null;
  setWallet(userId: string, address: string): void;

  addRefresh(
    tokenHash: string,
    userId: string,
    familyId: string,
    expiresAt: number,
  ): void;
  /** Consume a refresh token: marks it used so it can never rotate twice. */
  takeRefresh(tokenHash: string, now: number): RefreshResult;
  revokeFamily(familyId: string): void;
  revokeUser(userId: string): void;

  putChallenge(challenge: WalletChallenge): void;
  /** Single use: returns and deletes the challenge if it has not expired. */
  takeChallenge(nonce: string, now: number): WalletChallenge | null;

  /** False when a game with this id is already stored. */
  putGame(meta: GameMeta, record: Buffer, players: GamePlayerRow[]): boolean;
  getGameRecord(id: string): Buffer | null;
  countGames(userId: string): { played: number; won: number };

  /** The latest settlement attempt for a paid game (docs/LandpotPot.md). */
  putSettlement(row: SettlementRow): void;
  getSettlement(gameId: string): SettlementRow | null;
  cupPairs(gameId: string): string[][];
  pickPartner(gameId: string, wallet: string, partner: string): void;
  putRound(row: PotRoundRow): void;
  getRound(gameId: string): PotRoundRow | null;
  setRoundState(gameId: string, state: PotRoundState): void;
  /** Rounds in these states, oldest first. */
  roundsIn(states: readonly PotRoundState[]): PotRoundRow[];
  /** Rounds created at or after `since` (ms), newest first. */
  recentRounds(since: number): PotRoundRow[];

  /** Drop expired refresh tokens and challenges. */
  sweep(now: number): void;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  public_id  TEXT NOT NULL UNIQUE,
  wallet     TEXT UNIQUE,
  role       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  nonce      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  map         TEXT NOT NULL,
  num_players INTEGER NOT NULL,
  winners     TEXT NOT NULL,
  record      BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS games_end ON games(end_ms);

CREATE TABLE IF NOT EXISTS game_players (
  game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  won       INTEGER NOT NULL,
  PRIMARY KEY (game_id, client_id)
);
CREATE INDEX IF NOT EXISTS game_players_user ON game_players(user_id);

CREATE TABLE IF NOT EXISTS pot_settlements (
  game_id    TEXT PRIMARY KEY,
  round_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cup_picks (game_id TEXT NOT NULL, wallet TEXT NOT NULL, partner TEXT NOT NULL, PRIMARY KEY(game_id, wallet));
CREATE TABLE IF NOT EXISTS pot_rounds (
  game_id      TEXT PRIMARY KEY,
  round_id     TEXT NOT NULL,
  stake        TEXT NOT NULL,
  min_players  INTEGER NOT NULL,
  max_players  INTEGER NOT NULL,
  funding_ends INTEGER NOT NULL,
  result_ends  INTEGER NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pot_rounds_state ON pot_rounds(state);
CREATE INDEX IF NOT EXISTS pot_rounds_created ON pot_rounds(created_at);
`;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function newPublicId(): string {
  // 8 chars of base62 from rejection-free bytes (248 = 4 * 62).
  let out = "";
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === 8) break;
    }
  }
  return out;
}

type Row = Record<string, unknown>;

function toUser(row: Row | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id as string,
    publicId: row.public_id as string,
    wallet: (row.wallet as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

function toRound(row: Row): PotRoundRow {
  return {
    gameId: row.game_id as string,
    roundId: row.round_id as string,
    ...(row.cup ? { cup: true } : {}),
    stake: row.stake as string,
    minPlayers: Number(row.min_players),
    maxPlayers: Number(row.max_players),
    fundingEnds: Number(row.funding_ends),
    resultEnds: Number(row.result_ends),
    state: row.state as PotRoundState,
    createdAt: Number(row.created_at),
  };
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly q: Record<string, StatementSync>;

  /** `file` is a path, or ":memory:" for tests. */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    if (
      !this.db
        .prepare("PRAGMA table_info(pot_rounds)")
        .all()
        .some((c) => c.name === "cup")
    ) {
      this.db.exec(
        "ALTER TABLE pot_rounds ADD COLUMN cup INTEGER NOT NULL DEFAULT 0",
      );
    }
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      insertUser: p(
        "INSERT INTO users (id, public_id, created_at) VALUES (?, ?, ?)",
      ),
      userById: p("SELECT * FROM users WHERE id = ?"),
      userByPublicId: p("SELECT * FROM users WHERE public_id = ?"),
      userByWallet: p("SELECT * FROM users WHERE wallet = ?"),
      setWallet: p("UPDATE users SET wallet = ? WHERE id = ?"),
      insertRefresh: p(
        "INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at) VALUES (?, ?, ?, ?)",
      ),
      refreshByHash: p("SELECT * FROM refresh_tokens WHERE token_hash = ?"),
      markUsed: p(
        "UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
      ),
      revokeFamily: p("DELETE FROM refresh_tokens WHERE family_id = ?"),
      revokeUser: p("DELETE FROM refresh_tokens WHERE user_id = ?"),
      insertChallenge: p(
        "INSERT INTO wallet_challenges (nonce, user_id, address, message, expires_at) VALUES (?, ?, ?, ?, ?)",
      ),
      takeChallenge: p(
        "DELETE FROM wallet_challenges WHERE nonce = ? RETURNING *",
      ),
      insertGame: p(
        "INSERT OR IGNORE INTO games (id, kind, start_ms, end_ms, map, num_players, winners, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      insertGamePlayer: p(
        "INSERT OR IGNORE INTO game_players (game_id, user_id, client_id, won) VALUES (?, ?, ?, ?)",
      ),
      gameRecord: p("SELECT record FROM games WHERE id = ?"),
      putSettlement: p(
        "INSERT OR REPLACE INTO pot_settlements (game_id, round_id, status, detail, updated_at) VALUES (?, ?, ?, ?, ?)",
      ),
      getSettlement: p("SELECT * FROM pot_settlements WHERE game_id = ?"),
      putRound: p(
        "INSERT INTO pot_rounds (game_id, round_id, stake, min_players, max_players, funding_ends, result_ends, state, created_at, cup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      getRound: p("SELECT * FROM pot_rounds WHERE game_id = ?"),
      setRoundState: p("UPDATE pot_rounds SET state = ? WHERE game_id = ?"),
      roundsIn: p(
        "SELECT * FROM pot_rounds WHERE state IN (SELECT value FROM json_each(?)) ORDER BY created_at",
      ),
      recentRounds: p(
        "SELECT * FROM pot_rounds WHERE created_at >= ? ORDER BY created_at DESC",
      ),
      countGames: p(
        "SELECT COUNT(*) AS played, COALESCE(SUM(won), 0) AS won FROM game_players WHERE user_id = ?",
      ),
      sweepRefresh: p("DELETE FROM refresh_tokens WHERE expires_at < ?"),
      sweepChallenges: p("DELETE FROM wallet_challenges WHERE expires_at < ?"),
    };
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createUser(): User {
    const id = randomUUID();
    const now = Date.now();
    // A public id collision is ~1 in 2e14 per pair; retry rather than assume.
    for (let attempt = 0; ; attempt++) {
      const publicId = newPublicId();
      try {
        this.q.insertUser.run(id, publicId, now);
        return { id, publicId, wallet: null, role: null, createdAt: now };
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  }

  getUser(id: string): User | null {
    return toUser(this.q.userById.get(id) as Row | undefined);
  }

  getUserByPublicId(publicId: string): User | null {
    return toUser(this.q.userByPublicId.get(publicId) as Row | undefined);
  }

  getUserByWallet(address: string): User | null {
    return toUser(this.q.userByWallet.get(address) as Row | undefined);
  }

  setWallet(userId: string, address: string): void {
    this.q.setWallet.run(address, userId);
  }

  addRefresh(
    tokenHash: string,
    userId: string,
    familyId: string,
    expiresAt: number,
  ): void {
    this.q.insertRefresh.run(tokenHash, userId, familyId, expiresAt);
  }

  takeRefresh(tokenHash: string, now: number): RefreshResult {
    return this.tx(() => {
      const row = this.q.refreshByHash.get(tokenHash) as Row | undefined;
      if (!row) return { status: "invalid" };
      const familyId = row.family_id as string;
      if (row.used_at !== null) return { status: "reused", familyId };
      if ((row.expires_at as number) < now) return { status: "invalid" };
      this.q.markUsed.run(now, tokenHash);
      return { status: "ok", userId: row.user_id as string, familyId };
    });
  }

  revokeFamily(familyId: string): void {
    this.q.revokeFamily.run(familyId);
  }

  revokeUser(userId: string): void {
    this.q.revokeUser.run(userId);
  }

  putChallenge(c: WalletChallenge): void {
    this.q.insertChallenge.run(
      c.nonce,
      c.userId,
      c.address,
      c.message,
      c.expiresAt,
    );
  }

  takeChallenge(nonce: string, now: number): WalletChallenge | null {
    const row = this.q.takeChallenge.get(nonce) as Row | undefined;
    if (!row || (row.expires_at as number) < now) return null;
    return {
      nonce: row.nonce as string,
      userId: row.user_id as string,
      address: row.address as string,
      message: row.message as string,
      expiresAt: row.expires_at as number,
    };
  }

  putGame(meta: GameMeta, record: Buffer, players: GamePlayerRow[]): boolean {
    const winners = new Set(meta.winnerClientIds);
    return this.tx(() => {
      const result = this.q.insertGame.run(
        meta.id,
        meta.kind,
        meta.start,
        meta.end,
        meta.map,
        meta.numPlayers,
        JSON.stringify(meta.winnerClientIds),
        record,
      );
      if (result.changes === 0) return false;
      for (const p of players) {
        this.q.insertGamePlayer.run(
          meta.id,
          p.userId,
          p.clientId,
          winners.has(p.clientId) ? 1 : 0,
        );
      }
      return true;
    });
  }

  getGameRecord(id: string): Buffer | null {
    const row = this.q.gameRecord.get(id) as Row | undefined;
    if (!row) return null;
    return Buffer.from(row.record as Uint8Array);
  }

  countGames(userId: string): { played: number; won: number } {
    const row = this.q.countGames.get(userId) as Row;
    return { played: Number(row.played), won: Number(row.won) };
  }

  putSettlement(row: SettlementRow): void {
    this.q.putSettlement.run(
      row.gameId,
      row.roundId,
      row.status,
      row.detail,
      row.updatedAt,
    );
  }

  getSettlement(gameId: string): SettlementRow | null {
    const row = this.q.getSettlement.get(gameId) as Row | undefined;
    if (!row) return null;
    return {
      gameId: row.game_id as string,
      roundId: row.round_id as string,
      status: row.status as string,
      detail: row.detail as string,
      updatedAt: row.updated_at as number,
    };
  }

  cupPairs(gameId: string): string[][] {
    return this.db
      .prepare(`SELECT a.wallet, a.partner FROM cup_picks a JOIN cup_picks b
      ON a.game_id=b.game_id AND a.wallet=b.partner AND a.partner=b.wallet
      WHERE a.game_id=? AND a.wallet<a.partner ORDER BY a.wallet`)
      .all(gameId)
      .map((r) => [String(r.wallet), String(r.partner)]);
  }

  pickPartner(gameId: string, wallet: string, partner: string): void {
    this.db
      .prepare(`INSERT INTO cup_picks VALUES (?, ?, ?) ON CONFLICT(game_id,wallet)
      DO UPDATE SET partner=excluded.partner`)
      .run(gameId, wallet, partner);
  }

  putRound(r: PotRoundRow): void {
    this.q.putRound.run(
      r.gameId,
      r.roundId,
      r.stake,
      r.minPlayers,
      r.maxPlayers,
      r.fundingEnds,
      r.resultEnds,
      r.state,
      r.createdAt,
      r.cup ? 1 : 0,
    );
  }

  getRound(gameId: string): PotRoundRow | null {
    const row = this.q.getRound.get(gameId) as Row | undefined;
    return row ? toRound(row) : null;
  }

  setRoundState(gameId: string, state: PotRoundState): void {
    this.q.setRoundState.run(state, gameId);
  }

  roundsIn(states: readonly PotRoundState[]): PotRoundRow[] {
    return (this.q.roundsIn.all(JSON.stringify(states)) as Row[]).map(toRound);
  }

  recentRounds(since: number): PotRoundRow[] {
    return (this.q.recentRounds.all(since) as Row[]).map(toRound);
  }

  sweep(now: number): void {
    this.q.sweepRefresh.run(now);
    this.q.sweepChallenges.run(now);
  }

  close(): void {
    this.db.close();
  }
}
