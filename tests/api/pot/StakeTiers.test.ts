import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../../../src/api/ApiEnv";
import {
  RoundPhase,
  type EscrowChain,
  type RoundStatus,
} from "../../../src/api/pot/EscrowChain";
import { PotError, PotService } from "../../../src/api/pot/PotService";
import type { Hex } from "../../../src/api/pot/RoundId";
import { SqliteStore } from "../../../src/api/Store";

function makeFakeChain() {
  const opened: Array<{ roundId: Hex; stake: bigint }> = [];
  const chain: EscrowChain = {
    cluster: "bsc",
    escrow: "0x" + "9".repeat(40),
    token: async () => ({
      address: "0x1111111111111111111111111111111111111111",
      symbol: "LANDPOT",
      decimals: 18,
    }),
    fees: async () => ({ burnBps: 200, treasuryBps: 300, reviewDelay: 60 }),
    now: async () => 1_700_000_000n,
    status: async (): Promise<RoundStatus> => ({
      phase: RoundPhase.Funding,
      frozen: false,
      playerCount: 0,
      balance: 0n,
      releaseAt: 0n,
    }),
    players: async () => [],
    owed: async () => ({ deposit: 0n, payout: 0n }),
    open: async (roundId, stake) => {
      opened.push({ roundId, stake });
      return "0x" + "ab".repeat(32);
    },
    start: async () => "0x" + "cd".repeat(32),
    cancel: async () => "0x" + "ef".repeat(32),
    propose: async () => "0x" + "12".repeat(32),
    finalize: async () => "0x" + "34".repeat(32),
    close: async () => "0x" + "56".repeat(32),
    depositTx: async () => "",
    claimTx: async () => "",
    txStatus: async () => "confirmed",
  };
  return { chain, opened };
}

describe("multi-tier pot stakes", () => {
  it("parses LANDPOT_POT_STAKES and merges default LANDPOT_POT_STAKE sorted ascending", () => {
    const cfg = loadApiConfig({
      DOMAIN: "localhost",
      LANDPOT_POT_MODE: "bsc",
      LANDPOT_POT_RPC_URL: "https://bsc-dataseed.binance.org",
      LANDPOT_POT_CLUSTER: "bsc",
      LANDPOT_POT_CONTRACT: "0x" + "1".repeat(40),
      LANDPOT_POT_OPERATOR_KEY: "0x" + "2".repeat(64),
      LANDPOT_POT_ORACLE_KEY: "0x" + "3".repeat(64),
      LANDPOT_POT_STAKE: "10000",
      LANDPOT_POT_STAKES: "500000, 50000, 100000, 1000000, 50000",
    });
    expect(cfg.pot?.stakeTokens).toBe(10_000n);
    expect(cfg.pot?.stakeTiersTokens).toEqual([
      10_000n,
      50_000n,
      100_000n,
      500_000n,
      1_000_000n,
    ]);
  });

  it("rejects invalid LANDPOT_POT_STAKES values", () => {
    expect(() =>
      loadApiConfig({
        DOMAIN: "localhost",
        LANDPOT_POT_MODE: "bsc",
        LANDPOT_POT_RPC_URL: "https://bsc-dataseed.binance.org",
        LANDPOT_POT_CLUSTER: "bsc",
        LANDPOT_POT_CONTRACT: "0x" + "1".repeat(40),
        LANDPOT_POT_OPERATOR_KEY: "0x" + "2".repeat(64),
        LANDPOT_POT_ORACLE_KEY: "0x" + "3".repeat(64),
        LANDPOT_POT_STAKE: "10000",
        LANDPOT_POT_STAKES: "10000,0,abc",
      }),
    ).toThrow(/LANDPOT_POT_STAKES/);
  });

  it("opens duels with any allowed tier and rejects disallowed tiers", async () => {
    const { chain, opened } = makeFakeChain();
    const store = new SqliteStore(":memory:");
    const service = new PotService({
      chain,
      store,
      replay: async () => null,
      rules: {
        stakeTokens: 10_000n,
        stakeTiersTokens: [10_000n, 50_000n, 100_000n, 500_000n, 1_000_000n],
        minPlayers: 8,
        maxPlayers: 16,
        fundingSeconds: 1200,
      },
      archived: () => null,
    });

    const row = await service.openDuel("duel-tier-1", undefined, 500_000n);
    const unit = 10n ** 18n;
    expect(row.stake).toBe((500_000n * unit).toString());
    expect(opened[0].stake).toBe(500_000n * unit);

    expect(await service.stakeTiersUnits()).toEqual([
      10_000n * unit,
      50_000n * unit,
      100_000n * unit,
      500_000n * unit,
      1_000_000n * unit,
    ]);

    expect(() => service.openDuel("duel-tier-bad", undefined, 999n)).toThrow(
      PotError,
    );
    store.close();
  });
});
