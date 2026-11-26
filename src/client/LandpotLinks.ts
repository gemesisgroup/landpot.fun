/**
 * External links for Landpot (social channels and BNB Chain token page).
 * Leave a social URL empty ("") until the channel is live; buttons render in
 * place as "Coming soon" and activate automatically once a URL is filled in.
 */

export const LANDPOT_CA = "0x4f2cd78b7615467c8f0f1a758f981009fc377777";
export const GMGN_BSC_URL = `https://gmgn.ai/bsc/token/${LANDPOT_CA}`;
/** Legacy export name kept for existing callers. */
export const PUMP_FUN_URL = GMGN_BSC_URL;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/landpot_bnb",
  discord: "",
  telegram: "https://t.me/landpot_bnb",
} as const;

export function pumpFunUrl(mint?: string | null): string {
  return `https://gmgn.ai/bsc/token/${mint || LANDPOT_CA}`;
}
