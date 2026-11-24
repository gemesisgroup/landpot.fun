import { Connection, Keypair } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../../src/api/ApiEnv";
import { CustodialEscrow } from "../../../src/api/pot/CustodialEscrow";
import { RoundPhase } from "../../../src/api/pot/EscrowChain";
import { roundIdOf } from "../../../src/api/pot/RoundId";

describe("CustodialEscrow", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("parses LANDPOT_POT_MODE=custodial in loadApiConfig", () => {
    const vault = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    const treasury = Keypair.generate().publicKey.toBase58();
    const cfg = loadApiConfig({
      DOMAIN: "localhost",
      LANDPOT_POT_MODE: "custodial",
      LANDPOT_POT_RPC_URL: "https://api.mainnet-beta.solana.com",
      LANDPOT_POT_CLUSTER: "mainnet-beta",
      LANDPOT_POT_MINT: mint,
      LANDPOT_POT_VAULT_KEY: JSON.stringify(Array.from(vault.secretKey)),
      LANDPOT_POT_TREASURY: treasury,
      LANDPOT_POT_STAKE: "10000",
      LANDPOT_POT_BURN_BPS: "200",
      LANDPOT_POT_TREASURY_BPS: "300",
      LANDPOT_POT_REVIEW_DELAY: "15",
    });
    expect(cfg.pot?.mode).toBe("custodial");
    expect(cfg.pot?.mint).toBe(mint);
    expect(cfg.pot?.treasury).toBe(treasury);
    expect(cfg.pot?.stakeTokens).toBe(10000n);
    expect(cfg.pot?.burnBps).toBe(200);
    expect(cfg.pot?.treasuryBps).toBe(300);
    expect(cfg.pot?.reviewDelay).toBe(15);
  });

  it("persists rounds, cancels cleanly, and reports fees", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "landpot-custodial-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "custodial.sqlite");
    const vault = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate().publicKey;
    const conn = new Connection("http://127.0.0.1:8899", "confirmed");

    const chain = new CustodialEscrow({
      connection: conn,
      cluster: "mainnet-beta",
      mint,
      vault,
      treasury,
      dbPath,
      burnBps: 200,
      treasuryBps: 300,
      reviewDelay: 15,
    });

    const rid = roundIdOf("custodial-test-1");
    expect(await chain.fees()).toEqual({
      burnBps: 200,
      treasuryBps: 300,
      reviewDelay: 15,
    });

    await chain.open(rid, 10_000_000_000n, 2, 2, 9999999999n, 9999999999n);
    const st1 = await chain.status(rid);
    expect(st1.phase).toBe(RoundPhase.Funding);
    expect(st1.playerCount).toBe(0);

    await chain.cancel(rid);
    expect((await chain.status(rid)).phase).toBe(RoundPhase.Refunding);

    await chain.close(rid);
    expect((await chain.status(rid)).phase).toBe(RoundPhase.None);
    chain.closeDb();
  });
});
