"""
Enhanced Pattern Analysis with Market Regime Context
Analyzes bullish patterns and ranks them by probability + risk/reward, considering market regime
"""

import logging
from typing import Dict, List, Any, Optional
try:
    from modules.pattern_scanner import scan_bullish_patterns
    from modules.market_regime import detect_market_regime
except ImportError:
    from pattern_scanner import scan_bullish_patterns
    from market_regime import detect_market_regime

logger = logging.getLogger(__name__)


def analyze_patterns_with_regime(
    tickers: Optional[List[str]] = None,
    universe: Optional[str] = None,
    intervals: Optional[List[str]] = None,
    horizon: int = 20,
    min_return_pct: float = 1.0,
    lookback: int = 180,
    market_overview: Dict[str, Any] = None,
    industry_heatmap: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """
    Scan for bullish patterns AND analyze them in context of market regime.
    
    This is a trader-style pattern analysis:
    1. Detect market regime (trending? mean reverting? risk-on/off?)
    2. Scan for bullish patterns
    3. Rank patterns by:
       - Regime fit (breakouts score higher in uptrends; bounces score higher in mean reversion)
       - Volume confirmation (strong = higher probability)
       - Momentum (RSI alignment)
       - Risk/Reward ratio (not just return %)
    4. Return ranked list with reasoning for each setup
    
    Args:
        tickers: List of tickers to scan
        universe: Preset universe to scan
        intervals: Timeframes to check
        horizon: Bars to forecast
        min_return_pct: Minimum expected return threshold
        lookback: Historical bars for analysis
        market_overview: Market overview data for regime detection
        industry_heatmap: Industry heatmap for sector context
    
    Returns:
        Dict with:
        - regime: Market regime context
        - patterns: List of ranked patterns with analysis
        - summary: Trading actionable summary
        - recommendation: What to do with these setups
    """
    
    # First: detect market regime
    regime = detect_market_regime(market_overview, industry_heatmap)
    
    # Second: scan for patterns
    pattern_scan = scan_bullish_patterns(
        tickers=tickers,
        universe=universe,
        intervals=intervals,
        horizon=horizon,
        min_return_pct=min_return_pct,
        lookback=lookback
    )
    
    if pattern_scan.get("error"):
        return {
            "error": pattern_scan["error"],
            "regime": regime,
            "patterns": [],
            "summary": "Pattern scan failed",
            "recommendation": "Check ticker symbols and try again"
        }
    
    # Third: rank and analyze each pattern in context of regime
    bullish_patterns = pattern_scan.get("bullish_patterns", [])
    analyzed_patterns = []
    
    for ticker_group in bullish_patterns:
        ticker = ticker_group.get("ticker")
        patterns_for_ticker = ticker_group.get("patterns", [])
        
        # Check if ticker is in leading sectors (higher probability if so)
        is_in_leading_sector = _is_ticker_in_sectors(ticker, regime.get("leading_sectors", []))
        is_in_lagging_sector = _is_ticker_in_sectors(ticker, regime.get("lagging_sectors", []))
        
        for pattern in patterns_for_ticker:
            analyzed = _analyze_single_pattern(
                pattern,
                regime=regime,
                is_leading_sector=is_in_leading_sector,
                is_lagging_sector=is_in_lagging_sector
            )
            analyzed_patterns.append(analyzed)
    
    # Rank by probability (adjusted for regime)
    analyzed_patterns.sort(key=lambda x: x["probability_adjusted"], reverse=True)
    
    # Build summary
    summary = _build_pattern_summary(analyzed_patterns, regime)
    
    return {
        "regime": regime,
        "patterns": analyzed_patterns,
        "summary": summary,
        "regime_fit_quality": _assess_regime_pattern_fit(analyzed_patterns, regime),
        "recommendation": _pattern_trading_recommendation(analyzed_patterns, regime)
    }


def _analyze_single_pattern(
    pattern: Dict[str, Any],
    regime: Dict[str, Any],
    is_leading_sector: bool = False,
    is_lagging_sector: bool = False
) -> Dict[str, Any]:
    """
    Analyze a single pattern in context of market regime.
    Adjusts probability based on regime fit.
    """
    
    ticker = pattern.get("ticker")
    interval = pattern.get("interval")
    expected_return = float(pattern.get("expected_return_pct", 0))
    rsi = float(pattern.get("rsi14", 50))
    volatility = float(pattern.get("volatility_pct", 1.5))
    latest_close = float(pattern.get("latest_close", 0))
    
    regime_type = regime.get("regime_type", "unknown")
    sentiment = regime.get("sentiment", "neutral")
    
    # Base probability (before regime adjustment)
    base_probability = _calculate_base_probability(expected_return, rsi, volatility)
    
    # Regime fit adjustments
    regime_bonus = 0  # Probability adjustment from regime fit
    regime_note = ""
    
    # Trending market: breakouts score higher
    if regime_type == "trend_strong":
        if interval in ["1d", "1h", "15m"]:  # Breakouts typically clearer on medium/long timeframes
            regime_bonus += 10
            regime_note = "Strong uptrend—breakout setup fits regime"
        else:
            regime_bonus += 5
            regime_note = "Uptrend confirmed, but short timeframe"
    
    elif regime_type == "trend_weak":
        regime_bonus += 2
        regime_note = "Weak trend; setup still valid but use tighter stops"
    
    # Mean reversion: bounces score higher
    elif regime_type == "mean_reversion":
        if rsi < 40:  # Oversold bounces are strong in mean reversion
            regime_bonus += 8
            regime_note = "Mean reversion + oversold bounce—strong setup"
        elif rsi < 50:
            regime_bonus += 5
            regime_note = "Mean reversion regime, moderate setup"
        else:
            regime_bonus -= 5
            regime_note = "Mean reversion but RSI not yet oversold—wait"
    
    # Choppy market: be cautious
    elif regime_type == "choppy":
        regime_bonus -= 5
        regime_note = "Choppy market—lower probability, use tight stops"
    
    # Sector sentiment
    sector_bonus = 0
    sector_note = ""
    if is_leading_sector and sentiment == "risk_on":
        sector_bonus += 10
        sector_note = "In leading sector with risk-on sentiment"
    elif is_leading_sector:
        sector_bonus += 5
        sector_note = "In leading sector, but mixed sentiment"
    elif is_lagging_sector:
        sector_bonus -= 8
        sector_note = "In lagging sector—reconsider"
    
    # Risk/Reward calculation (simple version)
    # Assume 2% stop loss, calculate reward/risk
    stop_distance_pct = 2.0  # Conservative estimate
    reward_pct = expected_return
    risk_reward = (reward_pct / stop_distance_pct) if stop_distance_pct > 0 else 0
    
    # Risk/Reward bonus: 1:2 is better than 1:1
    risk_reward_bonus = min(10, (risk_reward - 1) * 3) if risk_reward > 1 else -5
    
    # Final adjusted probability
    probability_adjusted = base_probability + regime_bonus + sector_bonus + risk_reward_bonus
    probability_adjusted = max(20, min(95, probability_adjusted))  # Clamp between 20-95%
    
    return {
        "ticker": ticker,
        "interval": interval,
        "expected_return_pct": expected_return,
        "rsi": rsi,
        "volatility_pct": volatility,
        "latest_close": latest_close,
        "probability_base": base_probability,
        "probability_adjusted": probability_adjusted,
        "regime_bonus": regime_bonus,
        "regime_note": regime_note,
        "sector_bonus": sector_bonus,
        "sector_note": sector_note,
        "risk_reward_ratio": round(risk_reward, 2),
        "stop_distance_pct": stop_distance_pct,
        "full_analysis": _format_pattern_analysis(
            ticker, interval, expected_return, rsi, regime_note, sector_note, risk_reward
        )
    }


def _calculate_base_probability(expected_return: float, rsi: float, volatility: float) -> float:
    """
    Calculate base probability score (0-100) from pattern metrics.
    
    - Expected return: higher = more conviction
    - RSI: 40-60 is healthiest (not overbought or oversold yet)
    - Volatility: moderate is good (too low = no conviction, too high = whipsaw risk)
    """
    
    score = 50  # Start at neutral
    
    # Return contribution: 1% = +5, 2% = +10, etc. (capped at +30)
    return_score = min(30, expected_return * 5)
    score += return_score
    
    # RSI contribution: 40-60 is ideal
    if 40 <= rsi <= 60:
        score += 10
    elif 30 <= rsi < 40:
        score += 5  # About to reverse up
    elif 60 < rsi <= 70:
        score += 5  # Extended but not overbought yet
    elif rsi < 30 or rsi > 70:
        score -= 10  # Extreme
    
    # Volatility contribution: 1-3% is healthy
    if 1.0 <= volatility <= 3.0:
        score += 5
    elif volatility < 0.5:
        score -= 5  # Too quiet, no conviction
    elif volatility > 5.0:
        score -= 10  # Too choppy, whipsaw risk
    
    return min(100, max(20, score))


def _is_ticker_in_sectors(ticker: str, sector_names: List[str]) -> bool:
    """Quick check if a ticker is in a sector group (simplified)."""
    # This is a placeholder; in production, would use full sector mappings
    ticker_upper = ticker.upper()
    sector_str = " ".join(sector_names).upper()
    return ticker_upper in sector_str


def _format_pattern_analysis(
    ticker: str,
    interval: str,
    expected_return: float,
    rsi: float,
    regime_note: str,
    sector_note: str,
    risk_reward: float
) -> str:
    """Format a detailed analysis string for this pattern."""
    
    return f"{ticker} ({interval}): +{expected_return:.1f}% expected. RSI {rsi:.0f}. Risk/Reward {risk_reward:.1f}:1. {regime_note} {sector_note}"


def _build_pattern_summary(patterns: List[Dict[str, Any]], regime: Dict[str, Any]) -> str:
    """Build a readable summary of top patterns."""
    
    if not patterns:
        return "No bullish patterns found matching criteria."
    
    lines = []
    lines.append(f"Found {len(patterns)} bullish pattern(s). Ranked by probability:")
    lines.append("")
    
    for i, p in enumerate(patterns[:5], 1):  # Top 5
        lines.append(f"{i}. **{p['ticker']}** ({p['interval']})")
        lines.append(f"   Probability: {p['probability_adjusted']:.0f}% | Return: +{p['expected_return_pct']:.1f}% | R/R: {p['risk_reward_ratio']}:1")
        lines.append(f"   → {p['regime_note']}")
        if p['sector_note']:
            lines.append(f"   → {p['sector_note']}")
        lines.append("")
    
    return "\n".join(lines)


def _assess_regime_pattern_fit(patterns: List[Dict[str, Any]], regime: Dict[str, Any]) -> str:
    """Assess how well the patterns fit the market regime."""
    
    if not patterns:
        return "No patterns to assess"
    
    avg_regime_bonus = sum(p.get("regime_bonus", 0) for p in patterns) / len(patterns)
    
    if avg_regime_bonus > 5:
        return "Excellent—patterns align well with market regime"
    elif avg_regime_bonus > 0:
        return "Good—patterns mostly aligned with regime"
    elif avg_regime_bonus > -5:
        return "Neutral—mixed alignment with regime"
    else:
        return "Caution—patterns may not fit current regime. Use tighter stops."


def _pattern_trading_recommendation(patterns: List[Dict[str, Any]], regime: Dict[str, Any]) -> str:
    """Generate actionable trading recommendation."""
    
    if not patterns:
        return "No patterns found. Market may not have suitable setups right now."
    
    top_pattern = patterns[0] if patterns else None
    if not top_pattern:
        return "Unable to generate recommendation"
    
    prob = top_pattern.get("probability_adjusted", 50)
    regime_type = regime.get("regime_type", "unknown")
    
    if prob > 70:
        return f"High probability setup detected ({top_pattern['ticker']} on {top_pattern['interval']}). Entry: Current price. Stop: 2% below. This fits the {regime_type} regime."
    elif prob > 50:
        return f"Moderate setup ({top_pattern['ticker']}). Consider it if this matches your risk tolerance. Watch for confirmation on volume."
    else:
        return f"Lower probability patterns. Consider waiting for higher-conviction setups, or use very tight stops (1% max)."
