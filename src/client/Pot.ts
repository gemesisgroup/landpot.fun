import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";
import {
  availableWallets,
  connectWallet,
  isUserRejection,
  signAndSend,
  WalletError,
  type Wallet,
  type WalletAccount,
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
  /** Allowed entry tiers for selectable-stake duels, token base units. */
  stakes?: string[];
  /** The escrow's cuts of the pot at settlement, basis points. */
  burnBps: number;
  treasuryBps: number;
  /** How long a result is held for review before it can be claimed, s. */
  reviewDelay: number;
  minPlayers: number;
  maxPlayers: number;
  /** The weekly Cup's hour of the week, UTC (0 = Sunday 00:00). */
  cupHourUTC?: number;
}

export interface PaidLobby {
  cup?: boolean;
  partner?: string;
  /** Whether the signed-in wallet's partner has paid (Cup). */
  partnerPaid?: boolean;
  /** Locked pairs so far (Cup). */
  pairs?: number;
  /** The escrow's cuts when this round opened; absent on older rounds. */
  burnBps?: number;
  treasuryBps?: number;
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
  /** refund_pending: a void result, refundable from releaseAt. */
  kind: "winnings" | "refund" | "refund_pending";
  amount: string;
  /** 2 Started, 3 Proposed (in review), 4 Final, 5 Refunding. */
  phase: number;
  releaseAt: number;
  frozen: boolean;
  /** Why a Cup round pays nothing out. */
  reason?: "tie" | "unverified" | "cancelled";
}

/** What a Cup invite link is for, and whether this wallet can accept it. */
export interface CupInvite {
  gameId: string;
  inviter: string;
  stake: string;
  burnBps: number;
  treasuryBps: number;
  fundingEnds: number;
  pairs: number;
  state:
    | "open"
    | "accepted"
    | "self"
    | "taken"
    | "you_paired"
    | "full"
    | "expired"
    | "revoked";
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

/** A Cup pair's winnings: each winner's share of a full 8-seat pot. */
export function cupPrize(
  stake: string,
  fees: Pick<PotConfig, "burnBps" | "treasuryBps">,
): { perWinner: bigint; profit: bigint } {
  const perWinner = netEntryPot(stake, 8, fees) / 2n;
  return { perWinner, profit: perWinner - BigInt(stake) };
}

/** The next start of the weekly Cup at `hourUTC` of the week, after `now`. */
export function nextCupStart(hourUTC: number, now: number): Date {
  const d = new Date(now);
  const weekStart = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - d.getUTCDay(),
  );
  const week = 7 * 86_400_000;
  let at = weekStart + hourUTC * 3_600_000;
  // The Cup hour itself still counts as "now": its lobby may be open.
  if (at + 3_600_000 <= now) at += week;
  return new Date(at);
}

const INVITE_PARAM = "cup_invite";

/** The invite link a player sends their partner. */
export function inviteLink(token: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(INVITE_PARAM, token);
  return url.toString();
}

/** The invite token in this page's address, if any. */
export function inviteTokenFromUrl(): string | null {
  return new URL(window.location.href).searchParams.get(INVITE_PARAM);
}

/** Drop the invite token from the address bar once it's dealt with. */
export function clearInviteFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(INVITE_PARAM)) return;
  url.searchParams.delete(INVITE_PARAM);
  history.replaceState(history.state, "", url.toString());
}

async function authed(path: string, body?: unknown): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: await getAuthHeader(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

/** This wallet's invite link token for a Cup round. */
export async function createInvite(gameId: string): Promise<string> {
  const res = await authed(`/public/pot/invite/${encodeURIComponent(gameId)}`);
  if (!res.ok) throw new Error(`invite ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export function readInvite(token: string, wallet?: string): Promise<CupInvite> {
  const q = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return get<CupInvite>(`/public/pot/invite/${encodeURIComponent(token)}${q}`);
}

/**
 * Confirm an invite. Resolves "ok", or the reason it can't be accepted
 * (the same states readInvite reports).
 */
export async function acceptInvite(token: string): Promise<string> {
  const res = await authed(
    `/public/pot/invite/${encodeURIComponent(token)}/accept`,
  );
  if (res.ok) return "ok";
  if (res.status === 404) return "revoked";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === "Registration closed") return "expired";
  return body.error ?? "failed";
}

/** "Play again with the same partner?" after a Cup match. */
export async function sendRematch(
  gameId: string,
  again: boolean,
): Promise<void> {
  await authed(`/public/pot/rematch/${encodeURIComponent(gameId)}`, {
    again,
  });
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

const CHAINS: Record<string, string> = {
  bsc: "eip155:56",
  "bsc-testnet": "eip155:97",
  "mainnet-beta": "solana:mainnet",
  devnet: "solana:devnet",
  localnet: "solana:localnet",
};

export function explorerTx(cluster: string, signature: string): string | null {
  if (cluster === "localnet") return null;
  if (cluster === "bsc") return `https://bscscan.com/tx/${signature}`;
  if (cluster === "bsc-testnet")
    return `https://testnet.bscscan.com/tx/${signature}`;
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
  lobby: Pick<PaidLobby, "gameId">,
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
