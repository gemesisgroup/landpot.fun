import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

/**
 * Wallet sign-in for Landpot (docs/LandpotAPI.md).
 *
 * Wallets are found through EIP-6963 (each injected wallet announces itself,
 * so several can coexist), with the legacy `window.ethereum` as a fallback.
 * Signing in is: ask for the account, fetch a server-written EIP-4361
 * message, sign it with `personal_sign`, send it back. The server then sets
 * the refresh cookie for the wallet's account, and the page reloads into it,
 * the same way the other sign-ins in Auth.ts finish.
 */

/** Dispatched on window to open the wallet picker (any "Sign in" button). */
export const CONNECT_WALLET_EVENT = "landpot:connect-wallet";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string;
}

export interface WalletOption {
  info: WalletInfo;
  provider: Eip1193Provider;
}

const announced = new Map<string, WalletOption>();
const listeners = new Set<() => void>();
let listening = false;

function onAnnounce(event: Event): void {
  const detail = (event as CustomEvent<WalletOption>).detail;
  if (!detail?.info?.uuid || typeof detail.provider?.request !== "function") {
    return;
  }
  // Keyed by rdns so a wallet that re-announces does not show twice.
  announced.set(detail.info.rdns || detail.info.uuid, {
    info: detail.info,
    provider: detail.provider,
  });
  listeners.forEach((fn) => fn());
}

/** Start listening and ask the installed wallets to announce themselves. */
export function discoverWallets(onChange?: () => void): () => void {
  if (!listening) {
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    listening = true;
  }
  if (onChange) listeners.add(onChange);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => {
    if (onChange) listeners.delete(onChange);
  };
}

/** Every wallet found so far; the legacy injected provider if none announced. */
export function availableWallets(): WalletOption[] {
  if (announced.size > 0) return [...announced.values()];
  const legacy = (window as { ethereum?: Eip1193Provider }).ethereum;
  if (legacy && typeof legacy.request === "function") {
    return [
      {
        info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "" },
        provider: legacy,
      },
    ];
  }
  return [];
}

export type WalletSignInError =
  | "rejected" // the player closed or declined the wallet prompt
  | "failed"; // anything else: network, server, malformed answer

export class WalletError extends Error {
  constructor(readonly kind: WalletSignInError) {
    super(kind);
  }
}

// EIP-1193: 4001 is "user rejected the request".
function isUserRejection(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 4001 || code === "ACTION_REJECTED";
}

async function walletCall<T>(
  provider: Eip1193Provider,
  method: string,
  params?: unknown[],
): Promise<T> {
  try {
    return (await provider.request({ method, params })) as T;
  } catch (e) {
    throw new WalletError(isUserRejection(e) ? "rejected" : "failed");
  }
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
export async function signInWithWallet(
  provider: Eip1193Provider,
): Promise<string> {
  const accounts = await walletCall<string[]>(provider, "eth_requestAccounts");
  const address = accounts?.[0];
  if (typeof address !== "string") throw new WalletError("failed");
  const chainHex = await walletCall<string>(provider, "eth_chainId");
  const chainId = Number.parseInt(chainHex, 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WalletError("failed");
  }

  const { message } = await api<{ message: string }>("/auth/wallet/challenge", {
    address,
    chainId,
  });
  // personal_sign takes the message as hex so every wallet signs the exact
  // UTF-8 bytes, whatever it does with plain strings.
  const hex =
    "0x" +
    [...new TextEncoder().encode(message)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const signature = await walletCall<string>(provider, "personal_sign", [
    hex,
    address,
  ]);
  const verified = await api<{ address: string }>("/auth/wallet/verify", {
    message,
    signature,
  });
  return verified.address;
}

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
