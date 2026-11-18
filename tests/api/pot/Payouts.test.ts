import { describe, expect, it } from "vitest";
import { roundIdOf } from "../../../src/api/pot/Oracle";
import {
  netPot,
  NoTerritoryError,
  splitPot,
} from "../../../src/api/pot/Payouts";

const P = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const roundId = roundIdOf("GamePaid1");
const land = (entries: [number, number][]) =>
  new Map(entries.map(([i, t]) => [P(i), BigInt(t)]));

describe("netPot", () => {
  it("floors the burn and the treasury cut separately", () => {
    // The prototype's worked example: 8 × 20 = 160, 2% burn, 3% treasury.
    expect(netPot(160n, { burnBps: 200, treasuryBps: 300 })).toBe(153n);
    // 3.2 → 3 and 4.8 → 4: one combined floor (5% of 160 = 8) would give 152.
    expect(160n - (160n * 500n) / 10_000n).toBe(152n);
  });
});

describe("splitPot", () => {
  const players = [P(1), P(2), P(3), P(4)];

  it("splits by land and sums to the net pot exactly", () => {
    const amounts = splitPot({
      net: 153n,
      roundId,
      players,
      land: land([
        [1, 100],
        [2, 50],
        [3, 30],
        [4, 20],
      ]),
    });
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(153n);
    // 153 × 100/200 = 76.5, × 50/200 = 38.25, × 30/200 = 22.95, × 20/200 = 15.3
    // floors 76+38+22+15 = 151; the two units left go to .95 and .5.
    expect(amounts).toEqual([77n, 38n, 23n, 15n]);
  });

  it("gives a depositor with no land nothing", () => {
    const amounts = splitPot({
      net: 100n,
      roundId,
      players,
      land: land([
        [1, 3],
        [3, 1],
      ]),
    });
    expect(amounts).toEqual([75n, 0n, 25n, 0n]);
  });

  it("is in contract order and ignores land of non-depositors", () => {
    const amounts = splitPot({
      net: 10n,
      roundId,
      players: [P(2), P(1)],
      land: land([
        [1, 1],
        [2, 1],
        [9, 1000],
      ]),
    });
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(10n);
    expect(amounts).toEqual([5n, 5n]);
  });

  it("breaks equal remainders by a hash nobody picks, the same every time", () => {
    const run = () =>
      splitPot({
        net: 10n,
        roundId,
        players: [P(1), P(2), P(3)],
        land: land([
          [1, 1],
          [2, 1],
          [3, 1],
        ]),
      });
    const a = run();
    expect(a.reduce((x, y) => x + y, 0n)).toBe(10n);
    expect([...a].sort()).toEqual([3n, 3n, 4n]);
    expect(run()).toEqual(a);
    // A different round can favour someone else, but stays exact.
    const other = splitPot({
      net: 10n,
      roundId: roundIdOf("GamePaid2"),
      players: [P(1), P(2), P(3)],
      land: land([
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    });
    expect(other.reduce((x, y) => x + y, 0n)).toBe(10n);
  });

  it("matches addresses whatever their case", () => {
    const upper = `0x${"AB".repeat(20)}` as `0x${string}`;
    const amounts = splitPot({
      net: 7n,
      roundId,
      players: [upper],
      land: new Map([[upper.toLowerCase(), 5n]]),
    });
    expect(amounts).toEqual([7n]);
  });

  it("refunds a depositor who missed the start, less their share of fees", () => {
    // 8 × 20 = 160, net 153. Two never came: each gets floor(153 / 8) = 19
    // back; the six who played split the other 115 by land.
    const eight = Array.from({ length: 8 }, (_, i) => P(i + 1));
    const amounts = splitPot({
      net: 153n,
      roundId,
      players: eight,
      land: land([
        [1, 100],
        [2, 50],
        [3, 30],
        [4, 20],
        [7, 999], // not in the match: land can't count
      ]),
      played: new Set(eight.slice(0, 6).map((p) => p.toUpperCase())),
    });
    expect(amounts.slice(6)).toEqual([19n, 19n]);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(153n);
    // 115 × 100/200 = 57.5, × 50/200 = 28.75, × 30/200 = 17.25, × 20/200 = 11.5
    expect(amounts.slice(0, 4).reduce((a, b) => a + b, 0n)).toBe(115n);
    expect(amounts[1]).toBe(29n);
    expect(amounts.slice(4, 6)).toEqual([0n, 0n]);
  });

  it("is void when nobody who played holds land", () => {
    expect(() =>
      splitPot({
        net: 153n,
        roundId,
        players,
        land: land([[3, 10]]),
        played: new Set([P(1), P(2)]),
      }),
    ).toThrow(NoTerritoryError);
  });

  it("refuses a round where nobody holds land, or a repeated depositor", () => {
    expect(() =>
      splitPot({ net: 10n, roundId, players, land: new Map() }),
    ).toThrow(NoTerritoryError);
    expect(() =>
      splitPot({
        net: 10n,
        roundId,
        players: [P(1), P(1)],
        land: land([[1, 1]]),
      }),
    ).toThrow(/duplicate/);
  });
});
