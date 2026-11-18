import { getApiBase } from "./Api";
import {
  availableWallets,
  discoverWallets,
  type Eip1193Provider,
} from "./Wallet";

/**
 * Paid matches, client side (docs/LandpotPot.md): read the open lobbies and
 * what the escrow owes you from the API; deposit and claim from your own
 * wallet, straight to the escrow contract. The server never touches funds.
 *
 * Kept free of viem at import time: the homepage loads this module, and the
 * ABI encoder is only fetched when a player actually pays or claims.
 */

export interface PotConfig {
  enabled: true;
  chainId: number;
  escrow: `0x${string}`;
  token: { address: `0x${string}`; symbol: string; decimals: number };
  /** Entry, token base units. */
  stake: string;
  minPlayers: number;
  maxPlayers: number;
}

export interface PaidLobby {
  gameId: string;
  roundId: `0x${string}`;
  stake: string;
  minPlayers: number;
  maxPlayers: number;
  /** Chain time, seconds. */
  fundingEnds: number;
  deposited: number;
  /** Whether the signed-in wallet has paid this lobby's entry. */
  joined: boolean;
}

export interface Claim {
  gameId: string;
  roundId: `0x${string}`;
  kind: "winnings" | "refund";
  amount: string;
  /** 3 Proposed (in review), 4 Final, 5 Refunding. */
  phase: number;
  releaseAt: number;
  frozen: boolean;
}

export const PHASE_PROPOSED = 3;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as T;
}

let configPromise: Promise<PotConfig | null> | null = null;

/** The escrow, token and entry; null when paid matches are off. */
export function potConfig(): Promise<PotConfig | null> {
  configPromise ??= get<PotConfig | { enabled: false }>("/public/pot/config")
    .then((c) => (c.enabled ? c : null))
    .catch(() => {
      configPromise = null;
      return null;
    });
  return configPromise;
}

export async function paidLobbies(wallet?: string): Promise<PaidLobby[]> {
  const q = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return (await get<{ lobbies: PaidLobby[] }>(`/public/pot/lobbies${q}`))
    .lobbies;
}

export async function potClaims(wallet: string): Promise<Claim[]> {
  return (
    await get<{ claims: Claim[] }>(
      `/public/pot/claims/${encodeURIComponent(wallet)}`,
    )
  ).claims;
}

/** 1500000000000000000 with 18 decimals → "1.5". */
export function formatUnits(value: string | bigint, decimals: number): string {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, 4);
  const trimmed = frac.replace(/0+$/, "");
  return trimmed
    ? `${whole.toLocaleString("en-US")}.${trimmed}`
    : whole.toLocaleString("en-US");
}

// ── the wallet side ──

export type PotStep = "switching" | "approving" | "depositing" | "claiming";

export type PotErrorKind =
  | "rejected" // the player declined in the wallet
  | "wrong_account" // the wallet's account is not the one signed in
  | "no_wallet"
  | "balance" // not enough tokens
  | "failed";

export class PotTxError extends Error {
  constructor(
    readonly kind: PotErrorKind,
    detail?: string,
  ) {
    super(detail ?? kind);
  }
}

const KNOWN_CHAINS: Record<
  number,
  { name: string; rpc: string; explorer: string }
> = {
  8453: {
    name: "Base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  84532: {
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
};

export function explorerTx(chainId: number, hash: string): string | null {
  const c = KNOWN_CHAINS[chainId];
  return c ? `${c.explorer}/tx/${hash}` : null;
}

function isRejection(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 4001 || code === "ACTION_REJECTED";
}

async function rpc<T>(
  provider: Eip1193Provider,
  method: string,
  params?: unknown[],
): Promise<T> {
  try {
    return (await provider.request({ method, params })) as T;
  } catch (e) {
    if (isRejection(e)) throw new PotTxError("rejected");
    throw e;
  }
}

/**
 * The wallet holding the signed-in address. Asks without a prompt first;
 * if none has it unlocked, asks the only (or first) wallet to connect, and
 * refuses another account: a deposit from it would not get a seat.
 */
export async function walletFor(address: string): Promise<Eip1193Provider> {
  discoverWallets();
  const wanted = address.toLowerCase();
  const wallets = availableWallets();
  if (wallets.length === 0) throw new PotTxError("no_wallet");
  for (const w of wallets) {
    const accounts = await w.provider
      .request({ method: "eth_accounts" })
      .catch(() => []);
    if (
      Array.isArray(accounts) &&
      accounts.some((a) => String(a).toLowerCase() === wanted)
    ) {
      return w.provider;
    }
  }
  const provider = wallets[0].provider;
  const accounts = await rpc<string[]>(provider, "eth_requestAccounts");
  if (!accounts.some((a) => a.toLowerCase() === wanted)) {
    throw new PotTxError("wrong_account");
  }
  return provider;
}

async function ensureChain(provider: Eip1193Provider, chainId: number) {
  const current = Number.parseInt(
    await rpc<string>(provider, "eth_chainId"),
    16,
  );
  if (current === chainId) return;
  const hex = `0x${chainId.toString(16)}`;
  try {
    await rpc(provider, "wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (e) {
    // 4902: the wallet does not know this chain yet.
    const known = KNOWN_CHAINS[chainId];
    if ((e as { code?: unknown }).code !== 4902 || !known) throw e;
    await rpc(provider, "wallet_addEthereumChain", [
      {
        chainId: hex,
        chainName: known.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [known.rpc],
        blockExplorerUrls: [known.explorer],
      },
    ]);
  }
}

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const ESCROW_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }],
    outputs: [],
  },
] as const;

async function readUint(
  provider: Eip1193Provider,
  to: string,
  data: `0x${string}`,
): Promise<bigint> {
  const out = await rpc<string>(provider, "eth_call", [{ to, data }, "latest"]);
  return BigInt(out === "0x" ? 0 : out);
}

async function sendTx(
  provider: Eip1193Provider,
  from: string,
  to: string,
  data: `0x${string}`,
): Promise<string> {
  const hash = await rpc<string>(provider, "eth_sendTransaction", [
    { from, to, data },
  ]);
  // Wait for it to be mined: the next step depends on it.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ status?: string } | null>(
      provider,
      "eth_getTransactionReceipt",
      [hash],
    ).catch(() => null);
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new PotTxError("failed", `transaction ${hash} reverted`);
      }
      return hash;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PotTxError("failed", `transaction ${hash} was not mined in time`);
}

/**
 * Pay a lobby's entry: switch to the escrow's chain, approve the entry if
 * the allowance is short, then deposit. Resolves with the deposit's hash.
 */
export async function payEntry(
  address: string,
  config: PotConfig,
  lobby: PaidLobby,
  onStep: (step: PotStep) => void,
): Promise<string> {
  const { encodeFunctionData } = await import("viem");
  const provider = await walletFor(address);
  onStep("switching");
  await ensureChain(provider, config.chainId);
  const stake = BigInt(lobby.stake);
  const token = config.token.address;
  const balance = await readUint(
    provider,
    token,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }),
  );
  if (balance < stake) throw new PotTxError("balance");
  const allowance = await readUint(
    provider,
    token,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address as `0x${string}`, config.escrow],
    }),
  );
  if (allowance < stake) {
    onStep("approving");
    // Exactly one entry: the escrow can never pull more than you chose to pay.
    await sendTx(
      provider,
      address,
      token,
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [config.escrow, stake],
      }),
    );
  }
  onStep("depositing");
  return sendTx(
    provider,
    address,
    config.escrow,
    encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "deposit",
      args: [lobby.roundId],
    }),
  );
}

/** Claim winnings or a refund for one round. */
export async function claimRound(
  address: string,
  config: PotConfig,
  roundId: `0x${string}`,
  onStep: (step: PotStep) => void,
): Promise<string> {
  const { encodeFunctionData } = await import("viem");
  const provider = await walletFor(address);
  onStep("switching");
  await ensureChain(provider, config.chainId);
  onStep("claiming");
  return sendTx(
    provider,
    address,
    config.escrow,
    encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "claim",
      args: [roundId],
    }),
  );
}
