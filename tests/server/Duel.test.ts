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
import type { PaidGame } from "../../src/server/PaidLobby";

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

function host() {
  let now = 1_000_000;
  let n = 0;
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
    newGameId: () => "game" + games.size,
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

  it("cancels a pair that doesn't confirm in time", () => {
    const { h, advance } = host();
    h.joinQueue("alice", "Alice");
    const duel = h.joinQueue("bob", "Bob")!;
    advance(CONFIRM_WINDOW_MS + 1);
    h.tick();
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
    h.tick();
    expect(game.started).toBe(false);
    game.connected.add("bob");
    h.tick();
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
    h.tick();
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
    h.tick();
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
    h.tick();
    h.report(duel.id, "alice", report);
    h.rematch(duel.id, "alice", true);
    const after = h.rematch(duel.id, "bob", false);
    expect(after.id).toBe(duel.id);
    expect(after.rematchId).toBeUndefined();
    expect(() => h.rematch(duel.id, "carol", true)).toThrow("not_found");
  });
});
