import { getAuthHeader } from "./Auth";
import { ClientEnv } from "./ClientEnv";

/**
 * Caldera duels, client side (src/server/Duel.ts, docs/CalderaDuel.md).
 * Worker 0 hosts every duel, so every call goes to /w0.
 */

export type DuelPhase =
  | "invite"
  | "confirm"
  | "funding"
  | "starting"
  | "playing"
  | "ended"
  | "cancelled";

export interface DuelView {
  id: string;
  kind: "friend" | "queue";
  phase: DuelPhase;
  /** Entry stake in whole tokens chosen for this duel. */
  stakeTokens?: number;
  paid?: boolean;
  fundingEnds?: number;
  reason?: string;
  side: number;
  opponent: { name: string; ready: boolean; funded?: boolean } | null;
  ready: boolean;
  funded?: boolean;
  gameId?: string;
  rematch: { mine?: boolean; theirs?: boolean; next?: string };
  rematchOf?: string;
}

export interface DuelInvite {
  /** open, self, taken, joined or expired. */
  state: string;
  inviter?: string;
  stakeTokens?: number;
}

export interface DuelReport {
  winner: "tie" | 0 | 1;
  seconds: number;
  sides: { crater: number; rim: number; firstCraterSecond: number | null }[];
}

export class DuelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = await getAuthHeader();
  const res = await fetch(`${ClientEnv.serverHttpBase()}/w0/api/duel${path}`, {
    method,
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok) {
    throw new DuelApiError(res.status, data?.error ?? `http_${res.status}`);
  }
  return data as T;
}

export const duelApi = {
  me: () =>
    call<{ duel: DuelView | null; queued: boolean; queuedStake?: number | null }>(
      "GET",
      "/me",
    ),
  invite: (name: string, stakeTokens?: number) =>
    call<DuelView>("POST", "/invite", {
      name,
      ...(stakeTokens !== undefined ? { stakeTokens } : {}),
    }),
  readInvite: (id: string) =>
    call<DuelInvite>("GET", `/invite/${encodeURIComponent(id)}`),
  accept: (id: string, name: string) =>
    call<DuelView>("POST", `/invite/${encodeURIComponent(id)}/accept`, {
      name,
    }),
  queue: (name: string, stakeTokens?: number) =>
    call<{ duel: DuelView | null; queued: boolean; queuedStake?: number | null }>(
      "POST",
      "/queue",
      {
        name,
        ...(stakeTokens !== undefined ? { stakeTokens } : {}),
      },
    ),
  leaveQueue: () =>
    call<{ queued: false; queuedStake?: null }>("DELETE", "/queue"),
  get: (id: string) => call<DuelView>("GET", `/${encodeURIComponent(id)}`),
  confirm: (id: string) =>
    call<DuelView>("POST", `/${encodeURIComponent(id)}/confirm`),
  decline: (id: string) =>
    call<DuelView>("POST", `/${encodeURIComponent(id)}/decline`),
  report: (id: string, report: DuelReport) =>
    call<{ ok: true }>("POST", `/${encodeURIComponent(id)}/report`, report),
  rematch: (id: string, yes: boolean) =>
    call<DuelView>("POST", `/${encodeURIComponent(id)}/rematch`, { yes }),
};

const LINK_PARAM = "duel";

/** The challenge link a player sends a friend. */
export function duelLink(id: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(LINK_PARAM, id);
  return url.toString();
}

export function duelFromUrl(): string | null {
  return new URL(window.location.href).searchParams.get(LINK_PARAM);
}

export function clearDuelFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(LINK_PARAM)) return;
  url.searchParams.delete(LINK_PARAM);
  history.replaceState(history.state, "", url.toString());
}

/** The duel a game belongs to, so the in-game panel can report and rematch. */
const KEY = "landpot:duel-by-game";

export function rememberDuelGame(gameId: string, duelId: string): void {
  try {
    const map = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<
      string,
      string
    >;
    map[gameId] = duelId;
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage off: the panel falls back to asking the server.
  }
}

export function duelForGame(gameId: string): string | null {
  try {
    const map = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<
      string,
      string
    >;
    return map[gameId] ?? null;
  } catch {
    return null;
  }
}
