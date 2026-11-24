import { base58 } from "@scure/base";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Landpot API configuration, read once from the environment (docs/LandpotAPI.md).
 * Dev defaults let `npm run dev:all` work with no setup; production refuses
 * to start without the secrets that matter.
 */
export interface ApiConfig {
  readonly port: number;
  readonly domain: string;
  /** JWT issuer: must equal ServerEnv.jwtIssuer() on the game server. */
  readonly issuer: string;
  /** JWT audience: the site domain (ServerEnv.jwtAudience()). */
  readonly audience: string;
  readonly apiKey: string;
  readonly dataDir: string;
  /** Private Ed25519 JWK as JSON, or null to generate one (dev only). */
  readonly jwtKey: string | null;
  /** The page origin that signs in: bound into wallet messages and allowed by CORS. */
  readonly siteOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly turnstileSecret: string;
  readonly isDev: boolean;
  /** Paid-match escrow (docs/LandpotPot.md); null when not configured. */
  readonly pot: PotConfig | null;
}

export interface PotConfig {
  readonly mode: "program" | "custodial";
  readonly rpcUrl: string;
  /** "mainnet-beta", "devnet" or "localnet": for explorer links. */
  readonly cluster: string;
  /** The escrow program id (program mode) or vault pubkey (custodial mode), base58. */
  readonly programId: string;
  /** Co-signs every result; the escrow config's oracle (program mode). 64-byte secret key. */
  readonly oracleKey: Uint8Array;
  /**
   * The escrow config's operator (program mode) or vault keypair (custodial mode).
   */
  readonly operatorKey: Uint8Array;
  /** Token mint (custodial mode only). */
  readonly mint?: string;
  /** Treasury wallet pubkey (custodial mode only). */
  readonly treasury?: string;
  readonly burnBps?: number;
  readonly treasuryBps?: number;
  readonly reviewDelay?: number;
  /** Entry per player, whole tokens. */
  readonly cupHourUTC?: number;
  readonly stakeTokens: bigint;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly fundingSeconds: number;
}

const CLUSTERS = new Set(["mainnet-beta", "devnet", "localnet"]);
const POT_REQUIRED = [
  "LANDPOT_POT_RPC_URL",
  "LANDPOT_POT_CLUSTER",
  "LANDPOT_POT_PROGRAM",
  "LANDPOT_POT_ORACLE_KEY",
  "LANDPOT_POT_OPERATOR_KEY",
  "LANDPOT_POT_STAKE",
] as const;

/**
 * A Solana keypair as `solana-keygen` writes it: a JSON array of 64 bytes,
 * inline or in a file at this path.
 */
function keypairBytes(name: string, value: string): Uint8Array {
  const json = value.startsWith("[") ? value : readFileSync(value, "utf8");
  let bytes: unknown;
  try {
    bytes = JSON.parse(json);
  } catch {
    bytes = null;
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)
  ) {
    throw new Error(`${name} must be a Solana keypair (64-byte JSON array)`);
  }
  return Uint8Array.from(bytes as number[]);
}

const CUSTODIAL_REQUIRED = [
  "LANDPOT_POT_RPC_URL",
  "LANDPOT_POT_CLUSTER",
  "LANDPOT_POT_MINT",
  "LANDPOT_POT_VAULT_KEY",
  "LANDPOT_POT_TREASURY",
  "LANDPOT_POT_STAKE",
] as const;

/** All of the required LANDPOT_POT_* variables, or none of them. */
function loadPotConfig(env: NodeJS.ProcessEnv): PotConfig | null {
  const v = (k: string) => env[k]?.trim() ?? "";
  const mode = v("LANDPOT_POT_MODE") === "custodial" ? "custodial" : "program";

  const int = (k: string, fallback: number) => {
    const raw = v(k);
    const n = raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`${k} must be a positive integer`);
    }
    return n;
  };
  const nonNegInt = (k: string, fallback: number) => {
    const raw = v(k);
    const n = raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`${k} must be a non-negative integer`);
    }
    return n;
  };

  if (mode === "custodial") {
    const set = CUSTODIAL_REQUIRED.filter((k) => v(k) !== "").length;
    if (set === 0) return null;
    if (set !== CUSTODIAL_REQUIRED.length) {
      throw new Error(
        `Set all of ${CUSTODIAL_REQUIRED.join(", ")}, or none (custodial mode)`,
      );
    }
    const cluster = v("LANDPOT_POT_CLUSTER");
    if (!CLUSTERS.has(cluster)) {
      throw new Error(
        `LANDPOT_POT_CLUSTER must be one of ${[...CLUSTERS].join(", ")}`,
      );
    }
    const mint = v("LANDPOT_POT_MINT");
    if (!isPublicKey(mint)) {
      throw new Error("LANDPOT_POT_MINT must be a base58 public key");
    }
    const treasury = v("LANDPOT_POT_TREASURY");
    if (!isPublicKey(treasury)) {
      throw new Error("LANDPOT_POT_TREASURY must be a base58 public key");
    }
    const stake = v("LANDPOT_POT_STAKE");
    if (!/^[1-9]\d*$/.test(stake)) {
      throw new Error("LANDPOT_POT_STAKE must be a whole number of tokens");
    }
    const vaultKey = keypairBytes(
      "LANDPOT_POT_VAULT_KEY",
      v("LANDPOT_POT_VAULT_KEY"),
    );
    const cupHour = v("LANDPOT_CUP_WEEK_HOUR_UTC");
    const cupHourUTC = cupHour === "" ? undefined : Number(cupHour);
    if (
      cupHourUTC !== undefined &&
      (!/^\d+$/.test(cupHour) || cupHourUTC > 167)
    ) {
      throw new Error("Invalid cup hour (0..167, Sunday UTC first)");
    }
    return {
      mode: "custodial",
      rpcUrl: v("LANDPOT_POT_RPC_URL"),
      cluster,
      programId: mint,
      oracleKey: vaultKey,
      operatorKey: vaultKey,
      mint,
      treasury,
      burnBps: nonNegInt("LANDPOT_POT_BURN_BPS", 200),
      treasuryBps: nonNegInt("LANDPOT_POT_TREASURY_BPS", 300),
      reviewDelay: nonNegInt("LANDPOT_POT_REVIEW_DELAY", 15),
      cupHourUTC,
      stakeTokens: BigInt(stake),
      minPlayers: int("LANDPOT_POT_MIN_PLAYERS", 8),
      maxPlayers: int("LANDPOT_POT_MAX_PLAYERS", 16),
      fundingSeconds: int("LANDPOT_POT_FUNDING_MINUTES", 20) * 60,
    };
  }

  const set = POT_REQUIRED.filter((k) => v(k) !== "").length;
  if (set === 0) return null;
  if (set !== POT_REQUIRED.length) {
    throw new Error(`Set all of ${POT_REQUIRED.join(", ")}, or none`);
  }
  const cluster = v("LANDPOT_POT_CLUSTER");
  if (!CLUSTERS.has(cluster)) {
    throw new Error(
      `LANDPOT_POT_CLUSTER must be one of ${[...CLUSTERS].join(", ")}`,
    );
  }
  const programId = v("LANDPOT_POT_PROGRAM");
  if (!isPublicKey(programId)) {
    throw new Error("LANDPOT_POT_PROGRAM must be a base58 program id");
  }
  const stake = v("LANDPOT_POT_STAKE");
  if (!/^[1-9]\d*$/.test(stake)) {
    throw new Error("LANDPOT_POT_STAKE must be a whole number of tokens");
  }
  const cupHour = v("LANDPOT_CUP_WEEK_HOUR_UTC");
  const cupHourUTC = cupHour === "" ? undefined : Number(cupHour);
  if (
    cupHourUTC !== undefined &&
    (!/^\d+$/.test(cupHour) || cupHourUTC > 167)
  ) {
    throw new Error("Invalid cup hour (0..167, Sunday UTC first)");
  }
  return {
    mode: "program",
    rpcUrl: v("LANDPOT_POT_RPC_URL"),
    cluster,
    programId,
    oracleKey: keypairBytes(
      "LANDPOT_POT_ORACLE_KEY",
      v("LANDPOT_POT_ORACLE_KEY"),
    ),
    operatorKey: keypairBytes(
      "LANDPOT_POT_OPERATOR_KEY",
      v("LANDPOT_POT_OPERATOR_KEY"),
    ),
    cupHourUTC,
    stakeTokens: BigInt(stake),
    minPlayers: int("LANDPOT_POT_MIN_PLAYERS", 8),
    maxPlayers: int("LANDPOT_POT_MAX_PLAYERS", 16),
    fundingSeconds: int("LANDPOT_POT_FUNDING_MINUTES", 20) * 60,
  };
}

/** A base58 string that decodes to 32 bytes: a Solana public key. */
export function isPublicKey(s: string): boolean {
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

// Cloudflare's documented test secret that always passes.
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
const DEV_API_KEY = "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION";

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Required, never defaulted: a missing DOMAIN must not quietly turn a
  // production container into dev mode (public API key, throwaway JWT key).
  const domain = env.DOMAIN;
  if (domain === undefined || domain.length === 0) {
    throw new Error("DOMAIN must be set (use DOMAIN=localhost for dev)");
  }
  const isDev = domain === "localhost";
  const required = (name: string, devValue: string): string => {
    const v = env[name];
    if (v !== undefined && v.length > 0) return v;
    if (isDev) return devValue;
    throw new Error(`${name} must be set outside development`);
  };

  const siteOrigin = required("LANDPOT_SITE_ORIGIN", "http://localhost:9000");
  const extra = (env.LANDPOT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const port = Number(env.LANDPOT_API_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid LANDPOT_API_PORT: ${env.LANDPOT_API_PORT}`);
  }

  const jwtKey = env.LANDPOT_JWT_KEY ?? null;
  if (jwtKey === null && !isDev) {
    throw new Error("LANDPOT_JWT_KEY must be set outside development");
  }

  return {
    port,
    domain,
    // Mirrors ServerEnv.jwtIssuer() and ApiBase.getApiBase().
    issuer: isDev ? `http://localhost:${port}` : `https://api.${domain}`,
    audience: domain,
    apiKey: required("API_KEY", DEV_API_KEY),
    dataDir: path.resolve(env.LANDPOT_DATA_DIR ?? ".data/api"),
    jwtKey,
    siteOrigin,
    allowedOrigins: new Set([siteOrigin, ...extra]),
    turnstileSecret: required("TURNSTILE_SECRET_KEY", TURNSTILE_TEST_SECRET),
    isDev,
    pot: loadPotConfig(env),
  };
}
