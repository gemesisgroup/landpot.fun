import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "node:crypto";

/**
 * Sign-In with Ethereum (EIP-4361) for EOA wallets.
 *
 * The server writes the whole message and keeps it with the nonce, then
 * verifies the signature against exactly that text. Nothing the client sends
 * is parsed back into fields, so domain, URI, chain and expiry cannot be
 * tampered with: changing any byte breaks the signature or the lookup.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** EIP-55 mixed-case checksum. */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = Buffer.from(
    keccak_256(new TextEncoder().encode(lower)),
  ).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

export function newNonce(): string {
  // EIP-4361: at least 8 alphanumeric characters.
  return randomBytes(12).toString("hex");
}

export function buildSiweMessage(opts: {
  siteOrigin: string;
  address: string; // checksummed
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const url = new URL(opts.siteOrigin);
  return [
    `${url.host} wants you to sign in with your Ethereum account:`,
    opts.address,
    "",
    "Sign in to Landpot. This request will not trigger a blockchain transaction or cost any gas.",
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

/** EIP-191 personal_sign digest. */
function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${body.length}`,
  );
  const buf = new Uint8Array(prefix.length + body.length);
  buf.set(prefix);
  buf.set(body, prefix.length);
  return keccak_256(buf);
}

/**
 * Recover the checksummed signer of a personal_sign signature, or null when
 * the signature is malformed. Rejects high-s signatures (EIP-2), so each
 * signature has exactly one valid encoding.
 */
export function recoverSigner(
  message: string,
  signature: string,
): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const bytes = Buffer.from(signature.slice(2), "hex");
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(bytes.subarray(0, 64));
    if (sig.hasHighS()) return null;
    const pub = sig
      .addRecoveryBit(v)
      .recoverPublicKey(personalMessageHash(message))
      .toRawBytes(false);
    const addr = Buffer.from(keccak_256(pub.subarray(1)).subarray(12));
    return toChecksumAddress(`0x${addr.toString("hex")}`);
  } catch {
    return null;
  }
}
