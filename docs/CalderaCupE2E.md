# Caldera Cup: end-to-end results (local validator, 2026-11-23)

Run with `scripts/landpot/cup_e2e.py`: eight isolated browsers, one of them a
phone profile (iPhone 13), dev wallets player-1..8, test LANDPOT. The dev
entry is 10 LANDPOT, so the 10,000 entry numbers scale down by 1,000.
Evidence: `design/shots/cup-e2e/` (screenshots, `result.json`).

## Main run: `aXruNdWeHJ`

| Step                 | Result                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Sign-in              | 8 wallets, through the UI                                                                     |
| Pairs                | 4 invites created, 4 accepted (pair 7+8 confirmed on the phone)                               |
| Deposits             | 8 / 8 through the pay button; lobby filled 92 s after it opened                               |
| Match                | 4 teams spawned in their outlined areas, played to the 14-minute limit                        |
| Archive → replay     | WinnerReplay on the server; replay hash `0x89eb18ce…e6b3d3`                                   |
| Settlement           | amounts `[0,0,0,0,0,0,38,38]` LANDPOT; proposed, finalized after the 2 s localnet review hold |
| Payouts (pair 7 + 8) | each wallet 970 → 1008 LANDPOT (+38), claims sent from the Cup card                           |

Claim transactions (both `finalized`, no error):

- player 7 `AkutaW8P…8EQRh`: `3uknKtcejrBwHsNVJJHFYxnxDugSpN5N2Eoz531h6E7UcTnjTt3QC7XWkHehqmEtaT1K1eGMLjCv1HoVj6o3e1Eg`
- player 8 (phone) `E3WDGH2T…N5pxK`: `43Z8b8FafsQpJndfdh6DaBDE9tN8x3XL4UE2265zKRbQqcSiFRLeFkCjP51u7sKqJhCcwRDbfz6K1ReEz6qF8JuY`

38 per winner = (8 × 10 − 2% − 3%) ÷ 2, +28 after the entry: the same
numbers the card shows before paying.

## The three cases

| Case                                                      | How checked                                        | Result                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| One partner eliminated, the other wins                    | engine test `Caldera.test.ts` + PotFlow `CupGame1` | both wallets of the winning pair get equal shares                                                                          |
| One of eight paid and didn't come                         | PotFlow `CupNoSho` on the validator                | lobby can't start, cancelled; full entry refundable at once (measured under 1 s after cancel)                              |
| Tie for first at the limit                                | engine test + PotFlow `CupTie01`                   | void, reason _tie_ on the card; refund opens at the result deadline, ~47.8 h after registration, unless a guardian cancels |
| Extra, found live: all paid, one pair never picked a tile | live run `anszXYdgVV`                              | match cancelled "not all players spawned", void _unverified_, refund opens at the result deadline (~48 h)                  |

The dropout and tie cases were not played live in eight browsers.

## Fixed during the run

1. Playtest metrics lost after payout: once claims empty the round, the keeper closes its account and `cup-stats`
   showed `pairsPaid: 0`; rematch answers after that got 403. Both now fall back to the settlement's record of who paid
   (test in PotFlow).
2. Cup tutorial said the pot is "split by the land each player holds"; it now says the pair with the most land wins and
   splits equally, and asks to spawn inside the team's area near the partner.
3. Stable test ids on the pay, confirm-invite and claim buttons for the rehearsal script.

## Not done

- Live playtest with eight people: **pending** until the owner agrees the players and the time.
- On the phone the run confirmed invite, pay, spawn in the team area and claim. Placing a team marker and finding the
  result after elimination were not exercised by the script.
