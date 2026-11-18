import { Connection, Keypair, Transaction } from "@solana/web3.js";
/**
 * With `npm run dev:pot` running: pay a paid lobby's entry from the dev
 * player wallets, to fill seats without more browsers.
 *
 *   npx tsx scripts/landpot/devDeposit.ts <gameId> <from> <to> [--devnet]
 *
 * <from>..<to> are player numbers (1..16, keys in .data/solana/dev/). Those
 * wallets have no Landpot account, so the lobby waits for them like for any
 * no-show and starts at the deadline. Goes through the API's deposit-tx
 * endpoint, exactly like the browser. With --devnet (`dev:pot -- --devnet`),
 * the devnet players from .data/solana/devnet/ on the devnet RPC.
 */
import { readFileSync } from "node:fs";

const onDevnet = process.argv.includes("--devnet");
const [gameId, from, to] = process.argv
  .slice(2)
  .filter((a) => a !== "--devnet");
const API = process.env.LANDPOT_API ?? "http://localhost:8787";
const RPC =
  process.env.SOLANA_RPC ??
  (onDevnet ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
const DIR = onDevnet ? ".data/solana/devnet" : ".data/solana/dev";

async function main() {
  if (!gameId || !from || !to) {
    throw new Error("usage: devDeposit.ts <gameId> <from> <to>");
  }
  const connection = new Connection(RPC, "confirmed");
  for (let i = Number(from); i <= Number(to); i++) {
    const key = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(readFileSync(`${DIR}/player-${i}.json`, "utf8")) as number[],
      ),
    );
    // 503: the API's RPC is rate-limited; the same request works shortly.
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${API}/public/pot/deposit-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, wallet: key.publicKey.toBase58() }),
      });
      if (res.status !== 503 || attempt === 6) break;
      await sleep(5_000);
    }
    if (!res.ok) {
      console.log(`player ${i}: ${res.status} ${await res.text()}`);
      continue;
    }
    const { transaction } = (await res.json()) as { transaction: string };
    const tx = Transaction.from(Buffer.from(transaction, "base64"));
    tx.partialSign(key);
    const sig = await connection.sendRawTransaction(tx.serialize());
    // Then ask the API until it is confirmed, like the browser does.
    let status = "pending";
    for (let n = 0; n < 60 && status === "pending"; n++) {
      await sleep(1_000);
      const r = await fetch(`${API}/public/pot/tx/${sig}`);
      if (r.ok) status = ((await r.json()) as { status: string }).status;
    }
    console.log(
      `player ${i} (${key.publicKey.toBase58()}) ${status === "confirmed" ? "paid" : status}: ${sig}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
