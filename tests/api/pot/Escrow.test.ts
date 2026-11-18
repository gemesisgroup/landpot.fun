import { GameType } from "@openfront/engine-api/game/GameTypes";
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import {
  GameRecordSchema,
  type PlayerRecord,
} from "@openfront/shared/WireSchemas";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import {
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ARTIFACT,
  compileContracts,
  escrowArtifactJson,
} from "../../../scripts/landpot/compileContracts";
import { deployLandpot } from "../../../scripts/landpot/deploy";
import { loadApiConfig } from "../../../src/api/ApiEnv";
import { createApp, publicRecordJson } from "../../../src/api/App";
import { RoundPhase, viemEscrowChain } from "../../../src/api/pot/EscrowChain";
import { resultDigest, roundIdOf } from "../../../src/api/pot/Oracle";
import { PotService } from "../../../src/api/pot/PotService";
import type { Replayer } from "../../../src/api/pot/Settlement";
import { SqliteStore } from "../../../src/api/Store";
import { loadSigningKeys } from "../../../src/api/Tokens";
import { testGameConfig } from "../../util/Wire";

/**
 * The pot end to end against the real contract on a local anvil chain:
 * archive → POST /pot/settle (our payouts + oracle signature) → propose on
 * chain → review hold → finalize → claims under the daily cap; plus the
 * refund paths. Skipped where anvil is not installed.
 */

function findAnvil(): string | null {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const candidates = [
    process.env.ANVIL_PATH,
    path.join(os.homedir(), ".foundry", "bin", exe),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const ANVIL = findAnvil();
const MNEMONIC = "test test test test test test test test test test test junk";
const API_KEY = "test-api-key";
const DAY = 86_400n;
const STAKE = 20n;
const DAILY_CAP = 60n;

describe("compiled artifact", () => {
  it("matches contracts/LandpotEscrow.sol (run npm run contracts:build)", () => {
    expect(readFileSync(ARTIFACT, "utf8")).toBe(escrowArtifactJson());
  }, 60_000);
});

describe.skipIf(ANVIL === null)("LandpotEscrow on anvil", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let chain: Chain;
  let pub: ReturnType<typeof createPublicClient>;
  let testClient: ReturnType<typeof createTestClient>;
  let tokenAbi: Abi;
  let token: Address;
  let escrow: Address;
  let server: Server;
  let base: string;
  let store: SqliteStore;
  let territory: Record<string, number> = {};

  const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
  const guardian = acct(0);
  const treasury = acct(1);
  const players = [2, 3, 4, 5, 6, 7, 8, 9].map(acct);
  const stranger = acct(10);
  const operator = acct(11);
  const operatorKey = toHex(operator.getHdKey().privateKey!);
  let pot: PotService;
  const oracleKey = generatePrivateKey();
  const oracle = privateKeyToAccount(oracleKey);

  const walletOf = (account: ReturnType<typeof acct>) =>
    createWalletClient({ account, chain, transport: http(rpc) });
  const escrowAbi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi as Abi;

  async function send(
    account: ReturnType<typeof acct>,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) {
    const { request } = await pub.simulateContract({
      address,
      abi,
      functionName,
      args,
      account,
    });
    const hash = await walletOf(account).writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }
  const call = <T>(
    address: Address,
    abi: Abi,
    fn: string,
    args: unknown[] = [],
  ) => pub.readContract({ address, abi, functionName: fn, args }) as Promise<T>;
  const balanceOf = (a: Address) =>
    call<bigint>(token, tokenAbi, "balanceOf", [a]);
  const now = async () => (await pub.getBlock()).timestamp;
  const warp = async (seconds: bigint) => {
    await testClient.increaseTime({ seconds: Number(seconds) });
    await testClient.mine({ blocks: 1 });
  };

  /** open → every player deposits → (optionally) start. */
  async function fundRound(gameID: string, start: boolean) {
    const roundId = roundIdOf(gameID);
    const t = await now();
    await send(operator, escrow, escrowAbi, "open", [
      roundId,
      STAKE,
      8,
      16,
      t + 3600n,
      t + 7200n,
    ]);
    for (const p of players) {
      await send(p, escrow, escrowAbi, "deposit", [roundId]);
    }
    if (start) await send(operator, escrow, escrowAbi, "start", [roundId]);
    return roundId;
  }

  /** Archive a finished paid game the way the game server does. */
  /** `present`: how many depositors were in the match when it started. */
  async function archive(gameID: string, present = players.length) {
    const records: PlayerRecord[] = players.slice(0, present).map(
      (p, i) =>
        ({
          clientID: `Pl00000${i}`,
          username: `player${i}`,
          clanTag: null,
          persistentID: userIds.get(p.address)!,
          stats: undefined,
        }) as unknown as PlayerRecord,
    );
    const partial = createPartialGameRecord(
      gameID,
      testGameConfig({ gameType: GameType.Public }),
      records,
      [],
      1_700_000_000_000,
      1_700_000_060_000,
      ["player", "Pl000000"],
    );
    const record = GameRecordSchema.parse({ ...partial, gitCommit: "DEV" });
    const res = await fetch(`${base}/game/${gameID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(201);
  }

  const settle = async (gameID: string) => {
    const res = await fetch(`${base}/pot/settle/${gameID}`, {
      method: "POST",
      headers: { "x-api-key": API_KEY },
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const userIds = new Map<Address, string>();

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    anvil = spawn(
      ANVIL!,
      ["--port", String(port), "--silent", "--accounts", "12"],
      {
        stdio: "ignore",
      },
    );
    rpc = `http://127.0.0.1:${port}`;
    chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    };
    pub = createPublicClient({ chain, transport: http(rpc) });
    testClient = createTestClient({
      chain,
      mode: "anvil",
      transport: http(rpc),
    });
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch (e) {
        if (i > 100) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    tokenAbi = compileContracts().LandpotToken.abi as Abi;
    // The real deploy script, as it would run against Base.
    ({ token, escrow } = await deployLandpot({
      chain,
      rpcUrl: rpc,
      deployerKey: toHex(guardian.getHdKey().privateKey!),
      token: {
        name: "Landpot Test",
        symbol: "LTEST",
        supply: 10n ** 24n,
        holder: guardian.address,
      },
      guardian: guardian.address,
      operator: operator.address,
      oracle: oracle.address,
      treasury: treasury.address,
      burnBps: 200,
      treasuryBps: 300,
      reviewDelaySeconds: DAY,
      maxBank: 10n ** 22n,
      dailyCap: DAILY_CAP,
    }));
    await testClient.setBalance({
      address: oracle.address,
      value: 10n ** 20n,
    });
    for (const p of players) {
      await send(guardian, token, tokenAbi, "transfer", [
        p.address,
        10n ** 20n,
      ]);
      await send(p, token, tokenAbi, "approve", [escrow, 10n ** 20n]);
    }

    // The API, wired to this chain; the replay is faked so each test sets
    // the land it wants (the real replay is covered in tests/core).
    store = new SqliteStore(":memory:");
    for (const p of players) {
      const u = store.createUser();
      store.setWallet(u.id, p.address);
      userIds.set(p.address, u.id);
    }
    const replay: Replayer = async (record) => ({
      winner: ["player", record.info.players[0].clientID],
      allPlayersStats: {},
      tick: 100,
      territory,
    });
    pot = new PotService({
      chain: viemEscrowChain({
        rpcUrl: rpc,
        chainId: 31337,
        escrow,
        senderKey: operatorKey,
      }),
      store,
      oracleKey,
      replay,
      rules: {
        stakeTokens: 1n,
        minPlayers: 8,
        maxPlayers: 16,
        fundingSeconds: 3600,
      },
      archived: (id) => {
        const blob = store.getGameRecord(id);
        return blob
          ? {
              publicBytes: new TextEncoder().encode(publicRecordJson(blob)),
              full: JSON.parse(gunzipSync(blob).toString("utf8")),
            }
          : null;
      },
    });
    const config = loadApiConfig({
      DOMAIN: "localhost",
      API_KEY,
      LANDPOT_DATA_DIR: ".data/test-api",
      LANDPOT_POT_RPC_URL: rpc,
      LANDPOT_POT_CHAIN_ID: "31337",
      LANDPOT_POT_ESCROW: escrow,
      LANDPOT_POT_ORACLE_KEY: oracleKey,
      LANDPOT_POT_OPERATOR_KEY: operatorKey,
      LANDPOT_POT_STAKE: "1",
    } as NodeJS.ProcessEnv);
    const keys = await loadSigningKeys({ ...config, jwtKey: null });
    let clock = Date.now();
    const app = createApp({
      config,
      store,
      keys,
      pot,
      now: () => clock,
    });
    // finalize compares against chain time; keep the API clock in step.
    advanceClock = async () => {
      clock = Number(await now()) * 1000;
    };
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);
  let advanceClock: () => Promise<void> = async () => {};

  afterAll(() => {
    server?.close();
    store?.close();
    anvil?.kill();
  });

  it("settles by land, holds for review, then pays claims under the daily cap", async () => {
    const gameID = "PaidGam1";
    const roundId = await fundRound(gameID, true);
    await archive(gameID);
    territory = {
      Pl000000: 100,
      Pl000001: 50,
      Pl000002: 30,
      Pl000003: 20,
      // The other four held nothing at the end.
    };

    const { status, body } = await settle(gameID);
    expect(status).toBe(200);
    expect(body.reason).toBeUndefined();
    expect(body.status).toBe("proposed");
    // 160 in, 3 burned, 4 to the treasury, 153 split 77/38/23/15 (see Payouts.test).
    expect(body.amounts).toEqual(["77", "38", "23", "15", "0", "0", "0", "0"]);

    // The hash commits to exactly what /game/:id serves.
    const served = await (await fetch(`${base}/game/${gameID}`)).text();
    expect(body.replayHash).toBe(keccak256(toBytes(served)));
    // Our digest is the contract's, so the oracle signature means the same thing.
    expect(
      await call<Hex>(escrow, escrowAbi, "digest", [
        roundId,
        body.amounts.map(BigInt),
        body.replayHash,
      ]),
    ).toBe(
      resultDigest({
        chainId: 31337n,
        escrow,
        roundId,
        players: players.map((p) => p.address),
        amounts: body.amounts.map(BigInt),
        replayHash: body.replayHash,
      }),
    );
    const s = await call<[number, boolean, bigint, bigint, bigint]>(
      escrow,
      escrowAbi,
      "status",
      [roundId],
    );
    expect(s[0]).toBe(RoundPhase.Proposed);

    // A second settle does nothing, and the public record shows the result.
    expect((await settle(gameID)).body.status).toBe("skipped");
    const pubRow = await (await fetch(`${base}/public/pot/${gameID}`)).json();
    expect(pubRow).toMatchObject({ status: "proposed", roundId });

    // Not before the review hold ends.
    const finalize = () =>
      fetch(`${base}/pot/finalize/${gameID}`, {
        method: "POST",
        headers: { "x-api-key": API_KEY },
      }).then((r) => r.json());
    await advanceClock();
    expect((await finalize()).finalized).toBe(false);
    await warp(DAY + 1n);
    await advanceClock();
    expect((await finalize()).finalized).toBe(true);
    expect(await balanceOf(treasury.address)).toBe(4n);
    // The burn share goes to the dead address, so any ERC-20 works.
    expect(await balanceOf("0x000000000000000000000000000000000000dEaD")).toBe(
      3n,
    );
    expect(await balanceOf(escrow)).toBe(153n);

    // Claims: the top player is capped at 60 a day, the rest comes tomorrow.
    const before = await balanceOf(players[0].address);
    await send(players[0], escrow, escrowAbi, "claim", [roundId]);
    expect((await balanceOf(players[0].address)) - before).toBe(DAILY_CAP);
    await expect(
      send(players[0], escrow, escrowAbi, "claim", [roundId]),
    ).rejects.toThrow();
    await warp(DAY);
    await send(players[0], escrow, escrowAbi, "claim", [roundId]);
    expect((await balanceOf(players[0].address)) - before).toBe(77n);
    for (const i of [1, 2, 3]) {
      await send(players[i], escrow, escrowAbi, "claim", [roundId]);
    }
    // A player who held no land has nothing to claim.
    await expect(
      send(players[4], escrow, escrowAbi, "claim", [roundId]),
    ).rejects.toThrow();
    expect(await balanceOf(escrow)).toBe(0n);
  }, 120_000);

  it("refunds every entry when a round never starts", async () => {
    const gameID = "PaidGam2";
    const roundId = await fundRound(gameID, false);
    const before = await balanceOf(players[5].address);
    await expect(
      send(stranger, escrow, escrowAbi, "cancel", [roundId]),
    ).rejects.toThrow();
    await warp(3601n);
    await send(stranger, escrow, escrowAbi, "cancel", [roundId]);
    await send(players[5], escrow, escrowAbi, "claim", [roundId]);
    expect((await balanceOf(players[5].address)) - before).toBe(STAKE);
  }, 120_000);

  it("lets only the operator open and start, and close an unfilled lobby", async () => {
    const roundId = roundIdOf("PaidGam6");
    const t = await now();
    const args = [roundId, STAKE, 8, 16, t + 3600n, t + 7200n];
    // The guardian is the cold key: it reviews and cancels, it does not run lobbies.
    await expect(
      send(guardian, escrow, escrowAbi, "open", args),
    ).rejects.toThrow();
    await send(operator, escrow, escrowAbi, "open", args);
    await send(players[0], escrow, escrowAbi, "deposit", [roundId]);
    await expect(
      send(operator, escrow, escrowAbi, "start", [roundId]),
    ).rejects.toThrow(); // one depositor, eight needed
    // The operator can refund a lobby that will not fill, before funding ends.
    await expect(
      send(stranger, escrow, escrowAbi, "cancel", [roundId]),
    ).rejects.toThrow();
    await send(operator, escrow, escrowAbi, "cancel", [roundId]);
    const before = await balanceOf(players[0].address);
    await send(players[0], escrow, escrowAbi, "claim", [roundId]);
    expect((await balanceOf(players[0].address)) - before).toBe(STAKE);
  }, 120_000);

  it("voids a match where nobody held land", async () => {
    const gameID = "PaidGam3";
    await fundRound(gameID, true);
    await archive(gameID);
    territory = {};
    const { body } = await settle(gameID);
    expect(body.status).toBe("void");
    const row = await (await fetch(`${base}/public/pot/${gameID}`)).json();
    expect(row.status).toBe("void");
  }, 120_000);

  it("lets anyone refund a result the guardian froze and abandoned", async () => {
    const gameID = "PaidGam4";
    const roundId = await fundRound(gameID, true);
    await archive(gameID);
    territory = { Pl000000: 1 };
    expect((await settle(gameID)).body.status).toBe("proposed");
    await send(guardian, escrow, escrowAbi, "review", [roundId, true]);

    // Frozen: no finalize, and no public cancel during the next review period.
    await warp(DAY + 1n);
    await expect(
      send(stranger, escrow, escrowAbi, "finalize", [roundId]),
    ).rejects.toThrow();
    await expect(
      send(stranger, escrow, escrowAbi, "cancel", [roundId]),
    ).rejects.toThrow();
    // One more review period later, anyone can refund it.
    await warp(DAY);
    await send(stranger, escrow, escrowAbi, "cancel", [roundId]);
    const before = await balanceOf(players[7].address);
    await send(players[7], escrow, escrowAbi, "claim", [roundId]);
    expect((await balanceOf(players[7].address)) - before).toBe(STAKE);
  }, 120_000);

  it("refuses a result signed by anyone but the oracle", async () => {
    const gameID = "PaidGam5";
    const roundId = await fundRound(gameID, true);
    const amounts = [153n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
    const replayHash = keccak256(toBytes("x"));
    const digest = await call<Hex>(escrow, escrowAbi, "digest", [
      roundId,
      amounts,
      replayHash,
    ]);
    const { signDigest } = await import("../../../src/api/pot/Oracle");
    const forged = await signDigest(generatePrivateKey(), digest);
    await expect(
      send(stranger, escrow, escrowAbi, "propose", [
        roundId,
        amounts,
        replayHash,
        forged.v,
        forged.r,
        forged.s,
      ]),
    ).rejects.toThrow();
    // The same amounts signed by the oracle go through.
    const real = await signDigest(oracleKey, digest);
    await send(stranger, escrow, escrowAbi, "propose", [
      roundId,
      amounts,
      replayHash,
      real.v,
      real.r,
      real.s,
    ]);
  }, 120_000);

  it("refunds depositors who missed the start, less fees", async () => {
    const gameID = "PaidGamA";
    await fundRound(gameID, true);
    await archive(gameID, 6);
    territory = { Pl000000: 100, Pl000001: 50, Pl000002: 30, Pl000003: 20 };
    const { status, body } = await settle(gameID);
    expect(status).toBe(200);
    expect(body.status).toBe("proposed");
    const amounts = (body.amounts as string[]).map(BigInt);
    // 153 net: the two absent get floor(153/8) = 19 each, the six who
    // played split 115 by land (see Payouts.test).
    expect(amounts.slice(6)).toEqual([19n, 19n]);
    expect(amounts[1]).toBe(29n);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(153n);
  }, 120_000);

  describe("paid lobbies through the API", () => {
    const api = async (
      method: "GET" | "POST",
      route: string,
      body?: unknown,
    ) => {
      const res = await fetch(
        `${base}${route}`,
        body === undefined
          ? { method, headers: { "x-api-key": API_KEY } }
          : {
              method,
              headers: {
                "x-api-key": API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    const seat = async (gameID: string, persistentID: string) =>
      (await api("POST", `/pot/seat/${gameID}`, { persistentID })).body.seated;

    it("opens, seats only depositors, starts, settles, finalizes and pays", async () => {
      const gameID = "PaidGam7";
      const config = (await api("GET", "/public/pot/config")).body;
      expect(config).toMatchObject({
        enabled: true,
        chainId: 31337,
        token: { address: getAddress(token), symbol: "LTEST", decimals: 18 },
        stake: (10n ** 18n).toString(),
        minPlayers: 8,
        maxPlayers: 16,
      });

      const opened = await api("POST", `/pot/open/${gameID}`);
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({ state: "funding" });
      // Opening twice is the same round.
      expect((await api("POST", `/pot/open/${gameID}`)).body).toEqual(
        opened.body,
      );
      const roundId = roundIdOf(gameID);
      const p0 = userIds.get(players[0].address)!;
      expect(await seat(gameID, p0)).toBe(false);

      for (const p of players.slice(0, 7)) {
        await send(p, escrow, escrowAbi, "deposit", [roundId]);
      }
      expect(await seat(gameID, p0)).toBe(true);
      // Seven of eight: start refuses, and the lobby shows who is in.
      expect((await api("POST", `/pot/start/${gameID}`)).status).toBe(409);
      const lobby = (await api("GET", `/pot/lobby/${gameID}`)).body;
      expect(lobby).toMatchObject({ deposited: 7, phase: RoundPhase.Funding });
      expect(lobby.depositors).toHaveLength(7);
      const listed = await (
        await fetch(
          `${base}/public/pot/lobbies?wallet=${players[0].address.toLowerCase()}`,
        )
      ).json();
      expect(listed.lobbies).toContainEqual(
        expect.objectContaining({ gameId: gameID, deposited: 7, joined: true }),
      );

      await send(players[7], escrow, escrowAbi, "deposit", [roundId]);
      // An account without a wallet, or a wallet that did not pay, never sits.
      expect(await seat(gameID, store.createUser().id)).toBe(false);
      const started = await api("POST", `/pot/start/${gameID}`);
      expect(started.status).toBe(200);
      expect([...started.body.depositors].sort()).toEqual(
        players.map((p) => userIds.get(p.address)!).sort(),
      );
      // Deposits are closed now.
      await expect(
        send(stranger, escrow, escrowAbi, "deposit", [roundId]),
      ).rejects.toThrow();

      // The keeper settles once the record is archived...
      territory = { Pl000000: 3, Pl000001: 1 };
      await archive(gameID);
      await pot.tick();
      expect(store.getSettlement(gameID)?.status).toBe("proposed");
      const pending = await (
        await fetch(`${base}/public/pot/claims/${players[0].address}`)
      ).json();
      expect(pending.claims).toEqual([
        expect.objectContaining({
          gameId: gameID,
          kind: "winnings",
          phase: RoundPhase.Proposed,
        }),
      ]);
      // ...and finalizes after the review hold.
      await warp(DAY + 1n);
      await pot.tick();
      expect(store.getSettlement(gameID)?.status).toBe("finalized");
      expect(store.getRound(gameID)?.state).toBe("closed");
      // 8 × 1 token: 7.6 net, split 3:1.
      const net = (8n * 10n ** 18n * 95n) / 100n;
      const ready = await (
        await fetch(`${base}/public/pot/claims/${players[1].address}`)
      ).json();
      expect(ready.claims).toEqual([
        expect.objectContaining({
          kind: "winnings",
          phase: RoundPhase.Final,
          amount: (net / 4n).toString(),
        }),
      ]);
    }, 120_000);

    it("refunds a lobby the game server closes, and one nobody started", async () => {
      const closed = "PaidGam8";
      await api("POST", `/pot/open/${closed}`);
      await send(players[2], escrow, escrowAbi, "deposit", [roundIdOf(closed)]);
      // Decided on a count that is already stale: look again.
      expect(
        (await api("POST", `/pot/cancel/${closed}`, { deposited: 0 })).status,
      ).toBe(409);
      expect(
        (await api("POST", `/pot/cancel/${closed}`, { deposited: 1 })).status,
      ).toBe(200);
      expect(store.getRound(closed)?.state).toBe("cancelled");

      const expired = "PaidGam9";
      await api("POST", `/pot/open/${expired}`);
      await send(players[2], escrow, escrowAbi, "deposit", [
        roundIdOf(expired),
      ]);
      await pot.tick();
      expect(store.getRound(expired)?.state).toBe("funding");
      await warp(3601n);
      await pot.tick();
      expect(store.getRound(expired)?.state).toBe("cancelled");

      const claims = await (
        await fetch(`${base}/public/pot/claims/${players[2].address}`)
      ).json();
      const refunds = claims.claims.filter(
        (c: { kind: string }) => c.kind === "refund",
      );
      expect(refunds.map((c: { gameId: string }) => c.gameId).sort()).toEqual([
        closed,
        expired,
      ]);
      expect(refunds[0].amount).toBe((10n ** 18n).toString());
    }, 120_000);
  });
});
