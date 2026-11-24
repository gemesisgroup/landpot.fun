import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const devnetEnv = parseEnvFile(".data/solana/devnet/api.env");
const tunnelEnv = parseEnvFile(".data/solana/devnet/tunnel.env");

const sharedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...devnetEnv,
  ...tunnelEnv,
  GAME_ENV: "dev",
  GIT_COMMIT: "DEVNET",
  LANDPOT_DATA_DIR: ".data/api-devnet",
  LANDPOT_PAID_LOBBIES: "1",
  LANDPOT_POT_FUNDING_MINUTES: process.env.LANDPOT_POT_FUNDING_MINUTES ?? "10",
  SKIP_BROWSER_OPEN: "true",
  WEBSOCKET_URL: "",
};

const children: ChildProcess[] = [];
const stop = () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // ignore
    }
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function run(label: string, cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  console.log(`[landpot-tunnel] starting ${label}...`);
  const cp = spawn(cmd, args, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(cp);
  cp.on("exit", (code) => {
    console.log(`[landpot-tunnel] ${label} exited (${code})`);
  });
  return cp;
}

// 1. Landpot API (:8787)
run("api", "npx", ["tsx", "src/api/Server.ts"], sharedEnv);

// 2. Game Server (:3000 / :3001)
run("server", "npx", ["tsx", "src/server/Server.ts"], sharedEnv);

// 3. Vite Frontend + Proxy (127.0.0.1:9000)
run("client", "npx", ["vite", "--host", "127.0.0.1"], sharedEnv);

// 4. Cloudflare Tunnel (landpot.fun -> :9000, api.landpot.fun -> :8787)
// Uses explicit Cloudflare edge IPs + http2 so VPN FakeDNS (no SRV) never blocks tunnel startup.
const token = tunnelEnv.CLOUDFLARE_TUNNEL_TOKEN;
if (!token) throw new Error("Missing CLOUDFLARE_TUNNEL_TOKEN in tunnel.env");
run(
  "cloudflared",
  "cloudflared",
  [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--edge-ip-version",
    "4",
    "--edge",
    "198.41.192.7:7844",
    "--edge",
    "198.41.192.47:7844",
    "--edge",
    "198.41.200.13:7844",
    "--edge",
    "198.41.200.23:7844",
    "run",
    "--token",
    token,
  ],
  { ...sharedEnv, GODEBUG: "tlsmlkem=0" },
);
