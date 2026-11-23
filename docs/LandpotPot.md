# Landpot pot: paid matches

Players pay an equal entry into an escrow program on **Solana**, play a
match, and split the pot by the land each holds at the end. The server never
holds the money. It only reports a result, and anyone can check that result.

**Status:** the escrow program (Anchor, `solana/programs/landpot_escrow`),
the API's chain client, Sign-In With Solana and the pay/claim UI are built.
They are tested end to end on a local validator: the program's rules, plus
the lobby → deposit → settle → review → finalize → claim and refund paths
through the API.

**Not done yet:** the program is **unaudited**. Run it on devnet only, never
with real money before an audit.

## Weekly Caldera Community Cup

Set `LANDPOT_CUP_WEEK_HOUR_UTC` on the API to the UTC hour of the week
(0 = Sunday 00:00, 167 = Saturday 23:00). For example, 161 opens the
Saturday 17:00 UTC event. The first new paid lobby opened in that hour is
the cup. Other lobbies use the regular rules. Without the setting every
lobby uses the regular rules. A running lobby finishes its funding cycle first.

Four pairs play on Caldera. Sign in with your wallet and enter your
partner's wallet on the paid match card. When both choices match, the pair
locks for this round and both players can pay. All eight depositors must
be present to start. Each pair chooses positions in its highlighted starting
area and can place temporary hold, attack and help markers for its partner.

The last pair holding land wins. At 12 minutes the eruption continues for
two more minutes. At 14 minutes the pair with the greatest total weighted
territory wins (crater ×3). An exact tie for first or an unverifiable result
voids the round. The existing refund path opens at the result deadline or on
guardian cancellation. Each winning wallet gets half the net pot including
an eliminated teammate. If the net amount is odd, the existing deterministic
rounding rule assigns the last base unit. Settlement checks the replay and
the registered pairs against the depositors before proposing a payout.

## Launch values

|                 | Value                                         | Why                                                                                                                 |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Token           | **Landpot**, symbol **LANDPOT**, via pump.fun | pump.fun mints are Token-2022, 6 decimals, 1B supply, no mint or freeze authority: exactly what the escrow accepts  |
| Supply          | **1,000,000,000**, fixed                      | pump.fun's standard; no mint authority after launch                                                                 |
| Entry           | **10,000 LANDPOT** (0.001% of supply)         | about $1 at a $100k market cap, $10 at $1M; an API setting, changed without a redeploy                              |
| Players         | **8–16**, entries open **20 min**             | 8 is the program's floor; 20 min fills a lobby without stalling it                                                  |
| Fees            | **2% burned, 3% treasury**                    | the prototype's rule                                                                                                |
| Max pot         | **10,000,000 LANDPOT** per round              | set at initialize: leaves room to raise the entry to 625,000, and caps what one round of an unaudited program holds |
| Daily claim cap | **2,000,000 LANDPOT** per wallet              | set at initialize: a top win (≈95% of 16 entries) is claimable in one day up to an entry of about 130,000           |
| Review hold     | **24 h**                                      | the program's minimum; enough for a multisig guardian to react                                                      |

## Rules

| Rule              | Value                                                                        | Where                                                                                |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Players per match | 8–16                                                                         | program `open` (8 is the hard minimum); API `LANDPOT_POT_MIN_PLAYERS`/`_MAX_PLAYERS` |
| Entry             | equal for all                                                                | API `LANDPOT_POT_STAKE` (whole tokens)                                               |
| No-show           | entry back less their fee share, floor(net ÷ depositors)                     | `Payouts.ts`                                                                         |
| Match             | FFA on Caldera, 12 minutes; humans only: no bots, no nations, no alliances   | `packages/shared/src/PaidMatch.ts`, `paidGameConfig` in `src/server/PaidLobby.ts`    |
| Burn              | 2% of the pot, floored, burned from the vault (the supply goes down)         | `initialize` `burn_bps`                                                              |
| Treasury          | 3% of the pot, floored separately                                            | `initialize` `treasury_bps`                                                          |
| Split             | the rest, in proportion to land value at the end (crater tiles count ×3)     | `src/api/pot/Payouts.ts`, `landValue` in `engine-lib/game/Caldera.ts`                |
| Units             | no nukes, missile silos, SAMs or warships                                    | `PAID_MATCH_DISABLED_UNITS`                                                          |
| Eruption          | last 3 minutes: land outside an edge closing to ¼ of the width turns to rock | `PAID_MATCH_CALDERA`, `EruptionExecution`                                            |
| Rounding          | largest remainder; ties go to the lower keccak256(roundId ‖ wallet pubkey)   | `Payouts.ts`                                                                         |
| Review hold       | 24–48 h after a result is proposed                                           | `initialize` `review_delay`                                                          |
| Daily claim cap   | per wallet per UTC day                                                       | `initialize` `daily_cap`                                                             |
| Max pot           | per round                                                                    | `initialize` `max_bank`                                                              |
| Entries close     | 20 min after the lobby opens by default (at most 1 day)                      | API `LANDPOT_POT_FUNDING_MINUTES`                                                    |
| Token             | no freeze authority; Token-2022 only with metadata extensions, or plain SPL  | `check_mint` in the program                                                          |

Worked example: 8 players × 20 entry is a pot of 160. Burn 3.2 (2%),
treasury 4.8 (3%), net 152. Land held 100/50/30/20/0/0/0/0 pays
76/38/22.8/15.2/0/0/0/0. Amounts are in the token's base units (6 decimals),
so floors only bite at a millionth of a token.

**A depositor who isn't connected when the match starts** is left out and
gets their entry back at settlement, less their equal share of the fees:
floor(net ÷ depositors). The players who came split the rest by land. The
lobby waits for everyone who paid. It starts without them only just before
entries close, and only if at least two depositors are there.

## The map

Every paid match is played on **Caldera** (`scripts/landpot/makeMap.py`): a
round volcanic island around a crater lake with a cone in the middle. Eight
mountain ridges (with passes) and eight rivers (with fords) cut it into 16
identical plates, one per seat, plus eight islets offshore. Every terrain
field is drawn in one 22.5° wedge and mirrored, and the fields are computed
on the half-size grid Compact games play on, so the plates match exactly
there:

```
python scripts/landpot/makeMap.py            # image.png
cd map-generator && go run -tags nodynamic . --maps=caldera
python scripts/landpot/makeMap.py --stats    # balance per plate
```

On map4x (600×600, 178,868 land tiles): 11,179 land tiles per plate, 49%
plains, 47% highland, 5% mountain. The plates differ by 0.01% in land,
0.08% in plains, 0.15% in highland and under 1% in mountain.

The match ends after 12 minutes (`PAID_MATCH_MINUTES`), or earlier if one
player holds 80% of the land; land held then is the split.

### Caldera rules

The paid config carries `caldera` (`PAID_MATCH_CALDERA`, schema in
`engine-api/Schemas.ts`); the maths is in `engine-lib/game/Caldera.ts`,
shared by the simulation, the settlement replay and the client HUD.
Distances are from the map centre in doubled tile units, integers only.

- **The crater is worth more.** Land within a fifth of the map's width of
  the centre (`craterPermille` 200) counts `craterWeight` 3 times. The
  winner replay (`WinnerReplay.ts`) reports each alive player's land value,
  not their tile count, so the split follows it.
- **The eruption.** For the last `eruptionSeconds` (180) of the match,
  `EruptionExecution` closes an edge on the centre once a second, evenly from
  just past the farthest land down to a quarter of the width
  (`eruptionPermille` 250). Land outside it becomes impassable rock
  (`Game.setImpassable`): the owner loses it, structures on it go, and
  nobody can take it again. Rock leaves the land count, so the 80% win
  check is against the land still standing. The client draws rock as
  cooling lava (`LAVA_ROCK`).
- **The HUD.** `pot-share` shows the player's land value, their share of
  all alive players' land value, the estimated payout (entry × players
  here, less burn and treasury; no-show refunds are not subtracted) and
  the time to the eruption. Paid matches replace the OpenFront tutorial
  with three steps (`PAID_TUTORIAL_STEPS`).

## Flow

1. **Open.** Worker 0 of the game server keeps one paid lobby open
   (`LANDPOT_PAID_LOBBIES=1`). It asks the API to open a round
   (`POST /pot/open/:id`, which sends `open` as the **operator**, who pays
   the round's rent), and only then creates the game with the fixed paid
   config. The lobby is held: it can't start by filling up or by a timer.
2. **Deposit.** The home page lists the lobby (`GET /public/pot/lobbies`). A
   signed-in player presses _Pay and join_: the API builds an unsigned
   `deposit` transaction (`POST /public/pot/deposit-tx`, 402 if the wallet
   holds less than the entry), the wallet shows, signs and sends it
   (Wallet Standard `solana:signAndSendTransaction`), and once it is
   confirmed the client joins the lobby. No approval step: the transfer is
   signed by the player inside the deposit itself.
3. **Seat.** Every join and rejoin to a paid game asks `POST /pot/seat/:id`
   whether this account's wallet is among the round's depositors. This
   **fails closed**: if the API or chain can't answer, the player is turned
   away (`close_reason.pot_unavailable`) and can try again.
4. **Start.** Every 5 s the host reads `GET /pot/lobby/:id` and decides
   (`decidePaidLobby`):
   - every seat paid and everyone who paid connected: start now;
   - at least 8 paid, all connected, no new deposit for a minute: start;
   - 90 s before entries close, with at least 8 paid and at least 2 of them
     here: start with whoever came;
   - otherwise at that point: cancel.

   To start, the host calls `POST /pot/start/:id`, which confirms `start`
   and returns the depositors. The host keeps exactly those players and
   starts the match. A deposit that lands before `start` is in the round.

5. **Cancel.** `POST /pot/cancel/:id` refunds a lobby that won't start; its
   players are told and sent home. The host sends the deposit count it
   decided on. If more deposits landed since, the API answers 409 and the
   host looks again.
6. **Settle.** After the game server archives the record (`POST /game/:id`),
   the API's **keeper** (every 20 s, and right after an archive) replays it
   and maps land by clientID → persistentID → wallet. Depositors who weren't
   in the match get their refund; the record lists exactly who was there at
   the start, and nobody joins later. The rest of the net pot is split by
   land. The keeper sends `propose`, co-signed by the **oracle** key.
   `replay_hash` is keccak256 of exactly the bytes `GET /game/:id` serves.
7. **Review.** During the hold the **guardian** can `review(true)` to freeze
   a wrong result, then `cancel` it so everyone is refunded.
8. **Finalize.** After the hold the keeper sends `finalize`: the burn share
   is burned and the treasury share sent to the treasury's token account.
9. **Claim.** Winnings and refunds show in the paid-match panel
   (`GET /public/pot/claims/:wallet`); the player claims from their own
   wallet (`POST /public/pot/claim-tx`), within the daily cap. The claim
   creates the player's token account if needed.
10. **Close.** Once a settled round owes nothing, the keeper sends
    `close_round`: the round and vault accounts are closed and their rent
    goes back to the operator.

**Refunds without anyone's help.** Anyone may `cancel` a round when entries
closed without a start, when a started round got no result by `result_ends`
(2 days after entries close; a match where no depositor held land settles as
`void` and ends this way), or when a frozen result was left alone for one
more review period. The keeper cancels the first two; the frozen case is for
the guardian. After a cancel, each depositor claims their entry back.

## Roles and trust

| Role                  | Key                                                        | Can                                                                                       | Can't                             |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| **Operator**          | hot, on the API (`LANDPOT_POT_OPERATOR_KEY`)               | open and start rounds, refund an unfilled lobby, pay fees and rent for what the API sends | freeze results, move funds        |
| **Oracle**            | hot, on the API (`LANDPOT_POT_ORACLE_KEY`)                 | co-sign results                                                                           | anything else                     |
| **Guardian**          | **cold**: a multisig or hardware wallet, never on a server | pause, freeze a result, cancel a started or frozen round                                  | open rounds, move funds to itself |
| **Upgrade authority** | cold, from deploy                                          | `initialize` once; upgrade the program                                                    |                                   |

The operator and oracle share a server. Someone who takes it over could
propose a bad split but could not stop the guardian freezing it. So the
guardian stays off the server, and `initialize` refuses a guardian equal to
either hot key. Only the program's upgrade authority can `initialize`, so
nobody can claim the config between deploy and set-up. Before real money,
hand the upgrade authority to the guardian multisig or make the program
immutable (`solana program set-upgrade-authority --final`): whoever holds it
can replace the program.

**Anyone can check a result:** download `GET /game/:id`, compare its
keccak256 to the `Proposed` event's `replay_hash`, and re-run the match.
`GET /public/pot/:id` shows depositors, amounts and transactions. Territory
comes from our replay, identities from our database, depositors from the
chain; nothing a client reports is trusted.

## Program

`solana/programs/landpot_escrow/src/lib.rs` (Anchor 0.31.1). Accounts:

| Account  | Seeds               | Holds                                                                  |
| -------- | ------------------- | ---------------------------------------------------------------------- |
| Config   | `"config"`          | roles, mint and token program, fees, review hold, max pot, daily cap   |
| Round    | `"round"`, round id | phase, stake, deadlines, up to 16 players with deposits and payouts    |
| Vault    | `"vault"`, round    | the round's tokens; its authority is the round                         |
| ClaimCap | `"cap"`, wallet     | what a wallet claimed today, for the daily cap; one per wallet, reused |

The round id is keccak256 of the game id. Every transfer is `transfer_checked`
through the token interface, and a deposit checks the vault grew by exactly
the entry. The mint must have no freeze authority and no extension that
could tax, hook, claw back or freeze a transfer (pump.fun mints only carry
metadata).

Build (in WSL, see `scripts/landpot/solana-build.sh`):

```
npm run solana:build
```

It writes three programs to `solana/`, plus the IDL and its types to
`src/api/pot/`:

- `landpot_escrow.so`: the release build.
- `landpot_escrow_localnet.so`: tests and `dev:pot`, with a 2-second review
  hold.
- `landpot_escrow_devtest.so`: the same fast build at its own address
  (`solana/landpot_escrow_devtest.id`), for devnet playtests.

Program keypairs live in `.data/solana/` (gitignored).

## Deploy (devnet)

```
npm run solana:deploy -- --playtest    # fast review, own address, test mint
npm run solana:deploy                  # release build and address
```

- On the first run the script creates keys in `.data/solana/devnet/`:
  deployer (it pays, and is the upgrade authority), guardian, operator,
  oracle, treasury and test players.
- The deployer needs about 8 SOL: the deploy holds rent for the upload
  buffer and the program at once (about 3.5 SOL each, most of it returned).
  If it is short, the script stops and
  prints its address: fund it at faucet.solana.com.
- It deploys the program and refuses to put a fast-review build at the
  release address.
- Without `--mint`, it creates a test mint and funds the players.
- It initializes the config, creates the treasury's token account, and
  writes `api.env` with the `LANDPOT_POT_*` settings.
- Mainnet is refused. That deploy is a manual, reviewed step after the
  audit.

## Configuration

API:

| Variable                                  | Meaning                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `LANDPOT_POT_RPC_URL`                     | Solana RPC endpoint (use a paid provider in production; the public ones are rate-limited) |
| `LANDPOT_POT_CLUSTER`                     | `mainnet-beta`, `devnet` or `localnet` (explorer links, the sign-in message's Chain ID)   |
| `LANDPOT_POT_PROGRAM`                     | The escrow program id                                                                     |
| `LANDPOT_POT_ORACLE_KEY`                  | The config's oracle: a keypair file path, or its JSON array inline                        |
| `LANDPOT_POT_OPERATOR_KEY`                | The config's operator, same format (needs SOL for fees and round rent, returned on close) |
| `LANDPOT_POT_STAKE`                       | Entry, whole tokens                                                                       |
| `LANDPOT_POT_MIN_PLAYERS`, `_MAX_PLAYERS` | Optional, default 8 and 16                                                                |
| `LANDPOT_POT_FUNDING_MINUTES`             | Optional, default 20                                                                      |

Set the first six together or none. Without them paid matches are off:
`/public/pot/config` says `enabled: false`, the client shows nothing, and the
game-server endpoints answer 503.

Game server: `LANDPOT_PAID_LOBBIES=1` makes worker 0 host paid lobbies.

## Endpoints

| Who         | Method | Path                                   |                                                    |
| ----------- | ------ | -------------------------------------- | -------------------------------------------------- |
| game server | POST   | `/pot/open/:id`                        | Open a round for a new lobby (idempotent)          |
| game server | GET    | `/pot/lobby/:id`                       | Phase, deposits, depositors' persistentIDs         |
| game server | POST   | `/pot/seat/:id`                        | `{ persistentID }` → `{ seated }`                  |
| game server | POST   | `/pot/start/:id`                       | Start on chain → `{ depositors }`; 409 if too few  |
| game server | POST   | `/pot/cancel/:id`                      | `{ deposited }` → refund; 409 if more landed since |
| operator    | POST   | `/pot/settle/:id`, `/pot/finalize/:id` | By hand; the keeper does both                      |
| public      | GET    | `/public/pot/config`                   | Cluster, program, token, entry, seats              |
| public      | GET    | `/public/pot/lobbies?wallet=`          | Open lobbies, and whether this wallet is in        |
| public      | GET    | `/public/pot/claims/:wallet`           | Winnings and refunds owed                          |
| public      | POST   | `/public/pot/deposit-tx`               | `{ gameId, wallet }` → unsigned deposit (base64)   |
| public      | POST   | `/public/pot/claim-tx`                 | `{ gameId, wallet }` → unsigned claim (base64)     |
| public      | GET    | `/public/pot/tx/:signature`            | `confirmed`, `failed` or `pending`                 |
| public      | GET    | `/public/pot/:id`                      | How a game was settled                             |

## Local run

```
npm run dev:pot
```

Starts a Solana test validator in WSL with the `localnet` build and creates
a Token-2022 test mint. It initializes the escrow and funds 16 test
players, each with 2 SOL and 1,000 tokens; their keys are in
`.data/solana/dev/`. Then it runs the dev stack with paid lobbies on.
Entries close after `LANDPOT_POT_FUNDING_MINUTES`, default 3 here. The API
uses a fresh database in `.data/api-pot` each run.

To play from a browser, import a player key into a wallet set to the local
RPC (`http://127.0.0.1:8899`). To fill seats without more browsers, use
`scripts/landpot/devDeposit.ts`.

The validator from the Solana release needs a CPU with AVX2. On an older CPU,
build `solana-test-validator` from source and point
`LANDPOT_TEST_VALIDATOR` at it (`scripts/landpot/solanaLocal.ts`).

Tests: `npx vitest run tests/api/pot` covers:

- `SolanaEscrow.test.ts`: the program's rules;
- `PotFlow.test.ts`: the API flow;
- `Payouts.test.ts`: the split.

The first two need the validator and are skipped without it.
`tests/server/PaidLobby.test.ts` covers the host and the start rule.

## Known limits

- Only worker 0 hosts paid lobbies. With several game servers, each would
  open its own lobby; run paid lobbies on one.
- Every on-chain call goes through one operator key, one at a time.

## Before real money

1. **Audit** the program and the settlement path.
2. **Playtest on devnet** with the launch values and real wallets.
3. **Launch the token on pump.fun**, then deploy the release build to
   mainnet and initialize it with that mint.
4. **Keys:** the guardian and the upgrade authority are a multisig (or the
   program is made immutable); the operator holds only fee and rent money;
   hot keys live in a secret store.
5. **RPC:** a paid Solana provider.
6. **Legal:** fill in the Terms' placeholders and get them reviewed for the
   places you open to.
