# Landpot — locked design direction: A "Plates"

Chosen 2026-11-18 from `design/refs/` (ref_A_site.png, ref_A_match.png).
The references are the floor: the build must be at least as rich.

## World
The map is a board of thousands of small square **land plates**. Owning land
means your plates are lit in your colour; taking land is plates flipping over to
your colour along the front. Neutral land is unlit graphite-grey plates; sea is
dark glass. The pot is the thing everyone plays for.

## Palette
| Role | Value |
|---|---|
| Ground (page, around board) | `#0B0D10` graphite |
| Surface (glass panels) | `#12151A` at 72–88% + 1px `#FFFFFF14` border, blur |
| Neutral plate | `#3A3E46` top / `#24272D` side |
| Sea | `#07090C` → `#0E1218` glass |
| Ink | `#F4F5F7`, muted `#8A909C` |
| Accent (brand, pot, primary action) | lime `#C6FF3D` |
| Player colours | lime `#C6FF3D`, coral `#FF5A4E`, cyan `#35E0FF`, violet `#8B6CFF`, amber `#FFB02E`, pink `#FF4FB8`, teal `#19D3A6`, white `#E9ECF1` (+ the upstream long list for >8 players) |

## Type
- Display: **Unbounded** (600) — headlines, timer, pot, big numbers.
- Body/mono: **IBM Plex Mono** (400/500) — labels, numbers, small UI.
- UI sans fallback: Inter (already in upstream) for dense menus.
Both fonts OFL, bundled locally via @fontsource (no Google requests).

## Signature sheet
| Row | Landpot |
|---|---|
| Ground | Graphite field `#0B0D10`, no photo, no hex grid; the board is the only image |
| Hero composition | Live 3D isometric plate board bleeding off the right two thirds; headline left; small pot chip floating over the board |
| Navigation | Slim transparent top bar: lowercase wordmark left, plain lowercase links, rounded-rect outlined "Connect wallet" right |
| Buttons | Rounded rectangles (10px), 1px border; primary is lime fill with ink text; hover lifts like a plate (translateY -2px + bottom edge shadow) |
| Divider device | A single row of plates (small squares) at section edges |
| Section container | Dark glass panels with 1px hairline borders |
| Explainer forms | Plates: a small board that plays out "spawn → expand → hold → payout" |
| Living detail | Frontier plates flipping in the hero; pot chip ticking; cards tilt slightly like plates on hover |

## In game
- Map seen from above (the engine is 2D top-down): every tile is drawn as a
  plate — a slightly inset top face with a darker bottom/right edge — lit in the
  owner's colour; neutral land in graphite plates; sea as dark glass.
- HUD: floating dark glass panels, 1px borders, Unbounded for timer / pot /
  troops, Plex Mono for labels.

## Placeholders (not wired yet)
"Connect wallet", the pot readout and stake tiers are visual only until the
paid layer exists. They must say so (disabled state / "test" label), not fake it.
