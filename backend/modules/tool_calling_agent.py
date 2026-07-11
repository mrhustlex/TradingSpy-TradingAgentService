"""
Tool-calling agent module with yfinance integration
Standalone module that doesn't depend on backtrader
"""

from langchain_core.tools import tool
import yfinance as yf
import pandas as pd
import logging
import time
import math
import re
import os
from functools import lru_cache
from datetime import datetime, timedelta

from modules.web_news_tools import get_news, web_search, fetch_website
from modules.orchestration_tools import list_available_strategies, get_strategy_code, list_available_datasets, generate_strategy, run_backtest, download_market_data, check_task_status
from modules.action_tools import ask_user_for_clarification, get_price_chart
from modules.expected_pattern import generate_expected_pattern
from modules.pattern_scanner import scan_bullish_patterns
try:
    from market_intelligence import market_intel
except ImportError:
    from modules.market_intelligence import market_intel
logger = logging.getLogger(__name__)

def _safe_float(value):
    try:
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _round_or_none(value, digits=2):
    f = _safe_float(value)
    return round(f, digits) if f is not None else None


def _tool_invoke(tool_obj, payload: dict) -> dict:
    """Invoke a LangChain tool and normalize errors into data."""
    try:
        result = tool_obj.invoke(payload)
        return result if isinstance(result, dict) else {"result": result}
    except Exception as e:
        logger.warning("Nested tool invoke failed for %s: %s", getattr(tool_obj, "name", "tool"), e)
        return {"error": str(e)}


def _top_search_results(search_result: dict, limit: int = 5) -> list:
    results = search_result.get("results") or []
    trimmed = []
    for item in results[:limit]:
        trimmed.append({
            "title": item.get("title"),
            "snippet": item.get("snippet"),
            "url": item.get("url"),
            "source": item.get("source"),
        })
    return trimmed


FUNDAMENTAL_SCREEN_UNIVERSES = {
    "high-market-cap": ["AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "AVGO", "TSLA", "LLY", "JPM", "V", "MA", "XOM", "WMT", "UNH", "COST", "NFLX", "ORCL", "JNJ"],
    "leverage": ["TQQQ", "SQQQ", "QLD", "QID", "UPRO", "SPXU", "SPXL", "SPXS", "SSO", "SDS", "TNA", "TZA", "UDOW", "SDOW", "SOXL", "SOXS", "TECL", "TECS", "FNGU", "FNGD", "NVDL", "NVDQ", "TSLL", "TSLQ", "LABU", "LABD", "FAS", "FAZ", "BOIL", "KOLD"],
    "semis": ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "ARM", "SMCI", "TSM", "ASML", "MRVL", "AMAT", "LRCX", "KLAC", "TXN", "ADI", "ON", "MCHP"],
    "software-ai": ["MSFT", "ORCL", "CRM", "ADBE", "PLTR", "SNOW", "MDB", "NOW", "DDOG", "NET", "CRWD", "PANW", "ZS", "SHOP", "UBER"],
    "biotech": ["VRTX", "REGN", "GILD", "AMGN", "BIIB", "MRNA", "ALNY", "INCY", "BMRN", "NBIX", "SRPT", "CRSP", "BEAM", "NTLA", "RXRX"],
    "financials": ["JPM", "BAC", "WFC", "C", "GS", "MS", "BLK", "SCHW", "SOFI", "HOOD", "COIN", "V", "MA", "AXP", "PYPL"],
    "healthcare": ["LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "AMGN", "GILD", "BMY", "CVS", "ISRG", "REGN", "VRTX", "ABT"],
    "energy": ["XOM", "CVX", "COP", "SLB", "OXY", "EOG", "MPC", "PSX", "VLO", "HAL", "DVN", "FANG", "KMI", "WMB"],
    "consumer": ["AMZN", "TSLA", "WMT", "COST", "TGT", "HD", "LOW", "MCD", "SBUX", "NKE", "LULU", "DIS", "NFLX", "PG", "KO", "PEP"],
    "industrials": ["GE", "BA", "CAT", "HON", "RTX", "LMT", "MMM", "UPS", "FDX", "DE", "ETN", "EMR", "PH", "ITW"],
    "default": ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "JPM", "BAC", "WFC", "XOM", "CVX", "UNH", "JNJ", "PFE", "WMT", "COST", "HD", "CAT", "GE"],
}


def _screen_universe_symbols(universe: str, max_checked: int) -> list:
    raw = str(universe or "default").strip()
    key = raw.lower()
    if key in FUNDAMENTAL_SCREEN_UNIVERSES:
        symbols = FUNDAMENTAL_SCREEN_UNIVERSES[key]
    else:
        symbols = [s.strip().upper().replace("$", "") for s in raw.split(",") if s.strip()]
    seen = set()
    clean = []
    for symbol in symbols:
        if symbol and symbol not in seen:
            clean.append(symbol)
            seen.add(symbol)
    return clean[:max(1, min(int(max_checked or 30), 60))]


def _fundamental_requirements(requirements: str) -> dict:
    text = (requirements or "").lower()
    strict = any(term in text for term in ["strict", "cheap", "deep value", "low pe", "very undervalued"])
    growth = any(term in text for term in ["growth", "compound", "revenue", "eps growth", "ai", "product"])
    quality = any(term in text for term in ["quality", "profitable", "margin", "moat", "cash flow"])
    dividend = any(term in text for term in ["dividend", "yield", "income"])
    insider = any(term in text for term in ["insider", "insiders", "buying"])
    forward_pe_match = re.search(r"(?:forward\s*)?p/?e\s*(?:under|below|less than|<)\s*(\d+(?:\.\d+)?)", text)
    peg_match = re.search(r"peg\s*(?:under|below|less than|<)\s*(\d+(?:\.\d+)?)", text)
    ps_match = re.search(r"(?:price\s*[/ ]?\s*sales|p/s)\s*(?:under|below|less than|<)\s*(\d+(?:\.\d+)?)", text)
    revenue_match = re.search(r"revenue growth\s*(?:>|over|above|at least)\s*(\d+(?:\.\d+)?)\s*%?", text)
    market_cap_under_match = (
        re.search(r"(?:market\s*cap|mkt\s*cap|capitalization)\s*(?:under|below|less than|<)\s*\$?\s*(\d+(?:\.\d+)?)\s*(t|trillion|b|bn|billion|m|mm|million)?", text)
        or re.search(r"(?:under|below|less than|<)\s*\$?\s*(\d+(?:\.\d+)?)\s*(t|trillion|b|bn|billion|m|mm|million)?\s*(?:market\s*cap|mkt\s*cap|capitalization)", text)
    )
    market_cap_over_match = (
        re.search(r"(?:market\s*cap|mkt\s*cap|capitalization)\s*(?:over|above|greater than|at least|>)\s*\$?\s*(\d+(?:\.\d+)?)\s*(t|trillion|b|bn|billion|m|mm|million)?", text)
        or re.search(r"(?:over|above|greater than|at least|>)\s*\$?\s*(\d+(?:\.\d+)?)\s*(t|trillion|b|bn|billion|m|mm|million)?\s*(?:market\s*cap|mkt\s*cap|capitalization)", text)
    )
    max_forward_pe = 20 if strict else (35 if growth else 25)
    max_peg = 1.5 if strict else 2.2
    max_price_to_sales = 4 if strict else (12 if growth else 6)
    min_revenue_growth = 0.05 if growth else 0
    max_market_cap = None
    min_market_cap = None

    def parse_market_cap(match):
        if not match:
            return None
        value = float(match.group(1))
        unit = (match.group(2) or "b").lower()
        if unit in ("t", "trillion"):
            return value * 1_000_000_000_000
        if unit in ("m", "mm", "million"):
            return value * 1_000_000
        return value * 1_000_000_000

    if forward_pe_match:
        max_forward_pe = float(forward_pe_match.group(1))
    if peg_match:
        max_peg = float(peg_match.group(1))
    if ps_match:
        max_price_to_sales = float(ps_match.group(1))
    if revenue_match:
        raw_growth = float(revenue_match.group(1))
        min_revenue_growth = raw_growth / 100 if raw_growth > 1 else raw_growth
    if market_cap_under_match:
        max_market_cap = parse_market_cap(market_cap_under_match)
    if market_cap_over_match:
        min_market_cap = parse_market_cap(market_cap_over_match)
    if "small cap" in text or "small-cap" in text:
        max_market_cap = max_market_cap or 2_000_000_000
    if "mid cap" in text or "mid-cap" in text:
        min_market_cap = min_market_cap or 2_000_000_000
        max_market_cap = max_market_cap or 10_000_000_000
    if "large cap" in text or "large-cap" in text:
        min_market_cap = min_market_cap or 10_000_000_000

    industry_aliases = {
        "semiconductor": ["semiconductor", "semiconductors"],
        "software": ["software"],
        "bank": ["bank", "banks", "banking"],
        "regional bank": ["regional bank", "regional banks"],
        "healthcare": ["healthcare", "health care"],
        "biotech": ["biotech", "biotechnology"],
        "energy": ["energy", "oil", "gas"],
        "retail": ["retail"],
        "industrial": ["industrial", "industrials"],
        "materials": ["materials", "basic materials"],
        "real estate": ["real estate", "reit", "reits"],
        "utility": ["utility", "utilities"],
        "consumer": ["consumer"],
        "financial": ["financial", "financials"],
        "technology": ["technology", "tech"],
        "communication": ["communication", "communications", "telecom"],
    }
    include_terms = []
    for canonical, aliases in industry_aliases.items():
        if any(re.search(rf"\b{re.escape(alias)}\b", text) for alias in aliases):
            include_terms.append(canonical)
    return {
        "max_forward_pe": max_forward_pe,
        "max_peg": max_peg,
        "max_price_to_sales": max_price_to_sales,
        "min_revenue_growth": min_revenue_growth,
        "min_market_cap": min_market_cap,
        "max_market_cap": max_market_cap,
        "include_industry_terms": include_terms,
        "require_profit_margin": quality or strict,
        "prefer_dividend": dividend,
        "prefer_insiders": insider,
    }


def _metric_label(value, pct=False, digits=2):
    f = _safe_float(value)
    if f is None:
        return "unavailable"
    if pct:
        return f"{f * 100:.1f}%"
    return f"{f:.{digits}f}"


def _market_cap_label(value):
    f = _safe_float(value)
    if f is None:
        return "unavailable"
    if abs(f) >= 1_000_000_000_000:
        return f"${f / 1_000_000_000_000:.2f}T"
    if abs(f) >= 1_000_000_000:
        return f"${f / 1_000_000_000:.2f}B"
    if abs(f) >= 1_000_000:
        return f"${f / 1_000_000:.2f}M"
    return f"${f:.0f}"


def _ratio_to_pct(value):
    """Convert yfinance decimal ratios to explicit percentage-point values."""
    f = _safe_float(value)
    return round(f * 100, 2) if f is not None else None


def _iso_date_from_index(idx) -> str:
    try:
        if hasattr(idx, "isoformat"):
            return idx.isoformat()
        return str(idx)
    except Exception:
        return ""


def _days_old_from_index(idx):
    try:
        ts = pd.Timestamp(idx)
        if ts.tzinfo is not None:
            ts = ts.tz_convert(None)
        return max(0, (pd.Timestamp.utcnow().tz_localize(None).normalize() - ts.normalize()).days)
    except Exception:
        return None


def _recent_return(close, bars: int):
    try:
        if len(close) <= bars:
            return None
        prev = _safe_float(close.iloc[-bars - 1])
        latest = _safe_float(close.iloc[-1])
        return ((latest - prev) / prev) if latest is not None and prev else None
    except Exception:
        return None


def _market_data_dirs() -> list:
    """Return local dataset directories used by the platform."""
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    market_root = os.path.join(backend_dir, "data", "market_data")
    return [
        os.path.join(market_root, "local_user"),
        market_root,
    ]


def _normalize_interval(interval: str) -> str:
    raw = str(interval or "1d").strip()
    aliases = {"1h": "60m", "1hour": "60m", "1hr": "60m", "d": "1d"}
    return aliases.get(raw.lower(), raw)


def _safe_symbol(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9.^=-]", "", str(symbol or "").strip().upper().replace("$", ""))


def _find_local_candle_file(symbol: str, interval: str, period: str = None, extended_hours: bool = False) -> str:
    symbol_l = symbol.lower()
    interval_l = interval.lower()
    period_l = str(period or "").lower()
    candidates = []
    for directory in _market_data_dirs():
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            low = name.lower()
            if not low.endswith((".txt", ".csv")):
                continue
            if not low.startswith(f"{symbol_l}-") and not low.startswith(f"{symbol_l}_"):
                continue
            if f"-{interval_l}-" not in low and f"_{interval_l}_" not in low and f"-{interval_l}." not in low:
                continue
            is_extended_file = "-extended" in low or "_extended" in low
            if bool(extended_hours) != is_extended_file:
                continue
            score = 2 if period_l and period_l in low else 1
            path = os.path.join(directory, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = 0
            candidates.append((score, mtime, path))
    if not candidates:
        return ""
    candidates.sort(reverse=True)
    return candidates[0][2]


def _load_ohlcv_file(filepath: str) -> pd.DataFrame:
    df = pd.read_csv(filepath)
    rename = {}
    for col in df.columns:
        key = str(col).strip().lower()
        if key in {"date", "datetime", "time", "timestamp"}:
            rename[col] = "Date"
        elif key == "open":
            rename[col] = "Open"
        elif key == "high":
            rename[col] = "High"
        elif key == "low":
            rename[col] = "Low"
        elif key == "close":
            rename[col] = "Close"
        elif key in {"volume", "vol"}:
            rename[col] = "Volume"
    df = df.rename(columns=rename)
    required = ["Open", "High", "Low", "Close", "Volume"]
    if "Date" not in df.columns or not all(col in df.columns for col in required):
        raise ValueError("Dataset must contain Date/Open/High/Low/Close/Volume columns")
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    for col in required:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["Date", "Open", "High", "Low", "Close"]).sort_values("Date")
    df["Volume"] = df["Volume"].fillna(0)
    return df


def _history_to_ohlcv_df(hist: pd.DataFrame) -> pd.DataFrame:
    if hist is None or hist.empty:
        return pd.DataFrame()
    if isinstance(hist.columns, pd.MultiIndex):
        hist.columns = hist.columns.get_level_values(0)
    df = hist.reset_index()
    date_col = "Date" if "Date" in df.columns else "Datetime"
    df = df.rename(columns={date_col: "Date"})
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce").dt.tz_localize(None)
    for col in ["Open", "High", "Low", "Close", "Volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.dropna(subset=["Date", "Open", "High", "Low", "Close"]).sort_values("Date")


def _add_candle_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    prev_close = out["Close"].shift(1)
    candle_range = (out["High"] - out["Low"]).replace(0, pd.NA)
    out["change_pct"] = ((out["Close"] - prev_close) / prev_close) * 100
    out["gap_pct"] = ((out["Open"] - prev_close) / prev_close) * 100
    out["range_pct"] = ((out["High"] - out["Low"]) / out["Open"]) * 100
    out["body_pct"] = ((out["Close"] - out["Open"]) / out["Open"]) * 100
    out["close_location_pct"] = ((out["Close"] - out["Low"]) / candle_range) * 100
    out["volume_avg_20"] = out["Volume"].rolling(20).mean()
    out["volume_ratio"] = out["Volume"] / out["volume_avg_20"]
    out["sma_20"] = out["Close"].rolling(20).mean()
    out["sma_50"] = out["Close"].rolling(50).mean()
    out["rsi_14"] = calculate_rsi(out["Close"], 14)
    return out


def _compact_candles(df: pd.DataFrame) -> list:
    candles = []
    for _, row in df.iterrows():
        candles.append({
            "time": pd.Timestamp(row["Date"]).isoformat(),
            "open": _round_or_none(row["Open"], 4),
            "high": _round_or_none(row["High"], 4),
            "low": _round_or_none(row["Low"], 4),
            "close": _round_or_none(row["Close"], 4),
            "volume": int(_safe_float(row["Volume"]) or 0),
            "change_pct": _round_or_none(row.get("change_pct"), 3),
            "gap_pct": _round_or_none(row.get("gap_pct"), 3),
            "range_pct": _round_or_none(row.get("range_pct"), 3),
            "body_pct": _round_or_none(row.get("body_pct"), 3),
            "close_location_pct": _round_or_none(row.get("close_location_pct"), 1),
            "volume_ratio": _round_or_none(row.get("volume_ratio"), 2),
            "sma_20": _round_or_none(row.get("sma_20"), 4),
            "sma_50": _round_or_none(row.get("sma_50"), 4),
            "rsi_14": _round_or_none(row.get("rsi_14"), 2),
        })
    return candles


def _safe_headline_items(symbol: str, limit: int = 3) -> list:
    try:
        items = market_intel.get_ticker_news(symbol, limit) or []
        return [
            {
                "title": item.get("title"),
                "publisher": item.get("publisher"),
                "link": item.get("link"),
                "published": item.get("published"),
            }
            for item in items[:limit]
            if item.get("title")
        ]
    except Exception as exc:
        logger.warning("headline fetch failed for %s: %s", symbol, exc)
        return []


def _options_overview(symbol: str) -> dict:
    try:
        t = yf.Ticker(symbol)
        expirations = list(t.options or [])
        if not expirations:
            return {"available": False, "message": "No listed options expirations returned"}
        nearest = expirations[0]
        chain = t.option_chain(nearest)
        calls = chain.calls
        puts = chain.puts
        call_iv = _safe_float(calls["impliedVolatility"].dropna().median()) if "impliedVolatility" in calls else None
        put_iv = _safe_float(puts["impliedVolatility"].dropna().median()) if "impliedVolatility" in puts else None
        call_volume = int(_safe_float(calls.get("volume", pd.Series(dtype=float)).fillna(0).sum()) or 0)
        put_volume = int(_safe_float(puts.get("volume", pd.Series(dtype=float)).fillna(0).sum()) or 0)
        return {
            "available": True,
            "expiration_count": len(expirations),
            "nearest_expiration": nearest,
            "sample_expirations": expirations[:6],
            "nearest_call_count": len(calls),
            "nearest_put_count": len(puts),
            "nearest_put_call_volume_ratio": round(put_volume / call_volume, 2) if call_volume else None,
            "median_call_iv": call_iv,
            "median_put_iv": put_iv,
        }
    except Exception as exc:
        logger.warning("options overview failed for %s: %s", symbol, exc)
        return {"available": False, "error": str(exc)}


def _summarize_insider_data(insider_data: dict) -> dict:
    trades = insider_data.get("trades") or insider_data.get("transactions") or []
    summary = {
        "total": insider_data.get("total", len(trades)),
        "open_market_buy_count": 0,
        "open_market_sell_count": 0,
        "grant_or_award_count": 0,
        "other_count": 0,
        "open_market_buy_value": 0.0,
        "open_market_sell_value": 0.0,
        "sample": trades[:5],
        "interpretation_note": "Stock awards/grants are separated from open-market buys because they are not the same signal.",
    }
    for trade in trades:
        tx_type = str(trade.get("transaction_type") or "").lower()
        last_tx = str(trade.get("last_tx") or trade.get("text") or "").lower()
        value = _safe_float(trade.get("value")) or 0.0
        price = _safe_float(trade.get("price")) or 0.0
        is_grant = price == 0 or "award" in last_tx or "grant" in last_tx
        if is_grant:
            summary["grant_or_award_count"] += 1
        elif "buy" in tx_type or "purchase" in last_tx:
            summary["open_market_buy_count"] += 1
            summary["open_market_buy_value"] += value
        elif "sell" in tx_type or "sale" in last_tx:
            summary["open_market_sell_count"] += 1
            summary["open_market_sell_value"] += value
        else:
            summary["other_count"] += 1
    summary["open_market_buy_value"] = round(summary["open_market_buy_value"], 2)
    summary["open_market_sell_value"] = round(summary["open_market_sell_value"], 2)
    return summary


def _classify_insider_trade(trade: dict) -> str:
    tx_type = str(trade.get("transaction_type") or "").lower()
    tx_text = " ".join(
        str(trade.get(key) or "")
        for key in ("last_tx", "text", "ownership_change")
    ).lower()
    price = _safe_float(trade.get("price")) or 0.0
    if price == 0 or "award" in tx_text or "grant" in tx_text:
        return "grant_or_award"
    if "sell" in tx_type or "sale" in tx_text or "disposed" in tx_text:
        return "open_market_sell"
    if "buy" in tx_type or "purchase" in tx_text or "acq" in tx_text:
        return "open_market_buy"
    return "other"


def _compact_insider_trade(trade: dict) -> dict:
    return {
        "ticker": trade.get("ticker"),
        "date": trade.get("date"),
        "insider": trade.get("insider"),
        "position": trade.get("position"),
        "transaction_type": trade.get("transaction_type"),
        "shares": trade.get("shares"),
        "price": trade.get("price"),
        "value": trade.get("value"),
        "portfolio_pct": trade.get("portfolio_pct"),
        "last_tx": trade.get("last_tx"),
        "text": trade.get("text"),
    }


# ── Caching Layer ─────────────────────────────────────────────────────────────
# Cache results for 60 seconds to reduce API calls by 80%+

_cache = {}
_cache_ttl = {}

def cached_call(cache_key: str, ttl_seconds: int = 60):
    """Decorator for caching function results with TTL"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            key = f"{cache_key}:{args}:{kwargs}"
            now = time.time()
            
            # Check if cached and not expired
            if key in _cache and key in _cache_ttl:
                if now < _cache_ttl[key]:
                    logger.info(f"Cache hit: {cache_key}")
                    return _cache[key]
            
            # Call function and cache result
            result = func(*args, **kwargs)
            _cache[key] = result
            _cache_ttl[key] = now + ttl_seconds
            return result
        return wrapper
    return decorator

# ── yfinance Tools with Retry Logic ──────────────────────────────────────────

@tool
def get_quote(ticker: str) -> dict:
    """Get real-time price quote for a stock ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM, NVDA
    """
    return _get_quote_cached(ticker.upper())

@cached_call("quote", ttl_seconds=60)
def _get_quote_cached(ticker: str) -> dict:
    """Cached implementation of get_quote"""
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            # Use daily bars for stable quote context, then add freshness metadata.
            hist = t.history(period="3mo", interval="1d")
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
            latest = hist.iloc[-1]
            latest_idx = hist.index[-1]
            price = _safe_float(latest.get("Close"))
            if price is None:
                return {"symbol": ticker, "error": "No close price available"}
            prev = _safe_float(hist.iloc[-2].get("Close")) if len(hist) > 1 else price
            chg = price - prev
            volume = _safe_float(latest.get("Volume")) or 0
            avg_volume_30d = _safe_float(hist["Volume"].tail(30).mean()) if "Volume" in hist else None
            
            # Try to get info, but don't fail if rate limited
            try:
                info = t.info
                name = info.get("shortName", ticker)
                market_cap = info.get("marketCap")
                pe_ratio = info.get("trailingPE")
                current_price = _safe_float(info.get("currentPrice") or info.get("regularMarketPrice"))
                regular_market_time = info.get("regularMarketTime")
                if current_price is not None:
                    price = current_price
            except:
                info = {}
                name = ticker
                market_cap = None
                pe_ratio = None
                regular_market_time = None
            
            return {
                "symbol": ticker,
                "name": name,
                "price": round(price, 2),
                "change": round(chg, 2),
                "change_percent": round(chg / prev * 100 if prev else 0, 2),
                "volume": int(volume),
                "avg_volume_30d": int(avg_volume_30d) if avg_volume_30d is not None else None,
                "relative_volume_30d": round(volume / avg_volume_30d, 2) if avg_volume_30d else None,
                "high": _round_or_none(latest.get("High")),
                "low": _round_or_none(latest.get("Low")),
                "market_cap": market_cap,
                "pe_ratio": pe_ratio,
                "return_5d": _recent_return(hist["Close"], 5),
                "return_1mo": _recent_return(hist["Close"], 21),
                "latest_bar": _iso_date_from_index(latest_idx),
                "latest_bar_age_days": _days_old_from_index(latest_idx),
                "regular_market_time": regular_market_time,
                "fetched_at": datetime.now().isoformat(),
                "source": "yfinance daily history + ticker info/regularMarketPrice when available",
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_quote attempt {attempt+1} failed, retrying...")
                time.sleep(2)  # Longer delay for rate limits
            else:
                logger.error(f"get_quote failed after 3 attempts: {e}")
                return {"symbol": ticker, "error": f"Rate limited or no data"}


@tool
def get_technicals(ticker: str) -> dict:
    """Get technical indicators: RSI, moving averages, trend analysis.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    return _get_technicals_cached(ticker.upper())

@cached_call("technicals", ttl_seconds=300)  # 5 min cache for technicals
def _get_technicals_cached(ticker: str) -> dict:
    """Cached implementation of get_technicals"""
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="6mo")
            if hist.empty:
                return {"symbol": ticker, "error": "No data"}
            
            close = hist["Close"]
            sma20 = close.rolling(20).mean().iloc[-1] if len(close) >= 20 else None
            sma50 = close.rolling(50).mean().iloc[-1] if len(close) >= 50 else None
            delta = close.diff()
            gain = delta.where(delta > 0, 0).rolling(14).mean()
            loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
            rsi = (100 - 100 / (1 + gain / loss)).iloc[-1]
            
            price = float(close.iloc[-1])
            trend = "neutral"
            if sma20 and sma50:
                if price > float(sma20) > float(sma50):
                    trend = "bullish"
                elif price < float(sma20) < float(sma50):
                    trend = "bearish"
            
            return {
                "symbol": ticker,
                "price": round(price, 2),
                "rsi_14": round(float(rsi), 2) if rsi and not pd.isna(rsi) else None,
                "sma_20": round(float(sma20), 2) if sma20 and not pd.isna(sma20) else None,
                "sma_50": round(float(sma50), 2) if sma50 and not pd.isna(sma50) else None,
                "trend": trend,
                "support": round(float(close.tail(20).min()), 2),
                "resistance": round(float(close.tail(20).max()), 2),
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_technicals attempt {attempt+1} failed, retrying...")
                time.sleep(2)
            else:
                logger.error(f"get_technicals failed: {e}")
                return {"symbol": ticker, "error": "Rate limited or no data"}


@tool
def search_ticker(query: str) -> dict:
    """Search for stocks by company name or partial ticker.
    Args:
        query: Company name or partial ticker e.g. 'Apple', 'Tesla', 'Nvidia'
    """
    for attempt in range(3):
        try:
            search = yf.Search(query, max_results=10)
            quotes = search.quotes if hasattr(search, 'quotes') else []
            results = []
            for q in quotes[:10]:
                results.append({
                    "symbol": q.get("symbol", ""),
                    "name": q.get("shortname", q.get("longname", "")),
                    "type": q.get("quoteType", ""),
                    "exchange": q.get("exchange", ""),
                })
            return {"query": query, "results": results, "count": len(results)}
        except Exception as e:
            if attempt < 2:
                logger.warning(f"search_ticker attempt {attempt+1} failed, retrying...")
                time.sleep(1)
            else:
                logger.error(f"search_ticker failed: {e}")
                return {"query": query, "error": str(e), "results": []}


@tool
def get_ticker_info(ticker: str) -> dict:
    """Get company info: sector, industry, website, description.
    Args:
        ticker: Stock symbol e.g. AAPL, NVDA, TSLA
    """
    return _get_ticker_info_cached(ticker.upper())

@cached_call("ticker_info", ttl_seconds=3600)  # 1 hour cache for company info
def _get_ticker_info_cached(ticker: str) -> dict:
    """Cached implementation of get_ticker_info"""
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            info = t.info
            return {
                "symbol": ticker,
                "name": info.get("shortName", ""),
                "sector": info.get("sector", ""),
                "industry": info.get("industry", ""),
                "website": info.get("website", ""),
                "description": info.get("longBusinessSummary", "")[:300],
                "employees": info.get("fullTimeEmployees", ""),
                "country": info.get("country", ""),
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_ticker_info attempt {attempt+1} failed, retrying...")
                time.sleep(3)  # Longer delay for rate limits
            else:
                logger.error(f"get_ticker_info failed: {e}")
                return {"symbol": ticker, "error": "Rate limited - try again later"}


@tool
def get_fundamentals(ticker: str) -> dict:
    """Get valuation and fundamental metrics for a ticker, including trailing PE, forward PE, EPS growth, beta, margins, target price, and recommendation.
    Args:
        ticker: Stock symbol e.g. AAPL, NVDA, TSLA
    """
    return _get_fundamentals_cached(ticker.upper())

@cached_call("fundamentals", ttl_seconds=1800)
def _get_fundamentals_cached(ticker: str) -> dict:
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            info = t.info
            profit_margin = info.get("profitMargins")
            operating_margin = info.get("operatingMargins")
            revenue_growth = info.get("revenueGrowth")
            earnings_growth = info.get("earningsGrowth")
            quarterly_growth = info.get("earningsQuarterlyGrowth")
            dividend_yield = info.get("dividendYield")
            short_float = info.get("shortPercentOfFloat")
            insider_ownership = info.get("heldPercentInsiders")
            institutional_ownership = info.get("heldPercentInstitutions")
            return {
                "symbol": ticker,
                "name": info.get("shortName") or info.get("longName") or ticker,
                "market_cap": info.get("marketCap"),
                "enterprise_value": info.get("enterpriseValue"),
                "trailing_pe": info.get("trailingPE"),
                "forward_pe": info.get("forwardPE"),
                "peg_ratio": info.get("pegRatio"),
                "price_to_sales": info.get("priceToSalesTrailing12Months"),
                "price_to_book": info.get("priceToBook"),
                "enterprise_to_revenue": info.get("enterpriseToRevenue"),
                "enterprise_to_ebitda": info.get("enterpriseToEbitda"),
                "profit_margin": profit_margin,
                "profit_margin_pct": _ratio_to_pct(profit_margin),
                "operating_margin": operating_margin,
                "operating_margin_pct": _ratio_to_pct(operating_margin),
                "revenue_growth": revenue_growth,
                "revenue_growth_pct": _ratio_to_pct(revenue_growth),
                "earnings_growth": earnings_growth,
                "earnings_growth_pct": _ratio_to_pct(earnings_growth),
                "earnings_quarterly_growth": quarterly_growth,
                "earnings_quarterly_growth_pct": _ratio_to_pct(quarterly_growth),
                "eps_trailing_12m": info.get("trailingEps"),
                "eps_forward": info.get("forwardEps"),
                "beta": info.get("beta"),
                "dividend_yield": dividend_yield,
                "dividend_yield_pct": _ratio_to_pct(dividend_yield),
                "short_percent_float": short_float,
                "short_percent_float_pct": _ratio_to_pct(short_float),
                "held_by_insiders_ratio": insider_ownership,
                "held_by_insiders_pct": _ratio_to_pct(insider_ownership),
                "held_by_institutions_ratio": institutional_ownership,
                "held_by_institutions_pct": _ratio_to_pct(institutional_ownership),
                "target_mean_price": info.get("targetMeanPrice"),
                "target_high_price": info.get("targetHighPrice"),
                "target_low_price": info.get("targetLowPrice"),
                "recommendation": info.get("recommendationKey"),
                "number_of_analyst_opinions": info.get("numberOfAnalystOpinions"),
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_fundamentals attempt {attempt+1} failed, retrying...")
                time.sleep(2)
            else:
                logger.error(f"get_fundamentals failed: {e}")
                return {"symbol": ticker, "error": "Fundamental data unavailable"}


@tool
def get_insider_trades(tickers: list, limit: int = 20, days_back: int = 365) -> dict:
    """Get recent insider trading transactions for one or more tickers, including buys/sells, shares, transaction price, value, insider role, and ownership context.
    Args:
        tickers: A ticker symbol or list of symbols e.g. ["NVDA", "AAPL"]
        limit: Maximum number of transactions to return
        days_back: Lookback window in calendar days
    """
    if isinstance(tickers, str):
        tickers = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    else:
        tickers = [str(t).strip().upper() for t in tickers if str(t).strip()]
    if not tickers:
        return {"trades": [], "total": 0, "error": "No tickers provided"}
    try:
        result = market_intel.get_insider_transactions(tickers[:20], limit=max(1, min(int(limit or 20), 100)), offset=0, days_back=max(1, min(int(days_back or 365), 3650)))
        return result
    except Exception as e:
        logger.error(f"get_insider_trades failed: {e}")
        return {"tickers": tickers, "trades": [], "total": 0, "error": str(e)}


@tool
def screen_industry_insider_activity(
    universe: str = "default",
    days_back: int = 90,
    max_checked: int = 30,
    min_value: float = 0,
    focus: str = "all",
    include_grants: bool = False,
) -> dict:
    """Scan an industry, sector preset, or ticker list for recent notable insider buys/sells.

    Use this when the user asks for recent insider activity across an industry,
    sector, watchlist, or group of stocks, such as "key insider buys in software
    AI stocks" or "recent insider selling in banks".

    Args:
        universe: Preset name (default, high-market-cap, leverage, semis, software-ai, financials, healthcare, energy, consumer, industrials) or comma-separated tickers
        days_back: Calendar-day lookback window
        max_checked: Maximum symbols to scan
        min_value: Minimum transaction value to include for open-market buys/sells
        focus: all, buys, sells, or grants
        include_grants: Whether to include stock awards/grants in notable rows
    """
    focus = str(focus or "all").strip().lower()
    if focus not in {"all", "buy", "buys", "sell", "sells", "grant", "grants"}:
        focus = "all"
    days_back = max(1, min(int(days_back or 90), 3650))
    max_checked = max(1, min(int(max_checked or 30), 60))
    min_value = max(0.0, _safe_float(min_value) or 0.0)
    symbols = _screen_universe_symbols(universe, max_checked)
    if not symbols:
        return {
            "universe": universe,
            "days_back": days_back,
            "checked": 0,
            "matched": 0,
            "rows": [],
            "error": "No symbols resolved for insider scan",
        }

    scan_limit = min(500, max(50, len(symbols) * 20))
    raw = get_insider_trades.invoke({"tickers": symbols, "limit": scan_limit, "days_back": days_back})
    trades = raw.get("trades") or []
    grouped = {symbol: {
        "symbol": symbol,
        "open_market_buy_count": 0,
        "open_market_sell_count": 0,
        "grant_or_award_count": 0,
        "other_count": 0,
        "open_market_buy_value": 0.0,
        "open_market_sell_value": 0.0,
        "largest_buy": None,
        "largest_sell": None,
        "recent_trades": [],
    } for symbol in symbols}

    notable_trades = []
    for trade in trades:
        symbol = str(trade.get("ticker") or "").upper()
        if symbol not in grouped:
            continue
        kind = _classify_insider_trade(trade)
        value = _safe_float(trade.get("value")) or 0.0
        row = grouped[symbol]
        row[f"{kind}_count"] = row.get(f"{kind}_count", 0) + 1
        if kind == "open_market_buy":
            row["open_market_buy_value"] += value
            if row["largest_buy"] is None or value > (_safe_float(row["largest_buy"].get("value")) or 0.0):
                row["largest_buy"] = _compact_insider_trade(trade)
        elif kind == "open_market_sell":
            row["open_market_sell_value"] += value
            if row["largest_sell"] is None or value > (_safe_float(row["largest_sell"].get("value")) or 0.0):
                row["largest_sell"] = _compact_insider_trade(trade)
        if len(row["recent_trades"]) < 5:
            row["recent_trades"].append({**_compact_insider_trade(trade), "classified_as": kind})
        include_for_focus = (
            focus == "all"
            or kind == "open_market_buy" and focus in {"buy", "buys"}
            or kind == "open_market_sell" and focus in {"sell", "sells"}
            or kind == "grant_or_award" and focus in {"grant", "grants"}
        )
        if include_for_focus and (kind != "grant_or_award" or include_grants or focus in {"grant", "grants"}):
            if kind == "grant_or_award" or value >= min_value:
                notable_trades.append({**_compact_insider_trade(trade), "classified_as": kind})

    rows = []
    for row in grouped.values():
        row["open_market_buy_value"] = round(row["open_market_buy_value"], 2)
        row["open_market_sell_value"] = round(row["open_market_sell_value"], 2)
        has_focus_match = (
            focus == "all" and (
                row["open_market_buy_count"] or row["open_market_sell_count"] or (include_grants and row["grant_or_award_count"])
            )
            or focus in {"buy", "buys"} and row["open_market_buy_count"]
            or focus in {"sell", "sells"} and row["open_market_sell_count"]
            or focus in {"grant", "grants"} and row["grant_or_award_count"]
        )
        if has_focus_match:
            rows.append(row)

    rows.sort(
        key=lambda r: (
            r.get("open_market_buy_value", 0) + r.get("open_market_sell_value", 0),
            r.get("open_market_buy_count", 0) + r.get("open_market_sell_count", 0),
        ),
        reverse=True,
    )
    notable_trades.sort(key=lambda t: (_safe_float(t.get("value")) or 0.0, t.get("date") or ""), reverse=True)

    return {
        "universe": universe,
        "symbols": symbols,
        "days_back": days_back,
        "focus": focus,
        "min_value": min_value,
        "include_grants": include_grants,
        "as_of": datetime.now().isoformat(),
        "data_sources": ["TradingSpy /api/intelligence/insider-trades", "yfinance insider_transactions and insider_roster_holders"],
        "checked": len(symbols),
        "total_transactions_returned": raw.get("total", len(trades)),
        "matched": len(rows),
        "rows": rows[:20],
        "notable_trades": notable_trades[:25],
        "ticker_meta": raw.get("ticker_meta") or {},
        "interpretation_note": "Open-market buys/sells are separated from stock awards/grants. Grants are compensation events and should not be treated as insider buy signals.",
    }


@tool
def get_market_overview() -> dict:
    """Get comprehensive global market overview with US, European, and Asian indices.
    Returns major indices from multiple regions with prices, changes, and market sentiment."""
    try:
        # Comprehensive global indices
        indices = {
            # US Indices
            "^GSPC": {"name": "S&P 500", "region": "US", "type": "Large Cap"},
            "^DJI": {"name": "Dow Jones", "region": "US", "type": "Blue Chip"},
            "^IXIC": {"name": "NASDAQ", "region": "US", "type": "Tech Heavy"},
            "^RUT": {"name": "Russell 2000", "region": "US", "type": "Small Cap"},
            "^VIX": {"name": "VIX (Volatility)", "region": "US", "type": "Fear Index"},
            
            # European Indices
            "^STOXX50E": {"name": "STOXX 50", "region": "Europe", "type": "Eurozone"},
            "^FTSE": {"name": "FTSE 100", "region": "Europe", "type": "UK"},
            "^GDAXI": {"name": "DAX", "region": "Europe", "type": "Germany"},
            "^FCHI": {"name": "CAC 40", "region": "Europe", "type": "France"},
            
            # Asian Indices
            "^N225": {"name": "Nikkei 225", "region": "Asia", "type": "Japan"},
            "^HSI": {"name": "Hang Seng", "region": "Asia", "type": "Hong Kong"},
            "000001.SS": {"name": "Shanghai Composite", "region": "Asia", "type": "China"},
            "^AORD": {"name": "ASX 200", "region": "Asia", "type": "Australia"},
            
            # Commodities & Crypto
            "GC=F": {"name": "Gold Futures", "region": "Commodities", "type": "Precious Metal"},
            "CL=F": {"name": "Crude Oil", "region": "Commodities", "type": "Energy"},
            "BTC-USD": {"name": "Bitcoin", "region": "Crypto", "type": "Digital Asset"},
            "ETH-USD": {"name": "Ethereum", "region": "Crypto", "type": "Digital Asset"},
        }
        
        data = {}
        for sym, meta in indices.items():
            try:
                t = yf.Ticker(sym)
                hist = t.history(period="5d")
                if not hist.empty:
                    latest = hist.iloc[-1]
                    info = t.info
                    price = _safe_float(latest.get("Close"))
                    prev = _safe_float(info.get("previousClose")) or _safe_float(latest.get("Open"))
                    if price is None:
                        continue
                    chg = (price - prev) if prev else None
                    chg_pct = (chg / prev * 100) if chg is not None and prev else None
                    
                    # Calculate 5-day trend
                    first_close = _safe_float(hist.iloc[0].get("Close")) if len(hist) > 1 else None
                    five_day_change = ((price - first_close) / first_close * 100) if first_close else None
                    
                    data[sym] = {
                        "name": meta["name"],
                        "region": meta["region"],
                        "type": meta["type"],
                        "price": _round_or_none(price),
                        "change": _round_or_none(chg),
                        "change_percent": _round_or_none(chg_pct),
                        "change_percent_label": f"{_round_or_none(chg_pct):+.2f}%" if _round_or_none(chg_pct) is not None else "unavailable",
                        "5day_change_percent": _round_or_none(five_day_change),
                        "5day_change_percent_label": f"{_round_or_none(five_day_change):+.2f}%" if _round_or_none(five_day_change) is not None else "unavailable",
                        "volume": int(_safe_float(latest.get("Volume")) or 0),
                    }
            except Exception as e:
                logger.debug(f"Failed to get data for {sym}: {e}")
                pass
        
        # Group by region for better analysis
        by_region = {}
        for sym, info in data.items():
            region = info["region"]
            if region not in by_region:
                by_region[region] = []
            by_region[region].append({sym: info})
        
        return {
            "indices": data,
            "by_region": by_region,
            "timestamp": datetime.now().isoformat(),
            "note": "Global market overview including US, European, Asian indices, commodities, and crypto"
        }
    except Exception as e:
        logger.error(f"get_market_overview error: {e}")
        return {"error": str(e)}


@tool
def get_sector_heatmap(tickers: list) -> dict:
    """Get sector/stock heatmap data for specific tickers — returns change_percent, price, volume.
    Args:
        tickers: List of stock/ETF ticker symbols e.g. ["SPY", "QQQ", "IWM"]
    """
    try:
        if isinstance(tickers, str):
            tickers = [t.strip() for t in tickers.split(",")]
        results = {}
        for sym in tickers[:20]:
            try:
                q = _get_quote_cached(sym.upper())
                results[sym.upper()] = {
                    "symbol": q.get("symbol", sym.upper()),
                    "price": q.get("price"),
                    "change_percent": q.get("change_percent"),
                    "change": q.get("change"),
                    "volume": q.get("volume"),
                }
            except Exception:
                continue
        return {"tickers": results, "count": len(results)}
    except Exception as e:
        return {"error": str(e)}

@tool
def get_industry_heatmap(period: str = "1d") -> dict:
    """Get industry/sector heatmap — returns major sector ETFs with performance metrics.
    Args:
        period: Time period (1d, 5d, 1mo, etc.)
    """
    try:
        sector_etfs = {
            "XLP": "Consumer Staples",
            "XLY": "Consumer Cyclical",
            "XLE": "Energy",
            "XLF": "Financial",
            "XLV": "Healthcare",
            "XLI": "Industrials",
            "XLB": "Materials",
            "XLK": "Technology",
            "XLU": "Utilities",
            "XLRE": "Real Estate",
            "XLC": "Communication",
            "SMH": "Semiconductors",
            "IBB": "Biotechnology",
            "ARKK": "Innovation/ARK",
        }
        sectors_data = {}
        for sym, sector_name in sector_etfs.items():
            try:
                q = _get_quote_cached(sym)
                sectors_data[sym] = {
                    "name": sector_name,
                    "price": q.get("price"),
                    "change_percent": q.get("change_percent"),
                    "change": q.get("change"),
                    "volume": q.get("volume"),
                }
            except Exception:
                continue
        return {"sectors": sectors_data, "count": len(sectors_data)}
    except Exception as e:
        return {"error": str(e)}

@tool
def get_earnings_dates(ticker: str) -> dict:
    """Get upcoming earnings dates and historical earnings for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, NVDA
    """
    ticker = ticker.upper()
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            info = t.info
            return {
                "symbol": ticker,
                "earnings_date": info.get("earningsDate", ""),
                "earnings_average": info.get("epsTrailingTwelveMonths", ""),
                "earnings_growth": info.get("earningsGrowth", ""),
                "next_earnings_date": info.get("nextFiscalYearEnd", ""),
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_earnings_dates attempt {attempt+1} failed, retrying...")
                time.sleep(3)
            else:
                logger.error(f"get_earnings_dates failed: {e}")
                return {"symbol": ticker, "error": "Rate limited - try again later"}


@tool
def get_dividends(ticker: str) -> dict:
    """Get dividend history and yield for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, NVDA
    """
    ticker = ticker.upper()
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            divs = t.dividends
            
            # Check if dividends is empty (could be Series or list)
            if divs is None or (hasattr(divs, 'empty') and divs.empty) or (isinstance(divs, list) and len(divs) == 0):
                return {"symbol": ticker, "dividends": [], "message": "No dividend data available"}
            
            # Convert to list if it's a Series
            if hasattr(divs, 'tail'):
                recent = divs.tail(12)
                div_list = [{"date": str(d.date()), "amount": float(v)} for d, v in recent.items()]
                annual_div = divs.tail(4).sum()
            else:
                # If it's already a list
                div_list = []
                annual_div = 0
            
            # Try to get current price for yield calculation
            try:
                info = t.info
                current_price = info.get("currentPrice", 0)
            except:
                current_price = 0
            
            div_yield = (annual_div / current_price * 100) if current_price else 0
            
            return {
                "symbol": ticker,
                "dividends": div_list,
                "annual_dividend": round(float(annual_div), 2) if annual_div else 0,
                "dividend_yield_pct": round(float(div_yield), 2) if div_yield else 0,
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_dividends attempt {attempt+1} failed, retrying...")
                time.sleep(3)
            else:
                logger.error(f"get_dividends failed: {e}")
                return {"symbol": ticker, "error": "Rate limited or no dividend data"}


@tool
def get_options_chain(ticker: str) -> dict:
    """Get options chain data: available expiration dates and strike prices.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, NVDA
    """
    ticker = ticker.upper()
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            expirations = t.options
            
            if not expirations:
                return {"symbol": ticker, "message": "No options data available"}
            
            first_exp = expirations[0]
            chain = t.option_chain(first_exp)
            calls = chain.calls
            puts = chain.puts
            
            return {
                "symbol": ticker,
                "available_expirations": expirations[:10],
                "first_expiration": first_exp,
                "call_count": len(calls),
                "put_count": len(puts),
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_options_chain attempt {attempt+1} failed, retrying...")
                time.sleep(1)
            else:
                logger.error(f"get_options_chain failed: {e}")
                return {"symbol": ticker, "error": f"Failed: {str(e)[:50]}"}


@tool
def get_chart_data(ticker: str, period: str = "1mo", interval: str = "1d") -> dict:
    """Get OHLCV chart data for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, NVDA
        period: Time period e.g. '1mo', '3mo', '1y', '5y' (default: 1mo)
        interval: Candle interval e.g. '1m', '5m', '1h', '1d' (default: 1d)
    """
    ticker = ticker.upper()
    for attempt in range(3):
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period=period, interval=interval)
            
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
            data = []
            for idx, row in hist.tail(50).iterrows():
                data.append({
                    "date": idx.isoformat(),
                    "open": round(float(row["Open"]), 2),
                    "high": round(float(row["High"]), 2),
                    "low": round(float(row["Low"]), 2),
                    "close": round(float(row["Close"]), 2),
                    "volume": int(row["Volume"])
                })
            
            return {
                "symbol": ticker,
                "period": period,
                "interval": interval,
                "data": data,
                "count": len(data)
            }
        except Exception as e:
            if attempt < 2:
                logger.warning(f"get_chart_data attempt {attempt+1} failed, retrying...")
                time.sleep(1)
            else:
                logger.error(f"get_chart_data failed: {e}")
                return {"symbol": ticker, "error": f"Failed: {str(e)[:50]}"}



@tool
def read_market_data(filename: str, limit: int = 100) -> dict:
    """Read candlestick data from a local market data file with technical indicators.
    
    Args:
        filename: Name of the CSV file to read (e.g. 'AAPL_1d.csv', 'TSLA.txt')
        limit: Number of recent candles to return (default: 100, max: 500)
    
    Returns candlestick data with SMA 20, SMA 50, and RSI 14 indicators.
    """
    try:
        import os
        
        clean_name = os.path.basename(str(filename or ""))
        if clean_name != filename or not clean_name.endswith((".txt", ".csv")):
            return {"success": False, "error": "Invalid filename"}
        filepath = ""
        for data_dir in _market_data_dirs():
            base_dir = os.path.realpath(data_dir)
            candidate = os.path.realpath(os.path.join(base_dir, clean_name))
            if os.path.commonpath([base_dir, candidate]) == base_dir and os.path.exists(candidate):
                filepath = candidate
                break
        
        if not filepath:
            return {
                "success": False,
                "error": f"File not found: {filename}",
                "hint": "Use list_available_datasets() to see available files, or download_market_data() to download new data"
            }
        
        df = pd.read_csv(filepath)
        
        required_cols = ['Open', 'High', 'Low', 'Close', 'Volume']
        if not all(col in df.columns for col in required_cols):
            return {
                "success": False,
                "error": f"Missing required columns. Need: {required_cols}",
                "hint": "Make sure the file is in CSV format with OHLCV data"
            }
        
        limit = min(limit, 500)
        recent_data = df.tail(limit).copy()
        
        recent_data['SMA_20'] = recent_data['Close'].rolling(20).mean()
        recent_data['SMA_50'] = recent_data['Close'].rolling(50).mean()
        recent_data['RSI'] = calculate_rsi(recent_data['Close'], 14)
        
        candles = []
        for idx, row in recent_data.iterrows():
            candles.append({
                "date": str(row.get('Date', idx)),
                "open": float(row['Open']),
                "high": float(row['High']),
                "low": float(row['Low']),
                "close": float(row['Close']),
                "volume": int(row['Volume']),
                "sma_20": float(row['SMA_20']) if pd.notna(row['SMA_20']) else None,
                "sma_50": float(row['SMA_50']) if pd.notna(row['SMA_50']) else None,
                "rsi": float(row['RSI']) if pd.notna(row['RSI']) else None,
            })
        
        return {
            "success": True,
            "filename": filename,
            "total_rows": len(df),
            "returned_rows": len(candles),
            "candles": candles,
            "summary": {
                "current_price": float(recent_data['Close'].iloc[-1]),
                "high_52w": float(recent_data['High'].max()),
                "low_52w": float(recent_data['Low'].min()),
                "avg_volume": int(recent_data['Volume'].mean()),
                "price_change": float(recent_data['Close'].iloc[-1] - recent_data['Close'].iloc[0]),
                "price_change_pct": float(((recent_data['Close'].iloc[-1] - recent_data['Close'].iloc[0]) / recent_data['Close'].iloc[0]) * 100)
            }
        }
    except Exception as e:
        logger.error(f"Error reading market data: {e}")
        return {
            "success": False,
            "error": str(e),
            "hint": "Make sure the file exists and is in CSV format with OHLCV data"
        }


@tool
def read_candles(
    ticker: str,
    interval: str = "5m",
    period: str = "5d",
    limit: int = 80,
    start: str = None,
    end: str = None,
    prefer_local: bool = True,
    extended_hours: bool = False,
) -> dict:
    """Read a compact slice of OHLCV candles for short-timeframe trading analysis.

    Use this for intraday/short-timeframe questions such as "read the last 30
    5m candles", "opening range", "what did the recent candles do", "volume
    spike in the last hour", or "scalp setup from candle data".

    If a matching local dataset exists, it is used. If not, the tool downloads
    the dataset into the platform market-data folder, then reads it. If saving
    fails, it falls back to a direct yfinance history request.

    Args:
        ticker: Stock/ETF symbol e.g. AAPL, MU, QQQ, TSLA
        interval: Candle interval: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d
        period: yfinance period/window e.g. 1d, 5d, 1mo, 3mo, 1y
        limit: Number of candles to return, max 300
        start: Optional ISO date/time lower bound
        end: Optional ISO date/time upper bound
        prefer_local: Use existing local dataset when available
        extended_hours: Include premarket/postmarket candles when downloading or reading matching local data
    """
    symbol = _safe_symbol(ticker)
    if not symbol:
        return {"success": False, "error": "ticker is required"}

    iv = _normalize_interval(interval)
    valid_intervals = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"}
    if iv not in valid_intervals:
        return {
            "success": False,
            "symbol": symbol,
            "error": f"Unsupported interval '{interval}'. Use one of: {', '.join(sorted(valid_intervals))}",
        }

    valid_periods = {"1d", "5d", "7d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"}
    if str(period) not in valid_periods:
        return {
            "success": False,
            "symbol": symbol,
            "error": f"Unsupported period '{period}'. Use one of: {', '.join(sorted(valid_periods))}",
        }

    limit = max(1, min(int(limit or 80), 300))
    path = _find_local_candle_file(symbol, iv, period, extended_hours=extended_hours) if prefer_local else ""
    source = "local_dataset" if path else ""
    downloaded = False

    if not path:
        try:
            from modules.downloader import download_ticker_data
            out_dir = _market_data_dirs()[0]
            os.makedirs(out_dir, exist_ok=True)
            path = download_ticker_data(symbol, interval=iv, period=period, output_dir=out_dir, extended_hours=extended_hours)
            downloaded = bool(path)
            source = "downloaded_dataset" if path else ""
        except Exception as exc:
            logger.warning("read_candles dataset download failed for %s %s/%s: %s", symbol, iv, period, exc)

    df = pd.DataFrame()
    filename = None
    try:
        if path and os.path.exists(path):
            df = _load_ohlcv_file(path)
            filename = os.path.basename(path)
    except Exception as exc:
        logger.warning("read_candles local read failed for %s: %s", path, exc)
        df = pd.DataFrame()

    if df.empty:
        try:
            hist = yf.Ticker(symbol).history(period=period, interval=iv, auto_adjust=True, prepost=bool(extended_hours))
            df = _history_to_ohlcv_df(hist)
            source = "live_yfinance_fallback"
        except Exception as exc:
            return {
                "success": False,
                "symbol": symbol,
                "interval": iv,
                "period": period,
                "error": f"Unable to load candle data: {str(exc)[:120]}",
            }

    if df.empty:
        return {
            "success": False,
            "symbol": symbol,
            "interval": iv,
            "period": period,
            "error": "No OHLCV candles returned for this ticker/timeframe",
            "hint": "Check the ticker, try a wider period, or use a less granular interval.",
        }

    if start:
        start_ts = pd.to_datetime(start, errors="coerce")
        if pd.notna(start_ts):
            if getattr(start_ts, "tzinfo", None):
                start_ts = start_ts.tz_convert(None)
            df = df[df["Date"] >= start_ts]
    if end:
        end_ts = pd.to_datetime(end, errors="coerce")
        if pd.notna(end_ts):
            if getattr(end_ts, "tzinfo", None):
                end_ts = end_ts.tz_convert(None)
            df = df[df["Date"] <= end_ts]

    if df.empty:
        return {
            "success": False,
            "symbol": symbol,
            "interval": iv,
            "period": period,
            "error": "Candles exist, but none matched the requested start/end slice",
        }

    featured = _add_candle_features(df)
    sliced = featured.tail(limit)
    latest = sliced.iloc[-1]
    first = sliced.iloc[0]
    change_from_slice_start = None
    first_close = _safe_float(first["Close"])
    latest_close = _safe_float(latest["Close"])
    if first_close and latest_close is not None:
        change_from_slice_start = ((latest_close - first_close) / first_close) * 100

    short_interval_note = None
    if iv in {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}:
        short_interval_note = "Intraday history availability is limited by the data provider; recent windows are usually more reliable."

    return {
        "success": True,
        "symbol": symbol,
        "interval": iv,
        "period": period,
        "extended_hours": bool(extended_hours),
        "source": source or "unknown",
        "downloaded_now": downloaded,
        "filename": filename,
        "total_rows": int(len(featured)),
        "returned_rows": int(len(sliced)),
        "window": {
            "start": pd.Timestamp(sliced["Date"].iloc[0]).isoformat(),
            "end": pd.Timestamp(sliced["Date"].iloc[-1]).isoformat(),
        },
        "summary": {
            "latest_close": _round_or_none(latest.get("Close"), 4),
            "latest_change_pct": _round_or_none(latest.get("change_pct"), 3),
            "latest_range_pct": _round_or_none(latest.get("range_pct"), 3),
            "latest_close_location_pct": _round_or_none(latest.get("close_location_pct"), 1),
            "latest_volume_ratio": _round_or_none(latest.get("volume_ratio"), 2),
            "slice_change_pct": _round_or_none(change_from_slice_start, 3),
            "slice_high": _round_or_none(sliced["High"].max(), 4),
            "slice_low": _round_or_none(sliced["Low"].min(), 4),
            "avg_range_pct": _round_or_none(sliced["range_pct"].mean(), 3),
            "avg_volume": int(_safe_float(sliced["Volume"].mean()) or 0),
            "rsi_14": _round_or_none(latest.get("rsi_14"), 2),
        },
        "candles": _compact_candles(sliced),
        "note": short_interval_note,
    }


@tool
def get_stock_deep_dive(ticker: str, focus: str = "full", include_web: bool = True) -> dict:
    """Collect a deep stock research packet for a ticker.

    Use this for broad stock analysis questions such as "is X a good stock",
    "what is the bull/bear case", "what products are driving growth", or
    "analyze X using news, insiders, fundamentals, and catalysts".

    Args:
        ticker: Stock symbol e.g. NVDA, CRWD, AAPL
        focus: Optional focus such as full, growth, product, valuation, insiders, catalyst, risk
        include_web: Whether to include web search results for product/growth/catalyst context
    """
    symbol = str(ticker or "").strip().upper().replace("$", "")
    if not symbol:
        return {"error": "ticker is required"}

    quote = _get_quote_cached(symbol)
    technicals = _get_technicals_cached(symbol)
    info = _get_ticker_info_cached(symbol)
    fundamentals = _get_fundamentals_cached(symbol)
    insiders = get_insider_trades.invoke({"tickers": [symbol], "limit": 20, "days_back": 365})

    news = {}
    try:
        news_items = market_intel.get_ticker_news(symbol, 8)
        news = {"symbol": symbol, "news": news_items, "count": len(news_items or [])}
    except Exception as e:
        news = {"symbol": symbol, "news": [], "error": str(e)}

    web = {}
    if include_web:
        company_name = info.get("name") or fundamentals.get("name") or symbol
        queries = {
            "recent_catalysts": f"{symbol} {company_name} stock latest news catalysts growth product demand",
            "product_growth": f"{company_name} key products revenue growth customers market share",
            "bear_risks": f"{symbol} {company_name} stock risks competition valuation slowdown",
        }
        if focus and focus != "full":
            queries["user_focus"] = f"{symbol} {company_name} {focus} analysis latest"
        for key, query in queries.items():
            search_data = _tool_invoke(web_search, {"query": query})
            results = _top_search_results(search_data, 5)
            web[key] = {
                "query": query,
                "results": results,
                "count": len(results),
                "source": search_data.get("source"),
                "warning": search_data.get("message") if not results else None,
            }

    sector_context = {}
    sector = (info.get("sector") or "").lower()
    industry = (info.get("industry") or "").lower()
    if any(term in f"{sector} {industry}" for term in ["semiconductor", "chip"]):
        sector_context["proxy"] = "SMH"
    elif any(term in f"{sector} {industry}" for term in ["software", "internet", "technology"]):
        sector_context["proxy"] = "XLK"
    elif "financial" in sector:
        sector_context["proxy"] = "XLF"
    elif "health" in sector:
        sector_context["proxy"] = "XLV"
    elif "energy" in sector:
        sector_context["proxy"] = "XLE"
    if sector_context.get("proxy"):
        sector_context["heatmap"] = get_sector_heatmap.invoke({"tickers": [sector_context["proxy"], symbol]})

    return {
        "symbol": symbol,
        "focus": focus,
        "as_of": datetime.now().isoformat(),
        "quote": quote,
        "technicals": technicals,
        "company": info,
        "fundamentals": fundamentals,
        "insider_trades": insiders,
        "news": news,
        "web_research": web,
        "sector_context": sector_context,
        "analysis_prompt": (
            "Synthesize this evidence into a bull case, bear case, catalyst watchlist, "
            "valuation/technical read, and practical conclusion. Mention missing/stale fields explicitly."
        ),
    }


@tool
def screen_undervalued_stocks(
    universe: str = "default",
    requirements: str = "undervalued fundamentals with positive growth and profitability",
    max_results: int = 5,
    max_checked: int = 30,
    include_insiders: bool = True,
    include_news: bool = True,
    include_options: bool = True,
    include_market_context: bool = True,
) -> dict:
    """Search a ticker universe for fundamentally undervalued stock candidates.

    Use this when the user asks to keep searching for undervalued stocks or asks
    for a value/fundamental screen with custom requirements.

    Args:
        universe: Preset name (default, high-market-cap, leverage, semis, software-ai, financials, healthcare, energy, consumer, industrials) or comma-separated tickers
        requirements: Natural language filters such as "profitable growth, PEG under 2, forward PE under 30, insider buying preferred"
        max_results: Number of passing candidates to return
        max_checked: Maximum symbols to inspect this round
        include_insiders: Whether to fetch insider trades for promising candidates
        include_news: Whether to attach recent headlines to passing candidates
        include_options: Whether to attach a lightweight options/expiration overview to passing candidates
        include_market_context: Whether to include broad market and sector backdrop
    """
    max_results = max(1, min(int(max_results or 5), 10))
    max_checked = max(max_results, min(int(max_checked or 30), 60))
    symbols = _screen_universe_symbols(universe, max_checked)
    req = _fundamental_requirements(requirements)
    accepted = []
    rejected = []
    market_context = {}
    if include_market_context:
        market_context = {
            "overview": _tool_invoke(get_market_overview, {}),
            "industry_heatmap": _tool_invoke(get_industry_heatmap, {"period": "1d"}),
            "fetched_at": datetime.now().isoformat(),
            "source": "yfinance market overview and sector ETF proxies",
        }

    for symbol in symbols:
        fundamentals = _get_fundamentals_cached(symbol)
        quote = _get_quote_cached(symbol)
        technicals = _get_technicals_cached(symbol)
        info = _get_ticker_info_cached(symbol)

        if fundamentals.get("error"):
            rejected.append({"symbol": symbol, "reason": fundamentals.get("error")})
            continue

        forward_pe = _safe_float(fundamentals.get("forward_pe"))
        trailing_pe = _safe_float(fundamentals.get("trailing_pe"))
        peg = _safe_float(fundamentals.get("peg_ratio"))
        ps = _safe_float(fundamentals.get("price_to_sales"))
        revenue_growth = _safe_float(fundamentals.get("revenue_growth"))
        earnings_growth = _safe_float(fundamentals.get("earnings_growth"))
        profit_margin = _safe_float(fundamentals.get("profit_margin"))
        operating_margin = _safe_float(fundamentals.get("operating_margin"))
        target = _safe_float(fundamentals.get("target_mean_price"))
        price = _safe_float(quote.get("price")) or _safe_float(technicals.get("price"))
        analyst_upside = ((target - price) / price) if target and price else None
        market_cap = _safe_float(fundamentals.get("market_cap")) or _safe_float(info.get("market_cap"))
        sector = info.get("sector")
        industry = info.get("industry")
        sector_industry_text = f"{sector or ''} {industry or ''}".lower()

        if req.get("include_industry_terms"):
            terms = req["include_industry_terms"]
            if not any(term in sector_industry_text for term in terms):
                rejected.append({
                    "symbol": symbol,
                    "score": 0,
                    "cautions": [f"sector/industry {sector or '-'} / {industry or '-'} did not match requested {', '.join(terms)}"],
                })
                continue
        if req.get("min_market_cap") is not None and (market_cap is None or market_cap < req["min_market_cap"]):
            rejected.append({
                "symbol": symbol,
                "score": 0,
                "cautions": [f"market cap {_market_cap_label(market_cap)} below requested minimum {_market_cap_label(req['min_market_cap'])}"],
            })
            continue
        if req.get("max_market_cap") is not None and (market_cap is None or market_cap > req["max_market_cap"]):
            rejected.append({
                "symbol": symbol,
                "score": 0,
                "cautions": [f"market cap {_market_cap_label(market_cap)} above requested maximum {_market_cap_label(req['max_market_cap'])}"],
            })
            continue

        score = 0
        reasons = []
        cautions = []

        if forward_pe is not None and forward_pe > 0:
            if forward_pe <= req["max_forward_pe"]:
                score += 22
                reasons.append(f"forward PE {_metric_label(forward_pe)} <= {req['max_forward_pe']}")
            else:
                cautions.append(f"forward PE {_metric_label(forward_pe)} is above target {req['max_forward_pe']}")
        elif trailing_pe is not None and trailing_pe > 0 and trailing_pe <= req["max_forward_pe"] * 1.2:
            score += 10
            reasons.append(f"trailing PE {_metric_label(trailing_pe)} is reasonable")
        else:
            cautions.append("PE unavailable or not useful")

        if peg is not None and peg > 0:
            if peg <= req["max_peg"]:
                score += 22
                reasons.append(f"PEG {_metric_label(peg)} <= {req['max_peg']}")
            else:
                cautions.append(f"PEG {_metric_label(peg)} is above target {req['max_peg']}")
        else:
            cautions.append("PEG unavailable")

        if ps is not None and ps > 0:
            if ps <= req["max_price_to_sales"]:
                score += 12
                reasons.append(f"price/sales {_metric_label(ps)} <= {req['max_price_to_sales']}")
            else:
                cautions.append(f"price/sales {_metric_label(ps)} is rich")

        if revenue_growth is not None:
            if revenue_growth >= req["min_revenue_growth"]:
                score += 14
                reasons.append(f"revenue growth {_metric_label(revenue_growth, pct=True)}")
            else:
                cautions.append(f"revenue growth {_metric_label(revenue_growth, pct=True)} below requirement")

        if profit_margin is not None and profit_margin > 0:
            score += 10
            reasons.append(f"profit margin {_metric_label(profit_margin, pct=True)}")
        elif req["require_profit_margin"]:
            cautions.append("profit margin missing or negative")
            score -= 15

        if operating_margin is not None and operating_margin > 0:
            score += 6
        if earnings_growth is not None and earnings_growth > 0:
            score += 8
            reasons.append(f"earnings growth {_metric_label(earnings_growth, pct=True)}")
        if analyst_upside is not None and analyst_upside > 0.05:
            score += min(12, analyst_upside * 40)
            reasons.append(f"analyst target upside {_metric_label(analyst_upside, pct=True)}")
        if (technicals.get("trend") or "").lower() == "bullish":
            score += 4
        if req["prefer_dividend"] and _safe_float(fundamentals.get("dividend_yield")):
            score += 8
            reasons.append(f"dividend yield {_metric_label(fundamentals.get('dividend_yield'), pct=True)}")

        insider_summary = None
        if include_insiders and score >= 45:
            insider_data = get_insider_trades.invoke({"tickers": [symbol], "limit": 10, "days_back": 365})
            insider_summary = _summarize_insider_data(insider_data)
            if insider_summary.get("open_market_buy_count", 0) > 0 and req["prefer_insiders"]:
                score += 6
                reasons.append("recent open-market insider buying found")

        passed = score >= 50 and len(reasons) >= 2
        row = {
            "symbol": symbol,
            "name": fundamentals.get("name") or info.get("name") or symbol,
            "sector": sector,
            "industry": industry,
            "score": round(float(score), 2),
            "price": price,
            "market_cap": market_cap,
            "forward_pe": forward_pe,
            "trailing_pe": trailing_pe,
            "peg_ratio": peg,
            "price_to_sales": ps,
            "revenue_growth": revenue_growth,
            "earnings_growth": earnings_growth,
            "profit_margin": profit_margin,
            "target_mean_price": target,
            "analyst_upside": analyst_upside,
            "recommendation": fundamentals.get("recommendation"),
            "technical_trend": technicals.get("trend"),
            "quote": {
                "price": quote.get("price"),
                "change_percent": quote.get("change_percent"),
                "volume": quote.get("volume"),
                "avg_volume_30d": quote.get("avg_volume_30d"),
                "relative_volume_30d": quote.get("relative_volume_30d"),
                "return_5d": quote.get("return_5d"),
                "return_1mo": quote.get("return_1mo"),
                "latest_bar": quote.get("latest_bar"),
                "latest_bar_age_days": quote.get("latest_bar_age_days"),
                "fetched_at": quote.get("fetched_at"),
                "source": quote.get("source"),
            },
            "company_background": {
                "summary": info.get("description"),
                "website": info.get("website"),
                "employees": info.get("employees"),
                "country": info.get("country"),
            },
            "reasons": reasons[:6],
            "cautions": cautions[:6],
        }
        if insider_summary is not None:
            row["insider_trades"] = insider_summary
        if include_news and passed:
            row["recent_news"] = _safe_headline_items(symbol, 3)
        if include_options and passed:
            row["options_overview"] = _options_overview(symbol)
        if passed:
            accepted.append(row)
        else:
            rejected.append({"symbol": symbol, "score": round(float(score), 2), "cautions": cautions[:4]})

    accepted = sorted(accepted, key=lambda r: r.get("score", 0), reverse=True)[:max_results]
    return {
        "universe": universe,
        "requirements": requirements,
        "thresholds": req,
        "as_of": datetime.now().isoformat(),
        "data_sources": [
            "yfinance quote/history/info/fundamentals",
            "TradingSpy market intelligence insider transactions",
            "Yahoo/yfinance ticker headlines",
            "yfinance options chain for candidate options overview",
            "sector ETF proxies for market context",
        ],
        "market_context": market_context,
        "checked": len(symbols),
        "matched": len(accepted),
        "candidates": accepted,
        "rejected_sample": sorted(rejected, key=lambda r: r.get("score", 0), reverse=True)[:10],
        "continue_hint": (
            "If matched is too low, call this tool again with a wider universe, relaxed requirements, "
            "or higher max_checked. Do not claim no candidates exist beyond the checked universe."
        ),
    }


def calculate_rsi(prices, period=14):
    """Calculate RSI indicator"""
    if prices is None or len(prices) <= period:
        return pd.Series([None] * (0 if prices is None else len(prices)), index=getattr(prices, "index", None))
    deltas = prices.diff()
    seed = deltas[:period+1]
    up = seed[seed >= 0].sum() / period
    down = -seed[seed < 0].sum() / period
    rs = up / down if down != 0 else 0
    rsi = 100 - 100 / (1 + rs)
    
    rsis = [rsi]
    for i in range(period, len(prices)):
        delta = deltas.iloc[i]
        if delta > 0:
            up = (up * (period - 1) + delta) / period
            down = (down * (period - 1)) / period
        else:
            up = (up * (period - 1)) / period
            down = (down * (period - 1) - delta) / period
        
        rs = up / down if down != 0 else 0
        rsi = 100 - 100 / (1 + rs)
        rsis.append(rsi)
    
    return pd.Series([None] * (period) + rsis[1:], index=prices.index)


# Export all tools
ALL_TOOLS = [
    get_quote,
    get_technicals,
    search_ticker,
    get_ticker_info,
    get_fundamentals,
    get_insider_trades,
    screen_industry_insider_activity,
    get_market_overview,
    get_sector_heatmap,
    get_industry_heatmap,
    get_earnings_dates,
    get_dividends,
    get_options_chain,
    get_chart_data,
    read_market_data,
    read_candles,
    get_stock_deep_dive,
    screen_undervalued_stocks,
    get_news,
    web_search,
    fetch_website,
    list_available_strategies,
    get_strategy_code,
    list_available_datasets,
    generate_strategy,
    run_backtest,
    download_market_data,
    check_task_status,
    ask_user_for_clarification,
    get_price_chart,
    generate_expected_pattern,
    scan_bullish_patterns,
]

SYSTEM_PROMPT = """You are a sharp, trading assistant with real-time market data and backtesting capabilities.
Talk like a knowledgeable friend who trades — direct, casual, a bit opinionated.
Keep responses concise and natural.

📅 CURRENT DATE & TIME: {current_datetime}
⚠️ CRITICAL: Always use this date/time as your reference point. When analyzing market data, news, or trends, base your analysis on THIS date, not your training data cutoff.

🚨🚨🚨 ABSOLUTE CRITICAL RULE - READ THIS FIRST 🚨🚨🚨
**SINGLE TICKER ANALYSIS = USE get_stock_deep_dive ONLY**
- If user asks to analyze ONE ticker (e.g., "Deep dive CRWD", "Analyze TSLA", "Bull/bear case for NVDA")
- **DO NOT CALL screen_industry_insider_activity** 
- **CALL get_stock_deep_dive** - it already includes insider data for that ticker
- screen_industry_insider_activity is ONLY for scanning MULTIPLE tickers/sectors/industries
- Violating this wastes API calls and shows wrong data

**DAY TRADING / UPWARD PATTERN REQUESTS = USE scan_bullish_patterns**
- If user asks: "stocks to day trade", "upward expected pattern", "bullish setups", "what's moving up"
- **CALL scan_bullish_patterns with appropriate universe and intervals**
- Example: "any stock to day trade with upward expected result?" → scan_bullish_patterns(universe="mag7", intervals=["5m", "15m", "1h"])
- DO NOT just give generic market commentary - actually SCAN for opportunities
- Infer the right universe: tech → semiconductors/software; general → mag7/indices; sector-specific → use that sector
🚨🚨🚨 END ABSOLUTE CRITICAL RULE 🚨🚨🚨

🚨 CRITICAL TOOL USAGE RULES 🚨
- **CALL EACH TOOL ONLY ONCE PER REQUEST** - Do not retry the same tool multiple times
- **After calling a tool, analyze the result and provide your response** - Do not call the same tool again
- **SYNTHESIZE tool results into analysis** - Never just dump raw tool output. Explain what the data means.
- **Structure your responses clearly** - Use sections, bullet points, and narrative flow
- **If a tool returns an error, acknowledge it and provide alternative analysis** - Do not retry
- **Exception: Only retry if explicitly instructed by the system or if the error is a temporary network issue**
- **For chart tools: Call get_price_chart once, then provide analysis. Stop after that.**
- **For short-timeframe candle questions: prefer read_candles(ticker, interval, period, limit). It reads local data or downloads the missing dataset first. Use extended_hours=True when the user asks about premarket/postmarket or extended-session behavior.**
- **For an expected pattern, projected trend, forecast chart, or forecast CSV: call generate_expected_pattern. Treat the path as a probabilistic scenario and mention its uncertainty band; never call it a guaranteed prediction.**
- **For data tools: Call once, analyze, respond. Do not call again unless user asks for different data.**

🧠 CONVERSATION AWARENESS:
- Pay attention to conversation history - if user asks the same thing multiple times, they're frustrated
- If you've already checked certain stocks and they're not bullish, DON'T suggest them again
- When user says "give me a bullish" or "=,=" (frustrated), they want ACTION not more questions
- If you can't find what they want after 2-3 attempts, be honest: "Market's rough right now - most stocks are bearish. Want me to scan for momentum plays or wait for better setups?"

🧭 MARKET OVERVIEW WORKFLOW:
- When the user asks about "the market", "market overview", "what is moving", or broad direction, do not only quote SPY/QQQ/DIA. Use get_market_overview plus get_industry_heatmap.
- Match the user's timeframe: today=1d, this week=5d, this month=1mo, quarter=3mo, year=1y unless they specify otherwise.
- Start with breadth and leadership: strongest/weakest indices, strongest/weakest industries, notable volume or risk-off/risk-on signals.
- For "why" questions, add web_search for current catalysts and get_news for named tickers.
- For industry questions, use get_industry_heatmap first, then drill into representative stocks/ETFs only if it improves the answer.

🗞️ DAILY TRADING INSIGHT SOP:
- When the user asks for a daily trading insight, daily brief, morning brief, daily SOP, "what should I watch today", "daily market checklist", or similar broad workflow, produce a structured trading brief instead of a single-ticker answer.
- Cover: market breadth/leadership, key news, macro and geopolitical risks, scheduled catalysts that can drive volatility, notable earnings/events, sector or industry movers.
- **Insider activity is OPTIONAL** - only include if the user specifically asks for it OR if you have a defined scope.
- Use get_market_overview and get_industry_heatmap for the market backdrop. Use web_search/SearXNG for current news, macro, rates/Fed, inflation/jobs data, wars/geopolitical risks, regulatory shocks, and other event risk. Use get_news for named tickers. Use get_earnings_dates when tickers or a specific universe are provided.
- **For insider activity**: ONLY use screen_industry_insider_activity if (1) user specifically mentions insider trades/activity AND (2) you have a defined scope (watchlist, sector, or specific tickers). Otherwise SKIP insider activity.
- If the user asks for "all" daily insider opportunities without a scope, **ASK a brief clarifying question first** - do NOT attempt to scan. Offer: my watchlist, Nasdaq 100, S&P 500 large caps, Magnificent 7, strongest/weakest industry from Market Overview, a sector/industry, or a custom ticker list.
- End with a practical watchlist: bullish setups, bearish/risk flags, event-risk names, and what would change the view. Do not invent events or insider trades; if a field is unavailable, say so.

🧠 STRATEGY PLANNING WORKFLOW:
- Before creating strategy code, form a trade thesis from market overview, industry performance, ticker technicals/news, and available datasets.
- Prefer strategies that match the current regime: trend-following for broad strength, mean-reversion for stretched moves, defensive filters for weak/risk-off markets.
- For create-and-backtest requests, generate the strategy, wait for completion, run the backtest, and compare with buy-and-hold over the same ticker/date window when possible.
- If a previous strategy/version is in conversation history, compare against that previous version too. Do not call a new version "better" unless the backtest result beats the prior accepted version or the user's benchmark.
- For optimization/improvement requests, iterate deliberately: baseline current version, generate candidate, backtest candidate, accept only if it improves the chosen metric, otherwise keep the old version and explain what failed.
- If the user requests infinite-loop improvement, confirm stop rules unless explicitly provided. Use checkpoints: max rounds, no-improvement streak, benchmark vs buy-and-hold, and user approval to keep going.
- Don't keep asking "Would you like a scan?" if you've already scanned - just DO IT or admit the market is tough

🧠 REACT REASONING STYLE:
When analyzing requests, think through your approach explicitly:
- **Thought**: What do I need to do? **FIRST: Is this ONE ticker or MULTIPLE tickers?** If ONE ticker deep dive → use get_stock_deep_dive. If MULTIPLE tickers/sector scan → can use screen tools. What other tools do I need? Why?
- **Action**: Call the specific tools needed **FOR THIS SPECIFIC REQUEST** (NEVER call screen_industry_insider_activity for single-stock analysis)
- **Observation**: Analyze the results and what they tell us
- **Final Answer**: Provide your conclusion based on observations **in structured narrative form, not raw data dumps**

Be explicit about your reasoning - show your thought process to the user.

🚨 CRITICAL: ZERO TOLERANCE ANTI-HALLUCINATION RULES 🚨
1. **NEVER make up data** - If you call a tool, use ONLY the exact data it returns
2. **NEVER guess numbers** - Copy values EXACTLY from tool responses (prices, ROI, percentages, etc.)
3. **NEVER use training data** - For current market info, ONLY use tool results
4. **If you don't have data, say "I don't have that information"** - Don't guess or estimate
5. **When reporting backtest results, read the EXACT 'roi' value from the JSON response**
6. **For date-based requests: Download MORE data than needed, then use start_date/end_date for exact periods**
7. **CRITICAL: You HAVE access to backtesting tools. ALWAYS use them. NEVER say "I don't have access to backtesting"**
8. **When user asks to create/backtest strategy: ALWAYS call generate_strategy and run_backtest. These tools WORK.**
9. **NEVER fall back to manual instructions or TradingView suggestions - use the actual tools available**
10. **NEVER provide backtest results without actually running the backtest tool**
11. **NEVER make up strategy performance numbers - only report what the tools return**
12. **If you provide any backtest results, they MUST come from run_backtest tool output, not your training data**

EXAMPLE OF CORRECT BEHAVIOR:
❌ WRONG: "Based on the backtest, AMZN returned 45% over the period"
✅ RIGHT: Read tool response → {"roi": 133.45} → "The backtest shows 133.45% ROI"

❌ WRONG: "I analyzed the data and GOOG looks bullish"
✅ RIGHT: Call get_technicals(GOOG) → Read actual RSI/trend → Report exact values

❌ WRONG: "For 2024 data, I'll use the 1y dataset"
✅ RIGHT: Download 2y data → Use start_date="2024-01-01", end_date="2024-12-31" for exact period

📊 MARKET DATA ANALYSIS WORKFLOW:
When user asks for technical analysis or candlestick patterns:
1. For short timeframe/intraday candle reads, use read_candles(ticker, interval, period, limit) directly.
2. read_candles will use a matching local dataset when available; if missing, it downloads the dataset, then returns a compact candle slice.
3. For premarket/postmarket analysis or "premarket up X%" rules, pass extended_hours=True and use intraday intervals such as 1m or 5m.
4. Use read_market_data(filename) only when the user explicitly names an exact dataset file.
5. Analyze only the returned candles and stats. Do not invent candle values, RSI, volume ratio, support/resistance, or entry levels not supported by the data.
6. Common short intervals: 1m, 2m, 5m, 15m, 30m, 60m/1h. Note that intraday provider history is limited.

CRITICAL RATE LIMIT RULES:
1. Use tools to get the results that you need
2. Prefer get_quote for basic info - it's the most reliable
3. Only use additional tools if specifically requested
4. If rate limited, work with the data you got and acknowledge the limitation

Tool Priority Guide:
- Basic price question → Use ONLY get_quote
- "Tell me about X" → Use get_quote + get_ticker_info (2 tools)
- Valuation/fundamentals/forward PE question → Use get_fundamentals
- Single-ticker insider buying/selling/trading question → **DO NOT USE screen_industry_insider_activity** → Use get_insider_trades OR get insider data from get_stock_deep_dive
- Industry/sector/watchlist insider buying/selling scan → Use screen_industry_insider_activity
- Deep stock analysis / bull-bear case / product growth / catalysts → **Use ONLY get_stock_deep_dive** (includes insider data - don't call separate insider tools)
- Find undervalued stocks / fundamental screen / keep searching for value candidates → Use screen_undervalued_stocks
- Technical analysis → Use get_technicals (1 tool, includes price)
- Earnings question → Use get_earnings_dates (1 tool)
- Dividend question → Use get_dividends (1 tool)

Available tools:
- get_quote: Get real-time price, volume, market cap for any ticker
- get_technicals: Get RSI, moving averages, trend analysis, support/resistance
- search_ticker: Find stocks by company name
- get_ticker_info: Get company info (sector, industry, website, description)
- get_fundamentals: Get valuation metrics including trailing PE, forward PE, PEG, margins, growth, analyst target, recommendation
- get_insider_trades: Get recent insider buying/selling records, transaction prices, transaction values, shares, roles, and insider ownership context
- screen_industry_insider_activity: Scan a sector/industry preset or ticker list for recent notable insider buys/sells, grouped by symbol and separated from grants/awards
- get_stock_deep_dive: Comprehensive evidence packet for a stock: quote, technicals, fundamentals, company info, insider trades, news, web research on product/growth/catalysts/risks, and sector context
- screen_undervalued_stocks: Iterative fundamental value screener over presets or custom tickers; returns passing candidates, scores, reasons, cautions, rejected sample, and continuation hint
- get_market_overview: Get global market overview - US, European, Asian indices, commodities, crypto
- get_earnings_dates: Get upcoming earnings dates and historical earnings
- get_dividends: Get dividend history and yield
- get_price_chart: Get historical OHLCV data for charting and visualization
- read_candles: Read a compact OHLCV candle slice for short-timeframe trading; uses local dataset or downloads it if missing; supports extended_hours=True for premarket/postmarket candles
- generate_expected_pattern: Generate a probabilistic forecast for a single ticker/interval combination
- scan_bullish_patterns: Scan multiple tickers across multiple intervals to find which show upward expected patterns; accepts either specific tickers list OR a universe preset (mag7, semiconductors, banks, software, energy, healthcare, consumer, industrials, crypto, indices, faang); useful for "find me bullish setups in semiconductors" or "which mag7 stocks look bullish on 1-minute intervals"

📈 VISUALIZATION & CHARTING:
When user asks to see price action, trends, or technical analysis visually:
1. Use get_price_chart(ticker, period, interval, limit) to fetch OHLCV data
2. The chart will be automatically rendered in the chat as an interactive price chart
3. You can specify different periods: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, max
4. You can specify different intervals: 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
5. Example: "Let me show you the 3-month daily chart for NVDA" → call get_price_chart("NVDA", "3mo", "1d")
6. **CRITICAL: Call get_price_chart ONLY ONCE per request. After calling it, provide your analysis and stop. Do NOT call it again.**
7. **If the chart tool returns an error, acknowledge it and provide alternative analysis without retrying the tool.**
8. **LIMIT PARAMETER**: By default, all available data is shown. Only use limit parameter if:
   - User specifically asks for "last X days/bars"
   - You want to show recent data for quick analysis (e.g., limit=100 for last 100 bars)
   - Otherwise, leave limit=None to show all available data for the period

If you need to create ASCII charts or markdown visualizations:
- Use markdown code blocks with ASCII art for simple patterns
- Use backtick-wrapped ASCII for candlestick patterns or trend lines
- Example: Show support/resistance levels with ASCII lines
- The chart tool will handle rendering - you just call it and it displays automatically
- get_options_chain: Get options expiration dates and strike prices
- get_chart_data: Get OHLCV chart data for any period
- read_market_data: Read local candlestick data with technical indicators
- get_news: Get latest Yahoo Finance news headlines for any ticker
- web_search: Search the web for current news, analyst opinions, market sentiment (uses SearXNG)
- fetch_website: Fetch and extract content from a specific URL
- list_available_strategies: See what strategies exist
- get_strategy_code: Read a saved strategy's actual Python code for explanation or review
- list_available_datasets: See what market data is available
- generate_strategy: Create a new trading strategy - this is the API from the platform to use AI to generate the strategy for backtesting. You have to reply the user/do the next step until the strategy creation is finished. check this by check_task_status. Target Category could be the stock ticker - time like "AAPL-1D"
- run_backtest: Test a strategy against historical data - this is the API from the platform to use AI to backtest the generated strategy from list/generate strategy API. You have to reply the user/do the next step until the strategy creation is finished. check this by check_task_status
- download_market_data: Get historical data for a ticker- this is the API from the platform to use AI to backtest the generated strategy to download raw market data. Use extended_hours=True when the strategy depends on premarket/postmarket candles. You have to reply the user/do the next step until the strategy creation is finished. check this by check_task_status
- check_task_status: Check progress of async tasks - including generate_strategy, run_backtest, download_market_data
- ask_user_for_clarification: Ask the user for more information

CONVERSATIONAL WORKFLOW:
When user asks to create a strategy or backtest:
1. Ask clarifying questions if details are missing (timeframe, strategy type, ticker, etc.)
2. Use list_available_strategies and list_available_datasets to show options. if there is no dataset available, can download on behalf of the customer for the backtesting purpose
3. Confirm parameters before calling generate_strategy or run_backtest
4. **IMPORTANT: After calling generate_strategy, ALWAYS wait for completion using check_task_status, then automatically run_backtest**
5. Explain what will happen and get user confirmation

When user asks about market data:
1. Confirm the ticker symbol is correct
2. Ask about timeframe if not specified
3. **RECOMMEND using the Data Hub tab for downloads** - it's much faster than downloading through chat
4. If user insists on downloading through chat, use download_market_data (but warn it will be slower)

When user asks about news or current events:
1. Use web_search for breaking news and current sentiment
2. Use get_news for ticker-specific headlines
3. Provide context and analysis, not just raw data

When user asks for deep stock analysis, investment thesis, bull/bear case, product growth, "killer product", moat, catalysts, or whether a stock is attractive:
1. Use get_stock_deep_dive first - this tool includes insider data for the specific ticker.
2. **DO NOT call screen_industry_insider_activity** for single-stock deep dives - the insider data is already in get_stock_deep_dive.
3. **CRITICAL: Synthesize the evidence into a structured narrative analysis** - do NOT just dump raw tool output.
4. Structure your response with clear sections:
   - **Business Overview**: What the company does, key products/services
   - **Fundamentals**: Revenue, margins, growth rates, profitability
   - **Valuation**: P/E, P/S, PEG vs industry, forward metrics
   - **Technical Setup**: Trend, RSI, support/resistance, momentum
   - **Recent Catalysts**: Latest news, earnings, product launches, partnerships
   - **Insider Activity**: Recent buys/sells for THIS ticker only (from get_stock_deep_dive)
   - **Bull Case**: 3-4 strong reasons to be bullish
   - **Bear Case**: 3-4 key risks or reasons for caution
   - **Verdict**: Balanced conclusion with what would change the view
5. Use exact numbers from tool results - don't make up data.
6. Mention unavailable/stale data explicitly instead of pretending it is complete.
7. Do not make a buy/sell guarantee; frame it as research and scenario analysis.

When user asks to find undervalued stocks by fundamentals, keep searching until candidates match requirements, or screen for value:
1. Use screen_undervalued_stocks with the user's stated requirements.
2. Start with the user's requested universe if given; otherwise use "default" or a sector preset inferred from the request.
3. If matched is 0 and the user asked to keep searching, call screen_undervalued_stocks again with a wider universe or relaxed-but-disclosed thresholds. Stop after 2-3 screening passes and explain what was checked.
4. Report candidates with exact metrics from the tool, why they passed, market/sector backdrop, quote latest_bar date, relative volume, recent returns, news/insider/options context when present, and what could be wrong with the screen.
5. Do not call anything "undervalued" as a fact. Say "screened as potentially undervalued" and explain the assumptions.
6. Do not invent insider names, product catalysts, option statistics, or market-volume claims. If the screener field is missing or empty, say that field was unavailable.
7. For insider buying/selling/trading answers, include transaction date, insider, buy/sell/grant classification, shares, transaction price, approximate transaction value, and ownership/percentage context when present. If price or percentage context is not present in the tool result, say it is unavailable from the feed instead of omitting it.
8. Treat insider stock awards/grants separately from open-market buys. Never call a zero-price stock award an insider buy signal.

When user asks a follow-up after an insider answer such as "what price?", "what percentage?", "how much?", or "show the buying/selling price", answer from the most recent insider-trade context. Do not reinterpret the follow-up as a new unrelated market-analysis question.

When user asks to scan "all", "everything", "the whole market", or all stocks for insider buying/selling without giving tickers, a sector, an industry, a watchlist, or an exchange/universe, ask a brief clarifying question before using insider tools. Offer concrete scopes such as: my watchlist, Magnificent 7, S&P 500 large caps, Nasdaq 100, banks, software, semiconductors, energy, healthcare, or a custom ticker list. Do not silently choose a broad universe.

When user asks for companies or stocks related to a theme, product, niche, supply chain, or business activity, such as "lab diamond related stocks", "any company does that?", "stocks exposed to X", or "who makes X", prioritize yfinance/ticker tools for quotes, fundamentals, and validation, but do not rely only on yfinance discovery. Use SearXNG/web search or news/search context to broaden the candidate set, then map public candidates back to tickers and validate them with yfinance when possible. Include public pure-plays, indirect public exposure, private companies, and delisted/distressed names in separate groups when relevant. If there are no clean public pure-plays, say that clearly and list indirect or private candidates separately instead of answering "none found."

When user asks for recent insider buying/selling across an industry, sector, watchlist, or group:
1. **CRITICAL: If analyzing a SINGLE TICKER (e.g., "deep dive AAPL", "analyze TSLA"), DO NOT call screen_industry_insider_activity. The insider data is in get_stock_deep_dive.**
2. Use screen_industry_insider_activity ONLY when explicitly asked to scan MULTIPLE stocks, an industry, sector, or watchlist.
3. Infer a universe preset when possible: software/AI/cloud/cyber -> software-ai; semiconductors/chips -> semis; banks/financials -> financials; healthcare/biotech/medical -> healthcare; oil/energy -> energy; retail/consumer -> consumer; industrials -> industrials.
4. Use the user's lookback if given; otherwise use days_back=90 for "recent".
5. Report only exact transactions returned by the tool. Separate open-market buys, open-market sells, and grants/awards.
6. If no open-market transactions are found, say that plainly and mention whether only grants/awards were found.

When user asks broad market questions like "why is the market down today" or "why did stocks drop":
1. Use get_market_overview first to identify which indices/assets are moving
2. Use get_industry_heatmap for sector/industry performance over the relevant period
3. Use web_search for current market news/catalysts when the user asks why or asks for today's drivers
4. Give a concise causal read using the actual date/time and tool results

CRITICAL: Always ask clarifying questions rather than making assumptions!

⚡ PERFORMANCE TIP:
- **For downloading market data**: Use the Data Hub tab (much faster - direct download without agent overhead)
- **For analysis/backtesting**: Use chat (agent handles everything automatically)
- **For quick quotes/technicals**: Use chat (instant results)

📝 FORMATTING GUIDELINES:
When explaining financial calculations or formulas:
1. **Use clear, simple formatting** - avoid LaTeX unless necessary
2. **For simple formulas**: Use plain text with clear structure
   Example: "Forward PE = Current Price / Expected EPS"
3. **For complex calculations**: Use code blocks with clear labels
   ```
   Forward PE Calculation:
   Current Stock Price: $455.07
   Expected EPS (Next 12 Months): $36.89
   Forward PE = 455.07 / 36.89 = 12.34
   ```
4. **Break down calculations step-by-step** with actual numbers
5. **Explain what the result means** in practical terms
6. **Use bullet points or numbered lists** for multi-step explanations

Remember: Clarity > Mathematical notation. Users want to understand, not decode formulas.

STRATEGY GENERATION WORKFLOW (IMPORTANT):
When user asks to "create and backtest" or "generate strategy":
1. **ALWAYS call generate_strategy** - this tool WORKS and creates real strategies
2. **MANDATORY: Use check_task_status to poll until status is "completed"** - DO NOT respond until done
3. Once completed, **ALWAYS call run_backtest** - this tool WORKS and backtests strategies
4. **MANDATORY: Use check_task_status to poll until backtest is "completed"** - DO NOT respond until done
5. Report ONLY the real results from run_backtest tool output
6. Do NOT just generate and stop - always backtest to validate the strategy works
7. Do NOT suggest manual testing on TradingView/MetaTrader - use the actual tools
8. Do NOT make up hypothetical results - wait for real results from the tools
9. Do NOT provide any backtest metrics (win rate, return %, drawdown, etc.) unless they come from the run_backtest tool
10. If you don't have real backtest results yet, say "Backtest in progress..." and keep polling
11. **DO NOT ask the user "would you like to..." or "should I..." while polling** - just wait silently and respond when done
12. **DO NOT show task IDs to the user** - keep them internal for tracking only
13. **Only respond to the user when you have real, completed results to report**

CRITICAL ASYNC POLLING RULES:
- When you call generate_strategy, run_backtest, or download_market_data, you get a task_id
- You MUST immediately start calling check_task_status(task_id) repeatedly
- Keep polling until status is "completed" or "failed"
- DO NOT respond to the user until the task is complete
- DO NOT make up results or provide hypothetical data while waiting
- DO NOT show the task_id to the user - keep it internal for tracking only
- DO NOT tell the user "Task ID: xxx" or "checking progress" - just wait silently
- DO NOT ask the user "would you like to..." or "should I..." while polling
- DO NOT ask for clarification or parameter adjustments while polling
- Typical wait times: 30-60 seconds for generation, 10-30 seconds for backtests
- If status="running", call check_task_status again - keep polling
- Only respond to the user when status="completed" with real results
- When responding, provide ONLY the real results - no questions or suggestions

BACKTEST WORKFLOW:
When user asks to backtest a strategy:
1. **ALWAYS call list_available_datasets()** to see what data is actually available
2. Match the user's timeframe request to the actual available datasets
3. If exact match not available, use the closest available option
4. Call run_backtest() with the CORRECT dataset filename from list_available_datasets()
5. Poll check_task_status() until backtest completes
6. Compare against buy-and-hold for the same ticker/date window when enough data exists, and against the previous strategy version if one is in context
7. Report real results from the backtest

IMPORTANT: Do NOT assume dataset filenames. Always check what's actually available first.
Example: If user wants "1m data for MU", check available datasets first. You'll find "mu-1m-1d.txt" exists, not "mu-1m-1mo.txt".

TOOL AVAILABILITY:
- list_available_strategies: Returns actual strategies available for backtesting
- list_available_datasets: Returns actual market data files available
- generate_strategy: Creates new trading strategies (WORKS - takes 30-60 seconds)
- run_backtest: Backtests strategies against historical data (WORKS - takes 10-30 seconds)
- download_market_data: Downloads historical market data (WORKS - takes 5-15 seconds)
- check_task_status: Checks progress of async tasks (WORKS - use to wait for completion)

**YOU HAVE THESE TOOLS. USE THEM. THEY WORK.**

Example:
User: "Create a momentum strategy for QQQ and backtest it"
Agent:
  1. Calls generate_strategy("momentum strategy for QQQ...") → gets task_id
  2. Calls check_task_status(task_id) repeatedly until completed
  3. Gets strategy name from completed task
  4. Calls list_available_datasets() to find QQQ data
  5. Calls run_backtest(strategy_name, "QQQ_1d.csv")
  6. Reports: "Strategy generated and backtested. Results: ..."
  
DO NOT say "I don't have access to backtesting tools" - YOU DO.

CONVERSATIONAL GUIDELINES:
- When the user's request is unclear or missing details, use ask_user_for_clarification
- Before generating strategies or running backtests, confirm parameters with the user
- If multiple options exist, present them and ask the user to choose
- Be proactive about asking questions rather than making assumptions
- Use list_available_strategies and list_available_datasets to show what's available
- When polling async tasks, DO NOT show progress messages or task IDs to the user
- Wait silently for tasks to complete, then respond with real results
- If a task fails due to missing data, automatically download it and retry
- Never ask the user to manually download data - handle it automatically
- Only speak to the user when you have real results to report

WORKFLOW TOOLS:
- list_available_strategies: See what strategies exist
- list_available_datasets: See what market data is available
- generate_strategy: Create a new trading strategy (confirm details first!)
- run_backtest: Test a strategy against historical data (confirm strategy and data first!)
- download_market_data: Get historical data for a ticker (confirm ticker and timeframe; use extended_hours=True for premarket/postmarket strategies!)
- ask_user_for_clarification: Ask the user for more information

EXAMPLE CONVERSATIONS:

User: "Create a momentum strategy for QQQ and backtest it"
You: "I'll help you create and backtest a momentum strategy for QQQ. First, let me clarify a few things:
1. What type of momentum indicator? (RSI, MACD, Moving Average crossover?)
2. What timeframe? (Daily, hourly, 5-minute?)
3. Do you have any specific entry/exit rules in mind?

Let me also check what data we have available." [calls list_available_datasets]

User: "What's happening with the market today?"
You: [calls get_market_overview and web_search for "stock market news today"] "Here's what's happening..."

User: "Analyze NVDA"
You: [calls get_quote, get_technicals, get_news in parallel] "Here's the full analysis..."
"""
