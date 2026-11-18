import {
  decompressGameRecord,
  toWireGameStartInfo,
} from "@openfront/shared/SharedUtil";
import { WireGameStartInfoSchema } from "@openfront/shared/WireSchemas";
import type { Replayer } from "./Settlement";

/**
 * Settlement replays with the game server's own replayer: the same
 * low-priority, memory-capped subprocess, the same map files (static/ in a
 * production build, resources/ in dev), and the same start info the live
 * clients simulated.
 *
 * Loaded on first use: src/server reads GAME_ENV when imported (Server.ts
 * sets it for the API), and an API without an escrow never needs it.
 */
export const replayRecord: Replayer = async (record) => {
  const { replayWinnerInChild } = await import("../../server/WinnerReplay");
  const gameStart = toWireGameStartInfo(
    WireGameStartInfoSchema.parse(record.info),
  );
  const { turns } = decompressGameRecord({ ...record });
  return replayWinnerInChild(gameStart, turns);
};
