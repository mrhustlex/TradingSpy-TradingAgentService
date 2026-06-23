# TradingSpy CLI Agent

Command-line interface for the Strands agent. Access powerful trading strategy generation, backtesting, and analysis from your terminal.

## Installation

```bash
# Install dependencies
pip install -r requirements.txt

# Install in development mode
pip install -e .
```

## Quick Start

```bash
# Generate a trading strategy
python -m cli strategy generate "momentum strategy for NVDA"

# Run a backtest
python -m cli backtest run SMA_Cross --dataset aapl-1d-1y.csv

# Download market data
python -m cli data download AAPL MSFT --period 5y --interval 1d

# Analyze a stock
python -m cli analyze stock MSFT --with-technicals

# Check ACP remote-agent output
python -m cli acp ping

# Interactive mode
python -m cli interactive
```

## Commands

### Strategy Commands

```bash
tradingspy strategy generate "description"    # Generate strategies
tradingspy strategy list                      # List all strategies
tradingspy strategy info NAME                 # Show strategy details
tradingspy strategy delete NAME               # Delete a strategy
```

### Backtest Commands

```bash
tradingspy backtest run STRATEGY --dataset FILE      # Run backtest
tradingspy backtest compare S1 S2 --dataset FILE    # Compare strategies
tradingspy backtest optimize STRATEGY --dataset FILE # Optimize parameters
```

### Data Commands

```bash
tradingspy data download AAPL MSFT           # Download market data
tradingspy data list                          # List available datasets
tradingspy data info TICKER                   # Show dataset info
tradingspy data delete TICKER                 # Delete dataset
```

### Analysis Commands

```bash
tradingspy analyze stock AAPL                 # Analyze stock
tradingspy analyze sector technology          # Analyze sector
```

### Interactive Mode

```bash
tradingspy interactive    # Start interactive REPL
```

### ACP Remote Agent Commands

ACP must be enabled in Settings under Assistant Outputs before these commands work.

```bash
tradingspy acp ping
tradingspy acp agents
tradingspy acp agent strategy
tradingspy acp run strategy --input '{"action":"list"}'
tradingspy acp get RUN_ID
tradingspy acp cancel RUN_ID
```

If you configured a remote agent auth token, pass it with `--token` or set:

```bash
export TRADINGSPY_REMOTE_AGENT_TOKEN=your-token
```

The installed CLI also exposes `tradingai` as an alias:

```bash
tradingai acp ping
```

Type natural language commands:
- "generate a momentum strategy for TQQQ"
- "analyze MSFT with technicals"
- "backtest EMA_Trend on AAPL"
- "help"
- "exit"

## Output Formats

Control output format with `--json` flag:

```bash
# Pretty output (default)
tradingspy backtest run SMA_Cross --dataset aapl.csv

# JSON output (for scripting)
tradingspy backtest run SMA_Cross --dataset aapl.csv --json | jq .
```

## Configuration

Configuration stored in `~/.tradingspy/config.json`:

```json
{
  "output_format": "pretty",
  "api_provider": "openai",
  "api_model": "gpt-4",
  "temperature": 0.7,
  "verbose": false,
  "data_dir": "~/.tradingspy/data",
  "cache_enabled": true,
  "api_url": "http://localhost:8000"
}
```

### Docker Environments

When running the CLI against a Dockerized backend, specify the API URL:

```bash
# Local Docker with docker-compose
tradingspy interactive --api http://backend:8000

# Or set it in config
echo '{"api_url": "http://backend:8000"}' >> ~/.tradingspy/config.json
```

The `api_url` defaults to `http://localhost:8000` for local development.

## Examples

### Generate and backtest a strategy

```bash
# 1. Generate strategy
python -m cli strategy generate "RSI momentum strategy for tech stocks"

# 2. Download data
python -m cli data download NVDA --period 2y --interval 1d

# 3. Backtest
python -m cli backtest run "RSI_Momentum" --dataset nvda-1d-2y.csv

# 4. Compare with others
python -m cli backtest compare "RSI_Momentum" "SMA_Cross" "EMA_Trend" \
  --dataset nvda-1d-2y.csv
```

### Batch processing

```bash
# Download data for multiple tickers
python -m cli data download AAPL MSFT GOOGL AMZN NVDA --period 5y

# Test strategy on all
for ticker in AAPL MSFT GOOGL AMZN NVDA; do
  python -m cli backtest run SMA_Cross --dataset "${ticker,,}-1d-5y.csv"
done
```

### Integration with other tools

```bash
# Export to JSON for processing
python -m cli backtest run SMA_Cross --dataset aapl.csv --json > results.json

# Parse with jq
cat results.json | jq '.total_return'

# Feed to another tool
```

### Docker Integration

```bash
# Inside Docker container or when backend is in Docker
docker-compose up -d

# In another terminal, run CLI commands against the containerized backend
tradingspy interactive --api http://backend:8000

# Or update config to persist the API URL
# ~/.tradingspy/config.json:
# {
#   "api_url": "http://backend:8000"
# }

# Then use CLI normally:
tradingspy interactive
```
python -m cli backtest run SMA_Cross --dataset aapl.csv --json | \
  python analyze_results.py
```

## Architecture

```
cli/
├── __main__.py           # CLI entry point
├── __init__.py           # Package init
├── commands/             # Command implementations
│   ├── strategy.py       # Strategy generation/management
│   ├── backtest.py       # Backtest execution
│   ├── data.py           # Data download/management
│   ├── analyze.py        # Stock analysis
│   └── interactive.py    # REPL mode
├── output/               # Output formatting
│   ├── formatters.py     # Table, JSON, CSV formatting
│   └── progress_bar.py   # Progress indicators
├── utils/                # Utilities
│   └── config.py         # Configuration management
└── requirements.txt      # Python dependencies
```

## Sharing Code with Web UI

Both CLI and web UI use the same core `StrandsAgentLoop` from `backend/modules/strands_agent.py`:

```
┌─ Web UI (React) ─────────┬─ CLI (Python) ──┐
│                          │                  │
└──────→ Backend (FastAPI) ←─────────────────┘
             │
             └──────→ Core Agent Loop
                backend/modules/strands_agent.py
```

This ensures consistent agent behavior and responses across both interfaces.

## Future Enhancements

- [ ] Config UI command
- [ ] Estimated time remaining (ETA)
- [ ] Step counter during operations
- [ ] Cancel button during tasks
- [ ] Sound notifications
- [ ] Report generation
- [ ] API client support
- [ ] Dashboard view
- [ ] Scheduled tasks
- [ ] Multi-account support

## Contributing

To add new commands:

1. Create new command file in `cli/commands/`
2. Use Click decorators for command structure
3. Add to `__init__.py`
4. Register in main `__main__.py`

## License

Same as TradingSpy Service

## Support

Issues? Check:
- `--help` flag on any command
- `cli/commands/*.py` for examples
- Backend logs for agent errors
