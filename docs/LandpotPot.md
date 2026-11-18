# Landpot pot: paid matches

Players pay an equal entry into an escrow contract, play a match, and split
the pot by the land each holds at the end. The server never holds the money.
It only reports a result, and anyone can check that result.

**Status:** built end to end and tested on a local chain (anvil): contract,
token and deploy script; paid lobbies, seat check, on-chain start;
settlement, review hold, finalize, refunds; deposit and claim UI. The full
flow was run live with `npm run dev:pot`.

**Not done yet:** the contracts are **unaudited** and nothing is deployed on
Base. Do not put real money in it before an audit.

## Launch values

|                 | Value                                        | Why                                                                                                                   |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Token           | **Landpot**, symbol **LANDPOT**, 18 decimals | the game's name; no confusion with other LAND tokens                                                                  |
| Supply          | **1,000,000,000**, fixed                     | the usual size for a Base launch; no mint                                                                             |
| Entry           | **10,000 LANDPOT** (0.001% of supply)        | about $1 at a $100k market cap, $10 at $1M; an API setting, changed without a redeploy                                |
| Players         | **8–16**, entries open **20 min**            | 8 is the contract's floor; 20 min fills a lobby without stalling it                                                   |
| Fees            | **2% burned, 3% treasury**                   | the prototype's rule                                                                                                  |
| Max pot         | **10,000,000 LANDPOT** per round             | fixed at deploy: leaves room to raise the entry to 625,000, and caps what one round of an unaudited contract can hold |
| Daily claim cap | **2,000,000 LANDPOT** per wallet             | fixed at deploy: a top win (≈95% of 16 entries) is claimable in one day up to an entry of about 130,000               |
| Review hold     | **24 h**                                     | the contract's minimum; enough for a multisig guardian to react                                                       |

## Rules

| Rule              | Value                                                                | Where                                                                                 |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Players per match | 8–16                                                                 | contract `open` (8 is the hard minimum); API `LANDPOT_POT_MIN_PLAYERS`/`_MAX_PLAYERS` |
| Entry             | equal for all                                                        | API `LANDPOT_POT_STAKE` (whole tokens)                                                |
| No-show           | entry back less their fee share, floor(net ÷ depositors)             | `Payouts.ts`                                                                          |
| Match             | FFA, humans only: no bots, no nations, no alliances                  | `paidGameConfig` in `src/server/PaidLobby.ts`                                         |
| Burn              | 2% of the pot, floored, sent to `0x…dEaD`                            | deploy `LANDPOT_BURN_BPS`                                                             |
| Treasury          | 3% of the pot, floored separately                                    | deploy `LANDPOT_TREASURY_BPS`                                                         |
| Split             | the rest, in proportion to land held at the end                      | `src/api/pot/Payouts.ts`                                                              |
| Rounding          | largest remainder; ties go to the lower keccak256(roundId ‖ address) | `Payouts.ts`                                                                          |
| Review hold       | 24–48 h after a result is proposed                                   | deploy `LANDPOT_REVIEW_DELAY_SECONDS`                                                 |
| Daily claim cap   | per wallet per UTC day                                               | deploy `LANDPOT_DAILY_CAP`                                                            |
| Max pot           | per round                                                            | deploy `LANDPOT_MAX_BANK`                                                             |
| Entries close     | 20 min after the lobby opens by default (at most 1 day)              | API `LANDPOT_POT_FUNDING_MINUTES`                                                     |

Worked example: 8 players × 20 entry is a pot of 160. Burn 3 (2% floored),
treasury 4 (3% floored), net 153. Land held 100/50/30/20/0/0/0/0 pays
77/38/23/15/0/0/0/0.

**A depositor who isn't connected when the match starts** is left out and
gets their entry back at settlement, less their equal share of the fees:
floor(net ÷ depositors). The players who came split the rest by land. The
lobby waits for everyone who paid. It starts without them only just before
entries close, and only if at least two depositors are there.

## Flow

1. **Open.** Worker 0 of the game server keeps one paid lobby open
   (`LANDPOT_PAID_LOBBIES=1`). It asks the API to open a round
   (`POST /pot/open/:id`, which calls `open` as the **operator**), and only
   then creates the game with the fixed paid config. The lobby is held: it
   can't start by filling up or by a timer.
2. **Deposit.** The home page lists the lobby (`GET /public/pot/lobbies`). A
   signed-in player presses _Pay and join_: the wallet switches to Base,
   approves exactly one entry, calls `deposit(roundId)`, then the client
   joins the lobby.
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

   To start, the host calls `POST /pot/start/:id`, which mines `start` and
   returns the depositors. The host keeps exactly those players and starts
   the match. A deposit that lands before `start` is mined is in the round.

5. **Cancel.** `POST /pot/cancel/:id` refunds a lobby that won't start; its
   players are told and sent home. The host sends the deposit count it
   decided on. If more deposits landed since, the API answers 409 and the
   host looks again.
6. **Settle.** After the game server archives the record (`POST /game/:id`),
   the API's **keeper** (every 20 s, and right after an archive) replays it
   and maps land by clientID → persistentID → wallet. Depositors who weren't
   in the match get their refund; the record lists exactly who was there at
   the start, and nobody joins later. The rest of the net pot is split by
   land. The keeper signs the result as the **oracle** and sends
   `propose`. `replayHash` is keccak256 of exactly the bytes
   `GET /game/:id` serves.
7. **Review.** During the hold the **guardian** can `review(roundId, true)`
   to freeze a wrong result, then `cancel` it so everyone is refunded.
8. **Finalize.** After the hold the keeper calls `finalize`; burn and
   treasury are paid out.
9. **Claim.** Winnings and refunds show in the paid-match panel
   (`GET /public/pot/claims/:wallet`); the player claims from their own
   wallet, within the daily cap.

**Refunds without anyone's help.** Anyone may `cancel` a round when entries
closed without a start, when a started round got no result by `resultEnds`
(2 days after entries close; a match where no depositor held land settles as
`void` and ends this way), or when a frozen result was left alone for one
more review period. The keeper cancels the first two; the frozen case is for
the guardian. After a cancel, each depositor claims their entry back.

## Roles and trust

| Role         | Key                                                        | Can                                                                                   | Can't                             |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| **Operator** | hot, on the API (`LANDPOT_POT_OPERATOR_KEY`)               | open and start rounds, refund an unfilled lobby, pay gas for everything the API sends | freeze results, move funds        |
| **Oracle**   | hot, on the API (`LANDPOT_POT_ORACLE_KEY`)                 | sign results                                                                          | anything else                     |
| **Guardian** | **cold**: a multisig or hardware wallet, never on a server | pause, freeze a result, cancel a started or frozen round                              | open rounds, move funds to itself |

The operator and oracle share a server. Someone who takes it over could sign
a bad split but could not stop the guardian freezing it. So the guardian
stays off the server, and the deploy script refuses a guardian equal to
either hot key.

**Anyone can check a result:** download `GET /game/:id`, compare its
keccak256 to the `Proposed` event's `replayHash`, and re-run the match.
`GET /public/pot/:id` shows depositors, amounts and transactions. Territory
comes from our replay, identities from our database, depositors from the
chain; nothing a client reports is trusted.

## Token

`contracts/LandpotToken.sol` is a plain fixed-supply ERC-20: no owner, mint,
tax, pause or blacklist; the whole supply goes to one holder at deploy;
holders can burn their own. The escrow works with any plain ERC-20 without
transfer fees or rebasing (it checks each deposit arrives in full), so a
token launched elsewhere works too: deploy with `LANDPOT_TOKEN=0x…`.

## Deploy (Base)

```
LANDPOT_DEPLOY_NETWORK=base-sepolia \
LANDPOT_DEPLOYER_KEY=0x… \
LANDPOT_GUARDIAN=0x… LANDPOT_OPERATOR=0x… LANDPOT_ORACLE=0x… LANDPOT_TREASURY=0x… \
LANDPOT_TOKEN_NAME=Landpot LANDPOT_TOKEN_SYMBOL=LANDPOT LANDPOT_TOKEN_SUPPLY=1000000000 \
LANDPOT_MAX_BANK=10000000 LANDPOT_DAILY_CAP=2000000 \
npm run contracts:deploy
```

- Supply, max pot and daily cap are whole tokens (18 decimals).
- Defaults: burn 200 bps, treasury 300 bps, review hold 86,400 s.
- `LANDPOT_TOKEN_HOLDER` gets the supply (default: the deployer).
- `LANDPOT_DEPLOY_RPC_URL` overrides the chain's public RPC.
- `LANDPOT_DEPLOY_NETWORK=base` also needs `LANDPOT_DEPLOY_CONFIRM=base`.
- The script prints the API's `LANDPOT_POT_*` lines.
- After editing a contract, run `npm run contracts:build`; it refreshes
  `src/api/pot/LandpotEscrow.json`, and a test checks that file is current.

## Configuration

API:

| Variable                                  | Meaning                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `LANDPOT_POT_RPC_URL`                     | JSON-RPC endpoint (use a paid Base provider; the public one is rate-limited) |
| `LANDPOT_POT_CHAIN_ID`                    | 8453 Base, 84532 Base Sepolia                                                |
| `LANDPOT_POT_ESCROW`                      | The deployed `LandpotEscrow`                                                 |
| `LANDPOT_POT_ORACLE_KEY`                  | Private key of the contract's `oracle`                                       |
| `LANDPOT_POT_OPERATOR_KEY`                | Private key of the contract's `operator` (needs ETH for gas)                 |
| `LANDPOT_POT_STAKE`                       | Entry, whole tokens                                                          |
| `LANDPOT_POT_MIN_PLAYERS`, `_MAX_PLAYERS` | Optional, default 8 and 16                                                   |
| `LANDPOT_POT_FUNDING_MINUTES`             | Optional, default 20                                                         |

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
| public      | GET    | `/public/pot/config`                   | Chain, escrow, token, entry, seats                 |
| public      | GET    | `/public/pot/lobbies?wallet=`          | Open lobbies, and whether this wallet is in        |
| public      | GET    | `/public/pot/claims/:wallet`           | Winnings and refunds owed                          |
| public      | GET    | `/public/pot/:id`                      | How a game was settled                             |

## Local run

```
npm run dev:pot
```

Starts anvil, deploys a test token (LDEV) and the escrow with the real deploy
code, gives anvil accounts 4 and up 1,000 LDEV each, and runs the dev stack
with paid lobbies on (entries close after `LANDPOT_POT_FUNDING_MINUTES`,
default 3 here). The API uses a fresh database in `.data/api-pot` each run.
A browser needs a wallet holding one of those test accounts; to fill seats
without more browsers use `scripts/landpot/devDeposit.ts`.

Tests: `npx vitest run tests/api/pot` (contract, API flow and deploy code on
anvil; skipped when anvil is missing) and `tests/server/PaidLobby.test.ts`
(host and start rule).

## Known limits

- Only worker 0 hosts paid lobbies. With several game servers, each would
  open its own lobby; run paid lobbies on one.
- Every on-chain call goes through one operator key, one at a time.

## Before real money

1. **Audit** both contracts and the settlement path.
2. **Deploy on Base Sepolia** with the launch values and play real matches
   with real wallets.
3. **Keys:** guardian is a multisig; the operator key holds only gas money;
   hot keys live in a secret store.
4. **RPC:** a paid Base provider.
5. **Legal:** fill in the Terms' placeholders and get them reviewed for the
   places you open to.
