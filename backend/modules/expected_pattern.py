"""Probabilistic expected-pattern generation for assistant chart cards."""

import logging
import math

import numpy as np
import pandas as pd
import yfinance as yf
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


def _interval(value: str) -> str:
    raw = str(value or "1d").strip().lower()
    return {"1hour": "1h", "1hr": "1h", "hourly": "1h", "daily": "1d", "weekly": "1wk"}.get(raw, raw)


def _convert_numpy_types(obj):
    """Recursively convert numpy and pandas types to native Python types for JSON serialization."""
    if isinstance(obj, dict):
        return {key: _convert_numpy_types(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [_convert_numpy_types(item) for item in obj]
    elif isinstance(obj, (pd.Timestamp, pd.DatetimeTZDtype)):
        return obj.isoformat() if hasattr(obj, 'isoformat') else str(obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif pd.isna(obj):
        return None
    return obj


@tool
def generate_expected_pattern(
    ticker: str,
    interval: str = "1d",
    horizon: int = 20,
    lookback: int = 180,
    extended_hours: bool = False,
) -> dict:
    """Generate a probabilistic upcoming price pattern from recent OHLCV bars.

    Use for an expected pattern, projected trend, forecast path/chart, likely
    upcoming movement, or forecast CSV. Returns recent history, a median path,
    an 80% uncertainty band, diagnostics, and CSV-ready rows. This is a
    statistical scenario rather than a guaranteed price prediction.

    Args:
        ticker: Market symbol, for example SPY, NVDA, BTC-USD, or EURUSD=X.
        interval: Candle interval such as 5m, 15m, 1h, 1d, or 1wk.
        horizon: Future bars to project, from 2 to 500.
        lookback: Recent bars used for estimation, from 40 to 500.
        extended_hours: Include pre/post-market bars for intraday equities.
    """
    symbol = str(ticker or "").strip().upper().replace("$", "")
    if not symbol:
        return {"error": "ticker is required"}
    interval = _interval(interval)
    horizon = max(2, min(int(horizon or 20), 500))
    lookback = max(40, min(int(lookback or 180), 500))
    periods = {
        "1m": "7d", "2m": "60d", "5m": "60d", "15m": "60d", "30m": "60d",
        "60m": "2y", "90m": "60d", "1h": "2y", "1d": "2y", "5d": "5y",
        "1wk": "10y", "1mo": "max",
    }
    try:
        frame = yf.Ticker(symbol).history(
            period=periods.get(interval, "2y"), interval=interval,
            prepost=bool(extended_hours), auto_adjust=False,
        ).dropna(subset=["Close"]).tail(lookback)
        if len(frame) < 35:
            return {"error": f"Need at least 35 usable bars; received {len(frame)} for {symbol} {interval}."}

        close = frame["Close"].astype(float)
        volume = frame["Volume"].fillna(0).astype(float)
        returns = np.log(close / close.shift(1)).dropna().tail(90)
        weights = np.exp(np.linspace(-2.0, 0.0, len(returns)))
        weighted_drift = float(np.average(returns, weights=weights))
        trend_window = min(30, len(close))
        slope = float(np.polyfit(np.arange(trend_window), np.log(close.tail(trend_window)), 1)[0])
        sma20 = float(close.tail(20).mean())
        stretch = math.log(float(close.iloc[-1]) / sma20) if sma20 > 0 else 0.0
        average_volume = float(volume.tail(30).mean())
        volume_ratio = float(volume.tail(5).mean() / average_volume) if average_volume > 0 else 1.0
        volume_confirmation = min(1.2, max(0.75, volume_ratio ** 0.15))
        expected_step = ((0.55 * weighted_drift) + (0.45 * slope) - (0.08 * stretch)) * volume_confirmation
        volatility = float(returns.ewm(span=min(30, len(returns))).std().iloc[-1])
        if not np.isfinite(volatility) or volatility <= 0:
            volatility = max(float(returns.std()), 1e-6)

        anchor = float(close.iloc[-1])
        seed = int(abs(anchor) * 10000 + len(frame) * 31 + horizon * 17) % (2**32 - 1)
        rng = np.random.default_rng(seed)
        residuals = returns.to_numpy() - float(returns.mean())
        shocks = rng.choice(residuals, size=(1200, horizon), replace=True)
        paths = anchor * np.exp(np.cumsum(expected_step + shocks, axis=1))
        median = np.quantile(paths, 0.50, axis=0)
        lower = np.quantile(paths, 0.10, axis=0)
        upper = np.quantile(paths, 0.90, axis=0)

        offsets = {
            "1m": pd.Timedelta(minutes=1), "2m": pd.Timedelta(minutes=2), "5m": pd.Timedelta(minutes=5),
            "15m": pd.Timedelta(minutes=15), "30m": pd.Timedelta(minutes=30), "60m": pd.Timedelta(hours=1),
            "90m": pd.Timedelta(minutes=90), "1h": pd.Timedelta(hours=1), "1d": pd.offsets.BDay(1),
            "5d": pd.offsets.BDay(5), "1wk": pd.offsets.Week(1), "1mo": pd.offsets.MonthEnd(1),
        }
        offset = offsets.get(interval, pd.offsets.BDay(1))
        future_times = []
        cursor = pd.Timestamp(frame.index[-1])
        for _ in range(horizon):
            cursor += offset
            future_times.append(cursor)

        def timestamp(value):
            return pd.Timestamp(value).isoformat()

        history = [{
            "time": timestamp(idx), "open": round(float(row["Open"]), 4),
            "high": round(float(row["High"]), 4), "low": round(float(row["Low"]), 4),
            "close": round(float(row["Close"]), 4), "volume": int(float(row.get("Volume", 0) or 0)),
        } for idx, row in frame.tail(80).iterrows()]
        forecast = [{
            "step": step, "time": timestamp(when), "expected_close": round(float(mid), 4),
            "lower_80": round(float(lo), 4), "upper_80": round(float(hi), 4),
            "expected_return_pct": round((float(mid) / anchor - 1) * 100, 3),
        } for step, (when, mid, lo, hi) in enumerate(zip(future_times, median, lower, upper), 1)]

        # Confirmed pivots and ATR-tolerant levels. Pivots require three bars on
        # either side, so the latest unconfirmed candles cannot become anchors.
        radius = 3
        lows = frame["Low"].astype(float).to_numpy()
        highs = frame["High"].astype(float).to_numpy()
        pivot_lows = [i for i in range(radius, len(frame) - radius) if lows[i] <= np.min(lows[i - radius:i + radius + 1])]
        pivot_highs = [i for i in range(radius, len(frame) - radius) if highs[i] >= np.max(highs[i - radius:i + radius + 1])]
        previous_close = close.shift(1)
        true_range = pd.concat([
            frame["High"] - frame["Low"],
            (frame["High"] - previous_close).abs(),
            (frame["Low"] - previous_close).abs(),
        ], axis=1).max(axis=1)
        atr14 = float(true_range.tail(14).mean())
        level_tolerance = max(anchor * 0.002, atr14 * 0.45)

        def clustered_levels(pivots, values, kind):
            clusters = []
            for position in pivots:
                price = float(values[position])
                match = next((cluster for cluster in clusters if abs(cluster["price"] - price) <= level_tolerance), None)
                if match:
                    match["prices"].append(price)
                    match["positions"].append(position)
                    match["price"] = float(np.mean(match["prices"]))
                else:
                    clusters.append({"price": price, "prices": [price], "positions": [position]})
            eligible = [
                cluster for cluster in clusters
                if (kind == "support" and cluster["price"] <= anchor * 1.015)
                or (kind == "resistance" and cluster["price"] >= anchor * 0.985)
            ]
            eligible.sort(key=lambda cluster: (len(cluster["positions"]), max(cluster["positions"])), reverse=True)
            return [{
                "price": round(cluster["price"], 4),
                "touches": len(cluster["positions"]),
                "last_touch": timestamp(frame.index[max(cluster["positions"])]),
                "distance_pct": round((cluster["price"] / anchor - 1) * 100, 3),
                "source": f"ATR-clustered swing {kind}",
            } for cluster in eligible[:3]]

        def ranked_pivot_lines(pivots, values, kind):
            candidates = pivots[-10:]
            ranked = []
            max_bars = len(frame)
            
            for first_index in range(len(candidates)):
                for second_index in range(first_index + 1, len(candidates)):
                    first = candidates[first_index]
                    second = candidates[second_index]
                    
                    # Minimum spacing to avoid noise
                    if second - first < 3:
                        continue
                    
                    # NEW: Prefer pivots that are reasonably spaced
                    # Don't connect pivots that are too far apart relative to total history
                    distance_bars = second - first
                    max_reasonable_distance = max(20, max_bars * 0.4)  # At most 40% of history or 20 bars minimum
                    
                    # NEW: Penalize very distant pivots unless they're both recent
                    both_recent = (max_bars - first) <= 30 and (max_bars - second) <= 30
                    
                    # Skip if pivots are too far apart AND not both recent
                    if distance_bars > max_reasonable_distance and not both_recent:
                        continue
                    
                    slope = (float(values[second]) - float(values[first])) / (second - first)
                    projected = float(values[first]) + slope * (np.arange(len(frame)) - first)
                    pivot_distances = [abs(float(values[position]) - projected[position]) for position in candidates if position >= first]
                    touches = sum(distance <= level_tolerance for distance in pivot_distances)
                    
                    if kind == "support":
                        violations = int(np.sum(lows[first:] < projected[first:] - level_tolerance))
                    else:
                        violations = int(np.sum(highs[first:] > projected[first:] + level_tolerance))
                    
                    # NEW: Add recency weight - prefer lines where both pivots are more recent
                    recency_weight = ((max_bars - first) + (max_bars - second)) / (2 * max_bars)
                    recency_score = (1 - recency_weight) * 0.5  # Bonus up to 0.5 for recent pivots
                    
                    # NEW: Add spacing quality weight - penalize very tight or very wide spacing
                    spacing_ratio = distance_bars / max_bars
                    spacing_quality = 0.3 if 0.1 <= spacing_ratio <= 0.5 else 0  # Bonus for good spacing
                    
                    score = touches * 2.0 - violations * 1.5 + recency_score + spacing_quality
                    current_price = float(values[first]) + slope * (len(frame) - 1 - first)
                    
                    ranked.append({
                        "first": first, 
                        "second": second, 
                        "slope": slope, 
                        "touches": touches, 
                        "violations": violations, 
                        "score": score, 
                        "current_price": current_price,
                        "distance_bars": distance_bars,
                    })
            
            ranked.sort(key=lambda item: (item["score"], -abs(item["current_price"] - anchor)), reverse=True)
            output = []
            for item in ranked[:6]:
                confidence = "high" if item["touches"] >= 3 and item["violations"] == 0 else "medium" if item["violations"] <= 1 else "low"
                output.append({
                    "kind": kind,
                    "anchor_1": {"time": timestamp(frame.index[item["first"]]), "price": round(float(values[item["first"]]), 4)},
                    "anchor_2": {"time": timestamp(frame.index[item["second"]]), "price": round(float(values[item["second"]]), 4)},
                    "slope_per_bar": round(float(item["slope"]), 6),
                    "touches": item["touches"],
                    "violations": item["violations"],
                    "score": round(float(item["score"]), 3),
                    "confidence": confidence,
                    "current_price": round(float(item["current_price"]), 4),
                    "distance_pct": round((item["current_price"] / anchor - 1) * 100, 3),
                    "projected_end_price": round(float(values[item["first"]]) + item["slope"] * (len(frame) + horizon - 1 - item["first"]), 4),
                    "anchor_distance_bars": item["distance_bars"],
                })
            return output

        def project_best_line(candidates, values):
            if not candidates:
                return None
            best = candidates[0]
            start_position = max(0, len(frame) - len(history))
            positions = list(range(start_position, len(frame) + horizon))
            times = [timestamp(value) for value in frame.index[start_position:]] + [timestamp(value) for value in future_times]
            first_position = next((position for position, index_value in enumerate(frame.index) if timestamp(index_value) == best["anchor_1"]["time"]), 0)
            values_out = [best["anchor_1"]["price"] + best["slope_per_bar"] * (position - first_position) for position in positions]
            return {**best, "points": [{"time": time_value, "price": round(price, 4)} for time_value, price in zip(times, values_out)]}

        supports = clustered_levels(pivot_lows, lows, "support")
        resistances = clustered_levels(pivot_highs, highs, "resistance")
        previous_low = None
        if pivot_lows:
            position = pivot_lows[-1]
            previous_low = {"time": timestamp(frame.index[position]), "price": round(float(lows[position]), 4), "bars_ago": len(frame) - 1 - position}
        support_candidates = ranked_pivot_lines(pivot_lows, lows, "support")
        resistance_candidates = ranked_pivot_lines(pivot_highs, highs, "resistance")
        
        # Add points array to candidates for frontend rendering
        def add_candidate_points(candidates, values):
            start_position = max(0, len(frame) - 80)
            positions = list(range(start_position, len(frame) + horizon))
            times_list = [timestamp(value) for value in frame.index[start_position:]] + future_times
            for candidate in candidates:
                anchor_time = candidate["anchor_1"]["time"]
                first_position = next((idx for idx, t in enumerate(frame.index) if timestamp(t) == anchor_time), 0)
                points = [
                    {"time": time_value, "price": round(candidate["anchor_1"]["price"] + candidate["slope_per_bar"] * (position - first_position), 4)}
                    for position, time_value in zip(positions, times_list)
                ]
                candidate["points"] = points
            return candidates
        
        support_candidates = add_candidate_points(support_candidates, lows)
        resistance_candidates = add_candidate_points(resistance_candidates, highs)
        
        technical_levels = {
            "atr14": round(atr14, 4),
            "tolerance": round(level_tolerance, 4),
            "previous_low": previous_low,
            "supports": supports,
            "resistances": resistances,
            "trend_support": project_best_line(support_candidates, lows),
            "trend_resistance": project_best_line(resistance_candidates, highs),
            "trend_support_candidates": support_candidates,
            "trend_resistance_candidates": resistance_candidates,
            "method": "Confirmed 3-bar pivots; horizontal levels clustered within 0.45 ATR; trendline pairs scored by touches, recency, and candle violations.",
        }
        structure_summary = {
            "previous_low": previous_low,
            "nearest_horizontal_supports": supports,
            "nearest_horizontal_resistances": resistances,
            "ranked_support_trendlines": support_candidates[:4],
            "ranked_resistance_trendlines": resistance_candidates[:4],
            "guidance": "Compare distance, touches, violations, confidence, and anchors; do not assume the top-ranked line is guaranteed to hold.",
        }

        end_return = float(forecast[-1]["expected_return_pct"])
        neutral_threshold = max(0.35, volatility * math.sqrt(horizon) * 20)
        direction = "upward" if end_return > neutral_threshold else "downward" if end_return < -neutral_threshold else "sideways"
        changes = close.diff()
        avg_gain = float(changes.clip(lower=0).tail(14).mean())
        avg_loss = float(-changes.clip(upper=0).tail(14).mean())
        rsi14 = 100.0 if avg_loss == 0 else 100 - (100 / (1 + avg_gain / avg_loss))

        # Create user-friendly explanation
        explanation = (
            f"This forecast uses a statistical calculation based on {len(frame)} historical bars. "
            f"It combines recent momentum (weighted toward the most recent data), trend direction "
            f"from the last 30 bars, mean reversion from the 20-bar average, and volume confirmation. "
            f"The path is generated using Monte Carlo simulation with 1,200 scenarios, sampling from "
            f"actual historical price movements. The median path represents the most likely outcome, "
            f"while the 80% confidence band shows the range where prices are statistically likely to fall. "
            f"Current indicators: RSI={round(rsi14, 1)}, Recent Volume vs Average={round(volume_ratio, 2)}x, "
            f"Volatility={round(volatility * 100, 2)}% per bar."
        )
        
        return _convert_numpy_types({
            "type": "expected_pattern", "symbol": symbol, "interval": interval,
            "horizon": horizon, "lookback_used": len(frame), "as_of": timestamp(frame.index[-1]),
            "direction": direction, "expected_end_return_pct": round(end_return, 3),
            "market_structure": structure_summary,
            "history": history, "forecast": forecast,
            "technical_levels": technical_levels,
            "inputs": {"latest_close": round(anchor, 4), "sma20": round(sma20, 4),
                       "rsi14": round(rsi14, 2), "per_bar_volatility_pct": round(volatility * 100, 3),
                       "recent_volume_ratio": round(volume_ratio, 3), "bars": len(frame)},
            "method": "Seeded residual bootstrap using momentum, log-price trend, mean reversion, volume confirmation, and empirical volatility.",
            "explanation": explanation,
            "csv_columns": ["step", "time", "expected_close", "lower_80", "upper_80", "expected_return_pct"],
            "csv_rows": forecast,
            "warning": "Probabilistic historical-data scenario, not financial advice or a guaranteed price forecast. The 80% band represents model uncertainty.",
        })
    except Exception as exc:
        logger.warning("Expected-pattern generation failed for %s: %s", symbol, exc)
        return {"error": str(exc), "symbol": symbol, "interval": interval}
