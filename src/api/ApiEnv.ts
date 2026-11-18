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
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly escrow: `0x${string}`;
  /** Signs results; its address is the contract's immutable oracle. */
  readonly oracleKey: `0x${string}`;
  /**
   * The contract's operator: opens and starts rounds, closes unfilled
   * lobbies, and pays gas for everything the API sends.
   */
  readonly operatorKey: `0x${string}`;
  /** Entry per player, whole tokens. */
  readonly stakeTokens: bigint;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly fundingSeconds: number;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const POT_REQUIRED = [
  "LANDPOT_POT_RPC_URL",
  "LANDPOT_POT_CHAIN_ID",
  "LANDPOT_POT_ESCROW",
  "LANDPOT_POT_ORACLE_KEY",
  "LANDPOT_POT_OPERATOR_KEY",
  "LANDPOT_POT_STAKE",
] as const;

/** All of the required LANDPOT_POT_* variables, or none of them. */
function loadPotConfig(env: NodeJS.ProcessEnv): PotConfig | null {
  const v = (k: string) => env[k]?.trim() ?? "";
  const set = POT_REQUIRED.filter((k) => v(k) !== "").length;
  if (set === 0) return null;
  if (set !== POT_REQUIRED.length) {
    throw new Error(`Set all of ${POT_REQUIRED.join(", ")}, or none`);
  }
  const int = (k: string, fallback: number) => {
    const raw = v(k);
    const n = raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`${k} must be a positive integer`);
    }
    return n;
  };
  const chainId = int("LANDPOT_POT_CHAIN_ID", 0);
  const escrow = v("LANDPOT_POT_ESCROW");
  if (!ADDRESS_RE.test(escrow)) {
    throw new Error("LANDPOT_POT_ESCROW must be an address");
  }
  const oracleKey = v("LANDPOT_POT_ORACLE_KEY");
  const operatorKey = v("LANDPOT_POT_OPERATOR_KEY");
  if (!KEY_RE.test(oracleKey) || !KEY_RE.test(operatorKey)) {
    throw new Error("LANDPOT_POT_*_KEY must be 32-byte hex private keys");
  }
  const stake = v("LANDPOT_POT_STAKE");
  if (!/^[1-9]\d*$/.test(stake)) {
    throw new Error("LANDPOT_POT_STAKE must be a whole number of tokens");
  }
  return {
    rpcUrl: v("LANDPOT_POT_RPC_URL"),
    chainId,
    escrow: escrow as `0x${string}`,
    oracleKey: oracleKey as `0x${string}`,
    operatorKey: operatorKey as `0x${string}`,
    stakeTokens: BigInt(stake),
    minPlayers: int("LANDPOT_POT_MIN_PLAYERS", 8),
    maxPlayers: int("LANDPOT_POT_MAX_PLAYERS", 16),
    fundingSeconds: int("LANDPOT_POT_FUNDING_MINUTES", 20) * 60,
  };
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
