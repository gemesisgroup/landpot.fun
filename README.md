<div align="center">

# LANDPOT (`$LANDPOT`)

**Real-Time Territory Warfare with Non-Custodial BNB Smart Chain Escrow**

[![Live Site](https://img.shields.io/badge/Play_Now-landpot.fun-c6ff3d?style=for-the-badge&labelColor=0b0d10)](https://landpot.fun)
[![BNB Smart Chain](https://img.shields.io/badge/Network-BNB_Smart_Chain_(BEP--20)-F3BA2F?style=for-the-badge&labelColor=0b0d10)](https://bscscan.com)
[![X / Twitter](https://img.shields.io/badge/Follow-@landpot__bnb-ffffff?style=for-the-badge&labelColor=0b0d10)](https://x.com/landpot_bnb)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-3b82f6?style=for-the-badge&labelColor=0b0d10)](LICENSE)

*Conquer the map. Hold the crater. Every settled match burns 2% of the pot on-chain.*

</div>

---

## Overview

**Landpot** is a browser-based, real-time territorial strategy game where players expand empires, command armies, build defenses, and compete for **`$LANDPOT`** pots settled through a **non-custodial Solidity escrow contract** on **BNB Smart Chain (BSC)**.

- **Play free** immediately in Classic Multiplayer or Singleplayer against upgraded tactical AI — no wallet required.
- **Play for `$LANDPOT`** in deterministic, mirrored competitive formats where deposits lock directly into [`LandpotEscrow.sol`](bsc/contracts/LandpotEscrow.sol), replay hashes are committed on-chain via `keccak256`, **2%** of every settled pot is burned permanently to `0x000000000000000000000000000000000000dEaD`, and winners claim directly from their own wallet.

---

## Game Modes

| Mode | Format | Duration | Stake / Payout |
| :--- | :--- | :--- | :--- |
| **1v1 Caldera Arena** | Mirrored 1v1 (Queue or Friend Link) | 6 min | Selectable tiers: `10K` · `50K` · `100K` · `500K` · `1M` `$LANDPOT`. Winner takes **95%** of the pot. One-click rematch. |
| **Caldera FFA Pot** | 8–16 players Free-for-All | 12 min | Crater land counts **×3**; final 3-minute eruption burns the rim. Net pot splits proportionally by final weighted territory. |
| **Weekly Caldera Cup** | 4 locked pairs (`2v2v2v2`) | 14 min | Invite a partner by link. The winning duo splits **95%** of the entire 8-seat pot 50/50. |
| **Classic & Singleplayer** | Open multiplayer & AI battles | Flexible | Free-to-play across classic world and regional maps with upgraded tactical AI (anti-air SAM defense, naval fleets, flanking, and leader focus). |

---

## Non-Custodial Escrow & Tokenomics

Landpot never holds player funds in a custodial wallet. All paid match flows are enforced on-chain by [`bsc/contracts/LandpotEscrow.sol`](bsc/contracts/LandpotEscrow.sol):

- **95% Player Payouts** — Claimable directly by winners via `claim(roundId)` from their own EVM wallet (MetaMask, Rabby, Trust Wallet, OKX, Binance Web3 via EIP-6963).
- **2% Deflationary Burn** — Permanently transferred to `0x000000000000000000000000000000000000dEaD` on every finalized match.
- **3% Protocol Treasury** — Funds infrastructure, server hosting, and ongoing development.
- **100% Refunds on Ties & Cancellations** — Unfilled lobbies, declined/timed-out duels, or exact ties refund every deposit in full with zero fee.
- **Verifiable Settlement** — Every finished match archive is replayed deterministically, hashed with `keccak256`, co-signed by an independent oracle (`ecrecover`), and protected by a guardian review window before finalization.

---

## Repository Structure

```text
├── bsc/
│   ├── contracts/LandpotEscrow.sol   # Non-custodial BSC BEP-20 escrow contract (Solidity 0.8.24)
│   └── artifacts/LandpotEscrow.json  # Compiled ABI & bytecode
├── packages/
│   ├── engine/                       # Deterministic game simulation & upgraded AI behaviors
│   ├── engine-api/                   # Engine types & wire schemas
│   └── shared/                       # Shared match rules (Caldera config, stake tiers, payouts)
├── src/
│   ├── api/                          # Landpot API (SIWE/EIP-4361 wallet auth, PotService, BscEscrow)
│   ├── server/                       # Real-time game server, 1v1 DuelHost, PaidLobby manager
│   └── client/                       # Lit + Vite web client, EIP-6963 wallet connector, Arena UI
├── scripts/landpot/
│   ├── bscCompile.ts                 # Compiles LandpotEscrow.sol via solc
│   └── bscDeploy.ts                  # Deploys LandpotEscrow.sol to BSC Mainnet / Testnet
└── tests/                            # Vitest unit & integration test suites
```

---

## Local Development

### Prerequisites

- **Node.js** `24.x`
- **npm** `11+` / `12.x`

### Install & Run

```bash
# Install dependencies (reproducible lockfile install)
npm ci --ignore-scripts

# Start client + game server in development mode
npm run dev
```

### Typecheck, Tests & Production Build

```bash
# TypeScript check across the workspace
npx tsc --noEmit

# Run escrow, payout, duel, and AI test suites
npx vitest run tests/server/Duel.test.ts tests/api/pot/BscEscrow.test.ts tests/api/pot/Payouts.test.ts tests/api/pot/StakeTiers.test.ts

# Build production client bundle
npx vite build
```

---

## Smart Contract Compilation & Deployment (BSC)

All keys and addresses are supplied exclusively via environment variables — never committed to the repository.

```bash
# Compile LandpotEscrow.sol -> bsc/artifacts/LandpotEscrow.json
npx tsx scripts/landpot/bscCompile.ts

# Deploy to BNB Smart Chain (Mainnet or Testnet)
BSC_CLUSTER=bsc \
BSC_RPC_URL=https://bsc-dataseed.binance.org \
BSC_DEPLOYER_KEY=0x<deployer_private_key> \
BSC_TOKEN=0x<landpot_bep20_address> \
BSC_TREASURY=0x<treasury_address> \
BSC_GUARDIAN=0x<guardian_address> \
BSC_OPERATOR=0x<operator_address> \
BSC_ORACLE=0x<oracle_address> \
npx tsx scripts/landpot/bscDeploy.ts
```

### API Escrow Configuration

To enable paid matches on the Landpot API, configure the following environment variables (e.g. in `.env.landpot`, which is gitignored):

```env
LANDPOT_POT_MODE=bsc
LANDPOT_POT_CLUSTER=bsc
LANDPOT_POT_RPC_URL=https://bsc-dataseed.binance.org
LANDPOT_POT_CONTRACT=0x<deployed_escrow_contract>
LANDPOT_POT_OPERATOR_KEY=0x<operator_private_key>
LANDPOT_POT_ORACLE_KEY=0x<oracle_private_key>
LANDPOT_POT_STAKE=10000
LANDPOT_POT_STAKES=10000,50000,100000,500000,1000000
```

---

## License & Attribution

Landpot is built on top of [OpenFront.io](https://openfront.io/) (originally forked from WarFront.io).

- Source code is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](LICENSE).
- Assets are licensed under **CC BY-SA 4.0** — see [LICENSE-ASSETS](LICENSE-ASSETS).
- Original OpenFront copyright notices (`© OpenFront and Contributors`) are preserved in accordance with AGPL-3.0.
