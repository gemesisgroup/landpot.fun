import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";
import {
  availableWallets,
  connectWallet,
  isUserRejection,
  signAndSend,
  WalletError,
} from "./Wallet";

/**
 * Paid matches, client side (docs/LandpotPot.md): read the open lobbies and
 * what the escrow owes you from the API; deposit and claim from your own
 * wallet, straight to the escrow program. The API builds the unsigned
 * transaction; your wallet shows it, signs it and sends it. The server never
 * holds funds or keys that can move them.
 */

export interface PotConfig {
  enabled: true;
  /** "mainnet-beta", "devnet" or "localnet". */
  cluster: string;
  /** The escrow program id. */
  program: string;
  token: { address: string; symbol: string; decimals: number };
  /** Entry, token base units. */
  stake: string;
  /** The escrow's cuts of the pot at settlement, basis points. */
  burnBps: number;
  treasuryBps: number;
  minPlayers: number;
  maxPlayers: number;
}

export interface PaidLobby {
  cup?: boolean;
  partner?: string;
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

export function netEntryPot(
  stake: string,
  seats: number,
  config: Pick<PotConfig, "burnBps" | "treasuryBps">,
): bigint {
  const gross = BigInt(stake) * BigInt(seats);
  return (
    gross -
    (gross * BigInt(config.burnBps)) / 10_000n -
    (gross * BigInt(config.treasuryBps)) / 10_000n
  );
}

export async function nominatePartner(
  gameId: string,
  partner: string,
): Promise<void> {
  const res = await fetch(
    `${getApiBase()}/public/pot/partner/${encodeURIComponent(gameId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ partner }),
    },
  );
  if (!res.ok) throw new Error("Registration failed");
}

export async function potClaims(wallet: string): Promise<Claim[]> {
  return (
    await get<{ claims: Claim[] }>(
      `/public/pot/claims/${encodeURIComponent(wallet)}`,
    )
  ).claims;
}

/** 1500000 with 6 decimals → "1.5". */
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

export type PotStep = "switching" | "depositing" | "claiming";

export type PotErrorKind =
  | "rejected" // the player declined in the wallet
  | "wrong_account" // the wallet's account is not the one signed in
  | "no_wallet"
  | "balance" // not enough tokens
  | "busy" // the chain's RPC is rate-limiting the API; nothing was sent
  | "failed";

export class PotTxError extends Error {
  constructor(
    readonly kind: PotErrorKind,
    detail?: string,
  ) {
    super(detail ?? kind);
  }
}

/** Wallet Standard chain ids. */
const CHAINS: Record<string, string> = {
  "mainnet-beta": "solana:mainnet",
  devnet: "solana:devnet",
  localnet: "solana:localnet",
};

export function explorerTx(cluster: string, signature: string): string | null {
  if (cluster === "localnet") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}

/**
 * The wallet holding the signed-in address. Looks for one already connected
 * to it, then asks each to connect; refuses another account: a deposit from
 * it would not get a seat.
 */
export async function walletFor(
  address: string,
): Promise<{ wallet: Wallet; account: WalletAccount }> {
  const wallets = availableWallets();
  if (wallets.length === 0) throw new PotTxError("no_wallet");
  for (const { wallet } of wallets) {
    const account = wallet.accounts.find((a) => a.address === address);
    if (account) return { wallet, account };
  }
  for (const { wallet } of wallets) {
    const account = await connectWallet(wallet, true).catch(() => null);
    if (account?.address === address) return { wallet, account };
  }
  let account: WalletAccount;
  try {
    account = await connectWallet(wallets[0].wallet);
  } catch (e) {
    throw new PotTxError(
      e instanceof WalletError && e.kind === "rejected" ? "rejected" : "failed",
    );
  }
  if (account.address !== address) throw new PotTxError("wrong_account");
  return { wallet: wallets[0].wallet, account };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 402) throw new PotTxError("balance");
  if (res.status === 503) throw new PotTxError("busy");
  if (!res.ok) throw new PotTxError("failed", `api ${res.status}`);
  return (await res.json()) as T;
}

/** Wait until the cluster has confirmed it: the next step depends on it. */
async function confirmed(signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { status } = await get<{ status: string }>(
      `/public/pot/tx/${signature}`,
    ).catch(() => ({ status: "pending" }));
    if (status === "confirmed") return;
    if (status === "failed") {
      throw new PotTxError("failed", `transaction ${signature} failed`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new PotTxError("failed", `transaction ${signature} not confirmed`);
}

async function send(
  kind: "deposit" | "claim",
  address: string,
  config: PotConfig,
  gameId: string,
  onStep: (step: PotStep) => void,
): Promise<string> {
  onStep("switching");
  const { wallet, account } = await walletFor(address);
  const { transaction } = await post<{ transaction: string }>(
    `/public/pot/${kind}-tx`,
    { gameId, wallet: address },
  );
  onStep(kind === "deposit" ? "depositing" : "claiming");
  const bytes = Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0));
  let signature: string;
  try {
    signature = await signAndSend(
      wallet,
      account,
      bytes,
      CHAINS[config.cluster] ?? "solana:mainnet",
    );
  } catch (e) {
    console.warn(`${kind} not sent`, e);
    throw new PotTxError(isUserRejection(e) ? "rejected" : "failed");
  }
  await confirmed(signature);
  return signature;
}

/** Pay a lobby's entry. Resolves with the transaction's signature. */
export function payEntry(
  address: string,
  config: PotConfig,
  lobby: PaidLobby,
  onStep: (step: PotStep) => void,
): Promise<string> {
  return send("deposit", address, config, lobby.gameId, onStep);
}

/** Claim winnings or a refund for one round. */
export function claimRound(
  address: string,
  config: PotConfig,
  gameId: string,
  onStep: (step: PotStep) => void,
): Promise<string> {
  return send("claim", address, config, gameId, onStep);
}
