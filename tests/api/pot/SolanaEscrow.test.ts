import {
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fund,
  PROGRAM_ID,
  startValidator,
  validatorAvailable,
  type TestValidator,
} from "../../../scripts/landpot/solanaLocal";
import { RoundPhase } from "../../../src/api/pot/EscrowChain";
import { keccakHex, roundIdOf, type Hex } from "../../../src/api/pot/RoundId";
import {
  escrowProgram,
  initializeEscrow,
  pda,
  SolanaEscrow,
  type InitArgs,
} from "../../../src/api/pot/SolanaEscrow";

const UNIT = 1_000_000n; // 6 decimals, like a pump.fun mint
const STAKE = 10_000n * UNIT;
const DAILY_CAP = 50_000n * UNIT;

const CODES: Record<string, number> = {
  Unauthorized: 6000,
  InvalidInput: 6001,
  WrongPhase: 6002,
  LimitExceeded: 6003,
  TransferFailed: 6004,
  BadMint: 6005,
};

/** Anchor reports a program error by name or as a custom error code. */
async function expectError(p: Promise<unknown>, name: keyof typeof CODES) {
  const hex = `0x${CODES[name].toString(16)}`;
  await expect(p).rejects.toThrow(new RegExp(`${name}|${hex}\\b`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!validatorAvailable())(
  "landpot_escrow on a local validator",
  () => {
    let v: TestValidator;
    let connection: Connection;
    let mint: Keypair["publicKey"];
    let chain: SolanaEscrow;
    const guardian = Keypair.generate();
    const operator = Keypair.generate();
    const oracle = Keypair.generate();
    const treasury = Keypair.generate();
    const players = Array.from({ length: 9 }, () => Keypair.generate());

    const args = (): InitArgs => ({
      guardian: guardian.publicKey,
      operator: operator.publicKey,
      oracle: oracle.publicKey,
      treasury: treasury.publicKey,
      burnBps: 200,
      treasuryBps: 300,
      reviewDelay: 2,
      maxBank: 10_000_000n * UNIT,
      dailyCap: DAILY_CAP,
    });

    async function balance(owner: Keypair): Promise<bigint> {
      const ata = getAssociatedTokenAddressSync(
        mint,
        owner.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const acc = await getAccount(
        connection,
        ata,
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      return acc.amount;
    }

    /**
     * What a browser wallet does with the API's unsigned transaction: sign,
     * send, then ask the API until it is confirmed (which is also what makes
     * the API's next round read fresh).
     */
    async function signAndSend(b64: string, signer: Keypair): Promise<string> {
      const tx = Transaction.from(Buffer.from(b64, "base64"));
      tx.partialSign(signer);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const latest = await connection.getLatestBlockhash();
      const res = await connection.confirmTransaction(
        { signature: sig, ...latest },
        "confirmed",
      );
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      expect(await chain.txStatus(sig)).toBe("confirmed");
      return sig;
    }

    async function openRound(gameID: string, fundingSecs = 60): Promise<Hex> {
      const id = roundIdOf(gameID);
      const now = await chain.now();
      await chain.open(
        id,
        STAKE,
        8,
        16,
        now + BigInt(fundingSecs),
        now + BigInt(fundingSecs + 300),
      );
      return id;
    }

    async function fill(id: Hex, who: Keypair[]) {
      for (const p of who)
        await signAndSend(await chain.depositTx(id, p.publicKey.toBase58()), p);
    }

    beforeAll(async () => {
      v = await startValidator(18899);
      connection = v.connection;
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
          STAKE * 5n,
          [],
          { commitment: "confirmed" },
          TOKEN_2022_PROGRAM_ID,
        );
      }
      chain = new SolanaEscrow({
        connection,
        programId: PROGRAM_ID,
        operator,
        oracle,
        cluster: "localnet",
      });
    }, 180_000);

    afterAll(() => v?.stop());

    it("lets only the upgrade authority initialize, with a clean mint", async () => {
      await expectError(
        initializeEscrow(connection, PROGRAM_ID, operator, mint, args()),
        "Unauthorized",
      );
      const frozen = await createMint(
        connection,
        v.authority,
        v.authority.publicKey,
        v.authority.publicKey,
        6,
        undefined,
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID,
      );
      await expectError(
        initializeEscrow(connection, PROGRAM_ID, v.authority, frozen, args()),
        "BadMint",
      );
      await expectError(
        initializeEscrow(connection, PROGRAM_ID, v.authority, mint, {
          ...args(),
          guardian: operator.publicKey,
        }),
        "InvalidInput",
      );
      await initializeEscrow(connection, PROGRAM_ID, v.authority, mint, args());
      expect(await chain.fees()).toEqual({ burnBps: 200, treasuryBps: 300 });
      expect(await chain.token()).toMatchObject({
        address: mint.toBase58(),
        decimals: 6,
      });
    });

    it("plays a round: deposits, result, review hold, fees, capped claims", async () => {
      const id = await openRound("game-paid");
      const eight = players.slice(0, 8);
      await expectError(chain.start(id), "WrongPhase"); // not enough players yet
      await fill(id, eight);
      await expectError(
        signAndSend(
          await chain.depositTx(id, eight[0].publicKey.toBase58()),
          eight[0],
        ),
        "LimitExceeded",
      );
      expect(await chain.players(id)).toEqual(
        eight.map((p) => p.publicKey.toBase58()),
      );
      let s = await chain.status(id);
      expect(s).toMatchObject({
        phase: RoundPhase.Funding,
        playerCount: 8,
        balance: 8n * STAKE,
      });

      await chain.start(id);
      // Late deposit after the start.
      await expectError(
        signAndSend(
          await chain.depositTx(id, players[8].publicKey.toBase58()),
          players[8],
        ),
        "WrongPhase",
      );

      const pot = 8n * STAKE;
      const burn = (pot * 200n) / 10_000n;
      const fee = (pot * 300n) / 10_000n;
      const net = pot - burn - fee;
      const amounts = [
        60_000n * UNIT,
        net - 60_000n * UNIT,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
      ];
      const replay = keccakHex(new TextEncoder().encode("replay"));

      const wrongOracle = new SolanaEscrow({
        connection,
        programId: PROGRAM_ID,
        operator,
        oracle: operator,
        cluster: "localnet",
      });
      await expectError(
        wrongOracle.propose(id, amounts, replay),
        "Unauthorized",
      );
      await expectError(
        chain.propose(id, [...amounts.slice(0, 7), 1n], replay),
        "InvalidInput",
      );
      await chain.propose(id, amounts, replay);
      s = await chain.status(id);
      expect(s.phase).toBe(RoundPhase.Proposed);
      await expectError(chain.finalize(id), "WrongPhase"); // review hold

      await sleep(3_000);
      const supply = (
        await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)
      ).supply;
      await chain.finalize(id);
      expect(await balance(treasury)).toBe(fee);
      expect(
        (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID))
          .supply,
      ).toBe(supply - burn);
      expect((await chain.status(id)).phase).toBe(RoundPhase.Final);

      const [winner, second, loser] = eight;
      const before = await balance(winner);
      await signAndSend(
        await chain.claimTx(id, winner.publicKey.toBase58()),
        winner,
      );
      expect((await balance(winner)) - before).toBe(DAILY_CAP);
      expect(await chain.owed(id, winner.publicKey.toBase58())).toEqual({
        deposit: STAKE,
        payout: 60_000n * UNIT - DAILY_CAP,
      });
      // Over the daily cap: the rest waits for tomorrow.
      await expectError(
        signAndSend(
          await chain.claimTx(id, winner.publicKey.toBase58()),
          winner,
        ),
        "LimitExceeded",
      );
      const b2 = await balance(second);
      await signAndSend(
        await chain.claimTx(id, second.publicKey.toBase58()),
        second,
      );
      expect((await balance(second)) - b2).toBe(net - 60_000n * UNIT);
      await expectError(
        signAndSend(await chain.claimTx(id, loser.publicKey.toBase58()), loser),
        "LimitExceeded",
      );
      // Not closable while the winner is still owed.
      await expectError(chain.close(id), "WrongPhase");
    }, 120_000);

    it("refunds a frozen result once the guardian cancels it, then closes", async () => {
      const id = await openRound("game-frozen");
      const eight = players.slice(1, 9);
      await fill(id, eight);
      await chain.start(id);
      const net = (8n * STAKE * 9_500n) / 10_000n;
      await chain.propose(
        id,
        [net, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
        keccakHex(new Uint8Array([1])),
      );

      const asGuardian = escrowProgram(connection, PROGRAM_ID, guardian);
      const round = pda.round(PROGRAM_ID, id);
      const config = pda.config(PROGRAM_ID);
      // The operator is not the guardian.
      await expectError(
        escrowProgram(connection, PROGRAM_ID, operator)
          .methods.review(true)
          .accountsPartial({ guardian: operator.publicKey, config, round })
          .rpc(),
        "Unauthorized",
      );
      await asGuardian.methods
        .review(true)
        .accountsPartial({ guardian: guardian.publicKey, config, round })
        .rpc();
      // The operator can't refund a frozen result; the guardian can.
      await expectError(chain.cancel(id), "WrongPhase");
      await sleep(2_500);
      await expectError(chain.finalize(id), "WrongPhase");
      await asGuardian.methods
        .cancel()
        .accountsPartial({ authority: guardian.publicKey, config, round })
        .rpc();
      expect((await chain.status(id)).phase).toBe(RoundPhase.Refunding);

      for (const p of eight) {
        const before = await balance(p);
        await signAndSend(await chain.claimTx(id, p.publicKey.toBase58()), p);
        expect((await balance(p)) - before).toBe(STAKE);
      }
      const rentBefore = await connection.getBalance(operator.publicKey);
      await chain.close(id);
      expect(await connection.getAccountInfo(round)).toBeNull();
      expect(await connection.getBalance(operator.publicKey)).toBeGreaterThan(
        rentBefore,
      );
      expect((await chain.status(id)).phase).toBe(RoundPhase.None);
    }, 120_000);

    it("lets anyone refund a frozen result left alone for a review period", async () => {
      const id = await openRound("game-abandoned");
      const eight = players.slice(0, 8);
      await fill(id, eight);
      await chain.start(id);
      const net = (8n * STAKE * 9_500n) / 10_000n;
      await chain.propose(
        id,
        [net, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
        keccakHex(new Uint8Array([2])),
      );
      const round = pda.round(PROGRAM_ID, id);
      const config = pda.config(PROGRAM_ID);
      await escrowProgram(connection, PROGRAM_ID, guardian)
        .methods.review(true)
        .accountsPartial({ guardian: guardian.publicKey, config, round })
        .rpc();
      const stranger = Keypair.generate();
      await fund(connection, stranger.publicKey, 1);
      const strangerCancel = () =>
        escrowProgram(connection, PROGRAM_ID, stranger)
          .methods.cancel()
          .accountsPartial({ authority: stranger.publicKey, config, round })
          .rpc();
      // Frozen, and not yet one review period past release.
      await expectError(strangerCancel(), "WrongPhase");
      // release_at + review_delay = propose + 4 s.
      await sleep(5_000);
      await strangerCancel();
      expect((await chain.status(id)).phase).toBe(RoundPhase.Refunding);
      const before = await balance(eight[7]);
      await signAndSend(
        await chain.claimTx(id, eight[7].publicKey.toBase58()),
        eight[7],
      );
      expect((await balance(eight[7])) - before).toBe(STAKE);
    }, 120_000);

    it("lets the operator close a lobby that won't fill, refunding deposits", async () => {
      const id = await openRound("game-empty");
      const two = players.slice(0, 2);
      await fill(id, two);
      await chain.cancel(id);
      for (const p of two) {
        const before = await balance(p);
        await signAndSend(await chain.claimTx(id, p.publicKey.toBase58()), p);
        expect((await balance(p)) - before).toBe(STAKE);
      }
      await expectError(
        signAndSend(
          await chain.claimTx(id, two[0].publicKey.toBase58()),
          two[0],
        ),
        "LimitExceeded",
      );
      await chain.close(id);
    }, 120_000);

    it("reads rounds in one batched call and reuses it briefly", async () => {
      const a = await openRound("game-batch-a");
      const b = await openRound("game-batch-b");
      const missing = roundIdOf("game-never-opened");
      const batched = vi.spyOn(connection, "getMultipleAccountsInfoAndContext");
      try {
        // What one homepage refresh asks for, all at once.
        const reads = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            chain.status([a, b, missing][i % 3]),
          ),
        );
        expect(batched).toHaveBeenCalledTimes(1);
        expect(reads[0].phase).toBe(RoundPhase.Funding);
        expect(reads[2].phase).toBe(RoundPhase.None);
        // Again within the reuse window: no RPC call at all.
        await chain.players(a);
        expect(batched).toHaveBeenCalledTimes(1);
        // Our own transaction makes the next read fresh.
        await chain.cancel(a);
        expect((await chain.status(a)).phase).toBe(RoundPhase.Refunding);
        expect(batched).toHaveBeenCalledTimes(2);
      } finally {
        batched.mockRestore();
      }
      await chain.cancel(b);
      await chain.close(a);
      await chain.close(b);
    }, 120_000);

    it("rejects a round that breaks the limits", async () => {
      const now = await chain.now();
      await expectError(
        chain.open(
          roundIdOf("too-big"),
          10_000_000n * UNIT,
          8,
          16,
          now + 60n,
          now + 120n,
        ),
        "InvalidInput",
      );
      await expectError(
        chain.open(roundIdOf("too-few"), STAKE, 4, 16, now + 60n, now + 120n),
        "InvalidInput",
      );
    });
  },
);
