# HN Submission Draft: TradingSpy

---

Title: I built TradingSpy: local, privacy-first AI trading assistant (open source)

URL: https://github.com/mrhustlex/TradingSpy-TradingAgentService

---

Show HN: I built TradingSpy — a local, privacy-first AI trading assistant

I built TradingSpy because I was tired of cloud-based trading tools that require accounts, charge subscriptions, and send my data somewhere I can't see.

TradingSpy is an open-source, Docker-based AI trading research workstation that runs entirely on your machine. It does four things:

1. **Market Intelligence** — real-time quotes, sector heatmaps, insider activity, news search, all in one query
2. **AI Strategy Generation** — describe a trading thesis in plain English, get a working Backtrader strategy
3. **Loop Engineering** — set a goal ("beat buy-and-hold for QQQ") and the agent iterates automatically until it finds a winning strategy
4. **Transparent Agent Runs** — every tool call, validation failure, and result is logged and visible

No cloud accounts. No telemetry. No broker connection. No paid tiers. It's free and open-source under the PolyForm Noncommercial License.

Supports 8+ LLM providers including Google AI Studio, Mistral, OpenRouter, Ollama (local), NVIDIA, AWS Bedrock, and Azure OpenAI.

Quick start:
```
git clone https://github.com/mrhustlex/TradingSpy-TradingAgentService.git
cd TradingSpy-TradingAgentService
cp .env.example .env
docker compose up -d --build
```

I'm looking for feedback on the loop engineering approach — especially from people who have tried similar agent-based strategy iteration. What would make this more useful for your workflow?

Tags: open-source, AI, trading, backtesting, local-first, Docker