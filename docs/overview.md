# SN-127 Validator — System Overview

## Architecture

Subnet 127 (SN-127) uses a two-tier miner model. Emissions from the Bittensor network flow to two classes of miners, and it is the validator's job to set the weights that determine how those emissions are split.

```
Bittensor Network
       │ emissions
       ▼
┌──────────────────────────────────────┐
│           SN-127 Validators          │
│  set weights based on:               │
│   • vault config          │
│   • arena miner competition results  │
└───────────────┬──────────────────────┘
                │ weights
       ┌────────┴────────┐
       ▼                 ▼
  UID 0 (burn)     Vault + Arena miners
```

---

## Emission Sources

### 1. Vault Miners

Vault miners receive a fixed portion of emissions configured in the **Vault** project. The configuration looks like this:

```
BITTENSOR_WEIGHTS="0:75,164:25"
```

This means:

- **75%** goes to UID 0 (burned / returned to root network)
- **25%** goes to UID 164 (the Vault miner)

The Vault API exposes these targets at `GET /v1/bittensor/weights`. Validators fetch from this endpoint and submit weights on-chain.

### 2. Arena Miners

Arena miners participate in a live **Miner Competition** hosted on the **arena.astrid.global**. They trade with simulated wallets and are ranked by PnL. A configurable percentage of emissions is redirected from the burn UID (0) to arena miners.

Example of emissions split when Vault miners have 25% and Arena miners have 25% of total emissions.

| Recipient         | UID       | Weight            |
| ----------------- | --------- | ----------------- |
| Burn (reduced)    | 0         | 50%               |
| Vault miner       | 164       | 25%               |
| Arena top-1 miner | (dynamic) | 15% (60% of 25%)  |
| Arena top-2 miner | (dynamic) | 7.5% (30% of 25%) |
| Arena top-3 miner | (dynamic) | 2.5% (10% of 25%) |

When there is no active competition, or no miners are eligible, the arena allocation is **ignored entirely** — vault-only weights apply.

---

## Project Roles

| Project                | Role                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| **Vault API**          | Serves vault weight targets (`GET api.astrid.global/v1/bittensor/weights`)             |
| **Arena API**          | Hosts miner competitions; exposes arena info + public leaderboard/trade/execution data |
| **sn-127 (this repo)** | Validator: fetches both, blends weights, submits on-chain                              |

---

## Validator Weight-Setting Flow

Every `BITTENSOR_WEIGHT_INTERVAL_MS` milliseconds the validator runs:

```
1. Fetch vault targets
   GET {API_URL}/bittensor/weights  →  [{uid:0, weight:75}, {uid:164, weight:25}]

2. If ARENA_API_URL is set:
   a. GET {ARENA_API_URL}/public/arena/bittensor
      → arenaEmissionsPercent, active competition, participants (coldkey + PnL)

   b. If active competition exists:
      - GET /public/competitions/:id/wallet-activity?after=<cursor>  (incremental)
      - GET /public/competitions/:id/executions?after=<cursor>       (incremental)
      - Cache results in memory; only new data fetched each cycle

   c. Eligibility check per miner (see [ranking-algorithm.md](ranking-algorithm.md))

   d. Rank top-3 eligible miners by PnL

   e. Resolve each miner's Bittensor UID via metagraph query

   f. Blend: reduce UID=0 weight by arenaPercent, add arena UIDs

3. Submit blended weights on-chain via subtensorModule.setWeights()
```

---

## Configuration Reference

### sn-127 validator (`.env`)

| Variable                       | Description                  | Default                           |
| ------------------------------ | ---------------------------- | --------------------------------- |
| `API_URL`                      | Vault API                    | `https://api.astrid.global/v1`    |
| `ARENA_API_URL`                | Arena API base URL           | `https://arena-api.astrid.global` |
| `BITTENSOR_ENABLED`            | Enable weight submission     | `true`                            |
| `BITTENSOR_WS_ENDPOINT`        | Substrate WebSocket endpoint | Finney mainnet                    |
| `BITTENSOR_NETUID`             | Subnet ID                    | `127`                             |
| `BITTENSOR_WEIGHT_INTERVAL_MS` | How often to submit weights  | `3600000` (1h)                    |
| `VALIDATOR_MNEMONIC`           | Validator signing key        | _(required)_                      |

---

## Data Flow Diagram

```
┌─────────────────────┐       ┌───────────────────────────┐
│   Vault API         │       │  Arena API                │
│                     │       │                           │
│ GET /bittensor/     │       │ GET /public/arena/        │
│      weights        │       │      bittensor            │
│  [{uid, weight}]    │       │  {percent, competition,   │
│                     │       │   participants[coldkey]}  │
└────────┬────────────┘       │                           │
         │                    │ GET /public/competitions/ │
         │ Vault Targets      │   :id/wallet-activity     │
         │                    │   :id/executions          │
         │                    └───────────────┬───────────┘
         │                                    │ Trades + Executions
         ▼                                    ▼
┌────────────────────────────────────────────────────────┐
│                  sn-127 Validator                       │
│                                                         │
│  1. Eligibility check (per-miner)                       │
│  2. Rank top-3 by PnL                                   │
│  3. Resolve coldkey → UID via Bittensor metagraph       │
│  4. Blend vault + arena weights                         │
│  5. subtensorModule.setWeights(netuid, uids, weights)   │
└────────────────────────────────────────────────────────┘
```
