# Support

TradingSpy is an open-source local research app. The fastest way to get help is to open a focused GitHub issue with enough context to reproduce the problem.

## Before Opening An Issue

- Pull the latest code.
- Rebuild containers with `docker compose up -d --build`.
- Check backend logs with `docker logs tradingai-service-backend-1 --tail 200`.
- Confirm which LLM provider and model you selected in Settings.
- Try a small known workflow such as `Generate until it beats buy and hold for QQQ. Use daily candles.`

## Useful Issue Details

- Operating system and Docker version.
- Browser and app URL.
- Backend error logs.
- Exact prompt or workflow.
- Ticker, interval, period, and strategy name.
- Whether the issue happens with a fresh thread.

## Security Issues

Please do not open public issues for vulnerabilities or credential leaks. Follow [SECURITY.md](SECURITY.md).

