import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/**
 * A throwaway signer for browser tests against `npm run dev:pot`: it holds
 * the dev player keys (.data/solana/dev/player-N.json, localnet only) and
 * signs for the test wallet that scripts/landpot/cup_e2e.py injects into
 * each browser. Nothing here is a real wallet; never point it at mainnet.
 *
 *   npx tsx scripts/landpot/testSigner.ts
 *
 *   GET  /players                 [{ player, address, publicKey }]
 *   POST /sign-message            { player, message }      → { signature }
 *   POST /sign-send               { player, transaction }  → { signature }
 *
 * Bytes travel as base64. /sign-send signs the API's unsigned transaction
 * and sends it to the local validator, like a wallet's signAndSend.
 */

const DIR = process.env.LANDPOT_DEV_KEYS ?? ".data/solana/dev";
const RPC = process.env.SOLANA_RPC ?? "http://127.0.0.1:8899";
const PORT = Number(process.env.SIGNER_PORT ?? 8790);
const PLAYERS = 16;

if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) {
  throw new Error("testSigner only signs for a local validator");
}

const keys = new Map<number, Keypair>();
for (let n = 1; n <= PLAYERS; n++) {
  const raw = JSON.parse(
    readFileSync(`${DIR}/player-${n}.json`, "utf8"),
  ) as number[];
  keys.set(n, Keypair.fromSecretKey(Uint8Array.from(raw)));
}
const connection = new Connection(RPC, "confirmed");

function key(n: unknown): Keypair {
  const k = keys.get(Number(n));
  if (!k) throw new Error(`no player ${String(n)}`);
  return k;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

async function handle(path: string, body: Record<string, string>) {
  if (path === "/players") {
    return [...keys].map(([player, k]) => ({
      player,
      address: k.publicKey.toBase58(),
      publicKey: b64(k.publicKey.toBytes()),
    }));
  }
  if (path === "/sign-message") {
    const k = key(body.player);
    const signature = ed25519.sign(
      unb64(body.message),
      k.secretKey.slice(0, 32),
    );
    return { signature: b64(signature) };
  }
  if (path === "/sign-send") {
    const k = key(body.player);
    const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
    tx.partialSign(k);
    await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    const sig = tx.signatures.find((s) => s.publicKey.equals(k.publicKey));
    if (!sig?.signature) throw new Error("not signed");
    return { signature: b64(sig.signature) };
  }
  throw new Error(`unknown route ${path}`);
}

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  let data = "";
  req.on("data", (c: Buffer) => (data += c.toString()));
  req.on("end", () => {
    const body = data
      ? (JSON.parse(data) as Record<string, string>)
      : ({} as Record<string, string>);
    handle(req.url ?? "/", body)
      .then((out) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(out));
      })
      .catch((e: unknown) => {
        console.warn(req.url, String(e));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`test signer on http://127.0.0.1:${PORT} (${DIR})`);
});
