import {
  createAssociatedTokenAccountIdempotent,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeEscrow, pda } from "../../src/api/pot/SolanaEscrow";
import { testMint } from "./solanaLocal";
import { uploadBuffer } from "./solanaUpload";

/**
 * Deploy the escrow to devnet and set it up (docs/LandpotPot.md):
 *
 *   npm run solana:deploy -- [--playtest] [--mint <address>] [--players N]
 *
 * --playtest  deploy the devtest build (solana/landpot_escrow_devtest.so):
 *             the same program with a 2 s review hold, at its own address,
 *             so a whole match pays out in minutes. Without it, the release
 *             build at the release address (a day's review hold).
 * --mint      the token; without it, a Token-2022 test mint (6 decimals, no
 *             freeze authority, like pump.fun's) and N funded test players.
 *
 * Keys live in .data/solana/devnet/ (gitignored) and are created on first
 * run: deployer (pays, and is the upgrade authority), guardian, operator,
 * oracle, treasury, player-N. The deployer needs about 8 SOL to deploy (rent for the
 * upload buffer and the program at once, ~3.5 SOL each) and 1 SOL after; it
 * says so and stops when it is short (faucet.solana.com).
 * Writes .data/solana/devnet/api.env with the LANDPOT_POT_* settings.
 *
 * Mainnet is refused: the program is unaudited (see "Before real money" in
 * docs/LandpotPot.md), and that deploy is a reviewed, manual step.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_RPC = "https://api.devnet.solana.com";
const BIN = "~/.local/share/solana/install/active_release/bin";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function wslPath(win: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : win;
}

function keypair(dir: string, name: string): Keypair {
  const file = path.join(dir, `${name}.json`);
  if (!existsSync(file)) {
    writeFileSync(
      file,
      JSON.stringify(Array.from(Keypair.generate().secretKey)),
    );
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]),
  );
}

const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

async function main() {
  if (arg("cluster") && arg("cluster") !== "devnet") {
    throw new Error("only devnet: mainnet is a reviewed, manual deploy");
  }
  const rpc = arg("rpc") ?? DEFAULT_RPC;
  const playtest = flag("playtest");
  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  // Devnet's genesis hash: refuse to run against anything else by mistake.
  if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error(`${rpc} is not devnet (genesis ${genesis})`);
  }

  const dir = path.join(ROOT, ".data/solana/devnet");
  mkdirSync(dir, { recursive: true });
  const deployer = keypair(dir, "deployer");
  const guardian = keypair(dir, "guardian");
  const operator = keypair(dir, "operator");
  const oracle = keypair(dir, "oracle");
  const treasury = keypair(dir, "treasury");

  // Which build, and which address. The release address only ever gets the
  // release build; the fast one only ever goes to its own address.
  const so = path.join(
    ROOT,
    playtest ? "solana/landpot_escrow_devtest.so" : "solana/landpot_escrow.so",
  );
  const programKey = path.join(
    ROOT,
    playtest
      ? ".data/solana/landpot_escrow_devtest-keypair.json"
      : ".data/solana/landpot_escrow-keypair.json",
  );
  const fast = sha256(path.join(ROOT, "solana/landpot_escrow_localnet.so"));
  if (
    !playtest &&
    (sha256(so) === fast ||
      sha256(so) ===
        sha256(path.join(ROOT, "solana/landpot_escrow_devtest.so")))
  ) {
    throw new Error("solana/landpot_escrow.so is a fast-review build; rebuild");
  }
  const programId = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(programKey, "utf8")) as number[]),
  ).publicKey;
  if (playtest) {
    const expected = readFileSync(
      path.join(ROOT, "solana/landpot_escrow_devtest.id"),
      "utf8",
    ).trim();
    if (expected !== programId.toBase58()) {
      throw new Error("devtest build and keypair disagree; run solana:build");
    }
  }

  // A deploy holds rent for the buffer and the program at once; the setup
  // after it needs about 1 SOL. Devnet's RPC airdrop is closed.
  const deployed = await connection.getAccountInfo(programId);
  const deploying = !deployed || flag("upgrade");
  const need = (deploying ? 8 : 1) * LAMPORTS_PER_SOL;
  const balance = await connection.getBalance(deployer.publicKey);
  if (balance < need) {
    console.log(
      `The deployer needs about ${need / LAMPORTS_PER_SOL} SOL on devnet and has ${balance / LAMPORTS_PER_SOL}.\n` +
        `Send devnet SOL to ${deployer.publicKey.toBase58()}\n` +
        "(https://faucet.solana.com), then run again.",
    );
    process.exit(2);
  }

  // 1. The program: a slow, resumable upload into a buffer (solanaUpload.ts),
  // then the CLI deploys (or upgrades) from that buffer. buffer.json is kept
  // until the deploy succeeds, so a rerun resumes the same upload.
  if (deploying) {
    const bufferFile = path.join(dir, "buffer.json");
    const buffer = keypair(dir, "buffer");
    console.log(
      `uploading ${path.basename(so)} for ${programId.toBase58()} into ${buffer.publicKey.toBase58()}…`,
    );
    await uploadBuffer(connection, deployer, buffer, readFileSync(so));
    const cmd = [
      `${BIN}/solana program deploy`,
      `--url ${rpc}`,
      `--keypair ${wslPath(path.join(dir, "deployer.json"))}`,
      `--program-id ${wslPath(programKey)}`,
      `--buffer ${buffer.publicKey.toBase58()}`,
      deployed ? "" : `--max-len ${readFileSync(so).length}`,
    ].join(" ");
    execFileSync("wsl", ["-d", "Ubuntu", "--", "bash", "-lc", cmd], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    rmSync(bufferFile);
  }

  // 2. The token.
  const pay = async (to: PublicKey, sol: number) => {
    const have = await connection.getBalance(to);
    const want = sol * LAMPORTS_PER_SOL;
    if (have >= want / 2) return;
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: to,
          lamports: want - have,
        }),
      ),
      [deployer],
    );
  };
  const players = Number(arg("players") ?? 8);
  const mintFile = path.join(dir, "mint.txt");
  let mint: PublicKey;
  if (arg("mint")) {
    mint = new PublicKey(arg("mint")!);
  } else if (existsSync(mintFile)) {
    mint = new PublicKey(readFileSync(mintFile, "utf8").trim());
  } else {
    const holders = Array.from({ length: players }, (_, i) =>
      keypair(dir, `player-${i + 1}`),
    );
    mint = await testMint(
      connection,
      deployer,
      holders.map((h) => h.publicKey),
      10_000n * 1_000_000n * 10n,
    );
    writeFileSync(mintFile, mint.toBase58());
    for (const h of holders) await pay(h.publicKey, 0.05);
    console.log(
      `test mint ${mint.toBase58()}: ${players} players, 100,000 each`,
    );
  }

  // 3. Roles and the config.
  await pay(operator.publicKey, 0.5);
  await pay(oracle.publicKey, 0.01);
  const config = pda.config(programId);
  if (!(await connection.getAccountInfo(config))) {
    await initializeEscrow(connection, programId, deployer, mint, {
      guardian: guardian.publicKey,
      operator: operator.publicKey,
      oracle: oracle.publicKey,
      treasury: treasury.publicKey,
      burnBps: 200,
      treasuryBps: 300,
      reviewDelay: playtest ? 60 : 86_400,
      maxBank: 10_000_000n * 1_000_000n,
      dailyCap: 2_000_000n * 1_000_000n,
    });
    console.log("escrow initialized");
  }
  const mintOwner = (await connection.getAccountInfo(mint))!.owner;
  await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    mint,
    treasury.publicKey,
    { commitment: "confirmed" },
    mintOwner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : mintOwner,
  );

  const env = [
    `LANDPOT_POT_RPC_URL=${rpc}`,
    "LANDPOT_POT_CLUSTER=devnet",
    `LANDPOT_POT_PROGRAM=${programId.toBase58()}`,
    `LANDPOT_POT_ORACLE_KEY=${path.join(dir, "oracle.json")}`,
    `LANDPOT_POT_OPERATOR_KEY=${path.join(dir, "operator.json")}`,
    "LANDPOT_POT_STAKE=10000",
  ].join("\n");
  writeFileSync(path.join(dir, "api.env"), `${env}\n`);
  console.log(
    `\nprogram  ${programId.toBase58()}${playtest ? " (playtest)" : ""}`,
  );
  console.log(`mint     ${mint.toBase58()}`);
  console.log(`guardian ${guardian.publicKey.toBase58()}`);
  console.log(`API settings: ${path.join(dir, "api.env")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
