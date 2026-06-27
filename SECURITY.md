# Security Policy

TradingSpy is a local-first research application. It is not designed to be exposed directly to the public internet.

## Supported Version

Security fixes are applied to the latest version on the `main` branch.

## Local-Only Default

The default Docker Compose configuration binds the frontend, backend, and SearXNG services to `127.0.0.1`. Keep those bindings unless you have added authentication, TLS, network controls, and appropriate process isolation.

## Generated Strategy Code

TradingSpy generates and executes Python strategy code. Generated code is not sandboxed and must be treated as untrusted. Review it before execution and run TradingSpy only in an environment you control. Generated code may be able to access environment variables, network resources, and writable container mounts.

## Sensitive Data

- Store API keys in a local `.env` file or a dedicated secret manager.
- Never commit `.env` files, `backend/data/`, generated strategies, downloaded market data, logs, or local databases.
- Rotate any credential that has ever been committed, even if it was later deleted.
- Set a strong remote-agent bearer token before enabling remote-agent outputs.

## Reporting a Vulnerability

Please use GitHub's private vulnerability-reporting feature or send the maintainer a private report. Do not disclose credential leaks or exploitable vulnerabilities in a public issue.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Please allow reasonable time for investigation before public disclosure.
