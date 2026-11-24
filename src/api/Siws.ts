import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { randomBytes } from "node:crypto";
import { isAddress as isEvmAddress, verifyMessage, type Address, type Hex } from "viem";
import { isPublicKey } from "./ApiEnv";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function isAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("0x")) return isEvmAddress(value, { strict: false });
  return isPublicKey(value);
}

export function newNonce(): string {
  return randomBytes(12).toString("hex");
}

export function buildSiwsMessage(opts: {
  siteOrigin: string;
  address: string;
  /** "bsc", "bsc-testnet", "mainnet", "devnet" or "localnet". */
  chainId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const url = new URL(opts.siteOrigin);
  const isEvm = opts.address.startsWith("0x");
  const chainLabel = isEvm ? "BNB Chain" : "Solana";
  const chainValue =
    opts.chainId === "bsc"
      ? "56"
      : opts.chainId === "bsc-testnet"
        ? "97"
        : opts.chainId;
  return [
    `${url.host} wants you to sign in with your ${chainLabel} account:`,
    opts.address,
    "",
    "Sign in to Landpot. This request will not trigger a blockchain transaction or cost any fees.",
    "",
    `URI: ${url.origin}`,
    "Version: 1",
    `Chain ID: ${chainValue}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt.toISOString()}`,
    `Expiration Time: ${opts.expiresAt.toISOString()}`,
  ].join("\n");
}

/** Pull the nonce back out of a message this server built. */
export function nonceOf(message: string): string | null {
  const m = /\nNonce: ([0-9a-f]{24})\n/.exec(message);
  return m ? m[1] : null;
}

/**
 * Verifies either an EVM EIP-191 `personal_sign` signature (0x... address) or
 * a Solana ed25519 signature (base58 address).
 */
export async function verifySignature(
  message: string,
  signature: string,
  address: string,
): Promise<boolean> {
  try {
    if (address.startsWith("0x")) {
      if (!isEvmAddress(address, { strict: false }) || !signature.startsWith("0x")) {
        return false;
      }
      return await verifyMessage({
        address: address as Address,
        message,
        signature: signature as Hex,
      });
    }
    const sig = base58.decode(signature);
    const key = base58.decode(address);
    if (sig.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), key, {
      zip215: false,
    });
  } catch {
    return false;
  }
}
