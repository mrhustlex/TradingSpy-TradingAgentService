"""
Market Regime Detection Module
Analyzes current market conditions to guide trading decisions
"""

import logging
from typing import Dict, Any, Optional
from datetime import datetime, timedelta
import math

logger = logging.getLogger(__name__)


def detect_market_regime(market_overview: Dict[str, Any], industry_heatmap: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Analyze market overview to detect current trading regime.
    
    Returns a regime profile that tells the agent:
    - Is the market trending or mean-reverting?
    - Risk-on or risk-off sentiment?
    - Which sectors are leading/lagging?
    - Volatility environment?
    - Momentum strength?
    
    Args:
        market_overview: Output from get_market_overview tool
        industry_heatmap: Optional output from get_industry_heatmap tool
    
    Returns:
        Dict with keys:
        - regime_type: "trend_strong", "trend_weak", "mean_reversion", "choppy"
        - sentiment: "risk_on", "risk_off", "neutral"
        - leading_sectors: list of strongest sectors
        - lagging_sectors: list of weakest sectors
        - volatility: "low", "normal", "high"
        - momentum: "strong", "moderate", "weak"
        - recommendation: str (guidance for tool selection)
        - evidence: dict (supporting data points)
    """
    
    if not market_overview:
        return {
            "regime_type": "unknown",
            "sentiment": "neutral",
            "leading_sectors": [],
            "lagging_sectors": [],
            "volatility": "normal",
            "momentum": "weak",
            "recommendation": "Insufficient data. Check market status.",
            "evidence": {}
        }
    
    # Extract index moves (US focus)
    indices = market_overview.get("indices", {})
    us_indices = indices.get("us", {})
    
    spy_move = _safe_float(us_indices.get("SPY", {}).get("change_pct"))
    qqq_move = _safe_float(us_indices.get("QQQ", {}).get("change_pct"))
    dia_move = _safe_float(us_indices.get("DIA", {}).get("change_pct"))
    vix_value = _safe_float(us_indices.get("^VIX", {}).get("price"))
    
    # Breadth indicators
    advance_count = _safe_float(market_overview.get("breadth", {}).get("advancing_symbols", 0))
    decline_count = _safe_float(market_overview.get("breadth", {}).get("declining_symbols", 0))
    
    # Calculate breadth ratio
    total_symbols = advance_count + decline_count if advance_count and decline_count else 1
    breadth_ratio = (advance_count / total_symbols) if total_symbols > 0 else 0.5
    
    # Detect trends
    avg_index_move = _mean([spy_move, qqq_move, dia_move])
    index_dispersion = _std_dev([spy_move, qqq_move, dia_move]) if None not in [spy_move, qqq_move, dia_move] else 0
    
    # Volatility assessment
    volatility = "high" if (vix_value and vix_value > 25) else ("low" if (vix_value and vix_value < 12) else "normal")
    
    # Trend strength: use combination of average move and consistency
    if avg_index_move is not None:
        move_magnitude = abs(avg_index_move)
        
        if move_magnitude < 0.3:
            regime_type = "choppy"
            momentum = "weak"
        elif move_magnitude < 1.0:
            if index_dispersion < 0.3:
                regime_type = "trend_weak"
                momentum = "moderate"
            else:
                regime_type = "choppy"
                momentum = "weak"
        elif move_magnitude >= 1.5 and index_dispersion < 0.5:
            regime_type = "trend_strong"
            momentum = "strong"
        elif move_magnitude >= 1.0:
            regime_type = "trend_weak"
            momentum = "moderate"
        else:
            regime_type = "mean_reversion"
            momentum = "moderate"
    else:
        regime_type = "unknown"
        momentum = "weak"
    
    # Sentiment: compare tech vs other indices
    # If QQQ leading, it's risk-on (growth favored)
    # If DIA/SPY leading or QQQ lagging, it's risk-off (defensive)
    sentiment = "neutral"
    if qqq_move is not None and dia_move is not None:
        qqq_dominance = qqq_move - dia_move
        if qqq_dominance > 0.5:
            sentiment = "risk_on"
        elif qqq_dominance < -0.5:
            sentiment = "risk_off"
        else:
            sentiment = "neutral"
    
    # Breadth sentiment
    if breadth_ratio > 0.65:
        sentiment = "risk_on" if sentiment != "risk_off" else "neutral"
    elif breadth_ratio < 0.35:
        sentiment = "risk_off" if sentiment != "risk_on" else "neutral"
    
    # Sector analysis
    leading_sectors = []
    lagging_sectors = []
    if industry_heatmap:
        sectors_data = industry_heatmap.get("sectors", {})
        if sectors_data:
            sector_moves = [(name, _safe_float(data.get("change_pct", 0))) for name, data in sectors_data.items()]
            sector_moves_sorted = sorted([s for s in sector_moves if s[1] is not None], key=lambda x: x[1], reverse=True)
            
            if len(sector_moves_sorted) > 0:
                leading_sectors = [s[0] for s in sector_moves_sorted[:2]]
                lagging_sectors = [s[0] for s in sector_moves_sorted[-2:]]
    
    # Build recommendation
    recommendation = _build_recommendation(regime_type, sentiment, volatility, momentum)
    
    # Collect evidence
    evidence = {
        "SPY_change": spy_move,
        "QQQ_change": qqq_move,
        "DIA_change": dia_move,
        "VIX": vix_value,
        "breadth_ratio": round(breadth_ratio, 3),
        "advance_count": int(advance_count) if advance_count else 0,
        "decline_count": int(decline_count) if decline_count else 0,
        "index_dispersion": round(index_dispersion, 3),
    }
    
    return {
        "regime_type": regime_type,
        "sentiment": sentiment,
        "leading_sectors": leading_sectors,
        "lagging_sectors": lagging_sectors,
        "volatility": volatility,
        "momentum": momentum,
        "recommendation": recommendation,
        "evidence": evidence,
        "timestamp": datetime.now().isoformat()
    }


def _safe_float(value) -> Optional[float]:
    """Convert to float, return None if invalid."""
    try:
        if value is None:
            return None
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _mean(values) -> Optional[float]:
    """Calculate mean of list, ignoring None values."""
    nums = [v for v in values if v is not None]
    return sum(nums) / len(nums) if nums else None


def _std_dev(values) -> float:
    """Calculate standard deviation, treating None as 0."""
    nums = [v if v is not None else 0 for v in values]
    if not nums or len(nums) < 2:
        return 0.0
    mean_val = sum(nums) / len(nums)
    variance = sum((x - mean_val) ** 2 for x in nums) / len(nums)
    return variance ** 0.5


def _build_recommendation(regime_type: str, sentiment: str, volatility: str, momentum: str) -> str:
    """Build actionable recommendation based on regime."""
    
    if regime_type == "unknown":
        return "Insufficient market data to assess regime. Check data availability."
    
    # Trend + Risk-On = look for breakout/continuation trades
    if regime_type.startswith("trend") and sentiment == "risk_on":
        return f"Trending market, risk-on sentiment. Look for breakouts in leading sectors ({regime_type}). Scan for bullish patterns with good volume."
    
    # Trend + Risk-Off = defensive, maybe mean reversion bounces
    if regime_type.startswith("trend") and sentiment == "risk_off":
        return f"Trending market, but risk-off sentiment. Be cautious. Look for mean-reversion bounces off support in defensive stocks."
    
    # Choppy + Risk-On = range plays, small position sizes
    if regime_type == "choppy" and sentiment == "risk_on":
        return "Choppy market, risk-on. Favor mean-reversion trades around support/resistance. Keep position sizes small, use tight stops."
    
    # Choppy + Risk-Off = avoid trading, wait for direction
    if regime_type == "choppy" and sentiment == "risk_off":
        return "Choppy market, risk-off. Avoid trading—uncertain direction. Wait for clearer setup or consider defensive setups only."
    
    # Mean reversion regime
    if regime_type == "mean_reversion":
        if sentiment == "risk_on":
            return "Mean-reversion regime. Look for extended overbought moves ready to pull back. Favor fade trades on strength."
        else:
            return "Mean-reversion regime, risk-off. Look for bounces off support. Use tight stops—could accelerate lower."
    
    # High volatility = tighter stops, smaller positions
    if volatility == "high":
        return f"High volatility ({regime_type}). Use tight stops and smaller positions. Momentum may reverse suddenly."
    
    # Low volatility = trend likely to develop
    if volatility == "low":
        return f"Low volatility ({regime_type}). Trend breakouts may develop soon. Watch for volume expansion on directional move."
    
    # Default
    return f"Market regime: {regime_type}, sentiment {sentiment}. Adapt position sizing and stop placement accordingly."


def regime_summary_for_user(regime: Dict[str, Any]) -> str:
    """Format regime detection as readable summary for user."""
    
    if regime.get("regime_type") == "unknown":
        return "Market regime unknown—cannot assess conditions."
    
    lines = []
    lines.append(f"🎯 **Market Regime:** {regime['regime_type'].replace('_', ' ').title()}")
    lines.append(f"📊 **Sentiment:** {regime['sentiment'].replace('_', ' ').title()}")
    lines.append(f"📈 **Momentum:** {regime['momentum'].title()}")
    lines.append(f"⚡ **Volatility:** {regime['volatility'].title()}")
    
    if regime.get("leading_sectors"):
        lines.append(f"✅ **Leading:** {', '.join(regime['leading_sectors'])}")
    
    if regime.get("lagging_sectors"):
        lines.append(f"❌ **Lagging:** {', '.join(regime['lagging_sectors'])}")
    
    lines.append(f"\n💡 **Approach:** {regime['recommendation']}")
    
    return "\n".join(lines)
