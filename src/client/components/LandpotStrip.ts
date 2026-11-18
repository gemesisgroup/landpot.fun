import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

/**
 * Landpot round explainer under the hero (design/DESIGN.md: "Plates: a small
 * board that plays out spawn -> expand -> hold -> payout"). Each step is a
 * 4x4 plate board showing the round at that moment. Replaces the upstream
 * news banner, whose feed belongs to openfront.io.
 */
type Step = {
  title: string;
  desc: string;
  lit: number[];
  rival?: number[];
  soon?: boolean;
};

// Cells 0..15 of a 4x4 board, row by row.
const STEPS: Step[] = [
  {
    title: "landpot.step_spawn",
    desc: "landpot.step_spawn_desc",
    lit: [5],
  },
  {
    title: "landpot.step_expand",
    desc: "landpot.step_expand_desc",
    lit: [1, 4, 5, 6, 9],
    rival: [15],
  },
  {
    title: "landpot.step_hold",
    desc: "landpot.step_hold_desc",
    lit: [0, 1, 2, 4, 5, 6, 8, 9, 10, 13],
    rival: [3, 7, 11, 15],
  },
  {
    title: "landpot.step_payout",
    desc: "landpot.step_payout_desc",
    lit: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    soon: true,
  },
];

@customElement("landpot-strip")
export class LandpotStrip extends LitElement {
  createRenderRoot() {
    return this;
  }

  private board(step: Step) {
    return html`<div
      class="grid grid-cols-4 gap-[2px] size-9 shrink-0"
      aria-hidden="true"
    >
      ${Array.from({ length: 16 }, (_, i) => {
        const tone = step.lit.includes(i)
          ? "bg-malibu-blue shadow-[0_1px_0_0_#8fc21a]"
          : step.rival?.includes(i)
            ? "bg-[#ff5a4e] shadow-[0_1px_0_0_#a8352d]"
            : "bg-[#3a3e46] shadow-[0_1px_0_0_#24272d]";
        return html`<span class="rounded-[2px] ${tone}"></span>`;
      })}
    </div>`;
  }

  render() {
    return html`
      <section
        class="lp-glass flex flex-col gap-3 rounded-xl px-4 py-3 sm:flex-row sm:items-center sm:gap-6"
      >
        <div class="flex items-center gap-3 sm:w-[30%] sm:shrink-0">
          <span
            class="lp-mono rounded-md bg-malibu-blue px-2 py-1 text-[11px] font-medium tracking-widest"
            data-i18n="landpot.strip_badge"
          ></span>
          <p
            class="lp-mono text-xs leading-snug text-gray-300"
            data-i18n="landpot.strip_note"
          ></p>
        </div>
        <ol class="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          ${STEPS.map(
            (step, i) => html`
              <li class="flex items-center gap-3 min-w-0">
                ${this.board(step)}
                <div class="min-w-0">
                  <div class="lp-mono text-[11px] text-gray-500">
                    0${i + 1}${
                      step.soon
                        ? html` ·
                            <span data-i18n="landpot.pot_soon"></span>`
                        : ""
                    }
                  </div>
                  <div
                    class="lp-display text-sm font-semibold text-white"
                    data-i18n=${step.title}
                  ></div>
                  <div
                    class="lp-mono text-[11px] leading-tight text-gray-400"
                    data-i18n=${step.desc}
                  ></div>
                </div>
              </li>
            `,
          )}
        </ol>
      </section>
    `;
  }
}
