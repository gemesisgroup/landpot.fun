# Caldera Cup: host guide for a closed playtest

Eight invited players, four pairs, one Cup match on **localnet or devnet
with test tokens**. Mainnet and real funds are out of scope until the owner
decides otherwise (docs/LandpotPot.md: the program is unaudited).

## Before the day

1. Agree the eight players and the start time with the owner. Each needs a
   Solana wallet that supports Wallet Standard (Phantom, Solflare,
   Backpack) set to the test cluster, test SOL for fees and one entry in
   test LANDPOT.
2. Check one phone in advance: open an invite link, confirm, pay, pick a
   start tile, place a team marker, then after elimination find the result
   on the Cup card.
3. Tell players the rules in one line: _pairs, 14 minutes, the pair with
   the most land (crater ×3) wins, each winner gets half the net pot._

## Running it

Local rehearsal (validator, API, game server and 16 funded dev wallets):

```
npm run dev:pot -- --cup
```

`--cup` makes the current hour the Cup hour and keeps registration open
10 minutes. On a shared server, set `LANDPOT_CUP_WEEK_HOUR_UTC` or arm the
next lobby by hand:

```
curl -X POST -H "x-api-key: $KEY" $API/pot/cup-next
```

Then, in order:

| Step    | Who          | What they see                                                 |
| ------- | ------------ | ------------------------------------------------------------- |
| Sign in | each player  | wallet address on the top bar                                 |
| Invite  | one per pair | **Copy invite link** on the Cup card, sends it in chat        |
| Confirm | the partner  | the inviter's address, entry, prize, **Confirm partner**      |
| Pay     | each player  | the pay button unlocks once paired; _you paid / partner paid_ |
| Join    | each player  | the lobby; the match starts when all eight are in             |
| Play    | everyone     | 12 min + 2 min eruption; spawn inside the pair's area         |
| Result  | everyone     | the winners' claim appears after the review hold              |

## When it goes wrong

| Situation                     | What happens                                          | Host action                                                                                   |
| ----------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Someone paid but doesn't come | the lobby can't start, is cancelled near the deadline | none; everyone claims a full refund from the card                                             |
| Exact tie for first at 14:00  | no winner, the round is void, card shows _tie_        | refund opens at the result deadline (~48 h after registration); a guardian can cancel earlier |
| Replay doesn't match          | void, card shows _couldn't verify_                    | same as a tie; keep the game id for the report                                                |
| Link says expired             | registration closed or the round was cancelled        | arm a new Cup, send new links                                                                 |
| Link says taken               | that inviter already has a partner                    | ask for a fresh link from someone unpaired                                                    |

## After the match

Read the metrics:

```
curl -H "x-api-key: $KEY" $API/pot/cup-stats/<gameId>
```

| Metric                               | Field                                                       |
| ------------------------------------ | ----------------------------------------------------------- |
| Invites that became a pair           | `invitesAccepted / invitesCreated`                          |
| Pairs that reached payment           | `pairsPaid / pairs`                                         |
| Lobby fill time                      | `fillSeconds` (opened → eighth deposit)                     |
| Want a rematch with the same partner | `rematch.yes / (yes + no)` (asked in-game after the result) |

Ask every losing player, and write the answers down word for word:

> «В какой момент вы поняли, что могли сыграть иначе?»

## Rehearsal script

`scripts/landpot/cup_e2e.py` runs the whole flow in eight isolated
browsers on the local validator (player 8 on a phone profile), with
`scripts/landpot/testSigner.ts` signing for the dev wallets. Evidence lands
in `design/shots/cup-e2e/`.
