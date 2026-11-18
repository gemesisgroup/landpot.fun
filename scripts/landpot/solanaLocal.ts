import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import idl from "../../src/api/pot/landpot_escrow.json";

/**
 * A throwaway `solana-test-validator` in WSL with the escrow program
 * (the `localnet` build: a 2 s review hold) deployed as upgradeable, so
 * `initialize` sees a real upgrade authority. Tests skip when WSL or the
 * Solana tools are missing (scripts/landpot/solana-build.sh installs them).
 */
const DISTRO = "Ubuntu";
/**
 * Where to find the validator inside WSL, first match wins:
 * LANDPOT_TEST_VALIDATOR; a build from source in ~/agave (the release
 * binaries need AVX2, so an older CPU builds it: `cargo build --release
 * --bin solana-test-validator` in agave, with
 * RUST_REED_SOLOMON_ERASURE_ARCH=native); the installed release.
 */
const VALIDATORS = [
  process.env.LANDPOT_TEST_VALIDATOR,
  "~/agave/target/release/solana-test-validator",
  "~/.local/share/solana/install/active_release/bin/solana-test-validator",
].filter((p): p is string => !!p);
let validator: string | null | undefined;
const SO = fileURLToPath(
  new URL("../../solana/landpot_escrow_localnet.so", import.meta.url),
);

export const PROGRAM_ID = new PublicKey(idl.address);

function wsl(script: string): string {
  return execFileSync("wsl", ["-d", DISTRO, "--", "bash", "-lc", script], {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
}

function wslPath(win: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win);
  if (!m) return win;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export function validatorAvailable(): boolean {
  if (process.platform !== "win32" || !existsSync(SO)) return false;
  if (validator === undefined) {
    validator = null;
    for (const v of VALIDATORS) {
      try {
        if (wsl(`test -x ${v} && echo ok`).trim() === "ok") {
          validator = v;
          break;
        }
      } catch {
        // no WSL, or not there
      }
    }
  }
  return validator !== null;
}

export interface TestValidator {
  connection: Connection;
  /** The program's upgrade authority. */
  authority: Keypair;
  stop(): void;
}

export async function startValidator(rpcPort: number): Promise<TestValidator> {
  const authority = Keypair.generate();
  const ledger = `/tmp/landpot-ledger-${rpcPort}`;
  if (!validatorAvailable()) throw new Error("no solana-test-validator");
  const args = [
    validator!,
    "--reset",
    "--quiet",
    `--ledger ${ledger}`,
    `--rpc-port ${rpcPort}`,
    `--faucet-port ${rpcPort + 1001}`,
    `--gossip-port ${rpcPort + 2}`,
    `--dynamic-port-range ${rpcPort + 10}-${rpcPort + 60}`,
    `--upgradeable-program ${PROGRAM_ID.toBase58()} ${wslPath(SO)} ${authority.publicKey.toBase58()}`,
  ].join(" ");
  const child: ChildProcess = spawn(
    "wsl",
    ["-d", DISTRO, "--", "bash", "-lc", `exec ${args}`],
    { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  const stop = () => {
    child.kill();
    try {
      wsl(`pkill -f ${ledger} || true`);
    } catch {
      // already gone
    }
  };
  const connection = new Connection(`http://127.0.0.1:${rpcPort}`, "confirmed");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const info = await connection.getAccountInfo(PROGRAM_ID);
      if (info?.executable) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      let log = "";
      try {
        log = wsl(`tail -n 15 ${ledger}/validator.log`);
      } catch {
        // no log
      }
      stop();
      throw new Error(`solana-test-validator did not start
${log}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await fund(connection, authority.publicKey, 100);
  return { connection, authority, stop };
}

export async function fund(
  connection: Connection,
  to: PublicKey,
  sol: number,
): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, ...latest },
    "confirmed",
  );
}

/**
 * A Token-2022 test mint with 6 decimals and no freeze authority, like a
 * pump.fun mint, and `amount` base units for each holder.
 */
export async function testMint(
  connection: Connection,
  authority: Keypair,
  holders: readonly PublicKey[],
  amount: bigint,
): Promise<PublicKey> {
  const mint = await createMint(
    connection,
    authority,
    authority.publicKey,
    null,
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID,
  );
  for (const h of holders) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      h,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      connection,
      authority,
      mint,
      ata.address,
      authority,
      amount,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  }
  return mint;
}
