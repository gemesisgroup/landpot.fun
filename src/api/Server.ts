import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadApiConfig } from "./ApiEnv";
import { createApp, publicRecordJson } from "./App";
import { viemEscrowChain } from "./pot/EscrowChain";
import { PotService } from "./pot/PotService";
import { replayRecord } from "./pot/Replay";
import { SqliteStore } from "./Store";
import { loadSigningKeys } from "./Tokens";

/** Landpot API entry point (docs/LandpotAPI.md). */
async function main() {
  const config = loadApiConfig();
  // Settlement reuses the game server's replayer (pot/Replay.ts), and
  // src/server refuses to load without a game environment.
  process.env.GAME_ENV ??= config.isDev ? "dev" : "prod";
  const store = new SqliteStore(path.join(config.dataDir, "landpot.sqlite"));
  const keys = await loadSigningKeys(config);
  const pot = config.pot
    ? new PotService({
        chain: viemEscrowChain({
          rpcUrl: config.pot.rpcUrl,
          chainId: config.pot.chainId,
          escrow: config.pot.escrow,
          senderKey: config.pot.operatorKey,
        }),
        store,
        oracleKey: config.pot.oracleKey,
        replay: replayRecord,
        rules: config.pot,
        archived: (id) => {
          const blob = store.getGameRecord(id);
          return blob
            ? {
                publicBytes: new TextEncoder().encode(publicRecordJson(blob)),
                full: JSON.parse(gunzipSync(blob).toString("utf8")),
              }
            : null;
        },
        log: (msg, fields) => console.log(msg, fields ?? ""),
      })
    : undefined;
  const app = createApp({ config, store, keys, pot });

  const sweep = setInterval(() => store.sweep(Date.now()), 10 * 60_000);
  sweep.unref();
  // The pot keeper: settles, finalizes and refunds without anyone asking.
  if (pot) {
    const keeper = setInterval(() => {
      pot.tick().catch((e: unknown) => console.error("pot keeper", e));
    }, 20_000);
    keeper.unref();
  }

  const server = app.listen(config.port, () => {
    console.log(
      `Landpot API on :${config.port} (issuer ${config.issuer}, audience ${config.audience}, pot ${config.pot ? `escrow ${config.pot.escrow} on chain ${config.pot.chainId}` : "off"})`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
