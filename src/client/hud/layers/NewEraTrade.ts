import type { ResourceKind } from "@openfront/engine-api/Schemas";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  CONTRACT_MAX_PRICE,
  CONTRACT_MAX_RATE,
  CONTRACTS_PER_PLAYER,
  FREIGHT_BATCH,
  IRON,
} from "@openfront/engine-lib/game/NewEra";
import { html, nothing, TemplateResult } from "lit";
import { translateText } from "../../Utils";
import type { NewEraContractRow, NewEraStore } from "./lib/NewEraStore";
import { routeExpect, zoneName } from "./NewEraSea";

/** What the viewer is about to offer. */
export interface TradeDraft {
  /** Small id of the player asked to sell (0: none picked). */
  seller: number;
  kind: ResourceKind;
  /** Whole units a minute, gold per whole unit. */
  rate: number;
  price: number;
}

export const DEFAULT_DRAFT: TradeDraft = {
  seller: 0,
  kind: "oil",
  rate: 4,
  price: 2_000,
};

/** The viewer's side of a contract, or null when it isn't theirs. */
export function contractRole(
  c: Pick<NewEraContractRow, "buyer" | "seller">,
  me: number,
): "buying" | "selling" | null {
  if (c.buyer === me) return "buying";
  if (c.seller === me) return "selling";
  return null;
}

/** A draft kept inside what an offer may say. */
export function clampDraft(d: TradeDraft): TradeDraft {
  const int = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.floor(v) : lo));
  return {
    ...d,
    rate: int(d.rate, 1, CONTRACT_MAX_RATE),
    price: int(d.price, 0, CONTRACT_MAX_PRICE),
  };
}

/** Gold a minute a contract costs the buyer when it all arrives. */
export function goldPerMinute(rate: number, price: number): number {
  return rate * price;
}

export interface TradeContext {
  store: NewEraStore;
  me: number;
  zoneNames: readonly string[];
  ticks: number;
  nameOf: (smallId: number) => string;
  /** Players the viewer could trade with, by name. */
  partners: { id: number; name: string }[];
  draft: TradeDraft;
  onDraft: (d: TradeDraft) => void;
  onOffer: (d: TradeDraft) => void;
  onAnswer: (contractId: number, accept: boolean) => void;
  onEnd: (contractId: number) => void;
  onRoute: (contractId: number, via: number) => void;
}

function amount(units: number): string {
  const v = units / IRON;
  return v < 10 ? v.toFixed(1) : Math.floor(v).toString();
}

function kindName(kind: ResourceKind): string {
  return translateText(
    kind === "oil" ? "landpot.newera.oil" : "landpot.newera.iron",
  );
}

function terms(c: { kind: ResourceKind; rate: number; price: number }) {
  return translateText("landpot.newera.terms", {
    rate: c.rate.toString(),
    kind: kindName(c.kind),
    price: renderNumber(c.price),
  });
}

function renderIncoming(c: TradeContext, o: NewEraContractRow) {
  const left = Math.max(0, Math.ceil((o.expires - c.ticks) / 10));
  return html`<div class="lp-ne-factory lp-ne-offer">
    <div class="lp-ne-row">
      <span class="px-title"
        >${translateText("landpot.newera.offer_from", {
          name: c.nameOf(o.buyer),
        })}</span
      >
      <span class="px-num lp-ne-muted">${left}s</span>
    </div>
    <div>${terms(o)}</div>
    <div class="lp-ne-muted px-num">
      ${translateText("landpot.newera.per_min_gold", {
        gold: renderNumber(goldPerMinute(o.rate, o.price)),
      })}
    </div>
    <div class="lp-ne-specs">
      <button
        type="button"
        class="lp-ne-spec is-on"
        @click=${() => c.onAnswer(o.id, true)}
      >
        ${translateText("landpot.newera.accept")}
      </button>
      <button
        type="button"
        class="lp-ne-spec"
        @click=${() => c.onAnswer(o.id, false)}
      >
        ${translateText("landpot.newera.decline")}
      </button>
    </div>
  </div>`;
}

function renderContract(c: TradeContext, k: NewEraContractRow) {
  const role = contractRole(k, c.me)!;
  const partner = c.nameOf(role === "buying" ? k.seller : k.buyer);
  const head = translateText(
    role === "buying"
      ? "landpot.newera.buying_from"
      : "landpot.newera.selling_to",
    { name: partner },
  );
  let status: TemplateResult | typeof nothing = nothing;
  if (k.state === "offered") {
    status = html`<div class="lp-ne-muted">
      ${translateText("landpot.newera.awaiting", {
        s: Math.max(0, Math.ceil((k.expires - c.ticks) / 10)).toString(),
      })}
    </div>`;
  } else if (!k.hasPorts) {
    status = html`<div class="lp-ne-warn">
      ${translateText("landpot.newera.needs_trade_ports")}
    </div>`;
  } else if (k.supply < 1000) {
    status = html`<div class="lp-ne-warn">
      ${translateText("landpot.newera.seller_short", {
        pct: Math.floor(k.supply / 10).toString(),
      })}
    </div>`;
  } else if (k.inFlight) {
    status = html`<div class="lp-ne-muted">
      ${translateText("landpot.newera.at_sea")}
    </div>`;
  }
  return html`<div class="lp-ne-factory">
    <div class="lp-ne-row">
      <span class="px-title">${head}</span>
      <button type="button" class="lp-ne-spec" @click=${() => c.onEnd(k.id)}>
        ${translateText(
          k.state === "offered"
            ? "landpot.newera.withdraw"
            : "landpot.newera.end_contract",
        )}
      </button>
    </div>
    <div>${terms(k)}</div>
    ${status}
    ${
      k.state === "active"
        ? html`<div class="lp-ne-row lp-ne-muted px-num">
            <span
              >${translateText("landpot.newera.delivered", {
                n: amount(k.delivered),
                kind: kindName(k.kind),
              })}</span
            >
            <span
              >${translateText("landpot.newera.paid", {
                gold: renderNumber(k.paid),
              })}</span
            >
          </div>`
        : nothing
    }
    ${k.options.map((o) => {
      const expect = routeExpect(o.losses);
      const short = expect < FREIGHT_BATCH;
      return html`<button
        type="button"
        class="lp-ne-route ${o.via === k.via ? "is-on" : ""}"
        aria-pressed=${o.via === k.via}
        @click=${() => c.onRoute(k.id, o.via)}
      >
        <span
          >${
            o.via < 0
              ? translateText("landpot.newera.route_direct")
              : translateText("landpot.newera.route_via", {
                  zone: zoneName(c.zoneNames[o.via] ?? "?"),
                })
          }</span
        >
        <span class="px-num lp-ne-muted">${Math.round(o.ticks / 10)}s</span>
        <span class="px-num ${short ? "lp-ne-warn-ink" : "lp-ne-in"}"
          >${amount(expect)}/${amount(FREIGHT_BATCH)}</span
        >
      </button>`;
    })}
  </div>`;
}

function renderDraft(c: TradeContext, full: boolean) {
  const d = c.draft;
  const set = (patch: Partial<TradeDraft>) =>
    c.onDraft(clampDraft({ ...d, ...patch }));
  const ready = !full && d.seller !== 0;
  return html`<div class="lp-ne-factory lp-ne-draft">
    <label class="lp-ne-field">
      <span class="lp-ne-muted">${translateText("landpot.newera.seller")}</span>
      <select
        class="lp-ne-select"
        .value=${String(d.seller)}
        @change=${(e: Event) =>
          set({ seller: Number((e.target as HTMLSelectElement).value) })}
      >
        <option value="0" ?selected=${d.seller === 0}>
          ${translateText("landpot.newera.pick_seller")}
        </option>
        ${c.partners.map(
          (p) =>
            html`<option value=${String(p.id)} ?selected=${d.seller === p.id}>
              ${p.name}
            </option>`,
        )}
      </select>
    </label>
    <div class="lp-ne-specs" role="group">
      ${(["oil", "iron"] as const).map(
        (k) =>
          html`<button
            type="button"
            class="lp-ne-spec ${d.kind === k ? "is-on" : ""}"
            aria-pressed=${d.kind === k}
            @click=${() => set({ kind: k })}
          >
            ${kindName(k)}
          </button>`,
      )}
    </div>
    <div class="lp-ne-row lp-ne-fields">
      <label class="lp-ne-field">
        <span class="lp-ne-muted"
          >${translateText("landpot.newera.rate_label")}</span
        >
        <input
          class="lp-ne-input px-num"
          type="number"
          min="1"
          max=${CONTRACT_MAX_RATE}
          .value=${String(d.rate)}
          @change=${(e: Event) =>
            set({ rate: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
      <label class="lp-ne-field">
        <span class="lp-ne-muted"
          >${translateText("landpot.newera.price_label")}</span
        >
        <input
          class="lp-ne-input px-num"
          type="number"
          min="0"
          max=${CONTRACT_MAX_PRICE}
          step="100"
          .value=${String(d.price)}
          @change=${(e: Event) =>
            set({ price: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
    </div>
    <div class="lp-ne-muted px-num">
      ${translateText("landpot.newera.per_min_gold", {
        gold: renderNumber(goldPerMinute(d.rate, d.price)),
      })}
    </div>
    <div class="lp-ne-muted">
      ${translateText("landpot.newera.pay_on_arrival")}
    </div>
    <button
      type="button"
      class="px-btn lp-ne-send"
      ?disabled=${!ready}
      @click=${() => c.onOffer(d)}
    >
      ${translateText(
        full ? "landpot.newera.too_many_deals" : "landpot.newera.send_offer",
      )}
    </button>
  </div>`;
}

/** The Trade tab: offers to answer, running deals, a new offer. */
export function renderTrade(c: TradeContext): TemplateResult {
  const incoming = c.store.contracts.filter(
    (k) => k.state === "offered" && k.seller === c.me,
  );
  const mine = c.store.contracts.filter(
    (k) =>
      contractRole(k, c.me) !== null &&
      !(k.state === "offered" && k.seller === c.me),
  );
  const count = incoming.length + mine.length;
  return html`
    ${
      incoming.length > 0
        ? html`<div class="lp-ne-section px-title">
              ${translateText("landpot.newera.offers_in")}
            </div>
            ${incoming.map((o) => renderIncoming(c, o))}`
        : nothing
    }
    <div class="lp-ne-section px-title">
      ${translateText("landpot.newera.contracts")}
    </div>
    ${
      mine.length === 0
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.no_contracts")}
          </div>`
        : mine.map((k) => renderContract(c, k))
    }
    <div class="lp-ne-section px-title">
      ${translateText("landpot.newera.new_offer")}
    </div>
    <div class="lp-ne-muted">${translateText("landpot.newera.ai_note")}</div>
    ${renderDraft(c, count >= CONTRACTS_PER_PLAYER)}
  `;
}
