import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../../../src/api/ApiEnv";
import { netPot, splitPot } from "../../../src/api/pot/Payouts";
import { roundIdOf } from "../../../src/api/pot/RoundId";
import {
  buildSiwsMessage,
  isAddress,
  newNonce,
  verifySignature,
} from "../../../src/api/Siws";

describe("BSC / EVM integration", () => {
  it("parses LANDPOT_POT_MODE=bsc in loadApiConfig", () => {
    const opKey = generatePrivateKey();
    const orKey = generatePrivateKey();
    const contract = privateKeyToAccount(generatePrivateKey()).address;
    const cfg = loadApiConfig({
      DOMAIN: "localhost",
      LANDPOT_POT_MODE: "bsc",
      LANDPOT_POT_RPC_URL: "https://bsc-dataseed.binance.org",
      LANDPOT_POT_CLUSTER: "bsc",
      LANDPOT_POT_CONTRACT: contract,
      LANDPOT_POT_OPERATOR_KEY: opKey,
      LANDPOT_POT_ORACLE_KEY: orKey,
      LANDPOT_POT_STAKE: "10000",
    });
    expect(cfg.pot?.mode).toBe("bsc");
    expect(cfg.pot?.cluster).toBe("bsc");
    expect(cfg.pot?.programId).toBe(contract);
    expect(cfg.pot?.evmOperatorKey).toBe(opKey);
    expect(cfg.pot?.evmOracleKey).toBe(orKey);
    expect(cfg.pot?.stakeTokens).toBe(10000n);
  });

  it("verifies EVM EIP-191 personal_sign messages for BSC accounts", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(isAddress(account.address)).toBe(true);

    const msg = buildSiwsMessage({
      siteOrigin: "https://landpot.fun",
      address: account.address,
      chainId: "bsc",
      nonce: newNonce(),
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(msg).toContain("BNB Chain account:");
    expect(msg).toContain("Chain ID: 56");

    const sig = await account.signMessage({ message: msg });
    expect(await verifySignature(msg, sig, account.address)).toBe(true);
    expect(await verifySignature(msg + "!", sig, account.address)).toBe(false);
  });

  it("splits pot deterministically for 0x EVM wallet addresses", () => {
    const p1 = privateKeyToAccount(generatePrivateKey()).address;
    const p2 = privateKeyToAccount(generatePrivateKey()).address;
    const net = netPot(20_000n * 10n ** 18n, {
      burnBps: 200,
      treasuryBps: 300,
    });
    expect(net).toBe(19_000n * 10n ** 18n);

    const amounts = splitPot({
      net,
      roundId: roundIdOf("bsc-duel-1"),
      players: [p1, p2],
      land: new Map([
        [p1, 100n],
        [p2, 0n],
      ]),
    });
    expect(amounts).toEqual([19_000n * 10n ** 18n, 0n]);
  });
});
