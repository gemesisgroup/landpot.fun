import {
  AllPlayersStats,
  ClientID,
  District,
  FactorySpec,
  ShipClass,
  ShipTask,
  Winner,
} from "../Schemas";
import { TileRef } from "./GameMap";
import {
  EmojiMessage,
  GameUpdates,
  Gold,
  MessageType,
  NameViewData,
  NukeState,
  PlayerID,
  PlayerType,
  SamLauncherState,
  Team,
  Tick,
  TrainType,
  TransportShipState,
  UnitType,
  WarshipState,
} from "./GameTypes";

export interface GameUpdateViewData {
  tick: number;
  updates: GameUpdates;
  /**
   * Packed tile updates as `[tileRef, state]` uint32 pairs.
   *
   * `tileRef` is a `TileRef` (fits in uint32), and `state` is the packed per-tile
   * state (`uint16`) stored in a `uint32` lane.
   */
  packedTileUpdates: Uint32Array;
  /**
   * Optional packed motion plan records.
   *
   * When present, this buffer is expected to be transferred worker -> main
   * (similar to `packedTileUpdates`) to avoid structured-clone copies.
   */
  packedMotionPlans?: Uint32Array;
  /**
   * Packed unit updates (stride of 21 floats per unit, see UNIT_UPDATE_STRIDE).
   */
  packedUnitUpdates?: Float64Array;
  /**
   * Packed missile timer queues.
   * Format: `[unitId, queueLength, timer1, timer2, ...]`.
   */
  packedMissileTimers?: Uint32Array;
  /**
   * Packed per-player numeric stats as
   * `[smallID, tilesOwned, gold, troops, goldEarned]`
   * float64 quints — the fields that change for nearly every alive player
   * every tick. They travel here (transferred, not structured-cloned) instead
   * of in `PlayerUpdate` object diffs, which only carry them on a player's
   * first emission. Gold is exact in a float64 (game values stay far below
   * 2^53). Absent when no player's stats changed.
   */
  packedPlayerUpdates?: Float64Array;
  /**
   * Packed attack troop-count changes as
   * `[ownerSmallID, direction, index, troops]` float64 quads, where
   * `direction` is 0 for the owner's outgoingAttacks and 1 for
   * incomingAttacks, and `index` addresses that array. Troop counts change
   * every tick for every active attack, so they travel here instead of
   * re-sending whole attack arrays in PlayerUpdate diffs; the arrays
   * themselves are only resent when membership/order/retreating changes —
   * which also guarantees the receiver's indexes line up (see
   * packAttackTroopDeltas). Absent when no attack troop count changed.
   */
  packedAttackUpdates?: Float64Array;
  /**
   * Name placement per player. Only present on ticks where the worker
   * recomputed placements (spawn ticks, the first ticks, every 30th tick,
   * spawn end) — between those the values wouldn't change, so the record is
   * omitted instead of re-cloned every tick. Consumers keep the last applied
   * values.
   */
  playerNameViewData?: Record<string, NameViewData>;
  tickExecutionDuration?: number;
  pendingTurns?: number;
  /**
   * Packed tile refs that were inside a nuke blast radius this tick.
   * Used by the renderer to mark nukeable layer tiles as destroyed.
   * Absent when no nukes detonated.
   */
  packedNukeImpacts?: Uint32Array;
}

/**
 * Direction lane of a `packedAttackUpdates` quad: which of the owner's attack
 * arrays the index addresses. Encoder (PlayerImpl.toUpdate →
 * packAttackTroopDeltas) and decoder (client GameView.update) must both use
 * these.
 */
export const ATTACK_DELTA_OUTGOING = 0;
export const ATTACK_DELTA_INCOMING = 1;

export interface ErrorUpdate {
  errMsg: string;
  stack?: string;
}

export enum GameUpdateType {
  // Tile updates are delivered via `packedTileUpdates` on the outer GameUpdateViewData.
  Tile,
  Unit,
  Player,
  DisplayEvent,
  DisplayChatEvent,
  AllianceRequest,
  AllianceRequestReply,
  BrokeAlliance,
  AllianceExpired,
  AllianceExtension,
  TargetPlayer,
  Emoji,
  Win,
  Hash,
  UnitIncoming,
  BonusEvent,
  RailroadDestructionEvent,
  RailroadConstructionEvent,
  RailroadSnapEvent,
  ConquestEvent,
  EmbargoEvent,
  SpawnPhaseEnd,
  GamePaused,
  DonateEvent,
  NewEra,
}

export type GameUpdate =
  | UnitUpdate
  | PlayerUpdate
  | AllianceRequestUpdate
  | AllianceRequestReplyUpdate
  | BrokeAllianceUpdate
  | AllianceExpiredUpdate
  | DisplayMessageUpdate
  | DisplayChatMessageUpdate
  | TargetPlayerUpdate
  | EmojiUpdate
  | WinUpdate
  | HashUpdate
  | UnitIncomingUpdate
  | AllianceExtensionUpdate
  | BonusEventUpdate
  | RailroadConstructionUpdate
  | RailroadDestructionUpdate
  | RailroadSnapUpdate
  | ConquestUpdate
  | EmbargoUpdate
  | SpawnPhaseEndUpdate
  | GamePausedUpdate
  | DonateEventUpdate
  | NewEraUpdate;

/**
 * New Era's land economy, once a second (engine/game/NewEraEconomy.ts).
 * Iron is in units of 1/600 iron; rates are units per tick (= iron/minute).
 */
export interface NewEraUpdate {
  type: GameUpdateType.NewEra;
  players: {
    id: number;
    stock: number;
    production: number;
    demand: number;
    /** Share of factory demand met, permille. */
    utilization: number;
    /** Metallurgy gold discount, permille. */
    discount: number;
    /** Oil (rules v2), same units; demand is what ships on tasks burn. */
    oilStock: number;
    oilProduction: number;
    oilDemand: number;
    oilUtilization: number;
    /** Rules v4: fuel the refineries save (permille), gold a tick from
     * veins, residential troop-growth bonus (permille). */
    refining: number;
    veinGold: number;
    growth: number;
  }[];
  factories: { unitId: number; spec: FactorySpec }[];
  /** Rules v4: cities' profile districts. */
  districts: { unitId: number; district: District }[];
  /** Rules v4: platforms (wells on offshore fields), the deposit each
   * works, and the share of its output it keeps (permille). */
  shelves: { unitId: number; deposit: number; permille: number }[];
  /** Presence (permille) per sea zone, by config order; zero rows left out. */
  zones: { presence: { id: number; value: number }[] }[];
  /** Overseas mines and wells: their pile, freighter and route options. */
  sites: {
    unitId: number;
    owner: number;
    kind: "iron" | "oil";
    cargo: number;
    inFlight: boolean;
    /** Chosen route: -1 the shortest way, else through this sea zone. */
    via: number;
    /** A port on the site's landmass and one at home both stand. */
    hasPorts: boolean;
    /** What escorts add to the convoys' side now. */
    escort: number;
    options: {
      via: number;
      ticks: number;
      zones: number[];
      /** Cargo lost (permille) in each zone, at today's presence. */
      losses: number[];
    }[];
  }[];
  ships: {
    unitId: number;
    cls: ShipClass;
    task: ShipTask;
    target: number;
  }[];
  /** Shipyard orders, each yard's in queue order (readyTick -1: waiting). */
  orders: {
    shipyardId: number;
    cls: ShipClass;
    readyTick: number;
  }[];
  /** Trade contracts (rules v3): offers and running ones. */
  contracts: {
    id: number;
    buyer: number;
    seller: number;
    kind: "iron" | "oil";
    /** Whole units a minute, and gold per whole unit. */
    rate: number;
    price: number;
    state: "offered" | "active";
    /** Tick an offer lapses (offers only). */
    expires: number;
    /** Units waiting at the seller's port; a freighter is at sea. */
    pile: number;
    inFlight: boolean;
    via: number;
    /** Share of the rate the seller's stock covered last tick, permille. */
    supply: number;
    /** Totals so far: units landed, gold paid. */
    delivered: number;
    paid: number;
    /** Both sides have a port the freighters can use. */
    hasPorts: boolean;
    options: {
      via: number;
      ticks: number;
      zones: number[];
      losses: number[];
    }[];
  }[];
  /** Ports under blockade, with the share of throughput taken (permille). */
  blockades: { portId: number; permille: number }[];
}

export interface BonusEventUpdate {
  type: GameUpdateType.BonusEvent;
  player: PlayerID;
  tile: TileRef;
  gold: number;
  troops: number;
}

export interface RailroadConstructionUpdate {
  type: GameUpdateType.RailroadConstructionEvent;
  id: number;
  tiles: TileRef[];
}

export interface RailroadDestructionUpdate {
  type: GameUpdateType.RailroadDestructionEvent;
  id: number;
}

export interface RailroadSnapUpdate {
  type: GameUpdateType.RailroadSnapEvent;
  originalId: number;
  newId1: number;
  newId2: number;
  tiles1: TileRef[];
  tiles2: TileRef[];
}

export interface ConquestUpdate {
  type: GameUpdateType.ConquestEvent;
  conquerorId: PlayerID;
  conqueredId: PlayerID;
  gold: Gold;
}

export interface DonateEventUpdate {
  type: GameUpdateType.DonateEvent;
  donationType: "troops" | "gold";
  senderId: PlayerID;
  recipientId: PlayerID;
  amount: bigint;
}

export interface UnitUpdate {
  type: GameUpdateType.Unit;
  unitType: UnitType;
  troops: number;
  id: number;
  ownerID: number;
  lastOwnerID?: number;
  // TODO: make these tilerefs
  pos: TileRef;
  lastPos: TileRef;
  isActive: boolean;
  reachedTarget: boolean;
  warshipState?: WarshipState;
  transportShipState?: TransportShipState;
  nukeState?: NukeState;
  targetable: boolean;
  markedForDeletion: number | false;
  targetUnitId?: number; // Only for trade ships
  targetTile?: TileRef; // Only for nukes
  health?: number;
  underConstruction?: boolean;
  missileTimerQueue: number[];
  level: number;
  hasTrainStation: boolean;
  trainType?: TrainType; // Only for trains
  loaded?: boolean; // Only for trains
  samUpgrade?: SamLauncherState;
}

export interface AttackUpdate {
  attackerID: number;
  targetID: number;
  troops: number;
  id: string;
  retreating: boolean;
}

/**
 * Player snapshot delivered worker -> main thread.
 *
 * Only `type` and `id` are guaranteed. Every other field is omitted when its
 * value matches the previous emission for the same player. The first emission
 * for a player always includes all fields; consumers must handle subsequent
 * partial updates by merging into local state, not overwriting.
 *
 * When adding a field here, also wire it into diffPlayerUpdate() and
 * applyStateUpdate() in PlayerStateUpdate.ts — otherwise it is only ever sent on
 * the first emission and later changes are silently dropped.
 */
export interface PlayerUpdate {
  type: GameUpdateType.Player;
  id: PlayerID;
  nameViewData?: NameViewData;
  clientID?: ClientID | null;
  name?: string;
  displayName?: string;
  clanTag?: string | null;
  nationFlag?: string | null;
  team?: Team;
  smallID?: number;
  playerType?: PlayerType;
  isAlive?: boolean;
  isDisconnected?: boolean;
  killedBy?: ClientID | null;
  deathPosition?: number | null;
  tilesOwned?: number;
  gold?: Gold;
  /** Cumulative ship-trade revenue (changes only on arrivals, so it diffs). */
  tradeGold?: Gold;
  /** Cumulative train revenue: own trains + external stops at own stations. */
  trainGold?: Gold;
  /** Cumulative piracy revenue: captured-ship payouts. */
  piracyGold?: Gold;
  /** Cumulative gold received from all sources (workers, trade, ...). */
  goldEarned?: Gold;
  troops?: number;
  allies?: number[];
  embargoes?: Set<PlayerID>;
  isTraitor?: boolean;
  traitorRemainingTicks?: number;
  inDoomsdayClock?: boolean;
  isDecaying?: boolean;
  markedDoomsdayClockTick?: number;
  targets?: number[];
  outgoingEmojis?: EmojiMessage[];
  outgoingAttacks?: AttackUpdate[];
  incomingAttacks?: AttackUpdate[];
  outgoingAllianceRequests?: PlayerID[];
  alliances?: AllianceView[];
  hasSpawned?: boolean;
  spawnTile?: TileRef;
  betrayals?: number;
  lastDeleteUnitTick?: Tick;
  isLobbyCreator?: boolean;
}

export interface AllianceView {
  id: number;
  other: PlayerID;
  createdAt: Tick;
  expiresAt: Tick;
  hasExtensionRequest: boolean;
}

export interface AllianceRequestUpdate {
  type: GameUpdateType.AllianceRequest;
  requestorID: number;
  recipientID: number;
  createdAt: Tick;
}

export interface AllianceRequestReplyUpdate {
  type: GameUpdateType.AllianceRequestReply;
  request: AllianceRequestUpdate;
  accepted: boolean;
}

export interface BrokeAllianceUpdate {
  type: GameUpdateType.BrokeAlliance;
  traitorID: number;
  betrayedID: number;
  allianceID: number;
}

export interface AllianceExpiredUpdate {
  type: GameUpdateType.AllianceExpired;
  player1ID: number;
  player2ID: number;
}

export interface AllianceExtensionUpdate {
  type: GameUpdateType.AllianceExtension;
  playerID: number;
  allianceID: number;
}

export interface TargetPlayerUpdate {
  type: GameUpdateType.TargetPlayer;
  playerID: number;
  targetID: number;
}

export interface EmojiUpdate {
  type: GameUpdateType.Emoji;
  emoji: EmojiMessage;
}

export interface DisplayMessageUpdate {
  type: GameUpdateType.DisplayEvent;
  message: string;
  messageType: MessageType;
  goldAmount?: bigint;
  playerID: number | null;
  params?: Record<string, string | number>;
  unitID?: number;
  focusPlayerID?: number;
}

export type DisplayChatMessageUpdate = {
  type: GameUpdateType.DisplayChatEvent;
  key: string;
  category: string;
  markerTile?: TileRef;
  target: string | undefined;
  playerID: number | null;
  isFrom: boolean;
  recipient: string;
};

export interface WinUpdate {
  type: GameUpdateType.Win;
  allPlayersStats: AllPlayersStats;
  winner: Winner;
}

export interface HashUpdate {
  type: GameUpdateType.Hash;
  tick: Tick;
  hash: number;
}

export interface UnitIncomingUpdate {
  type: GameUpdateType.UnitIncoming;
  unitID: number;
  message: string;
  messageType: MessageType;
  playerID: number;
}

export interface EmbargoUpdate {
  type: GameUpdateType.EmbargoEvent;
  event: "start" | "stop";
  playerID: number;
  embargoedID: number;
}

export interface SpawnPhaseEndUpdate {
  type: GameUpdateType.SpawnPhaseEnd;
  startTick: Tick;
}

export interface GamePausedUpdate {
  type: GameUpdateType.GamePaused;
  paused: boolean;
}
