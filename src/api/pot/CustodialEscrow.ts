import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  type Keypair,
} from "@solana/web3.js";
import { DatabaseSync } from "node:sqlite";
import {
  InsufficientBalanceError,
  RoundPhase,
  type EscrowChain,
  type RoundStatus,
  type TokenInfo,
} from "./EscrowChain";
import type { Hex } from "./RoundId";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export interface CustodialEscrowConfig {
  connection: Connection;
  cluster: string;
  mint: PublicKey;
  vault: Keypair;
  treasury: PublicKey;
  dbPath: string;
  burnBps?: number;
  treasuryBps?: number;
  reviewDelay?: number;
}

interface RoundRow {
  round_id: string;
  stake: string;
  min_players: number;
  max_players: number;
  funding_ends: number;
  result_ends: number;
  phase: number;
  release_at: number;
  burn_done: number;
  replay_hash: string | null;
}

function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(text, "utf8"),
  });
}

/**
 * Server-custodied Solana escrow implementing `EscrowChain` without deploying
 * an Anchor program (zero program rent). Deposits are standard SPL / Token-2022
 * transfers into the vault ATA tagged with a round memo; finalization burns the
 * 2% cut on-chain via `burnChecked` and sends 3% to treasury; claims are
 * partially signed by the vault so winners pay the tx fee and receive tokens
 * atomically in one transaction.
 */
export class CustodialEscrow implements EscrowChain {
  readonly cluster: string;
  readonly escrow: string;

  private readonly connection: Connection;
  private readonly mint: PublicKey;
  private readonly vault: Keypair;
  private readonly treasury: PublicKey;
  private readonly burnBps: number;
  private readonly treasuryBps: number;
  private readonly reviewDelay: number;
  private readonly db: DatabaseSync;

  private tokenCache: {
    info: TokenInfo;
    programId: PublicKey;
    vaultAta: PublicKey;
    treasuryAta: PublicKey;
  } | null = null;

  constructor(cfg: CustodialEscrowConfig) {
    this.connection = cfg.connection;
    this.cluster = cfg.cluster;
    this.mint = cfg.mint;
    this.vault = cfg.vault;
    this.treasury = cfg.treasury;
    this.escrow = cfg.vault.publicKey.toBase58();
    this.burnBps = cfg.burnBps ?? 200;
    this.treasuryBps = cfg.treasuryBps ?? 300;
    this.reviewDelay = cfg.reviewDelay ?? 15;

    this.db = new DatabaseSync(cfg.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS custodial_rounds (
        round_id TEXT PRIMARY KEY,
        stake TEXT NOT NULL,
        min_players INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        funding_ends INTEGER NOT NULL,
        result_ends INTEGER NOT NULL,
        phase INTEGER NOT NULL,
        release_at INTEGER NOT NULL DEFAULT 0,
        burn_done INTEGER NOT NULL DEFAULT 0,
        replay_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS custodial_deposits (
        round_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        tx_sig TEXT NOT NULL UNIQUE,
        amount TEXT NOT NULL,
        seq INTEGER NOT NULL,
        refunded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (round_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS custodial_payouts (
        round_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        amount TEXT NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        claim_sig TEXT,
        PRIMARY KEY (round_id, wallet)
      );
    `);
  }

  closeDb(): void {
    this.db.close();
  }

  private async resolveToken() {
    if (this.tokenCache) return this.tokenCache;
    const acct = await this.connection.getAccountInfo(this.mint, "confirmed");
    if (!acct) {
      throw new Error(`Mint ${this.mint.toBase58()} not found on ${this.cluster}`);
    }
    const programId = acct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const mintInfo = await getMint(
      this.connection,
      this.mint,
      "confirmed",
      programId,
    );
    let symbol = "LANDPOT";
    if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
      try {
        const meta = await getTokenMetadata(
          this.connection,
          this.mint,
          "confirmed",
          programId,
        );
        if (meta?.symbol) symbol = meta.symbol.trim();
      } catch {
        // default symbol
      }
    }
    const vaultAta = getAssociatedTokenAddressSync(
      this.mint,
      this.vault.publicKey,
      false,
      programId,
    );
    const treasuryAta = getAssociatedTokenAddressSync(
      this.mint,
      this.treasury,
      false,
      programId,
    );
    this.tokenCache = {
      info: {
        address: this.mint.toBase58(),
        symbol,
        decimals: mintInfo.decimals,
      },
      programId,
      vaultAta,
      treasuryAta,
    };
    return this.tokenCache;
  }

  async fees() {
    return {
      burnBps: this.burnBps,
      treasuryBps: this.treasuryBps,
      reviewDelay: this.reviewDelay,
    };
  }

  async token(): Promise<TokenInfo> {
    return (await this.resolveToken()).info;
  }

  async now(): Promise<bigint> {
    return BigInt(Math.floor(Date.now() / 1000));
  }

  private getRound(roundId: Hex): RoundRow | undefined {
    return this.db
      .prepare("SELECT * FROM custodial_rounds WHERE round_id = ?")
      .get(roundId) as RoundRow | undefined;
  }

  async status(roundId: Hex): Promise<RoundStatus> {
    const row = this.getRound(roundId);
    if (!row) {
      return {
        phase: RoundPhase.None,
        frozen: false,
        playerCount: 0,
        balance: 0n,
        releaseAt: 0n,
      };
    }
    const deposits = this.db
      .prepare("SELECT amount, refunded FROM custodial_deposits WHERE round_id = ?")
      .all(roundId) as { amount: string; refunded: number }[];
    let balance = 0n;
    if (row.phase === RoundPhase.Final) {
      const payouts = this.db
        .prepare("SELECT amount, claimed FROM custodial_payouts WHERE round_id = ?")
        .all(roundId) as { amount: string; claimed: number }[];
      for (const p of payouts) {
        if (!p.claimed) balance += BigInt(p.amount);
      }
    } else {
      for (const d of deposits) {
        if (!d.refunded) balance += BigInt(d.amount);
      }
    }
    return {
      phase: row.phase as RoundPhase,
      frozen: false,
      playerCount: deposits.length,
      balance,
      releaseAt: BigInt(row.release_at),
    };
  }

  async players(roundId: Hex): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT wallet FROM custodial_deposits WHERE round_id = ? ORDER BY seq ASC",
      )
      .all(roundId) as { wallet: string }[];
    return rows.map((r) => r.wallet);
  }

  async owed(
    roundId: Hex,
    wallet: string,
  ): Promise<{ deposit: bigint; payout: bigint }> {
    const dep = this.db
      .prepare(
        "SELECT amount, refunded FROM custodial_deposits WHERE round_id = ? AND wallet = ?",
      )
      .get(roundId, wallet) as { amount: string; refunded: number } | undefined;
    const pay = this.db
      .prepare(
        "SELECT amount, claimed FROM custodial_payouts WHERE round_id = ? AND wallet = ?",
      )
      .get(roundId, wallet) as { amount: string; claimed: number } | undefined;
    return {
      deposit: dep && !dep.refunded ? BigInt(dep.amount) : 0n,
      payout: pay && !pay.claimed ? BigInt(pay.amount) : 0n,
    };
  }

  async open(
    roundId: Hex,
    stake: bigint,
    minPlayers: number,
    maxPlayers: number,
    fundingEnds: bigint,
    resultEnds: bigint,
  ): Promise<string> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO custodial_rounds
         (round_id, stake, min_players, max_players, funding_ends, result_ends, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roundId,
        stake.toString(),
        minPlayers,
        maxPlayers,
        Number(fundingEnds),
        Number(resultEnds),
        RoundPhase.Funding,
      );
    return `custodial-open-${roundId.slice(0, 12)}`;
  }

  async start(roundId: Hex): Promise<string> {
    const row = this.getRound(roundId);
    if (!row) throw new Error(`Round ${roundId} not found`);
    if (row.phase === RoundPhase.Funding) {
      const count = (
        this.db
          .prepare("SELECT COUNT(*) as c FROM custodial_deposits WHERE round_id = ?")
          .get(roundId) as { c: number }
      ).c;
      if (count < row.min_players) {
        throw new Error(`Not enough players (${count}/${row.min_players})`);
      }
      this.db
        .prepare("UPDATE custodial_rounds SET phase = ? WHERE round_id = ?")
        .run(RoundPhase.Started, roundId);
    }
    return `custodial-start-${roundId.slice(0, 12)}`;
  }

  async cancel(roundId: Hex): Promise<string> {
    const row = this.getRound(roundId);
    if (!row) throw new Error(`Round ${roundId} not found`);
    if (
      row.phase === RoundPhase.Funding ||
      row.phase === RoundPhase.Started ||
      row.phase === RoundPhase.Proposed
    ) {
      this.db
        .prepare("UPDATE custodial_rounds SET phase = ? WHERE round_id = ?")
        .run(RoundPhase.Refunding, roundId);
    }
    return `custodial-cancel-${roundId.slice(0, 12)}`;
  }

  async propose(
    roundId: Hex,
    amounts: readonly bigint[],
    replayHash: Hex,
  ): Promise<string> {
    const row = this.getRound(roundId);
    if (!row) throw new Error(`Round ${roundId} not found`);
    const wallets = await this.players(roundId);
    if (amounts.length !== wallets.length) {
      throw new Error(
        `Payout count ${amounts.length} !== player count ${wallets.length}`,
      );
    }
    const releaseAt = Math.floor(Date.now() / 1000) + this.reviewDelay;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE custodial_rounds SET phase = ?, release_at = ?, replay_hash = ? WHERE round_id = ?",
        )
        .run(RoundPhase.Proposed, releaseAt, replayHash, roundId);
      const stmt = this.db.prepare(
        `INSERT INTO custodial_payouts (round_id, wallet, amount, claimed)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(round_id, wallet) DO UPDATE SET amount = excluded.amount`,
      );
      for (let i = 0; i < wallets.length; i++) {
        stmt.run(roundId, wallets[i], amounts[i].toString());
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return `custodial-propose-${roundId.slice(0, 12)}`;
  }

  async finalize(roundId: Hex): Promise<string> {
    const row = this.getRound(roundId);
    if (!row) throw new Error(`Round ${roundId} not found`);
    if (row.phase === RoundPhase.Final) {
      return `custodial-final-${roundId.slice(0, 12)}`;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < row.release_at) {
      throw new Error("Review hold not elapsed yet");
    }

    const tok = await this.resolveToken();
    const deposits = this.db
      .prepare("SELECT amount FROM custodial_deposits WHERE round_id = ?")
      .all(roundId) as { amount: string }[];
    let total = 0n;
    for (const d of deposits) total += BigInt(d.amount);

    const burnAmt = (total * BigInt(this.burnBps)) / 10_000n;
    const treasuryAmt = (total * BigInt(this.treasuryBps)) / 10_000n;

    let sig = `custodial-final-${roundId.slice(0, 12)}`;
    if (!row.burn_done && (burnAmt > 0n || treasuryAmt > 0n)) {
      const tx = new Transaction();
      if (burnAmt > 0n) {
        tx.add(
          createBurnCheckedInstruction(
            tok.vaultAta,
            this.mint,
            this.vault.publicKey,
            burnAmt,
            tok.info.decimals,
            [],
            tok.programId,
          ),
        );
      }
      if (treasuryAmt > 0n) {
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            this.vault.publicKey,
            tok.treasuryAta,
            this.treasury,
            this.mint,
            tok.programId,
          ),
          createTransferCheckedInstruction(
            tok.vaultAta,
            this.mint,
            tok.treasuryAta,
            this.vault.publicKey,
            treasuryAmt,
            tok.info.decimals,
            [],
            tok.programId,
          ),
        );
      }
      tx.add(memoIx(`landpot:finalize:${roundId}`));
      sig = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.vault],
        { commitment: "confirmed" },
      );
    }

    this.db
      .prepare(
        "UPDATE custodial_rounds SET phase = ?, burn_done = 1 WHERE round_id = ?",
      )
      .run(RoundPhase.Final, roundId);
    return sig;
  }

  async close(roundId: Hex): Promise<string> {
    this.db
      .prepare("DELETE FROM custodial_payouts WHERE round_id = ?")
      .run(roundId);
    this.db
      .prepare("DELETE FROM custodial_deposits WHERE round_id = ?")
      .run(roundId);
    this.db
      .prepare("DELETE FROM custodial_rounds WHERE round_id = ?")
      .run(roundId);
    return `custodial-close-${roundId.slice(0, 12)}`;
  }

  async depositTx(roundId: Hex, wallet: string): Promise<string> {
    const row = this.getRound(roundId);
    if (!row || row.phase !== RoundPhase.Funding) {
      throw new Error("Round is not accepting deposits");
    }
    const existing = this.db
      .prepare(
        "SELECT 1 FROM custodial_deposits WHERE round_id = ? AND wallet = ?",
      )
      .get(roundId, wallet);
    if (existing) {
      throw new Error("Wallet already deposited in this round");
    }

    const tok = await this.resolveToken();
    const playerPk = new PublicKey(wallet);
    const playerAta = getAssociatedTokenAddressSync(
      this.mint,
      playerPk,
      false,
      tok.programId,
    );
    const stake = BigInt(row.stake);
    try {
      const bal = await this.connection.getTokenAccountBalance(
        playerAta,
        "confirmed",
      );
      if (BigInt(bal.value.amount) < stake) {
        throw new InsufficientBalanceError();
      }
    } catch (e) {
      if (e instanceof InsufficientBalanceError) throw e;
      throw new InsufficientBalanceError();
    }

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: playerPk, recentBlockhash: blockhash });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        playerPk,
        tok.vaultAta,
        this.vault.publicKey,
        this.mint,
        tok.programId,
      ),
      createTransferCheckedInstruction(
        playerAta,
        this.mint,
        tok.vaultAta,
        playerPk,
        stake,
        tok.info.decimals,
        [],
        tok.programId,
      ),
      memoIx(`landpot:deposit:${roundId}:${wallet}`),
    );
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  async claimTx(roundId: Hex, wallet: string): Promise<string> {
    const row = this.getRound(roundId);
    if (!row) throw new Error("Round not found");
    const owed = await this.owed(roundId, wallet);
    const amount =
      row.phase === RoundPhase.Final
        ? owed.payout
        : row.phase === RoundPhase.Refunding
          ? owed.deposit
          : 0n;
    if (amount <= 0n) {
      throw new Error("Nothing claimable for this wallet");
    }

    const tok = await this.resolveToken();
    const playerPk = new PublicKey(wallet);
    const playerAta = getAssociatedTokenAddressSync(
      this.mint,
      playerPk,
      false,
      tok.programId,
    );

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: playerPk, recentBlockhash: blockhash });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        playerPk,
        playerAta,
        playerPk,
        this.mint,
        tok.programId,
      ),
      createTransferCheckedInstruction(
        tok.vaultAta,
        this.mint,
        playerAta,
        this.vault.publicKey,
        amount,
        tok.info.decimals,
        [],
        tok.programId,
      ),
      memoIx(`landpot:claim:${roundId}:${wallet}`),
    );
    // Partially sign with the vault so the player signs as feePayer and submits directly.
    tx.partialSign(this.vault);
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  async txStatus(signature: string): Promise<"confirmed" | "failed" | "pending"> {
    const { value } = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (!st) return "pending";
    if (st.err) return "failed";
    if (
      st.confirmationStatus !== "confirmed" &&
      st.confirmationStatus !== "finalized"
    ) {
      return "pending";
    }
    await this.reconcileConfirmedTx(signature);
    return "confirmed";
  }

  /**
   * Inspects a confirmed deposit or claim transaction by its memo and updates
   * SQLite idempotently after verifying the on-chain token balance delta.
   */
  private async reconcileConfirmedTx(signature: string): Promise<void> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) return;

    const logs = tx.meta.logMessages ?? [];
    const memoLine = logs.find((l) => l.includes("landpot:"));
    if (!memoLine) return;

    const depMatch = /landpot:deposit:(0x[0-9a-fA-F]+):([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(
      memoLine,
    );
    if (depMatch) {
      const [, roundId, wallet] = depMatch;
      const row = this.getRound(roundId as Hex);
      if (!row || row.phase !== RoundPhase.Funding) return;

      const vaultOwner = this.vault.publicKey.toBase58();
      const mintStr = this.mint.toBase58();
      const pre = (tx.meta.preTokenBalances ?? []).find(
        (b) => b.owner === vaultOwner && b.mint === mintStr,
      );
      const post = (tx.meta.postTokenBalances ?? []).find(
        (b) => b.owner === vaultOwner && b.mint === mintStr,
      );
      const delta =
        BigInt(post?.uiTokenAmount.amount ?? "0") -
        BigInt(pre?.uiTokenAmount.amount ?? "0");
      const stake = BigInt(row.stake);
      if (delta < stake) return;

      const nextSeq =
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(seq), -1) + 1 as n FROM custodial_deposits WHERE round_id = ?",
            )
            .get(roundId) as { n: number }
        ).n;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO custodial_deposits (round_id, wallet, tx_sig, amount, seq)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(roundId, wallet, signature, stake.toString(), nextSeq);
      return;
    }

    const claimMatch = /landpot:claim:(0x[0-9a-fA-F]+):([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(
      memoLine,
    );
    if (claimMatch) {
      const [, roundId, wallet] = claimMatch;
      const row = this.getRound(roundId as Hex);
      if (!row) return;
      if (row.phase === RoundPhase.Final) {
        this.db
          .prepare(
            "UPDATE custodial_payouts SET claimed = 1, claim_sig = ? WHERE round_id = ? AND wallet = ?",
          )
          .run(signature, roundId, wallet);
      } else if (row.phase === RoundPhase.Refunding) {
        this.db
          .prepare(
            "UPDATE custodial_deposits SET refunded = 1 WHERE round_id = ? AND wallet = ?",
          )
          .run(roundId, wallet);
      }
    }
  }
}
