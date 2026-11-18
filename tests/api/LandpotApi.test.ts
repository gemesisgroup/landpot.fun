import { ed25519 } from "@noble/curves/ed25519";
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import {
  GameRecordSchema,
  type PlayerRecord,
} from "@openfront/shared/WireSchemas";
import { base58 } from "@scure/base";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../src/api/ApiEnv";
import { createApp } from "../../src/api/App";
import { SqliteStore } from "../../src/api/Store";
import { loadSigningKeys, type SigningKeys } from "../../src/api/Tokens";
import { verifyClientToken } from "../../src/server/jwt";
import { ServerEnv } from "../../src/server/ServerEnv";
import { testGameConfig } from "../util/Wire";

// The contract that matters: tokens this API mints are accepted by the real
// game server code (src/server/jwt.ts), and every body parses with the
// schemas the client uses. Dev mode skips JWTs entirely, so only this test
// proves production auth works.

const SITE = "http://localhost:9000";
const API_KEY = "test-api-key";

let server: Server;
let base: string;
let store: SqliteStore;
let keys: SigningKeys;
let siteverify: { success: boolean } = { success: true };

beforeAll(async () => {
  process.env.DOMAIN = "localhost";
  const config = loadApiConfig({
    DOMAIN: "localhost",
    API_KEY,
    LANDPOT_SITE_ORIGIN: SITE,
    LANDPOT_DATA_DIR: ".data/test-api",
  } as NodeJS.ProcessEnv);
  keys = await loadSigningKeys({
    ...config,
    jwtKey: null,
    dataDir: ".data/test-api",
  });
  store = new SqliteStore(":memory:");
  const app = createApp({
    config,
    store,
    keys,
    fetch: (async () =>
      new Response(JSON.stringify(siteverify))) as unknown as typeof fetch,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The game server would fetch this from the issuer; hand it the same key.
  const jwksBody = await (await fetch(`${base}/.well-known/jwks.json`)).json();
  (ServerEnv as unknown as { publicKey: unknown }).publicKey = jwksBody.keys[0];
});

afterAll(() => {
  server?.close();
  store?.close();
});

beforeEach(() => {
  siteverify = { success: true };
});

/** A browser-like client: keeps the refresh cookie between calls. */
class Client {
  cookie: string | null = null;
  jwt: string | null = null;

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Origin", SITE);
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (this.jwt && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.jwt}`);
    }
    const res = await fetch(base + path, { ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0];
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    return res;
  }

  async refresh(): Promise<Response> {
    const res = await this.call("/auth/refresh", { method: "POST" });
    if (res.ok) this.jwt = ((await res.clone().json()) as { jwt: string }).jwt;
    return res;
  }

  post(path: string, body: unknown): Promise<Response> {
    return this.call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

/** A Solana wallet: what `solana:signMessage` returns, base58. */
function wallet() {
  const priv = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(priv));
  const sign = (message: string) =>
    base58.encode(ed25519.sign(new TextEncoder().encode(message), priv));
  return { address, sign };
}

async function signIn(client: Client, w: ReturnType<typeof wallet>) {
  const challenge = await client.post("/auth/wallet/challenge", {
    address: w.address,
  });
  expect(challenge.status).toBe(200);
  const { message } = (await challenge.json()) as { message: string };
  const res = await client.post("/auth/wallet/verify", {
    message,
    signature: w.sign(message),
  });
  if (res.ok) client.jwt = ((await res.clone().json()) as { jwt: string }).jwt;
  return { res, message };
}

describe("sessions", () => {
  it("mints a guest the game server accepts", async () => {
    const c = new Client();
    const res = await c.refresh();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwt: string; expiresIn: number };
    expect(body.expiresIn).toBe(900);
    expect(c.cookie).toMatch(/^lp_refresh=/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);

    const verdict = await verifyClientToken(body.jwt);
    expect(verdict.type).toBe("success");
    if (verdict.type !== "success") return;
    expect(verdict.claims?.provider).toBeUndefined();
    expect(store.getUser(verdict.persistentId)).not.toBeNull();
  });

  it("rotates the refresh token and kills the family on reuse", async () => {
    const c = new Client();
    await c.refresh();
    const first = c.cookie;
    expect((await c.refresh()).status).toBe(200);
    const second = c.cookie;
    expect(second).not.toBe(first);

    // Replaying the rotated token revokes the live one too.
    const thief = new Client();
    thief.cookie = first;
    expect((await thief.refresh()).status).toBe(401);
    c.cookie = second;
    expect((await c.refresh()).status).toBe(401);
  });

  it("logs out", async () => {
    const c = new Client();
    await c.refresh();
    const cookie = c.cookie;
    expect((await c.call("/auth/logout", { method: "POST" })).status).toBe(200);
    c.cookie = cookie;
    expect((await c.refresh()).status).toBe(401);
  });

  it("answers CORS only for the site with credentials", async () => {
    const res = await fetch(`${base}/auth/refresh`, {
      method: "OPTIONS",
      headers: { Origin: SITE },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/users/@me", () => {
  it("parses with the client's schema", async () => {
    const c = new Client();
    await c.refresh();
    const res = await c.call("/users/@me");
    expect(res.status).toBe(200);
    const me = UserMeResponseSchema.parse(await res.json());
    expect(me.player.publicId).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(me.user.wallet).toBeUndefined();
  });

  it("rejects a missing or forged token", async () => {
    expect((await fetch(`${base}/users/@me`)).status).toBe(401);
    const forged = await fetch(`${base}/users/@me`, {
      headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.e30." },
    });
    expect(forged.status).toBe(401);
  });
});

describe("wallet sign-in", () => {
  it("attaches a new wallet to the guest in place", async () => {
    const c = new Client();
    await c.refresh();
    const before = await verifyClientToken(c.jwt!);
    const w = wallet();
    const { res } = await signIn(c, w);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: string };
    expect(body.address).toBe(w.address);

    const after = await verifyClientToken(c.jwt!);
    expect(after.type).toBe("success");
    if (after.type !== "success" || before.type !== "success") return;
    expect(after.persistentId).toBe(before.persistentId);
    expect(after.claims?.provider).toBe("wallet");

    const me = UserMeResponseSchema.parse(
      await (await c.call("/users/@me")).json(),
    );
    expect(me.user.wallet?.address).toBe(w.address);
    // The refresh cookie was replaced and still works.
    expect((await c.refresh()).status).toBe(200);
  });

  it("switches another device to the wallet's account", async () => {
    const w = wallet();
    const a = new Client();
    await a.refresh();
    await signIn(a, w);
    const b = new Client();
    await b.refresh();
    await signIn(b, w);
    const ida = await verifyClientToken(a.jwt!);
    const idb = await verifyClientToken(b.jwt!);
    expect(ida.type === "success" && idb.type === "success").toBe(true);
    if (ida.type === "success" && idb.type === "success") {
      expect(idb.persistentId).toBe(ida.persistentId);
    }
  });

  it("refuses a signature from another key, and a replayed challenge", async () => {
    const c = new Client();
    await c.refresh();
    const w = wallet();
    const other = wallet();
    const challenge = await c.post("/auth/wallet/challenge", {
      address: w.address,
    });
    const { message } = (await challenge.json()) as { message: string };
    expect(message).toContain("localhost:9000 wants you to sign in");
    expect(message).toContain("with your Solana account:");
    expect(message).toContain("Chain ID: mainnet");
    const bad = await c.post("/auth/wallet/verify", {
      message,
      signature: other.sign(message),
    });
    expect(bad.status).toBe(401);
    // The challenge was consumed by the failed attempt.
    const replay = await c.post("/auth/wallet/verify", {
      message,
      signature: w.sign(message),
    });
    expect(replay.status).toBe(400);
  });

  it("refuses a message edited after it was issued", async () => {
    const c = new Client();
    await c.refresh();
    const w = wallet();
    const challenge = await c.post("/auth/wallet/challenge", {
      address: w.address,
    });
    const { message } = (await challenge.json()) as { message: string };
    const edited = message.replace("localhost:9000", "evil.example");
    const res = await c.post("/auth/wallet/verify", {
      message: edited,
      signature: w.sign(edited),
    });
    expect(res.status).toBe(400);
  });
});

function record(
  gameID: string,
  gameType: GameType,
  persistentID: string | null,
) {
  const players: PlayerRecord[] = [
    {
      clientID: "Pl000001",
      username: "alice",
      clanTag: null,
      persistentID,
      stats: undefined,
    } as unknown as PlayerRecord,
  ];
  const partial = createPartialGameRecord(
    gameID,
    testGameConfig({ gameType }),
    players,
    [],
    1_700_000_000_000,
    1_700_000_060_000,
    ["player", "Pl000001"],
  );
  return GameRecordSchema.parse({ ...partial, gitCommit: "DEV" });
}

describe("game archive", () => {
  it("stores a server record once and serves it scrubbed", async () => {
    const owner = store.createUser();
    const rec = record("GameAAA1", GameType.Public, owner.id);
    const post = (body: unknown, key = API_KEY) =>
      fetch(`${base}/game/GameAAA1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
      });
    expect((await post(rec, "wrong")).status).toBe(403);
    expect((await post(rec)).status).toBe(201);
    expect((await post(rec)).status).toBe(409);
    expect(store.countGames(owner.id)).toEqual({ played: 1, won: 1 });

    const read = await fetch(`${base}/game/GameAAA1`);
    expect(read.status).toBe(200);
    const served = GameRecordSchema.parse(await read.json());
    expect(served.info.players[0].persistentID).toBeNull();
    expect(served.info.gameID).toBe("GameAAA1");
  });

  it("archives a client's own singleplayer game from gzip", async () => {
    const c = new Client();
    await c.refresh();
    const me = await verifyClientToken(c.jwt!);
    if (me.type !== "success") throw new Error("no session");
    const send = (body: unknown) =>
      c.call("/archive_singleplayer_game", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: gzipSync(JSON.stringify(body)),
      });
    // Somebody else's game is refused.
    const foreign = record(
      "SoloBBB1",
      GameType.Singleplayer,
      crypto.randomUUID(),
    );
    expect((await send(foreign)).status).toBe(403);
    const own = record("SoloBBB2", GameType.Singleplayer, me.persistentId);
    expect((await send(own)).status).toBe(201);
    expect((await fetch(`${base}/game/SoloBBB2?turns=false`)).status).toBe(200);
  });
});

describe("join_verify and static", () => {
  const verify = (token: string | null) =>
    fetch(`${base}/join_verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        ip: "1.2.3.4",
        token,
        username: "alice",
        clanTag: "X",
      }),
    }).then((r) => r.json());

  it("approves a passing Turnstile token and drops clan tags", async () => {
    expect(await verify("tok")).toEqual({
      status: "approved",
      username: "alice",
      clanTag: null,
    });
  });

  it("rejects a failing Turnstile token", async () => {
    siteverify = { success: false };
    expect((await verify("tok")).status).toBe("rejected");
  });

  it("serves the JWKS shape the game server requires", async () => {
    const body = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    expect(body.keys[0]).toMatchObject({
      alg: "EdDSA",
      crv: "Ed25519",
      kty: "OKP",
    });
    expect(body.keys[0].d).toBeUndefined();
  });

  it("answers the client's boot requests", async () => {
    expect((await fetch(`${base}/cluster.json?site=x`)).status).toBe(404);
    const cos = await (await fetch(`${base}/cosmetics.json`)).json();
    expect(cos).toEqual({ patterns: {}, flags: {} });
    const streams = await (await fetch(`${base}/streams.json`)).json();
    expect(streams.featured).toEqual([]);
  });

  it("gives the game server empty clan tags and tribes", async () => {
    const h = { "x-api-key": API_KEY, "Content-Type": "application/json" };
    const tags = await fetch(`${base}/reserved_clan_tags`, { headers: h });
    expect(await tags.json()).toEqual([]);
    const tribes = await fetch(`${base}/custom_tribes`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ players: [] }),
    });
    expect(await tribes.json()).toEqual({ tribes: [] });
    expect((await fetch(`${base}/reserved_clan_tags`)).status).toBe(403);
  });
});

describe("config", () => {
  it("refuses to start without DOMAIN, and outside dev without secrets", () => {
    expect(() => loadApiConfig({})).toThrow(/DOMAIN/);
    expect(() => loadApiConfig({ DOMAIN: "landpot.fun" })).toThrow();
  });

  it("takes the pot whole or not at all", () => {
    const keypair = (n: number) => JSON.stringify(Array(64).fill(n));
    const pot = {
      LANDPOT_POT_RPC_URL: "https://api.devnet.solana.com",
      LANDPOT_POT_CLUSTER: "devnet",
      LANDPOT_POT_PROGRAM: "4cbs4ZSsC9E9S56QwoAxPKDPDjRbfWzoUso3R8NWq165",
      LANDPOT_POT_ORACLE_KEY: keypair(1),
      LANDPOT_POT_OPERATOR_KEY: keypair(2),
      LANDPOT_POT_STAKE: "10",
    };
    const load = (extra: Record<string, string>) =>
      loadApiConfig({ DOMAIN: "localhost", ...extra });
    expect(load({}).pot).toBeNull();
    expect(load(pot).pot).toMatchObject({
      cluster: "devnet",
      stakeTokens: 10n,
      minPlayers: 8,
      maxPlayers: 16,
      fundingSeconds: 20 * 60,
    });
    // Half a pot is a mistake, not "off".
    const noOperator: Record<string, string> = { ...pot };
    delete noOperator.LANDPOT_POT_OPERATOR_KEY;
    expect(() => load(noOperator)).toThrow(/LANDPOT_POT_OPERATOR_KEY/);
    expect(() => load({ ...pot, LANDPOT_POT_STAKE: "1.5" })).toThrow(
      /whole number/,
    );
    expect(() => load({ ...pot, LANDPOT_POT_ORACLE_KEY: "[1,2]" })).toThrow(
      /keypair/,
    );
    expect(() => load({ ...pot, LANDPOT_POT_PROGRAM: "0x12" })).toThrow(
      /program id/,
    );
    expect(() => load({ ...pot, LANDPOT_POT_CLUSTER: "base" })).toThrow(
      /CLUSTER/,
    );
  });
});
