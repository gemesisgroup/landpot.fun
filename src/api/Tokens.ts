import { uuidToBase64url } from "@openfront/shared/Base64";
import {
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApiConfig } from "./ApiEnv";
import type { User } from "./Store";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SigningKeys {
  privateKey: CryptoKey;
  publicJwk: JWK & { alg: "EdDSA"; kid: string };
}

/**
 * Load the Ed25519 signing key. In dev a key is generated once and kept in
 * the data dir so sessions survive restarts; elsewhere it must come from
 * LANDPOT_JWT_KEY (a private JWK as JSON).
 */
export async function loadSigningKeys(config: ApiConfig): Promise<SigningKeys> {
  let privateJwk: JWK;
  if (config.jwtKey !== null) {
    privateJwk = JSON.parse(config.jwtKey) as JWK;
  } else {
    const file = path.join(config.dataDir, "dev-jwt-key.json");
    if (existsSync(file)) {
      privateJwk = JSON.parse(readFileSync(file, "utf8")) as JWK;
    } else {
      const { privateKey } = await generateKeyPair("EdDSA", {
        crv: "Ed25519",
        extractable: true,
      });
      privateJwk = await exportJWK(privateKey);
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(privateJwk), { mode: 0o600 });
    }
  }
  if (
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    !privateJwk.d
  ) {
    throw new Error("LANDPOT_JWT_KEY must be a private Ed25519 JWK");
  }
  const privateKey = (await importJWK(privateJwk, "EdDSA")) as CryptoKey;
  const pub: JWK = { ...privateJwk };
  delete pub.d;
  const kid = await calculateJwkThumbprint(pub);
  // jose's exportJWK omits alg, and the game server's JwksSchema requires it.
  return { privateKey, publicJwk: { ...pub, alg: "EdDSA", kid } };
}

export function jwks(keys: SigningKeys): { keys: JWK[] } {
  return { keys: [keys.publicJwk] };
}

/** Claims the game server reads (TokenPayloadSchema). */
export async function mintAccessToken(
  keys: SigningKeys,
  config: ApiConfig,
  user: User,
): Promise<string> {
  const claims: Record<string, string> = {};
  // Guests carry no provider, so the game server's clientAuth() reads them as
  // anonymous; a wallet makes the session an account.
  if (user.wallet !== null) claims.provider = "wallet";
  if (user.role !== null) claims.role = user.role;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.publicJwk.kid })
    .setSubject(uuidToBase64url(user.id))
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(keys.privateKey);
}

/** Verify an access token issued by this API; returns the user id or null. */
export async function verifyAccessToken(
  keys: SigningKeys,
  config: ApiConfig,
  token: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicJwk, {
      algorithms: ["EdDSA"],
      issuer: config.issuer,
      audience: config.audience,
    });
    if (typeof payload.sub !== "string") return null;
    const bytes = base64url.decode(payload.sub);
    if (bytes.length !== 16) return null;
    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/** A fresh refresh token and the hash that is stored in its place. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
