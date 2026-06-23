# Security Policy

TradingSpy is intended to run as a local-first research app.

## Local-only default

Do not expose the backend directly to the public internet. The default Docker Compose file binds services to `127.0.0.1`.

## Sensitive data

Keep API keys in local `.env` files or browser local settings. Do not commit `.env` files, `backend/data/`, generated strategies, downloaded market data, or debug output.

If you previously committed a real API key, rotate it before publishing.

## Generated strategy code

TradingSpy can generate and execute Python strategy code for backtesting. Treat generated strategies as untrusted code. Run the app only in a local environment you control.

## URL fetch tools

Article and website fetch helpers block local/private network targets by default to reduce local SSRF risk.

## Reporting issues

Open a private security advisory or contact the maintainer before publicly disclosing vulnerabilities.
