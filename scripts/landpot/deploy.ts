import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { compileContracts } from "./compileContracts";

/**
 * Deploys the Landpot pot: optionally a new LandpotToken, then the escrow.
 *
 *   LANDPOT_DEPLOY_NETWORK=base-sepolia LANDPOT_DEPLOYER_KEY=0x… \
 *   LANDPOT_GUARDIAN=0x… LANDPOT_OPERATOR=0x… LANDPOT_ORACLE=0x… \
 *   LANDPOT_TREASURY=0x… LANDPOT_MAX_BANK=… LANDPOT_DAILY_CAP=… \
 *   LANDPOT_TOKEN_NAME=… LANDPOT_TOKEN_SYMBOL=… LANDPOT_TOKEN_SUPPLY=… \
 *   npm run contracts:deploy
 *
 * Use LANDPOT_TOKEN=0x… instead of the LANDPOT_TOKEN_* trio to reuse a token
 * that already exists. Amounts are whole tokens (18 decimals). Base mainnet
 * also needs LANDPOT_DEPLOY_CONFIRM=base, so a copied testnet command can't
 * spend real ETH by accident. Prints the API's LANDPOT_POT_* lines.
 */

export interface DeployParams {
  chain: Chain;
  rpcUrl: string;
  deployerKey: Hex;
  /** An existing token, or the new token's name, symbol and supply (wei). */
  token:
    | { address: Address }
    | { name: string; symbol: string; supply: bigint; holder: Address };
  guardian: Address;
  operator: Address;
  oracle: Address;
  treasury: Address;
  burnBps: number;
  treasuryBps: number;
  reviewDelaySeconds: bigint;
  /** Per round, in token wei. */
  maxBank: bigint;
  /** Per wallet per UTC day, in token wei. */
  dailyCap: bigint;
}

export interface Deployed {
  token: Address;
  escrow: Address;
  tokenDeployed: boolean;
}

export async function deployLandpot(p: DeployParams): Promise<Deployed> {
  const compiled = compileContracts();
  const account = privateKeyToAccount(p.deployerKey);
  const transport = http(p.rpcUrl, { timeout: 60_000 });
  const pub = createPublicClient({ chain: p.chain, transport });
  const wallet = createWalletClient({ chain: p.chain, transport, account });
  const deploy = async (name: string, args: unknown[]) => {
    const c = compiled[name];
    const hash = await wallet.deployContract({
      abi: c.abi as Abi,
      bytecode: c.bytecode,
      args,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed in ${hash}`);
    }
    return receipt.contractAddress;
  };

  let token: Address;
  let tokenDeployed = false;
  if ("address" in p.token) {
    token = p.token.address;
    if (!(await pub.getCode({ address: token }))) {
      throw new Error(`no contract at token address ${token}`);
    }
  } else {
    token = await deploy("LandpotToken", [
      p.token.name,
      p.token.symbol,
      p.token.supply,
      p.token.holder,
    ]);
    tokenDeployed = true;
  }
  const escrow = await deploy("LandpotEscrow", [
    token,
    p.guardian,
    p.operator,
    p.oracle,
    p.treasury,
    p.burnBps,
    p.treasuryBps,
    p.reviewDelaySeconds,
    p.maxBank,
    p.dailyCap,
  ]);
  return { token, escrow, tokenDeployed };
}

const NETWORKS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
};
const WEI = 10n ** 18n;

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
function address(env: NodeJS.ProcessEnv, name: string): Address {
  const v = need(env, name);
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return getAddress(v);
}
function wholeTokens(env: NodeJS.ProcessEnv, name: string): bigint {
  const v = need(env, name);
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`${name} must be a whole number`);
  return BigInt(v) * WEI;
}

export function paramsFromEnv(env: NodeJS.ProcessEnv): DeployParams {
  const network = need(env, "LANDPOT_DEPLOY_NETWORK");
  const chain = NETWORKS[network];
  if (!chain) {
    throw new Error(
      `LANDPOT_DEPLOY_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  if (chain.id === base.id && env.LANDPOT_DEPLOY_CONFIRM !== "base") {
    throw new Error(
      "deploying to Base mainnet needs LANDPOT_DEPLOY_CONFIRM=base",
    );
  }
  const deployerKey = need(env, "LANDPOT_DEPLOYER_KEY") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
    throw new Error("LANDPOT_DEPLOYER_KEY must be a 32-byte hex private key");
  }
  const guardian = address(env, "LANDPOT_GUARDIAN");
  const operator = address(env, "LANDPOT_OPERATOR");
  const oracle = address(env, "LANDPOT_ORACLE");
  // One hot server holds the operator and oracle keys; the guardian, who can
  // freeze a bad result, must not be one of them.
  if (guardian === operator || guardian === oracle) {
    throw new Error(
      "LANDPOT_GUARDIAN must differ from the operator and oracle",
    );
  }
  const token = env.LANDPOT_TOKEN?.trim()
    ? { address: address(env, "LANDPOT_TOKEN") }
    : {
        name: need(env, "LANDPOT_TOKEN_NAME"),
        symbol: need(env, "LANDPOT_TOKEN_SYMBOL"),
        supply: wholeTokens(env, "LANDPOT_TOKEN_SUPPLY"),
        holder: env.LANDPOT_TOKEN_HOLDER?.trim()
          ? address(env, "LANDPOT_TOKEN_HOLDER")
          : privateKeyToAccount(deployerKey).address,
      };
  return {
    chain,
    rpcUrl: env.LANDPOT_DEPLOY_RPC_URL?.trim()
      ? env.LANDPOT_DEPLOY_RPC_URL.trim()
      : chain.rpcUrls.default.http[0],
    deployerKey,
    token,
    guardian,
    operator,
    oracle,
    treasury: address(env, "LANDPOT_TREASURY"),
    burnBps: Number(env.LANDPOT_BURN_BPS ?? 200),
    treasuryBps: Number(env.LANDPOT_TREASURY_BPS ?? 300),
    reviewDelaySeconds: BigInt(env.LANDPOT_REVIEW_DELAY_SECONDS ?? 86_400),
    maxBank: wholeTokens(env, "LANDPOT_MAX_BANK"),
    dailyCap: wholeTokens(env, "LANDPOT_DAILY_CAP"),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const params = paramsFromEnv(process.env);
  console.log(`deploying to ${params.chain.name} (${params.chain.id})…`);
  const out = await deployLandpot(params);
  console.log(
    out.tokenDeployed
      ? `token  ${out.token} (new)`
      : `token  ${out.token} (existing)`,
  );
  console.log(`escrow ${out.escrow}\n`);
  console.log("API environment:");
  console.log(`LANDPOT_POT_RPC_URL=${params.rpcUrl}`);
  console.log(`LANDPOT_POT_CHAIN_ID=${params.chain.id}`);
  console.log(`LANDPOT_POT_ESCROW=${out.escrow}`);
  console.log("LANDPOT_POT_STAKE=<entry, whole tokens>");
  console.log("LANDPOT_POT_ORACLE_KEY=<private key of the oracle address>");
  console.log("LANDPOT_POT_OPERATOR_KEY=<private key of the operator address>");
}
