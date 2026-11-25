import type { Gold, Tick } from "./GameTypes";

export type PerkBranch = "warfare" | "economy" | "fortress";

export const PERK_IDS = [
  "warfare_1",
  "warfare_2",
  "warfare_3",
  "warfare_4",
  "warfare_5",
  "economy_1",
  "economy_2",
  "economy_3",
  "economy_4",
  "economy_5",
  "fortress_1",
  "fortress_2",
  "fortress_3",
  "fortress_4",
  "fortress_5",
] as const;

export type PerkId = (typeof PERK_IDS)[number];

export interface PerkDef {
  readonly id: PerkId;
  readonly branch: PerkBranch;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly name: string;
  readonly shortEffect: string;
  readonly description: string;
  readonly cost: Gold;
  /** Ticks after match start (10 ticks = 1 second) when this tier unlocks. */
  readonly unlockTicks: Tick;
  readonly requires?: PerkId;
}

// 10 ticks = 1 second
export const PERK_TIER_UNLOCK_TICKS: Record<1 | 2 | 3 | 4 | 5, Tick> = {
  1: 0, // 0:00 — available from spawn
  2: 2 * 60 * 10, // 2:00
  3: 4.5 * 60 * 10, // 4:30
  4: 7.5 * 60 * 10, // 7:30
  5: 11 * 60 * 10, // 11:00
};

// High-economy Classic pricing (scaled for trade & piracy gold flow)
export const PERK_TIER_COST: Record<1 | 2 | 3 | 4 | 5, Gold> = {
  1: 300_000n,
  2: 750_000n,
  3: 1_500_000n,
  4: 3_500_000n,
  5: 8_000_000n,
};

export const PERKS: readonly PerkDef[] = [
  // ── Warfare ──
  {
    id: "warfare_1",
    branch: "warfare",
    tier: 1,
    name: "Forced March",
    shortEffect: "+12% attack speed",
    description: "Land attacks capture enemy territory 12% faster.",
    cost: PERK_TIER_COST[1],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[1],
  },
  {
    id: "warfare_2",
    branch: "warfare",
    tier: 2,
    name: "Conscription",
    shortEffect: "+12% troop growth",
    description: "Passive troop regeneration increases by 12%.",
    cost: PERK_TIER_COST[2],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[2],
    requires: "warfare_1",
  },
  {
    id: "warfare_3",
    branch: "warfare",
    tier: 3,
    name: "Expanded Reserves",
    shortEffect: "+15% max troops",
    description: "Maximum troop capacity increases by 15%.",
    cost: PERK_TIER_COST[3],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[3],
    requires: "warfare_2",
  },
  {
    id: "warfare_4",
    branch: "warfare",
    tier: 4,
    name: "Shock Troops",
    shortEffect: "-15% attack losses",
    description: "Take 15% fewer troop losses when attacking enemy land.",
    cost: PERK_TIER_COST[4],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[4],
    requires: "warfare_3",
  },
  {
    id: "warfare_5",
    branch: "warfare",
    tier: 5,
    name: "Total War",
    shortEffect: "+15% speed & growth",
    description: "Stacks another +15% attack speed and +15% troop growth.",
    cost: PERK_TIER_COST[5],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[5],
    requires: "warfare_4",
  },

  // ── Economy & Navy ──
  {
    id: "economy_1",
    branch: "economy",
    tier: 1,
    name: "Merchant Guild",
    shortEffect: "+15% trade gold",
    description: "Trade ships and trains generate 15% more gold.",
    cost: PERK_TIER_COST[1],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[1],
  },
  {
    id: "economy_2",
    branch: "economy",
    tier: 2,
    name: "Shipwrights",
    shortEffect: "+25% warship HP",
    description: "Newly built warships launch with 25% more max health.",
    cost: PERK_TIER_COST[2],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[2],
    requires: "economy_1",
  },
  {
    id: "economy_3",
    branch: "economy",
    tier: 3,
    name: "Urban Planning",
    shortEffect: "-15% eco build cost",
    description: "Cities, Ports, and Factories cost 15% less gold.",
    cost: PERK_TIER_COST[3],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[3],
    requires: "economy_2",
  },
  {
    id: "economy_4",
    branch: "economy",
    tier: 4,
    name: "War Profiteering",
    shortEffect: "+30% piracy & land gold",
    description: "Earn 30% more gold from piracy captures and territory income.",
    cost: PERK_TIER_COST[4],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[4],
    requires: "economy_3",
  },
  {
    id: "economy_5",
    branch: "economy",
    tier: 5,
    name: "Golden Armada",
    shortEffect: "+30% ship dmg & +25% trade",
    description: "Warship shells deal +30% damage and trade gold rises +25%.",
    cost: PERK_TIER_COST[5],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[5],
    requires: "economy_4",
  },

  // ── Fortress & Tech ──
  {
    id: "fortress_1",
    branch: "fortress",
    tier: 1,
    name: "Fortified Borders",
    shortEffect: "+20% fort defense",
    description: "Defense Posts inflict 20% heavier losses on attackers.",
    cost: PERK_TIER_COST[1],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[1],
  },
  {
    id: "fortress_2",
    branch: "fortress",
    tier: 2,
    name: "Coastal Batteries",
    shortEffect: "-25% enemy landing troops",
    description: "Enemy naval landings lose 25% of their troops on your coast.",
    cost: PERK_TIER_COST[2],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[2],
    requires: "fortress_1",
  },
  {
    id: "fortress_3",
    branch: "fortress",
    tier: 3,
    name: "Radar Network",
    shortEffect: "+20% SAM range",
    description: "All your SAM Launchers intercept missiles 20% farther out.",
    cost: PERK_TIER_COST[3],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[3],
    requires: "fortress_2",
  },
  {
    id: "fortress_4",
    branch: "fortress",
    tier: 4,
    name: "Fast Reload",
    shortEffect: "-25% silo cooldown",
    description: "Your Missile Silos reload 25% faster between launches.",
    cost: PERK_TIER_COST[4],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[4],
    requires: "fortress_3",
  },
  {
    id: "fortress_5",
    branch: "fortress",
    tier: 5,
    name: "Nuclear Supremacy",
    shortEffect: "-20% nuke & MIRV cost",
    description: "Atom Bombs, Hydrogen Bombs, and MIRVs cost 20% less gold.",
    cost: PERK_TIER_COST[5],
    unlockTicks: PERK_TIER_UNLOCK_TICKS[5],
    requires: "fortress_4",
  },
];

export const PERK_BY_ID: ReadonlyMap<PerkId, PerkDef> = new Map(
  PERKS.map((p) => [p.id, p]),
);

export function isPerkId(v: unknown): v is PerkId {
  return typeof v === "string" && PERK_BY_ID.has(v as PerkId);
}

/**
 * In-match doctrine perks are active in Classic & Singleplayer matches,
 * and disabled in Caldera paid matches (1v1 Duels, FFA Pots, Weekly Cup).
 */
export function perksEnabledForConfig(gameConfig: {
  caldera?: unknown;
  tutorial?: unknown;
}): boolean {
  return gameConfig.caldera === undefined && !gameConfig.tutorial;
}

export function canBuyPerk(
  owned: ReadonlySet<PerkId> | readonly PerkId[],
  gold: Gold,
  matchTicks: Tick,
  perkId: PerkId,
  enabled = true,
): boolean {
  if (!enabled) return false;
  const def = PERK_BY_ID.get(perkId);
  if (!def) return false;
  const has = (id: PerkId) =>
    Array.isArray(owned) ? owned.includes(id) : (owned as ReadonlySet<PerkId>).has(id);
  if (has(perkId)) return false;
  if (def.requires && !has(def.requires)) return false;
  if (matchTicks < def.unlockTicks) return false;
  return gold >= def.cost;
}
