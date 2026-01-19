# Astrid Validator - Subnet 127

A production-ready Bittensor subnet validator daemon for Subnet 127 (Astrid). This validator connects to the Astrid coordination service, executes trading strategy simulations in isolated Docker environments, and manages Bittensor weight commitments.

## Features

- **Distributed Task Execution**: Polls and executes tasks from the Astrid coordinator using BullMQ and Redis
- **Bittensor Integration**: Automatic weight setting with support for static weights or dynamic weights from an external API
- **Docker Sandbox**: Secure, isolated execution of trading simulations and NPX tasks
- **Trade Validation**: Validates on-chain transactions and simulates trading strategies
- **Health Monitoring**: Periodic heartbeat reporting to the coordinator service
- **Admin Dashboard**: Bull Board UI for monitoring job queues and task execution
- **Production Ready**: Multi-stage Docker builds, proper error handling, and graceful shutdown

## Architecture

The validator operates as a daemon that:
1. Registers with the Astrid coordinator service using a Polkadot/Substrate identity
2. Polls for tasks (trading simulations, Docker jobs, NPX executions)
3. Executes tasks in isolated environments with resource limits
4. Reports results back to the coordinator
5. Maintains heartbeat signals for liveness monitoring
6. Manages Bittensor weight commitments at configurable intervals

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Redis 7+ (included in docker-compose.yml)
- Bittensor validator identity (mnemonic phrase)

## Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
NODE_ENV=production

# Astrid API endpoint
API_URL=https://api.astrid.global

# Redis connection
REDIS_URL=redis://localhost:6379

# Validator identity (Polkadot/Substrate mnemonic or secret seed)
VALIDATOR_MNEMONIC="your twelve word seed phrase goes here"
VALIDATOR_SECRET_SEED="0x..."

# Heartbeat interval (ms)
HEARTBEAT_INTERVAL_MS=10000

# Maximum concurrent task executions
MAX_CONCURRENT_TASKS=5

# Docker socket path
DOCKER_SOCKET=/var/run/docker.sock

# Validator display name
VALIDATOR_DISPLAY_NAME=Validator Name

# Admin dashboard port
ADMIN_PORT=3000

# Bittensor configuration
BITTENSOR_ENABLED=true
BITTENSOR_WS_ENDPOINT=wss://entrypoint-finney.opentensor.ai:443
BITTENSOR_NETUID=127
BITTENSOR_VERSION_KEY=0
BITTENSOR_WEIGHT_INTERVAL_MS=3600000

# Optional: Dynamic weights from external API
# BITTENSOR_WEIGHTS_URL=https://api.example.com/weights

# Optional: Static weight targets (comma-separated uid:weight pairs)
# BITTENSOR_STATIC_WEIGHTS=0:100,1:50,2:25
```

## Usage

### Development Mode

```bash
# Run with auto-reload
npm run dev
```

### Production Mode

```bash
# Build and start
npm run build
npm start
```

### Docker Deployment

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f validator

# Stop services
docker-compose down
```

### With Development Tools

```bash
# Start with Redis Commander UI
docker-compose --profile tools up -d

# Access Redis Commander at http://localhost:8081
# Access Bull Board at http://localhost:3000/admin/queues
```

## Task Types

The validator supports multiple task execution modes:

### 1. Docker Image Tasks
Executes arbitrary Docker images with mounted volumes and environment variables:
- Secure sandbox isolation
- Resource limits and timeout controls
- Output capture and error handling

### 2. NPX Tasks
Runs NPX commands in isolated containers:
- Fresh npm package installations
- Controlled execution environment
- Stdout/stderr logging

### 3. Simulate Trade Tasks
Executes trading strategy simulations using the SigmaArena VM:
- Loads OHLCV market data
- Runs custom trading strategies
- Generates performance reports and trade logs

### 4. Validate Transaction Tasks
Validates on-chain blockchain transactions:
- Transaction verification
- State validation
- Result reporting

## Bittensor Weight Management

The validator automatically manages weight commitments on Subnet 127:

### Static Weights
Configure fixed weight targets in `.env`:
```env
BITTENSOR_STATIC_WEIGHTS=0:65535,1:32768,2:16384
```

### Weight Submission
- Duplicate UIDs are automatically deduplicated
- Submissions occur at configurable intervals
- Automatic retry on transient failures

## Monitoring & Administration

### Bull Board Dashboard
Access the job queue dashboard at `http://localhost:3000/admin/queues` to:
- Monitor active, completed, and failed jobs
- View job details and execution logs
- Retry failed jobs manually
- Track queue metrics and performance

### Logging
The validator uses structured JSON logging via Pino:
- Configurable log levels (`debug`, `info`, `warn`, `error`)
- Request/response correlation IDs
- Performance metrics and timing data

### Health Checks
The validator reports heartbeat signals to the coordinator:
- Current task execution status
- System resource utilization
- Connection health

## Project Structure

```
src/
├── admin/          # Bull Board admin interface
├── config/         # Environment configuration and logger setup
├── core/           # Core validator logic
│   ├── runner/     # Task execution handlers
│   ├── bittensor-weights.ts
│   ├── heartbeat.ts
│   ├── monitoring.ts
│   ├── queue.ts
│   ├── task-poller.ts
│   ├── task-runner.ts
│   └── validator-service.ts
├── polkadot/       # Polkadot/Substrate API integration
└── utils/          # Identity management and utilities
```

## Development

### Linting
```bash
npm run lint
```

### Building
```bash
npm run build
```

## Security Considerations

- **Credential Storage**: Never commit your validator mnemonic or secret seed to version control
- **Docker Socket**: The validator requires access to `/var/run/docker.sock` for task execution
- **Network Isolation**: Consider running in isolated network environments
- **Resource Limits**: Configure `MAX_CONCURRENT_TASKS` based on available system resources
- **API Authentication**: Ensure secure communication with the Astrid coordinator

## Troubleshooting

### Validator fails to register
- Verify `API_URL` is correct and accessible
- Check that `VALIDATOR_MNEMONIC` or `VALIDATOR_SECRET_SEED` is valid
- Ensure network connectivity to the coordinator

### Tasks not executing
- Verify Redis connection via `REDIS_URL`
- Check Docker daemon is running and accessible
- Review `MAX_CONCURRENT_TASKS` setting
- Check admin dashboard for queue status

### Weight submission failures
- Verify Bittensor WebSocket endpoint connectivity
- Check `BITTENSOR_NETUID` matches your subnet
- Ensure validator has sufficient TAO balance for transactions
- Review weight format and UID validity

## License

See [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper logging and error handling
4. Test in development environment
5. Submit a pull request with detailed description

## Support

For issues, questions, or feature requests:
- Open an issue in the repository
- Contact the Astrid team
- Check the validator logs for detailed error information
