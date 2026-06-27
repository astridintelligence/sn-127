# SN-127 Validator — System Overview

## Architecture

Subnet 127 (SN-127) allocates Bittensor emissions to miners based on the results of completed miner competitions hosted on the Astrid Arena platform. The validator independently verifies competition outcomes and submits weights on-chain.

```
Bittensor Network
       │ emissions
       ▼
┌──────────────────────────────────────┐
│           SN-127 Validators          │
│  set weights based on:               │
│   • completed competition results    │
│   • independently replayed PnL       │
└───────────────┬──────────────────────┘
                │ weights
       ┌────────┴────────┐
       ▼                 ▼
  UID 0 (burn)     Arena miners (top 3)
```

---

## Emission Model

Only **delayed emissions** are supported. After a competition ends and the platform runs the integrity checks, a payout window opens:

```
payout window = [emissionsStartDate, emissionsEndDate]
```

During this window, the top-3 eligible miners (ranked by replayed PnL) receive a fixed allocation per competition:

| Recipient    | UID       | Weight             |
| ------------ | --------- | ------------------ |
| Burn         | 0         | 100% − arena total |
| Arena rank-1 | (dynamic) | `EMISSIONS_PERCENT`% × 60%  |
| Arena rank-2 | (dynamic) | `EMISSIONS_PERCENT`% × 30%  |
| Arena rank-3 | (dynamic) | `EMISSIONS_PERCENT`% × 10%  |

When no competition is in its payout window, all weight goes to UID=0 (burn).

Emission parameters are hardcoded in `src/core/arena/constants.ts` and are not fetched from the platform:

- `EMISSIONS_PERCENT` — allocation per competition
- `EMISSION_SPLITS = [0.60, 0.30, 0.10]` — rank 1, 2, 3 shares

---

## Validator Weight-Setting Flow

Every `BITTENSOR_WEIGHT_INTERVAL_MS` milliseconds the validator runs:

```
1. GET {ARENA_API_URL}/public/arena/completed-competitions
   → Returns: competitions in payout window with participants
               (participantId, coldkey, hotkey, uid, isDisqualified)

2. If no competitions active → submit [{uid:0, weight:100}]

3. For each competition:
   a. GET /public/competitions/:id/wallet-activity?after=<cursor>  (incremental)
   b. GET /public/competitions/:id/executions?after=<cursor>       (incremental)
   c. Filter out disqualified participants
   d. Run eligibility checks (trades + execution coverage)
   e. Replay trades to compute PnL per participant (src/core/arena/pnl.ts)
   f. Rank top-3 eligible miners by replayed PnL
   g. Resolve Bittensor UIDs via metagraph query

4. Build weight targets using hardcoded constants
5. Submit via subtensorModule.setWeights() or commit-reveal
```

---

## Configuration Reference

### sn-127 validator (`.env`)

| Variable                       | Description                  | Default                           |
| ------------------------------ | ---------------------------- | --------------------------------- |
| `ARENA_API_URL`                | Arena API base URL           | `https://arena-api.astrid.global` |
| `BITTENSOR_ENABLED`            | Enable weight submission     | `true`                            |
| `BITTENSOR_WS_ENDPOINT`        | Substrate WebSocket endpoint | Finney mainnet                    |
| `BITTENSOR_WEIGHT_INTERVAL_MS` | How often to submit weights  | `3600000` (1h)                    |
| `VALIDATOR_MNEMONIC`           | Validator signing key        | _(required)_                      |

---

## Data Flow Diagram

```
┌────────────────────────────────────┐
│  Arena API                         │
│                                    │
│ GET /public/arena/                 │
│      completed-competitions        │
│  [{competitionId, initialBalance,  │
│    emissionsStartDate,             │
│    emissionsEndDate,               │
│    participants[...]}]             │
│                                    │
│ GET /public/competitions/          │
│   :id/wallet-activity              │
│   :id/executions                   │
└─────────────────┬──────────────────┘
                  │ Competition data + raw trades
                  ▼
┌───────────────────────────────────────────────────────┐
│                  sn-127 Validator                     │
│                                                       │
│  1. Filter disqualified participants                  │
│  2. Eligibility check (trades + execution coverage)   │
│  3. Replay trades → compute PnL from raw trade data   │
│  4. Rank top-3 by replayed PnL                        │
│  5. Resolve coldkey → UID via Bittensor metagraph     │
│  6. Build weight targets (EMISSIONS_PERCENT% / 60-30-10)   │
│  7. subtensorModule.setWeights(netuid, uids, weights) │
└───────────────────────────────────────────────────────┘
```
