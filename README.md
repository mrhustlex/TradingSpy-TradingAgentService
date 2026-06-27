# TradingSpy

Local-first AI trading research, market intelligence, strategy generation, and Backtrader backtesting in one Docker Compose stack.

TradingSpy lets you chat with market data, inspect heatmaps and news catalysts, generate Python strategies, and compare real backtest results without connecting a brokerage account. It does not place trades.

## Highlights

- Tool-using market assistant with transparent agent runs and progress.
- Market, sector, industry, news, insider, and technical context.
- Backtrader strategy generation, validation, optimization, and benchmark comparisons.
- Local data storage with no hosted TradingSpy account required.
- Google AI Studio, Mistral, OpenRouter, and LiteLLM support.
- OpenAI-compatible local API for scripts and other agent clients.

## Quick Start With Docker

This is the recommended installation path.

### Prerequisites

- Git.
- Docker Desktop, or Docker Engine with Docker Compose v2.
- An API key for at least one supported LLM provider. The app will start without one, but AI features require a key.

### 1. Clone and configure

```bash
git clone https://github.com/mrhustlex/TradingSpy.git
cd TradingSpy
cp .env.example .env
```

Open `.env` and add one provider key. Google AI Studio is the default:

```bash
GOOGLE_AI_STUDIO_API_KEY=your-key
DEFAULT_PROVIDER=google_ai_studio
DEFAULT_MODEL=gemini-2.5-flash
```

You may leave the keys blank and configure a provider later from the app's Settings page.

### 2. Start TradingSpy

```bash
docker compose up -d --build
```

The first build downloads the application dependencies. Later starts use the Docker cache.

Check that all three services are healthy:

```bash
docker compose ps
```

Open:

- TradingSpy: <http://localhost:3000>
- API documentation: <http://localhost:8000/docs>
- SearXNG: <http://localhost:8080>

### 3. Stop or update

```bash
# Stop the application without deleting local data
docker compose down

# Pull updates and rebuild
git pull
docker compose up -d --build
```

Runtime data remains under `backend/data/`.

## Local Development Without Docker

Use this path when you want hot reload or plan to change the code.

### Prerequisites

- Python 3.11. Python 3.13 is not currently supported by the data-science dependency set.
- Node.js 22 and npm.
- Git.
- Docker is optional for SearXNG-backed web/news search.

### 1. Clone and configure

```bash
git clone https://github.com/mrhustlex/TradingSpy.git
cd TradingSpy
cp .env.example backend/.env
```

Add one provider key to `backend/.env`, or configure it later in the UI.

### 2. Start the backend

Run in the first terminal:

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

On Windows PowerShell, activate the environment with:

```powershell
.venv\Scripts\Activate.ps1
```

Confirm the backend is ready at <http://localhost:8000/health>.

### 3. Start the frontend

Run in a second terminal from the repository root:

```bash
cd frontend
npm ci
npm run dev
```

Open <http://localhost:5173>.

### 4. Optional: start local web search

News search uses SearXNG. If Docker is available, run this from the repository root:

```bash
docker compose up -d searxng
```

The rest of TradingSpy still works when SearXNG is unavailable; web-search tools will report that the search service could not be reached.

## Provider Configuration

Keys may be stored in `.env`/`backend/.env` or entered in Settings. Never commit a real key.

| Provider | Environment variable | Example default model |
| --- | --- | --- |
| Google AI Studio | `GOOGLE_AI_STUDIO_API_KEY` | `gemini-2.5-flash` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |
| LiteLLM | `LITELLM_API_KEY`, `LITELLM_BASE_URL` | Your proxy's model ID |

See [.env.example](.env.example) for every supported setting.

## First Things To Try

After opening the app, try:

```text
Explain today's market and strongest sectors using current heatmap data and fresh news.
```

```text
Download daily QQQ data for one year, then generate and backtest an RSI and volume strategy.
```

```text
Generate candidates until one beats buy and hold for QQQ. Reject strategies with zero trades.
```

```text
Find undervalued profitable semiconductor stocks and explain the evidence.
```

Agent runs appear in the Task Center and expose their plan, progress, tool results, validation failures, and final outcome.

## What TradingSpy Includes

### Research and market intelligence

- Market overview, sector and industry heatmaps, watchlists, and ticker charts.
- News and catalyst search through the local SearXNG service.
- Fundamentals, insider activity, technical context, and data-freshness checks.
- Daily, intraday, and extended-hours candle downloads.

### Strategy research

- Backtrader-powered backtests and parameter optimization.
- AI-generated strategies with syntax and runtime validation.
- Zero-trade rejection and buy-and-hold or saved-strategy benchmarks.
- Persistent strategy, result, and optimization history.

### Agent interfaces

- Interactive tool-using assistant for short research questions.
- Persistent background workflows for strategy races, market reviews, and screens.
- OpenAI-compatible `/v1/chat/completions` interface.
- Optional ACP and A2A outputs for trusted local integrations.

## Architecture

```mermaid
flowchart LR
    User["Browser / API client"] --> Frontend["React frontend"]
    Frontend --> Backend["FastAPI backend"]
    Backend --> Agents["Tool-using and background agents"]
    Backend --> Backtest["Backtrader engine"]
    Backend --> Market["Market data and intelligence"]
    Backend --> Store["Local data under backend/data"]
    Backend --> Search["SearXNG"]
    Agents --> LLM["Configured LLM provider"]
```

The Docker setup binds all services to `127.0.0.1`:

| Service | Address |
| --- | --- |
| Frontend | `http://localhost:3000` |
| Backend | `http://localhost:8000` |
| SearXNG | `http://localhost:8080` |

## Local Data

TradingSpy stores runtime data locally:

```text
backend/data/
├── db.json
├── system_settings.json
├── market_data/local_user/
├── strategies/local_user/
├── results/local_user/
├── optimization_history/
└── temp_datas/
```

These files are ignored by Git. Back them up separately if the results matter to you.

## OpenAI-Compatible API

List the available adapter modes:

```bash
curl http://localhost:8000/v1/models
```

Send a streaming request:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "trading-ai-strands",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Is QQQ strong today? Use market context."}
    ]
  }'
```

`trading-ai-strands` is the recommended tool-using adapter. `trading-ai` and `trading-ai-manual` provide plain responses, while `trading-ai-agentic` remains for compatibility.

## Troubleshooting

### A service does not become healthy

```bash
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=200 frontend
docker compose logs --tail=200 searxng
```

### A port is already in use

TradingSpy needs local ports `3000`, `8000`, and `8080`. Stop the conflicting process or change the host-side port in `docker-compose.yml`.

### The assistant says no provider is configured

Add a key to `.env` and recreate the backend:

```bash
docker compose up -d --force-recreate backend
```

Alternatively, save the key from Settings in the application.

### The frontend opens but the API is unavailable

Check <http://localhost:8000/health>. For local development, make sure the backend terminal is still running and uses port `8000`.

### Docker runs out of disk space

Inspect usage before removing unused build cache:

```bash
docker system df
docker builder prune
```

## Development Checks

```bash
python3 -m py_compile backend/main.py backend/modules/*.py
npm run build --prefix frontend
docker compose config --quiet
```

The direct Python dependencies live in `backend/requirements.in`; `backend/requirements.txt` is the generated lock file used by Docker and local installs.

## Safety

- TradingSpy is experimental research software, not financial advice or a trading signal service.
- Backtests can overfit and do not predict future returns.
- Generated strategy Python is executed locally and is not sandboxed. Review it before running it.
- Keep all services bound to localhost unless you add authentication, TLS, network controls, and process isolation.
- Keep credentials out of Git and rotate any key that has ever been committed.

See [SECURITY.md](SECURITY.md) for the full security policy.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and use [SUPPORT.md](SUPPORT.md) when reporting a problem.

## License

TradingSpy is available under the [MIT License](LICENSE).
