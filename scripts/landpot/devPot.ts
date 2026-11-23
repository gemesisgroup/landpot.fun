import { Keypair } from "@solana/web3.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initializeEscrow } from "../../src/api/pot/SolanaEscrow";
import {
  fund,
  PROGRAM_ID,
  startValidator,
  testMint,
  validatorAvailable,
} from "./solanaLocal";

/**
 * Local paid matches, end to end: starts a Solana test validator (in WSL)
 * with the escrow program, creates a Token-2022 test mint, initializes the
 * escrow, funds test wallets, then runs `npm run dev:all` with the pot and
 * paid lobbies switched on.
 *
 *   npm run dev:pot
 *
 * Every run starts from an empty validator with fresh keys, written to
 * .data/solana/dev/ (gitignored, throwaway): guardian, operator, oracle,
 * treasury, and player-1..16 with 2 SOL and 1,000 test tokens each. Import a
 * player key into a wallet set to a custom RPC (http://127.0.0.1:8899) to
 * play, or fill seats with scripts/landpot/devDeposit.ts.
 * The program is the `localnet` build: results release after 2 seconds of
 * review instead of a day. LANDPOT_POT_FUNDING_MINUTES (default 3) sets how
 * long a lobby takes deposits.
 *
 *   npm run dev:pot -- --cup
 *
 * The same, with the first paid lobby a Caldera Cup (four pairs) that takes
 * deposits for 10 minutes: for trying the Cup, and for
 * scripts/landpot/cup_e2e.py.
 *
 *   npm run dev:pot -- --devnet
 *
 * The same stack against the devnet escrow that `npm run solana:deploy`
 * set up: no validator, the settings come from .data/solana/devnet/api.env,
 * and the players are .data/solana/devnet/player-N.json. Lobbies take
 * deposits for 10 minutes there: the public RPC is rate-limited.
 */

const PORT = Number(process.env.SOLANA_RPC_PORT ?? 8899);
const PLAYERS = 16;
const DIR = ".data/solana/dev";

/** Runs `npm run dev:all` with paid lobbies and the given pot settings. */
function runStack(
  pot: Record<string, string>,
  dataDir: string,
  children: ChildProcess[],
  stop: () => void,
) {
  // Its own API database per chain: rounds in it belong to that escrow.
  const env = {
    ...process.env,
    LANDPOT_DATA_DIR: dataDir,
    LANDPOT_PAID_LOBBIES: "1",
    ...pot,
    LANDPOT_POT_STAKE: process.env.LANDPOT_POT_STAKE ?? pot.LANDPOT_POT_STAKE,
    LANDPOT_POT_FUNDING_MINUTES:
      process.env.LANDPOT_POT_FUNDING_MINUTES ??
      pot.LANDPOT_POT_FUNDING_MINUTES,
  };
  const dev = spawn("npm", ["run", "dev:all"], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(dev);
  dev.on("exit", stop);
}

function devnet() {
  const file = ".data/solana/devnet/api.env";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `${file} not found: run npm run solana:deploy -- --playtest`,
    );
  }
  const pot: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) pot[m[1]] = m[2];
  }
  // The public devnet RPC is rate-limited: give lobbies time to fill.
  pot.LANDPOT_POT_FUNDING_MINUTES ??= "10";
  console.log(`devnet program ${pot.LANDPOT_POT_PROGRAM}\n`);
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  runStack(pot, ".data/api-devnet", children, stop);
}

async function main() {
  if (process.argv.includes("--devnet")) return devnet();
  if (!validatorAvailable()) {
    throw new Error(
      "solana-test-validator not found in WSL (see scripts/landpot/solanaLocal.ts)",
    );
  }
  const children: ChildProcess[] = [];
  const v = await startValidator(PORT);
  const stop = () => {
    for (const c of children) c.kill();
    v.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const save = (name: string, k: Keypair) => {
    const file = path.join(DIR, `${name}.json`);
    writeFileSync(file, JSON.stringify(Array.from(k.secretKey)));
    return file;
  };
  const [guardian, operator, oracle, treasury] = [0, 1, 2, 3].map(() =>
    Keypair.generate(),
  );
  const players = Array.from({ length: PLAYERS }, () => Keypair.generate());
  save("guardian", guardian);
  const operatorFile = save("operator", operator);
  const oracleFile = save("oracle", oracle);
  save("treasury", treasury);
  players.forEach((p, i) => save(`player-${i + 1}`, p));

  const { connection } = v;
  for (const k of [guardian, operator, oracle, ...players]) {
    await fund(connection, k.publicKey, k === operator ? 50 : 2);
  }
  const mint = await testMint(
    connection,
    v.authority,
    players.map((p) => p.publicKey),
    1_000n * 1_000_000n,
  );
  await initializeEscrow(connection, PROGRAM_ID, v.authority, mint, {
    guardian: guardian.publicKey,
    operator: operator.publicKey,
    oracle: oracle.publicKey,
    treasury: treasury.publicKey,
    burnBps: 200,
    treasuryBps: 300,
    reviewDelay: 2,
    maxBank: 10_000_000n * 1_000_000n,
    dailyCap: 2_000_000n * 1_000_000n,
  });
  console.log(
    `\nvalidator ${connection.rpcEndpoint}\nprogram   ${PROGRAM_ID.toBase58()}\nmint      ${mint.toBase58()}`,
  );
  console.log(
    `players: ${DIR}/player-1..${PLAYERS}.json, 2 SOL and 1,000 tokens each\n`,
  );

  // Fresh each run: the validator starts empty every time.
  const dataDir = ".data/api-pot";
  rmSync(dataDir, { recursive: true, force: true });
  runStack(
    {
      LANDPOT_POT_RPC_URL: connection.rpcEndpoint,
      LANDPOT_POT_CLUSTER: "localnet",
      LANDPOT_POT_PROGRAM: PROGRAM_ID.toBase58(),
      LANDPOT_POT_ORACLE_KEY: path.resolve(oracleFile),
      LANDPOT_POT_OPERATOR_KEY: path.resolve(operatorFile),
      LANDPOT_POT_STAKE: "10",
      LANDPOT_POT_FUNDING_MINUTES: process.argv.includes("--cup") ? "10" : "3",
      ...(process.argv.includes("--cup")
        ? { LANDPOT_CUP_WEEK_HOUR_UTC: String(weekHourUTC(new Date())) }
        : {}),
    },
    dataDir,
    children,
    stop,
  );
}

/** 0 = Sunday 00:00 UTC, as LANDPOT_CUP_WEEK_HOUR_UTC counts. */
function weekHourUTC(d: Date): number {
  return d.getUTCDay() * 24 + d.getUTCHours();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
