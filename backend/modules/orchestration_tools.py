"""
Orchestration tools for triggering strategy generation, backtesting, and data downloads
"""

from langchain_core.tools import tool
import requests
import logging
import os
from urllib.parse import quote

logger = logging.getLogger(__name__)

# Get the backend URL from environment or default to localhost
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


@tool
def list_available_strategies() -> dict:
    """List all available trading strategies that can be backtested.
    
    Returns:
        dict with 'strategies' list containing strategy names and metadata
    """
    try:
        response = requests.get(f"{BACKEND_URL}/api/backtest/strategies", timeout=10)
        if response.status_code == 200:
            data = response.json()
            strategies = data.get("strategies", [])
            strategy_names = [s.get("name", s) if isinstance(s, dict) else s for s in strategies]
            return {
                "success": True,
                "count": len(strategy_names),
                "strategies": strategy_names
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"list_available_strategies error: {e}")
        return {"success": False, "error": str(e)}


@tool
def get_strategy_code(strategy_name: str) -> dict:
    """Read a saved strategy's code and metadata for explanation or review.

    Args:
        strategy_name: Exact saved strategy name or class name from list_available_strategies.

    Returns:
        dict with strategy name, class_name, description, ticker/category, and Python code.
    """
    try:
        encoded = quote(strategy_name, safe="")
        response = requests.get(f"{BACKEND_URL}/api/backtest/strategies/{encoded}", timeout=10)
        if response.status_code == 200:
            data = response.json()
            return {
                "success": True,
                "strategy": data.get("name") or strategy_name,
                "class_name": data.get("class_name"),
                "description": data.get("description"),
                "ticker": data.get("ticker"),
                "category": data.get("category"),
                "code": data.get("code"),
            }
        return {"success": False, "error": f"HTTP {response.status_code}", "strategy": strategy_name}
    except Exception as e:
        logger.error(f"get_strategy_code error: {e}")
        return {"success": False, "error": str(e), "strategy": strategy_name}


@tool
def list_available_datasets() -> dict:
    """List all available market data files that can be used for backtesting.
    
    Returns:
        dict with 'datasets' list containing filenames of available market data
    """
    try:
        response = requests.get(f"{BACKEND_URL}/api/market-data/files", timeout=10)
        if response.status_code == 200:
            data = response.json()
            files = data.get("files", [])
            return {
                "success": True,
                "count": len(files),
                "datasets": files
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"list_available_datasets error: {e}")
        return {"success": False, "error": str(e)}


@tool
def generate_strategy(description: str, count: int = 1) -> dict:
    """Generate a trading strategy based on a description. This starts an async task.
    
    Args:
        description: Natural language description of the strategy (e.g., "momentum strategy with RSI crossover")
        count: Number of strategy variations to generate (default 1, max 3)
    
    Returns:
        dict with 'task_id' to track the generation progress
    """
    try:
        payload = {
            "prompt": description,
            "count": min(count, 3),
            "mode": "agnostic"
        }
        response = requests.post(f"{BACKEND_URL}/api/backtest/ai/generate", json=payload, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return {
                "success": True,
                "task_id": data.get("task_id"),
                "message": f"Strategy generation started. Task ID: {data.get('task_id')}. This will take 30-60 seconds.",
                "note": "The strategy will be available in the strategies list once generation completes."
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"generate_strategy error: {e}")
        return {"success": False, "error": str(e)}


@tool
def run_backtest(strategy_name: str, dataset_filename: str) -> dict:
    """Run a backtest for a strategy against a dataset. This starts an async task.
    
    Args:
        strategy_name: Name of the strategy to backtest (use list_available_strategies to see options)
        dataset_filename: Filename of the market data (use list_available_datasets to see options)
    
    Returns:
        dict with 'task_id' to track the backtest progress
    """
    try:
        payload = {
            "strategies": [strategy_name],
            "dataset_filename": dataset_filename
        }
        response = requests.post(f"{BACKEND_URL}/api/backtest/backtest", json=payload, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return {
                "success": True,
                "task_id": data.get("task_id"),
                "message": f"Backtest started. Task ID: {data.get('task_id')}. This will take 10-30 seconds.",
                "strategy": strategy_name,
                "dataset": dataset_filename
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"run_backtest error: {e}")
        return {"success": False, "error": str(e)}


@tool
def download_market_data(ticker: str, period: str = "1y", interval: str = "1d", extended_hours: bool = False) -> dict:
    """Download historical market data for a ticker. This starts an async task.
    
    Args:
        ticker: Stock symbol (e.g., "AAPL", "QQQ", "SPY")
        period: Time period - "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"
        interval: Data interval - "1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"
        extended_hours: Include premarket/postmarket candles for intraday intervals
    
    Returns:
        dict with 'task_id' to track the download progress
    """
    # Validate period
    valid_periods = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]
    if period not in valid_periods:
        return {
            "success": False,
            "error": f"Invalid period '{period}'. Must be one of: {', '.join(valid_periods)}. For 1.5 years, use '2y'."
        }
    
    try:
        payload = {
            "tickers": [ticker.upper()],
            "period": period,
            "interval": interval,
            "extended_hours": bool(extended_hours)
        }
        response = requests.post(f"{BACKEND_URL}/api/market-data/download", json=payload, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return {
                "success": True,
                "task_id": data.get("task_id"),
                "message": f"Download started for {ticker}. Task ID: {data.get('task_id')}. This will take 5-15 seconds.",
                "ticker": ticker.upper(),
                "period": period,
                "interval": interval,
                "extended_hours": bool(extended_hours),
                "expected_filename": f"{ticker.lower()}-{interval}-{period}{'-extended' if extended_hours else ''}.txt"
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"download_market_data error: {e}")
        return {"success": False, "error": str(e)}


@tool
def check_task_status(task_id: str) -> dict:
    """Check the status of an async task (strategy generation, backtest, or data download).
    
    IMPORTANT: This tool MUST be called repeatedly until status is "completed" or "failed".
    Do NOT respond to the user until the task is complete.
    Keep polling this tool until you get a "completed" status.
    
    Args:
        task_id: The task ID returned from generate_strategy, run_backtest, or download_market_data
    
    Returns:
        dict with 'status' (running/completed/failed), 'progress', and 'results' if completed
    """
    try:
        response = requests.get(f"{BACKEND_URL}/api/backtest/results/{task_id}", timeout=10)
        if response.status_code == 200:
            data = response.json()
            status = data.get("status")
            result = {
                "success": True,
                "task_id": task_id,
                "status": status,
                "progress": data.get("progress", 0),
                "current": data.get("current", ""),
                "results": data.get("results") if status == "completed" else None,
                "error": data.get("error") if status == "failed" else None
            }
            
            # Add explicit instruction if still running
            if status == "running":
                result["instruction"] = "Task is still running. Call check_task_status again with the same task_id to check progress."
            elif status == "completed":
                result["instruction"] = "Task completed! You can now report the results to the user."
            elif status == "failed":
                result["instruction"] = "Task failed. Report the error to the user."
            
            return result
        elif response.status_code == 404:
            # Task not found - might still be initializing, return running status
            return {
                "success": True,
                "task_id": task_id,
                "status": "running",
                "progress": 0,
                "current": "Task initializing...",
                "instruction": "Task is initializing. Call check_task_status again to check progress."
            }
        return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        logger.error(f"check_task_status error: {e}")
        return {"success": False, "error": str(e)}
