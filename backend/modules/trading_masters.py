"""
Trading Masters: Investment & Trading Methodologies from the Greatest Investors
Embedded skills from Warren Buffett, Peter Lynch, Mark Minervini, William O'Neil, and more.

Based on: https://github.com/mrhustlex/trading-masters
"""

import logging
from typing import Dict, List, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class TradingMaster:
    """Profile of a trading/investing master with their methodology."""
    name: str
    style: str  # value, growth, momentum, technical, etc.
    timeframe: str  # long-term, swing, day-trading
    key_principles: List[str]
    screening_criteria: Dict[str, Any]
    risk_rules: List[str]
    checklist: List[str]


# =============================================================================
# VALUE INVESTORS
# =============================================================================

WARREN_BUFFETT = TradingMaster(
    name="Warren Buffett / Ben Graham",
    style="Value + Margin of Safety",
    timeframe="Long-term (years)",
    key_principles=[
        "Buy wonderful businesses at fair prices",
        "Margin of safety (buy below intrinsic value)",
        "Durable competitive advantage (moat)",
        "Management quality matters",
        "Be greedy when others are fearful",
    ],
    screening_criteria={
        "pe_ratio": {"max": 15, "description": "P/E < 15 (cheap valuation)"},
        "pb_ratio": {"max": 1.5, "description": "P/B < 1.5 (book value discount)"},
        "debt_to_equity": {"max": 0.5, "description": "Low debt (D/E < 0.5)"},
        "roe": {"min": 0.15, "description": "ROE > 15% (profitable)"},
        "dividend_yield": {"min": 0.02, "description": "Dividend yield > 2%"},
        "earnings_growth": {"min": 0.05, "description": "5yr EPS growth > 5%"},
    },
    risk_rules=[
        "Never invest in businesses you don't understand",
        "Never overpay (margin of safety is critical)",
        "Diversify, but not excessively (focus on best ideas)",
        "Hold forever if business remains strong",
    ],
    checklist=[
        "✓ Do I understand this business?",
        "✓ Does it have a durable moat?",
        "✓ Is management honest and competent?",
        "✓ Am I buying with a margin of safety (20%+ discount)?",
        "✓ Can I hold this for 10+ years?",
    ]
)

PETER_LYNCH = TradingMaster(
    name="Peter Lynch",
    style="GARP (Growth at Reasonable Price)",
    timeframe="Medium-term (months to years)",
    key_principles=[
        "Invest in what you know",
        "PEG ratio ≤ 1 (growth at reasonable price)",
        "Look for 'ten-baggers' (10x returns)",
        "Small caps can outperform (hidden gems)",
        "Earnings growth drives stock prices",
    ],
    screening_criteria={
        "peg_ratio": {"max": 1.0, "description": "PEG ≤ 1 (growth cheaper than P/E)"},
        "pe_ratio": {"max": 20, "description": "P/E < 20"},
        "earnings_growth": {"min": 0.15, "description": "15%+ annual EPS growth"},
        "revenue_growth": {"min": 0.10, "description": "10%+ revenue growth"},
        "debt_to_equity": {"max": 0.8, "description": "Moderate debt"},
    },
    risk_rules=[
        "Sell when story changes (fundamentals deteriorate)",
        "Don't fall in love with stocks",
        "Diversify across 10-20 stocks",
        "Monitor earnings every quarter",
    ],
    checklist=[
        "✓ Do I understand what the company does?",
        "✓ Is PEG ≤ 1?",
        "✓ Is earnings growth accelerating?",
        "✓ Does the company have a unique product/advantage?",
        "✓ Is the story intact (no red flags)?",
    ]
)

JOEL_GREENBLATT = TradingMaster(
    name="Joel Greenblatt",
    style="Magic Formula (Quant Value)",
    timeframe="Medium-term (6-12 months)",
    key_principles=[
        "Buy good businesses (high ROIC) at cheap prices (high earnings yield)",
        "Mechanical screening removes emotion",
        "Rebalance annually",
        "Small/mid caps preferred",
    ],
    screening_criteria={
        "roic": {"description": "Rank by Return on Invested Capital (high = better)"},
        "earnings_yield": {"description": "Rank by Earnings Yield (EBIT/EV, high = cheaper)"},
        "magic_formula_rank": {"description": "Combined rank of ROIC + EY (lower = better)"},
        "market_cap": {"min": 50_000_000, "description": "Min $50M market cap"},
    },
    risk_rules=[
        "Hold top-ranked stocks for 1 year (tax efficiency)",
        "Rebalance annually",
        "Expect 20-30% of picks to underperform",
        "Portfolio of 20-30 stocks (diversification)",
    ],
    checklist=[
        "✓ Is ROIC high (efficient capital use)?",
        "✓ Is earnings yield high (cheap valuation)?",
        "✓ Does it rank in top 30 of magic formula?",
        "✓ Am I willing to hold for 1 year?",
    ]
)

# =============================================================================
# MOMENTUM & SWING TRADERS
# =============================================================================

MARK_MINERVINI = TradingMaster(
    name="Mark Minervini",
    style="SEPA + VCP (Momentum Swing)",
    timeframe="Swing (weeks to months)",
    key_principles=[
        "Buy stocks in Stage 2 uptrend (Weinstein stages)",
        "VCP (Volatility Contraction Pattern) breakout",
        "Strong relative strength (leading stocks)",
        "Tight stops (7-8% max loss)",
        "Pyramid winners, cut losers fast",
    ],
    screening_criteria={
        "rs_rating": {"min": 80, "description": "Relative strength > 80 (top 20% of stocks)"},
        "price_above_ma": {"ma": [50, 150, 200], "description": "Price > 50/150/200-day MA"},
        "ma_alignment": {"description": "50 MA > 150 MA > 200 MA (uptrend)"},
        "volume_surge": {"min": 1.5, "description": "Volume 1.5x avg on breakout"},
        "base_depth": {"max": 0.25, "description": "Base depth < 25%"},
        "vcp_pattern": {"description": "Volatility contracting over 3+ pullbacks"},
    },
    risk_rules=[
        "Cut losses at 7-8% (discipline is key)",
        "Never average down",
        "Pyramid into strength (not weakness)",
        "Take profits at 20-25% or trail stops",
    ],
    checklist=[
        "✓ Is stock in Stage 2 (clear uptrend)?",
        "✓ Is it outperforming market (RS > 80)?",
        "✓ Is it breaking out of VCP on volume?",
        "✓ Are all MAs aligned (50>150>200)?",
        "✓ Can I risk 7-8% stop?",
    ]
)

WILLIAM_ONEIL = TradingMaster(
    name="William O'Neil",
    style="CAN SLIM (Growth Momentum)",
    timeframe="Swing (weeks to months)",
    key_principles=[
        "CAN SLIM: Current earnings, Annual earnings, New high, Supply/demand, Leader, Institutional, Market",
        "Buy cup-with-handle or other bases",
        "Cut losses at 7-8%",
        "Institutional sponsorship critical",
    ],
    screening_criteria={
        "eps_growth_current": {"min": 0.25, "description": "25%+ EPS growth (current quarter)"},
        "eps_growth_annual": {"min": 0.25, "description": "25%+ annual EPS growth"},
        "new_high": {"description": "Within 15% of 52-week high"},
        "volume": {"description": "Above-average volume on breakout"},
        "rs_rating": {"min": 80, "description": "Relative strength > 80"},
        "institutional_ownership": {"min": 0.10, "description": "10%+ institutional ownership"},
    },
    risk_rules=[
        "Cut losses at 7-8% (no exceptions)",
        "Sell into weakness (don't hope)",
        "Follow market trend (don't fight the tape)",
        "Buy leaders, not laggards",
    ],
    checklist=[
        "✓ Current EPS growth > 25%?",
        "✓ Annual EPS growth > 25%?",
        "✓ Near 52-week high?",
        "✓ Volume surging on breakout?",
        "✓ Market in confirmed uptrend?",
    ]
)

# =============================================================================
# DAY TRADERS
# =============================================================================

ANDREW_AZIZ = TradingMaster(
    name="Andrew Aziz",
    style="Momentum Day Trading (ORB + VWAP)",
    timeframe="Intraday (minutes)",
    key_principles=[
        "Trade with momentum (follow the trend)",
        "Opening Range Breakout (ORB)",
        "VWAP as support/resistance",
        "1:2 risk/reward minimum",
        "Cut losses fast (tight stops)",
    ],
    screening_criteria={
        "premarket_gainer": {"min": 0.02, "description": "2%+ premarket move"},
        "float": {"max": 50_000_000, "description": "Low float < 50M shares"},
        "volume": {"min": 500_000, "description": "500K+ daily volume"},
        "price_range": {"min": 2, "max": 200, "description": "$2-$200 per share"},
        "catalyst": {"description": "News catalyst (earnings, FDA, contract, etc.)"},
    },
    risk_rules=[
        "Risk max 1% per trade",
        "Stop trading after 3 losses",
        "Don't chase (wait for pullback)",
        "Cut losses at support break",
    ],
    checklist=[
        "✓ Is there a catalyst driving momentum?",
        "✓ Is float low (< 50M shares)?",
        "✓ Is premarket volume strong?",
        "✓ Is risk/reward at least 1:2?",
        "✓ Do I have a clear stop level?",
    ]
)

AL_BROOKS = TradingMaster(
    name="Al Brooks",
    style="Price Action (No Indicators)",
    timeframe="Intraday to swing",
    key_principles=[
        "Read price action (candles tell the story)",
        "Identify trends, trading ranges, reversals",
        "Support/resistance from price itself",
        "Probability-based trading (not certainty)",
        "Lose small, win big",
    ],
    screening_criteria={
        "trend": {"description": "Clear trend (higher highs/lows or lower highs/lows)"},
        "breakout": {"description": "Breakout from range or pullback"},
        "reversal_pattern": {"description": "Reversal bar (engulfing, pin bar, etc.)"},
        "context": {"description": "Trend context (with trend = higher probability)"},
    },
    risk_rules=[
        "Trade with the trend (highest probability)",
        "Tight stops (below recent swing)",
        "Scale out of winners (take partial profits)",
        "Accept that 40-50% of trades will lose",
    ],
    checklist=[
        "✓ Is there a clear trend?",
        "✓ Am I trading WITH the trend?",
        "✓ Is this a high-probability setup?",
        "✓ Is my stop tight and logical?",
        "✓ Is risk/reward favorable?",
    ]
)

# =============================================================================
# MASTER REGISTRY
# =============================================================================

TRADING_MASTERS = {
    "buffett": WARREN_BUFFETT,
    "lynch": PETER_LYNCH,
    "greenblatt": JOEL_GREENBLATT,
    "minervini": MARK_MINERVINI,
    "oneil": WILLIAM_ONEIL,
    "aziz": ANDREW_AZIZ,
    "brooks": AL_BROOKS,
}


def get_master_by_name(name: str) -> Optional[TradingMaster]:
    """Get a trading master by name (case-insensitive)."""
    name_lower = name.lower().strip()
    return TRADING_MASTERS.get(name_lower)


def list_all_masters() -> List[str]:
    """List all available trading masters."""
    return list(TRADING_MASTERS.keys())


def get_master_checklist(master_name: str) -> Optional[List[str]]:
    """Get the checklist for a specific master."""
    master = get_master_by_name(master_name)
    return master.checklist if master else None


def analyze_with_master(ticker_data: Dict[str, Any], master_name: str) -> Dict[str, Any]:
    """
    Analyze a ticker using a specific master's methodology.
    
    Args:
        ticker_data: Dict with keys like pe_ratio, pb_ratio, earnings_growth, etc.
        master_name: Name of the master to use
    
    Returns:
        Dict with:
        - master: master name
        - score: 0-100 (how well it matches criteria)
        - passed_criteria: list of criteria that passed
        - failed_criteria: list of criteria that failed
        - recommendation: str (buy/hold/pass)
    """
    master = get_master_by_name(master_name)
    if not master:
        return {"error": f"Master '{master_name}' not found"}
    
    passed = []
    failed = []
    score = 0
    
    criteria = master.screening_criteria
    total_criteria = len(criteria)
    
    for key, requirement in criteria.items():
        if key not in ticker_data:
            continue  # Skip if data not available
        
        value = ticker_data[key]
        
        if isinstance(requirement, dict):
            # Check min/max thresholds
            passed_check = True
            if "min" in requirement and value < requirement["min"]:
                passed_check = False
            if "max" in requirement and value > requirement["max"]:
                passed_check = False
            
            if passed_check:
                passed.append(f"{key}: {value} (meets {requirement.get('description', 'criteria')})")
                score += 100 / total_criteria
            else:
                failed.append(f"{key}: {value} (fails {requirement.get('description', 'criteria')})")
    
    # Determine recommendation
    if score >= 75:
        recommendation = "BUY (Strong match)"
    elif score >= 50:
        recommendation = "HOLD/WATCH (Partial match)"
    else:
        recommendation = "PASS (Weak match)"
    
    return {
        "master": master.name,
        "style": master.style,
        "score": round(score, 1),
        "passed_criteria": passed,
        "failed_criteria": failed,
        "recommendation": recommendation,
        "checklist": master.checklist,
        "risk_rules": master.risk_rules,
    }


def get_master_summary() -> str:
    """Get a formatted summary of all trading masters."""
    lines = ["# Trading Masters Library\n"]
    
    for key, master in TRADING_MASTERS.items():
        lines.append(f"## {master.name}")
        lines.append(f"**Style**: {master.style}")
        lines.append(f"**Timeframe**: {master.timeframe}")
        lines.append(f"**Key Principles**:")
        for principle in master.key_principles:
            lines.append(f"  - {principle}")
        lines.append("")
    
    return "\n".join(lines)
