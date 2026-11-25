/**
 * External links for Landpot (social channels and BNB Chain token page).
 * Leave a social URL empty ("") until the channel is live; buttons render in
 * place as "Coming soon" and activate automatically once a URL is filled in.
 */

export const LAUNCHPAD_URL = "https://blockx.gg";
/** Legacy export name kept for existing callers. */
export const PUMP_FUN_URL = LAUNCHPAD_URL;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/landpot_bnb",
  discord: "",
  telegram: "",
} as const;

export function pumpFunUrl(mint?: string | null): string {
  return mint ? `${LAUNCHPAD_URL}/token/${mint}` : LAUNCHPAD_URL;
}
