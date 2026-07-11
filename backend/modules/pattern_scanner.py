"""Scan expected patterns across intervals to find bullish setups."""

import logging
from typing import List, Dict, Optional
from langchain_core.tools import tool
from modules.expected_pattern import generate_expected_pattern

logger = logging.getLogger(__name__)

# Universe presets
UNIVERSE_PRESETS = {
    "mag7": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
    "faang": ["META", "AAPL", "AMZN", "NFLX", "GOOGL"],
    "semiconductors": ["NVDA", "AMD", "INTC", "TSM", "AVGO", "QCOM", "MU", "AMAT", "LRCX", "KLAC"],
    "software": ["MSFT", "ORCL", "ADBE", "CRM", "NOW", "INTU", "PANW", "CRWD", "SNOW", "DDOG"],
    "banks": ["JPM", "BAC", "WFC", "C", "GS", "MS", "USB", "PNC", "TFC", "SCHW"],
    "energy": ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "VLO", "OXY", "HAL"],
    "healthcare": ["UNH", "JNJ", "LLY", "ABBV", "MRK", "TMO", "ABT", "DHR", "PFE", "BMY"],
    "consumer": ["AMZN", "WMT", "COST", "HD", "MCD", "NKE", "SBUX", "TGT", "LOW", "TJX"],
    "industrials": ["CAT", "BA", "HON", "UPS", "RTX", "LMT", "DE", "GE", "MMM", "EMR"],
    "crypto": ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD"],
    "indices": ["SPY", "QQQ", "DIA", "IWM", "VTI"],
}


@tool
def scan_bullish_patterns(
    tickers: Optional[List[str]] = None,
    universe: Optional[str] = None,
    intervals: Optional[List[str]] = None,
    horizon: int = 20,
    min_return_pct: float = 1.0,
    lookback: int = 180,
) -> dict:
    """Scan multiple tickers and intervals to find bullish expected patterns.
    
    Generates expected patterns for each ticker across different timeframes,
    then filters for those showing upward direction with minimum expected returns.
    
    Args:
        tickers: List of specific symbols to scan (e.g., ['AAPL', 'MSFT', 'QQQ'])
        universe: Preset universe to scan (e.g., 'mag7', 'semiconductors', 'banks', 'software', 'energy', 'healthcare', 'consumer', 'industrials', 'crypto', 'indices', 'faang')
        intervals: Intervals to test (default: ['1m', '5m', '15m', '1h', '1d'])
        horizon: Forecast horizon in bars (default: 20)
        min_return_pct: Minimum expected return % to qualify as bullish (default: 1.0)
        lookback: Historical bars for pattern calculation (default: 180)
    
    Returns:
        Dictionary with bullish patterns found, grouped by ticker and interval
    
    Examples:
        - scan_bullish_patterns(tickers=['AAPL', 'NVDA'], intervals=['1m', '5m'])
        - scan_bullish_patterns(universe='semiconductors', intervals=['1h', '1d'])
        - scan_bullish_patterns(universe='mag7', min_return_pct=2.0)
    """
    if intervals is None:
        intervals = ['1m', '5m', '15m', '1h', '1d']
    
    # Resolve tickers from universe or use provided list
    if universe:
        universe_lower = universe.lower().replace(" ", "").replace("-", "")
        if universe_lower in UNIVERSE_PRESETS:
            tickers = UNIVERSE_PRESETS[universe_lower]
            logger.info(f"Using {universe} preset with {len(tickers)} tickers")
        else:
            available = ", ".join(UNIVERSE_PRESETS.keys())
            return {
                "error": f"Unknown universe '{universe}'. Available: {available}",
                "available_universes": list(UNIVERSE_PRESETS.keys()),
                "bullish_patterns": []
            }
    
    if not tickers:
        return {
            "error": "Provide either 'tickers' list or 'universe' preset",
            "available_universes": list(UNIVERSE_PRESETS.keys()),
            "bullish_patterns": []
        }
    
    if len(tickers) > 10:
        return {"error": "Maximum 10 tickers per scan to avoid timeouts", "bullish_patterns": []}
    
    logger.info(f"Scanning {len(tickers)} ticker(s) across {len(intervals)} interval(s) for bullish patterns")
    
    results = []
    scanned_count = 0
    error_count = 0
    
    for ticker in tickers:
        ticker_results = []
        
        for interval in intervals:
            scanned_count += 1
            try:
                # Generate pattern for this ticker/interval combo
                pattern = generate_expected_pattern.invoke({
                    "ticker": ticker,
                    "interval": interval,
                    "horizon": min(horizon, 250),  # Respect max limits
                    "lookback": lookback,
                    "extended_hours": False,
                })
                
                if pattern.get("error"):
                    error_count += 1
                    continue
                
                direction = pattern.get("direction", "sideways")
                end_return = float(pattern.get("expected_end_return_pct", 0))
                
                # Check if it's bullish
                if direction == "upward" and end_return >= min_return_pct:
                    ticker_results.append({
                        "ticker": ticker,
                        "interval": interval,
                        "direction": direction,
                        "expected_return_pct": round(end_return, 2),
                        "horizon": pattern.get("horizon"),
                        "as_of": pattern.get("as_of"),
                        "latest_close": pattern.get("inputs", {}).get("latest_close"),
                        "rsi14": pattern.get("inputs", {}).get("rsi14"),
                        "volatility_pct": pattern.get("inputs", {}).get("per_bar_volatility_pct"),
                    })
            
            except Exception as e:
                logger.warning(f"Pattern scan failed for {ticker} {interval}: {e}")
                error_count += 1
                continue
        
        # Add ticker results if any bullish patterns found
        if ticker_results:
            # Sort by expected return (highest first)
            ticker_results.sort(key=lambda x: x["expected_return_pct"], reverse=True)
            results.append({
                "ticker": ticker,
                "bullish_intervals": [r["interval"] for r in ticker_results],
                "best_interval": ticker_results[0]["interval"],
                "best_return_pct": ticker_results[0]["expected_return_pct"],
                "patterns": ticker_results,
            })
    
    # Sort tickers by best return
    results.sort(key=lambda x: x["best_return_pct"], reverse=True)
    
    summary = {
        "scanned_tickers": len(tickers),
        "scanned_intervals": len(intervals),
        "total_patterns_checked": scanned_count,
        "errors": error_count,
        "bullish_found": len(results),
        "min_return_threshold": min_return_pct,
        "universe_used": universe if universe else "custom",
    }
    
    return {
        "summary": summary,
        "bullish_patterns": results,
        "intervals_tested": intervals,
        "tickers_scanned": tickers,
        "message": f"Found {len(results)} ticker(s) with bullish patterns out of {len(tickers)} scanned.",
    }
