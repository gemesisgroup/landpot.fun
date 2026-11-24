import { getAddress } from "viem";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

/**
 * EVM / BNB Smart Chain (BSC) wallets for Landpot.
 *
 * Discovers installed browser wallets via EIP-6963 (MetaMask, Rabby, Trust
 * Wallet, OKX Wallet, Binance Web3 Wallet, Coinbase Wallet...) with a fallback
 * to `window.ethereum`. Signing in uses EIP-4361 / `personal_sign`, and paid
 * matches use `eth_sendTransaction` (with automatic BSC chain switching and
 * BEP-20 `approve` when needed).
 */

/** Dispatched on window to open the wallet picker (any "Sign in" button). */
export const CONNECT_WALLET_EVENT = "landpot:connect-wallet";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletAccount {
  address: string;
}

export interface Wallet {
  name: string;
  icon: string;
  provider: Eip1193Provider;
  accounts: WalletAccount[];
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
}

export interface WalletOption {
  info: WalletInfo;
  wallet: Wallet;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns?: string };
  provider: Eip1193Provider;
}

const discovered = new Map<string, WalletOption>();
const listeners = new Set<() => void>();
let discoveryStarted = false;

function notify() {
  for (const fn of listeners) fn();
}

function startDiscovery() {
  if (discoveryStarted || typeof window === "undefined") return;
  discoveryStarted = true;
  window.addEventListener("eip6963:announceProvider", (ev: Event) => {
    const detail = (ev as CustomEvent<Eip6963Detail>).detail;
    if (!detail?.provider || !detail?.info?.uuid) return;
    if (discovered.has(detail.info.uuid)) return;
    const wallet: Wallet = {
      name: detail.info.name,
      icon: detail.info.icon,
      provider: detail.provider,
      accounts: [],
    };
    discovered.set(detail.info.uuid, {
      info: {
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
      },
      wallet,
    });
    notify();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Listen for EVM wallets announcing themselves via EIP-6963. */
export function discoverWallets(onChange?: () => void): () => void {
  startDiscovery();
  if (!onChange) return () => {};
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

const FALLBACK_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#f3ba2f"/><path d="M16 7l3.2 3.2-6 6L10 13l6-6zm6 6l3.2 3.2-9.2 9.2-9.2-9.2L10 13l6 6 6-6z" fill="#0b0e11"/></svg>',
  );

/** Every EVM wallet discovered so far (with `window.ethereum` fallback). */
export function availableWallets(): WalletOption[] {
  startDiscovery();
  if (discovered.size > 0) {
    return [...discovered.values()];
  }
  const eth = (globalThis as unknown as { ethereum?: Eip1193Provider })
    .ethereum;
  if (!eth) return [];
  const wallet: Wallet = {
    name: "Browser Wallet (BSC)",
    icon: FALLBACK_ICON,
    provider: eth,
    accounts: [],
  };
  return [
    {
      info: { uuid: "injected-ethereum", name: wallet.name, icon: wallet.icon },
      wallet,
    },
  ];
}

export type WalletSignInError = "rejected" | "failed";

export class WalletError extends Error {
  constructor(readonly kind: WalletSignInError) {
    super(kind);
  }
}

/** Wallets reject with EIP-1193's 4001, or say so in the message. */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; name?: unknown } | null;
  return (
    err?.code === 4001 ||
    /reject|declin|cancel|denied/i.test(String(err?.message ?? ""))
  );
}

/** Connect and return the wallet's checksummed EVM account. */
export async function connectWallet(
  wallet: Wallet,
  silent = false,
): Promise<WalletAccount> {
  if (wallet.accounts.length > 0) return wallet.accounts[0];
  let raw: unknown;
  try {
    raw = await wallet.provider.request({
      method: silent ? "eth_accounts" : "eth_requestAccounts",
    });
  } catch (e) {
    throw new WalletError(isUserRejection(e) ? "rejected" : "failed");
  }
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  if (!list[0]) throw new WalletError("failed");
  const account: WalletAccount = { address: getAddress(list[0]) };
  wallet.accounts = [account];
  return account;
}

const BSC_CHAINS: Record<
  number,
  {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    blockExplorerUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
  }
> = {
  56: {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    blockExplorerUrls: ["https://bscscan.com"],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  },
  97: {
    chainId: "0x61",
    chainName: "BNB Smart Chain Testnet",
    rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
    blockExplorerUrls: ["https://testnet.bscscan.com"],
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  },
};

async function ensureChain(provider: Eip1193Provider, chainId: number) {
  const hexId = `0x${chainId.toString(16)}`;
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === hexId.toLowerCase()) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (e) {
    const code = (e as { code?: number })?.code;
    const cfg = BSC_CHAINS[chainId];
    if (code === 4902 && cfg) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [cfg],
      });
    } else {
      throw e;
    }
  }
}

async function waitForReceipt(provider: Eip1193Provider, hash: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("Approval transaction reverted");
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("Approval transaction timed out");
}

interface EvmTxPayload {
  kind: "evm";
  chainId: number;
  to: string;
  data: string;
  approve?: { to: string; data: string };
}

/** Sign and send an EVM transaction payload (JSON-encoded bytes); returns tx hash. */
export async function signAndSend(
  wallet: Wallet,
  account: WalletAccount,
  transaction: Uint8Array,
  _chain: string,
): Promise<string> {
  const payload = JSON.parse(
    new TextDecoder().decode(transaction),
  ) as EvmTxPayload;
  await ensureChain(wallet.provider, payload.chainId);

  if (payload.approve) {
    const approveHash = (await wallet.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account.address,
          to: payload.approve.to,
          data: payload.approve.data,
        },
      ],
    })) as string;
    await waitForReceipt(wallet.provider, approveHash);
  }

  const txHash = (await wallet.provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: account.address,
        to: payload.to,
        data: payload.data,
      },
    ],
  })) as string;
  return txHash;
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
 * Sign in with an EVM wallet (`personal_sign`). Resolves once the server has
 * switched this browser's session to the wallet's account.
 */
export async function signInWithWallet(wallet: Wallet): Promise<string> {
  const account = await connectWallet(wallet);
  const { message } = await api<{ message: string }>("/auth/wallet/challenge", {
    address: account.address,
  });
  let signature: string;
  try {
    signature = (await wallet.provider.request({
      method: "personal_sign",
      params: [message, account.address],
    })) as string;
  } catch (e) {
    throw new WalletError(isUserRejection(e) ? "rejected" : "failed");
  }
  const verified = await api<{ address: string }>("/auth/wallet/verify", {
    message,
    signature,
  });
  return verified.address;
}

/** 0x71C7…89A2 */
export function shortAddress(address: string): string {
  return address.startsWith("0x")
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
