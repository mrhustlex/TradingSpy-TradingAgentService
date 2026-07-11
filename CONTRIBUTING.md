# Contributing

Thanks for helping improve TradingSpy.

## Getting Started

### Prerequisites

- Git
- Python 3.11 (3.13 is not currently supported)
- Node.js 22 and npm
- Docker Desktop or Docker Engine (optional, for SearXNG)

### Local Setup

For the simplest setup, use Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

The application runs at <http://localhost:3000>, with API documentation at <http://localhost:8000/docs>.

For local hot reload, follow the Python 3.11 and Node.js 22 instructions in [README.md](README.md#local-development-without-docker).

## Development Checks

Run these before submitting a pull request:

```bash
# Python syntax check
python3 -m py_compile backend/main.py backend/modules/*.py

# Frontend build
npm ci --prefix frontend
npm run build --prefix frontend

# Frontend lint
npm run lint --prefix frontend

# Docker config validation
docker compose config --quiet
```

The repository currently has legacy lint debt, so avoid introducing new warnings or errors in files you change.

## Project Structure

```text
tradingAI-service/
├── backend/
│   ├── main.py                    # FastAPI application and REST endpoints
│   ├── modules/
│   │   ├── market_intelligence.py # Market data, quotes, technicals, fundamentals
│   │   ├── downloader.py          # OHLCV candle download to local storage
│   │   ├── web_news_tools.py      # SearXNG, DuckDuckGo, arXiv search
│   │   ├── tool_calling_agent.py  # AI agent tools (market overview, heatmaps, etc.)
│   │   └── expected_pattern.py    # Probabilistic price pattern forecasts
│   ├── data/                      # Runtime data (gitignored)
│   └── requirements.txt           # Python dependencies (lock file)
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── SectorHeatmap.jsx      # Market Overview heatmap
│       │   ├── IndustryMovements.jsx  # Stock price movements
│       │   ├── MarketIntelligence.jsx # Watchlist and ticker details
│       │   ├── MarketDataHub.jsx      # Data download management
│       │   └── Settings.jsx           # Provider configuration
│       └── App.jsx                # Main app with sidebar navigation
├── searxng/                       # SearXNG Docker configuration
├── .env.example                   # Environment variable template
└── docker-compose.yml             # Docker services (frontend, backend, SearXNG)
```

## Pull Requests

### What we look for

- **Focused changes** — One logical change per PR. Separate unrelated fixes.
- **Clear description** — Explain what changed, why it changed, and how to test it.
- **Screenshots** for visual changes and request/response examples for API changes.
- **No credential leaks** — Never commit API keys, tokens, or local databases.
- **Respect the local-first model** — Generated strategy code is untrusted. Keep all services bound to localhost.

### Commit messages

Use clear, descriptive commit messages:

- `fix: resolve heatmap loading for empty watchlist`
- `feat: add candlestick pattern scanning tab`
- `docs: clarify Ollama setup in README`

### Code style

**Backend (Python):**
- Follow existing patterns in `backend/modules/`.
- Keep imports at the top of the file.
- Use type hints where existing code uses them.

**Frontend (React/JSX):**
- Match the component structure in `frontend/src/components/`.
- Use the existing utility functions and config from `config.js`.
- Run `npm run lint --prefix frontend` before committing.

## Ways to Contribute

- **Bug reports** — Open an issue with steps to reproduce, expected vs. actual behavior, and your environment.
- **Feature requests** — Describe the use case and the problem it solves, not just the implementation.
- **Code** — Pick an open issue or start a discussion for large changes.
- **Documentation** — Fix typos, clarify explanations, or add examples.
- **Testing** — Try edge cases, different LLM providers, or non-US markets and report what breaks.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
