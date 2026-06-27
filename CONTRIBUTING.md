# Contributing

Thanks for helping improve TradingSpy.

## Local Setup

For the simplest setup, use Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

The application runs at <http://localhost:3000>, with API documentation at <http://localhost:8000/docs>.

For local hot reload, follow the Python 3.11 and Node.js 22 instructions in [README.md](README.md#local-development-without-docker).

## Development Checks

```bash
python3 -m py_compile backend/main.py backend/modules/*.py
npm ci --prefix frontend
npm run build --prefix frontend
docker compose config --quiet
```

Run `npm run lint --prefix frontend` as well. The repository currently has legacy lint debt, so avoid introducing new warnings or errors in files you change.

## Pull Requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests where practical.
- Include screenshots for visual changes and request/response examples for API changes.
- Never commit credentials, local databases, downloaded market data, generated strategies, caches, or build output.
- Treat generated strategy code as untrusted and preserve the local-only security model.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
