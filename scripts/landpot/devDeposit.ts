/**
 * With `npm run dev:pot` running: pay a paid lobby's entry from anvil test
 * accounts, to fill seats without more browsers.
 *
 *   npx tsx scripts/landpot/devDeposit.ts <gameId> <escrow> <token> <from> <to>
 *
 * <from>..<to> are anvil account indexes (players are 4 and up). Those
 * wallets have no Landpot account, so the lobby waits for them like for any
 * no-show and starts at the deadline.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  parseUnits,
  type Chain,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
const [gameId, escrow, token, from, to] = process.argv.slice(2);
const chain: Chain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
};
const pub = createPublicClient({ chain, transport: http() });
const abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }],
    outputs: [],
  },
] as const;
for (let i = Number(from); i <= Number(to); i++) {
  const account = mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex: i },
  );
  const w = createWalletClient({ chain, transport: http(), account });
  await pub.waitForTransactionReceipt({
    hash: await w.writeContract({
      address: token as `0x${string}`,
      abi,
      functionName: "approve",
      args: [escrow as `0x${string}`, parseUnits("10", 18)],
    }),
  });
  await pub.waitForTransactionReceipt({
    hash: await w.writeContract({
      address: escrow as `0x${string}`,
      abi,
      functionName: "deposit",
      args: [keccak256(toBytes(gameId))],
    }),
  });
  console.log("deposited", i, account.address);
}
