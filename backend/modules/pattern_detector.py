"""Technical chart pattern detection for special-pattern scans (VCP, cup & handle, flags).

Uses daily (or other) OHLCV frames and simple, explainable heuristics. Each
detector returns a score (0-100) plus supporting evidence so the caller can
decide how strict to be. These are screening heuristics, not investment advice.
"""

import logging
import math

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def _require(frame, min_bars: int = 60):
    if frame is None or not isinstance(frame, pd.DataFrame) or len(frame) < min_bars:
        return None
    for col in ("High", "Low", "Close", "Volume", "Open"):
        if col not in frame.columns:
            return None
    return frame.astype(float) if False else frame


def _range_pct(row):
    high = float(row["High"])
    low = float(row["Low"])
    if high <= 0:
        return None
    return (high - low) / high


def _body_mid(frame):
    return (frame["High"] + frame["Low"]) / 2.0


def _atr(frame, period: int = 14):
    close = frame["Close"].astype(float)
    prev = close.shift(1)
    tr = pd.concat([
        frame["High"].astype(float) - frame["Low"].astype(float),
        (frame["High"].astype(float) - prev).abs(),
        (frame["Low"].astype(float) - prev).abs(),
    ], axis=1).max(axis=1)
    return float(tr.tail(period).mean()) if len(tr) >= period else None


def _linear_slope_pct(values):
    values = np.asarray(values, dtype=float)
    if len(values) < 3 or np.isnan(values).any():
        return 0.0
    x = np.arange(len(values))
    if values.max() <= 0:
        return 0.0
    slope, _ = np.polyfit(x, values / values[0], 1)
    return float(slope)


def detect_vcp(frame, min_bars: int = 60) -> dict:
    """Volatility Contraction Pattern.

    Identifies a base in which high-low range contracts across successive
    pullbacks while price holds near the top of the base. Higher score means a
    tighter, more established contraction setup.
    """
    if _require(frame, min_bars) is None:
        return {"pattern": "vcp", "detected": False, "score": 0, "reason": "insufficient data"}
    frame = frame.dropna(subset=["High", "Low", "Close"]).reset_index(drop=True)
    if len(frame) < min_bars:
        return {"pattern": "vcp", "detected": False, "score": 0, "reason": "insufficient data"}

    close = frame["Close"].astype(float)
    mid = _body_mid(frame)
    range_pct = frame.apply(_range_pct, axis=1).astype(float)

    base = frame.tail(60)
    base_high = float(base["High"].max())
    base_low = float(base["Low"].min())
    if base_high <= 0 or base_low <= 0:
        return {"pattern": "vcp", "detected": False, "score": 0, "reason": "invalid base"}
    base_range_pct = (base_high - base_low) / base_low
    anchor = float(close.iloc[-1])
    if anchor <= 0:
        return {"pattern": "vcp", "detected": False, "score": 0, "reason": "invalid close"}

    # Find pullback troughs (local minima) in the base and the contraction
    # between successive troughs.
    radius = 3
    lows = base["Low"].to_numpy()
    troughs = []
    for i in range(radius, len(base) - radius):
        window = lows[i - radius:i + radius + 1]
        if lows[i] <= window.min():
            troughs.append(i)
    if len(troughs) >= 2:
        trough_volatilities = []
        for i in range(len(troughs) - 1):
            seg = base.iloc[troughs[i]:troughs[i + 1] + 1]
            seg_range = (seg["High"].max() - seg["Low"].min())
            seg_pct = seg_range / seg["Low"].min() if seg["Low"].min() > 0 else None
            if seg_pct:
                trough_volatilities.append(float(seg_pct))
        contraction = True
        if len(trough_volatilities) >= 2:
            contraction = trough_volatilities[-1] < trough_volatilities[-2] * 1.05
    else:
        contraction = True
        trough_volatilities = []

    # Volume should fade as the base tightens (last 10 bars vs base average).
    # True volume contraction = recent volume is significantly lower (< 80% of base average)
    volume = base["Volume"].astype(float).fillna(0)
    base_avg_volume = float(volume.mean()) if len(volume) else 0.0
    recent_volume = float(volume.tail(10).mean())
    volume_fade = recent_volume < base_avg_volume * 0.80 if base_avg_volume > 0 else False

    # Price should hold in the upper portion of the base near the pivot high.
    position_in_base = (anchor - base_low) / (base_high - base_low) if base_high > base_low else 0.5
    near_pivot = position_in_base >= 0.55

    score = 0.0
    evidence = []
    if base_range_pct is not None and base_range_pct <= 0.35:
        score += 25
        evidence.append(f"base range {base_range_pct*100:.1f}% (compact)")
    else:
        score += 5
        evidence.append(f"base range {base_range_pct*100:.1f}% (wide)")
    if contraction:
        score += 30
        evidence.append("pullbacks contracting (tighter volatility)")
    else:
        score += 5
        evidence.append("pullbacks not contracting")
    if volume_fade:
        score += 20
        evidence.append("volume fading into the pivot")
    else:
        score += 5
        evidence.append("volume not fading")
    if near_pivot:
        score += 15
        evidence.append("price holding in upper portion of base")
    else:
        score += 5
        evidence.append("price below mid-base")

    detected = score >= 55
    base_start = int(base.index[0])
    return {
        "pattern": "vcp",
        "detected": detected,
        "score": round(min(score, 100), 1),
        "reason": ", ".join(evidence),
        "detail": {
            "base_range_pct": round(base_range_pct * 100, 2) if base_range_pct is not None else None,
            "position_in_base_pct": round(position_in_base * 100, 1),
            "pullback_ranges_pct": [round(v * 100, 2) for v in trough_volatilities[-6:]],
            "contraction": bool(contraction),
            "volume_fade": bool(volume_fade),
            "anchor": round(anchor, 4),
            "base_high": round(base_high, 4),
            "base_low": round(base_low, 4),
            "markers": [
                {"label": "Base low", "index": int(base["Low"].idxmin()), "position": "belowBar", "color": "#10b981"},
                {"label": "Pivot high", "index": int(base["High"].idxmax()), "position": "aboveBar", "color": "#eab308"},
                *([{"label": "Last pullback", "index": base_start + troughs[-1], "position": "belowBar", "color": "#60a5fa"}] if troughs else []),
            ],
            "trigger": round(base_high, 4),
        },
    }


def detect_cup_handle(frame, min_bars: int = 100) -> dict:
    """Cup-with-handle (William O'Neil style).

    Looks for a U-shaped base (rounded left side, higher right side) followed by
    a small, tight pullback ("handle") in the upper portion of the cup.
    """
    if _require(frame, min_bars) is None:
        return {"pattern": "cup_handle", "detected": False, "score": 0, "reason": "insufficient data"}
    frame = frame.dropna(subset=["High", "Low", "Close"]).reset_index(drop=True)
    if len(frame) < min_bars:
        return {"pattern": "cup_handle", "detected": False, "score": 0, "reason": "insufficient data"}

    window = frame.tail(90).reset_index(drop=True)
    high = window["High"].astype(float)
    low = window["Low"].astype(float)
    close = window["Close"].astype(float)
    cup_high = float(high.max())
    cup_low = float(low.min())
    cup_low_idx = int(low.idxmin())
    if cup_high <= 0 or cup_low <= 0:
        return {"pattern": "cup_handle", "detected": False, "score": 0, "reason": "invalid cup"}

    cup_depth_pct = (cup_high - cup_low) / cup_high * 100
    cup_len = len(window)

    # Cup must be reasonably deep (>= 8%) but not a crash (<= 60%), and the low
    # should be near the middle of the window (a rounded U, not a V).
    mid_idx = len(window) / 2
    low_in_middle = mid_idx * 0.30 <= cup_low_idx <= mid_idx * 1.70
    right_side = window.loc[cup_low_idx:]
    if len(right_side) < 5:
        return {"pattern": "cup_handle", "detected": False, "score": 0, "reason": "cup too short"}
    right_recovery = (float(right_side["Close"].iloc[-1]) - cup_low) / cup_low

    # Handle: the last ~10-20 bars should form a small tight pullback off the
    # right-side high, staying in the upper part of the cup.
    handle = window.tail(15)
    handle_high = float(handle["High"].max())
    handle_low = float(handle["Low"].min())
    handle_tightness = (handle_high - handle_low) / cup_low if cup_low > 0 else 1.0
    handle_in_upper = (handle_low - cup_low) / (cup_high - cup_low) >= 0.40 if cup_high > cup_low else False
    handle_drift_down = handle_low <= float(handle["High"].iloc[0])

    score = 0.0
    evidence = []
    if 8 <= cup_depth_pct <= 60:
        score += 30
        evidence.append(f"cup depth {cup_depth_pct:.1f}%")
    else:
        score += 8
        evidence.append(f"cup depth {cup_depth_pct:.1f}% (unusual)")
    if low_in_middle:
        score += 20
        evidence.append("U-shaped (low near middle)")
    else:
        score += 5
        evidence.append("low not centered (V-shaped)")
    if right_recovery >= 0.25:
        score += 20
        evidence.append(f"right side recovered {right_recovery*100:.0f}%")
    else:
        score += 5
        evidence.append("right side weak recovery")
    if handle_tightness <= 0.20:
        score += 15
        evidence.append(f"tight handle ({handle_tightness*100:.1f}% range)")
    else:
        score += 3
        evidence.append("handle not tight")
    if handle_in_upper:
        score += 10
        evidence.append("handle in upper cup")
    if handle_drift_down:
        score += 5
        evidence.append("handle drifting down")

    detected = score >= 65
    window_start = len(frame) - len(window)
    cup_high_idx = int(high.idxmax())
    handle_start_idx = max(cup_len - 15, 0)
    return {
        "pattern": "cup_handle",
        "detected": detected,
        "score": round(min(score, 100), 1),
        "reason": ", ".join(evidence),
        "detail": {
            "cup_depth_pct": round(cup_depth_pct, 2),
            "cup_low_position_ratio": round(cup_low_idx / cup_len, 2),
            "right_recovery_pct": round(right_recovery * 100, 1),
            "handle_tightness_pct": round(handle_tightness * 100, 2),
            "handle_in_upper": bool(handle_in_upper),
            "anchor": round(float(close.iloc[-1]), 4),
            "cup_high": round(cup_high, 4),
            "cup_low": round(cup_low, 4),
            "markers": [
                {"label": "Cup low", "index": window_start + cup_low_idx, "position": "belowBar", "color": "#10b981"},
                {"label": "Cup high", "index": window_start + cup_high_idx, "position": "aboveBar", "color": "#eab308"},
                {"label": "Handle", "index": window_start + handle_start_idx, "position": "belowBar", "color": "#60a5fa"},
            ],
            "trigger": round(cup_high, 4),
        },
    }


def detect_bull_flag(frame, min_bars: int = 50) -> dict:
    """Bull flag.

    Sharp vertical rally (pole) followed by a tight, slightly downward-sloping
    consolidation (flag) near the highs. High score = steep pole plus tight flag.
    """
    if _require(frame, min_bars) is None:
        return {"pattern": "bull_flag", "detected": False, "score": 0, "reason": "insufficient data"}
    frame = frame.dropna(subset=["High", "Low", "Close"]).reset_index(drop=True)
    if len(frame) < min_bars:
        return {"pattern": "bull_flag", "detected": False, "score": 0, "reason": "insufficient data"}

    window = frame.tail(50).reset_index(drop=True)
    close = window["Close"].astype(float)
    high = window["High"].astype(float)
    low = window["Low"].astype(float)

    # Pole: strongest up-move in the window.
    pole_start = int(close.iloc[: len(window) // 2].idxmin())
    pole_end = int(high.iloc[pole_start:].idxmax())
    if pole_end <= pole_start or close.iloc[pole_start] <= 0:
        return {"pattern": "bull_flag", "detected": False, "score": 0, "reason": "no clear pole"}
    pole_return = (high.iloc[pole_end] - close.iloc[pole_start]) / close.iloc[pole_start] * 100

    # Flag: bars after the pole high, before the last bar.
    flag_start = pole_end + 1
    flag = window.iloc[flag_start:]
    if len(flag) < 4:
        return {"pattern": "bull_flag", "detected": False, "score": 0, "reason": "no flag yet"}
    flag_range = (float(flag["High"].max()) - float(flag["Low"].min())) / float(flag["Low"].min())
    flag_slope = _linear_slope_pct(flag["Close"].to_numpy())
    near_highs = float(flag["Close"].iloc[-1]) >= float(high.max()) * 0.97

    score = 0.0
    evidence = []
    if pole_return >= 10:
        score += 35
        evidence.append(f"pole {pole_return:.0f}%")
    else:
        score += 8
        evidence.append(f"pole only {pole_return:.0f}%")
    if flag_range <= 0.10:
        score += 30
        evidence.append(f"tight flag ({flag_range*100:.1f}% range)")
    else:
        score += 8
        evidence.append(f"loose flag ({flag_range*100:.1f}% range)")
    if flag_slope < 0.01:
        score += 15
        evidence.append("flag sloping flat/down")
    else:
        score += 5
        evidence.append("flag sloping up (less ideal)")
    if near_highs:
        score += 15
        evidence.append("price near flag highs")
    else:
        score += 5
        evidence.append("price below flag highs")

    detected = score >= 60
    window_start = len(frame) - len(window)
    return {
        "pattern": "bull_flag",
        "detected": detected,
        "score": round(min(score, 100), 1),
        "reason": ", ".join(evidence),
        "detail": {
            "pole_return_pct": round(pole_return, 1),
            "flag_range_pct": round(flag_range * 100, 2),
            "flag_slope_pct_per_bar": round(flag_slope * 100, 3),
            "near_highs": bool(near_highs),
            "anchor": round(float(close.iloc[-1]), 4),
            "pole_high": round(float(high.iloc[pole_end]), 4),
            "markers": [
                {"label": "Pole start", "index": window_start + pole_start, "position": "belowBar", "color": "#3b82f6"},
                {"label": "Pole high", "index": window_start + pole_end, "position": "aboveBar", "color": "#eab308"},
                {"label": "Flag", "index": window_start + pole_end + 1, "position": "belowBar", "color": "#10b981"},
            ],
            "trigger": round(float(high.iloc[pole_end]), 4),
        },
    }


def detect_bear_flag(frame, min_bars: int = 50) -> dict:
    """Bear flag (mirror of bull flag, for completeness)."""
    result = detect_bull_flag(frame, min_bars=min_bars)
    if not result.get("detected") and result.get("score", 0) > 0:
        return result
    # Flip logic: strong down move followed by tight consolidation near lows.
    if _require(frame, min_bars) is None:
        return {"pattern": "bear_flag", "detected": False, "score": 0, "reason": "insufficient data"}
    frame = frame.dropna(subset=["High", "Low", "Close"]).reset_index(drop=True)
    if len(frame) < min_bars:
        return {"pattern": "bear_flag", "detected": False, "score": 0, "reason": "insufficient data"}
    window = frame.tail(50).reset_index(drop=True)
    close = window["Close"].astype(float)
    low = window["Low"].astype(float)
    pole_start = int(close.iloc[: len(window) // 2].idxmax())
    pole_end = int(low.iloc[pole_start:].idxmin())
    if pole_end <= pole_start or close.iloc[pole_start] <= 0:
        return {"pattern": "bear_flag", "detected": False, "score": 0, "reason": "no clear pole"}
    pole_drop = (low.iloc[pole_end] - close.iloc[pole_start]) / close.iloc[pole_start] * 100
    flag = window.iloc[pole_end + 1:]
    if len(flag) < 4:
        return {"pattern": "bear_flag", "detected": False, "score": 0, "reason": "no flag yet"}
    flag_range = (float(flag["High"].max()) - float(flag["Low"].min())) / float(flag["Low"].min())
    flag_slope = _linear_slope_pct(flag["Close"].to_numpy())
    score = 0.0
    evidence = []
    if pole_drop <= -10:
        score += 35
        evidence.append(f"pole drop {abs(pole_drop):.0f}%")
    else:
        score += 8
        evidence.append(f"pole drop only {abs(pole_drop):.0f}%")
    if flag_range <= 0.10:
        score += 30
        evidence.append(f"tight flag ({flag_range*100:.1f}% range)")
    else:
        score += 8
        evidence.append(f"loose flag ({flag_range*100:.1f}% range)")
    if flag_slope > -0.01:
        score += 15
        evidence.append("flag consolidating flat/up")
    else:
        score += 5
        evidence.append("flag still sloping down")
    detected = score >= 60
    window_start = len(frame) - len(window)
    return {
        "pattern": "bear_flag",
        "detected": detected,
        "score": round(min(score, 100), 1),
        "reason": ", ".join(evidence),
        "detail": {
            "pole_drop_pct": round(pole_drop, 1),
            "flag_range_pct": round(flag_range * 100, 2),
            "flag_slope_pct_per_bar": round(flag_slope * 100, 3),
            "anchor": round(float(close.iloc[-1]), 4),
            "markers": [
                {"label": "Pole start", "index": window_start + pole_start, "position": "aboveBar", "color": "#3b82f6"},
                {"label": "Pole low", "index": window_start + pole_end, "position": "belowBar", "color": "#ef4444"},
                {"label": "Flag", "index": window_start + pole_end + 1, "position": "belowBar", "color": "#10b981"},
            ],
            "trigger": round(float(low.iloc[pole_end]), 4),
        },
    }


DETECTORS = {
    "vcp": detect_vcp,
    "cup_handle": detect_cup_handle,
    "bull_flag": detect_bull_flag,
    "bear_flag": detect_bear_flag,
}


def detect_all(frame, patterns=None, min_bars: int = 60) -> list:
    """Run all (or selected) detectors against a frame and return ranked results."""
    selected = [p for p in (patterns or list(DETECTORS.keys())) if p in DETECTORS]
    results = []
    for name in selected:
        try:
            detector = DETECTORS[name]
            result = detector(frame, min_bars=min_bars)
            results.append(result)
        except Exception as exc:
            logger.warning("Pattern detector %s failed: %s", name, exc)
            results.append({"pattern": name, "detected": False, "score": 0, "reason": f"error: {exc}"})
    results.sort(key=lambda r: r.get("score", 0), reverse=True)
    return results
