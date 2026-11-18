import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifact from "./LandpotEscrow.json";
import type { OracleSignature } from "./Oracle";

export const ESCROW_ABI = artifact.abi as Abi;
export const ESCROW_BYTECODE = artifact.bytecode as Hex;

/** LandpotEscrow.Phase */
export enum RoundPhase {
  None = 0,
  Funding = 1,
  Started = 2,
  Proposed = 3,
  Final = 4,
  Refunding = 5,
}

export interface TokenInfo {
  address: Address;
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
 * What settlement needs from the escrow. The viem implementation below talks
 * to a real chain; unit tests use an in-memory fake.
 */
export interface EscrowChain {
  readonly chainId: bigint;
  readonly escrow: Address;
  fees(): Promise<{ burnBps: number; treasuryBps: number }>;
  status(roundId: Hex): Promise<RoundStatus>;
  players(roundId: Hex): Promise<Address[]>;
  /** What the escrow still owes this wallet in a round. */
  owed(
    roundId: Hex,
    wallet: Address,
  ): Promise<{ deposit: bigint; payout: bigint }>;
  token(): Promise<TokenInfo>;
  /** The latest block's timestamp: round deadlines are in chain time. */
  now(): Promise<bigint>;
  open(
    roundId: Hex,
    stake: bigint,
    minPlayers: number,
    maxPlayers: number,
    fundingEnds: bigint,
    resultEnds: bigint,
  ): Promise<Hex>;
  start(roundId: Hex): Promise<Hex>;
  cancel(roundId: Hex): Promise<Hex>;
  propose(
    roundId: Hex,
    amounts: readonly bigint[],
    replayHash: Hex,
    sig: OracleSignature,
  ): Promise<Hex>;
  finalize(roundId: Hex): Promise<Hex>;
}

export function viemEscrowChain(opts: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  /**
   * The contract's operator: opens and starts rounds, closes unfilled
   * lobbies, and pays gas for propose/finalize/cancel (anyone may send those).
   */
  senderKey: Hex;
}): EscrowChain {
  const chain = {
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  } satisfies Chain;
  const transport = http(opts.rpcUrl, { timeout: 15_000 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({
    chain,
    transport,
    account: privateKeyToAccount(opts.senderKey),
  });
  const read = <T>(functionName: string, args: unknown[] = []) =>
    pub.readContract({
      address: opts.escrow,
      abi: ESCROW_ABI,
      functionName,
      args,
    }) as Promise<T>;
  // Simulate first so a revert surfaces with its reason before gas is spent;
  // then wait for the receipt so callers see a mined, successful transaction.
  const write = async (functionName: string, args: unknown[]) => {
    const { request } = await pub.simulateContract({
      address: opts.escrow,
      abi: ESCROW_ABI,
      functionName,
      args,
      account: wallet.account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName} reverted in ${hash}`);
    }
    return hash;
  };

  const ERC20_ABI = [
    {
      type: "function",
      name: "symbol",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "string" }],
    },
    {
      type: "function",
      name: "decimals",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint8" }],
    },
  ] as const;
  let tokenInfo: Promise<TokenInfo> | null = null;

  return {
    chainId: BigInt(opts.chainId),
    escrow: opts.escrow,
    async fees() {
      const [burnBps, treasuryBps] = await Promise.all([
        read<number>("burnBps"),
        read<number>("treasuryBps"),
      ]);
      return { burnBps: Number(burnBps), treasuryBps: Number(treasuryBps) };
    },
    async status(roundId) {
      const [phase, frozen, count, balance, releaseAt] = await read<
        [number, boolean, bigint, bigint, bigint]
      >("status", [roundId]);
      return {
        phase: Number(phase) as RoundPhase,
        frozen,
        playerCount: Number(count),
        balance,
        releaseAt: BigInt(releaseAt),
      };
    },
    players: (roundId) => read<Address[]>("players", [roundId]),
    async owed(roundId, wallet) {
      const [deposit, payout] = await Promise.all([
        read<bigint>("deposits", [roundId, wallet]),
        read<bigint>("payouts", [roundId, wallet]),
      ]);
      return { deposit, payout };
    },
    token() {
      tokenInfo ??= (async () => {
        const address = await read<Address>("token");
        const [symbol, decimals] = await Promise.all([
          pub.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
          pub.readContract({
            address,
            abi: ERC20_ABI,
            functionName: "decimals",
          }),
        ]);
        return { address, symbol, decimals: Number(decimals) };
      })().catch((e: unknown) => {
        tokenInfo = null;
        throw e;
      });
      return tokenInfo;
    },
    async now() {
      return (await pub.getBlock({ blockTag: "latest" })).timestamp;
    },
    open: (roundId, stake, minPlayers, maxPlayers, fundingEnds, resultEnds) =>
      write("open", [
        roundId,
        stake,
        minPlayers,
        maxPlayers,
        fundingEnds,
        resultEnds,
      ]),
    start: (roundId) => write("start", [roundId]),
    cancel: (roundId) => write("cancel", [roundId]),
    propose: (roundId, amounts, replayHash, sig) =>
      write("propose", [
        roundId,
        [...amounts],
        replayHash,
        sig.v,
        sig.r,
        sig.s,
      ]),
    finalize: (roundId) => write("finalize", [roundId]),
  };
}
