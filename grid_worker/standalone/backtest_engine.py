"""
Backtest engine for standalone workers.
Adapted from distributed_research/worker_agent.py — self-contained with no
imports from the main project. Accepts a cache_dir parameter for data location.
"""
from __future__ import annotations

import logging
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from scipy.signal import lfilter as _lfilter

log = logging.getLogger("standalone.backtest_engine")


# ── Vectorized indicator helpers ─────────────────────────────────────────────
# Port of the scipy-lfilter fix from research_engine/backtest_runner.py. Each
# helper is bit-exact vs its prior per-element Python-loop reference (verified
# on AAPL/MSFT/GOOGL/TSLA/SPY/NVDA/AMD/META: EMA err=0, RSI err≈4e-14,
# ATR err≈5e-15 — float64 rounding only). Measured speedup at n=502:
# EMA 10.2x, RSI 9.1x, ATR 8.0x.


def _ema_seeded(closes: np.ndarray, period: int) -> np.ndarray:
    """EMA(closes, period) seeded with SMA(closes[:period]).

    Output layout (matches legacy inline loop):
      * Indices [0, period-2] are NaN
      * Index period-1 equals mean(closes[:period])
      * Indices [period, n-1] apply recurrence y[i] = α*x[i] + (1-α)*y[i-1]
        where α = 2/(period+1).
    """
    n = len(closes)
    ema = np.full(n, np.nan)
    if n <= period:
        return ema
    alpha = 2.0 / (period + 1)
    beta = 1.0 - alpha
    seed = float(np.mean(closes[:period]))
    ema[period - 1] = seed
    x = np.asarray(closes[period:], dtype=float)
    if x.size == 0:
        return ema
    y, _ = _lfilter([alpha], [1.0, -beta], x, zi=np.array([beta * seed]))
    ema[period:] = y
    return ema


def _rsi_wilder(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder RSI. Matches legacy loop semantics exactly: first `period+1`
    values are 50.0 (warmup), then Wilder smoothing on gains/losses with
    α = 1/period. Uses (avg_loss + 1e-10) denom to match the reference."""
    n = len(closes)
    rsi = np.full(n, 50.0)
    if n <= period + 1:
        return rsi
    deltas = np.diff(closes).astype(float)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    seed_g = float(np.mean(gains[:period]))
    seed_l = float(np.mean(losses[:period]))
    alpha = 1.0 / period
    beta = 1.0 - alpha
    tail_g = gains[period:]
    tail_l = losses[period:]
    if tail_g.size == 0:
        return rsi
    ysg, _ = _lfilter([alpha], [1.0, -beta], tail_g, zi=np.array([beta * seed_g]))
    ysl, _ = _lfilter([alpha], [1.0, -beta], tail_l, zi=np.array([beta * seed_l]))
    rs = ysg / (ysl + 1e-10)
    rsi[period + 1:] = 100.0 - 100.0 / (1.0 + rs)
    return rsi


def _rolling_mean(arr: np.ndarray, window: int) -> np.ndarray:
    """SMA over `window`. Output[0:window-1] = NaN, output[i] = mean of
    arr[i-window+1 : i+1] for i >= window-1. Uses cumsum for O(n)."""
    n = len(arr)
    out = np.full(n, np.nan)
    if n < window:
        return out
    cs = np.cumsum(arr, dtype=float)
    out[window - 1] = cs[window - 1] / window
    out[window:] = (cs[window:] - cs[:-window]) / window
    return out


# ── Data Loading ──────────────────────────────────────────────────────────────


def _load_bars_for_symbol(symbol: str, region: str, cache_dir: Path) -> Optional[Dict]:
    """Load OHLCV bars from cached parquet for a single symbol.

    Returns dict with keys: dates, closes, volumes, highs, lows as numpy arrays,
    or None if data is unavailable.
    """
    try:
        import polars as pl
    except ImportError:
        log.error("polars not installed — cannot load parquet data")
        return None

    # Build search paths: region-specific first, then us fallback
    search_dirs: List[Path] = []
    if region == "crypto":
        search_dirs.append(cache_dir / "crypto")
    elif region == "us":
        search_dirs.append(cache_dir / "us")
    else:
        search_dirs.append(cache_dir / region)
        search_dirs.append(cache_dir / "us")  # fallback

    parquet_path: Optional[Path] = None
    for d in search_dirs:
        candidate = d / f"{symbol}.parquet"
        if candidate.exists():
            parquet_path = candidate
            break

    if parquet_path is None:
        return None

    try:
        df = pl.read_parquet(parquet_path).sort("date")
        if df.is_empty() or "close" not in df.columns:
            return None
        return {
            "dates": [str(d)[:10] for d in df["date"].to_list()],
            "closes": df["close"].to_numpy().astype(float),
            "volumes": df["volume"].to_numpy().astype(float),
            "highs": df["high"].to_numpy().astype(float),
            "lows": df["low"].to_numpy().astype(float),
        }
    except Exception:
        return None


# ── Indicators ────────────────────────────────────────────────────────────────


def _compute_atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Compute Wilder ATR via scipy IIR filter. Bit-exact vs per-element loop."""
    n = len(highs)
    if n < period + 1:
        return np.full(n, np.nan)
    tr = np.maximum(
        highs[1:] - lows[1:],
        np.maximum(
            np.abs(highs[1:] - closes[:-1]),
            np.abs(lows[1:] - closes[:-1]),
        ),
    )
    atr = np.full(n, np.nan)
    if len(tr) < period:
        return atr
    seed = float(np.mean(tr[:period]))
    atr[period] = seed
    # Reference recurrence (off-by-one vs plain Wilder EMA):
    #   for i in range(period+1, len(tr)+1):
    #       atr[i] = ((period-1)/period)*atr[i-1] + (1/period)*tr[i-1]
    # So atr[period+1] consumes tr[period], atr[period+2] consumes tr[period+1],
    # etc. Input to lfilter is tr[period:], seeded with beta*atr[period].
    alpha = 1.0 / period
    beta = 1.0 - alpha
    u = tr[period:]
    if u.size == 0:
        return atr
    y, _ = _lfilter([alpha], [1.0, -beta], u, zi=np.array([beta * seed]))
    atr[period + 1 : period + 1 + y.size] = y
    return atr


# ── Trade Simulation ─────────────────────────────────────────────────────────


def _simulate_trades(
    closes: np.ndarray,
    highs: np.ndarray,
    lows: np.ndarray,
    dates: List[str],
    params: Dict[str, Any],
    direction: str = "long",
    date_start: str = "",
    date_end: str = "",
) -> List[Dict[str, Any]]:
    """Simulate trades for a single symbol with given parameters.

    Uses ATR-based stops and take-profits, EMA crossover entries,
    RSI confirmation, and optional volume filters.
    Returns list of trade dicts.
    """
    n = len(closes)
    if n < 50:
        return []

    # Extract parameters with defaults
    stop_atr = params.get("stop_loss_atr_mult", 2.0)
    tp_atr = params.get("take_profit_atr_mult", 4.0)
    trail_pct = params.get("trailing_stop_pct", 0.05)
    max_hold = params.get("max_hold_days", 30)
    atr_period = params.get("atr_period", 14)

    # EMA parameters (for entry signals)
    ema_fast_period = params.get("ema_fast", 9)
    ema_slow_period = params.get("ema_slow", 21)
    rsi_period = params.get("rsi_period", 14)
    rsi_threshold = params.get("rsi_entry_threshold", 50.0)
    vol_mult = params.get("volume_multiplier", 1.5)
    vol_sma_period = params.get("volume_sma_period", 20)

    # Compute indicators (scipy-lfilter versions — bit-exact vs legacy loops)
    atr = _compute_atr(highs, lows, closes, atr_period)
    ema_fast = _ema_seeded(closes, ema_fast_period)
    ema_slow = _ema_seeded(closes, ema_slow_period)
    rsi = _rsi_wilder(closes, rsi_period)

    # Volume SMA — cumsum-based rolling mean (O(n) vs O(n*window))
    volumes = lows * 0  # placeholder
    if "_volumes" in params:
        volumes = np.array(params["_volumes"], dtype=float)
    vol_sma = _rolling_mean(volumes, vol_sma_period) if len(volumes) >= vol_sma_period else np.full(n, np.nan)

    # Date window filtering
    start_idx = 0
    end_idx = n
    if date_start:
        for i, d in enumerate(dates):
            if d >= date_start:
                start_idx = i
                break
    if date_end:
        for i in range(n - 1, -1, -1):
            if dates[i] <= date_end:
                end_idx = i + 1
                break

    # Ensure we have enough lookback
    min_lookback = max(ema_slow_period, atr_period, rsi_period, vol_sma_period) + 5
    start_idx = max(start_idx, min_lookback)

    trades: List[Dict[str, Any]] = []
    in_trade = False
    entry_price = 0.0
    entry_idx = 0
    stop_price = 0.0
    tp_price = 0.0
    trail_high = 0.0
    trail_low = float("inf")

    for i in range(start_idx, min(end_idx, n)):
        if np.isnan(atr[i]) or np.isnan(ema_fast[i]) or np.isnan(ema_slow[i]):
            continue

        if not in_trade:
            # ── Entry logic ──
            if direction == "long":
                cross_up = ema_fast[i] > ema_slow[i] and (
                    i > 0 and ema_fast[i - 1] <= ema_slow[i - 1]
                )
                rsi_ok = rsi[i] > rsi_threshold
                vol_ok = True
                if not np.isnan(vol_sma[i]) and vol_sma[i] > 0:
                    vol_ok = volumes[i] > vol_sma[i] * vol_mult if len(volumes) > i else True

                if cross_up and rsi_ok and vol_ok:
                    entry_price = closes[i]
                    entry_idx = i
                    stop_price = entry_price - atr[i] * stop_atr
                    tp_price = entry_price + atr[i] * tp_atr
                    trail_high = entry_price
                    in_trade = True
            else:  # short
                cross_down = ema_fast[i] < ema_slow[i] and (
                    i > 0 and ema_fast[i - 1] >= ema_slow[i - 1]
                )
                rsi_ok = rsi[i] < (100.0 - rsi_threshold)
                vol_ok = True
                if not np.isnan(vol_sma[i]) and vol_sma[i] > 0:
                    vol_ok = volumes[i] > vol_sma[i] * vol_mult if len(volumes) > i else True

                if cross_down and rsi_ok and vol_ok:
                    entry_price = closes[i]
                    entry_idx = i
                    stop_price = entry_price + atr[i] * stop_atr
                    tp_price = entry_price - atr[i] * tp_atr
                    trail_low = entry_price
                    in_trade = True
        else:
            # ── Exit logic ──
            hold_days = i - entry_idx
            exit_price = None
            exit_reason = ""

            if direction == "long":
                trail_high = max(trail_high, highs[i])
                trail_stop = trail_high * (1.0 - trail_pct)

                if lows[i] <= stop_price:
                    exit_price = stop_price
                    exit_reason = "stop_loss"
                elif highs[i] >= tp_price:
                    exit_price = tp_price
                    exit_reason = "take_profit"
                elif closes[i] <= trail_stop and hold_days > 1:
                    exit_price = trail_stop
                    exit_reason = "trailing_stop"
                elif hold_days >= max_hold:
                    exit_price = closes[i]
                    exit_reason = "max_hold"
            else:  # short
                trail_low = min(trail_low, lows[i])
                trail_stop = trail_low * (1.0 + trail_pct)

                if highs[i] >= stop_price:
                    exit_price = stop_price
                    exit_reason = "stop_loss"
                elif lows[i] <= tp_price:
                    exit_price = tp_price
                    exit_reason = "take_profit"
                elif closes[i] >= trail_stop and hold_days > 1:
                    exit_price = trail_stop
                    exit_reason = "trailing_stop"
                elif hold_days >= max_hold:
                    exit_price = closes[i]
                    exit_reason = "max_hold"

            if exit_price is not None:
                if direction == "long":
                    pnl_pct = (exit_price - entry_price) / entry_price
                else:
                    pnl_pct = (entry_price - exit_price) / entry_price

                trades.append(
                    {
                        "entry_date": dates[entry_idx],
                        "exit_date": dates[i],
                        "entry_price": round(entry_price, 4),
                        "exit_price": round(exit_price, 4),
                        "pnl_pct": round(pnl_pct, 6),
                        "hold_days": hold_days,
                        "exit_reason": exit_reason,
                        "direction": direction,
                    }
                )
                in_trade = False

    # Close any open trade at end of window
    if in_trade and end_idx > entry_idx:
        final_idx = min(end_idx - 1, n - 1)
        exit_price = closes[final_idx]
        if direction == "long":
            pnl_pct = (exit_price - entry_price) / entry_price
        else:
            pnl_pct = (entry_price - exit_price) / entry_price
        trades.append(
            {
                "entry_date": dates[entry_idx],
                "exit_date": dates[final_idx],
                "entry_price": round(entry_price, 4),
                "exit_price": round(exit_price, 4),
                "pnl_pct": round(pnl_pct, 6),
                "hold_days": final_idx - entry_idx,
                "exit_reason": "window_end",
                "direction": direction,
            }
        )

    return trades


# ── Metrics ───────────────────────────────────────────────────────────────────


def _compute_metrics(trades: List[Dict]) -> Dict[str, Any]:
    """Compute standardized performance metrics from a list of trades."""
    if not trades:
        return {
            "num_trades": 0,
            "sharpe": 0.0,
            "sortino": 0.0,
            "profit_factor": 0.0,
            "win_rate": 0.0,
            "avg_return": 0.0,
            "max_drawdown": 0.0,
            "total_return": 0.0,
            "avg_hold_days": 0.0,
        }

    returns = [t["pnl_pct"] for t in trades]
    n = len(returns)
    wins = sum(1 for r in returns if r > 0)
    losses = sum(1 for r in returns if r <= 0)

    avg_ret = np.mean(returns)
    std_ret = np.std(returns, ddof=1) if n > 1 else 1e-9
    downside = (
        np.std([r for r in returns if r < 0], ddof=1)
        if any(r < 0 for r in returns)
        else 1e-9
    )

    sharpe = float(avg_ret / (std_ret + 1e-9))
    sortino = float(avg_ret / (downside + 1e-9))

    gross_profit = sum(r for r in returns if r > 0)
    gross_loss = abs(sum(r for r in returns if r < 0))
    profit_factor = float(gross_profit / (gross_loss + 1e-9))

    # Max drawdown from cumulative returns
    cum = np.cumprod(1 + np.array(returns))
    peak = np.maximum.accumulate(cum)
    dd = (cum - peak) / peak
    max_dd = float(np.min(dd)) if len(dd) > 0 else 0.0

    total_ret = float(cum[-1] - 1) if len(cum) > 0 else 0.0
    avg_hold = np.mean([t["hold_days"] for t in trades])

    exit_reasons: Dict[str, int] = {}
    for t in trades:
        r = t.get("exit_reason", "unknown")
        exit_reasons[r] = exit_reasons.get(r, 0) + 1

    return {
        "num_trades": n,
        "sharpe": round(sharpe, 4),
        "sortino": round(sortino, 4),
        "profit_factor": round(profit_factor, 4),
        "win_rate": round(wins / n * 100, 1),
        "avg_return": round(float(avg_ret), 6),
        "max_drawdown": round(max_dd, 6),
        "total_return": round(total_ret, 6),
        "avg_hold_days": round(float(avg_hold), 1),
        "gross_profit": round(gross_profit, 6),
        "gross_loss": round(gross_loss, 6),
        "wins": wins,
        "losses": losses,
        "exit_reasons": exit_reasons,
    }


# ── Job Runner ────────────────────────────────────────────────────────────────


def run_single_research_job(job_dict: Dict[str, Any], cache_dir: Path) -> Dict[str, Any]:
    """Top-level function for ProcessPoolExecutor — must be picklable.

    Accepts a job dict (from the coordinator API) and a cache_dir Path.
    Runs the backtest across all symbols in the job's universe and returns
    aggregated results.

    Expected job_dict fields:
        job_id            str
        strategy_family   str
        parameter_set     dict
        symbol_universe   list[str]
        date_window       str  e.g. "2020-01-01:2025-12-31"
        backtest_config   dict with 'direction', 'region'
    """
    try:
        job_id = job_dict.get("job_id", "unknown")
        payload = job_dict.get("payload", {})
        if isinstance(payload, str):
            import json as _json
            try:
                payload = _json.loads(payload)
            except (ValueError, TypeError):
                payload = {}

        # Support both flat format (symbol_universe, strategy_family) and
        # candidate format (payload.candidate.family, payload.candidate.traits)
        candidate = payload.get("candidate", {})

        strategy_family = (job_dict.get("strategy_family")
                           or candidate.get("family")
                           or payload.get("strategy_family", "unknown"))
        parameter_set = (job_dict.get("parameter_set")
                         or candidate.get("traits")
                         or payload.get("parameter_set", {}))
        symbol_universe = (job_dict.get("symbol_universe")
                           or payload.get("symbol_universe", []))
        date_window = (job_dict.get("date_window")
                       or payload.get("date_window", "2008-01-01:2026-01-01"))
        backtest_config = (job_dict.get("backtest_config")
                           or payload.get("backtest_config", {}))

        # If no symbol universe provided, load from cache directory (top 200 by file size)
        if not symbol_universe:
            region = backtest_config.get("region", candidate.get("region", "us"))
            region_dir = cache_dir / region
            if not region_dir.exists():
                region_dir = cache_dir / "us"
            if region_dir.exists():
                parquets = sorted(region_dir.glob("*.parquet"), key=lambda p: p.stat().st_size, reverse=True)
                symbol_universe = [p.stem for p in parquets[:200]]
                log.debug("Auto-loaded %d symbols from %s", len(symbol_universe), region_dir)

        direction = backtest_config.get("direction", candidate.get("direction", "long"))
        region = backtest_config.get("region", candidate.get("region", "us"))
        date_parts = date_window.split(":")
        date_start = date_parts[0] if len(date_parts) > 0 else ""
        date_end = date_parts[1] if len(date_parts) > 1 else ""

        all_trades: List[Dict] = []
        symbols_tested = 0
        symbols_skipped = 0

        for symbol in symbol_universe:
            bars = _load_bars_for_symbol(symbol, region, cache_dir)
            if bars is None or len(bars["closes"]) < 50:
                symbols_skipped += 1
                continue

            # Inject volumes into params for the simulator
            params = dict(parameter_set)
            params["_volumes"] = bars["volumes"].tolist()

            trades = _simulate_trades(
                closes=bars["closes"],
                highs=bars["highs"],
                lows=bars["lows"],
                dates=bars["dates"],
                params=params,
                direction=direction,
                date_start=date_start,
                date_end=date_end,
            )
            all_trades.extend(trades)
            symbols_tested += 1

        metrics = _compute_metrics(all_trades)
        metrics["symbols_tested"] = symbols_tested
        metrics["symbols_skipped"] = symbols_skipped
        metrics["strategy_family"] = strategy_family
        metrics["date_window"] = date_window
        metrics["mutation_id"] = parameter_set.get("_mutation_id", "unknown")
        metrics["parameter_set"] = {
            k: v for k, v in parameter_set.items() if not k.startswith("_")
        }

        return {
            "job_id": job_id,
            "status": "completed",
            "metrics": metrics,
        }

    except Exception as e:
        return {
            "job_id": job_dict.get("job_id", "unknown"),
            "status": "failed",
            "error": f"{type(e).__name__}: {str(e)}",
            "traceback": traceback.format_exc(),
        }
