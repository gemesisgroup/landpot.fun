import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex as ViemHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import {
  InsufficientBalanceError,
  RoundPhase,
  type EscrowChain,
  type RoundStatus,
  type TokenInfo,
} from "./EscrowChain";
import { LANDPOT_ESCROW_ABI } from "./LandpotEscrowAbi";
import type { Hex } from "./RoundId";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface EvmTxPayload {
  kind: "evm";
  chainId: number;
  to: Address;
  data: ViemHex;
  approve?: {
    to: Address;
    data: ViemHex;
  };
}

export interface BscEscrowConfig {
  rpcUrl: string;
  /** "bsc" (mainnet, 56) or "bsc-testnet" (97). */
  cluster: "bsc" | "bsc-testnet";
  contractAddress: Address;
  operatorPrivateKey: ViemHex;
  oraclePrivateKey: ViemHex;
}

/**
 * Non-custodial BNB Smart Chain (BSC) escrow talking to `LandpotEscrow.sol`
 * via `viem`. Implements the exact `EscrowChain` contract used by `PotService`.
 */
export class BscEscrow implements EscrowChain {
  readonly cluster: string;
  readonly escrow: string;

  private readonly chain: typeof bsc | typeof bscTestnet;
  private readonly address: Address;
  private readonly publicClient;
  private readonly operatorWallet;
  private readonly oracleAccount;

  private feesCache: {
    burnBps: number;
    treasuryBps: number;
    reviewDelay: number;
  } | null = null;
  private tokenCache: TokenInfo | null = null;

  constructor(cfg: BscEscrowConfig) {
    this.cluster = cfg.cluster;
    this.chain = cfg.cluster === "bsc" ? bsc : bscTestnet;
    this.address = getAddress(cfg.contractAddress);
    this.escrow = this.address;

    const transport = http(cfg.rpcUrl, { retryCount: 3, timeout: 15_000 });
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    const operatorAccount = privateKeyToAccount(cfg.operatorPrivateKey);
    this.operatorWallet = createWalletClient({
      account: operatorAccount,
      chain: this.chain,
      transport,
    });
    this.oracleAccount = privateKeyToAccount(cfg.oraclePrivateKey);
  }

  async fees() {
    if (this.feesCache) return this.feesCache;
    const [burnBps, treasuryBps, reviewDelay] = await Promise.all([
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "burnBps",
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "treasuryBps",
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "reviewDelay",
      }),
    ]);
    this.feesCache = {
      burnBps: Number(burnBps),
      treasuryBps: Number(treasuryBps),
      reviewDelay: Number(reviewDelay),
    };
    return this.feesCache;
  }

  async token(): Promise<TokenInfo> {
    if (this.tokenCache) return this.tokenCache;
    const tokenAddr = await this.publicClient.readContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "token",
    });
    const [symbol, decimals] = await Promise.all([
      this.publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      this.publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);
    this.tokenCache = {
      address: getAddress(tokenAddr),
      symbol: symbol || "LANDPOT",
      decimals: Number(decimals),
    };
    return this.tokenCache;
  }

  async now(): Promise<bigint> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp;
  }

  async status(roundId: Hex): Promise<RoundStatus> {
    const r = await this.publicClient.readContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "getRound",
      args: [roundId],
    });
    return {
      phase: Number(r[0]) as RoundPhase,
      frozen: r[1],
      playerCount: Number(r[9]),
      balance: r[8],
      releaseAt: r[6],
    };
  }

  async players(roundId: Hex): Promise<string[]> {
    const list = await this.publicClient.readContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "getPlayers",
      args: [roundId],
    });
    return list.map((a) => getAddress(a));
  }

  async owed(
    roundId: Hex,
    wallet: string,
  ): Promise<{ deposit: bigint; payout: bigint }> {
    const addr = getAddress(wallet);
    const [deposit, payout] = await Promise.all([
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "deposits",
        args: [roundId, addr],
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "payouts",
        args: [roundId, addr],
      }),
    ]);
    return { deposit, payout };
  }

  async open(
    roundId: Hex,
    stake: bigint,
    minPlayers: number,
    maxPlayers: number,
    fundingEnds: bigint,
    resultEnds: bigint,
  ): Promise<string> {
    const hash = await this.operatorWallet.writeContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "open",
      args: [roundId, stake, minPlayers, maxPlayers, fundingEnds, resultEnds],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async start(roundId: Hex): Promise<string> {
    const hash = await this.operatorWallet.writeContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "start",
      args: [roundId],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async cancel(roundId: Hex): Promise<string> {
    const hash = await this.operatorWallet.writeContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "cancel",
      args: [roundId],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async propose(
    roundId: Hex,
    amounts: readonly bigint[],
    replayHash: Hex,
  ): Promise<string> {
    const amountsHash = keccak256(
      encodePacked(
        amounts.map(() => "uint256" as const),
        [...amounts],
      ),
    );
    const digest = keccak256(
      encodePacked(
        ["string", "uint256", "address", "bytes32", "bytes32", "bytes32"],
        [
          "landpot:propose",
          BigInt(this.chain.id),
          this.address,
          roundId,
          replayHash,
          amountsHash,
        ],
      ),
    );
    const oracleSig = await this.oracleAccount.signMessage({
      message: { raw: digest },
    });
    const hash = await this.operatorWallet.writeContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "propose",
      args: [roundId, [...amounts], replayHash, oracleSig],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async finalize(roundId: Hex): Promise<string> {
    const hash = await this.operatorWallet.writeContract({
      address: this.address,
      abi: LANDPOT_ESCROW_ABI,
      functionName: "finalize",
      args: [roundId],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async close(_roundId: Hex): Promise<string> {
    // EVM contracts have no per-round rent to reclaim.
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  }

  async depositTx(roundId: Hex, wallet: string): Promise<string> {
    const player = getAddress(wallet);
    const [tok, r] = await Promise.all([
      this.token(),
      this.publicClient.readContract({
        address: this.address,
        abi: LANDPOT_ESCROW_ABI,
        functionName: "getRound",
        args: [roundId],
      }),
    ]);
    const stake = r[7];
    const tokenAddr = getAddress(tok.address);
    const [bal, allowance] = await Promise.all([
      this.publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [player],
      }),
      this.publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [player, this.address],
      }),
    ]);
    if (bal < stake) {
      throw new InsufficientBalanceError();
    }

    const payload: EvmTxPayload = {
      kind: "evm",
      chainId: this.chain.id,
      to: this.address,
      data: encodeFunctionData({
        abi: LANDPOT_ESCROW_ABI,
        functionName: "deposit",
        args: [roundId],
      }),
    };
    if (allowance < stake) {
      payload.approve = {
        to: tokenAddr,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [this.address, stake],
        }),
      };
    }
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  async claimTx(roundId: Hex, _wallet: string): Promise<string> {
    const payload: EvmTxPayload = {
      kind: "evm",
      chainId: this.chain.id,
      to: this.address,
      data: encodeFunctionData({
        abi: LANDPOT_ESCROW_ABI,
        functionName: "claim",
        args: [roundId],
      }),
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  async txStatus(signature: string): Promise<"confirmed" | "failed" | "pending"> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: signature as ViemHex,
      });
      return receipt.status === "success" ? "confirmed" : "failed";
    } catch {
      return "pending";
    }
  }
}
