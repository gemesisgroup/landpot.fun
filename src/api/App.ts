import { GameType } from "@openfront/engine-api/game/GameTypes";
import {
  type UserMeResponse,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { ApiConfig } from "./ApiEnv";
import { bigintJson, PotError, type PotService } from "./pot/PotService";
import {
  buildSiwsMessage,
  CHALLENGE_TTL_MS,
  isAddress,
  newNonce,
  nonceOf,
  verifySignature,
} from "./Siws";
import type { GameMeta, GamePlayerRow, Store, User } from "./Store";
import {
  ACCESS_TTL_S,
  hashRefreshToken,
  jwks,
  mintAccessToken,
  newRefreshToken,
  REFRESH_TTL_MS,
  type SigningKeys,
  verifyAccessToken,
} from "./Tokens";

export interface AppDeps {
  config: ApiConfig;
  store: Store;
  keys: SigningKeys;
  /** Paid matches; absent when no escrow is configured. */
  pot?: PotService;
  /** Injected so tests never reach Cloudflare. */
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The public view of an archived record: persistent ids (bearer credentials
 * in dev) and reports removed, like the upstream API. A paid match's
 * replayHash is keccak256 of exactly these bytes, so anyone can fetch
 * /game/:id, check the hash on chain and re-run the match.
 */
export function publicRecordJson(blob: Buffer): string {
  const record = JSON.parse(gunzipSync(blob).toString("utf8")) as {
    info: { players: { persistentID: unknown }[]; reports?: unknown };
  };
  for (const p of record.info.players) p.persistentID = null;
  delete record.info.reports;
  return JSON.stringify(record);
}

const REFRESH_COOKIE = "lp_refresh";
const REFRESH_COOKIE_PATH = "/auth";

type Authed = Request & { user: User };

// ── small helpers ─────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Fixed-window limiter per client IP and bucket. Enough for one process. */
function rateLimit(bucket: string, max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = `${bucket}:${req.ip}`;
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: "rate limited" });
    }
    next();
  };
}

/** The winning clientIDs of a record's `winner` tuple. */
function winnerClientIds(winner: unknown): string[] {
  if (!Array.isArray(winner)) return [];
  if (winner[0] === "player") return winner.slice(1) as string[];
  return winner.slice(2) as string[];
}

const GAME_KIND: Record<GameType, GameMeta["kind"]> = {
  [GameType.Public]: "public",
  [GameType.Private]: "private",
  [GameType.Singleplayer]: "singleplayer",
};

const STREAMS = readFileSync(
  path.resolve(import.meta.dirname, "../../resources/streams.json"),
  "utf8",
);

// ── app ───────────────────────────────────────────────────────────────────

export function createApp(deps: AppDeps): express.Express {
  const { config, store, keys } = deps;
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const app = express();
  app.disable("x-powered-by");
  // Behind exactly one proxy in production (the TLS terminator), so req.ip is
  // the client and rate limits are per player, not per proxy.
  app.set("trust proxy", config.isDev ? false : 1);

  // CORS: credentialed requests only from the site; public reads from anywhere.
  const PUBLIC_READ = /^\/(game|public)\/|^\/\.well-known\/|\.json$/;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    } else if (req.method === "GET" && PUBLIC_READ.test(req.path)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Content-Encoding, Authorization, Accept",
      );
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    next();
  });

  // body-parser inflates the client's gzip singleplayer records itself.
  const json = express.json({ limit: "32mb", inflate: true });

  // ── auth plumbing ──

  const requireUser = async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const userId = token ? await verifyAccessToken(keys, config, token) : null;
    const user = userId ? store.getUser(userId) : null;
    if (!user) return next(new HttpError(401, "unauthorized"));
    (req as Authed).user = user;
    next();
  };

  const requireApiKey = (req: Request, _res: Response, next: NextFunction) => {
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || !safeEqual(key, config.apiKey)) {
      return next(new HttpError(403, "forbidden"));
    }
    next();
  };

  const setRefreshCookie = (res: Response, token: string) => {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: true, // browsers accept Secure cookies on http://localhost
      sameSite: "lax", // landpot.fun and api.landpot.fun are same-site
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TTL_MS,
    });
  };
  const clearRefreshCookie = (res: Response) => {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
    });
  };

  /** Issue a refresh token in `familyId` and an access token for `user`. */
  const issueSession = async (res: Response, user: User, familyId: string) => {
    const { token, hash } = newRefreshToken();
    store.addRefresh(hash, user.id, familyId, now() + REFRESH_TTL_MS);
    setRefreshCookie(res, token);
    return {
      jwt: await mintAccessToken(keys, config, user),
      expiresIn: ACCESS_TTL_S,
    };
  };

  /** End the session behind the request's refresh cookie, if any. */
  const endCookieSession = (req: Request) => {
    const cookie = readCookie(req, REFRESH_COOKIE);
    if (!cookie) return;
    const result = store.takeRefresh(hashRefreshToken(cookie), now());
    if (result.status !== "invalid") store.revokeFamily(result.familyId);
  };

  // ── /auth ──

  const authLimit = rateLimit("auth", 30, 60_000);

  app.post("/auth/refresh", authLimit, async (req, res) => {
    const cookie = readCookie(req, REFRESH_COOKIE);
    if (!cookie) {
      // First visit: every player is a user, guests included. The game
      // server only accepts JWTs in production.
      const user = store.createUser();
      return res.json(await issueSession(res, user, crypto.randomUUID()));
    }
    const result = store.takeRefresh(hashRefreshToken(cookie), now());
    if (result.status === "reused") {
      // A rotated token came back: someone holds a copy. Kill the family.
      store.revokeFamily(result.familyId);
    }
    const user = result.status === "ok" ? store.getUser(result.userId) : null;
    if (result.status !== "ok" || !user) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: "session expired" });
    }
    res.json(await issueSession(res, user, result.familyId));
  });

  app.post("/auth/logout", authLimit, (req, res) => {
    endCookieSession(req);
    clearRefreshCookie(res);
    res.json({ ok: true });
  });

  app.post("/auth/revoke", authLimit, requireUser, (req, res) => {
    store.revokeUser((req as Authed).user.id);
    clearRefreshCookie(res);
    res.json({ ok: true });
  });

  // ── wallet sign-in (Sign-In With Solana) ──

  const walletLimit = rateLimit("wallet", 20, 60_000);

  const ChallengeBody = z.object({
    address: z.string().refine(isAddress, "invalid address"),
  });
  // The cluster the wallet signs in for, as SIWS names it.
  const siwsChain =
    config.pot?.cluster === "mainnet-beta"
      ? "mainnet"
      : (config.pot?.cluster ?? "mainnet");

  app.post(
    "/auth/wallet/challenge",
    walletLimit,
    json,
    requireUser,
    (req, res) => {
      const body = ChallengeBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
      const address = body.data.address;
      const nonce = newNonce();
      const issuedAt = new Date(now());
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
      const message = buildSiwsMessage({
        siteOrigin: config.siteOrigin,
        address,
        chainId: siwsChain,
        nonce,
        issuedAt,
        expiresAt,
      });
      store.putChallenge({
        nonce,
        userId: (req as Authed).user.id,
        address,
        message,
        expiresAt: expiresAt.getTime(),
      });
      res.json({ message });
    },
  );

  const VerifyBody = z.object({
    message: z.string().max(2000),
    signature: z.string().max(200),
  });

  app.post(
    "/auth/wallet/verify",
    walletLimit,
    json,
    requireUser,
    async (req, res) => {
      const body = VerifyBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
      const current = (req as Authed).user;
      const nonce = nonceOf(body.data.message);
      const challenge = nonce ? store.takeChallenge(nonce, now()) : null;
      if (
        !challenge ||
        challenge.userId !== current.id ||
        challenge.message !== body.data.message
      ) {
        throw new HttpError(400, "challenge expired or unknown");
      }
      const signer = challenge.address;
      if (!verifySignature(challenge.message, body.data.signature, signer)) {
        throw new HttpError(401, "signature does not match the address");
      }

      // Known wallet: switch to its account. Unknown: attach it to this
      // guest in place, or to a fresh account if this one already has a
      // different wallet.
      let target = store.getUserByWallet(signer);
      if (target === null) {
        const owner = current.wallet === null ? current : store.createUser();
        try {
          store.setWallet(owner.id, signer);
        } catch {
          throw new HttpError(409, "wallet was linked concurrently, retry");
        }
        target = { ...owner, wallet: signer };
      }

      endCookieSession(req);
      const session = await issueSession(res, target, crypto.randomUUID());
      res.json({ ...session, address: signer });
    },
  );

  // ── /users ──

  app.get("/users/@me", requireUser, (req, res) => {
    const user = (req as Authed).user;
    const body: UserMeResponse = {
      user: user.wallet ? { wallet: { address: user.wallet } } : {},
      ban: null,
      steamLicence: false,
      steamLicenceSince: null,
      noticesSeen: [],
      pendingMessages: [],
      player: {
        publicId: user.publicId,
        adfree: true,
        canCreatePublicLobbies: false,
        trustTier: user.wallet ? "trusted" : "untrusted",
        username: null,
        flares: [],
        achievements: { singleplayerMap: [], player: [] },
        levelHidden: true,
        searchHidden: true,
        clans: [],
        clanRequests: [],
        friends: [],
        subscription: null,
      },
    } as unknown as UserMeResponse;
    // Never ship a body the client would fail to parse.
    res.json(UserMeResponseSchema.parse(body));
  });

  app.get("/public/player/:publicId", (req, res) => {
    const user = store.getUserByPublicId(req.params.publicId);
    if (!user) throw new HttpError(404, "no such player");
    const games = store.countGames(user.id);
    res.json({
      publicId: user.publicId,
      createdAt: new Date(user.createdAt).toISOString(),
      wallet: user.wallet,
      games,
    });
  });

  // ── game server ──

  const JoinVerifyBody = z.object({
    ip: z.string(),
    token: z.string().nullable(),
    username: z.string(),
    clanTag: z.string().nullable(),
  });

  app.post("/join_verify", requireApiKey, json, async (req, res) => {
    const body = JoinVerifyBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
    const { ip, token, username } = body.data;
    // Clans are not part of Landpot: the identity is the name alone.
    const identity = { username, clanTag: null };
    // A null token is a re-admit whose single-use token is already spent;
    // the game server never sends null for a first join (JoinVerify.ts).
    if (token === null) return res.json({ status: "approved", ...identity });
    try {
      const form = new URLSearchParams({
        secret: config.turnstileSecret,
        response: token,
        remoteip: ip,
      });
      const r = await fetchFn(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        { method: "POST", body: form, signal: AbortSignal.timeout(3000) },
      );
      const verdict = (await r.json()) as {
        success?: boolean;
        "error-codes"?: string[];
      };
      if (verdict.success === true) {
        return res.json({ status: "approved", ...identity });
      }
      return res.json({
        status: "rejected",
        reason: "turnstile",
        errorCodes: verdict["error-codes"] ?? [],
      });
    } catch (e) {
      return res.json({
        status: "error",
        reason: `siteverify: ${e}`,
        ...identity,
      });
    }
  });

  /** Validate, index and store a record exactly as sent. */
  const storeRecord = (
    raw: unknown,
    expectId?: string,
  ): "created" | "exists" => {
    const parsed = GameRecordSchema.safeParse(raw);
    if (!parsed.success)
      throw new HttpError(400, z.prettifyError(parsed.error));
    const info = parsed.data.info;
    if (expectId !== undefined && info.gameID !== expectId) {
      throw new HttpError(400, "game id does not match the record");
    }
    const players: GamePlayerRow[] = [];
    for (const p of info.players) {
      if (p.persistentID)
        players.push({ userId: p.persistentID, clientId: p.clientID });
    }
    const meta: GameMeta = {
      id: info.gameID,
      kind: GAME_KIND[info.config.gameType],
      start: info.start,
      end: info.end,
      map: String(info.config.gameMap),
      numPlayers: info.players.length,
      winnerClientIds: winnerClientIds(info.winner),
    };
    // The raw body, not parsed.data: zod drops unknown keys, and stake
    // settlement must be able to replay exactly what the server sent.
    const blob = gzipSync(JSON.stringify(raw));
    return store.putGame(meta, blob, players) ? "created" : "exists";
  };

  app.post("/game/:id", requireApiKey, json, (req, res) => {
    const gameId = req.params.id as string;
    const result = storeRecord(req.body, gameId);
    // A paid match settles as soon as its record is in.
    if (result === "created" && deps.pot && store.getRound(gameId)) {
      void deps.pot.tick();
    }
    res
      .status(result === "created" ? 201 : 409)
      .json({ ok: result === "created" });
  });

  app.post(
    "/archive_singleplayer_game",
    rateLimit("archive", 10, 60_000),
    json,
    requireUser,
    (req, res) => {
      const user = (req as Authed).user;
      const info = (
        req.body as {
          info?: {
            config?: { gameType?: unknown };
            players?: { persistentID?: unknown }[];
          };
        }
      )?.info;
      if (info?.config?.gameType !== GameType.Singleplayer) {
        throw new HttpError(400, "not a singleplayer record");
      }
      // The client may only archive its own games.
      if (!info.players?.some((p) => p.persistentID === user.id)) {
        throw new HttpError(403, "record does not belong to this player");
      }
      const result = storeRecord(req.body);
      res
        .status(result === "created" ? 201 : 409)
        .json({ ok: result === "created" });
    },
  );

  const readGame = (req: Request, res: Response) => {
    const blob = store.getGameRecord(req.params.id as string);
    if (!blob) throw new HttpError(404, "no such game");
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    if (req.query.turns === "false") {
      const record = JSON.parse(publicRecordJson(blob)) as { turns?: unknown };
      delete record.turns;
      res.json(record);
      return;
    }
    // Byte for byte what a paid match's replayHash commits to.
    res.type("json").send(publicRecordJson(blob));
  };
  app.get("/game/:id", readGame);
  app.get("/public/game/:id", readGame);

  // ── homepage stats ──

  // Names live only in the archived records; a record never changes, so a
  // game's names are read once and kept (bounded).
  const nameCache = new Map<string, Map<string, string>>();
  const namesOf = (gameId: string): Map<string, string> => {
    const hit = nameCache.get(gameId);
    if (hit) return hit;
    const names = new Map<string, string>();
    const blob = store.getGameRecord(gameId);
    if (blob) {
      try {
        const rec = JSON.parse(gunzipSync(blob).toString("utf8")) as {
          info?: { players?: { clientID?: string; username?: string }[] };
        };
        for (const p of rec.info?.players ?? []) {
          if (p.clientID && p.username) names.set(p.clientID, p.username);
        }
      } catch {
        // A broken record just has no names.
      }
    }
    if (nameCache.size >= 500) {
      nameCache.delete(nameCache.keys().next().value!);
    }
    nameCache.set(gameId, names);
    return names;
  };
  const DAY_MS = 24 * 60 * 60 * 1000;
  let statsCache: { at: number; body: unknown } | null = null;
  app.get("/public/stats", rateLimit("stats", 240, 60_000), (_req, res) => {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > 15_000) {
      const recent = store.recentGames(6).map((g) => {
        const names = namesOf(g.id);
        return {
          id: g.id,
          map: g.map,
          players: g.numPlayers,
          endedAt: g.end,
          durationMs: Math.max(0, g.end - g.start),
          winners: g.winnerClientIds
            .map((c) => names.get(c))
            .filter((n): n is string => n !== undefined)
            .slice(0, 3),
        };
      });
      const top = store.topWinners(now - 7 * DAY_MS, 5).map((t) => ({
        publicId: t.publicId,
        name: namesOf(t.lastGameId).get(t.lastClientId) ?? null,
        wins: t.wins,
        played: t.played,
      }));
      statsCache = {
        at: now,
        body: { games24h: store.countGamesSince(now - DAY_MS), recent, top },
      };
    }
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json(statsCache.body);
  });

  // ── paid matches (docs/LandpotPot.md) ──

  const needPot = (): PotService => {
    if (!deps.pot) throw new HttpError(503, "paid matches are off");
    return deps.pot;
  };
  const sendJson = (res: Response, v: unknown) =>
    res.type("json").send(bigintJson(v));
  const walletParam = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (!isAddress(v)) throw new HttpError(400, "bad wallet address");
    return v;
  };

  // Game server: run a paid lobby (or a 1v1 duel round when body.mode === "duel").
  app.post("/pot/open/:id", requireApiKey, json, async (req, res) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== undefined && mode !== "duel") {
      throw new HttpError(400, "invalid mode");
    }
    const id = req.params.id as string;
    sendJson(
      res,
      mode === "duel" ? await needPot().openDuel(id) : await needPot().open(id),
    );
  });
  // The host: make the next paid lobby a Cup (docs/CalderaCupHost.md).
  app.post("/pot/cup-next", requireApiKey, (_req, res) => {
    needPot().armCup();
    res.json({ armed: true });
  });
  app.get("/pot/lobby/:id", requireApiKey, async (req, res) => {
    sendJson(res, await needPot().lobby(req.params.id as string));
  });
  app.post("/pot/seat/:id", requireApiKey, json, async (req, res) => {
    const pid = (req.body as { persistentID?: unknown })?.persistentID;
    if (typeof pid !== "string") throw new HttpError(400, "persistentID");
    res.json({ seated: await needPot().seat(req.params.id as string, pid) });
  });
  app.post("/pot/start/:id", requireApiKey, async (req, res) => {
    const id = req.params.id as string;
    res.json({ depositors: await needPot().start(id) });
  });
  app.post("/pot/cancel/:id", requireApiKey, json, async (req, res) => {
    const seen = (req.body as { deposited?: unknown } | undefined)?.deposited;
    if (seen !== undefined && !Number.isSafeInteger(seen)) {
      throw new HttpError(400, "deposited");
    }
    await needPot().cancel(req.params.id as string, seen as number | undefined);
    res.json({ cancelled: true });
  });
  // Normally the keeper does these; kept for operators.
  app.post("/pot/settle/:id", requireApiKey, async (req, res) => {
    sendJson(res, await needPot().settle(req.params.id as string));
  });
  app.post("/pot/finalize/:id", requireApiKey, async (req, res) => {
    const tx = await needPot().finalize(req.params.id as string);
    res.json({ finalized: tx !== null, tx });
  });

  // Public: what the client needs to deposit and claim.
  app.get("/public/pot/config", async (_req, res) => {
    if (!deps.pot) {
      res.json({ enabled: false });
      return;
    }
    const pot = deps.pot;
    const token = await pot.token();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      enabled: true,
      cluster: config.pot!.cluster,
      program: config.pot!.programId,
      token,
      stake: (await pot.stakeUnits()).toString(),
      ...(await pot.fees()),
      minPlayers: pot.rules.minPlayers,
      maxPlayers: pot.rules.maxPlayers,
      ...(pot.rules.cupHourUTC === undefined
        ? {}
        : { cupHourUTC: pot.rules.cupHourUTC }),
    });
  });
  app.get(
    "/public/pot/lobbies",
    rateLimit("pot", 120, 60_000),
    async (req, res) => {
      if (!deps.pot) {
        res.json({ lobbies: [] });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        lobbies: await deps.pot.openLobbies(walletParam(req.query.wallet)),
      });
    },
  );
  app.get(
    "/public/pot/claims/:wallet",
    rateLimit("pot", 120, 60_000),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        claims: await needPot().claims(walletParam(req.params.wallet)!),
      });
    },
  );
  // Unsigned transactions for the player's wallet to sign and send. Only
  // that wallet can sign them, so they need no session.
  const TxBody = z.object({
    gameId: z.string().min(1).max(64),
    wallet: z.string().refine(isAddress, "invalid address"),
  });
  // Each costs a few RPC reads, like the pot reads above.
  const txLimit = rateLimit("pot-tx", 120, 60_000);
  app.post(
    "/public/pot/partner/:id",
    txLimit,
    requireUser,
    json,
    (req, res) => {
      const wallet = (req as Authed).user.wallet;
      if (!wallet) throw new HttpError(403, "Sign in with your wallet");
      const partner = walletParam(req.body?.partner);
      if (!partner) throw new HttpError(400, "Missing partner wallet");
      needPot().nominate(req.params.id as string, wallet, partner);
      res.sendStatus(204);
    },
  );
  // Cup invite links: the inviter gets a link, the friend opens it, sees
  // the tournament and who invited them, and confirms. Opening the link
  // confirms nothing.
  app.post("/public/pot/invite/:id", txLimit, requireUser, (req, res) => {
    const wallet = (req as Authed).user.wallet;
    if (!wallet) throw new HttpError(403, "Sign in with your wallet");
    res.setHeader("Cache-Control", "no-store");
    res.json(needPot().invite(req.params.id as string, wallet));
  });
  app.get(
    "/public/pot/invite/:token",
    rateLimit("pot", 120, 60_000),
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(
        needPot().inviteView(
          String(req.params.token),
          walletParam(req.query.wallet),
        ),
      );
    },
  );
  app.post(
    "/public/pot/invite/:token/accept",
    txLimit,
    requireUser,
    (req, res) => {
      const wallet = (req as Authed).user.wallet;
      if (!wallet) throw new HttpError(403, "Sign in with your wallet");
      needPot().acceptInvite(String(req.params.token), wallet);
      res.sendStatus(204);
    },
  );
  app.post(
    "/public/pot/rematch/:id",
    txLimit,
    requireUser,
    json,
    async (req, res) => {
      const wallet = (req as Authed).user.wallet;
      if (!wallet) throw new HttpError(403, "Sign in with your wallet");
      const again = (req.body as { again?: unknown } | undefined)?.again;
      if (typeof again !== "boolean") throw new HttpError(400, "again");
      await needPot().rematch(req.params.id as string, wallet, again);
      res.sendStatus(204);
    },
  );
  app.get("/pot/cup-stats/:id", requireApiKey, async (req, res) => {
    res.json(await needPot().cupStats(req.params.id as string));
  });
  app.post("/public/pot/deposit-tx", txLimit, json, async (req, res) => {
    const body = TxBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      transaction: await needPot().depositTx(
        body.data.gameId,
        body.data.wallet,
      ),
    });
  });
  app.post("/public/pot/claim-tx", txLimit, json, async (req, res) => {
    const body = TxBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      transaction: await needPot().claimTx(body.data.gameId, body.data.wallet),
    });
  });
  app.get(
    "/public/pot/tx/:signature",
    rateLimit("pot", 120, 60_000),
    async (req, res) => {
      const sig = req.params.signature as string;
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
        throw new HttpError(400, "bad signature");
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: await needPot().txStatus(sig) });
    },
  );
  // How a paid game was settled, for anyone checking a payout.
  app.get("/public/pot/:id", (req, res) => {
    const row = store.getSettlement(req.params.id as string);
    if (!row) throw new HttpError(404, "no settlement for this game");
    res.json({
      gameId: row.gameId,
      roundId: row.roundId,
      status: row.status,
      updatedAt: row.updatedAt,
      ...(JSON.parse(row.detail) as object),
    });
  });

  // ── static-ish ──

  app.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(jwks(keys));
  });
  // No store in Landpot: an empty, valid catalog.
  app.get("/cosmetics.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ patterns: {}, flags: {} });
  });
  app.get("/streams.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("json").send(STREAMS);
  });
  // A single server: no list, so the client keeps its bootstrap server
  // (ServerList.ts treats a 404 as a reachable backend with no list).
  app.get("/cluster.json", (_req, res) => {
    res.status(404).json({ error: "no server list" });
  });
  // No clans in Landpot: nothing is reserved, so every tag reads as free text.
  app.get("/reserved_clan_tags", requireApiKey, (_req, res) => {
    res.json([]);
  });
  // No custom tribes: the game server falls back to organic bot names.
  app.post("/custom_tribes", requireApiKey, (_req, res) => {
    res.json({ tribes: [] });
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // ── errors ──

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof PotError) {
      return res.status(err.status).json({ error: err.message });
    }
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      // body-parser: malformed JSON, too large, bad encoding.
      return res.status(status).json({ error: (err as Error).message });
    }
    // The chain's RPC turned us away (rate limit): nothing is wrong with
    // the request, and asking again shortly works.
    if (/\b429\b|too many requests/i.test(String(err))) {
      console.warn("api: RPC rate-limited", req.method, req.path);
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "chain busy, try again" });
    }
    console.error("api error", err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
