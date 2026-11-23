import type { Hex } from "./RoundId";

/** The escrow program's round phases (solana/programs/landpot_escrow). */
export enum RoundPhase {
  None = 0,
  Funding = 1,
  Started = 2,
  Proposed = 3,
  Final = 4,
  Refunding = 5,
}

/** The wallet holds less than the entry: nothing to sign. */
export class InsufficientBalanceError extends Error {
  constructor() {
    super("not enough tokens for the entry");
  }
}

export interface TokenInfo {
  /** The mint, base58. */
  address: string;
  symbol: string;
  decimals: number;
}

export interface RoundStatus {
  phase: RoundPhase;
  frozen: boolean;
  playerCount: number;
  balance: bigint;
  releaseAt: bigint;
}

/**
 * What the pot service needs from the escrow. `solanaEscrowChain`
 * (SolanaEscrow.ts) talks to the program; unit tests use an in-memory fake.
 * Wallets are base58 public keys, compared exactly (base58 is case-sensitive).
 */
export interface EscrowChain {
  /** "mainnet-beta", "devnet" or "localnet": for explorer links. */
  readonly cluster: string;
  /** The escrow program id. */
  readonly escrow: string;
  /** The escrow's cuts (basis points) and review hold (seconds). */
  fees(): Promise<{
    burnBps: number;
    treasuryBps: number;
    reviewDelay: number;
  }>;
  status(roundId: Hex): Promise<RoundStatus>;
  /** Depositors in deposit order: the order `propose` takes amounts in. */
  players(roundId: Hex): Promise<string[]>;
  /** What the escrow still owes this wallet in a round. */
  owed(
    roundId: Hex,
    wallet: string,
  ): Promise<{ deposit: bigint; payout: bigint }>;
  token(): Promise<TokenInfo>;
  /** The cluster's clock: round deadlines are in chain time, seconds. */
  now(): Promise<bigint>;
  open(
    roundId: Hex,
    stake: bigint,
    minPlayers: number,
    maxPlayers: number,
    fundingEnds: bigint,
    resultEnds: bigint,
  ): Promise<string>;
  start(roundId: Hex): Promise<string>;
  cancel(roundId: Hex): Promise<string>;
  /** Sent by the operator and co-signed by the oracle. */
  propose(
    roundId: Hex,
    amounts: readonly bigint[],
    replayHash: Hex,
  ): Promise<string>;
  finalize(roundId: Hex): Promise<string>;
  /** Return a settled, fully claimed round's rent to the operator. */
  close(roundId: Hex): Promise<string>;
  /**
   * An unsigned deposit transaction for this wallet (base64). Throws
   * InsufficientBalanceError when it holds less than the entry.
   */
  depositTx(roundId: Hex, wallet: string): Promise<string>;
  /** An unsigned claim transaction for this wallet (base64). */
  claimTx(roundId: Hex, wallet: string): Promise<string>;
  /** Whether a sent transaction landed: "confirmed", "failed" or "pending". */
  txStatus(signature: string): Promise<"confirmed" | "failed" | "pending">;
}
