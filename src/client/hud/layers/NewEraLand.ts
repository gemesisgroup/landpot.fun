import type { DepositKind, FactorySpec } from "@openfront/engine-api/Schemas";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  FACTORY_PER_LEVEL,
  IRON,
  TICKS_PER_MINUTE,
  factoryDemand,
  factoryUpgradeIron,
  mineOutput,
  secondsToEmpty,
  veinGold,
} from "@openfront/engine-lib/game/NewEra";
import { html, nothing, TemplateResult } from "lit";
import { translateText } from "../../Utils";
import type { NewEraPlayerRow } from "./lib/NewEraStore";

/** Whole units, one decimal below 10. */
export function amount(units: number): string {
  const v = units / IRON;
  return v < 10 ? v.toFixed(1) : Math.floor(v).toString();
}

export function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * What upgrading one factory a level does right now (plan §4): capacity
 * gained, the output gained at today's iron supply, the iron still missing
 * for a full load, and the iron the upgrade orders.
 */
export function upgradePreview(
  level: number,
  row: NewEraPlayerRow | undefined,
  specialised: boolean,
): {
  capacityPct: number;
  outputPct: number;
  missingPerMin: number;
  ironCost: number;
} {
  const capacityPct = Math.round(100 / Math.max(1, level));
  const ironCost = factoryUpgradeIron(level + 1);
  if (!specialised || row === undefined) {
    return { capacityPct, outputPct: 0, missingPerMin: 0, ironCost };
  }
  const prod = row.production;
  const demand = row.demand;
  const nextDemand = demand + FACTORY_PER_LEVEL;
  // The stock only counts as supply while it covers a full minute of the
  // shortfall; past that the mines are what the factories really run on.
  const covered = (d: number) => row.stock >= Math.max(0, d - prod) * IRON;
  const share = (d: number) =>
    d === 0 || prod >= d || covered(d) ? 1 : prod / d;
  const now = level * share(demand);
  const next = (level + 1) * share(nextDemand);
  const outputPct = now > 0 ? Math.round(((next - now) / now) * 100) : 0;
  const missingPerMin = covered(nextDemand)
    ? 0
    : Math.max(0, nextDemand - prod);
  return { capacityPct, outputPct, missingPerMin, ironCost };
}

/** One resource's flow, as the panel reads it. */
export interface ResourceFlow {
  stock: number;
  /** Whole units a minute in and out. */
  made: number;
  used: number;
  /** Share of the demand met, permille. */
  util: number;
}

export type ResourceState =
  | { tone: "warn"; key: "short"; pct: number; missing: number }
  | { tone: "warn"; key: "empty"; seconds: number }
  | { tone: "ok"; key: "growing" }
  | { tone: "muted"; key: "steady" }
  | { tone: "muted"; key: "idle" };

/** How a resource stands: short, running out, growing, steady or idle. */
export function resourceState(f: ResourceFlow): ResourceState {
  if (f.used > 0 && f.util < 1000) {
    return {
      tone: "warn",
      key: "short",
      pct: Math.floor(f.util / 10),
      missing: Math.max(0, f.used - f.made),
    };
  }
  const empty = secondsToEmpty(f.stock, f.made - f.used);
  if (empty !== null) return { tone: "warn", key: "empty", seconds: empty };
  if (f.made === 0 && f.used === 0) return { tone: "muted", key: "idle" };
  if (f.made > f.used) return { tone: "ok", key: "growing" };
  return { tone: "muted", key: "steady" };
}

/** A mine or well of the viewer's, with the deposit it works. */
export interface ExtractorRow {
  id: number;
  well: boolean;
  /** The deposit's kind, or null when none is in reach. */
  kind: DepositKind | null;
  richness: number;
  offshore: boolean;
  level: number;
  cap: number;
  building: boolean;
  /** Share of an offshore field the platform keeps, permille. */
  shelf: number;
}

/**
 * What an extractor yields a minute, as the engine counts it
 * (NewEraEconomy.mineRate / veinRate): whole iron or oil, or gold for a vein.
 */
export function extractorYield(
  e: ExtractorRow,
): { res: DepositKind; perMin: number } | null {
  if (e.kind === null) return null;
  if (e.building) return { res: e.kind, perMin: 0 };
  if (e.kind === "gold") {
    return {
      res: "gold",
      perMin: veinGold(e.level, e.richness) * TICKS_PER_MINUTE,
    };
  }
  const full = mineOutput(e.level, e.richness);
  return {
    res: e.kind,
    perMin: e.offshore ? Math.floor((full * e.shelf) / 1000) : full,
  };
}

/** A factory of the viewer's. */
export interface FactoryRow {
  id: number;
  level: number;
  /** Levels a nearby Works district adds. */
  bonus: number;
  spec: FactorySpec;
  building: boolean;
}

export interface LandContext {
  row: NewEraPlayerRow | undefined;
  extractors: ExtractorRow[];
  factories: FactoryRow[];
  /** Section keys folded away by the viewer. */
  folded: ReadonlySet<string>;
  roman: (n: number) => string;
  onFold: (section: string) => void;
  onGoTo: (unitId: number) => void;
  onSpec: (factoryId: number, spec: FactorySpec) => void;
  onUpgrade: (factoryId: number) => void;
}

/** Rows a section lists before folding the rest into "+N more". */
export const LAND_LIST_MAX = 6;

const SPECS: readonly FactorySpec[] = [
  "none",
  "logistics",
  "metallurgy",
  "refinery",
];

function ingot(small = false): TemplateResult {
  return html`<span
    class="lp-ne-ore ${small ? "sm" : ""}"
    aria-hidden="true"
  ></span>`;
}

function drop(): TemplateResult {
  return html`<span class="lp-ne-oil" aria-hidden="true"></span>`;
}

function coin(): TemplateResult {
  return html`<span class="lp-ne-coin" aria-hidden="true"></span>`;
}

export function resourceIcon(res: DepositKind): TemplateResult {
  if (res === "oil") return drop();
  if (res === "gold") return coin();
  return ingot();
}

/** A section head that folds its body away. */
export function sectionHead(
  key: string,
  label: string,
  count: number | null,
  folded: ReadonlySet<string>,
  onFold: (key: string) => void,
): TemplateResult {
  const open = !folded.has(key);
  return html`<button
    type="button"
    class="lp-ne-section"
    aria-expanded=${open}
    @click=${() => onFold(key)}
  >
    <span class="lp-ne-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
    <span class="px-title">${label}</span>
    ${
      count !== null
        ? html`<span class="lp-ne-count px-num">${count}</span>`
        : nothing
    }
  </button>`;
}

function stateLine(res: "iron" | "oil", s: ResourceState): TemplateResult {
  let text: string;
  switch (s.key) {
    case "short":
      text =
        res === "iron"
          ? translateText("landpot.newera.short", {
              pct: s.pct.toString(),
              missing: s.missing.toString(),
            })
          : translateText("landpot.newera.oil_short", {
              pct: s.pct.toString(),
            });
      break;
    case "empty":
      text = translateText(
        res === "iron"
          ? "landpot.newera.empty_in"
          : "landpot.newera.oil_empty_in",
        { time: clock(s.seconds) },
      );
      break;
    case "growing":
      text = translateText("landpot.newera.res_growing");
      break;
    case "steady":
      text = translateText("landpot.newera.res_steady");
      break;
    default:
      text = translateText(
        res === "iron"
          ? "landpot.newera.res_idle_iron"
          : "landpot.newera.res_idle_oil",
      );
  }
  return html`<div class="lp-ne-state is-${s.tone}">${text}</div>`;
}

/** One resource card: stock, made against used, and how it stands. */
function renderResource(res: "iron" | "oil", f: ResourceFlow): TemplateResult {
  const s = resourceState(f);
  const top = Math.max(f.made, f.used, 1);
  return html`<div class="lp-ne-res is-${s.tone}">
    <div class="lp-ne-res-head">
      ${res === "iron" ? ingot() : drop()}
      <span class="lp-ne-res-name"
        >${translateText(`landpot.newera.${res}`)}</span
      >
      <span class="px-num lp-ne-big">${amount(f.stock)}</span>
    </div>
    <div class="lp-ne-flowrow px-num">
      <span class="lp-ne-in"
        >${translateText("landpot.newera.made", { n: f.made.toString() })}</span
      >
      <span class="lp-ne-out"
        >${translateText("landpot.newera.used", { n: f.used.toString() })}</span
      >
    </div>
    <div class="lp-ne-balance" aria-hidden="true">
      <i class="made" style="width:${(f.made / top) * 100}%"></i>
      <i class="used" style="width:${(f.used / top) * 100}%"></i>
    </div>
    ${stateLine(res, s)}
  </div>`;
}

/** Standing effects of the viewer's districts and specialised factories. */
function renderEffects(row: NewEraPlayerRow | undefined) {
  if (row === undefined) return nothing;
  const chips: string[] = [];
  if (row.discount > 0) {
    chips.push(
      translateText("landpot.newera.discount", {
        pct: (row.discount / 10).toFixed(0),
      }),
    );
  }
  if (row.refining > 0) {
    chips.push(
      translateText("landpot.newera.refining", {
        pct: (row.refining / 10).toFixed(0),
      }),
    );
  }
  if (row.veinGold > 0) {
    chips.push(
      translateText("landpot.newera.vein_gold", {
        gold: renderNumber(row.veinGold * TICKS_PER_MINUTE),
      }),
    );
  }
  if (row.growth > 0) {
    chips.push(
      translateText("landpot.newera.growth", {
        pct: (row.growth / 10).toFixed(0),
      }),
    );
  }
  if (chips.length === 0) return nothing;
  return html`<div class="lp-ne-effects">
    ${chips.map((c) => html`<span class="lp-ne-effect">${c}</span>`)}
  </div>`;
}

/** First steps, until the viewer has a mine, a factory at work and a well. */
function renderStart(c: LandContext): TemplateResult | typeof nothing {
  const steps = [
    {
      key: "start_mine",
      done: c.extractors.some((e) => !e.well && e.kind !== null),
    },
    {
      key: "start_factory",
      done: c.factories.some((f) => f.spec !== "none"),
    },
    {
      key: "start_oil",
      done: c.extractors.some((e) => e.well && e.kind !== null),
    },
  ];
  const left = steps.filter((s) => !s.done);
  if (left.length === 0) return nothing;
  return html`<div class="lp-ne-start">
    <div class="lp-ne-start-title px-title">
      ${translateText("landpot.newera.start_title")}
      <span class="px-num lp-ne-muted"
        >${steps.length - left.length}/${steps.length}</span
      >
    </div>
    <ol>
      ${left.map(
        (s) =>
          html`<li>
            <span class="lp-ne-tick" aria-hidden="true"></span>
            <span>${translateText(`landpot.newera.${s.key}`)}</span>
          </li>`,
      )}
    </ol>
  </div>`;
}

function renderExtractor(c: LandContext, e: ExtractorRow): TemplateResult {
  const y = extractorYield(e);
  const maxed = e.level >= e.cap;
  let detail: TemplateResult;
  if (y === null) {
    detail = html`<span class="lp-ne-warn-ink"
      >${translateText("landpot.newera.no_deposit")}</span
    >`;
  } else if (e.building) {
    detail = html`<span class="lp-ne-muted"
      >${translateText("landpot.newera.building")}</span
    >`;
  } else {
    detail = html`<span class="px-num lp-ne-in"
      >+${renderNumber(y.perMin)}/${translateText("landpot.newera.min")}</span
    >`;
  }
  return html`<button
    type="button"
    class="lp-ne-item"
    title=${
      e.offshore && y !== null
        ? translateText("landpot.newera.shelf_share", {
            pct: Math.floor(e.shelf / 10).toString(),
          })
        : ""
    }
    @click=${() => c.onGoTo(e.id)}
  >
    ${resourceIcon(e.kind ?? (e.well ? "oil" : "iron"))}
    <span class="lp-ne-item-name"
      >${translateText(e.well ? "unit_type.oil_well" : "unit_type.mine")}</span
    >
    <span
      class="lp-ne-lvl px-num ${maxed && y !== null ? "is-max" : ""}"
      title=${translateText("landpot.newera.level_cap", {
        level: e.level.toString(),
        cap: e.cap.toString(),
      })}
      >${
        maxed && y !== null
          ? translateText("landpot.newera.max")
          : `${e.level}/${e.cap}`
      }</span
    >
    ${detail}
  </button>`;
}

function renderFactory(
  c: LandContext,
  f: FactoryRow,
  row: NewEraPlayerRow | undefined,
): TemplateResult {
  const specialised = f.spec !== "none";
  const util = specialised ? (row?.utilization ?? 1000) : 0;
  const p = upgradePreview(f.level, row, specialised);
  const canPay = (row?.stock ?? 0) >= p.ironCost * IRON;
  return html`<div class="lp-ne-card">
    <div class="lp-ne-row">
      <button
        class="lp-ne-name px-title"
        type="button"
        @click=${() => c.onGoTo(f.id)}
      >
        ${translateText("unit_type.factory")} ${c.roman(f.level)}
      </button>
      ${
        f.bonus > 0
          ? html`<span
              class="lp-ne-effect"
              title=${translateText("landpot.newera.industrial_bonus", {
                n: f.bonus.toString(),
              })}
              >+${f.bonus}</span
            >`
          : nothing
      }
      <span class="px-num lp-ne-muted lp-ne-push"
        >${
          specialised
            ? html`${factoryDemand(f.level + f.bonus)}${ingot(true)}/${translateText(
                "landpot.newera.min",
              )}`
            : translateText("landpot.newera.no_iron")
        }</span
      >
    </div>
    <div class="lp-ne-specs" role="group">
      ${SPECS.map(
        (s) =>
          html`<button
            type="button"
            class="lp-ne-spec ${s === f.spec ? "is-on" : ""}"
            aria-pressed=${s === f.spec}
            title=${translateText(`landpot.newera.spec_desc.${s}`)}
            @click=${() => c.onSpec(f.id, s)}
          >
            ${translateText(`landpot.newera.spec.${s}`)}
          </button>`,
      )}
    </div>
    <div class="lp-ne-hint">
      ${translateText(`landpot.newera.spec_desc.${f.spec}`)}
    </div>
    ${
      specialised
        ? html`<div class="lp-ne-bar">
            <i style="width:${util / 10}%"></i>
            <span class="px-num"
              >${translateText("landpot.newera.load", {
                pct: Math.floor(util / 10).toString(),
              })}</span
            >
          </div>`
        : nothing
    }
    <div class="lp-ne-up">
      <div>
        ${translateText("landpot.newera.upgrade_line", {
          from: c.roman(f.level),
          to: c.roman(f.level + 1),
          cap: p.capacityPct.toString(),
        })}
        ${
          specialised
            ? html`<br />${translateText("landpot.newera.upgrade_output", {
                  pct: p.outputPct.toString(),
                })}`
            : nothing
        }
        ${
          p.missingPerMin > 0
            ? html`<br /><span class="lp-ne-warn-ink"
                  >${translateText("landpot.newera.upgrade_missing", {
                    n: p.missingPerMin.toString(),
                  })}</span
                >`
            : nothing
        }
      </div>
      <button
        type="button"
        class="px-btn lp-ne-upbtn"
        ?disabled=${!canPay || f.building}
        title=${translateText(
          canPay
            ? "landpot.newera.upgrade_cost"
            : "landpot.newera.upgrade_needs",
          { n: p.ironCost.toString() },
        )}
        @click=${() => c.onUpgrade(f.id)}
      >
        ▲ ${p.ironCost}${ingot(true)}
      </button>
    </div>
  </div>`;
}

function more(n: number) {
  return n > 0
    ? html`<div class="lp-ne-muted lp-ne-more">
        ${translateText("landpot.newera.more", { n: n.toString() })}
      </div>`
    : nothing;
}

/**
 * While players pick a start: what the markers on the map are, and what
 * the numbers under them mean.
 */
export function renderSpawnGuide(): TemplateResult {
  const rows: [DepositKind, string][] = [
    ["iron", "spawn_iron"],
    ["oil", "spawn_oil"],
    ["gold", "spawn_gold"],
  ];
  return html`<div class="lp-ne-start lp-ne-guide">
    <div class="lp-ne-start-title px-title">
      ${translateText("landpot.newera.spawn_title")}
    </div>
    ${rows.map(
      ([res, key]) =>
        html`<div class="lp-ne-guide-row">
          <span class="lp-ne-guide-icon">${resourceIcon(res)}</span>
          <span>${translateText(`landpot.newera.${key}`)}</span>
        </div>`,
    )}
    <div class="lp-ne-hint">${translateText("landpot.newera.spawn_note")}</div>
  </div>`;
}

/** The Land tab: resources, what digs them, and the factories using them. */
export function renderLand(c: LandContext): TemplateResult {
  const r = c.row;
  const iron: ResourceFlow = {
    stock: r?.stock ?? 0,
    made: r?.production ?? 0,
    used: r?.demand ?? 0,
    util: r?.utilization ?? 1000,
  };
  const oil: ResourceFlow = {
    stock: r?.oilStock ?? 0,
    made: r?.oilProduction ?? 0,
    used: r?.oilDemand ?? 0,
    util: r?.oilUtilization ?? 1000,
  };
  const ex = c.extractors;
  const fs = c.factories;
  const open = (k: string) => !c.folded.has(k);
  return html`
    ${renderStart(c)}
    ${sectionHead(
      "resources",
      translateText("landpot.newera.resources"),
      null,
      c.folded,
      c.onFold,
    )}
    ${
      open("resources")
        ? html`<div class="lp-ne-resgrid">
              ${renderResource("iron", iron)} ${renderResource("oil", oil)}
            </div>
            ${renderEffects(r)}`
        : nothing
    }
    ${
      ex.length > 0
        ? html`${sectionHead(
            "extraction",
            translateText("landpot.newera.extraction"),
            ex.length,
            c.folded,
            c.onFold,
          )}
          ${
            open("extraction")
              ? html`<div class="lp-ne-list">
                    ${ex
                      .slice(0, LAND_LIST_MAX)
                      .map((e) => renderExtractor(c, e))}
                  </div>
                  ${more(ex.length - LAND_LIST_MAX)}`
              : nothing
          }`
        : nothing
    }
    ${
      fs.length > 0
        ? html`${sectionHead(
            "factories",
            translateText("landpot.newera.factories"),
            fs.length,
            c.folded,
            c.onFold,
          )}
          ${
            open("factories")
              ? html`${fs
                  .slice(0, LAND_LIST_MAX)
                  .map((f) => renderFactory(c, f, r))}
                ${more(fs.length - LAND_LIST_MAX)}`
              : nothing
          }`
        : nothing
    }
  `;
}
