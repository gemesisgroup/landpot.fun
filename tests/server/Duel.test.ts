import type { GameConfig } from "@openfront/engine-api/Schemas";
import { DUEL_CALDERA, DUEL_MINUTES } from "@openfront/shared/PaidMatch";
import {
  CONFIRM_WINDOW_MS,
  DuelHost,
  INVITE_TTL_MS,
  QUEUE_STALE_MS,
  START_WINDOW_MS,
  duelGameConfig,
  duelView,
} from "../../src/server/Duel";
import type { PaidGame, PotApi } from "../../src/server/PaidLobby";

class FakeGame implements PaidGame {
  held = false;
  started = false;
  ended = false;
  connected = new Set<string>();
  pairs?: string[][];
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
    return this.connected;
  }
  releasePaidStart(_d: ReadonlySet<string>, pairs?: string[][]) {
    this.held = false;
    this.started = true;
    this.pairs = pairs;
  }
  cancelPaidLobby() {
    this.ended = true;
  }
}

function host(pot?: PotApi) {
  let now = 1_000_000;
  let n = 0;
  let gNum = 0;
  const games = new Map<string, FakeGame>();
  const h = new DuelHost({
    games: {
      game: (id) => games.get(id) ?? null,
      createGame: (id) => {
        const g = new FakeGame();
        games.set(id, g);
        return g;
      },
    },
    pot,
    newGameId: () => "game" + gNum++,
    baseConfig: async () => ({}) as GameConfig,
    log: () => {},
    now: () => now,
    newId: () => "d" + n++,
  });
  return {
    h,
    games,
    advance: (ms: number) => (now += ms),
  };
}

const report = {
  winner: 1 as const,
  seconds: 360,
  sides: [
    { crater: 0, rim: 900, firstCraterSecond: null },
    { crater: 600, rim: 400, firstCraterSecond: 95 },
  ],
};

describe("Caldera duel host", () => {
  it("builds a six-minute 1v1 on Caldera with mirrored starts", () => {
    const c = duelGameConfig({} as GameConfig);
    expect(c.maxPlayers).toBe(2);
    expect(c.playerTeams).toBe(2);
    expect(c.maxTimerValue).toBe(DUEL_MINUTES);
    expect(c.caldera).toEqual(DUEL_CALDERA);
    expect(c.bots).toBe(0);
    expect(c.disableAlliances).toBe(true);
  });

  it("pairs by link only after the friend confirms, then both confirm", async () => {
    const { h, games } = host();
    const duel = h.invite("alice", "Alice");
    expect(h.readInvite(duel.id, null)).toEqual({
      state: "open",
      inviter: "Alice",
    });
    expect(h.readInvite(duel.id, "alice").state).toBe("self");
    // Opening the link changes nothing.
    expect(duel.phase).toBe("invite");
    h.acceptInvite(duel.id, "bob", "Bob");
    expect(h.readInvite(duel.id, "carol").state).toBe("taken");
    expect(h.readInvite(duel.id, "bob").state).toBe("joined");
    expect(() => h.acceptInvite(duel.id, "carol", "Carol")).toThrow("taken");
    expect(duelView(duel, "bob").opponent).toEqual({
      name: "Alice",
      ready: false,
      funded: false,
    });
    await h.confirm(duel.id, "alice");
    expect(games.size).toBe(0);
    await h.confirm(duel.id, "bob");
    expect(duel.phase).toBe("starting");
    const game = games.get(duel.gameId!)!;
    expect(game.held).toBe(true);
    expect(h.admits(duel.gameId!, "bob")).toBe(true);
    expect(h.admits(duel.gameId!, "carol")).toBe(false);
  });

  it("expires an unused link", () => {
    const { h, advance } = host();
    const duel = h.invite("alice", "Alice");
    advance(INVITE_TTL_MS + 1);
    expect(h.readInvite(duel.id, "bob").state).toBe("expired");
    expect(() => h.acceptInvite(duel.id, "bob", "Bob")).toThrow("expired");
    expect(h.readInvite("nope", "bob").state).toBe("expired");
  });

  it("matches the first two in the queue, never a player with themself", () => {
    const { h } = host();
    expect(h.joinQueue("alice", "Alice")).toBeNull();
    expect(h.joinQueue("alice", "Alice")).toBeNull();
    const duel = h.joinQueue("bob", "Bob")!;
    expect(duel.kind).toBe("queue");
    expect(duel.sides.map((s) => s.pid)).toEqual(["alice", "bob"]);
    expect(h.active("alice")?.id).toBe(duel.id);
    expect(h.inQueue("alice")).toBe(false);
  });

  it("drops a queued player who stopped polling", () => {
    const { h, advance } = host();
    h.joinQueue("alice", "Alice");
    advance(QUEUE_STALE_MS + 1);
    expect(h.joinQueue("bob", "Bob")).toBeNull();
    expect(h.inQueue("bob")).toBe(true);
    expect(h.stats().queueAbandoned).toBe(1);
  });

  it("cancels a pair that doesn't confirm in time", async () => {
    const { h, advance } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    advance(CONFIRM_WINDOW_MS + 1);
    await h.tick();
    expect(duel.phase).toBe("cancelled");
    expect(duel.reason).toBe("not_confirmed");
  });

  it("starts the moment both are in, one team each, side 0 first", async () => {
    const { h, games } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    await h.confirm(duel.id, "alice");
    await h.confirm(duel.id, "bob");
    const game = games.get(duel.gameId!)!;
    game.connected.add("alice");
    await h.tick();
    expect(game.started).toBe(false);
    game.connected.add("bob");
    await h.tick();
    expect(game.started).toBe(true);
    expect(game.pairs).toEqual([["alice"], ["bob"]]);
    expect(duel.phase).toBe("playing");
  });

  it("drops the game when one player never comes", async () => {
    const { h, games, advance } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    await h.confirm(duel.id, "alice");
    await h.confirm(duel.id, "bob");
    const game = games.get(duel.gameId!)!;
    game.connected.add("alice");
    advance(START_WINDOW_MS + 1);
    await h.tick();
    expect(game.ended).toBe(true);
    expect(duel.phase).toBe("cancelled");
    expect(duel.reason).toBe("no_show");
    expect(h.stats().cancelled).toEqual({ no_show: 1 });
  });

  it("makes a rematch only when both say yes, and counts who asked", async () => {
    const { h, games, advance } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    await h.confirm(duel.id, "alice");
    await h.confirm(duel.id, "bob");
    const game = games.get(duel.gameId!)!;
    game.connected = new Set(["alice", "bob"]);
    advance(20_000);
    await h.tick();
    h.report(duel.id, "bob", report);
    expect(duel.phase).toBe("ended");
    // The loser (alice) asks first.
    expect(h.rematch(duel.id, "alice", true).id).toBe(duel.id);
    advance(5_000);
    const next = h.rematch(duel.id, "bob", true);
    expect(next.id).not.toBe(duel.id);
    expect(next.phase).toBe("confirm");
    expect(next.rematchOf).toBe(duel.id);
    // Each confirms the new duel on their own.
    expect(next.sides.every((s) => !s.ready)).toBe(true);
    expect(h.active("alice")?.id).toBe(next.id);
    const s = h.stats();
    expect(s).toMatchObject({
      pairsFound: 1,
      fromQueue: 1,
      reachedMatch: 1,
      decided: 1,
      loserAskedRematch: 1,
      loserAskedFirst: 1,
      winnerCraterShare: [60],
      loserCraterShare: [0],
    });
    expect(s.secondsToStart.median).toBe(20);
  });

  it("doesn't make a rematch when one says no", async () => {
    const { h, games } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    await h.confirm(duel.id, "alice");
    await h.confirm(duel.id, "bob");
    games.get(duel.gameId!)!.connected = new Set(["alice", "bob"]);
    await h.tick();
    h.report(duel.id, "alice", report);
    h.rematch(duel.id, "alice", true);
    const after = h.rematch(duel.id, "bob", false);
    expect(after.id).toBe(duel.id);
    expect(after.rematchId).toBeUndefined();
    expect(() => h.rematch(duel.id, "carol", true)).toThrow("not_found");
  });

  it("opens an escrow round for paid duels, starts once both pay, and requires a new deposit on rematch", async () => {
    const deposited = new Map<string, string[]>();
    const started: string[] = [];
    const cancelled: { id: string; count: number }[] = [];
    const pot: PotApi = {
      open: async () => ({ fundingEnds: 2000, minPlayers: 8, maxPlayers: 16 }),
      openDuel: async (id) => {
        deposited.set(id, []);
        return { duel: true, fundingEnds: 2000, minPlayers: 2, maxPlayers: 2 };
      },
      lobby: async (id) => ({
        gameId: id,
        phase: 1,
        minPlayers: 2,
        maxPlayers: 2,
        fundingEnds: 2000,
        deposited: deposited.get(id)?.length ?? 0,
        depositors: deposited.get(id) ?? [],
      }),
      seat: async () => true,
      start: async (id) => {
        started.push(id);
        return deposited.get(id) ?? [];
      },
      cancel: async (id, count) => {
        cancelled.push({ id, count });
      },
    };
    const { h, games, advance } = host(pot);
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    await h.confirm(duel.id, "alice");
    await h.confirm(duel.id, "bob");
    expect(duel.phase).toBe("funding");
    expect(duel.paid).toBe(true);
    expect(games.size).toBe(0);

    // Only Alice pays: duel stays in funding.
    deposited.get(duel.gameId!)!.push("alice");
    await h.tick();
    expect(duel.phase).toBe("funding");
    expect(duelView(duel, "alice")).toMatchObject({
      funded: true,
      opponent: { name: "Bob", ready: true, funded: false },
    });

    // Bob pays too: escrow starts and the game is created.
    deposited.get(duel.gameId!)!.push("bob");
    advance(3_000);
    await h.tick();
    expect(started).toEqual([duel.gameId]);
    expect(duel.phase).toBe("starting");
    const game = games.get(duel.gameId!)!;
    game.connected = new Set(["alice", "bob"]);
    await h.tick();
    expect(duel.phase).toBe("playing");

    // Rematch opens a fresh confirm -> funding cycle requiring new deposits.
    h.report(duel.id, "alice", report);
    h.rematch(duel.id, "alice", true);
    const rematch = h.rematch(duel.id, "bob", true);
    expect(rematch.phase).toBe("confirm");
    await h.confirm(rematch.id, "alice");
    await h.confirm(rematch.id, "bob");
    expect(rematch.phase).toBe("funding");
    expect(rematch.gameId).not.toBe(duel.gameId);

    // Declining during funding cancels the escrow round for a full refund.
    deposited.get(rematch.gameId!)!.push("alice");
    await h.decline(rematch.id, "bob");
    expect(rematch.phase).toBe("cancelled");
    expect(cancelled).toEqual([{ id: rematch.gameId!, count: 1 }]);
  });

  it("persists completed duel stats across restarts", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.tmpdir(), `duel-stats-${Date.now()}.json`);
    try {
      let now = 1_000_000;
      const games = new Map<string, FakeGame>();
      const makeHost = () =>
        new DuelHost({
          games: {
            game: (id) => games.get(id) ?? null,
            createGame: (id) => {
              const g = new FakeGame();
              games.set(id, g);
              return g;
            },
          },
          statsFile: file,
          newGameId: () => "g" + games.size,
          baseConfig: async () => ({}) as GameConfig,
          log: () => {},
          now: () => now,
        });
      const h1 = makeHost();
      h1.joinQueue("alice", "Alice");
      const d = h1.joinQueue("bob", "Bob")!;
      await h1.confirm(d.id, "alice");
      await h1.confirm(d.id, "bob");
      games.get(d.gameId!)!.connected = new Set(["alice", "bob"]);
      now += 15_000;
      await h1.tick();
      h1.report(d.id, "bob", report);
      h1.rematch(d.id, "alice", true);

      // Fresh DuelHost instance loads the persisted stats from disk.
      const h2 = makeHost();
      expect(h2.stats()).toMatchObject({
        pairsFound: 1,
        reachedMatch: 1,
        decided: 1,
        loserAskedRematch: 1,
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
