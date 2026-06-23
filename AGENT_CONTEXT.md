# TradingSpy Agent Context Guide

This document provides comprehensive context for AI agents working with TradingSpy, including file naming conventions, API parameters, and workflow patterns.

## 📁 Market Data File Naming Convention

### Format
```
{ticker}-{interval}-{period}.txt
```

### Examples
- `qqq-1d-2y.txt` - QQQ daily data for 2 years
- `aapl-1h-1mo.txt` - AAPL hourly data for 1 month
- `spy-5m-60d.txt` - SPY 5-minute data for 60 days
- `tsla-1d-max.txt` - TSLA daily data for maximum available period

### Components
- **ticker**: Stock symbol in lowercase (e.g., `qqq`, `aapl`, `spy`)
- **interval**: Data granularity
  - `1m` - 1 minute
  - `5m` - 5 minutes
  - `15m` - 15 minutes
  - `30m` - 30 minutes
  - `1h` - 1 hour
  - `1d` - 1 day (daily)
  - `1wk` - 1 week
  - `1mo` - 1 month
- **period**: Historical timeframe
  - `1d` - 1 day
  - `5d` - 5 days
  - `1mo` - 1 month
  - `3mo` - 3 months
  - `6mo` - 6 months
  - `1y` - 1 year
  - `2y` - 2 years
  - `5y` - 5 years
  - `10y` - 10 years
  - `60d` - 60 days (for intraday data)
  - `max` - Maximum available history

### File Location
- **Backend**: `backend/data/market_data/local_user/`
- **Format**: CSV with columns: `Date,Open,High,Low,Close,Volume,OpenInterest`

---

## 🔌 API Endpoints & Parameters

### 1. Download Market Data

**Endpoint**: `POST /api/market-data/download`

**Request Body**:
```json
{
  "tickers": ["AAPL", "MSFT"],
  "interval": "1d",
  "period": "5y",
  "suite": false
}
```

**Parameters**:
- `tickers` (required): Array of stock symbols (uppercase)
- `interval` (optional): Data granularity (default: `"1d"`)
  - Options: `"1m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"1d"`, `"1wk"`, `"1mo"`
- `period` (optional): Historical timeframe (default: `"5y"`)
  - Options: `"1d"`, `"5d"`, `"1mo"`, `"3mo"`, `"6mo"`, `"1y"`, `"2y"`, `"5y"`, `"10y"`, `"max"`
- `suite` (optional): Download multiple interval/period combinations (default: `false`)
  - When `true`, downloads: `1m/5d`, `5m/60d`, `1h/2y`, `1d/max`

**Response**:
```json
{
  "task_id": "uuid-string",
  "message": "Download started"
}
```

**Notes**:
- Downloads are asynchronous (background task)
- Tickers are automatically added to watchlist
- Check status with `/api/market-data/task/{task_id}`
- Files are saved as `{ticker}-{interval}-{period}.txt`

---

### 2. List Downloaded Files

**Endpoint**: `GET /api/market-data/files`

**Response**:
```json
{
  "files": [
    "aapl-1d-5y.txt",
    "msft-1h-2y.txt",
    "qqq-1d-2y.txt"
  ]
}
```

---

### 3. Run Backtest

**Endpoint**: `POST /api/backtest/backtest`

**Request Body**:
```json
{
  "dataset_filename": "qqq-1d-2y.txt",
  "strategies": ["SMA_Crossover", "BuyAndHold"],
  "stake_range": [95, 100],
  "trail_range": [0.0, 0.05],
  "start_date": "2023-01-01",
  "end_date": "2024-12-31",
  "sequential": false
}
```

**Parameters**:
- `dataset_filename` (required): Exact filename from market data directory
- `strategies` (required): Array of strategy names
- `stake_range` (optional): Percentage of capital to use `[min, max]`
- `trail_range` (optional): Trailing stop loss range `[min, max]`
- `start_date` (optional): Backtest start date (YYYY-MM-DD)
- `end_date` (optional): Backtest end date (YYYY-MM-DD)
- `sequential` (optional): Run strategies sequentially vs parallel (default: `false`)

**Response**:
```json
{
  "task_id": "uuid-string"
}
```

**Notes**:
- Backtests run asynchronously
- Check results with `/api/backtest/results/{task_id}`
- Results include ROI, Sharpe ratio, max drawdown, win rate, etc.

---

### 4. List Available Strategies

**Endpoint**: `GET /api/backtest/strategies`

**Response**:
```json
{
  "strategies": [
    {"name": "BuyAndHold", "is_custom": false},
    {"name": "SMA_Crossover", "is_custom": false},
    {"name": "RSI_Strategy", "is_custom": false},
    {"name": "My_Custom_Strategy", "is_custom": true}
  ]
}
```

**Built-in Strategies**:
- `BuyAndHold` - Simple buy and hold
- `SMA_Crossover` - Simple moving average crossover
- `EMA_Crossover` - Exponential moving average crossover
- `RSI_Strategy` - RSI-based strategy
- `MACD_Strategy` - MACD-based strategy
- `Bollinger_Bands` - Bollinger bands strategy

---

### 5. Check Task Status

**Endpoint**: `GET /api/market-data/task/{task_id}`

**Response**:
```json
{
  "status": "completed",
  "progress": 100,
  "current": "Download complete",
  "results": {
    "tickers": ["AAPL"],
    "files_downloaded": 1,
    "filenames": ["aapl-1d-5y.txt"]
  }
}
```

**Status Values**:
- `"running"` - Task in progress
- `"completed"` - Task finished successfully
- `"failed"` - Task encountered an error

---

### 6. Get Backtest Results

**Endpoint**: `GET /api/backtest/results/{task_id}`

**Response**:
```json
{
  "status": "completed",
  "results": [
    {
      "strategy": "SMA_Crossover",
      "roi": 45.2,
      "sharpe_ratio": 1.8,
      "max_drawdown": -12.5,
      "win_rate": 0.62,
      "total_trades": 42,
      "winning_trades": 26,
      "losing_trades": 16
    }
  ]
}
```

---

## 🤖 Agent Workflow Patterns

### Pattern 1: Download and Backtest
```
1. Download data: POST /api/market-data/download
   → Get task_id
2. Poll status: GET /api/market-data/task/{task_id}
   → Wait for "completed"
3. Get filenames from results.filenames
4. Run backtest: POST /api/backtest/backtest
   → Use exact filename from step 3
5. Get results: GET /api/backtest/results/{task_id}
```

### Pattern 2: Compare Strategies
```
1. List available files: GET /api/market-data/files
2. List strategies: GET /api/backtest/strategies
3. Run backtest with multiple strategies
4. Compare results
```

### Pattern 3: Historical Analysis
```
1. Download with suite=true for multiple timeframes
2. Run same strategy on different timeframes
3. Compare performance across timeframes
```

---

## 💡 Agent Tips

### File Name Resolution
- **Always use exact filenames** from `/api/market-data/files` or download task results
- Don't construct filenames manually - they may not exist
- If user says "2 years of QQQ", download first, then use returned filename

### Common Mistakes to Avoid
❌ Using `recent_2_years_data.txt` (doesn't exist)
✅ Using `qqq-1d-2y.txt` (actual format)

❌ Assuming file exists without checking
✅ List files first or check download task results

❌ Using uppercase ticker in filename
✅ Filenames use lowercase: `aapl` not `AAPL`

### Best Practices
1. **Always verify file existence** before backtesting
2. **Use suite downloads** for comprehensive analysis
3. **Check task status** before proceeding to next step
4. **Parse results.filenames** from download tasks
5. **Handle async operations** properly (poll status)

---

## 📊 Data Quality Notes

### Intraday Data Limitations
- `1m` data: Limited to last 7 days (use period `"5d"` or `"7d"`)
- `5m` data: Limited to last 60 days (use period `"60d"`)
- `1h` data: Available for ~2 years (use period `"2y"`)
- `1d` data: Available for maximum history (use period `"max"`)

### Recommended Combinations
- **Day trading**: `1m/5d` or `5m/60d`
- **Swing trading**: `1h/2y` or `1d/1y`
- **Long-term**: `1d/5y` or `1d/max`

---

## 🔍 Example Agent Conversations

### Example 1: User asks for buy-and-hold on 2 years
```
User: "Run buy and hold on 2 years of QQQ"

Agent Actions:
1. POST /api/market-data/download
   Body: {"tickers": ["QQQ"], "interval": "1d", "period": "2y"}
2. Wait for completion, get filename: "qqq-1d-2y.txt"
3. POST /api/backtest/backtest
   Body: {"dataset_filename": "qqq-1d-2y.txt", "strategies": ["BuyAndHold"]}
4. Return results
```

### Example 2: User wants to compare strategies
```
User: "Compare SMA and EMA strategies on AAPL"

Agent Actions:
1. Check if AAPL data exists: GET /api/market-data/files
2. If not, download: POST /api/market-data/download
3. POST /api/backtest/backtest
   Body: {
     "dataset_filename": "aapl-1d-5y.txt",
     "strategies": ["SMA_Crossover", "EMA_Crossover"]
   }
4. Compare and present results
```

---

## 🎯 Quick Reference

| Task | Endpoint | Key Parameters |
|------|----------|----------------|
| Download data | `POST /api/market-data/download` | `tickers`, `interval`, `period` |
| List files | `GET /api/market-data/files` | None |
| Run backtest | `POST /api/backtest/backtest` | `dataset_filename`, `strategies` |
| Check status | `GET /api/market-data/task/{task_id}` | None |
| Get results | `GET /api/backtest/results/{task_id}` | None |
| List strategies | `GET /api/backtest/strategies` | None |

---

**Last Updated**: 2026-04-22
