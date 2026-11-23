import type { District } from "@openfront/engine-api/Schemas";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  DISTRICT_GOLD,
  DISTRICT_MIN_LEVEL,
  DISTRICT_REACH,
  INDUSTRY_LEVEL_BONUS,
} from "@openfront/engine-lib/game/NewEra";
import { html, nothing, TemplateResult } from "lit";
import { translateText } from "../../Utils";

export const DISTRICT_CHOICES: readonly Exclude<District, "none">[] = [
  "residential",
  "commercial",
  "industrial",
];

/** How a district button stands for a city. */
export function districtChoice(
  level: number,
  current: District,
  gold: bigint,
  pick: District,
): "on" | "locked" | "poor" | "open" {
  if (pick === current) return "on";
  if (level < DISTRICT_MIN_LEVEL) return "locked";
  if (gold < DISTRICT_GOLD) return "poor";
  return "open";
}

/**
 * Levels an industrial district adds to a factory at (x, y): one of the
 * owner's industrial cities is within DISTRICT_REACH (Manhattan).
 */
export function industrialBonus(
  x: number,
  y: number,
  cities: readonly { x: number; y: number; district: District }[],
): number {
  for (const c of cities) {
    if (c.district !== "industrial") continue;
    if (Math.abs(c.x - x) + Math.abs(c.y - y) <= DISTRICT_REACH) {
      return INDUSTRY_LEVEL_BONUS;
    }
  }
  return 0;
}

export interface CityRow {
  id: number;
  level: number;
  district: District;
}

export interface CitiesContext {
  cities: CityRow[];
  gold: bigint;
  roman: (n: number) => string;
  onDistrict: (cityId: number, district: District) => void;
  onGoTo: (cityId: number) => void;
}

function renderCity(c: CitiesContext, city: CityRow): TemplateResult {
  const locked = city.level < DISTRICT_MIN_LEVEL;
  return html`<div class="lp-ne-factory">
    <div class="lp-ne-row">
      <button
        class="lp-ne-name px-title"
        type="button"
        @click=${() => c.onGoTo(city.id)}
      >
        ${translateText("unit_type.city")} ${c.roman(city.level)}
      </button>
      <span class="lp-ne-muted">
        ${
          city.district === "none"
            ? nothing
            : translateText(`landpot.newera.district.${city.district}`)
        }
      </span>
    </div>
    ${
      locked
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.district_locked", {
              level: c.roman(DISTRICT_MIN_LEVEL),
            })}
          </div>`
        : html`<div class="lp-ne-specs" role="group">
            ${DISTRICT_CHOICES.map((d) => {
              const state = districtChoice(
                city.level,
                city.district,
                c.gold,
                d,
              );
              return html`<button
                type="button"
                class="lp-ne-spec ${state === "on" ? "is-on" : ""}"
                aria-pressed=${state === "on"}
                ?disabled=${state === "poor"}
                title=${translateText(`landpot.newera.district_desc.${d}`)}
                @click=${() => {
                  if (state === "open") c.onDistrict(city.id, d);
                }}
              >
                ${translateText(`landpot.newera.district.${d}`)}
              </button>`;
            })}
          </div>`
    }
  </div>`;
}

/** The Land tab's cities: each one's level and profile district. */
export function renderCities(c: CitiesContext): TemplateResult {
  return html`
    <div class="lp-ne-hint">${translateText("landpot.newera.cities_hint")}</div>
    ${
      c.cities.length === 0
        ? html`<div class="lp-ne-muted">
            ${translateText("landpot.newera.no_cities")}
          </div>`
        : html`${c.cities.map((city) => renderCity(c, city))}
            <div class="lp-ne-muted">
              ${translateText("landpot.newera.district_cost", {
                gold: renderNumber(Number(DISTRICT_GOLD)),
              })}
            </div>`
    }
  `;
}
