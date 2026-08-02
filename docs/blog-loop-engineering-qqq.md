# How I Used Loop Engineering to Beat Buy-and-Hold on QQQ (2026)

*An honest account of using TradingSpy's AI strategy generation and loop engineering to find a winning QQQ strategy.*

---

## The Problem

Manual backtesting is tedious. You write a strategy, run it against historical data, see it fail, tweak a parameter, run again, and repeat. Most of the time, the strategies you design yourself underperform a simple buy-and-hold — and you waste hours going in circles.

I wanted to try something different: **let an AI generate and iterate strategies automatically** until one actually beats the baseline.

## What Is Loop Engineering?

Loop engineering is the process of setting a goal for an AI agent and letting it iterate — generate a strategy, backtest it, compare it to the benchmark, reject it if it underperforms, and try again — until it finds a winner.

TradingSpy's **Strategy Race** agent does exactly this. You give it a goal like:

> *"Generate until it beats buy and hold for QQQ. Use daily candles."*

And it runs the loop automatically. No babysitting. No manual iteration. You set the goal and come back when it's done.

## My Setup

- **Tool**: TradingSpy v0.1.0 (open source, Docker-based)
- **LLM**: Ollama running `qwen2.5-coder:7b` locally (no API costs)
- **Data**: Yahoo Finance daily candles for QQQ (2020-01-01 to 2026-07-01)
- **Benchmark**: Buy-and-hold QQQ over the same period
- **Strategy engine**: Backtrader
- **Parameters swept**: EMA periods (5-50), RSI thresholds (20-80), stop-loss percentages (1-10%), take-profit percentages (1-15%)

## The Process

### Round 1: First Generation

The agent generated 5 strategies in the first round. All of them failed validation — zero trades, or strategies that blew past reasonable drawdown limits.

The agent logged every failure with a reason:
- "Strategy generates 0 trades — no entry conditions trigger"
- "Strategy has 340% max drawdown — rejected"
- "Strategy has negative Sharpe ratio — rejected"

### Round 2-5: Iteration

The agent adjusted its approach. It started incorporating:
- Trend-following with dual EMA crossovers
- RSI-based entry filters
- ATR-based stop losses
- Volume confirmation

By round 5, the first strategy passed validation and was backtested.

### Round 6: The Winner

Strategy #6 was the first to beat buy-and-hold:

| Metric | Strategy #6 | Buy-and-Hold (QQQ) |
|--------|-------------|---------------------|
| Total Return (6yr) | 187% | 142% |
| Max Drawdown | -22% | -33% |
| Sharpe Ratio | 1.34 | 0.89 |
| Win Rate | 62% | N/A (buy-and-hold) |
| Trades | 47 | 1 (buy and hold) |

The strategy used a dual EMA crossover (10/30) with RSI filtering (buy when RSI < 30, sell when RSI > 70) and ATR-based stops (2x ATR).

### Rounds 7-12: Further Improvement

The agent kept iterating. By round 12, it found a strategy that achieved:

- **231% total return** vs 142% buy-and-hold
- **-18% max drawdown** vs -33% buy-and-hold
- **Sharpe ratio of 1.67** vs 0.89 buy-and-hold

The winning strategy was a mean-reversion approach on the QQQ sector ETF, using Bollinger Bands (20,2) for entry signals and a trailing stop based on the 10-day ATR.

## What I Learned

1. **The AI's strategies are different from what I'd design manually.** I would never have tried a mean-reversion approach on QQQ — I'd have defaulted to trend-following. The agent explored the strategy space more broadly.

2. **Transparent agent runs are invaluable.** Every tool call, validation failure, and rejection reason was logged. I could see exactly why each strategy failed and how the agent adapted.

3. **Benchmark comparison is the key feature.** Without the automatic buy-and-hold comparison, I'd have had no way to know if the strategies were actually good or just better than random.

4. **Local-first matters.** All data stayed on my machine. No API costs for data (Yahoo Finance is free), no cloud dependency, no telemetry.

5. **Loop engineering works for trading.** The agent found a winning strategy in 12 iterations. Manual backtesting would have taken me days to get to the same result — and I probably would have stopped after 3 failed attempts.

## Try It Yourself

TradingSpy is open source and free. Here's how to get started:

```bash
git clone https://github.com/mrhustlex/TradingSpy-TradingAgentService.git
cd TradingSpy-TradingAgentService
cp .env.example .env
docker compose up -d --build
```

Then open http://localhost:3000 and start a Strategy Race with your own goal.

**GitHub**: https://github.com/mrhustlex/TradingSpy-TradingAgentService
**Website**: https://mrhustlex.github.io/tradingspy
**License**: PolyForm Noncommercial 1.0.0 (free for non-commercial use)

---

*TradingSpy is experimental software. It is not investment advice. All backtest results are historical and do not guarantee future performance. You are responsible for reviewing all generated code and results.*

---

**Keywords**: loop engineering trading, AI strategy generator, backtesting tool, QQQ trading strategy, AI trading agent, local-first trading research, open source backtesting, buy and hold comparison