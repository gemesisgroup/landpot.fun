import { Cell } from "@openfront/engine-api/game/GameTypes";
import type { AttackUpdate } from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { Controller } from "../../Controller";
import { TransformHandler } from "../../TransformHandler";
import { UserSettings } from "../../UserSettings";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";
import {
  battleOdds,
  type CardBox,
  formatRatio,
  stackCards,
} from "./lib/BattleMath";

const swordsIcon = assetUrl("images/landpot/icons/swords.png");
const troopsIcon = assetUrl("images/landpot/icons/troops.png");

/** At most this many cards at once: the biggest fights win. */
const MAX_CARDS = 4;
/** Card size in CSS pixels, for stacking and keeping cards on screen. */
const CARD_W = 196;
const CARD_H = 92;
/** Lift above the front so the card clears the map's own troop label. */
const LIFT_PX = 26;
const EDGE_PX = 10;
/** Keep the troop rate over about this window. */
const RATE_WINDOW_MS = 1500;

interface Battle {
  id: string;
  incoming: boolean;
  retreating: boolean;
  enemyName: string;
  /** Our side: the attack force when we attack, our army when we defend. */
  ours: number;
  theirs: number;
  /** Change of the attack force, troops per second (negative while it bleeds). */
  rate: number;
}

interface Front {
  /** Target and drawn position, in map tiles. */
  tx: number;
  ty: number;
  x: number;
  y: number;
  known: boolean;
}

/**
 * Battle cards (Landpot): a small pixel card over the front of every fight
 * the player is in — attacking or attacked. It shows who is fighting, both
 * sides' troops, who is ahead (a split bar, our share and the ratio) and how
 * fast the attack force is burning. Fronts come from the same worker query
 * as the map's attack labels (AttackingTroopsController) and follow the
 * camera every frame.
 */
@customElement("battle-cards")
export class BattleCards extends LitElement implements Controller {
  public game: GameView;
  public transformHandler: TransformHandler;
  public userSettings: UserSettings;

  @state() private battles: Battle[] = [];

  private fronts = new Map<string, Front>();
  private history = new Map<string, { at: number; troops: number }[]>();
  private inFlight = false;
  private raf = 0;
  private cardEls = new Map<string, HTMLElement>();
  /** Last transform written per card, so unchanged cards cost no style write. */
  private lastPos = new Map<string, string>();

  createRenderRoot() {
    return this;
  }

  init() {}

  /** The frame loop runs only while there is a card to move. */
  private startLoop() {
    if (this.raf !== 0) return;
    const frame = () => {
      if (this.battles.length === 0) {
        this.raf = 0;
        return;
      }
      this.place();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  protected updated() {
    // Cache the card elements once per render instead of querying per frame.
    this.cardEls.clear();
    for (const el of this.querySelectorAll<HTMLElement>("[data-battle]")) {
      this.cardEls.set(el.dataset.battle ?? "", el);
    }
    if (this.battles.length > 0) this.startLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  getTickIntervalMs() {
    return 200;
  }

  tick() {
    const me = this.game?.myPlayer();
    if (
      !me ||
      !me.isAlive() ||
      this.game.inSpawnPhase() ||
      !this.userSettings?.attackingTroopsOverlay()
    ) {
      if (this.battles.length > 0) this.battles = [];
      this.fronts.clear();
      this.history.clear();
      return;
    }

    const now = performance.now();
    const next: Battle[] = [];
    for (const a of me.outgoingAttacks()) {
      // Free land has no army to compare against; the map label covers it.
      const enemy = this.player(a.targetID);
      if (!enemy) continue;
      next.push(this.battle(a, false, enemy, a.troops, enemy.troops(), now));
    }
    for (const a of me.incomingAttacks()) {
      const enemy = this.player(a.attackerID);
      if (!enemy) continue;
      next.push(this.battle(a, true, enemy, me.troops(), a.troops, now));
    }
    next.sort((p, q) => q.ours + q.theirs - (p.ours + p.theirs));
    const shown = next.slice(0, MAX_CARDS);

    const ids = new Set(shown.map((b) => b.id));
    for (const id of this.fronts.keys())
      if (!ids.has(id)) this.fronts.delete(id);
    for (const id of this.history.keys())
      if (!ids.has(id)) this.history.delete(id);
    for (const id of this.lastPos.keys())
      if (!ids.has(id)) this.lastPos.delete(id);
    for (const id of ids) {
      if (!this.fronts.has(id)) {
        this.fronts.set(id, { tx: 0, ty: 0, x: 0, y: 0, known: false });
      }
    }
    this.battles = shown;

    if (shown.length === 0 || this.inFlight) return;
    this.inFlight = true;
    void me
      .attackClusteredPositions()
      .then((list) => {
        for (const { id, positions } of list) {
          const front = this.fronts.get(id);
          const p = positions[0];
          if (!front || !p) continue;
          front.tx = p.x;
          front.ty = p.y;
          if (!front.known) {
            front.x = p.x;
            front.y = p.y;
            front.known = true;
          }
        }
      })
      .catch(() => {
        // Keep the last fronts; the next tick asks again.
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private player(smallID: number): PlayerView | null {
    if (!smallID) return null;
    const p = this.game.playerBySmallID(smallID);
    return p.isPlayer() ? p : null;
  }

  private battle(
    a: AttackUpdate,
    incoming: boolean,
    enemy: PlayerView,
    ours: number,
    theirs: number,
    now: number,
  ): Battle {
    const log = this.history.get(a.id) ?? [];
    log.push({ at: now, troops: a.troops });
    while (log.length > 2 && now - log[0].at > RATE_WINDOW_MS) log.shift();
    this.history.set(a.id, log);
    const first = log[0];
    const dt = (now - first.at) / 1000;
    const rate = dt > 0.3 ? (a.troops - first.troops) / dt : 0;
    return {
      id: a.id,
      incoming,
      retreating: a.retreating,
      enemyName: enemy.displayName(),
      ours,
      theirs,
      rate,
    };
  }

  /** Every frame: ease each front toward its target, project, stack, move. */
  private place() {
    if (this.battles.length === 0 || !this.transformHandler) return;
    const boxes: CardBox[] = [];
    for (const b of this.battles) {
      const f = this.fronts.get(b.id);
      if (!f?.known) continue;
      f.x += (f.tx - f.x) * 0.2;
      f.y += (f.ty - f.y) * 0.2;
      const s = this.transformHandler.worldToScreenCoordinates(
        new Cell(f.x + 0.5, f.y + 0.5),
      );
      boxes.push({ id: b.id, x: s.x, y: s.y - LIFT_PX });
    }
    stackCards(boxes, CARD_W, CARD_H);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const seen = new Set<string>();
    for (const box of boxes) {
      const el = this.cardEls.get(box.id);
      if (!el) continue;
      seen.add(box.id);
      const x = Math.min(
        w - EDGE_PX - CARD_W / 2,
        Math.max(EDGE_PX + CARD_W / 2, box.x),
      );
      const y = Math.min(h - EDGE_PX, Math.max(EDGE_PX + CARD_H, box.y));
      const off = x !== box.x || y !== box.y;
      const t = `translate(${Math.round(x - CARD_W / 2)}px, ${Math.round(y - CARD_H)}px)`;
      const key = `${t}|${off ? 1 : 0}`;
      if (this.lastPos.get(box.id) !== key) {
        this.lastPos.set(box.id, key);
        el.style.transform = t;
        el.classList.toggle("battle-card-off", off);
      }
      if (el.style.visibility !== "visible") el.style.visibility = "visible";
    }
    for (const [id, el] of this.cardEls) {
      if (!seen.has(id) && el.style.visibility !== "hidden") {
        el.style.visibility = "hidden";
        this.lastPos.delete(id);
      }
    }
  }

  private card(b: Battle) {
    const odds = battleOdds(b.ours, b.theirs);
    const me = translateText("battle_card.you");
    const left = b.incoming ? b.enemyName : me;
    const right = b.incoming ? me : b.enemyName;
    const status = b.retreating
      ? translateText("battle_card.retreating")
      : translateText(`battle_card.${odds.verdict}`);
    const rate =
      Math.abs(b.rate) >= 1
        ? `${b.rate > 0 ? "+" : "−"}${renderTroops(Math.abs(b.rate))}/s`
        : "";
    return html`
      <div
        class="battle-card px-panel ${
          b.incoming ? "battle-card-in" : "battle-card-out"
        } battle-${b.retreating ? "retreat" : odds.verdict}"
        data-battle=${b.id}
        style="width:${CARD_W}px; visibility:hidden"
        role="status"
      >
        <div class="battle-card-head">
          <img class="px-img" src=${swordsIcon} alt="" />
          <span class="battle-card-side">${left}</span>
          <span class="battle-card-arrow" aria-hidden="true">▶</span>
          <span class="battle-card-side">${right}</span>
        </div>
        <div class="battle-card-nums">
          <span class="px-num battle-card-ours">
            <img class="px-img" src=${troopsIcon} alt="" />${renderTroops(
              b.ours,
            )}</span
          >
          <span class="battle-card-vs">${translateText("battle_card.vs")}</span>
          <span class="px-num battle-card-theirs"
            >${renderTroops(b.theirs)}</span
          >
        </div>
        <div
          class="battle-card-bar"
          style="--share:${odds.share.toFixed(3)}"
          aria-label=${translateText("battle_card.share", {
            share: Math.round(odds.share * 100),
          })}
        ></div>
        <div class="battle-card-foot">
          ${keyed(
            status,
            html`<span class="px-title battle-card-status">${status}</span>`,
          )}
          <span class="px-num">${Math.round(odds.share * 100)}%</span>
          <span class="px-num battle-card-ratio"
            >${formatRatio(odds.ratio)}</span
          >
          ${
            rate
              ? html`<span
                  class="px-num battle-card-rate"
                  title=${translateText("battle_card.rate_hint")}
                  >${rate}</span
                >`
              : nothing
          }
        </div>
      </div>
    `;
  }

  render() {
    if (this.battles.length === 0) return html``;
    return html`${repeat(
      this.battles,
      (b) => b.id,
      (b) => this.card(b),
    )}`;
  }
}
