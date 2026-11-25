import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";

/**
 * Deploy `LandpotEscrow.sol` to BNB Smart Chain (Mainnet or Testnet).
 *
 * Required env:
 *   BSC_CLUSTER        "bsc" | "bsc-testnet" (default: bsc-testnet)
 *   BSC_RPC_URL        RPC endpoint
 *   BSC_DEPLOYER_KEY   0x... 32-byte private key (~0.004 BNB for gas)
 *   BSC_TOKEN          0x... BEP-20 $LANDPOT token address
 *   BSC_TREASURY       0x... treasury address (3%)
 *   BSC_GUARDIAN       0x... guardian address (default: deployer)
 *   BSC_OPERATOR       0x... operator address (default: deployer)
 *   BSC_ORACLE         0x... oracle address (default: deployer)
 *
 * Optional env:
 *   BSC_BURN_BPS       default 200 (2%)
 *   BSC_TREASURY_BPS   default 300 (3%)
 *   BSC_REVIEW_DELAY   default 60 (seconds; use 86400 for 24h)
 *   BSC_TOKEN_DECIMALS default 18
 */
async function main() {
  const cluster = (process.env.BSC_CLUSTER ?? "bsc-testnet") as
    | "bsc"
    | "bsc-testnet";
  const chain = cluster === "bsc" ? bsc : bscTestnet;
  const rpcUrl =
    process.env.BSC_RPC_URL ??
    (cluster === "bsc"
      ? "https://bsc-dataseed.binance.org"
      : "https://data-seed-prebsc-1-s1.binance.org:8545");

  const deployerKey = process.env.BSC_DEPLOYER_KEY as Hex | undefined;
  const token = process.env.BSC_TOKEN as Address | undefined;
  const treasury = process.env.BSC_TREASURY as Address | undefined;
  if (!deployerKey || !token || !treasury) {
    throw new Error(
      "Set BSC_DEPLOYER_KEY, BSC_TOKEN, and BSC_TREASURY before deploying",
    );
  }

  const account = privateKeyToAccount(deployerKey);
  const guardian = getAddress(process.env.BSC_GUARDIAN ?? account.address);
  const operator = getAddress(process.env.BSC_OPERATOR ?? account.address);
  const oracle = getAddress(process.env.BSC_ORACLE ?? account.address);
  const burnBps = Number(process.env.BSC_BURN_BPS ?? 200);
  const treasuryBps = Number(process.env.BSC_TREASURY_BPS ?? 300);
  const reviewDelay = BigInt(process.env.BSC_REVIEW_DELAY ?? 60);
  const decimals = BigInt(process.env.BSC_TOKEN_DECIMALS ?? 18);
  const unit = 10n ** decimals;
  const maxBank = BigInt(process.env.BSC_MAX_BANK ?? 20_000_000) * unit;
  const dailyCap = BigInt(process.env.BSC_DAILY_CAP ?? 20_000_000) * unit;

  const artifact = JSON.parse(
    readFileSync(path.resolve("bsc/artifacts/LandpotEscrow.json"), "utf8"),
  ) as { abi: readonly unknown[]; bytecode: Hex };

  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  console.log(`Deploying LandpotEscrow to ${cluster} from ${account.address}...`);
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      getAddress(token),
      guardian,
      operator,
      oracle,
      getAddress(treasury),
      burnBps,
      treasuryBps,
      reviewDelay,
      maxBank,
      dailyCap,
    ],
  });
  console.log("Deploy tx:", hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("LandpotEscrow deployed at:", receipt.contractAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
