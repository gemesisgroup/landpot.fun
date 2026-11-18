import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  toHex,
  type Abi,
  type Chain,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { compileContracts } from "./compileContracts";
import { deployLandpot } from "./deploy";

/**
 * Local paid matches, end to end: starts anvil, deploys a test token and the
 * escrow with the real deploy code, gives test wallets tokens, then runs
 * `npm run dev:all` with the pot and paid lobbies switched on.
 *
 *   npm run dev:pot
 *
 * Wallets are anvil's well-known test accounts (never use them anywhere
 * real): 0 deployer and guardian, 1 operator, 2 oracle, 3 treasury, 4 and up
 * players with 1,000 tokens each. LANDPOT_POT_FUNDING_MINUTES (default 3)
 * sets how long a lobby takes deposits.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const PORT = Number(process.env.ANVIL_PORT ?? 8545);
const RPC = `http://127.0.0.1:${PORT}`;
const PLAYERS = 16;

function findAnvil(): string {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const found = [
    process.env.ANVIL_PATH,
    path.join(os.homedir(), ".foundry", "bin", exe),
  ].find((p): p is string => !!p && existsSync(p));
  if (!found)
    throw new Error("anvil not found: install Foundry or set ANVIL_PATH");
  return found;
}

const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const keyOf = (i: number) => toHex(acct(i).getHdKey().privateKey!);

async function main() {
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const anvil = spawn(
    findAnvil(),
    ["--port", String(PORT), "--accounts", String(4 + PLAYERS), "--silent"],
    { stdio: "inherit" },
  );
  children.push(anvil);
  const chain: Chain = {
    id: 31337,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const pub = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const { token, escrow } = await deployLandpot({
    chain,
    rpcUrl: RPC,
    deployerKey: keyOf(0),
    token: {
      name: "Landpot Dev",
      symbol: "LDEV",
      supply: parseUnits("1000000000", 18),
      holder: acct(0).address,
    },
    guardian: acct(0).address,
    operator: acct(1).address,
    oracle: acct(2).address,
    treasury: acct(3).address,
    burnBps: 200,
    treasuryBps: 300,
    reviewDelaySeconds: 86_400n,
    maxBank: parseUnits("100000", 18),
    dailyCap: parseUnits("100000", 18),
  });
  const tokenAbi = compileContracts().LandpotToken.abi as Abi;
  const deployer = createWalletClient({
    chain,
    transport: http(RPC),
    account: acct(0),
  });
  for (let i = 4; i < 4 + PLAYERS; i++) {
    const hash = await deployer.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transfer",
      args: [acct(i).address, parseUnits("1000", 18)],
    });
    await pub.waitForTransactionReceipt({ hash });
  }
  console.log(`\nanvil ${RPC}\ntoken  ${token}\nescrow ${escrow}`);
  console.log(`players: anvil accounts 4..${3 + PLAYERS}, 1,000 LDEV each\n`);

  // Its own API database, fresh each run: rounds in it belong to this
  // anvil, which starts empty every time.
  const dataDir = ".data/api-pot";
  rmSync(dataDir, { recursive: true, force: true });
  const env = {
    ...process.env,
    LANDPOT_DATA_DIR: dataDir,
    LANDPOT_PAID_LOBBIES: "1",
    LANDPOT_POT_RPC_URL: RPC,
    LANDPOT_POT_CHAIN_ID: "31337",
    LANDPOT_POT_ESCROW: escrow,
    LANDPOT_POT_ORACLE_KEY: keyOf(2),
    LANDPOT_POT_OPERATOR_KEY: keyOf(1),
    LANDPOT_POT_STAKE: process.env.LANDPOT_POT_STAKE ?? "10",
    LANDPOT_POT_FUNDING_MINUTES: process.env.LANDPOT_POT_FUNDING_MINUTES ?? "3",
  };
  const dev = spawn("npm", ["run", "dev:all"], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(dev);
  dev.on("exit", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
