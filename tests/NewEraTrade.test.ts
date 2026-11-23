import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import {
  BLOCKADE_MAX,
  BLOCKADE_REACH,
  CONTRACTS_PER_PLAYER,
  FREIGHT_MAX_WAIT_TICKS,
  IRON,
  OFFER_TTL_TICKS,
  TWO_STRAITS_DEPOSITS,
  TWO_STRAITS_ZONES,
  blockadePermille,
  blockadeSkips,
  blockadedWeight,
  contractPayment,
  labelLandmasses,
  newEraConfig,
} from "@openfront/engine-lib/game/NewEra";
import { NewEraCommandExecution } from "@openfront/engine/execution/newera/NewEraCommandExecution";
import { NewEraExecution } from "@openfront/engine/execution/newera/NewEraExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import type { Shipment } from "@openfront/engine/game/NewEraEconomy";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const TWO_STRAITS = "../../../resources/maps/twostraits";
const CENTRAL = 0;
const NORTH = 1;

vi.setConfig({ testTimeout: 30_000 });

const RULES = newEraConfig(TWO_STRAITS_DEPOSITS, TWO_STRAITS_ZONES);

interface World {
  game: Game;
  west: Player;
  east: Player;
  /** A third side, holding no land worth mentioning, for rival presence. */
  pirate: Player;
}

let labels: Int32Array | null = null;

/** West and east each hold their own continent; the isles stay empty. */
async function twoStraits(): Promise<World> {
  const game = await setup(
    TWO_STRAITS,
    { gameMap: GameMapType.TwoStraits, newEra: RULES },
    [
      playerInfo("west", PlayerType.Human),
      playerInfo("east", PlayerType.Human),
      playerInfo("pirate", PlayerType.Human),
    ],
  );
  const west = game.player("west");
  const east = game.player("east");
  const pirate = game.player("pirate");
  labels ??= labelLandmasses(game);
  const l = labels;
  const at = (x: number, y: number) => l[y * game.width() + x];
  const westHome = at(250, 260);
  const eastHome = at(1149, 260);
  game.forEachTile((t) => {
    const k = l[game.y(t) * game.width() + game.x(t)];
    if (k === westHome) west.conquer(t);
    else if (k === eastHome) east.conquer(t);
  });
  pirate.conquer(game.ref(700, 330));
  west.setSpawnTile(game.ref(250, 260));
  east.setSpawnTile(game.ref(1149, 260));
  pirate.setSpawnTile(game.ref(700, 330));
  for (const p of [west, east, pirate]) p.addGold(500_000_000n);
  game.addExecution(new NewEraExecution());
  game.executeNextTick();
  return { game, west, east, pirate };
}

/** A port on `p`'s shore nearest (x, y), built at once. */
function portNear(game: Game, p: Player, x: number, y: number): Unit {
  for (let r = 0; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (const dx of [-r, r]) {
        for (const [px, py] of [
          [x + dx, y + dy],
          [x + dy, y + dx],
        ]) {
          if (!game.isValidCoord(px, py)) continue;
          const t = game.ref(px, py);
          if (game.owner(t) !== p || !game.isShore(t)) continue;
          const tile = p.canBuild(UnitType.Port, t);
          if (tile !== false) return p.buildUnit(UnitType.Port, tile, {});
        }
      }
    }
  }
  throw new Error(`no port site for ${p.name()} near ${x},${y}`);
}

/** A ship of `p`'s at sea next to `near` (a port), registered in New Era. */
function warship(
  game: Game,
  p: Player,
  near: Unit,
  cls: "patrol" | "destroyer",
): Unit {
  const e = game.newEra()!;
  const water = e.waterBy(game, near.tile())!;
  const ship = p.buildUnit(UnitType.Warship, water, { patrolTile: water });
  e.ships.set(ship.id(), { cls, task: "harbor", target: 0 });
  return ship;
}

function command(
  game: Game,
  p: Player,
  c: ConstructorParameters<typeof NewEraCommandExecution>[1],
) {
  game.addExecution(new NewEraCommandExecution(p, c));
  game.executeNextTick();
}

/** East sells west oil; both have a home port facing the middle. */
function oilDeal(w: World, rate = 6, price = 1000) {
  const { game, west, east } = w;
  const westPort = portNear(game, west, 583, 330);
  const eastPort = portNear(game, east, 816, 330);
  const e = game.newEra()!;
  e.deliver(east, "oil", 100 * IRON);
  command(game, west, {
    action: "offer_contract",
    seller: east.smallID(),
    kind: "oil",
    rate,
    price,
  });
  const id = Math.max(...e.contracts.keys());
  return { e, id, westPort, eastPort };
}

/** Records every freighter launched. */
function watchLaunches(w: World): Shipment[] {
  const e = w.game.newEra()!;
  const out: Shipment[] = [];
  const inner = e.launch!;
  e.launch = (f) => {
    out.push(f);
    inner(f);
  };
  return out;
}

/** Ticks until the contract's next freighter has landed. */
function untilLanded(
  w: World,
  id: number,
  launched: Shipment[],
  hold = () => {},
) {
  const e = w.game.newEra()!;
  const start = launched.length;
  for (let t = 0; t < 3000; t++) {
    hold();
    w.game.executeNextTick();
    const c = e.contracts.get(id);
    if (launched.length > start && (c === undefined || !c.inFlight)) break;
  }
  expect(launched.length).toBe(start + 1);
  return launched[start];
}

describe("New Era trade rules (pure)", () => {
  it("prices what arrives, per whole unit", () => {
    expect(contractPayment(6 * IRON, 1000)).toBe(6000n);
    expect(contractPayment(IRON / 2, 1000)).toBe(500n);
    expect(contractPayment(0, 1000)).toBe(0n);
    expect(contractPayment(IRON, 0)).toBe(0n);
  });

  it("weighs a blockade by class and oil, up to a cap", () => {
    expect(blockadePermille([])).toBe(0);
    expect(blockadePermille([{ cls: "patrol", oilUtil: 1000 }])).toBe(250);
    expect(blockadePermille([{ cls: "destroyer", oilUtil: 500 }])).toBe(200);
    expect(
      blockadePermille([
        { cls: "destroyer", oilUtil: 1000 },
        { cls: "destroyer", oilUtil: 1000 },
        { cls: "patrol", oilUtil: 1000 },
      ]),
    ).toBe(BLOCKADE_MAX);
  });

  it("skips exactly its share of a port's checks", () => {
    for (const permille of [0, 1, 250, 400, 800]) {
      let skipped = 0;
      for (let i = 0; i < 1000; i++) if (blockadeSkips(i, permille)) skipped++;
      expect(skipped).toBe(permille);
    }
    expect(blockadedWeight(3, 0)).toBe(3000);
    expect(blockadedWeight(3, 400)).toBe(1800);
  });
});

describe("New Era contracts", () => {
  it("offer, accept, ship, pay for what landed", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w, 6, 1000);
    const launched = watchLaunches(w);
    expect(e.contracts.get(id)?.state).toBe("offered");
    // Nothing moves before the seller says yes.
    executeTicks(w.game, 20);
    expect(e.oilLedger(w.east).stock).toBe(100 * IRON);
    command(w.game, w.east, {
      action: "answer_contract",
      contractId: id,
      accept: true,
    });
    const c = e.contracts.get(id)!;
    expect(c.state).toBe("active");
    executeTicks(w.game, 50);
    // The seller's stock feeds the pile at the rate: 6 units a tick.
    expect(c.supply).toBe(1000);
    expect(e.oilLedger(w.east).stock + c.pile).toBe(100 * IRON);

    const westGold = w.west.gold();
    const eastGold = w.east.gold();
    const f = untilLanded(w, id, launched);
    expect(f.owner).toBe(w.east);
    expect(f.consignee).toBe(w.west);
    // A batch (or a little over: the pile is checked every 10 ticks).
    expect(f.cargo).toBeGreaterThanOrEqual(6 * IRON);
    expect(f.cargo).toBeLessThan(6 * IRON + 60);
    // Open water all the way: it all lands, and west pays for it all.
    expect(c.delivered).toBe(f.cargo);
    const due = contractPayment(f.cargo, 1000);
    expect(c.paid).toBe(Number(due));
    expect(e.oilLedger(w.west).stock).toBe(f.cargo);
    // Trade-ship income may land meanwhile; contract gold is exact.
    expect(westGold - w.west.gold()).toBeGreaterThanOrEqual(due - 0n);
    expect(w.east.gold() - eastGold).toBeGreaterThanOrEqual(due);
  });

  it("lets only the seller answer, and the buyer withdraw", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w);
    expect(e.respondContract(w.game, w.west, id, true)).toBe(false);
    expect(e.endContract(w.game, w.east, id)).toBe(false);
    expect(e.endContract(w.game, w.west, id)).toBe(true);
    expect(e.contracts.has(id)).toBe(false);
    // No deals with oneself.
    expect(e.offer(w.game, w.west, w.west, "oil", 5, 100)).toBeNull();
  });

  it("lets an offer lapse, and caps how many a player is party to", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w);
    executeTicks(w.game, OFFER_TTL_TICKS + 10);
    expect(e.contracts.has(id)).toBe(false);
    for (let i = 0; i < CONTRACTS_PER_PLAYER; i++) {
      expect(e.offer(w.game, w.west, w.east, "iron", 1, 10)).not.toBeNull();
    }
    expect(e.offer(w.game, w.west, w.east, "iron", 1, 10)).toBeNull();
  });

  it("feeds a contract only from what the seller's own needs left", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w, 10);
    e.oil.get(w.east.smallID())!.stock = 3;
    e.respondContract(w.game, w.east, id, true);
    executeTicks(w.game, 1);
    const c = e.contracts.get(id)!;
    expect(c.supply).toBe(300);
    executeTicks(w.game, 1);
    expect(c.supply).toBe(0);
  });

  it("ends the deal when the buyer can't pay, keeping what they could", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w, 6, 1_000_000);
    const launched = watchLaunches(w);
    e.respondContract(w.game, w.east, id, true);
    w.west.removeGold(w.west.gold() - 1_000_000n);
    const f = untilLanded(w, id, launched);
    expect(f.price).toBe(1_000_000);
    expect(e.contracts.has(id)).toBe(false);
    expect(e.oilLedger(w.west).stock).toBe(f.cargo);
    expect(w.west.gold()).toBeLessThan(1_000_000n);
  });

  it("counts the buyer's flag with the seller's, not against it", async () => {
    const w = await twoStraits();
    const e = w.game.newEra()!;
    const row = new Array<number>(TWO_STRAITS_ZONES.length).fill(0);
    row[CENTRAL] = 700;
    e.presence.set(w.west.smallID(), row);
    // To east alone west's ships are a rival…
    expect(e.lossIn(w.game, w.east, CENTRAL, -1)).toBe(420);
    // …but on west's own import they guard the cargo.
    expect(e.lossIn(w.game, w.east, CENTRAL, -1, w.west)).toBe(0);
    const pirate = [...row];
    pirate[CENTRAL] = 900;
    e.presence.set(w.pirate.smallID(), pirate);
    expect(e.lossIn(w.game, w.east, CENTRAL, -1, w.west)).toBe(
      e.lossIn(w.game, w.west, CENTRAL, -1),
    );
  });

  it("goes round by the north when a rival holds the central strait", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w, 6, 10);
    const launched = watchLaunches(w);
    e.respondContract(w.game, w.east, id, true);
    const options = e.contractRoutes.get(id)!;
    expect(options[0].via).toBe(-1);
    expect(options[0].zones).toContain(CENTRAL);
    const north = options.find((o) => o.via === NORTH)!;
    expect(north).toBeDefined();
    expect(north.zones).not.toContain(CENTRAL);
    expect(north.ticks).toBeGreaterThan(options[0].ticks);

    const hold = () => {
      const row = new Array<number>(TWO_STRAITS_ZONES.length).fill(0);
      row[CENTRAL] = 1000;
      e.presence.set(w.pirate.smallID(), row);
    };
    const share = (f: Shipment, before: number) =>
      Math.floor(((e.contracts.get(id)!.delivered - before) * 1000) / f.cargo);
    // Straight through the strait: the 60% toll.
    let before = e.contracts.get(id)!.delivered;
    const direct = share(untilLanded(w, id, launched, hold), before);
    expect(direct).toBeLessThanOrEqual(420);
    // The way round: longer, but whole.
    command(w.game, w.west, {
      action: "contract_route",
      contractId: id,
      via: NORTH,
    });
    before = e.contracts.get(id)!.delivered;
    const round = share(untilLanded(w, id, launched, hold), before);
    expect(round).toBe(1000);
  });

  it("keeps contracts and freighters through a snapshot", async () => {
    const w = await twoStraits();
    const { e, id } = oilDeal(w);
    e.respondContract(w.game, w.east, id, true);
    command(w.game, w.east, {
      action: "contract_route",
      contractId: id,
      via: NORTH,
    });
    executeTicks(w.game, FREIGHT_MAX_WAIT_TICKS + 20);
    expect(e.contracts.get(id)!.inFlight).toBe(true);
    const restored = await expectSnapshotRoundTrip(w.game, TWO_STRAITS, 30);
    const r = restored.newEra()!;
    expect(r.contracts.get(id)).toEqual(e.contracts.get(id));
    expect(r.nextContractId).toBe(e.nextContractId);
    expect([...r.contractRoutes]).toEqual([...e.contractRoutes]);
  });
});

describe("New Era blockades", () => {
  it("blockades only a rival's port, and only from close by", async () => {
    const w = await twoStraits();
    const e = w.game.newEra()!;
    const westPort = portNear(w.game, w.west, 583, 330);
    const eastPort = portNear(w.game, w.east, 816, 330);
    e.deliver(w.east, "oil", 30 * IRON);
    const ship = warship(w.game, w.east, eastPort, "destroyer");
    // Not one's own port.
    expect(e.setTask(w.game, ship, "blockade", eastPort.id())).toBe(false);
    expect(e.setTask(w.game, ship, "blockade", westPort.id())).toBe(true);
    expect(ship.warshipState().patrolTile).toBe(
      e.waterBy(w.game, westPort.tile()),
    );
    // Still far off: no effect yet.
    expect(w.game.manhattanDist(ship.tile(), westPort.tile())).toBeGreaterThan(
      BLOCKADE_REACH,
    );
    expect(e.blockadeOf(w.game, westPort)).toBe(0);
    ship.move(e.waterBy(w.game, westPort.tile())!);
    executeTicks(w.game, 1);
    expect(e.blockadeOf(w.game, westPort)).toBe(400);
    // It burns oil like any task.
    expect(e.oilLedger(w.east).demand).toBe(2);
    // Peace ends it.
    w.west.createAllianceRequest(w.east)?.accept();
    executeTicks(w.game, 10);
    expect(e.shipInfo(ship)?.task).toBe("harbor");
    expect(e.blockadeOf(w.game, westPort)).toBe(0);
  });

  it("holds its post under way: a real warship sails over and stays", async () => {
    const w = await twoStraits();
    const e = w.game.newEra()!;
    const westPort = portNear(w.game, w.west, 583, 330);
    const eastPort = portNear(w.game, w.east, 816, 330);
    e.deliver(w.east, "oil", 60 * IRON);
    const ship = warship(w.game, w.east, eastPort, "destroyer");
    w.game.addExecution(new WarshipExecution(ship));
    command(w.game, w.east, {
      action: "ship_task",
      shipId: ship.id(),
      task: "blockade",
      target: westPort.id(),
    });
    // Sail across, then watch for a minute.
    for (let t = 0; t < 1500; t++) {
      w.game.executeNextTick();
      if (e.blockadeOf(w.game, westPort) > 0) break;
    }
    let on = 0;
    for (let i = 0; i < 60; i++) {
      executeTicks(w.game, 10);
      if (e.blockadeOf(w.game, westPort) > 0) on++;
    }
    expect(ship.isActive()).toBe(true);
    expect(on).toBeGreaterThanOrEqual(54);
  });

  it("takes its share of cargo at the port; another port is the way out", async () => {
    const w = await twoStraits();
    const { e, id, westPort } = oilDeal(w, 6, 10);
    const launched = watchLaunches(w);
    e.respondContract(w.game, w.east, id, true);
    e.deliver(w.pirate, "oil", 30 * IRON);
    const ship = warship(w.game, w.pirate, westPort, "destroyer");
    expect(e.setTask(w.game, ship, "blockade", westPort.id())).toBe(true);
    ship.move(e.waterBy(w.game, westPort.tile())!);
    // Keep the blockader's flag out of the sea zones: only the port counts.
    const quiet = () => e.presence.delete(w.pirate.smallID());
    let before = e.contracts.get(id)!.delivered;
    let f = untilLanded(w, id, launched, quiet);
    expect(f.unload).toBe(westPort);
    const blocked = e.contracts.get(id)!.delivered - before;
    expect(blocked).toBe(Math.floor((f.cargo * 600) / 1000));
    // West opens a second port up the coast: freight avoids the blockade.
    const other = portNear(w.game, w.west, 583, 150);
    expect(e.contractPorts(w.game, e.contracts.get(id)!)?.unload).toBe(other);
    before = e.contracts.get(id)!.delivered;
    f = untilLanded(w, id, launched, quiet);
    expect(f.unload).toBe(other);
    expect(e.contracts.get(id)!.delivered - before).toBe(f.cargo);
  });
});
