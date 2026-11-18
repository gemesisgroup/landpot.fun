import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GamePhase } from "../../src/server/GameServer";
import {
  DEADLINE_MARGIN_MS,
  decidePaidLobby,
  FILL_GRACE_MS,
  PaidLobbyHost,
  paidGameConfig,
  type PaidGame,
  type PotApi,
} from "../../src/server/PaidLobby";
import { makeClient, makeGame } from "../util/GameServerHarness";
import { testGameConfig } from "../util/Wire";

const T0 = 1_700_000_000_000;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe("decidePaidLobby", () => {
  const base = {
    now: T0,
    fundingEnds: T0 + 20 * 60_000,
    minPlayers: 8,
    maxPlayers: 16,
    lastDepositAt: T0,
  };

  it("waits below the minimum, and cancels near the deadline", () => {
    const depositors = ids(7);
    const connected = new Set(depositors);
    expect(
      decidePaidLobby({
        ...base,
        deposited: depositors.length,
        depositors,
        connected,
      }).type,
    ).toBe("wait");
    expect(
      decidePaidLobby({
        ...base,
        now: base.fundingEnds - DEADLINE_MARGIN_MS,
        deposited: depositors.length,
        depositors,
        connected,
      }),
    ).toEqual({ type: "cancel", reason: "7 of 8 deposited" });
  });

  it("starts at once when every seat is paid and everyone is here", () => {
    const depositors = ids(16);
    expect(
      decidePaidLobby({
        ...base,
        deposited: depositors.length,
        depositors,
        connected: new Set(depositors),
      }).type,
    ).toBe("start");
  });

  it("waits for everyone who paid, then a minute for more", () => {
    const depositors = ids(9);
    const missing = new Set(depositors.slice(1));
    const wait = (now: number, connected: Set<string>) =>
      decidePaidLobby({
        ...base,
        now,
        deposited: depositors.length,
        depositors,
        connected,
      }).type;
    expect(wait(T0 + FILL_GRACE_MS, missing)).toBe("wait");
    expect(wait(T0 + FILL_GRACE_MS - 1, new Set(depositors))).toBe("wait");
    expect(wait(T0 + FILL_GRACE_MS, new Set(depositors))).toBe("start");
  });

  it("starts at the deadline with whoever came, if enough paid and two are here", () => {
    const depositors = ids(8);
    const atDeadline = (connected: string[]) =>
      decidePaidLobby({
        ...base,
        now: base.fundingEnds - DEADLINE_MARGIN_MS,
        deposited: depositors.length,
        depositors,
        connected: new Set(connected),
      });
    expect(atDeadline(["p0", "p5"]).type).toBe("start");
    // One player alone is no match: everyone is refunded.
    expect(atDeadline(["p0", "stranger"])).toEqual({
      type: "cancel",
      reason: "1 of 8 here",
    });
  });

  it("counts deposits on chain, even from wallets with no account here", () => {
    // Eight paid, two of them signed in here and connected.
    const input = {
      ...base,
      deposited: 8,
      depositors: ["p0", "p1"],
      connected: new Set(["p0", "p1"]),
      lastDepositAt: T0 - FILL_GRACE_MS,
    };
    // Not everyone who paid can be here yet, so it waits...
    expect(decidePaidLobby(input).type).toBe("wait");
    // ...and starts at the deadline rather than refunding a full round.
    expect(
      decidePaidLobby({
        ...input,
        now: base.fundingEnds - DEADLINE_MARGIN_MS,
      }).type,
    ).toBe("start");
  });
});

describe("paidGameConfig", () => {
  it("is humans-only FFA with no alliances, whatever the base was", () => {
    const c = paidGameConfig(
      testGameConfig({
        gameType: GameType.Public,
        gameMode: GameMode.Team,
        bots: 400,
        nations: "default",
        trusted: true,
      } as Partial<GameConfig>),
      16,
    );
    expect(c).toMatchObject({
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      bots: 0,
      nations: "disabled",
      disableAlliances: true,
      maxPlayers: 16,
    });
    expect(c.trusted).toBeUndefined();
  });
});

describe("GameServer paid hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stays in the lobby when full, until the round is started", () => {
    const game = makeGame({ config: { maxPlayers: 2 } });
    game.holdForPaidStart();
    const a = makeClient({ persistentID: "a" });
    const b = makeClient({ persistentID: "b" });
    game.joinClient(a);
    game.joinClient(b);
    expect(game.phase()).toBe(GamePhase.Lobby);
    expect(game.connectedPersistentIDs()).toEqual(new Set(["a", "b"]));

    // Only depositors keep their seat.
    game.releasePaidStart(new Set(["a"]));
    expect(game.isPaidHeld()).toBe(false);
    expect(game.connectedPersistentIDs()).toEqual(new Set(["a"]));
    expect(game.phase()).toBe(GamePhase.Active);
  });

  it("closes the lobby when the round is cancelled", () => {
    const game = makeGame();
    game.holdForPaidStart();
    game.joinClient(makeClient({ persistentID: "a" }));
    game.cancelPaidLobby();
    expect(game.phase()).toBe(GamePhase.Finished);
  });
});

describe("PaidLobbyHost", () => {
  class FakeGame implements PaidGame {
    held = false;
    ended = false;
    started = false;
    connected = new Set<string>();
    released: Set<string> | null = null;
    holdForPaidStart() {
      this.held = true;
    }
    isPaidHeld() {
      return this.held;
    }
    hasStarted() {
      return this.started;
    }
    hasEnded() {
      return this.ended;
    }
    connectedPersistentIDs() {
      return new Set(this.connected);
    }
    releasePaidStart(d: ReadonlySet<string>) {
      this.released = new Set(d);
      this.held = false;
      this.started = true;
    }
    cancelPaidLobby() {
      this.held = false;
      this.ended = true;
    }
  }

  function setup() {
    let now = T0;
    const games = new Map<string, FakeGame>();
    const chain = {
      depositors: [] as string[],
      started: false,
      cancelled: false,
      seatCalls: 0,
      down: false,
    };
    const api: PotApi = {
      open: async () => ({
        fundingEnds: (T0 + 20 * 60_000) / 1000,
        minPlayers: 8,
        maxPlayers: 16,
      }),
      lobby: async (id) => ({
        gameId: id,
        phase: chain.started ? 2 : 1,
        minPlayers: 8,
        maxPlayers: 16,
        fundingEnds: (T0 + 20 * 60_000) / 1000,
        deposited: chain.depositors.length,
        depositors: [...chain.depositors],
      }),
      seat: async (_id, pid) => {
        chain.seatCalls++;
        if (chain.down) throw new Error("rpc down");
        return chain.depositors.includes(pid);
      },
      start: async () => {
        chain.started = true;
        return [...chain.depositors];
      },
      cancel: async () => {
        chain.cancelled = true;
      },
    };
    let n = 0;
    const host = new PaidLobbyHost({
      games: {
        game: (id) => games.get(id) ?? null,
        createGame: (id) => {
          const g = new FakeGame();
          games.set(id, g);
          return g;
        },
      },
      api,
      newGameId: () => `Paid${n++}`,
      baseConfig: async () => testGameConfig(),
      isActive: () => true,
      log: () => {},
      now: () => now,
    });
    return {
      host,
      games,
      chain,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("keeps one paid lobby open and starts it with exactly the depositors", async () => {
    const { host, games, chain, advance } = setup();
    await host.tick();
    await host.tick();
    expect([...games.keys()]).toEqual(["Paid0"]);
    const game = games.get("Paid0")!;
    expect(game.held).toBe(true);
    expect(host.isPaid("Paid0")).toBe(true);

    chain.depositors = ids(8);
    game.connected = new Set(ids(8));
    await host.tick(); // the deposit count just changed: wait a minute
    expect(game.released).toBeNull();
    advance(FILL_GRACE_MS);
    await host.tick();
    expect(game.released).toEqual(new Set(ids(8)));
    // Seats stay checkable for reconnects, without asking the API again.
    const calls = chain.seatCalls;
    expect(await host.admits("Paid0", "p3")).toBe(true);
    expect(chain.seatCalls).toBe(calls);

    // The started game is no longer driven; the next lobby opens.
    await host.tick();
    expect([...games.keys()]).toEqual(["Paid0", "Paid1"]);
  });

  it("cancels a lobby that did not fill by the deadline", async () => {
    const { host, games, chain, advance } = setup();
    await host.tick();
    chain.depositors = ids(3);
    advance(20 * 60_000 - DEADLINE_MARGIN_MS);
    await host.tick();
    expect(chain.cancelled).toBe(true);
    expect(games.get("Paid0")!.ended).toBe(true);
  });

  it("seats only depositors and fails closed when the escrow can't be asked", async () => {
    const { host, chain } = setup();
    await host.tick();
    chain.depositors = ["paid"];
    expect(await host.admits("Paid0", "paid")).toBe(true);
    expect(await host.admits("Paid0", "free")).toBe(false);
    chain.down = true;
    await expect(host.admits("Paid0", "other")).rejects.toThrow();
    // Not a paid game: the host has no say.
    expect(host.isPaid("Public1")).toBe(false);
  });
});
