"""
Action tools for strategy generation, backtesting, and data management
These tools allow the agent to trigger UI actions and workflows
"""

from langchain_core.tools import tool
import logging

logger = logging.getLogger(__name__)


@tool
def list_available_strategies() -> dict:
    """List all available trading strategies that can be backtested.
    Use this when the user asks about strategies or wants to backtest.
    
    Returns:
        dict with 'strategies' list containing strategy names
    """
    # This will be populated by the backend when calling the tool
    # The actual list comes from the request context
    return {
        "note": "Strategy list will be provided by the system",
        "action": "list_strategies"
    }


@tool
def list_available_datasets() -> dict:
    """List all available market data files that can be used for backtesting.
    Use this when the user asks about available data or wants to backtest.
    
    Returns:
        dict with 'datasets' list containing filenames
    """
    # This will be populated by the backend when calling the tool
    # The actual list comes from the request context
    return {
        "note": "Dataset list will be provided by the system",
        "action": "list_datasets"
    }


@tool
def generate_strategy(description: str, ticker: str = None, count: int = 1) -> dict:
    """Generate a trading strategy based on user description.
    This will create Python code for a backtesting strategy.
    
    IMPORTANT: Before calling this, you should:
    1. Understand what type of strategy the user wants (momentum, mean reversion, etc.)
    2. Confirm the ticker/asset if not specified
    3. Ask about timeframe preferences if relevant
    
    Args:
        description: Detailed description of the strategy (e.g., "RSI momentum strategy that buys when RSI crosses above 30")
        ticker: Optional ticker symbol the strategy is designed for (e.g., "QQQ", "AAPL")
        count: Number of strategy variations to generate (default 1)
    
    Returns:
        dict with task_id for tracking the generation progress
    """
    return {
        "action": "generate_strategy",
        "description": description,
        "ticker": ticker,
        "count": count,
        "note": "Strategy generation will be triggered. This takes 30-60 seconds."
    }


@tool
def run_backtest(strategy_name: str, dataset_filename: str) -> dict:
    """Run a backtest of a strategy against historical data.
    
    IMPORTANT: Before calling this, you should:
    1. Confirm the strategy exists (use list_available_strategies)
    2. Confirm the dataset exists (use list_available_datasets)
    3. Verify the user wants to proceed
    
    Args:
        strategy_name: Name of the strategy to test (must exist in available strategies)
        dataset_filename: Filename of the market data (e.g., "QQQ_1d.csv")
    
    Returns:
        dict with task_id for tracking the backtest progress
    """
    return {
        "action": "run_backtest",
        "strategy": strategy_name,
        "dataset": dataset_filename,
        "note": "Backtest will be triggered. Results will appear in Battle Station."
    }


@tool
def download_market_data(ticker: str, period: str = "1y", interval: str = "1d") -> dict:
    """Download historical market data for a ticker.
    
    IMPORTANT: Before calling this, you should:
    1. Confirm the ticker symbol is correct
    2. Ask about the timeframe if not specified (period: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max)
    3. Ask about the interval if not specified (1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo)
    
    Args:
        ticker: Stock ticker symbol (e.g., "AAPL", "QQQ", "SPY")
        period: Time period to download (default "1y")
        interval: Data interval/timeframe (default "1d" for daily)
    
    Returns:
        dict with task_id for tracking the download progress
    """
    return {
        "action": "download_data",
        "ticker": ticker.upper(),
        "period": period,
        "interval": interval,
        "note": f"Download will start for {ticker.upper()} ({period}, {interval} bars)"
    }


@tool
def ask_user_for_clarification(question: str, context: str = None) -> dict:
    """Ask the user a clarifying question when you need more information.
    Use this when:
    - The user's request is ambiguous
    - You need to confirm parameters before taking action
    - Multiple options are available and you need the user to choose
    
    Args:
        question: The question to ask the user
        context: Optional context about why you're asking
    
    Returns:
        dict indicating the question was asked
    """
    return {
        "action": "ask_clarification",
        "question": question,
        "context": context,
        "note": "Waiting for user response..."
    }


@tool
def get_price_chart(ticker: str, period: str = "1mo", interval: str = "1d", limit: int = None) -> dict:
    """Get historical price chart data for a ticker to visualize in the chat.
    Use this when the user wants to see price action, trends, or technical analysis visually.
    
    Args:
        ticker: Stock ticker symbol (e.g., "AAPL", "QQQ", "SPY")
        period: Time period to display (default "1mo"). Options: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, max
        interval: Candle interval (default "1d"). Options: 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
        limit: Optional limit on number of bars to return. If None, returns all available data.
    
    Returns:
        dict with OHLCV data ready for charting
    """
    # Import here to avoid circular imports
    import yfinance as yf
    import time
    from threading import Thread
    
    ticker = ticker.upper()
    result_holder = [None]
    error_holder = [None]
    
    def fetch_data():
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period=period, interval=interval)
            result_holder[0] = hist
        except Exception as e:
            error_holder[0] = e
    
    try:
        # Run fetch in thread with timeout
        thread = Thread(target=fetch_data, daemon=True)
        thread.start()
        thread.join(timeout=8)  # 8 second timeout
        
        if thread.is_alive():
            logger.warning(f"get_price_chart timed out for {ticker}")
            return {"type": "chart", "symbol": ticker, "error": "Request timed out - try again", "data": []}
        
        if error_holder[0]:
            logger.error(f"get_price_chart error: {error_holder[0]}")
            return {"type": "chart", "symbol": ticker, "error": f"Failed: {str(error_holder[0])[:50]}", "data": []}
        
        hist = result_holder[0]
        if hist is None or hist.empty:
            return {"type": "chart", "symbol": ticker, "error": "No data available", "data": []}
        
        # Apply limit if specified, otherwise return all data
        if limit and limit > 0:
            hist = hist.tail(limit)
        
        data = []
        for idx, row in hist.iterrows():
            data.append({
                "date": idx.isoformat(),
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"])
            })
        
        return {
            "type": "chart",
            "symbol": ticker,
            "data": data,
            "period": period,
            "interval": interval,
            "count": len(data)
        }
    except Exception as e:
        logger.error(f"Error in get_price_chart: {e}")
        return {"type": "chart", "symbol": ticker, "error": str(e), "data": []}
