import {
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Uploads a program into a BPF upgradeable-loader buffer, slowly and
 * resumably, for `solana program deploy --buffer <address>` to finish.
 *
 * The CLI's own upload sends hundreds of writes at once; the public devnet
 * RPC answers that with 429s, and the CLI's retries keep the limit tripped
 * (a 480 KB program took 30 minutes for 39 chunks). This writes one chunk at
 * a time, backs off on 429, then reads the buffer back and rewrites only the
 * chunks that differ, so a rerun picks up where the last one stopped.
 */

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Buffer state: enum tag (4) + Option<authority> (1 + 32). */
const HEADER = 37;
/** Bytes per write: fits a one-signer legacy transaction (1232 bytes). */
const CHUNK = 950;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let wait = 2_000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      return await f();
    } catch (e) {
      if (
        !/429|too many|rate limit|fetch failed|ECONN|timed? ?out/i.test(
          String(e),
        )
      ) {
        throw e;
      }
      await sleep(wait);
    }
  }
}

function loaderIx(data: Buffer, buffer: PublicKey, authority: PublicKey) {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function writeIx(
  buffer: PublicKey,
  authority: PublicKey,
  offset: number,
  bytes: Uint8Array,
) {
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32LE(1, 0); // Write
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  data.set(bytes, 16);
  const ix = loaderIx(data, buffer, authority);
  ix.keys[1].isSigner = true;
  return ix;
}

/** Creates the buffer (if missing) and fills it with `program`. */
export async function uploadBuffer(
  connection: Connection,
  payer: Keypair,
  buffer: Keypair,
  program: Uint8Array,
  log: (line: string) => void = console.log,
): Promise<void> {
  const address = buffer.publicKey;
  if (!(await patient(() => connection.getAccountInfo(address)))) {
    const space = HEADER + program.length;
    const lamports = await patient(() =>
      connection.getMinimumBalanceForRentExemption(space),
    );
    const init = Buffer.alloc(4); // InitializeBuffer
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: address,
        lamports,
        space,
        programId: LOADER,
      }),
      loaderIx(init, address, payer.publicKey),
    );
    const { blockhash, lastValidBlockHeight } = await patient(() =>
      connection.getLatestBlockhash(),
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer, buffer);
    const sig = await patient(() =>
      connection.sendRawTransaction(tx.serialize()),
    );
    await patient(() =>
      connection.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      }),
    );
    log(`buffer ${address.toBase58()} created`);
  }

  const total = Math.ceil(program.length / CHUNK);
  for (let pass = 1; pass <= 20; pass++) {
    const info = await patient(() => connection.getAccountInfo(address));
    if (!info || info.data.length < HEADER + program.length) {
      throw new Error(
        `${address.toBase58()} is not a buffer of the right size`,
      );
    }
    const have = info.data.subarray(HEADER);
    const todo: number[] = [];
    for (let off = 0; off < program.length; off += CHUNK) {
      const want = program.subarray(off, off + CHUNK);
      if (!Buffer.from(have.subarray(off, off + want.length)).equals(want)) {
        todo.push(off);
      }
    }
    log(`upload pass ${pass}: ${todo.length} of ${total} chunks to write`);
    if (todo.length === 0) return;

    let blockhash = "";
    let fetchedAt = 0;
    for (const off of todo) {
      if (Date.now() - fetchedAt > 30_000) {
        blockhash = (await patient(() => connection.getLatestBlockhash()))
          .blockhash;
        fetchedAt = Date.now();
      }
      const tx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: blockhash,
      });
      tx.add(
        writeIx(
          address,
          payer.publicKey,
          off,
          program.subarray(off, off + CHUNK),
        ),
      );
      tx.sign(payer);
      await patient(() =>
        connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 5,
        }),
      );
      await sleep(400);
    }
    // Let the writes land before reading the buffer back.
    await sleep(25_000);
  }
  throw new Error("the buffer is still incomplete after 20 passes; run again");
}
