import { GameType } from "@openfront/engine-api/game/GameTypes";
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import {
  GameRecordSchema,
  type PlayerRecord,
} from "@openfront/shared/WireSchemas";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, Transaction, type PublicKey } from "@solana/web3.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  fund,
  PROGRAM_ID,
  startValidator,
  validatorAvailable,
  type TestValidator,
} from "../../../scripts/landpot/solanaLocal";
import { loadApiConfig } from "../../../src/api/ApiEnv";
import { createApp, publicRecordJson } from "../../../src/api/App";
import { RoundPhase } from "../../../src/api/pot/EscrowChain";
import { PotService } from "../../../src/api/pot/PotService";
import { keccakHex, roundIdOf } from "../../../src/api/pot/RoundId";
import type { Replayer } from "../../../src/api/pot/Settlement";
import {
  initializeEscrow,
  SolanaEscrow,
} from "../../../src/api/pot/SolanaEscrow";
import { SqliteStore } from "../../../src/api/Store";
import { loadSigningKeys } from "../../../src/api/Tokens";
import { paidGameConfig } from "../../../src/server/PaidLobby";
import { testGameConfig } from "../../util/Wire";

/**
 * The pot end to end on a local validator with the escrow program: the game
 * server's lobby calls, deposits signed from the API's unsigned
 * transactions, archive → settle (our split, co-signed by the oracle) →
 * review hold → finalize → claims under the daily cap, and the refund
 * paths. The program's own rules are covered in SolanaEscrow.test.ts.
 */

const API_KEY = "test-api-key";
const UNIT = 1_000_000n;
const STAKE_TOKENS = 20n;
const STAKE = STAKE_TOKENS * UNIT;
const DAILY_CAP = 60n * UNIT;
// The localnet build's review hold.
const REVIEW_SECONDS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!validatorAvailable())(
  "paid matches on a local validator",
  () => {
    let v: TestValidator;
    let mint: PublicKey;
    let chain: SolanaEscrow;
    let pot: PotService;
    let store: SqliteStore;
    let server: Server;
    let base: string;
    let territory: Record<string, number> = {};
    // A test may replace the faked replay's result (a tie, say).
    let replayResult: Awaited<ReturnType<Replayer>> | null = null;
    const guardian = Keypair.generate();
    const operator = Keypair.generate();
    const oracle = Keypair.generate();
    const treasury = Keypair.generate();
    const players = Array.from({ length: 8 }, () => Keypair.generate());
    const userIds = new Map<string, string>();
    const addr = (k: Keypair) => k.publicKey.toBase58();

    async function balance(owner: PublicKey): Promise<bigint> {
      const ata = getAssociatedTokenAddressSync(
        mint,
        owner,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      try {
        return (
          await getAccount(
            v.connection,
            ata,
            "confirmed",
            TOKEN_2022_PROGRAM_ID,
          )
        ).amount;
      } catch {
        return 0n;
      }
    }

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
              method: "POST",
              headers: {
                "x-api-key": API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
      );
      return { status: res.status, body: (await res.json()) as any };
    };

    /** What the browser does: get the unsigned transaction, sign, send. */
    async function walletSends(
      kind: "deposit" | "claim",
      gameId: string,
      who: Keypair,
    ): Promise<void> {
      const { status, body } = await api("POST", `/public/pot/${kind}-tx`, {
        gameId,
        wallet: addr(who),
      });
      if (status !== 200)
        throw new Error(`${kind}-tx ${status}: ${body.error ?? ""}`);
      const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
      tx.partialSign(who);
      const sig = await v.connection.sendRawTransaction(tx.serialize());
      for (let i = 0; i < 240; i++) {
        const s = (await api("GET", `/public/pot/tx/${sig}`)).body.status;
        if (s === "confirmed") return;
        if (s === "failed") throw new Error(`${kind} failed`);
        await sleep(250);
      }
      throw new Error(`${kind} not confirmed`);
    }

    /** Open through the game server's route, then every player deposits. */
    async function fundRound(gameID: string, start: boolean) {
      expect((await api("POST", `/pot/open/${gameID}`)).status).toBe(200);
      for (const p of players) await walletSends("deposit", gameID, p);
      if (start)
        expect((await api("POST", `/pot/start/${gameID}`)).status).toBe(200);
    }

    /** Archive a finished paid game the way the game server does. */
    async function archive(gameID: string, present = players.length) {
      const cup = store.getRound(gameID)?.cup;
      const pairs = store.cupPairs(gameID);
      const records: PlayerRecord[] = players.slice(0, present).map(
        (p, i) =>
          ({
            clientID: `Pl00000${i}`,
            username: `player${i}`,
            ...(cup
              ? { teamIndex: pairs.findIndex((pair) => pair.includes(addr(p))) }
              : {}),
            clanTag: null,
            persistentID: userIds.get(addr(p))!,
            stats: undefined,
          }) as unknown as PlayerRecord,
      );
      const partial = createPartialGameRecord(
        gameID,
        cup
          ? paidGameConfig(testGameConfig(), 8, true)
          : testGameConfig({ gameType: GameType.Public }),
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

    beforeAll(async () => {
      v = await startValidator(18999);
      const { connection } = v;
      for (const k of [guardian, operator, treasury, ...players]) {
        await fund(connection, k.publicKey, 10);
      }
      mint = await createMint(
        connection,
        v.authority,
        v.authority.publicKey,
        null,
        6,
        undefined,
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID,
      );
      for (const p of players) {
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          v.authority,
          mint,
          p.publicKey,
          false,
          "confirmed",
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        await mintTo(
          connection,
          v.authority,
          mint,
          ata.address,
          v.authority,
          STAKE * 20n,
          [],
          { commitment: "confirmed" },
          TOKEN_2022_PROGRAM_ID,
        );
      }
      await initializeEscrow(connection, PROGRAM_ID, v.authority, mint, {
        guardian: guardian.publicKey,
        operator: operator.publicKey,
        oracle: oracle.publicKey,
        treasury: treasury.publicKey,
        burnBps: 200,
        treasuryBps: 300,
        reviewDelay: REVIEW_SECONDS,
        maxBank: 10_000_000n * UNIT,
        dailyCap: DAILY_CAP,
      });

      // The API, wired to this validator; the replay is faked so each test
      // sets the land it wants (the real replay is covered in tests/core).
      store = new SqliteStore(":memory:");
      for (const p of players) {
        const u = store.createUser();
        store.setWallet(u.id, addr(p));
        userIds.set(addr(p), u.id);
      }
      const replay: Replayer = async (record) =>
        replayResult ?? {
          winner: record.info.config.caldera?.teamCup
            ? ["team", "Red", "Pl000004", "Pl000005"]
            : ["player", record.info.players[0].clientID],
          allPlayersStats: {},
          tick: 100,
          territory,
        };
      chain = new SolanaEscrow({
        connection,
        programId: PROGRAM_ID,
        operator,
        oracle,
        cluster: "localnet",
      });
      pot = new PotService({
        chain,
        store,
        replay,
        rules: {
          stakeTokens: STAKE_TOKENS,
          minPlayers: 8,
          maxPlayers: 16,
          fundingSeconds: 60,
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
      const keypair = (k: Keypair) => JSON.stringify(Array.from(k.secretKey));
      const config = loadApiConfig({
        DOMAIN: "localhost",
        API_KEY,
        LANDPOT_DATA_DIR: ".data/test-api",
        LANDPOT_POT_RPC_URL: connection.rpcEndpoint,
        LANDPOT_POT_CLUSTER: "localnet",
        LANDPOT_POT_PROGRAM: PROGRAM_ID.toBase58(),
        LANDPOT_POT_ORACLE_KEY: keypair(oracle),
        LANDPOT_POT_OPERATOR_KEY: keypair(operator),
        LANDPOT_POT_STAKE: String(STAKE_TOKENS),
      } as NodeJS.ProcessEnv);
      const keys = await loadSigningKeys({ ...config, jwtKey: null });
      const app = createApp({ config, store, keys, pot });
      server = app.listen(0);
      await new Promise((r) => server.once("listening", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 240_000);

    afterAll(() => {
      server?.close();
      store?.close();
      v?.stop();
    });

    it("publishes what the client needs", async () => {
      expect((await api("GET", "/public/pot/config")).body).toEqual({
        enabled: true,
        cluster: "localnet",
        program: PROGRAM_ID.toBase58(),
        token: { address: mint.toBase58(), symbol: "LANDPOT", decimals: 6 },
        stake: STAKE.toString(),
        burnBps: 200,
        treasuryBps: 300,
        reviewDelay: REVIEW_SECONDS,
        minPlayers: 8,
        maxPlayers: 16,
      });
    });

    it("settles by land, holds for review, then pays claims under the daily cap", async () => {
      const gameID = "PaidGam1";
      const roundId = roundIdOf(gameID);
      await fundRound(gameID, true);
      await archive(gameID);
      territory = { Pl000000: 100, Pl000001: 50, Pl000002: 30, Pl000003: 20 };

      const { status, body } = await api("POST", `/pot/settle/${gameID}`);
      expect(status).toBe(200);
      expect(body.status).toBe("proposed");
      // 160 in, 3.2 burned, 4.8 to the treasury, 152 split by land.
      const net = 152n * UNIT;
      // 152 × 100/200, × 50/200, × 30/200, × 20/200: exact at 6 decimals.
      expect(body.amounts).toEqual([
        "76000000",
        "38000000",
        "22800000",
        "15200000",
        "0",
        "0",
        "0",
        "0",
      ]);
      expect(body.players).toEqual(players.map(addr));
      // The hash commits to exactly what /game/:id serves.
      const served = await (await fetch(`${base}/game/${gameID}`)).text();
      expect(body.replayHash).toBe(keccakHex(new TextEncoder().encode(served)));
      expect((await chain.status(roundId)).phase).toBe(RoundPhase.Proposed);
      // A second settle does nothing; the public record shows the result.
      expect((await api("POST", `/pot/settle/${gameID}`)).body.status).toBe(
        "skipped",
      );
      expect((await api("GET", `/public/pot/${gameID}`)).body).toMatchObject({
        status: "proposed",
        roundId,
      });

      // Not claimable while proposed; the claims list says when.
      const pending = (
        await api("GET", `/public/pot/claims/${addr(players[0])}`)
      ).body;
      expect(pending.claims).toEqual([
        expect.objectContaining({
          gameId: gameID,
          kind: "winnings",
          phase: RoundPhase.Proposed,
        }),
      ]);
      expect(
        (
          await api("POST", "/public/pot/claim-tx", {
            gameId: gameID,
            wallet: addr(players[0]),
          })
        ).status,
      ).toBe(409);

      await sleep((REVIEW_SECONDS + 1) * 1000);
      expect(
        (await api("POST", `/pot/finalize/${gameID}`)).body.finalized,
      ).toBe(true);
      expect(await balance(treasury.publicKey)).toBe((48n * UNIT) / 10n);

      // The top player is capped at 60 a day; the rest waits for tomorrow.
      const before = await balance(players[0].publicKey);
      await walletSends("claim", gameID, players[0]);
      expect((await balance(players[0].publicKey)) - before).toBe(DAILY_CAP);
      await expect(walletSends("claim", gameID, players[0])).rejects.toThrow();
      for (const i of [1, 2, 3]) await walletSends("claim", gameID, players[i]);
      // A player who held no land has nothing to claim.
      expect(
        (
          await api("POST", "/public/pot/claim-tx", {
            gameId: gameID,
            wallet: addr(players[4]),
          })
        ).status,
      ).toBe(409);
      const left = (await chain.status(roundId)).balance;
      expect(left).toBe(76n * UNIT - DAILY_CAP);
      expect(net).toBe(152n * UNIT);
    }, 180_000);

    it("locks reciprocal pairs before entry and pays both winning wallets after replay", async () => {
      const id = "CupGame1";
      const now = new Date();
      pot.rules.cupHourUTC = now.getUTCDay() * 24 + now.getUTCHours();
      try {
        expect((await api("POST", `/pot/open/${id}`)).body.cup).toBe(true);
      } finally {
        delete pot.rules.cupHourUTC;
      }
      for (let i = 0; i < players.length; i += 2) {
        const a = addr(players[i]),
          b = addr(players[i + 1]);
        pot.nominate(id, a, b);
        await expect(pot.depositTx(id, a)).rejects.toThrow("Confirm");
        pot.nominate(id, b, a);
        expect(() => pot.nominate(id, a, addr(players[(i + 2) % 8]))).toThrow();
        expect(
          (await pot.openLobbies(a)).find((l) => l.gameId === id)?.partner,
        ).toBe(b);
      }
      await fundRound(id, true);
      await archive(id);
      territory = { Pl000004: 0, Pl000005: 10, Pl000002: 1000 };
      const { body } = await api("POST", `/pot/settle/${id}`);
      expect(body.amounts).toEqual([
        "0",
        "0",
        "0",
        "0",
        "76000000",
        "76000000",
        "0",
        "0",
      ]);
      await sleep((REVIEW_SECONDS + 1) * 1000);
      expect((await api("POST", `/pot/finalize/${id}`)).body.finalized).toBe(
        true,
      );
      for (const wallet of players.slice(4, 6)) {
        const before = await balance(wallet.publicKey);
        await walletSends("claim", id, wallet);
        expect((await balance(wallet.publicKey)) - before).toBe(DAILY_CAP);
      }
      // Once paid out, the keeper closes the round's accounts; the playtest
      // metrics and rematch answers must still know who paid.
      const live = chain.players.bind(chain);
      chain.players = async () => [];
      onTestFinished(() => {
        chain.players = live;
      });
      await pot.rematch(id, addr(players[4]), true);
      expect(await pot.cupStats(id)).toMatchObject({
        pairs: 4,
        pairsPaid: 4,
        rematch: { yes: 1, no: 0 },
      });
    }, 180_000);

    /** A Cup lobby, opened on the host's request rather than the schedule. */
    async function openCup(id: string) {
      expect((await api("POST", "/pot/cup-next")).status).toBe(200);
      expect((await api("POST", `/pot/open/${id}`)).body.cup).toBe(true);
    }

    /** Players 0+1, 2+3, 4+5, 6+7 pair up through invite links. */
    function pairByInvites(id: string) {
      for (let i = 0; i < players.length; i += 2) {
        const a = addr(players[i]);
        const b = addr(players[i + 1]);
        const { token } = pot.invite(id, a);
        // Opening the link confirms nothing.
        expect(pot.inviteView(token, b).state).toBe("open");
        expect(store.cupPairs(id).some((p) => p.includes(b))).toBe(false);
        pot.acceptInvite(token, b);
      }
      expect(store.cupPairs(id)).toHaveLength(4);
    }

    it("pairs by invite link, with clear answers for self, taken and full", async () => {
      const id = "CupInv01";
      await openCup(id);
      const [a, b, c, d] = players.map(addr);
      const { token } = pot.invite(id, a);
      // The same wallet asking again gets the same link.
      expect(pot.invite(id, a).token).toBe(token);
      expect(pot.inviteView(token, a).state).toBe("self");
      expect(() => pot.acceptInvite(token, a)).toThrow("self");
      const view = pot.inviteView(token, b);
      expect(view).toMatchObject({
        gameId: id,
        inviter: a,
        stake: STAKE.toString(),
        burnBps: 200,
        treasuryBps: 300,
        state: "open",
      });
      pot.acceptInvite(token, b);
      expect(pot.inviteView(token, b).state).toBe("accepted");
      // Accepting twice is harmless; anyone else is told it's taken.
      pot.acceptInvite(token, b);
      expect(pot.inviteView(token, c).state).toBe("taken");
      expect(() => pot.acceptInvite(token, c)).toThrow("taken");
      // A paired wallet can't make a new link or join another pair.
      expect(() => pot.invite(id, b)).toThrow("Already in a pair");
      const other = pot.invite(id, c).token;
      expect(pot.inviteView(other, b).state).toBe("you_paired");
      expect(() => pot.acceptInvite(other, b)).toThrow("you_paired");
      // A new link from the same inviter replaces the old one.
      pot.acceptInvite(other, d);
      expect(store.cupPairs(id)).toHaveLength(2);
      const lobby = (await pot.openLobbies(a)).find((l) => l.gameId === id)!;
      expect(lobby).toMatchObject({
        partner: b,
        partnerPaid: false,
        pairs: 2,
        burnBps: 200,
        treasuryBps: 300,
      });
      await walletSends("deposit", id, players[1]);
      expect(
        (await pot.openLobbies(a)).find((l) => l.gameId === id)?.partnerPaid,
      ).toBe(true);
      // Once registration closes, the link says so.
      expect(
        (await api("POST", `/pot/cancel/${id}`, { deposited: 1 })).status,
      ).toBe(200);
      const late = pot.invite.bind(pot);
      expect(() => late(id, addr(players[4]))).toThrow("Registration closed");
      expect(pot.inviteView(other, d).state).toBe("accepted");
      expect(pot.inviteView(token, c).state).toBe("expired");
      await walletSends("claim", id, players[1]);
    }, 180_000);

    it("cancels a Cup when one of eight paid but didn't come, and refunds in full", async () => {
      const id = "CupNoSho";
      await openCup(id);
      pairByInvites(id);
      for (const p of players.slice(0, 7)) await walletSends("deposit", id, p);
      // Seven of eight: the game server can't start and closes the lobby.
      expect((await api("POST", `/pot/start/${id}`)).status).toBe(409);
      const at = Date.now();
      expect(
        (await api("POST", `/pot/cancel/${id}`, { deposited: 7 })).status,
      ).toBe(200);
      const claims = (
        await api("GET", `/public/pot/claims/${addr(players[0])}`)
      ).body.claims as { gameId: string }[];
      expect(claims.find((c) => c.gameId === id)).toMatchObject({
        kind: "refund",
        amount: STAKE.toString(),
        reason: "cancelled",
      });
      const before = await balance(players[0].publicKey);
      await walletSends("claim", id, players[0]);
      expect((await balance(players[0].publicKey)) - before).toBe(STAKE);
      console.log(
        `[cup no-show] refund claimable ${Date.now() - at} ms after cancel`,
      );
      for (const p of players.slice(1, 7)) await walletSends("claim", id, p);
    }, 180_000);

    it("names a tie for first and when the refund opens", async () => {
      const id = "CupTie01";
      await openCup(id);
      pairByInvites(id);
      await fundRound(id, true);
      await archive(id);
      // Two pairs hold exactly the same weighted land at the time limit.
      const pairs = store.cupPairs(id);
      const land: Record<string, number> = {};
      players.forEach((p, i) => {
        const team = pairs.findIndex((pair) => pair.includes(addr(p)));
        land[`Pl00000${i}`] = team === 0 || team === 1 ? 60 : 10;
      });
      replayResult = {
        winner: undefined,
        allPlayersStats: {},
        tick: 8400,
        territory: land,
      };
      try {
        const { body } = await api("POST", `/pot/settle/${id}`);
        expect(body).toMatchObject({ status: "void", code: "tie" });
      } finally {
        replayResult = null;
      }
      const round = store.getRound(id)!;
      const claims = (
        await api("GET", `/public/pot/claims/${addr(players[0])}`)
      ).body.claims as { gameId: string; releaseAt: number }[];
      const claim = claims.find((c) => c.gameId === id);
      expect(claim).toMatchObject({
        kind: "refund_pending",
        amount: STAKE.toString(),
        reason: "tie",
        releaseAt: round.resultEnds,
      });
      const hours = (round.resultEnds - Date.now() / 1000) / 3600;
      console.log(`[cup tie] refund opens in ${hours.toFixed(1)} h`);
      expect(hours).toBeGreaterThan(47);
      expect(hours).toBeLessThanOrEqual(48);
    }, 180_000);

    it("voids a match where nobody held land", async () => {
      const gameID = "PaidGam3";
      await fundRound(gameID, true);
      await archive(gameID);
      territory = {};
      expect((await api("POST", `/pot/settle/${gameID}`)).body.status).toBe(
        "void",
      );
      expect((await api("GET", `/public/pot/${gameID}`)).body.status).toBe(
        "void",
      );
    }, 180_000);

    it("refunds depositors who missed the start, less fees", async () => {
      const gameID = "PaidGamA";
      await fundRound(gameID, true);
      await archive(gameID, 6);
      territory = { Pl000000: 100, Pl000001: 50, Pl000002: 30, Pl000003: 20 };
      const { body } = await api("POST", `/pot/settle/${gameID}`);
      expect(body.status).toBe("proposed");
      const amounts = (body.amounts as string[]).map(BigInt);
      // 152 net: the two absent get 152/8 = 19 each.
      expect(amounts.slice(6)).toEqual([19n * UNIT, 19n * UNIT]);
      expect(amounts.reduce((a, b) => a + b, 0n)).toBe(152n * UNIT);
    }, 180_000);

    it("opens, seats only depositors, starts and settles through the keeper", async () => {
      const gameID = "PaidGam7";
      const opened = await api("POST", `/pot/open/${gameID}`);
      expect(opened.body).toMatchObject({ state: "funding" });
      // Opening twice is the same round.
      expect((await api("POST", `/pot/open/${gameID}`)).body).toEqual(
        opened.body,
      );
      const p0 = userIds.get(addr(players[0]))!;
      const seat = async (pid: string) =>
        (await api("POST", `/pot/seat/${gameID}`, { persistentID: pid })).body
          .seated;
      expect(await seat(p0)).toBe(false);

      for (const p of players.slice(0, 7))
        await walletSends("deposit", gameID, p);
      expect(await seat(p0)).toBe(true);
      // Twice is refused before anything is signed.
      expect(
        (
          await api("POST", "/public/pot/deposit-tx", {
            gameId: gameID,
            wallet: addr(players[0]),
          })
        ).status,
      ).toBe(409);
      // A wallet with no token account holds nothing: 402, not a 500.
      expect(
        (
          await api("POST", "/public/pot/deposit-tx", {
            gameId: gameID,
            wallet: addr(Keypair.generate()),
          })
        ).status,
      ).toBe(402);
      // Seven of eight: start refuses, and the lobby shows who is in.
      expect((await api("POST", `/pot/start/${gameID}`)).status).toBe(409);
      expect((await api("GET", `/pot/lobby/${gameID}`)).body).toMatchObject({
        deposited: 7,
        phase: RoundPhase.Funding,
      });
      const listed = (
        await api("GET", `/public/pot/lobbies?wallet=${addr(players[0])}`)
      ).body;
      expect(listed.lobbies).toContainEqual(
        expect.objectContaining({ gameId: gameID, deposited: 7, joined: true }),
      );

      await walletSends("deposit", gameID, players[7]);
      expect(await seat(store.createUser().id)).toBe(false);
      const started = await api("POST", `/pot/start/${gameID}`);
      expect(started.status).toBe(200);
      expect([...started.body.depositors].sort()).toEqual(
        players.map((p) => userIds.get(addr(p))!).sort(),
      );
      expect(
        (
          await api("POST", "/public/pot/deposit-tx", {
            gameId: gameID,
            wallet: addr(Keypair.generate()),
          })
        ).status,
      ).toBe(409);

      territory = { Pl000000: 3, Pl000001: 1 };
      await archive(gameID);
      await pot.tick();
      expect(store.getSettlement(gameID)?.status).toBe("proposed");
      await sleep((REVIEW_SECONDS + 1) * 1000);
      await pot.tick();
      expect(store.getSettlement(gameID)?.status).toBe("finalized");
      expect(store.getRound(gameID)?.state).toBe("closed");
      const ready = (await api("GET", `/public/pot/claims/${addr(players[1])}`))
        .body;
      // The same tick also released PaidGamA's result: both are listed.
      expect(ready.claims).toContainEqual(
        expect.objectContaining({
          gameId: gameID,
          kind: "winnings",
          phase: RoundPhase.Final,
          amount: ((152n * UNIT) / 4n).toString(),
        }),
      );
    }, 180_000);

    it("refunds a lobby the game server closes, then reclaims its rent", async () => {
      const gameID = "PaidGam8";
      const roundId = roundIdOf(gameID);
      await api("POST", `/pot/open/${gameID}`);
      await walletSends("deposit", gameID, players[2]);
      // Decided on a count that is already stale: look again.
      expect(
        (await api("POST", `/pot/cancel/${gameID}`, { deposited: 0 })).status,
      ).toBe(409);
      expect(
        (await api("POST", `/pot/cancel/${gameID}`, { deposited: 1 })).status,
      ).toBe(200);
      expect(store.getRound(gameID)?.state).toBe("cancelled");

      const claims = (
        await api("GET", `/public/pot/claims/${addr(players[2])}`)
      ).body;
      expect(claims.claims).toContainEqual(
        expect.objectContaining({
          gameId: gameID,
          kind: "refund",
          amount: STAKE.toString(),
        }),
      );
      const before = await balance(players[2].publicKey);
      await walletSends("claim", gameID, players[2]);
      expect((await balance(players[2].publicKey)) - before).toBe(STAKE);

      // Nothing left in it: the keeper closes the round for its rent.
      await pot.tick();
      expect((await chain.status(roundId)).phase).toBe(RoundPhase.None);
    }, 180_000);

    it("refunds a lobby nobody started once funding ends", async () => {
      const gameID = "PaidGam9";
      await api("POST", `/pot/open/${gameID}`);
      await walletSends("deposit", gameID, players[3]);
      await pot.tick();
      expect(store.getRound(gameID)?.state).toBe("funding");
      await sleep(62_000);
      await pot.tick();
      expect(store.getRound(gameID)?.state).toBe("cancelled");
      expect((await chain.status(roundIdOf(gameID))).phase).toBe(
        RoundPhase.Refunding,
      );
    }, 180_000);
  },
);
