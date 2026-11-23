/**
 * Numbers behind the battle cards (BattleCards.ts): who is ahead in a fight
 * and how to keep several cards from covering each other on screen.
 */

export type BattleVerdict = "winning" | "even" | "losing";

export interface BattleOdds {
  /** Our side's share of all troops in the fight, 0..1. */
  share: number;
  /** Our troops per enemy troop; Infinity when the enemy has none. */
  ratio: number;
  verdict: BattleVerdict;
}

/** Ahead by a quarter or more counts as winning, behind by a fifth as losing. */
const WINNING_RATIO = 1.25;
const LOSING_RATIO = 0.8;

export function battleOdds(ours: number, theirs: number): BattleOdds {
  const a = Math.max(0, ours);
  const b = Math.max(0, theirs);
  const total = a + b;
  const share = total > 0 ? a / total : 0.5;
  const ratio = b > 0 ? a / b : a > 0 ? Infinity : 1;
  const verdict: BattleVerdict =
    ratio >= WINNING_RATIO
      ? "winning"
      : ratio <= LOSING_RATIO
        ? "losing"
        : "even";
  return { share, ratio, verdict };
}

/** "×1.8", "×12", "×∞" for display. */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "×∞";
  if (ratio >= 10) return `×${Math.round(ratio)}`;
  return `×${ratio.toFixed(1)}`;
}

export interface CardBox {
  id: string;
  /** Anchor in screen pixels: the card's bottom centre. */
  x: number;
  y: number;
}

/**
 * Pushes cards up so no two overlap: sorted bottom to top, each card that
 * would cover the one below it (horizontally close, vertically within one
 * card height) moves up to sit just above it. Mutates and returns `cards`.
 */
export function stackCards(
  cards: CardBox[],
  width: number,
  height: number,
  gap = 6,
): CardBox[] {
  const placed: CardBox[] = [];
  const sorted = [...cards].sort(
    (p, q) => q.y - p.y || p.id.localeCompare(q.id),
  );
  for (const card of sorted) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of placed) {
        const overlapX = Math.abs(card.x - other.x) < width + gap;
        const overlapY =
          card.y > other.y - height - gap && card.y < other.y + height + gap;
        if (overlapX && overlapY) {
          card.y = other.y - height - gap;
          moved = true;
        }
      }
    }
    placed.push(card);
  }
  return cards;
}
