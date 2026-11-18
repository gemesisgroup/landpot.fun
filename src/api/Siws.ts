import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { randomBytes } from "node:crypto";
import { isPublicKey } from "./ApiEnv";

/**
 * Sign-In With Solana: the EIP-4361 message shape Solana wallets show for
 * "sign in", signed with the wallet's ed25519 key through Wallet Standard
 * `solana:signMessage`.
 *
 * The server writes the whole message and keeps it with the nonce, then
 * verifies the signature against exactly that text. Nothing the client sends
 * is parsed back into fields, so domain, URI, cluster and expiry cannot be
 * tampered with: changing any byte breaks the signature or the lookup.
 * Addresses are base58 public keys and case-sensitive: compared exactly.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && isPublicKey(value);
}

export function newNonce(): string {
  return randomBytes(12).toString("hex");
}

export function buildSiwsMessage(opts: {
  siteOrigin: string;
  address: string;
  /** "mainnet", "devnet" or "localnet". */
  chainId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const url = new URL(opts.siteOrigin);
  return [
    `${url.host} wants you to sign in with your Solana account:`,
    opts.address,
    "",
    "Sign in to Landpot. This request will not trigger a blockchain transaction or cost any fees.",
    "",
    `URI: ${url.origin}`,
    "Version: 1",
    `Chain ID: ${opts.chainId}`,
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
 * Whether `signature` (base58, 64 bytes) is `address`'s ed25519 signature of
 * exactly these message bytes. Strict RFC 8032 checks, so one message has
 * one valid signature encoding.
 */
export function verifySignature(
  message: string,
  signature: string,
  address: string,
): boolean {
  try {
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
