import { base58 } from "@scure/base";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

/**
 * Solana wallets for Landpot (docs/LandpotAPI.md).
 *
 * Wallets are found through Wallet Standard (Phantom, Solflare, Backpack…
 * each register themselves, so several can coexist). Signing in is: connect,
 * fetch a server-written Sign-In With Solana message, sign it with
 * `solana:signMessage`, send it back. The server then sets the refresh
 * cookie for the wallet's account, and the page reloads into it, the same
 * way the other sign-ins in Auth.ts finish.
 */

/** Dispatched on window to open the wallet picker (any "Sign in" button). */
export const CONNECT_WALLET_EVENT = "landpot:connect-wallet";

const CONNECT = "standard:connect";
const SIGN_MESSAGE = "solana:signMessage";
const SIGN_AND_SEND = "solana:signAndSendTransaction";

interface ConnectFeature {
  connect(input?: {
    silent?: boolean;
  }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
}
interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: {
      account: WalletAccount;
      transaction: Uint8Array;
      chain: string;
    }[]
  ): Promise<{ signature: Uint8Array }[]>;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
}

export interface WalletOption {
  info: WalletInfo;
  wallet: Wallet;
}

/** A wallet that can sign in and pay: the three features Landpot uses. */
function usable(w: Wallet): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    CONNECT in w.features &&
    SIGN_MESSAGE in w.features &&
    SIGN_AND_SEND in w.features
  );
}

/**
 * Listen for wallets registering; returns a function that stops calling
 * `onChange`. Wallet Standard keeps the registry itself.
 */
export function discoverWallets(onChange?: () => void): () => void {
  if (!onChange) return () => {};
  const { on } = getWallets();
  const offRegister = on("register", onChange);
  const offUnregister = on("unregister", onChange);
  return () => {
    offRegister();
    offUnregister();
  };
}

/** Every Solana wallet that has registered so far. */
export function availableWallets(): WalletOption[] {
  return getWallets()
    .get()
    .filter(usable)
    .map((wallet) => ({
      info: { uuid: wallet.name, name: wallet.name, icon: wallet.icon },
      wallet,
    }));
}

export type WalletSignInError =
  | "rejected" // the player closed or declined the wallet prompt
  | "failed"; // anything else: network, server, malformed answer

export class WalletError extends Error {
  constructor(readonly kind: WalletSignInError) {
    super(kind);
  }
}

/** Wallets reject with EIP-1193's 4001, or at least say so. */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; name?: unknown } | null;
  return (
    err?.code === 4001 ||
    err?.name === "WalletSignMessageError" ||
    /reject|declin|cancel/i.test(String(err?.message ?? ""))
  );
}

function feature<T>(wallet: Wallet, name: `${string}:${string}`): T {
  const f = wallet.features[name] as T | undefined;
  if (!f) throw new WalletError("failed");
  return f;
}

/** Connect and return the wallet's first account (prompts if needed). */
export async function connectWallet(
  wallet: Wallet,
  silent = false,
): Promise<WalletAccount> {
  if (wallet.accounts.length > 0) return wallet.accounts[0];
  let accounts: readonly WalletAccount[];
  try {
    ({ accounts } = await feature<ConnectFeature>(wallet, CONNECT).connect(
      silent ? { silent } : undefined,
    ));
  } catch (e) {
    throw new WalletError(isUserRejection(e) ? "rejected" : "failed");
  }
  const account = accounts[0];
  if (!account) throw new WalletError("failed");
  return account;
}

/** Sign and send a transaction (serialized bytes); its signature, base58. */
export async function signAndSend(
  wallet: Wallet,
  account: WalletAccount,
  transaction: Uint8Array,
  chain: string,
): Promise<string> {
  const [out] = await feature<SignAndSendFeature>(
    wallet,
    SIGN_AND_SEND,
  ).signAndSendTransaction({ account, transaction, chain });
  return base58.encode(out.signature);
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const auth = await getAuthHeader();
  if (!auth) throw new WalletError("failed");
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", authorization: auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) throw new WalletError("failed");
  return (await res.json()) as T;
}

/**
 * Sign in with a wallet. Resolves once the server has switched this browser's
 * session to the wallet's account; the caller reloads the page.
 */
export async function signInWithWallet(wallet: Wallet): Promise<string> {
  const account = await connectWallet(wallet);
  const { message } = await api<{ message: string }>("/auth/wallet/challenge", {
    address: account.address,
  });
  let signature: Uint8Array;
  try {
    [{ signature }] = await feature<SignMessageFeature>(
      wallet,
      SIGN_MESSAGE,
    ).signMessage({ account, message: new TextEncoder().encode(message) });
  } catch (e) {
    throw new WalletError(isUserRejection(e) ? "rejected" : "failed");
  }
  const verified = await api<{ address: string }>("/auth/wallet/verify", {
    message,
    signature: base58.encode(signature),
  });
  return verified.address;
}

/** 7xKX…AsU4 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
