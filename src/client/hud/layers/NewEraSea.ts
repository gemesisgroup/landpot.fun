import type { ShipClass, ShipTask } from "@openfront/engine-api/Schemas";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  CRUISER_YARD_LEVEL,
  FREIGHT_BATCH,
  IRON,
  SHIP_EXTRA_GOLD,
  SHIP_IRON,
  SHIPYARD_QUEUE,
  ZoneState,
  expectedDelivery,
  zoneState,
} from "@openfront/engine-lib/game/NewEra";
import { html, nothing, TemplateResult } from "lit";
import { translateText } from "../../Utils";
import type {
  NewEraOrderRow,
  NewEraShipRow,
  NewEraSiteRow,
  NewEraStore,
  NewEraZoneRow,
} from "./lib/NewEraStore";

/** A sea zone as the viewer sees it. */
export interface ZoneView {
  own: number;
  rival: number;
  state: ZoneState;
}

/**
 * The viewer's presence in a zone against the strongest presence of anyone
 * they aren't friendly with — the same reading the engine makes
 * (NewEraEconomy.rivalPresence).
 */
export function zoneView(
  zone: NewEraZoneRow | undefined,
  me: number,
  friendly: (id: number) => boolean,
): ZoneView {
  let own = 0;
  let rival = 0;
  for (const p of zone?.presence ?? []) {
    if (p.id === me) own = p.value;
    else if (!friendly(p.id)) rival = Math.max(rival, p.value);
  }
  return { own, rival, state: zoneState(own, rival) };
}

/** What a freighter batch on this route is expected to deliver (units). */
export function routeExpect(losses: readonly number[]): number {
  return expectedDelivery(FREIGHT_BATCH, losses);
}

/** One decimal below 10, whole above. */
function amount(units: number): string {
  const v = units / IRON;
  return v < 10 ? v.toFixed(1) : Math.floor(v).toString();
}

/** "Central Strait" → landpot.newera.zone_name.central_strait. */
export function zoneName(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return translateText(`landpot.newera.zone_name.${key}`);
}

export interface SeaContext {
  store: NewEraStore;
  zoneNames: readonly string[];
  me: number;
  friendly: (id: number) => boolean;
  ticks: number;
  ironStock: number;
  shipyards: { id: number; level: number }[];
  /** My warships' unit ids. */
  myShipIds: ReadonlySet<number>;
  /** Site unit id → its type, for my sites. */
  siteKinds: Map<number, "iron" | "oil">;
  /** Rival ports a ship could blockade, nearest first. */
  rivalPorts: (shipId: number) => { id: number; name: string }[];
  onRoute: (siteId: number, via: number) => void;
  onOrder: (shipyardId: number, cls: ShipClass) => void;
  onTask: (shipId: number, task: ShipTask, target: number) => void;
  onGoTo: (unitId: number) => void;
}

const STATE_KEY: Record<ZoneState, string> = {
  open: "landpot.newera.zone_open",
  contested: "landpot.newera.zone_contested",
  advantage: "landpot.newera.zone_yours",
};

function renderZones(c: SeaContext): TemplateResult {
  return html`<div class="lp-ne-section px-title">
      ${translateText("landpot.newera.sea_zones")}
    </div>
    ${c.zoneNames.map((name, i) => {
      const v = zoneView(c.store.zones[i], c.me, c.friendly);
      return html`<div class="lp-ne-zone">
        <div class="lp-ne-row">
          <span>${zoneName(name)}</span>
          <span class="lp-ne-chip is-${v.state}"
            >${translateText(STATE_KEY[v.state])}</span
          >
        </div>
        <div
          class="lp-ne-duel"
          title=${translateText("landpot.newera.presence_hint", {
            own: Math.floor(v.own / 10).toString(),
            rival: Math.floor(v.rival / 10).toString(),
          })}
        >
          <i class="own" style="width:${v.own / 20}%"></i>
          <i class="rival" style="width:${v.rival / 20}%"></i>
        </div>
      </div>`;
    })}`;
}

function routeLabel(c: SeaContext, via: number): string {
  if (via < 0) return translateText("landpot.newera.route_direct");
  return translateText("landpot.newera.route_via", {
    zone: zoneName(c.zoneNames[via] ?? "?"),
  });
}

function renderSite(c: SeaContext, s: NewEraSiteRow): TemplateResult {
  const kind = c.siteKinds.get(s.unitId) ?? s.kind;
  let status: TemplateResult | typeof nothing = nothing;
  if (!s.hasPorts) {
    status = html`<div class="lp-ne-warn">
      ${translateText("landpot.newera.needs_ports")}
    </div>`;
  } else if (s.inFlight) {
    status = html`<div class="lp-ne-muted">
      ${translateText("landpot.newera.at_sea")}
    </div>`;
  }
  return html`<div class="lp-ne-factory">
    <div class="lp-ne-row">
      <button
        class="lp-ne-name px-title"
        type="button"
        @click=${() => c.onGoTo(s.unitId)}
      >
        ${translateText(
          kind === "oil" ? "unit_type.oil_well" : "unit_type.mine",
        )}
      </button>
      <span class="px-num"
        >${amount(s.cargo)}
        <span class="lp-ne-muted"
          >${translateText(
            kind === "oil" ? "landpot.newera.oil" : "landpot.newera.iron",
          )}</span
        ></span
      >
    </div>
    ${status}
    ${s.options.map((o) => {
      const expect = routeExpect(o.losses);
      const short = expect < FREIGHT_BATCH;
      return html`<button
        type="button"
        class="lp-ne-route ${o.via === s.via ? "is-on" : ""}"
        aria-pressed=${o.via === s.via}
        @click=${() => c.onRoute(s.unitId, o.via)}
      >
        <span>${routeLabel(c, o.via)}</span>
        <span class="px-num lp-ne-muted">${Math.round(o.ticks / 10)}s</span>
        <span class="px-num ${short ? "lp-ne-warn-ink" : "lp-ne-in"}"
          >${amount(expect)}/${amount(FREIGHT_BATCH)}</span
        >
      </button>`;
    })}
    ${
      s.escort > 0
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.escorted", {
              n: s.escort.toString(),
            })}
          </div>`
        : nothing
    }
  </div>`;
}

function renderYard(
  c: SeaContext,
  yard: { id: number; level: number },
  orders: NewEraOrderRow[],
): TemplateResult {
  const classes: ShipClass[] = ["patrol", "destroyer", "cruiser"];
  const full = orders.length >= SHIPYARD_QUEUE;
  return html`<div class="lp-ne-factory">
    <div class="lp-ne-row">
      <button
        class="lp-ne-name px-title"
        type="button"
        @click=${() => c.onGoTo(yard.id)}
      >
        ${translateText("unit_type.shipyard")} ${yard.level}
      </button>
      <span class="lp-ne-muted px-num">${orders.length}/${SHIPYARD_QUEUE}</span>
    </div>
    ${orders.map((o) => {
      const left = o.readyTick < 0 ? null : Math.max(0, o.readyTick - c.ticks);
      return html`<div class="lp-ne-row lp-ne-muted">
        <span>${translateText(`landpot.newera.ship.${o.cls}`)}</span>
        <span class="px-num"
          >${
            left === null
              ? translateText("landpot.newera.queued")
              : `${Math.ceil(left / 10)}s`
          }</span
        >
      </div>`;
    })}
    <div class="lp-ne-specs">
      ${classes.map((cls) => {
        const iron = SHIP_IRON[cls];
        const yardOk = cls !== "cruiser" || yard.level >= CRUISER_YARD_LEVEL;
        const can = yardOk && !full && c.ironStock >= iron * IRON;
        const extra = SHIP_EXTRA_GOLD[cls];
        return html`<button
          type="button"
          class="lp-ne-spec"
          ?disabled=${!can}
          title=${
            yardOk
              ? translateText(`landpot.newera.ship_desc.${cls}`, {
                  gold: renderNumber(Number(extra)),
                })
              : translateText("landpot.newera.cruiser_needs_yard", {
                  level: CRUISER_YARD_LEVEL.toString(),
                })
          }
          @click=${() => c.onOrder(yard.id, cls)}
        >
          ${translateText(`landpot.newera.ship.${cls}`)}
          <span class="px-num">${iron}</span
          ><span class="lp-ne-ore sm" aria-hidden="true"></span>
        </button>`;
      })}
    </div>
  </div>`;
}

/**
 * The select value for a ship's task: "harbor", "patrol:2", "escort:41",
 * "blockade:57".
 */
export function taskValue(s: Pick<NewEraShipRow, "task" | "target">): string {
  return s.task === "harbor" ? "harbor" : `${s.task}:${s.target}`;
}

export function parseTask(v: string): { task: ShipTask; target: number } {
  const [task, target] = v.split(":");
  if (task === "patrol" || task === "escort" || task === "blockade") {
    return { task, target: Number(target) };
  }
  return { task: "harbor", target: 0 };
}

function renderShip(
  c: SeaContext,
  s: NewEraShipRow,
  mySites: NewEraSiteRow[],
): TemplateResult {
  const value = taskValue(s);
  return html`<div class="lp-ne-row lp-ne-ship">
    <button
      class="lp-ne-name px-title"
      type="button"
      @click=${() => c.onGoTo(s.unitId)}
    >
      ${translateText(`landpot.newera.ship.${s.cls}`)}
    </button>
    <select
      class="lp-ne-select"
      aria-label=${translateText("landpot.newera.task")}
      .value=${value}
      @change=${(e: Event) => {
        const t = parseTask((e.target as HTMLSelectElement).value);
        c.onTask(s.unitId, t.task, t.target);
      }}
    >
      <option value="harbor" ?selected=${value === "harbor"}>
        ${translateText("landpot.newera.task_harbor")}
      </option>
      ${c.zoneNames.map(
        (name, i) =>
          html`<option
            value=${`patrol:${i}`}
            ?selected=${value === `patrol:${i}`}
          >
            ${translateText("landpot.newera.task_patrol", {
              zone: zoneName(name),
            })}
          </option>`,
      )}
      ${mySites.map(
        (site) =>
          html`<option
            value=${`escort:${site.unitId}`}
            ?selected=${value === `escort:${site.unitId}`}
          >
            ${translateText("landpot.newera.task_escort", {
              site: translateText(
                site.kind === "oil" ? "unit_type.oil_well" : "unit_type.mine",
              ),
              id: site.unitId.toString(),
            })}
          </option>`,
      )}
      ${c.rivalPorts(s.unitId).map(
        (port) =>
          html`<option
            value=${`blockade:${port.id}`}
            ?selected=${value === `blockade:${port.id}`}
          >
            ${translateText("landpot.newera.task_blockade", {
              name: port.name,
            })}
          </option>`,
      )}
    </select>
  </div>`;
}

/** The Sea tab: zones, shipping from overseas sites, shipyards, ships. */
export function renderSea(c: SeaContext): TemplateResult {
  const mySites = [...c.store.sites.values()].filter((s) => s.owner === c.me);
  const myShips = [...c.store.ships.values()].filter((s) =>
    c.myShipIds.has(s.unitId),
  );
  return html`
    ${c.zoneNames.length > 0 ? renderZones(c) : nothing}
    <div class="lp-ne-section px-title">
      ${translateText("landpot.newera.shipping")}
    </div>
    ${
      mySites.length === 0
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.no_overseas")}
          </div>`
        : mySites.map((s) => renderSite(c, s))
    }
    <div class="lp-ne-section px-title">
      ${translateText("landpot.newera.fleet")}
    </div>
    ${
      c.shipyards.length === 0
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.no_shipyard")}
          </div>`
        : c.shipyards.map((y) =>
            renderYard(
              c,
              y,
              c.store.orders.filter((o) => o.shipyardId === y.id),
            ),
          )
    }
    ${myShips.map((s) => renderShip(c, s, mySites))}
  `;
}
