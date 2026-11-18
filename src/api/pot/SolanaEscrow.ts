import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type Keypair,
} from "@solana/web3.js";
import {
  InsufficientBalanceError,
  RoundPhase,
  type EscrowChain,
  type RoundStatus,
  type TokenInfo,
} from "./EscrowChain";
import idlJson from "./landpot_escrow.json";
import type { LandpotEscrow } from "./LandpotEscrowIdl";
import { fromHex, type Hex } from "./RoundId";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export function escrowProgram(
  connection: Connection,
  programId: PublicKey,
  payer: Keypair,
): Program<LandpotEscrow> {
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
  });
  return new Program<LandpotEscrow>(
    { ...(idlJson as LandpotEscrow), address: programId.toBase58() },
    provider,
  );
}

export const pda = {
  config: (program: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0],
  round: (program: PublicKey, roundId: Hex) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("round"), fromHex(roundId)],
      program,
    )[0],
  vault: (program: PublicKey, round: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), round.toBuffer()],
      program,
    )[0],
  cap: (program: PublicKey, wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("cap"), wallet.toBuffer()],
      program,
    )[0],
  programData: (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [program.toBuffer()],
      BPF_LOADER_UPGRADEABLE,
    )[0],
};

export interface InitArgs {
  guardian: PublicKey;
  operator: PublicKey;
  oracle: PublicKey;
  treasury: PublicKey;
  burnBps: number;
  treasuryBps: number;
  reviewDelay: number;
  maxBank: bigint;
  dailyCap: bigint;
}

/** One-time set-up; `authority` must be the program's upgrade authority. */
export async function initializeEscrow(
  connection: Connection,
  programId: PublicKey,
  authority: Keypair,
  mint: PublicKey,
  args: InitArgs,
): Promise<string> {
  const program = escrowProgram(connection, programId, authority);
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`mint ${mint.toBase58()} not found`);
  return program.methods
    .initialize({
      guardian: args.guardian,
      operator: args.operator,
      oracle: args.oracle,
      treasury: args.treasury,
      burnBps: args.burnBps,
      treasuryBps: args.treasuryBps,
      reviewDelay: new BN(args.reviewDelay),
      maxBank: new BN(args.maxBank.toString()),
      dailyCap: new BN(args.dailyCap.toString()),
    })
    .accountsPartial({
      authority: authority.publicKey,
      config: pda.config(programId),
      mint,
      tokenProgram: mintInfo.owner,
      program: programId,
      programData: pda.programData(programId),
    })
    .rpc();
}

const big = (n: BN | number) => BigInt(n.toString());
const bn = (n: bigint) => new BN(n.toString());

type RoundAccount = Awaited<
  ReturnType<Program<LandpotEscrow>["account"]["round"]["fetch"]>
>;
/** How long a round read is reused (see SolanaEscrow.fetchRound). */
const ROUND_TTL_MS = 2_000;

interface ConfigData {
  guardian: PublicKey;
  operator: PublicKey;
  oracle: PublicKey;
  treasury: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  burnBps: number;
  treasuryBps: number;
}

export interface SolanaEscrowOptions {
  connection: Connection;
  programId: PublicKey;
  /** Opens, starts and cancels rounds, and pays their rent. */
  operator: Keypair;
  /** Co-signs every result. */
  oracle: Keypair;
  cluster: string;
  /** Used when the mint carries no metadata (a classic SPL test mint). */
  fallbackSymbol?: string;
}

/** The escrow program as the pot service sees it (EscrowChain). */
export class SolanaEscrow implements EscrowChain {
  readonly cluster: string;
  readonly escrow: string;
  private readonly program: Program<LandpotEscrow>;
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private config_?: Promise<ConfigData>;
  private token_?: Promise<TokenInfo>;

  constructor(private readonly opts: SolanaEscrowOptions) {
    this.cluster = opts.cluster;
    this.escrow = opts.programId.toBase58();
    this.connection = opts.connection;
    this.programId = opts.programId;
    this.program = escrowProgram(
      opts.connection,
      opts.programId,
      opts.operator,
    );
  }

  private config(): Promise<ConfigData> {
    this.config_ ??= this.program.account.config
      .fetch(pda.config(this.programId))
      .catch((e: unknown) => {
        this.config_ = undefined;
        throw e;
      });
    return this.config_;
  }

  private roundPda(roundId: Hex): PublicKey {
    return pda.round(this.programId, roundId);
  }

  /**
   * Round reads, shared. The homepage asks every few seconds per open tab,
   * for every open lobby and every recent round (claims), and the keeper
   * walks the same rounds: one RPC call per read would trip a public RPC's
   * rate limit and bill a paid one for nothing. Reads asked for in the same
   * tick go out as one getMultipleAccounts, and a result is reused for
   * ROUND_TTL_MS. Our own transactions and any confirmed or failed one a
   * wallet reports through txStatus drop the cache, so nobody sees a round
   * from before their own action.
   */
  private readonly rounds = new Map<string, Promise<RoundAccount | null>>();
  private readonly fetchedAt = new Map<string, number>();
  private batch: {
    key: PublicKey;
    resolve: (r: RoundAccount | null) => void;
    reject: (e: unknown) => void;
  }[] = [];

  private fetchRound(roundId: Hex): Promise<RoundAccount | null> {
    const key = this.roundPda(roundId);
    const id = key.toBase58();
    const cached = this.rounds.get(id);
    const at = this.fetchedAt.get(id);
    if (cached && (at === undefined || Date.now() - at < ROUND_TTL_MS)) {
      return cached;
    }
    const read = new Promise<RoundAccount | null>((resolve, reject) => {
      if (this.batch.length === 0) setTimeout(() => this.flushRounds(), 0);
      this.batch.push({ key, resolve, reject });
    });
    this.rounds.set(id, read);
    this.fetchedAt.delete(id);
    read.then(
      () => {
        if (this.rounds.get(id) === read) this.fetchedAt.set(id, Date.now());
      },
      () => {
        if (this.rounds.get(id) === read) this.rounds.delete(id);
      },
    );
    return read;
  }

  private flushRounds(): void {
    const batch = this.batch;
    this.batch = [];
    this.program.account.round.fetchMultiple(batch.map((b) => b.key)).then(
      (found) =>
        batch.forEach((b, i) => b.resolve((found[i] as RoundAccount) ?? null)),
      (e: unknown) => batch.forEach((b) => b.reject(e)),
    );
  }

  /** Something changed on chain: the next read of any round is fresh. */
  private forgetRounds(): void {
    this.rounds.clear();
    this.fetchedAt.clear();
  }

  private async sent(tx: Promise<string>): Promise<string> {
    try {
      return await tx;
    } finally {
      this.forgetRounds();
    }
  }

  async fees(): Promise<{ burnBps: number; treasuryBps: number }> {
    const c = await this.config();
    return { burnBps: c.burnBps, treasuryBps: c.treasuryBps };
  }

  async status(roundId: Hex): Promise<RoundStatus> {
    const r = await this.fetchRound(roundId);
    if (!r)
      return {
        phase: RoundPhase.None,
        frozen: false,
        playerCount: 0,
        balance: 0n,
        releaseAt: 0n,
      };
    return {
      phase: r.phase as RoundPhase,
      frozen: r.frozen,
      playerCount: r.count,
      balance: big(r.balance),
      releaseAt: big(r.releaseAt),
    };
  }

  async players(roundId: Hex): Promise<string[]> {
    const r = await this.fetchRound(roundId);
    if (!r) return [];
    return r.players.slice(0, r.count).map((p) => p.toBase58());
  }

  async owed(
    roundId: Hex,
    wallet: string,
  ): Promise<{ deposit: bigint; payout: bigint }> {
    const r = await this.fetchRound(roundId);
    const i = r
      ? r.players.slice(0, r.count).findIndex((p) => p.toBase58() === wallet)
      : -1;
    if (!r || i < 0) return { deposit: 0n, payout: 0n };
    return { deposit: big(r.deposits[i]), payout: big(r.payouts[i]) };
  }

  token(): Promise<TokenInfo> {
    this.token_ ??= (async () => {
      const c = await this.config();
      let symbol = this.opts.fallbackSymbol ?? "LANDPOT";
      if (c.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        const meta = await getTokenMetadata(
          this.connection,
          c.mint,
          "confirmed",
          TOKEN_2022_PROGRAM_ID,
        ).catch(() => null);
        if (meta?.symbol) symbol = meta.symbol;
      }
      return { address: c.mint.toBase58(), symbol, decimals: c.decimals };
    })().catch((e: unknown) => {
      this.token_ = undefined;
      throw e;
    });
    return this.token_;
  }

  async now(): Promise<bigint> {
    const info = await this.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed",
    );
    if (!info) throw new Error("clock sysvar unavailable");
    // Clock: slot u64, epoch_start_timestamp i64, epoch u64,
    // leader_schedule_epoch u64, unix_timestamp i64.
    return info.data.readBigInt64LE(32);
  }

  async open(
    roundId: Hex,
    stake: bigint,
    minPlayers: number,
    maxPlayers: number,
    fundingEnds: bigint,
    resultEnds: bigint,
  ): Promise<string> {
    const c = await this.config();
    const round = this.roundPda(roundId);
    return this.sent(
      this.program.methods
        .open(
          Array.from(fromHex(roundId)),
          bn(stake),
          minPlayers,
          maxPlayers,
          bn(fundingEnds),
          bn(resultEnds),
        )
        .accountsPartial({
          operator: this.opts.operator.publicKey,
          config: pda.config(this.programId),
          round,
          mint: c.mint,
          vault: pda.vault(this.programId, round),
          tokenProgram: c.tokenProgram,
        })
        .rpc(),
    );
  }

  start(roundId: Hex): Promise<string> {
    return this.sent(
      this.program.methods
        .start()
        .accountsPartial({
          operator: this.opts.operator.publicKey,
          config: pda.config(this.programId),
          round: this.roundPda(roundId),
        })
        .rpc(),
    );
  }

  cancel(roundId: Hex): Promise<string> {
    return this.sent(
      this.program.methods
        .cancel()
        .accountsPartial({
          authority: this.opts.operator.publicKey,
          config: pda.config(this.programId),
          round: this.roundPda(roundId),
        })
        .rpc(),
    );
  }

  propose(
    roundId: Hex,
    amounts: readonly bigint[],
    replayHash: Hex,
  ): Promise<string> {
    return this.sent(
      this.program.methods
        .propose(amounts.map(bn), Array.from(fromHex(replayHash)))
        .accountsPartial({
          oracle: this.opts.oracle.publicKey,
          config: pda.config(this.programId),
          round: this.roundPda(roundId),
        })
        .signers([this.opts.oracle])
        .rpc(),
    );
  }

  async finalize(roundId: Hex): Promise<string> {
    const c = await this.config();
    const round = this.roundPda(roundId);
    const treasuryAccount = getAssociatedTokenAddressSync(
      c.mint,
      c.treasury,
      true,
      c.tokenProgram,
    );
    return this.sent(
      this.program.methods
        .finalize()
        .accountsPartial({
          config: pda.config(this.programId),
          round,
          mint: c.mint,
          vault: pda.vault(this.programId, round),
          treasuryAccount,
          tokenProgram: c.tokenProgram,
        })
        .preInstructions([
          createAssociatedTokenAccountIdempotentInstruction(
            this.opts.operator.publicKey,
            treasuryAccount,
            c.treasury,
            c.mint,
            c.tokenProgram,
          ),
        ])
        .rpc(),
    );
  }

  async close(roundId: Hex): Promise<string> {
    const c = await this.config();
    const round = this.roundPda(roundId);
    return this.sent(
      this.program.methods
        .closeRound()
        .accountsPartial({
          config: pda.config(this.programId),
          round,
          vault: pda.vault(this.programId, round),
          operator: c.operator,
          tokenProgram: c.tokenProgram,
        })
        .rpc(),
    );
  }

  async depositTx(roundId: Hex, wallet: string): Promise<string> {
    const c = await this.config();
    const player = new PublicKey(wallet);
    const round = this.roundPda(roundId);
    const r = await this.program.account.round.fetch(round);
    const from = getAssociatedTokenAddressSync(
      c.mint,
      player,
      false,
      c.tokenProgram,
    );
    // No token account means no tokens; any other failure (a rate-limited
    // RPC, say) is not a balance and must not read as one.
    const held = await this.connection
      .getTokenAccountBalance(from, "confirmed")
      .then((b) => BigInt(b.value.amount))
      .catch((e: unknown) => {
        if (/could not find account/i.test(String(e))) return 0n;
        throw e;
      });
    if (held < big(r.stake)) throw new InsufficientBalanceError();
    const ix = await this.program.methods
      .deposit()
      .accountsPartial({
        player,
        config: pda.config(this.programId),
        round,
        mint: c.mint,
        from,
        vault: pda.vault(this.programId, round),
        tokenProgram: c.tokenProgram,
      })
      .instruction();
    return this.unsigned(player, [ix]);
  }

  async claimTx(roundId: Hex, wallet: string): Promise<string> {
    const c = await this.config();
    const player = new PublicKey(wallet);
    const round = this.roundPda(roundId);
    const to = getAssociatedTokenAddressSync(
      c.mint,
      player,
      false,
      c.tokenProgram,
    );
    const ix = await this.program.methods
      .claim()
      .accountsPartial({
        player,
        config: pda.config(this.programId),
        round,
        mint: c.mint,
        vault: pda.vault(this.programId, round),
        to,
        cap: pda.cap(this.programId, player),
        tokenProgram: c.tokenProgram,
      })
      .instruction();
    return this.unsigned(player, [
      createAssociatedTokenAccountIdempotentInstruction(
        player,
        to,
        player,
        c.mint,
        c.tokenProgram,
      ),
      ix,
    ]);
  }

  private async unsigned(
    feePayer: PublicKey,
    ixs: Transaction["instructions"],
  ): Promise<string> {
    // Finalized: wallets simulate before sending, many at "finalized", and
    // a newer blockhash is unknown there ("Blockhash not found"). It stays
    // valid for about a minute, plenty for a wallet prompt.
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
    tx.add(...ixs);
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  async txStatus(
    signature: string,
  ): Promise<"confirmed" | "failed" | "pending"> {
    const { value } = await this.connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (!value) return "pending";
    if (value.confirmationStatus === "processed" && !value.err)
      return "pending";
    this.forgetRounds();
    return value.err ? "failed" : "confirmed";
  }
}
