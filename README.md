# Astrid Validator — Subnet 127

A Bittensor subnet validator daemon for Subnet 127 (Astrid). The validator fetches completed miner competition results from the Astrid Arena API, independently replays trade data to compute PnL rankings, and submits weights on-chain based solely on competition outcomes.

## How It Works

1. At each weight-setting interval, fetch completed competitions in their delayed-emissions payout window from `GET /public/arena/completed-competitions`
2. For each competition, fetch all trades and execution runs from the public Arena API
3. Filter out disqualified participants and run eligibility checks (trade activity + execution run correlation)
4. Replay trades independently to compute each participant's PnL
5. Rank the top-3 eligible miners by replayed PnL and resolve their Bittensor UIDs via the live metagraph
6. Submit weight targets on-chain: `EMISSIONS_PERCENT`% per competition allocated 60/30/10 to the top 3; remainder to UID=0 (burn)

Emission parameters are hardcoded in `src/core/arena/constants.ts` and are not fetched from the platform.

## Prerequisites

- Node.js 20+
- Bittensor validator identity (mnemonic phrase)

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `.env` file:

```env
NODE_ENV=production

# Astrid Arena API
ARENA_API_URL=https://arena-api.astrid.global

# Validator identity (Polkadot/Substrate mnemonic or secret seed)
VALIDATOR_MNEMONIC="your twelve word seed phrase goes here"
VALIDATOR_SECRET_SEED="0x..."
VALIDATOR_SS58_ADDRESS="5YourSS58AddressHere"

# Bittensor configuration
BITTENSOR_ENABLED=true
BITTENSOR_WS_ENDPOINT=wss://entrypoint-finney.opentensor.ai:443
BITTENSOR_WEIGHT_INTERVAL_MS=3600000

# Logging
LOG_LEVEL=info

# Slack alerts (optional)
SLACK_API_TOKEN=your-slack-bot-token
SLACK_CHANNEL=#validator-alerts
SLACK_ERROR_CHANNEL=#validator-errors
SLACK_INFO_CHANNEL=#validator-info
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## Project Structure

```
src/
├── config/         # Environment configuration
├── core/
│   ├── arena/      # Arena weight computation pipeline
│   │   ├── api.ts          # Typed HTTP client for the Arena API
│   │   ├── cache.ts        # Incremental trade/execution cache
│   │   ├── constants.ts    # Hardcoded emission parameters
│   │   ├── eligibility.ts  # Miner eligibility rules
│   │   ├── metagraph.ts    # Bittensor UID resolution
│   │   ├── pnl.ts          # Trade replay PnL engine
│   │   ├── weights.ts      # Weight target construction
│   │   └── index.ts        # Pipeline orchestration
│   └── submit_weights.ts   # Weight submission loop
├── polkadot/       # Polkadot/Substrate API integration
└── utils/          # Logging, Slack, identity, signing
```

## Logging

Structured JSON logging to stdout. Set `LOG_LEVEL` to `debug`, `info`, `warning`, or `error`. Warnings and errors are forwarded to Slack if `SLACK_API_TOKEN` is configured.

## Troubleshooting

### Validator fails to connect

- Verify `ARENA_API_URL` is reachable
- Check `VALIDATOR_MNEMONIC` or `VALIDATOR_SECRET_SEED` is valid

### Weight submission failures

- Verify `BITTENSOR_WS_ENDPOINT` is reachable
- Ensure the validator has sufficient TAO for transactions

### No weights being set (all burn)

- Confirm a competition is currently in its emissions payout window
- Check validator logs — competitions outside `[emissionsStartDate, emissionsEndDate]` are skipped with a warning

## Security

- Never commit your validator mnemonic or secret seed to version control
- Load credentials from environment variables or a secrets manager

## License

See [LICENSE](LICENSE) for details.
