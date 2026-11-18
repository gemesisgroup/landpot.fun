# Landpot API

`src/api/` replaces the closed-source OpenFront API (a Cloudflare Worker that
is not in this repo). It speaks the subset of that API's contract that the
Landpot client and game server actually use, plus wallet sign-in. Response
shapes are the shared zod schemas in `packages/shared`, and
`tests/api/` parses every response with them, so a drift fails the build.

Runs as one Node process: Express 5, `node:sqlite` (no native deps), `jose`
for Ed25519 JWTs, `@noble/curves` + `@noble/hashes` for wallet signatures.

```
npm run dev:all          # client :9000, game server :3000, API :8787
npm run start:api-dev    # the API alone, dev settings
npm run api:keygen       # print a new LANDPOT_JWT_KEY
docker build -f Dockerfile.api -t landpot-api .
```

## Deployment shape

One game server (master + workers) that does **not** register with a
cluster registry (`SUBDOMAIN` unset, no `LOBBY_COORDINATOR`), so it schedules
its own public lobbies and never calls the registry, coordinator or map weight
endpoints. Ranked matchmaking is off unless `RANKED_MATCHMAKING=1` on the game
server, and the client hides the Ranked card (`RANKED_ENABLED` in
`GameModeSelector.ts`).

The API image (`Dockerfile.api`) keeps its state in the `/data` volume:
back it up, it holds every account and archived game. The API lives at `https://api.<DOMAIN>`, which is where
the game server (`ServerEnv.jwtIssuer()`) and client (`getApiBase()`) look.

## Environment

| Variable                  | Dev default                          | Meaning                                                                                    |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `DOMAIN`                  | required (`localhost` in dev)        | JWT audience; issuer is `http://localhost:8787` for localhost, else `https://api.<DOMAIN>` |
| `API_KEY`                 | dev key from `start:server-dev`      | Shared secret the game server sends as `x-api-key`                                         |
| `LANDPOT_DATA_DIR`        | `.data/api`                          | SQLite database and (dev only) the generated signing key                                   |
| `LANDPOT_JWT_KEY`         | generated into the data dir          | Ed25519 private key as a JWK JSON string. **Required in prod.**                            |
| `LANDPOT_SITE_ORIGIN`     | `http://localhost:9000`              | The page origin: wallet sign-in messages are bound to it, and it is allowed by CORS        |
| `LANDPOT_ALLOWED_ORIGINS` | –                                    | Extra CORS origins, comma separated                                                        |
| `TURNSTILE_SECRET_KEY`    | Cloudflare's always-pass test secret | Server-side Turnstile check at join                                                        |
| `LANDPOT_API_PORT`        | `8787`                               | Listen port (not `PORT`, which dev tooling sets for the client)                            |
| `LANDPOT_POT_*`           | – (paid matches off)                 | Chain, escrow, keys and entry for paid matches: see [LandpotPot.md](LandpotPot.md)         |

The game server caches the JWKS for its lifetime: after rotating
`LANDPOT_JWT_KEY`, restart the game server.

## Identity

- Every visitor is a **user** (`id` = the UUID the game calls persistentID,
  `publicId` = 8-char public handle).
- `POST /auth/refresh` with no cookie creates a **guest** user and session.
  The game server rejects bare persistent IDs in production, so guests need a
  real JWT too.
- **Wallet sign-in** (EIP-4361 "Sign-In with Ethereum"): an unknown wallet is
  attached to the current guest in place (their history stays theirs); a
  known wallet switches the session to that wallet's account. Plain EOA
  signatures only for now; EIP-1271 contract wallets are not supported yet.
  The chain id is recorded but not restricted, since the chain is not chosen.
- Access token: EdDSA JWT, 15 min, `sub` = base64url of the user UUID,
  `provider` = `"wallet"` once a wallet is attached (absent for guests).
- Refresh token: random 32 bytes in an httpOnly `Secure` `SameSite=Lax` cookie
  scoped to `/auth`, 30 days. Only its SHA-256 is stored. Rotated on every
  refresh; presenting a used token revokes the whole session family.

## Endpoints

Client (CORS, credentials):

| Method | Path                            |                                                                                    |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/auth/refresh`                 | `{ jwt, expiresIn }`; mints a guest when there is no cookie; 401 on a bad cookie   |
| POST   | `/auth/logout`                  | Ends this session                                                                  |
| POST   | `/auth/revoke`                  | Ends every session of the user (bearer)                                            |
| POST   | `/auth/wallet/challenge`        | `{ address, chainId }` → `{ message }` to sign (bearer)                            |
| POST   | `/auth/wallet/verify`           | `{ message, signature }` → `{ jwt, expiresIn, address }` and a new cookie (bearer) |
| GET    | `/users/@me`                    | `UserMeResponseSchema` (bearer; also called by the game server with `x-api-key`)   |
| POST   | `/archive_singleplayer_game`    | gzip `GameRecord` from the client (bearer)                                         |
| GET    | `/game/:id`, `/public/game/:id` | Archived record, `persistentID`s scrubbed                                          |
| GET    | `/public/player/:publicId`      | Public profile                                                                     |
| GET    | `/cosmetics.json`               | Empty catalog (no store in Landpot)                                                |
| GET    | `/streams.json`                 | `{ featured: [] }`                                                                 |
| GET    | `/cluster.json`                 | 404: no server list, the client uses its bootstrap server                          |
| GET    | `/.well-known/jwks.json`        | Public signing key                                                                 |
| GET    | `/health`                       | Liveness                                                                           |

Game server (`x-api-key`):

| Method | Path                  |                                                 |
| ------ | --------------------- | ----------------------------------------------- |
| POST   | `/join_verify`        | Turnstile siteverify + name check               |
| POST   | `/game/:id`           | Archive a finished game; 409 if already stored  |
| GET    | `/reserved_clan_tags` | `[]`: no clans in Landpot                       |
| POST   | `/custom_tribes`      | `{ tribes: [] }`: bots keep organic names       |
| \*     | `/pot/*`              | Paid lobbies: open, seat, start, cancel, settle |

The `/pot/*` endpoints and the public `/public/pot/*` ones (config, open
lobbies, claims, a game's settlement) are listed in
[LandpotPot.md](LandpotPot.md). They need the `LANDPOT_POT_*` variables;
without them the game-server ones answer 503.

Not served, on purpose: `/users/@me/lobby_queue` (paid public listing; the
game server reports the payment as failed), the ranked queue, store, clans,
friends, leaderboards and the Discord/Google/Steam/email sign-ins. The nav
bars no longer link to them and the Ranked card is hidden, but deeper entry
points still exist (sign-in prompts in modals such as SinglePlayerModal,
UsernameInput and TribesPanel, the host lobby's "queue for public" button,
deep links like `#page-clan`, which now redirect to Play).

## Client

`src/client/Wallet.ts` finds wallets through EIP-6963 (falling back to
`window.ethereum`), signs the server's message with `personal_sign` and
reloads into the new session. `<landpot-wallet-button>` is the only account
control: in the desktop bar and at the foot of the mobile menu.

Archived records are stored whole (gzip, turns included) because stake
settlement will re-run them with `replayWinner`; only the public read scrubs
`persistentID` and reports.
