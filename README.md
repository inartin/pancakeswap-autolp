# PancakeSwap Autofarmer Bot — Solana

### + Read-Only: Meteora DLMM & Uniswap V3 (Ethereum)

<p align="left">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/pnpm-9%2B-F69220?style=for-the-badge&logo=pnpm&logoColor=white" alt="pnpm" />
  <img src="https://img.shields.io/badge/Solana-Web3.js-9945FF?style=for-the-badge&logo=solana&logoColor=white" alt="Solana" />
  <img src="https://img.shields.io/badge/PancakeSwap-CLMM-D1884F?style=for-the-badge&logo=pancakeswap&logoColor=white" alt="PancakeSwap" />
  <img src="https://img.shields.io/badge/Meteora-DLMM-FF4081?style=for-the-badge&logo=atom&logoColor=white" alt="Meteora DLMM" />
  <img src="https://img.shields.io/badge/Telegram-Bot_API-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Bot" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License: MIT" />
</p>

> **NOTE: This bot is experimental and unfinished.**
> - May have bugs
> - Use at your own risk

Telegram bot for automating PancakeSwap liquidity farming on Solana, with read-only portfolio and fee tracking for Meteora DLMM (Solana) and Uniswap V3 (Ethereum).

---

## Tech Stack

| Domain | Technologies |
| :--- | :--- |
| **Runtime & Language** | ![NodeJS](https://img.shields.io/badge/node.js-339933?style=flat-square&logo=node.js&logoColor=white) ![JavaScript](https://img.shields.io/badge/javascript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) ![pnpm](https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white) |
| **Blockchain & DEX** | ![Solana](https://img.shields.io/badge/Solana_Web3.js-9945FF?style=flat-square&logo=solana&logoColor=white) ![Anchor](https://img.shields.io/badge/Anchor_IDL-00C4B4?style=flat-square&logo=anchor&logoColor=white) ![PancakeSwap](https://img.shields.io/badge/PancakeSwap_CLMM-D1884F?style=flat-square&logo=pancakeswap&logoColor=white) ![Meteora](https://img.shields.io/badge/Meteora_DLMM-FF4081?style=flat-square&logo=atom&logoColor=white) ![Jupiter](https://img.shields.io/badge/Jupiter_API-00BEF0?style=flat-square&logo=solana&logoColor=white) ![Uniswap](https://img.shields.io/badge/Uniswap_v3-FF007A?style=flat-square&logo=uniswap&logoColor=white) |
| **Databases & State** | ![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat-square&logo=postgresql&logoColor=white) ![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat-square&logo=redis&logoColor=white) ![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=flat-square&logo=drizzle&logoColor=black) |
| **Bot & Network** | ![Telegram](https://img.shields.io/badge/Telegram_Bot_API-26A5E4?style=flat-square&logo=telegram&logoColor=white) ![Express](https://img.shields.io/badge/Express.js-000000?style=flat-square&logo=express&logoColor=white) ![Axios](https://img.shields.io/badge/Axios-5A29E4?style=flat-square&logo=axios&logoColor=white) ![Helius](https://img.shields.io/badge/Helius_RPC-E65100?style=flat-square&logo=solana&logoColor=white) |

---

## Features

- **Multi-Wallet Management:** Up to 3 active wallets per user (Solana & read-only EVM).
- **Position Tracking with Pool Filtering:** Real-time tracking across PancakeSwap CLMM and Meteora DLMM pools.
- **🪐 Meteora DLMM (Read-Only):**
  - Live detection of open DLMM positions (`Position` / `PositionV2`) across all pairs.
  - Accurate bin price boundaries, active bin calculation, and in-range indicators.
  - Live claimable fees breakdown (Token0, Token1, and USD value).
  - All-time earned fees and estimated APR / hourly / daily income.
  - Direct links to Meteora and Solscan with strict read-only protection (no write actions or automated transactions).
- **Automated Liquidity Management (PancakeSwap):** Create, top up, and close positions.
- **Smart Token Swaps & Auto-Unwrap:** Automatic WSOL unwrapping and token balancing via Jupiter Swap.
- **Real-Time Rewards & Compounding:** Real-time claimable fee calculation, single-tap claims, and auto-compounding back into liquidity.
- **Intelligent Auto-Rebalance:** Adaptive range calculation based on market volatility, with failure memory and safety cooldown limits.
- **Manual Rebalance:** Rebalance out-of-range positions into new custom or volatility-based ranges.
- **Smart Alerts:** Proximity boundary warnings (edge-triggered) and out-of-range notifications with instant rebalance buttons.
- **Visual Range Graphs & APR:** In-chat position visual range bars (`|────🟢────|`) and APR metrics.
- **Secure Key Management:** Private key encryption via `sodium-native` / AES-256-GCM, ephemeral prompts, secure export with auto-delete.
- **Security Audit Logging:** Complete audit trail for all key operations and transactions.
- **EVM Read-Only Support:** Uniswap V3 / V4 Ethereum position tracking and balance viewing.

---

## Preview

| | |
| --- | --- |
| ![Position view](screenshots/position.png) | ![Pending rewards](screenshots/pending-rewards.png) |
| Position details with range, APR and value | Pending rewards across positions |
| ![Out-of-range alert](screenshots/out-of-range.png) | ![Rewards claimed](screenshots/rewards-claimed.png) |
| Out-of-range alert with rebalance button | Rewards claim confirmation |

---

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Solana RPC endpoint (Helius recommended, enables priority fees and SWQOS)

### 1. Install

```bash
cd autofarmer-sol
pnpm install
```

### 2. Setup

Generates `.env` from template and creates a secure `MASTER_PASSWORD`:

```bash
pnpm run setup
```

### 3. Configure

Edit `.env` and fill in the minimum required:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here          # From @BotFather
SOLANA_RPC_URL=https://your-rpc-endpoint.com    # Helius recommended
MASTER_PASSWORD=...                             # Auto-set by setup
```

Recommended (Optional):

```bash
JUP_API=your_jupiter_api_key                    # https://portal.jup.ag/
MORALIS_API_KEY=your_moralis_key                # Token metadata
```

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full list of variables, RPC/API notes, and database setup.

### 4. Run

```bash
pnpm run dev      # Development (auto-reload)
pnpm start        # Production
```

Open Telegram, find your bot, and send `/start`.

---

## Available Commands

### Wallet Management

- `/newwallet` — Generate a new Solana wallet
- `/importwallet` — Import from private key (Solana) or address (EVM read-only)
- `/exportkey` — Export private key (secure spoiler + auto-delete)
- `/wallet` — View active wallet details
- `/wallets` — List and switch between configured wallets
- `/balance` — Check SOL, token balances, or ETH balance

### Position Management

- `/positions` — View all active positions (PancakeSwap & Meteora DLMM) with range bars and fee breakdowns
- `/addposition` — Create new liquidity position on PancakeSwap
- `/rebalance <nft>` — Rebalance out-of-range position
- `/rewards` — Check claimable rewards across PancakeSwap and Meteora DLMM
- `/claim` — Claim pending PancakeSwap rewards
- `/compound` — Auto-compound rewards back into active liquidity
- `/stats` — View aggregated performance and rebalance history

### Alerts & Monitoring

- `/proximity` — Configure proximity alert thresholds (edge-triggered)

### Security

- `/auditlog` — View security audit log
- `/walletaudit` — View wallet security history

### General

- `/help` — List all commands and features
- `/start` — Initialize bot or switch active wallet
- `/cancel` — Cancel current input or flow

---

## Testing

Run unit and integration tests:

```bash
node tests/meteora-dlmm.test.js    # Meteora DLMM price math & live position tests
node tests/token.test.js           # Token metadata & price lookup tests
```

---

## Documentation

| File | Purpose |
| --- | --- |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Environment variables, database, API keys |
| [`docs/AUTO_REBALANCE.md`](docs/AUTO_REBALANCE.md) | Auto-rebalance strategy and configuration |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Development guide and production deployment |
| [`docs/AUTO_REBALANCE_IMPLEMENTATION.md`](docs/AUTO_REBALANCE_IMPLEMENTATION.md) | Auto-rebalance implementation notes |
| [`docs/COMPOUND_FEATURE.md`](docs/COMPOUND_FEATURE.md) | Compound feature notes |
| [`docs/DRIZZLE_GUIDE.md`](docs/DRIZZLE_GUIDE.md) | Drizzle ORM usage |
| [`docs/CLAIM_TRACKING_ANALYSIS.md`](docs/CLAIM_TRACKING_ANALYSIS.md) | Claim tracking analysis |
| [`docs/REBALANCE_TRACKING.md`](docs/REBALANCE_TRACKING.md) | Rebalance tracking notes |
| [`docs/HELIUS-SWQOS-INTEGRATION-GUIDE.md`](docs/HELIUS-SWQOS-INTEGRATION-GUIDE.md) | Helius SWQOS integration |
| [`docs/SWQOS-IMPLEMENTATION-SUMMARY.md`](docs/SWQOS-IMPLEMENTATION-SUMMARY.md) | SWQOS implementation summary |

---

## License

MIT
