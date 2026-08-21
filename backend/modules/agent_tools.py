"""
Agent Tools — deterministic TradingSpy functions exposed to external agents.

Single source of truth for the tool registry shared by three surfaces:
  - MCP server        POST /mcp                        (opencode & any MCP client)
  - OpenAI manifest   GET  /api/tools/manifest          (Hermes-style function calling)
  - Generic invoke    POST /api/tools/invoke            ({name, arguments})

Tools are read-only or compute-only: no deletes, no resets, no LLM calls.
The remote agent brings its own brain; TradingSpy is the hands.

Heavy imports from main are done lazily inside handlers to avoid circular
imports (same pattern as acp_agent.py).
"""

import asyncio
import inspect
import json
import logging
import math
import os
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# How long compute tools (backtest, screen) may block before returning a
# task_id the caller can poll via get_task. The work keeps running.
TOOL_BLOCK_SECONDS = float(os.getenv("AGENT_TOOL_BLOCK_SECONDS", "120"))


class ImageResult:
    """Returned by image-producing tools; the router serializes it as an MCP
    image content block (and as base64 JSON for the invoke/manifest surfaces)."""

    def __init__(self, data: bytes, mime_type: str = "image/png"):
        self.data = data
        self.mime_type = mime_type


# ---------------------------------------------------------------------------
# JSON safety
# ---------------------------------------------------------------------------

def json_safe(value: Any) -> Any:
    """Recursively convert a result into strictly JSON-serializable data."""
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    item = getattr(value, "item", None)  # numpy scalars
    if callable(item):
        try:
            return json_safe(item())
        except Exception:
            pass
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        try:
            return iso()
        except Exception:
            pass
    return str(value)


# ---------------------------------------------------------------------------
# Handlers (lazy imports keep module import cheap and circular-safe)
# ---------------------------------------------------------------------------

async def _list_datasets() -> dict:
    from main import LOCAL_USER_ID, get_user_dirs

    _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
    files = sorted(f for f in os.listdir(user_dir) if f.endswith((".txt", ".csv")))
    return {"files": files, "count": len(files)}


async def _check_data(ticker: str) -> dict:
    from main import LOCAL_USER_ID, get_user_dirs

    ticker = str(ticker).strip().upper()
    _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
    files = sorted(
        f for f in os.listdir(user_dir)
        if f.upper().startswith(ticker + "-") and f.endswith((".txt", ".csv"))
    )
    return {"ticker": ticker, "available": len(files) > 0, "files": files}


async def _download_data(ticker: str, interval: str = "1d", period: str = "max") -> dict:
    from main import LOCAL_USER_ID, get_user_dirs
    from downloader import download_ticker_data

    ticker = str(ticker).strip().upper()
    if not ticker:
        raise ValueError("ticker is required")
    _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
    dest = await asyncio.to_thread(
        download_ticker_data, ticker, interval=interval, period=period, output_dir=user_dir
    )
    if not dest:
        return {"ticker": ticker, "interval": interval, "period": period, "status": "no data returned"}
    return {
        "ticker": ticker,
        "interval": interval,
        "period": period,
        "file": os.path.basename(dest),
        "status": "downloaded",
    }


async def _get_quote(ticker: str) -> dict:
    from market_intelligence import market_intel

    return market_intel.get_ticker_quote(str(ticker).strip().upper())


async def _batch_quotes(tickers: List[str]) -> dict:
    from market_intelligence import market_intel

    clean = [str(t).strip().upper() for t in (tickers or []) if str(t).strip()]
    if not clean:
        raise ValueError("tickers must contain at least one symbol")
    return {"quotes": market_intel.get_batch_quotes(clean[:50])}


async def _ticker_info(ticker: str) -> dict:
    from market_intelligence import market_intel

    return market_intel.get_ticker_info(str(ticker).strip().upper())


async def _get_news(ticker: str, limit: int = 10) -> dict:
    from market_intelligence import market_intel

    items = await asyncio.to_thread(
        market_intel.get_ticker_news, str(ticker).strip().upper(), max(1, min(int(limit), 50))
    )
    return {"ticker": ticker.upper(), "news": items}


async def _get_technicals(ticker: str, period: str = "3mo") -> dict:
    from market_intelligence import market_intel

    return market_intel.get_ticker_technicals(str(ticker).strip().upper(), period)


async def _get_earnings(ticker: str) -> dict:
    from market_intelligence import market_intel

    return market_intel.get_earnings_calendar(str(ticker).strip().upper())


async def _get_analyst_recommendations(ticker: str) -> dict:
    from market_intelligence import market_intel

    return market_intel.get_analyst_recommendations(str(ticker).strip().upper())


async def _get_insider_trades(tickers: List[str], limit: int = 50, days_back: int = 365) -> dict:
    from market_intelligence import market_intel

    clean = [str(t).strip().upper() for t in (tickers or []) if str(t).strip()]
    if not clean:
        raise ValueError("tickers must contain at least one symbol")
    return market_intel.get_insider_transactions(
        clean[:20], max(1, min(int(limit), 200)), 0, max(1, min(int(days_back), 1095))
    )


async def _get_market_movers(period: str = "1d") -> dict:
    from market_intelligence import market_intel

    return market_intel.get_market_movers(period, None)


async def _etf_holdings(etf_tickers: List[str], period: str = "1d", interval: Optional[str] = None, extended: bool = False) -> dict:
    from main import etf_holdings as _etf

    clean = [str(t).strip().upper() for t in (etf_tickers or []) if str(t).strip()]
    if not clean:
        raise ValueError("etf_tickers must contain at least one ETF symbol")
    return await _etf(clean[:10], period, interval, extended)


async def _peers(ticker: str, limit: int = 5) -> dict:
    from main import ticker_peers

    return await ticker_peers(str(ticker).strip().upper(), max(1, min(int(limit), 20)))


async def _expected_pattern(
    ticker: str,
    interval: str = "1d",
    horizon: int = 20,
    lookback: int = 180,
    extended_hours: bool = False,
) -> dict:
    from main import get_expected_pattern

    return await get_expected_pattern(
        str(ticker).strip().upper(), interval, int(horizon), int(lookback), bool(extended_hours)
    )


async def _chart(ticker: str, period: str = "1mo", interval: str = "1d") -> dict:
    from main import get_chart_data

    return await get_chart_data(str(ticker).strip().upper(), period, interval)


async def _industry_heatmap(
    tickers: Optional[List[str]] = None,
    period: str = "1d",
    interval: Optional[str] = None,
    extended: bool = False,
) -> dict:
    from main import industry_heatmap

    return await industry_heatmap(tickers, period, interval, extended)


async def _sector_heatmap(
    tickers: Optional[List[str]] = None,
    period: str = "1d",
    interval: Optional[str] = None,
    extended: bool = False,
) -> dict:
    from main import sector_heatmap

    return await sector_heatmap(tickers or [], period, interval, extended)


async def _trading_signal(tickers: List[str], period: str = "3mo", interval: str = "1d") -> dict:
    from main import TradingSignalRequest, trading_signal

    clean = [str(t).strip().upper() for t in (tickers or []) if str(t).strip()]
    if not clean:
        raise ValueError("tickers must contain at least one symbol")
    return await trading_signal(TradingSignalRequest(tickers=clean[:50], period=period, interval=interval))


async def _pattern_scan(
    universe: Optional[str] = None,
    tickers: Optional[List[str]] = None,
    interval: str = "1d",
    patterns: Optional[List[str]] = None,
    min_score: float = 55.0,
    max_results: int = 25,
    period: Optional[str] = None,
) -> dict:
    """Scan a universe for technical chart patterns. Long-running: blocks briefly, then returns a task_id to poll."""
    from main import (
        PatternScanRequest,
        _run_pattern_scan_task,
        init_task_state,
        results_store,
    )

    request = PatternScanRequest(
        universe=universe,
        tickers=tickers,
        interval=interval,
        patterns=patterns or ["vcp", "cup_handle", "bull_flag"],
        min_score=min_score,
        max_results=max_results,
        period=period,
    )
    task_id = f"SCAN_{uuid.uuid4().hex[:10].upper()}"
    init_task_state(task_id, {"status": "running", "progress": 0, "current": "Queued"})
    task = asyncio.create_task(_run_pattern_scan_task(task_id, request))
    done, _ = await asyncio.wait({task}, timeout=TOOL_BLOCK_SECONDS)
    state = {k: v for k, v in results_store.get(task_id, {}).items() if k != "events"}
    if not done:
        return {
            "task_id": task_id,
            "status": "running",
            "message": f"Pattern scan still running after {int(TOOL_BLOCK_SECONDS)}s; poll get_task(task_id).",
            "snapshot": json_safe(state),
        }
    return {"task_id": task_id, **json_safe(state)}


async def _render_chart_image(
    ticker: str,
    kind: str = "candles",
    interval: str = "1d",
    period: str = "6mo",
    horizon: int = 20,
    lookback: int = 180,
    patterns: Optional[List[str]] = None,
) -> ImageResult:
    """Render a branded TradingSpy PNG image for a ticker.

    kind:
      - "candles": OHLCV candle chart.
      - "expected_pattern": probabilistic forecast path with 80% band.
      - "pattern_detection": candles with detected-pattern markers.
    Returns image bytes stamped with the "Generated by TradingSpy" footer.
    """
    from chart_renderer import render_png

    symbol = str(ticker).strip().upper()
    if not symbol:
        raise ValueError("ticker is required")
    data = await asyncio.to_thread(
        render_png,
        symbol,
        kind,
        interval=interval,
        period=period,
        horizon=horizon,
        lookback=lookback,
        patterns=patterns,
    )
    return ImageResult(data, "image/png")


async def _screen_fundamentals(
    requirements: str,
    universe: str = "default",
    max_results: int = 5,
    max_checked: int = 30,
) -> dict:
    """Run the fundamental screener. Blocks up to TOOL_BLOCK_SECONDS, then returns a task_id."""
    from main import FundamentalScreenRequest, _run_fundamental_screen_task, init_task_state, results_store

    request = FundamentalScreenRequest(
        universe=universe,
        requirements=requirements,
        max_results=max(1, min(int(max_results), 10)),
        max_checked=max(1, min(int(max_checked), 80)),
    )
    task_id = f"SCREEN_{uuid.uuid4().hex[:10].upper()}"
    init_task_state(task_id, {"status": "running", "progress": 0, "current": "Queued"})
    task = asyncio.create_task(_run_fundamental_screen_task(task_id, request))
    done, _ = await asyncio.wait({task}, timeout=TOOL_BLOCK_SECONDS)
    state = {k: v for k, v in results_store.get(task_id, {}).items() if k not in ("events",)}
    if not done:
        return {
            "task_id": task_id,
            "status": "running",
            "message": f"Screen still running after {int(TOOL_BLOCK_SECONDS)}s; poll get_task(task_id).",
            "snapshot": json_safe(state),
        }
    return {"task_id": task_id, **json_safe(state)}


async def _run_backtest(
    dataset_filename: str,
    strategies: List[str],
    stake_range: Optional[List[int]] = None,
    trail_range: Optional[List[float]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    initial_cash: float = 100000.0,
    commission: float = 0.001,
) -> dict:
    """Run backtests. Blocks up to TOOL_BLOCK_SECONDS, then returns a task_id."""
    from main import (
        LOCAL_USER_ID,
        init_task_state,
        results_store,
        run_backtests_task,
    )

    if not dataset_filename:
        raise ValueError("dataset_filename is required")
    clean_strategies = [str(s) for s in (strategies or []) if str(s)]
    if not clean_strategies:
        raise ValueError("strategies must contain at least one strategy name")
    task_id = str(uuid.uuid4())
    init_task_state(task_id, {"status": "running", "progress": 0, "partial_results": []})
    task = asyncio.create_task(run_backtests_task(
        task_id, dataset_filename, clean_strategies, stake_range, trail_range,
        start_date, end_date, False, LOCAL_USER_ID, initial_cash, commission, 4,
    ))
    done, _ = await asyncio.wait({task}, timeout=TOOL_BLOCK_SECONDS)
    state = {k: v for k, v in results_store.get(task_id, {}).items() if k != "events"}
    if not done:
        return {
            "task_id": task_id,
            "status": "running",
            "message": f"Backtest still running after {int(TOOL_BLOCK_SECONDS)}s; poll get_task(task_id).",
            "snapshot": json_safe(state),
        }
    return {"task_id": task_id, **json_safe(state)}


async def _get_task(task_id: str) -> dict:
    from main import results_store

    state = results_store.get(str(task_id))
    if state is None:
        raise ValueError(f"Unknown task_id '{task_id}'")
    return {"task_id": task_id, **json_safe({k: v for k, v in state.items() if k != "events"})}


async def _list_strategies() -> dict:
    from main import LOCAL_USER_ID, STRATEGY_CATEGORIES, STRATEGY_MAP, strategies_table
    from tinydb import Query

    strats = [
        {"name": n, "is_custom": False, "category": STRATEGY_CATEGORIES.get(n, "General")}
        for n in STRATEGY_MAP.keys()
    ]
    for doc in strategies_table.search(Query().user_id == LOCAL_USER_ID):
        strats.append({
            "name": doc["name"],
            "is_custom": True,
            "category": doc.get("category", "General"),
            "ticker": doc.get("ticker", ""),
        })
    return {"strategies": strats}


async def _get_strategy(name: str) -> dict:
    from main import LOCAL_USER_ID, STRATEGY_BOILERPLATE, STRATEGY_CATEGORIES, STRATEGY_MAP, strategies_table
    from tinydb import Query

    name = str(name)
    if name in STRATEGY_MAP:
        strat_class = STRATEGY_MAP[name]
        try:
            code = inspect.getsource(strat_class)
        except Exception:
            code = STRATEGY_BOILERPLATE + "\n# Built-in strategy source unavailable"
        return {
            "name": name,
            "is_custom": False,
            "code": code,
            "class_name": strat_class.__name__,
            "category": STRATEGY_CATEGORIES.get(name, "General"),
        }
    doc = strategies_table.get((Query().name == name) & (Query().user_id == LOCAL_USER_ID))
    if doc:
        return {
            "name": doc["name"],
            "is_custom": True,
            "code": doc["code"],
            "class_name": doc["class_name"],
            "category": doc.get("category", "General"),
        }
    raise ValueError(f"Strategy '{name}' not found")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_INTERVALS = ["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo"]
_PERIODS = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "list_datasets",
        "description": "List locally available market-data dataset files (OHLCV, format TICKER-interval-period.txt/csv).",
        "kind": "read",
        "schema": {"type": "object", "properties": {}, "required": []},
        "handler": _list_datasets,
    },
    {
        "name": "check_data",
        "description": "Check whether local market data exists for a ticker and list matching files.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"ticker": {"type": "string", "description": "Ticker symbol, e.g. SPY"}},
            "required": ["ticker"],
        },
        "handler": _check_data,
    },
    {
        "name": "download_data",
        "description": "Download historical OHLCV market data for a ticker into the local dataset store.",
        "kind": "compute",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "interval": {"type": "string", "enum": _INTERVALS, "default": "1d"},
                "period": {"type": "string", "enum": _PERIODS, "default": "max"},
            },
            "required": ["ticker"],
        },
        "handler": _download_data,
    },
    {
        "name": "get_quote",
        "description": "Latest quote snapshot for a ticker: price, change, day range, volume.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"],
        },
        "handler": _get_quote,
    },
    {
        "name": "batch_quotes",
        "description": "Latest quotes for up to 50 tickers in one call.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"tickers": {"type": "array", "items": {"type": "string"}}},
            "required": ["tickers"],
        },
        "handler": _batch_quotes,
    },
    {
        "name": "ticker_info",
        "description": "Company/profile info for a ticker: name, sector, industry, market cap, summary.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"],
        },
        "handler": _ticker_info,
    },
    {
        "name": "get_news",
        "description": "Recent news articles for a ticker.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["ticker"],
        },
        "handler": _get_news,
    },
    {
        "name": "get_technicals",
        "description": "Technical indicator snapshot for a ticker (RSI, MACD, moving averages, levels).",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "period": {"type": "string", "enum": _PERIODS, "default": "3mo"},
            },
            "required": ["ticker"],
        },
        "handler": _get_technicals,
    },
    {
        "name": "get_earnings",
        "description": "Earnings calendar data for a ticker.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"],
        },
        "handler": _get_earnings,
    },
    {
        "name": "get_analyst_recommendations",
        "description": "Analyst recommendations and price targets for a ticker.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"],
        },
        "handler": _get_analyst_recommendations,
    },
    {
        "name": "get_insider_trades",
        "description": "Recent insider trading activity for one or more tickers.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "tickers": {"type": "array", "items": {"type": "string"}},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                "days_back": {"type": "integer", "minimum": 1, "maximum": 1095, "default": 365},
            },
            "required": ["tickers"],
        },
        "handler": _get_insider_trades,
    },
    {
        "name": "get_market_movers",
        "description": "Market overview: top gainers, losers, most active.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"period": {"type": "string", "default": "1d"}},
        },
        "handler": _get_market_movers,
    },
    {
        "name": "screen_fundamentals",
        "description": "Run the fundamental screener over a universe with natural-language requirements (e.g. 'undervalued with positive growth'). Long-running: blocks briefly, then returns a task_id to poll.",
        "kind": "compute",
        "schema": {
            "type": "object",
            "properties": {
                "requirements": {"type": "string", "description": "Natural-language screening requirements"},
                "universe": {"type": "string", "default": "default"},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
                "max_checked": {"type": "integer", "minimum": 1, "maximum": 80, "default": 30},
            },
            "required": ["requirements"],
        },
        "handler": _screen_fundamentals,
    },
    {
        "name": "list_strategies",
        "description": "List built-in and custom trading strategies available for backtesting.",
        "kind": "read",
        "schema": {"type": "object", "properties": {}, "required": []},
        "handler": _list_strategies,
    },
    {
        "name": "get_strategy",
        "description": "Get a strategy's source code and metadata by name.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
        "handler": _get_strategy,
    },
    {
        "name": "run_backtest",
        "description": "Backtest strategies against a local dataset. Long-running: blocks briefly, then returns a task_id to poll.",
        "kind": "compute",
        "schema": {
            "type": "object",
            "properties": {
                "dataset_filename": {"type": "string", "description": "Dataset file from list_datasets, e.g. spy-1d-max.txt"},
                "strategies": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "stake_range": {"type": "array", "items": {"type": "integer"}},
                "trail_range": {"type": "array", "items": {"type": "number"}},
                "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "YYYY-MM-DD"},
                "initial_cash": {"type": "number", "default": 100000.0},
                "commission": {"type": "number", "default": 0.001},
            },
            "required": ["dataset_filename", "strategies"],
        },
        "handler": _run_backtest,
    },
    {
        "name": "get_task",
        "description": "Poll the status/result of an async task started by run_backtest or screen_fundamentals.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
            "required": ["task_id"],
        },
        "handler": _get_task,
    },
    {
        "name": "etf_holdings",
        "description": "Top holdings and per-stock performance for one or more ETFs.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "etf_tickers": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "period": {"type": "string", "default": "1d"},
                "interval": {"type": "string"},
                "extended": {"type": "boolean", "default": False},
            },
            "required": ["etf_tickers"],
        },
        "handler": _etf_holdings,
    },
    {
        "name": "peers",
        "description": "Comparable tickers (same sector/industry) for a given ticker.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
            },
            "required": ["ticker"],
        },
        "handler": _peers,
    },
    {
        "name": "expected_pattern",
        "description": "Probabilistic expected-price-path / range projection for a ticker.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "interval": {"type": "string", "enum": _INTERVALS, "default": "1d"},
                "horizon": {"type": "integer", "default": 20},
                "lookback": {"type": "integer", "default": 180},
                "extended_hours": {"type": "boolean", "default": False},
            },
            "required": ["ticker"],
        },
        "handler": _expected_pattern,
    },
    {
        "name": "chart",
        "description": "OHLCV candle data for a ticker over a period/interval (same data the chart renderer uses).",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "period": {"type": "string", "enum": _PERIODS, "default": "1mo"},
                "interval": {"type": "string", "enum": _INTERVALS, "default": "1d"},
            },
            "required": ["ticker"],
        },
        "handler": _chart,
    },
    {
        "name": "industry_heatmap",
        "description": "Industry ETF heatmap grouped by sector/industry with price changes.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "tickers": {"type": "array", "items": {"type": "string"}},
                "period": {"type": "string", "default": "1d"},
                "interval": {"type": "string"},
                "extended": {"type": "boolean", "default": False},
            },
        },
        "handler": _industry_heatmap,
    },
    {
        "name": "sector_heatmap",
        "description": "Sector ETF heatmap with price changes.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "tickers": {"type": "array", "items": {"type": "string"}},
                "period": {"type": "string", "default": "1d"},
                "interval": {"type": "string"},
                "extended": {"type": "boolean", "default": False},
            },
        },
        "handler": _sector_heatmap,
    },
    {
        "name": "trading_signal",
        "description": "Candle/volume signal stats (momentum, breakout, volume) for a batch of tickers.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "tickers": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "period": {"type": "string", "default": "3mo"},
                "interval": {"type": "string", "default": "1d"},
            },
            "required": ["tickers"],
        },
        "handler": _trading_signal,
    },
    {
        "name": "pattern_scan",
        "description": "Scan a universe for technical chart patterns (VCP, cup-handle, bull flag). Long-running: blocks briefly, then returns a task_id to poll.",
        "kind": "compute",
        "schema": {
            "type": "object",
            "properties": {
                "universe": {"type": "string"},
                "tickers": {"type": "array", "items": {"type": "string"}},
                "interval": {"type": "string", "enum": _INTERVALS, "default": "1d"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "min_score": {"type": "number", "default": 55.0},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 50, "default": 25},
                "period": {"type": "string"},
            },
        },
        "handler": _pattern_scan,
    },
    {
        "name": "render_chart_image",
        "description": "Render a branded TradingSpy PNG chart image (candles, expected pattern forecast, or pattern detection). Returns image content stamped with a 'Generated by TradingSpy' footer.",
        "kind": "read",
        "schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "kind": {"type": "string", "enum": ["candles", "expected_pattern", "pattern_detection"], "default": "candles"},
                "interval": {"type": "string", "enum": _INTERVALS, "default": "1d"},
                "period": {"type": "string", "enum": _PERIODS, "default": "6mo"},
                "horizon": {"type": "integer", "default": 20},
                "lookback": {"type": "integer", "default": 180},
                "patterns": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["ticker"],
        },
        "handler": _render_chart_image,
    },
]

TOOLS_BY_NAME = {t["name"]: t for t in TOOLS}


# ---------------------------------------------------------------------------
# Dispatch (shared by MCP tools/call and /api/tools/invoke)
# ---------------------------------------------------------------------------

async def dispatch_tool(name: str, arguments: Optional[Dict[str, Any]]) -> Any:
    """Validate arguments against the handler signature and run the tool."""
    tool = TOOLS_BY_NAME.get(str(name or ""))
    if tool is None:
        raise KeyError(f"Unknown tool '{name}'")
    kwargs = dict(arguments or {})
    sig = inspect.signature(tool["handler"])
    params = list(sig.parameters.values())
    accepts_kwargs = any(p.kind is p.VAR_KEYWORD for p in params)
    if not accepts_kwargs:
        known = {p.name for p in params}
        unknown = set(kwargs) - known
        if unknown:
            raise TypeError(f"Unknown argument(s): {', '.join(sorted(unknown))}")
        kwargs = {k: v for k, v in kwargs.items() if k in known}
        missing = [
            p.name for p in params
            if p.default is p.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
            and p.name not in kwargs
        ]
        if missing:
            raise TypeError(f"Missing required argument(s): {', '.join(missing)}")
    return await tool["handler"](**kwargs)


def openai_manifest() -> List[Dict[str, Any]]:
    """Render the registry as OpenAI function-calling tool definitions."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["schema"],
            },
        }
        for t in TOOLS
    ]


def mcp_tool_definitions() -> List[Dict[str, Any]]:
    """Render the registry as MCP tools/list entries."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "inputSchema": t["schema"],
        }
        for t in TOOLS
    ]


def dumps_safe(value: Any) -> str:
    return json.dumps(json_safe(value), ensure_ascii=False, default=str)
