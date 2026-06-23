# Contributing

Thanks for helping improve TradingSpy. This project is local-first trading research software, so contributions should preserve transparency, user control, and reproducible backtests.

## Good First Areas

- Improve agent progress visibility and failure reporting.
- Add focused backtest/strategy validation tests.
- Improve docs, screenshots, and demo workflows.
- Add LLM provider compatibility fixes.
- Improve market intelligence explanations and data freshness handling.

## Local Setup

```bash
cp .env.example .env
docker compose up -d --build
```

Open:

- App: http://localhost:3000
- Backend API: http://localhost:8000
- API docs: http://localhost:8000/docs

## Development Checks

Run the checks that match your change:

```bash
python3 -m py_compile backend/main.py backend/modules/simple_agent.py
cd frontend
npm run build
```

For strategy-agent changes, also run a real assistant workflow from the UI, for example:

```text
Generate until it beats buy and hold for QQQ. Use daily candles.
```

## Pull Request Expectations

- Keep changes scoped.
- Explain user-visible behavior changes.
- Include screenshots or short screen recordings for UI changes.
- Include before/after endpoint examples for API changes.
- Do not commit API keys, downloaded market data, local databases, build output, or generated cache files.

## Strategy And Backtest Safety

- Generated strategies must be validated before backtesting.
- Zero-trade strategies should be rejected as inactive, not presented as successful `0% ROI`.
- Runtime errors must surface to the user instead of leaving the agent stuck.
- Backtests are research outputs only. Do not present them as financial advice.

