/**
 * External links for Landpot (social channels and Pump.fun token page).
 * Leave a social URL empty ("") until the channel is live; buttons render in
 * place as "Coming soon" and activate automatically once a URL is filled in.
 */

export const PUMP_FUN_URL = "https://pump.fun";

export const SOCIAL_LINKS = {
  twitter: "",
  discord: "",
  telegram: "",
} as const;

export function pumpFunUrl(mint?: string | null): string {
  return mint ? `${PUMP_FUN_URL}/coin/${mint}` : PUMP_FUN_URL;
}
