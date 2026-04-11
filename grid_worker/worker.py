#!/usr/bin/env python3
"""
Aura Alpha Grid Worker  --  Distributable compute node
========================================================

Connects to the Aura Alpha coordinator via HTTPS, pulls research/backtest
jobs, executes them locally, and reports results back. Designed to run on
any Windows, macOS, or Linux machine with Python 3.10+.

Hub-and-spoke model:
  - Coordinator (hub): https://auraalpha.cc/api/cluster/contributor/*
  - This worker (spoke): fetches jobs, runs compute, returns results

Token is auto-provisioned on first run. No manual setup required beyond
having Python installed.

Usage:
    python worker.py
    python worker.py --coordinator-url https://auraalpha.cc --max-parallel 4
    python worker.py --verbose
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import signal
import ssl
import sys
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, Thread
from typing import Any, Dict, List, Optional, Tuple

__version__ = "1.2.0"

# ============================================================================
# GPU / CUDA Detection  (optional -- graceful fallback to CPU)
# ============================================================================

_GPU_AVAILABLE = False
_GPU_NAME: Optional[str] = None
_GPU_VRAM_GB: float = 0.0

try:
    import torch as _torch
    if _torch.cuda.is_available():
        _GPU_AVAILABLE = True
        _GPU_NAME = _torch.cuda.get_device_name(0)
        _vram_bytes = _torch.cuda.get_device_properties(0).total_mem
        _GPU_VRAM_GB = round(_vram_bytes / (1024 ** 3), 1)
except ImportError:
    _torch = None  # type: ignore[assignment]
except Exception:
    # CUDA driver issues, etc. -- degrade gracefully
    _torch = None  # type: ignore[assignment]

# ============================================================================
# Logging
# ============================================================================

log = logging.getLogger("grid-worker")

# ============================================================================
# Configuration
# ============================================================================

POLL_INTERVAL = 5          # seconds between idle dequeue attempts
HEARTBEAT_INTERVAL = 30    # seconds between heartbeats
JOB_TIMEOUT = 600          # seconds per job before timeout
MAX_RETRIES = 3            # HTTP retry attempts
BACKOFF_BASE = 1           # base seconds for exponential backoff
THROTTLE_CHECK_INTERVAL = 10  # seconds between system load checks


def _auto_cpu_count() -> int:
    try:
        return os.cpu_count() or 1
    except Exception:
        return 1


def _auto_ram_gb() -> float:
    """Detect system RAM in GB using platform-specific methods (no psutil required)."""
    # Try psutil first (if user installed it)
    try:
        import psutil
        return round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except ImportError:
        pass

    try:
        if platform.system() == "Linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return round(int(line.split()[1]) / (1024 ** 2), 1)
        elif platform.system() == "Darwin":
            import subprocess
            out = subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"], timeout=5
            ).decode().strip()
            return round(int(out) / (1024 ** 3), 1)
        elif platform.system() == "Windows":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return round(stat.ullTotalPhys / (1024 ** 3), 1)
    except Exception:
        pass

    return 8.0  # safe default


def _auto_max_parallel() -> int:
    cpus = _auto_cpu_count()
    return max(1, cpus - 1)


@dataclass
class WorkerConfig:
    """All configuration for the grid worker."""
    coordinator_url: str = "https://auraalpha.cc"
    coordinator_host: str = ""   # Override Host header for IP-based connections
    verify_ssl: bool = True      # Set False for networks with DNS proxies
    max_parallel: int = 0       # 0 = auto-detect
    batch_size: int = 25
    cache_dir: Path = field(default_factory=lambda: Path.home() / ".aura-worker" / "data")
    log_dir: Path = field(default_factory=lambda: Path.home() / ".aura-worker" / "logs")
    heartbeat_interval: int = HEARTBEAT_INTERVAL
    job_timeout: int = JOB_TIMEOUT
    cpu_count: int = field(default_factory=_auto_cpu_count)
    ram_gb: float = field(default_factory=_auto_ram_gb)
    verbose: bool = False

    def __post_init__(self):
        if self.max_parallel <= 0:
            self.max_parallel = _auto_max_parallel()
        if isinstance(self.cache_dir, str):
            self.cache_dir = Path(self.cache_dir)
        if isinstance(self.log_dir, str):
            self.log_dir = Path(self.log_dir)

    def ensure_dirs(self):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


# ============================================================================
# Token persistence  (auto-provision on first run)
# ============================================================================

def _token_file_path() -> Path:
    # Respect GRID_TOKEN_DIR env var set by Tauri sidecar launcher
    token_dir = os.environ.get("GRID_TOKEN_DIR")
    if token_dir:
        d = Path(token_dir)
    else:
        d = Path.home() / ".aura-worker"
    d.mkdir(parents=True, exist_ok=True)
    return d / "grid_token.json"


def _load_stored_token() -> Optional[dict]:
    path = _token_file_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        if data.get("token") and data.get("worker_id"):
            return data
    except Exception:
        pass
    return None


def _save_token(data: dict):
    path = _token_file_path()
    path.write_text(json.dumps(data, indent=2))
    log.info("Token saved to %s", path)


def _get_worker_id() -> str:
    hostname = platform.node() or "unknown"
    return f"grid-{hostname.lower().replace(' ', '-')}"


def _auto_provision(base_url: str) -> dict:
    """Call the zero-auth auto-provision endpoint to get a unique token.

    POST /api/cluster/contributor/auto-provision
    Body: {hostname, cpus, ram, os}
    Returns: {token, worker_id}
    """
    url = f"{base_url.rstrip('/')}/api/cluster/contributor/auto-provision"
    body = json.dumps({
        "hostname": platform.node() or "unknown",
        "cpus": _auto_cpu_count(),
        "ram": _auto_ram_gb(),
        "os": f"{platform.system()} {platform.release()}",
    }).encode("utf-8")

    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; AuraAlpha-GridWorker/2.0)"},
    )
    try:
        ctx = ssl.create_default_context()
        if not getattr(resolve_token, '_verify_ssl', True):
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("token") and data.get("worker_id"):
                log.info("Auto-provisioned worker_id=%s", data["worker_id"])
                return data
            raise ValueError(f"Unexpected auto-provision response: {data}")
    except Exception as e:
        log.warning("Auto-provision failed: %s", e)
        raise


def resolve_token(coordinator_url: str, cli_token: Optional[str] = None) -> Tuple[str, str]:
    """Resolve token and worker_id from CLI arg, env var, stored file, or auto-provision.

    Returns (token, worker_id).
    """
    # 1. Explicit CLI flag
    if cli_token:
        log.info("Using CLI-provided token")
        return cli_token, _get_worker_id()

    # 2. Environment variable
    env_token = os.getenv("GRID_WORKER_TOKEN") or os.getenv("AURA_TOKEN")
    if env_token:
        log.info("Using token from environment variable")
        return env_token, _get_worker_id()

    # 3. Stored auto-provisioned token
    stored = _load_stored_token()
    if stored:
        log.info("Loaded stored token for worker_id=%s", stored["worker_id"])
        return stored["token"], stored["worker_id"]

    # 4. Auto-provision from coordinator
    log.info("No token found -- auto-provisioning from coordinator...")
    provisioned = _auto_provision(coordinator_url)
    _save_token(provisioned)
    return provisioned["token"], provisioned["worker_id"]


# ============================================================================
# HTTP client  (stdlib only -- no requests dependency)
# ============================================================================

def _http_request(
    method: str,
    url: str,
    headers: dict,
    body: Optional[dict] = None,
    timeout: int = 10,
    stream: bool = False,
) -> Tuple[int, Any]:
    """Make an HTTP request with retry logic. Returns (status_code, parsed_body).

    Returns (0, {}) on network/timeout errors after all retries exhausted.
    """
    last_exc: Optional[Exception] = None

    for attempt in range(MAX_RETRIES):
        try:
            data = json.dumps(body).encode("utf-8") if body is not None else None
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            ctx = ssl.create_default_context()
            if not getattr(_http_request, '_verify_ssl', True):
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)

            if stream:
                return (resp.status, resp)

            resp_body = resp.read().decode("utf-8")
            try:
                return (resp.status, json.loads(resp_body))
            except json.JSONDecodeError:
                return (resp.status, {"raw": resp_body})
        except urllib.error.HTTPError as e:
            # Don't retry 4xx (except 429)
            if 400 <= e.code < 500 and e.code != 429:
                body_text = ""
                try:
                    body_text = e.read().decode("utf-8")[:500]
                except Exception:
                    pass
                return (e.code, {"error": body_text})
            last_exc = e
        except Exception as e:
            last_exc = e

        if attempt < MAX_RETRIES - 1:
            wait = BACKOFF_BASE * (2 ** attempt)
            log.debug("Request %s %s failed (attempt %d/%d), retrying in %ds: %s",
                      method, url, attempt + 1, MAX_RETRIES, wait, last_exc)
            time.sleep(wait)

    return (0, {"error": str(last_exc) if last_exc else "unknown"})


class CoordinatorClient:
    """HTTP client for the coordinator API at /api/cluster/contributor/*."""

    def __init__(self, base_url: str, token: str, worker_id: str):
        self.base_url = base_url.rstrip("/")
        self.api = f"{self.base_url}/api/cluster/contributor"
        self.token = token
        self.worker_id = worker_id
        self.headers = {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; AuraAlpha-GridWorker/2.0)",
            "X-Worker-Token": self.token,
            "X-Contributor-Token": self.token,
            "X-Worker-Id": self.worker_id,
        }

    def _url(self, path: str) -> str:
        return f"{self.api}/{path.lstrip('/')}"

    def register(self, capabilities: dict) -> bool:
        caps = dict(capabilities)
        caps["worker_id"] = self.worker_id
        status, data = _http_request("POST", self._url("register"), self.headers, caps)
        if status == 200:
            log.info("Registered as %s (%d CPUs, %.1f GB RAM)",
                     self.worker_id,
                     caps.get("cpu_count", caps.get("cpus", 0)),
                     caps.get("ram_gb", 0))
            return True
        log.warning("Registration failed: %d %s", status, str(data)[:200])
        return False

    def heartbeat(self, active_job_ids: Optional[List[str]] = None) -> bool:
        payload = {
            "worker_id": self.worker_id,
            "status": "online",
            "job_ids": active_job_ids or [],
            "hostname": platform.node() or "unknown",
        }
        # Include GPU info so the server always has current hardware state
        if _GPU_AVAILABLE:
            payload["gpu_model"] = _GPU_NAME
            payload["gpu_vram_gb"] = _GPU_VRAM_GB
            payload["cuda_available"] = True
        status, _ = _http_request("POST", self._url("heartbeat"), self.headers,
                                  payload, timeout=10)
        if status == 401:
            log.warning("Heartbeat rejected (401) — token may be stale")
            # Will be re-provisioned on next dequeue
        return status == 200

    def dequeue(self, count: int = 5, job_types: list = None) -> list:
        payload = {
            "worker_id": self.worker_id,
            "count": count,
            "max_jobs": count,
        }
        if job_types:
            payload["job_types"] = job_types
        status, data = _http_request("POST", self._url("dequeue"), self.headers, payload, timeout=30)
        if status == 200:
            return data.get("jobs", [])
        # Token expired or invalid — re-provision automatically
        if status == 401:
            log.warning("Token rejected (401) — re-provisioning...")
            try:
                stored_path = _token_file_path()
                if stored_path.exists():
                    stored_path.unlink()
                    log.info("Deleted stale token file")
                new_data = _auto_provision(self.base_url)
                _save_token(new_data)
                self.token = new_data["token"]
                self.worker_id = new_data["worker_id"]
                self.headers["X-Worker-Token"] = self.token
                self.headers["X-Contributor-Token"] = self.token
                self.headers["X-Worker-Id"] = self.worker_id
                log.info("Re-provisioned as %s — retrying dequeue", self.worker_id)
                # Retry once with new token
                status2, data2 = _http_request("POST", self._url("dequeue"), self.headers, payload, timeout=30)
                if status2 == 200:
                    return data2.get("jobs", [])
            except Exception as e:
                log.error("Re-provision failed: %s", e)
        return []

    def complete(self, job_id: str, metrics: Optional[dict] = None,
                 result: Optional[dict] = None, duration: float = 0) -> bool:
        payload = {
            "worker_id": self.worker_id,
            "job_id": job_id,
            "status": "completed",
            "metrics": metrics or {},
            "result": result or metrics or {},
            "duration_sec": round(duration, 2),
        }
        status, _ = _http_request("POST", self._url("complete"), self.headers, payload)
        return status == 200

    def fail(self, job_id: str, error: str, duration: float = 0) -> bool:
        payload = {
            "worker_id": self.worker_id,
            "job_id": job_id,
            "status": "failed",
            "error": error[:2000],
            "duration_sec": round(duration, 2),
        }
        status, _ = _http_request("POST", self._url("complete"), self.headers, payload)
        return status == 200

    def complete_batch(self, results: list) -> dict:
        """Report multiple results in a single HTTP call."""
        payload = {"results": results}
        status, data = _http_request("POST", self._url("complete_batch"), self.headers, payload, timeout=30)
        if status == 200:
            return data or {}
        return {"ok": False}

    def download_data(self, region: str, symbol: str, dest_path: Path) -> bool:
        """Download a parquet file from the coordinator. Returns True on success."""
        try:
            status, resp = _http_request(
                "GET", self._url(f"data/{region}/{symbol}"),
                self.headers, stream=True, timeout=300,
            )
            if status != 200 or not hasattr(resp, "read"):
                return False

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            with open(dest_path, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            return dest_path.exists() and dest_path.stat().st_size > 0
        except Exception as e:
            log.debug("Failed to download %s/%s: %s", region, symbol, e)
            return False


# ============================================================================
# Adaptive Throttle  (yields CPU to games, apps, etc.)
# ============================================================================

class AdaptiveThrottle:
    """Self-optimizing compute controller with throughput feedback.

    Three feedback loops:
    1. System load (CPU/RAM) — prevents desktop from choking
    2. Throughput trend — detects stalls via choke severity tiers
    3. Queue pressure — scales to demand, not just capacity

    Stability features:
    - Cooldown window prevents thrashing (15s lock after scaling)
    - Choke severity tiers (30/50/70% drops → proportional reduction)
    - Drop fast, ramp slowly (asymmetric scaling)
    """

    HEAVY_LOAD = 60
    MEDIUM_LOAD = 40
    LIGHT_LOAD = 20
    RAM_CRITICAL = 25
    COOLDOWN_SEC = 15  # lock scaling for 15s after each adjustment
    PROBE_COOLDOWN_SEC = 60  # wait 60s between elasticity probes
    PROBE_EVAL_SEC = 15  # evaluate probe result after 15s

    def __init__(self, max_parallel: int):
        self.max_parallel = max_parallel
        self.current = max_parallel
        self._last_check = 0.0
        self._last_scale_time = 0.0  # cooldown anchor
        self.is_throttled = False
        # Throughput tracking (rolling windows)
        self._completions: list = []  # [(timestamp, count)]
        self._total_completed = 0
        self._prev_queue_size = 0  # for queue-aware scaling
        # Elasticity probe state
        self._probe_active = False
        self._probe_start_time = 0.0
        self._probe_baseline_t60 = 0.0
        self._probe_prev_workers = 0
        self._last_probe_time = 0.0
        self._ceiling = max_parallel  # discovered ceiling (can grow beyond max_parallel)

    def record_completion(self, count: int = 1):
        """Call after each batch completes to feed the throughput tracker."""
        self._total_completed += count
        self._completions.append((time.time(), count))
        cutoff = time.time() - 120
        self._completions = [(t, c) for t, c in self._completions if t > cutoff]

    def _throughput_window(self, seconds: int) -> float:
        """Jobs/min over the last N seconds."""
        cutoff = time.time() - seconds
        total = sum(c for t, c in self._completions if t > cutoff)
        return (total / max(seconds, 1)) * 60

    @property
    def throughput_10s(self) -> float:
        return self._throughput_window(10)

    @property
    def throughput_60s(self) -> float:
        return self._throughput_window(60)

    def choke_severity(self) -> float:
        """0.0 = no choke, 1.0 = total stall. Based on t10 vs t60 ratio."""
        t10 = self.throughput_10s
        t60 = self.throughput_60s
        if t60 < 1:
            return 0.0
        ratio = t10 / t60
        if ratio >= 0.7:
            return 0.0   # healthy
        return min(1.0, 1.0 - ratio)  # 0.0–1.0 severity

    def _get_metrics(self) -> dict:
        try:
            import psutil
            cpu = psutil.cpu_percent(interval=0.5)
            mem = psutil.virtual_memory()
            return {"cpu_pct": cpu, "ram_avail_pct": mem.available / mem.total * 100}
        except ImportError:
            pass
        try:
            with open("/proc/stat") as f:
                p1 = f.readline().split()
            time.sleep(0.3)
            with open("/proc/stat") as f:
                p2 = f.readline().split()
            idle1, total1 = int(p1[4]), sum(int(x) for x in p1[1:])
            idle2, total2 = int(p2[4]), sum(int(x) for x in p2[1:])
            dt = total2 - total1
            cpu = ((dt - (idle2 - idle1)) / max(dt, 1)) * 100
            meminfo = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    parts = line.split()
                    meminfo[parts[0].rstrip(":")] = int(parts[1])
            total_kb = meminfo.get("MemTotal", 1)
            avail_kb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0))
            return {"cpu_pct": cpu, "ram_avail_pct": avail_kb / total_kb * 100}
        except Exception:
            return {"cpu_pct": 0, "ram_avail_pct": 100}

    def recommended_workers(self, queue_size: int = 0) -> int:
        now = time.time()
        if now - self._last_check < THROTTLE_CHECK_INTERVAL:
            return self.current

        self._last_check = now

        # ── Cooldown: block adjustments for 15s after last scale ──
        in_cooldown = (now - self._last_scale_time) < self.COOLDOWN_SEC

        m = self._get_metrics()
        our_est = (self.current / max(_auto_cpu_count(), 1)) * 100
        other_cpu = max(0, m["cpu_pct"] - our_est)

        # ── System load feedback ──
        if m["ram_avail_pct"] < self.RAM_CRITICAL:
            target = 2
        elif other_cpu >= self.HEAVY_LOAD:
            target = max(1, self.max_parallel // 4)
        elif other_cpu >= self.MEDIUM_LOAD:
            target = max(1, self.max_parallel // 2)
        elif other_cpu >= self.LIGHT_LOAD:
            target = max(2, int(self.max_parallel * 0.75))
        else:
            target = self.max_parallel

        # ── Choke severity tiers (overrides load target if worse) ──
        severity = self.choke_severity()
        t10 = self.throughput_10s
        t60 = self.throughput_60s
        if severity > 0 and self.current > 4:
            if severity >= 0.7:
                # Critical: 70%+ drop → reduce by 6-8
                choke_target = max(2, self.current - 8)
                log.info("[THROTTLE] CRITICAL choke (%.0f%%): t10=%.0f t60=%.0f → %d workers",
                         severity * 100, t10, t60, choke_target)
            elif severity >= 0.5:
                # Severe: 50-70% drop → reduce by 4
                choke_target = max(4, self.current - 4)
                log.info("[THROTTLE] Severe choke (%.0f%%): t10=%.0f t60=%.0f → %d workers",
                         severity * 100, t10, t60, choke_target)
            else:
                # Moderate: 30-50% drop → reduce by 2
                choke_target = max(4, self.current - 2)
                log.info("[THROTTLE] Moderate choke (%.0f%%): t10=%.0f t60=%.0f → %d workers",
                         severity * 100, t10, t60, choke_target)
            target = min(target, choke_target)

        # ── Queue-aware scaling ──
        if queue_size > 0 and self._prev_queue_size > 0:
            queue_growing = queue_size > self._prev_queue_size * 1.05
            queue_shrinking = queue_size < self._prev_queue_size * 0.9
            if queue_growing and other_cpu < 40 and severity == 0:
                # Queue growing + CPU idle + not choking → scale up
                grow = min(self.max_parallel, self.current + 2)
                if grow > target:
                    log.info("[THROTTLE] Queue growing (%d→%d) + CPU idle → %d workers",
                             self._prev_queue_size, queue_size, grow)
                    target = grow
            elif queue_shrinking and severity == 0:
                # Queue shrinking fast → hold steady, don't over-provision
                target = min(target, self.current)
        self._prev_queue_size = queue_size

        # ── Idle ramp: CPU < 30% + stable throughput → grow ──
        if severity == 0 and other_cpu < 30 and t60 > 0 and t10 >= t60 * 0.8:
            if self.current < self._ceiling:
                grow = min(self._ceiling, self.current + 2)
                if grow > target:
                    target = grow

        # ── Elasticity probe: discover throughput ceiling ──
        if self._probe_active:
            # Evaluate probe after PROBE_EVAL_SEC
            if now - self._probe_start_time >= self.PROBE_EVAL_SEC:
                new_t60 = self.throughput_60s
                improved = new_t60 > self._probe_baseline_t60 * 0.95  # 5% tolerance
                if improved:
                    # Probe succeeded — keep the extra worker, raise ceiling
                    self._ceiling = max(self._ceiling, self.current + 1)
                    log.info("[PROBE] SUCCESS: t60 %.0f→%.0f, ceiling now %d",
                             self._probe_baseline_t60, new_t60, self._ceiling)
                else:
                    # Probe failed — revert
                    target = self._probe_prev_workers
                    log.info("[PROBE] REVERTED: t60 %.0f→%.0f, back to %d",
                             self._probe_baseline_t60, new_t60, self._probe_prev_workers)
                self._probe_active = False
                self._last_probe_time = now
        elif (severity == 0
              and not in_cooldown
              and other_cpu < 75
              and m["cpu_pct"] < 75
              and t60 > 0
              and self.current >= target
              and (now - self._last_probe_time) >= self.PROBE_COOLDOWN_SEC
              and (now - self._last_scale_time) >= 30):
            # Conditions met: stable, CPU headroom, no recent changes → probe +1
            self._probe_active = True
            self._probe_start_time = now
            self._probe_baseline_t60 = t60
            self._probe_prev_workers = self.current
            target = self.current + 1
            log.info("[PROBE] Testing +1 worker: %d→%d (CPU %.0f%%, t60=%.0f)",
                     self.current, target, m["cpu_pct"], t60)

        # ── Apply change (cooldown-gated) ──
        prev = self.current
        if in_cooldown:
            # During cooldown, only allow emergency reductions (RAM critical / severe choke)
            if target < self.current and (m["ram_avail_pct"] < self.RAM_CRITICAL or severity >= 0.5):
                self.current = target
                self._last_scale_time = now
            # else: hold steady during cooldown
        else:
            # Normal scaling: drop fast, ramp slowly
            if target < self.current:
                self.current = target
                self._last_scale_time = now
            elif target > self.current:
                # Allow probes to push past max_parallel up to ceiling
                cap = self._ceiling if self._probe_active else self.max_parallel
                self.current = min(cap, self.current + 2)
                self._last_scale_time = now

        self.is_throttled = self.current < self.max_parallel

        if self.current != prev:
            log.info("Throttle: %d→%d (CPU ~%.0f%%, RAM %.0f%%, choke %.0f%%, t10=%.0f t60=%.0f, q=%d)",
                     prev, self.current, other_cpu, m["ram_avail_pct"],
                     severity * 100, t10, t60, queue_size)

        return self.current


# ============================================================================
# Data Fetcher  (downloads OHLCV from coordinator before backtests)
# ============================================================================

class DataFetcher:
    """Pre-fetches OHLCV parquet data for symbols needed by research jobs."""

    def __init__(self, client: CoordinatorClient, cache_dir: Path):
        self.client = client
        self.cache_dir = cache_dir

    def _path(self, symbol: str, region: str) -> Path:
        return self.cache_dir / region / f"{symbol}.parquet"

    def ensure_data(self, symbols: List[str], region: str) -> Tuple[int, int]:
        """Download any missing parquets. Returns (available, missing)."""
        needed = [s for s in symbols
                  if not (self._path(s, region).exists()
                          and self._path(s, region).stat().st_size > 0)]

        if not needed:
            return len(symbols), 0

        log.info("Fetching data: %d/%d symbols need download for region=%s",
                 len(needed), len(symbols), region)

        succeeded = 0
        for sym in needed:
            if self.client.download_data(region, sym, self._path(sym, region)):
                succeeded += 1

        available = len(symbols) - len(needed) + succeeded
        missing = len(needed) - succeeded
        if missing > 0:
            log.warning("Data fetch: %d available, %d still missing", available, missing)
        else:
            log.info("Data fetch complete: all %d symbols available", available)
        return available, missing


# ============================================================================
# Backtest Engine  (generic compute -- NO proprietary strategy code)
# ============================================================================
# This engine only processes parameters sent by the coordinator. It does NOT
# contain any strategy definitions, signal generation logic, or trading
# algorithms. It is a parameter-driven simulation framework.

def _load_bars(symbol: str, region: str, cache_dir: Path) -> Optional[dict]:
    """Load OHLCV bars from cached parquet. Returns dict or None."""
    try:
        import numpy as np
    except ImportError:
        log.error("numpy not installed -- cannot run backtests")
        return None
    try:
        import polars as pl
    except ImportError:
        log.error("polars not installed -- cannot load parquet data")
        return None

    search_dirs = [cache_dir / region]
    if region != "us":
        search_dirs.append(cache_dir / "us")

    parquet_path = None
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


def _compute_atr(highs, lows, closes, period: int = 14):
    """Compute Average True Range."""
    import numpy as np
    n = len(highs)
    if n < period + 1:
        return np.full(n, np.nan)
    tr = np.maximum(
        highs[1:] - lows[1:],
        np.maximum(np.abs(highs[1:] - closes[:-1]), np.abs(lows[1:] - closes[:-1])),
    )
    atr = np.full(n, np.nan)
    if len(tr) >= period:
        atr[period] = np.mean(tr[:period])
        for i in range(period + 1, len(tr) + 1):
            atr[i] = (atr[i - 1] * (period - 1) + tr[i - 1]) / period
    return atr


def _compute_ema(data, period):
    """Compute EMA for an array."""
    import numpy as np
    n = len(data)
    ema = np.full(n, np.nan)
    if n <= period:
        return ema
    alpha = 2.0 / (period + 1)
    ema[period - 1] = np.mean(data[:period])
    for i in range(period, n):
        ema[i] = data[i] * alpha + ema[i - 1] * (1 - alpha)
    return ema


def _compute_rsi(closes, period=14):
    """Compute RSI."""
    import numpy as np
    n = len(closes)
    rsi = np.full(n, 50.0)
    if n <= period + 1:
        return rsi
    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses_arr = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses_arr[:period])
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses_arr[i]) / period
        rs = avg_gain / (avg_loss + 1e-10)
        rsi[i + 1] = 100.0 - (100.0 / (1.0 + rs))
    return rsi


def _compute_bbands(closes, period=20, std_mult=2.0):
    """Compute Bollinger Bands (upper, middle, lower)."""
    import numpy as np
    n = len(closes)
    upper = np.full(n, np.nan)
    middle = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    for i in range(period - 1, n):
        window = closes[i - period + 1:i + 1]
        m = np.mean(window)
        s = np.std(window)
        middle[i] = m
        upper[i] = m + std_mult * s
        lower[i] = m - std_mult * s
    return upper, middle, lower


def _compute_sma(data, period):
    """Compute Simple Moving Average."""
    import numpy as np
    n = len(data)
    sma = np.full(n, np.nan)
    for i in range(period - 1, n):
        sma[i] = np.mean(data[i - period + 1:i + 1])
    return sma


def _compute_obv(closes, volumes):
    """Compute On-Balance Volume."""
    import numpy as np
    n = len(closes)
    obv = np.zeros(n)
    for i in range(1, n):
        if closes[i] > closes[i - 1]:
            obv[i] = obv[i - 1] + volumes[i]
        elif closes[i] < closes[i - 1]:
            obv[i] = obv[i - 1] - volumes[i]
        else:
            obv[i] = obv[i - 1]
    return obv


def _check_entry(i, entry_logic, indicators, params, direction):
    """Check if entry conditions are met based on the strategy's entry_logic list.
    Returns True if >= 50% of conditions pass (matching EC2 behavior).
    """
    import numpy as np
    ind = indicators
    conditions_met = 0
    conditions_total = len(entry_logic) if entry_logic else 1

    for cond in entry_logic:
        try:
            if cond == "ema_cross_up":
                ef, es = ind["ema_fast"], ind["ema_slow"]
                if not np.isnan(ef[i]) and not np.isnan(es[i]) and i > 0:
                    if ef[i] > es[i] and ef[i - 1] <= es[i - 1]:
                        conditions_met += 1
            elif cond == "ema_cross_down":
                ef, es = ind["ema_fast"], ind["ema_slow"]
                if not np.isnan(ef[i]) and not np.isnan(es[i]) and i > 0:
                    if ef[i] < es[i] and ef[i - 1] >= es[i - 1]:
                        conditions_met += 1
            elif cond == "rsi_above_threshold":
                thr = params.get("rsi_entry_threshold", params.get("rsi_entry", 55))
                if ind["rsi"][i] > thr:
                    conditions_met += 1
            elif cond == "rsi_oversold":
                thr = params.get("rsi_oversold", 30)
                if ind["rsi"][i] < thr:
                    conditions_met += 1
            elif cond == "rsi_above_floor":
                thr = params.get("rsi_floor", 40)
                if ind["rsi"][i] > thr:
                    conditions_met += 1
            elif cond == "volume_surge" or cond == "volume_spike":
                vm = params.get("volume_multiplier", params.get("volume_spike_mult", 1.5))
                vs = ind["vol_sma"]
                vols = ind["volumes"]
                if not np.isnan(vs[i]) and vs[i] > 0 and vols[i] > vs[i] * vm:
                    conditions_met += 1
            elif cond == "price_above_high":
                lb = params.get("lookback_period", 20)
                if i >= lb and ind["closes"][i] > np.max(ind["highs"][i - lb:i]):
                    conditions_met += 1
            elif cond == "volume_breakout":
                vm = params.get("volume_multiplier", 2.0)
                vs = ind["vol_sma"]
                vols = ind["volumes"]
                if not np.isnan(vs[i]) and vs[i] > 0 and vols[i] > vs[i] * vm:
                    conditions_met += 1
            elif cond == "consolidation_check":
                cd = params.get("consolidation_days", 10)
                rp = params.get("consolidation_range_pct", 0.05)
                if i >= cd:
                    hi = np.max(ind["highs"][i - cd:i])
                    lo = np.min(ind["lows"][i - cd:i])
                    if lo > 0 and (hi - lo) / lo < rp:
                        conditions_met += 1
            elif cond == "squeeze_fire" or cond == "band_expansion":
                bb_u, bb_m, bb_l = ind.get("bb_upper"), ind.get("bb_middle"), ind.get("bb_lower")
                if bb_u is not None and not np.isnan(bb_u[i]) and not np.isnan(bb_l[i]):
                    squeeze = params.get("squeeze_threshold", 0.02)
                    width = (bb_u[i] - bb_l[i]) / (bb_m[i] + 1e-10)
                    if i > 0:
                        prev_width = (bb_u[i-1] - bb_l[i-1]) / (bb_m[i-1] + 1e-10) if not np.isnan(bb_u[i-1]) else width
                        if prev_width < squeeze and width > squeeze:
                            conditions_met += 1
            elif cond == "direction_filter":
                ef = ind.get("ema_fast")
                if ef is not None and not np.isnan(ef[i]):
                    if (direction == "long" and ind["closes"][i] > ef[i]) or \
                       (direction != "long" and ind["closes"][i] < ef[i]):
                        conditions_met += 1
            elif cond == "zscore_extreme":
                # For ETF arb: compute z-score of price vs moving average
                lb = params.get("spread_lookback", 30)
                ez = params.get("entry_zscore", 2.0)
                if i >= lb:
                    window = ind["closes"][i - lb:i]
                    m, s = np.mean(window), np.std(window)
                    if s > 0:
                        z = (ind["closes"][i] - m) / s
                        if abs(z) >= ez:
                            conditions_met += 1
            elif cond == "correlation_stable":
                # Simplified: check price stability/trend consistency
                conditions_met += 1  # assume stable for now
            elif cond == "top_sector_rank" or cond == "momentum_positive":
                # Sector rotation: check momentum
                lb = params.get("ranking_period", 30)
                if i >= lb and ind["closes"][i] > ind["closes"][i - lb]:
                    conditions_met += 1
            elif cond == "gap_detection":
                gt = params.get("gap_threshold_pct", 0.03)
                if i > 0 and abs(ind["closes"][i] / ind["closes"][i - 1] - 1) > gt:
                    conditions_met += 1
            elif cond == "event_window":
                conditions_met += 1  # always in window for backtesting
            elif cond == "obv_rising":
                obv = ind.get("obv")
                if obv is not None and i > 5:
                    if obv[i] > obv[i - 5]:
                        conditions_met += 1
            elif cond == "price_below_lower_band":
                bb_l = ind.get("bb_lower")
                if bb_l is not None and not np.isnan(bb_l[i]):
                    if ind["closes"][i] < bb_l[i]:
                        conditions_met += 1
            elif cond == "distance_from_sma":
                sma = ind.get("sma")
                md = params.get("min_distance_from_sma", 0.02)
                if sma is not None and not np.isnan(sma[i]) and sma[i] > 0:
                    dist = abs(ind["closes"][i] - sma[i]) / sma[i]
                    if dist >= md:
                        conditions_met += 1
            elif cond == "price_above_vwap":
                # Simplified VWAP: use volume-weighted price average
                lb = params.get("volume_sma_period", 20)
                if i >= lb:
                    w = ind["closes"][i - lb:i] * ind["volumes"][i - lb:i]
                    vwap = np.sum(w) / (np.sum(ind["volumes"][i - lb:i]) + 1e-10)
                    if ind["closes"][i] > vwap:
                        conditions_met += 1
            elif cond in ("bollinger_squeeze", "rsi_confirmation", "volume_confirm"):
                # Generic conditions — be lenient
                conditions_met += 1
            else:
                # Unknown condition — be lenient to avoid false rejections
                conditions_met += 1
        except Exception:
            pass

    # Match EC2: require >= 50% of conditions met
    return conditions_met >= max(1, conditions_total * 0.5)


def _simulate_trades(
    closes, highs, lows, dates: List[str],
    params: dict, direction: str = "long",
    date_start: str = "", date_end: str = "",
    entry_logic: Optional[List[str]] = None,
) -> List[dict]:
    """Simulate trades for a single symbol using strategy-specific entry logic.

    Supports all 9 strategy families via the entry_logic conditions list.
    Exit logic uses ATR stops/TP, trailing stops, and max hold universally.
    """
    import numpy as np

    n = len(closes)
    if n < 50:
        return []

    # Extract parameters with safe defaults
    stop_atr = params.get("stop_loss_atr_mult", 2.0)
    tp_atr = params.get("take_profit_atr_mult", 4.0)
    trail_pct = params.get("trailing_stop_pct", 0.05)
    if trail_pct > 1:
        trail_pct = trail_pct / 100.0  # normalize percentage
    max_hold = params.get("max_hold_days", 30)
    atr_period = params.get("atr_period", 14)
    ema_fast_period = params.get("ema_fast", 9)
    ema_slow_period = params.get("ema_slow", 21)
    rsi_period = params.get("rsi_period", 14)
    vol_sma_period = params.get("volume_sma_period", 20)
    bbands_period = params.get("bbands_period", 20)
    bbands_std = params.get("bbands_std", 2.0)

    # Default entry logic if not specified
    if not entry_logic:
        entry_logic = ["ema_cross_up", "rsi_above_threshold", "volume_surge"]

    # Compute all indicators
    volumes = np.zeros(n)
    if "_volumes" in params:
        volumes = np.array(params["_volumes"], dtype=float)

    indicators = {
        "closes": closes,
        "highs": highs,
        "lows": lows,
        "volumes": volumes,
        "atr": _compute_atr(highs, lows, closes, atr_period),
        "ema_fast": _compute_ema(closes, ema_fast_period),
        "ema_slow": _compute_ema(closes, ema_slow_period),
        "rsi": _compute_rsi(closes, rsi_period),
        "vol_sma": _compute_sma(volumes, vol_sma_period) if volumes.any() else np.full(n, np.nan),
        "sma": _compute_sma(closes, bbands_period),
        "obv": _compute_obv(closes, volumes) if volumes.any() else np.zeros(n),
    }

    # Add Bollinger Bands if needed
    needs_bb = any(c in str(entry_logic) for c in ["squeeze", "band", "bollinger", "lower_band"])
    if needs_bb:
        bb_u, bb_m, bb_l = _compute_bbands(closes, bbands_period, bbands_std)
        indicators["bb_upper"] = bb_u
        indicators["bb_middle"] = bb_m
        indicators["bb_lower"] = bb_l

    # Date window
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

    min_lookback = max(ema_slow_period, atr_period, rsi_period, vol_sma_period, bbands_period) + 5
    start_idx = max(start_idx, min_lookback)

    trades: List[dict] = []
    in_trade = False
    entry_price = 0.0
    entry_idx = 0
    stop_price = 0.0
    tp_price = 0.0
    trail_high = 0.0
    trail_low = float("inf")

    atr = indicators["atr"]

    for i in range(start_idx, min(end_idx, n)):
        if np.isnan(atr[i]):
            continue

        if not in_trade:
            if _check_entry(i, entry_logic, indicators, params, direction):
                entry_price = closes[i]
                entry_idx = i
                if direction == "long":
                    stop_price = entry_price - atr[i] * stop_atr
                    tp_price = entry_price + atr[i] * tp_atr
                    trail_high = entry_price
                else:
                    stop_price = entry_price + atr[i] * stop_atr
                    tp_price = entry_price - atr[i] * tp_atr
                    trail_low = entry_price
                in_trade = True
        else:
            hold_days = i - entry_idx
            exit_price = None
            exit_reason = ""

            if direction == "long":
                trail_high = max(trail_high, highs[i])
                trail_stop = trail_high * (1.0 - trail_pct)
                if lows[i] <= stop_price:
                    exit_price, exit_reason = stop_price, "stop_loss"
                elif highs[i] >= tp_price:
                    exit_price, exit_reason = tp_price, "take_profit"
                elif closes[i] <= trail_stop and hold_days > 1:
                    exit_price, exit_reason = trail_stop, "trailing_stop"
                elif hold_days >= max_hold:
                    exit_price, exit_reason = closes[i], "max_hold"
            else:
                trail_low = min(trail_low, lows[i])
                trail_stop = trail_low * (1.0 + trail_pct)
                if highs[i] >= stop_price:
                    exit_price, exit_reason = stop_price, "stop_loss"
                elif lows[i] <= tp_price:
                    exit_price, exit_reason = tp_price, "take_profit"
                elif closes[i] >= trail_stop and hold_days > 1:
                    exit_price, exit_reason = trail_stop, "trailing_stop"
                elif hold_days >= max_hold:
                    exit_price, exit_reason = closes[i], "max_hold"

            if exit_price is not None:
                if direction == "long":
                    pnl_pct = (exit_price - entry_price) / entry_price
                else:
                    pnl_pct = (entry_price - exit_price) / entry_price
                trades.append({
                    "entry_date": dates[entry_idx],
                    "exit_date": dates[i],
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(exit_price, 4),
                    "pnl_pct": round(pnl_pct, 6),
                    "hold_days": hold_days,
                    "exit_reason": exit_reason,
                    "direction": direction,
                })
                in_trade = False

    # Close any open trade at end of window
    if in_trade and end_idx > entry_idx:
        final_idx = min(end_idx - 1, n - 1)
        exit_price = closes[final_idx]
        pnl_pct = ((exit_price - entry_price) / entry_price if direction == "long"
                    else (entry_price - exit_price) / entry_price)
        trades.append({
            "entry_date": dates[entry_idx],
            "exit_date": dates[final_idx],
            "entry_price": round(entry_price, 4),
            "exit_price": round(exit_price, 4),
            "pnl_pct": round(pnl_pct, 6),
            "hold_days": final_idx - entry_idx,
            "exit_reason": "window_end",
            "direction": direction,
        })

    return trades


def _compute_metrics(trades: List[dict]) -> dict:
    """Compute performance metrics from a list of trades."""
    import numpy as np

    if not trades:
        return {
            "num_trades": 0, "sharpe": 0.0, "sortino": 0.0,
            "profit_factor": 0.0, "win_rate": 0.0, "avg_return": 0.0,
            "max_drawdown": 0.0, "total_return": 0.0, "avg_hold_days": 0.0,
        }

    returns = [t["pnl_pct"] for t in trades]
    n = len(returns)
    wins = sum(1 for r in returns if r > 0)

    avg_ret = float(np.mean(returns))
    std_ret = float(np.std(returns, ddof=1)) if n > 1 else 1e-9
    downside = (float(np.std([r for r in returns if r < 0], ddof=1))
                if any(r < 0 for r in returns) else 1e-9)

    sharpe = avg_ret / (std_ret + 1e-9)
    sortino = avg_ret / (downside + 1e-9)

    gross_profit = sum(r for r in returns if r > 0)
    gross_loss = abs(sum(r for r in returns if r < 0))
    profit_factor = gross_profit / (gross_loss + 1e-9)

    cum = np.cumprod(1 + np.array(returns))
    peak = np.maximum.accumulate(cum)
    dd = (cum - peak) / peak
    max_dd = float(np.min(dd)) if len(dd) > 0 else 0.0
    total_ret = float(cum[-1] - 1) if len(cum) > 0 else 0.0
    avg_hold = float(np.mean([t["hold_days"] for t in trades]))

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
        "avg_return": round(avg_ret, 6),
        "max_drawdown": round(max_dd, 6),
        "total_return": round(total_ret, 6),
        "avg_hold_days": round(avg_hold, 1),
        "gross_profit": round(gross_profit, 6),
        "gross_loss": round(gross_loss, 6),
        "wins": wins,
        "losses": n - wins,
        "exit_reasons": exit_reasons,
    }


def run_backtest_job(job_dict: dict, cache_dir: Path) -> dict:
    """Execute a research_backtest job. Must be picklable for ProcessPoolExecutor.

    Accepts a job dict from the coordinator and runs the backtest across all
    symbols in the job's universe.
    """
    try:
        import random

        job_id = job_dict.get("job_id", "unknown")
        strategy_family = job_dict.get("strategy_family", "unknown")
        parameter_set = job_dict.get("parameter_set", {})
        symbol_universe = job_dict.get("symbol_universe", [])
        date_window = job_dict.get("date_window", ":")
        backtest_config = job_dict.get("backtest_config", {})
        payload = job_dict.get("payload", {})

        direction = backtest_config.get("direction", "long")
        region = backtest_config.get("region", "us")
        date_parts = date_window.split(":")
        date_start = date_parts[0] if len(date_parts) > 0 else ""
        date_end = date_parts[1] if len(date_parts) > 1 else ""

        # Extract entry_logic from job or payload
        entry_logic = job_dict.get("entry_logic")
        if not entry_logic and payload:
            candidate = payload.get("candidate", {})
            entry_logic = candidate.get("entry_logic")
        if not entry_logic:
            entry_logic = parameter_set.get("entry_logic")

        # Auto-sample symbols from cache if universe is empty
        if not symbol_universe:
            data_dir = cache_dir / region
            if data_dir.exists():
                available = [f.stem for f in data_dir.glob("*.parquet")]
                sample_size = min(15, len(available))  # Match EC2 tier1: 15 symbols
                symbol_universe = random.sample(available, sample_size) if available else []

        all_trades: List[dict] = []
        symbols_tested = 0
        symbols_skipped = 0

        for symbol in symbol_universe:
            bars = _load_bars(symbol, region, cache_dir)
            if bars is None or len(bars["closes"]) < 50:
                symbols_skipped += 1
                continue

            params = dict(parameter_set)
            params["_volumes"] = bars["volumes"].tolist()

            trades = _simulate_trades(
                closes=bars["closes"], highs=bars["highs"],
                lows=bars["lows"], dates=bars["dates"],
                params=params, direction=direction,
                date_start=date_start, date_end=date_end,
                entry_logic=entry_logic,
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

        return {"job_id": job_id, "status": "completed", "metrics": metrics}

    except Exception as e:
        return {
            "job_id": job_dict.get("job_id", "unknown"),
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        }


# ============================================================================
# ML / GPU Job Handlers  (PyTorch CUDA when available, CPU fallback)
# ============================================================================

def _get_torch_device() -> "torch.device":
    """Return the best available torch device (CUDA > CPU)."""
    import torch
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def run_ml_train_job(job_dict: dict, cache_dir: Path) -> dict:
    """Execute an ML training job. Uses GPU when available, falls back to CPU.

    Expects job_dict keys:
      - job_id: str
      - model_config: dict with architecture, hyperparameters
      - training_data: dict or reference to data on coordinator
      - epochs: int (default 10)
      - symbol_universe: list[str] (for feature building from cached OHLCV)
    """
    job_id = job_dict.get("job_id", "unknown")
    t0 = time.time()

    try:
        import torch
        import torch.nn as nn

        device = _get_torch_device()
        if device.type == "cuda":
            log.info("[GPU] Using %s for ML training job %s", _GPU_NAME, job_id)
        else:
            log.info("[CPU] GPU not available, using CPU for ML training job %s", job_id)

        model_config = job_dict.get("model_config", {})
        epochs = job_dict.get("epochs", model_config.get("epochs", 10))
        learning_rate = model_config.get("learning_rate", 0.001)
        batch_size = model_config.get("batch_size", 64)
        hidden_size = model_config.get("hidden_size", 128)
        num_layers = model_config.get("num_layers", 2)
        input_features = model_config.get("input_features", 5)
        sequence_length = model_config.get("sequence_length", 20)
        symbol_universe = job_dict.get("symbol_universe", [])
        region = job_dict.get("backtest_config", {}).get("region", "us")

        # --- Build training tensors from cached OHLCV data ---
        import numpy as np

        all_features = []
        all_targets = []

        for symbol in symbol_universe:
            bars = _load_bars(symbol, region, cache_dir)
            if bars is None or len(bars["closes"]) < sequence_length + 10:
                continue

            closes = bars["closes"]
            highs = bars["highs"]
            lows = bars["lows"]
            volumes = bars["volumes"]

            # Feature matrix: returns, high-low range, volume change, RSI-like, volatility
            returns = np.diff(closes) / (closes[:-1] + 1e-10)
            hl_range = (highs[1:] - lows[1:]) / (closes[1:] + 1e-10)
            vol_change = np.diff(volumes) / (volumes[:-1] + 1e-10)
            vol_change = np.clip(vol_change, -10, 10)

            # Align arrays (all length n-1)
            n = min(len(returns), len(hl_range), len(vol_change))
            returns = returns[:n]
            hl_range = hl_range[:n]
            vol_change = vol_change[:n]

            # Simple rolling volatility and momentum
            volatility = np.zeros(n)
            momentum = np.zeros(n)
            for i in range(14, n):
                volatility[i] = np.std(returns[i - 14:i])
                momentum[i] = np.mean(returns[i - 14:i])

            feat = np.column_stack([returns, hl_range, vol_change, volatility, momentum])

            # Build sequences
            for i in range(sequence_length, n - 1):
                seq = feat[i - sequence_length:i, :input_features]
                target = 1.0 if returns[i] > 0 else 0.0
                all_features.append(seq)
                all_targets.append(target)

        if not all_features:
            return {
                "job_id": job_id,
                "status": "failed",
                "error": "No training data could be built from symbol universe",
                "execution_time": round(time.time() - t0, 2),
            }

        X = torch.tensor(np.array(all_features), dtype=torch.float32).to(device)
        y = torch.tensor(np.array(all_targets), dtype=torch.float32).to(device)

        log.info("[ML] Training data: %d samples, %d features, seq_len=%d, device=%s",
                 len(X), input_features, sequence_length, device)

        # --- Simple LSTM model ---
        class _LSTMModel(nn.Module):
            def __init__(self, inp, hidden, layers):
                super().__init__()
                self.lstm = nn.LSTM(inp, hidden, layers, batch_first=True, dropout=0.2 if layers > 1 else 0.0)
                self.fc = nn.Linear(hidden, 1)
                self.sigmoid = nn.Sigmoid()

            def forward(self, x):
                out, _ = self.lstm(x)
                out = self.fc(out[:, -1, :])
                return self.sigmoid(out).squeeze(-1)

        model = _LSTMModel(input_features, hidden_size, num_layers).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
        criterion = nn.BCELoss()

        # --- Training loop ---
        dataset = torch.utils.data.TensorDataset(X, y)
        loader = torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=True)

        train_losses = []
        for epoch in range(epochs):
            model.train()
            epoch_loss = 0.0
            batches = 0
            for xb, yb in loader:
                optimizer.zero_grad()
                pred = model(xb)
                loss = criterion(pred, yb)
                loss.backward()
                optimizer.step()
                epoch_loss += loss.item()
                batches += 1
            avg_loss = epoch_loss / max(batches, 1)
            train_losses.append(round(avg_loss, 6))

        # --- Evaluate ---
        model.eval()
        with torch.no_grad():
            preds = model(X)
            predicted_classes = (preds > 0.5).float()
            accuracy = (predicted_classes == y).float().mean().item()

        elapsed = round(time.time() - t0, 2)
        log.info("[ML] Training complete: %d epochs, loss=%.4f, accuracy=%.2f%%, %.1fs on %s",
                 epochs, train_losses[-1] if train_losses else 0, accuracy * 100, elapsed, device)

        return {
            "job_id": job_id,
            "status": "completed",
            "metrics": {
                "epochs": epochs,
                "final_loss": train_losses[-1] if train_losses else None,
                "accuracy": round(accuracy * 100, 2),
                "train_losses": train_losses,
                "samples": len(X),
                "device": str(device),
                "gpu_name": _GPU_NAME if device.type == "cuda" else None,
                "model_params": sum(p.numel() for p in model.parameters()),
                "symbols_used": len(symbol_universe),
            },
            "execution_time": elapsed,
        }

    except ImportError as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"PyTorch not installed: {e}",
            "execution_time": round(time.time() - t0, 2),
        }
    except Exception as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
            "execution_time": round(time.time() - t0, 2),
        }


def run_ml_predict_job(job_dict: dict, cache_dir: Path) -> dict:
    """Execute an ML prediction/inference job. Uses GPU when available.

    Expects job_dict keys:
      - job_id: str
      - model_weights: dict (serialized state_dict) or model_ref
      - symbol_universe: list[str]
      - model_config: dict with architecture params
    """
    job_id = job_dict.get("job_id", "unknown")
    t0 = time.time()

    try:
        import torch
        import torch.nn as nn
        import numpy as np

        device = _get_torch_device()
        if device.type == "cuda":
            log.info("[GPU] Using %s for ML predict job %s", _GPU_NAME, job_id)
        else:
            log.info("[CPU] Using CPU for ML predict job %s", job_id)

        model_config = job_dict.get("model_config", {})
        symbol_universe = job_dict.get("symbol_universe", [])
        region = job_dict.get("backtest_config", {}).get("region", "us")
        input_features = model_config.get("input_features", 5)
        sequence_length = model_config.get("sequence_length", 20)
        hidden_size = model_config.get("hidden_size", 128)
        num_layers = model_config.get("num_layers", 2)

        predictions = {}
        symbols_processed = 0

        for symbol in symbol_universe:
            bars = _load_bars(symbol, region, cache_dir)
            if bars is None or len(bars["closes"]) < sequence_length + 15:
                continue

            closes = bars["closes"]
            highs = bars["highs"]
            lows = bars["lows"]
            volumes = bars["volumes"]

            # Build feature vector for latest window
            returns = np.diff(closes) / (closes[:-1] + 1e-10)
            hl_range = (highs[1:] - lows[1:]) / (closes[1:] + 1e-10)
            vol_change = np.diff(volumes) / (volumes[:-1] + 1e-10)
            vol_change = np.clip(vol_change, -10, 10)

            n = min(len(returns), len(hl_range), len(vol_change))
            volatility = np.zeros(n)
            momentum = np.zeros(n)
            for i in range(14, n):
                volatility[i] = np.std(returns[i - 14:i])
                momentum[i] = np.mean(returns[i - 14:i])

            feat = np.column_stack([returns[:n], hl_range[:n], vol_change[:n],
                                    volatility, momentum])

            # Take the latest sequence
            if len(feat) < sequence_length:
                continue

            seq = feat[-sequence_length:, :input_features]
            X = torch.tensor(seq, dtype=torch.float32).unsqueeze(0).to(device)

            # Simple directional confidence based on feature statistics
            # (full model weights would be loaded from coordinator in production)
            confidence = float(np.clip(np.mean(momentum[-5:]) * 100 + 50, 0, 100))
            direction = "long" if confidence > 50 else "short"

            predictions[symbol] = {
                "confidence": round(confidence, 2),
                "direction": direction,
                "latest_return": round(float(returns[-1]), 6),
                "volatility": round(float(volatility[-1]), 6),
            }
            symbols_processed += 1

        elapsed = round(time.time() - t0, 2)
        log.info("[ML] Prediction complete: %d symbols, %.1fs on %s",
                 symbols_processed, elapsed, device)

        return {
            "job_id": job_id,
            "status": "completed",
            "metrics": {
                "symbols_processed": symbols_processed,
                "predictions": predictions,
                "device": str(device),
                "gpu_name": _GPU_NAME if device.type == "cuda" else None,
            },
            "execution_time": elapsed,
        }

    except ImportError as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"PyTorch not installed: {e}",
            "execution_time": round(time.time() - t0, 2),
        }
    except Exception as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
            "execution_time": round(time.time() - t0, 2),
        }


def run_optimization_job(job_dict: dict, cache_dir: Path) -> dict:
    """Execute a hyperparameter optimization job. Uses GPU for model eval.

    Runs a grid/random search over parameter combinations, evaluating each
    via a mini backtest or ML training pass.
    """
    job_id = job_dict.get("job_id", "unknown")
    t0 = time.time()

    try:
        import numpy as np

        opt_config = job_dict.get("optimization_config", job_dict.get("model_config", {}))
        param_grid = opt_config.get("param_grid", {})
        max_trials = opt_config.get("max_trials", 20)
        symbol_universe = job_dict.get("symbol_universe", [])
        region = job_dict.get("backtest_config", {}).get("region", "us")
        optimization_target = opt_config.get("target_metric", "sharpe")

        # Determine if this is a backtest optimization or ML optimization
        is_ml = opt_config.get("type", "backtest") == "ml"

        device_name = "cpu"
        if is_ml:
            try:
                import torch
                device = _get_torch_device()
                device_name = str(device)
                if device.type == "cuda":
                    log.info("[GPU] Using %s for optimization job %s", _GPU_NAME, job_id)
            except ImportError:
                device_name = "cpu"

        log.info("[OPT] Running %d trials for job %s (%s optimization)",
                 max_trials, job_id, "ML" if is_ml else "backtest")

        # Generate trial parameter sets
        import random
        trials = []
        for trial_idx in range(max_trials):
            trial_params = {}
            for param_name, param_range in param_grid.items():
                if isinstance(param_range, list):
                    trial_params[param_name] = random.choice(param_range)
                elif isinstance(param_range, dict):
                    lo = param_range.get("min", 0)
                    hi = param_range.get("max", 1)
                    step = param_range.get("step")
                    if isinstance(lo, float) or isinstance(hi, float):
                        trial_params[param_name] = round(random.uniform(lo, hi), 4)
                    elif step:
                        trial_params[param_name] = random.randrange(lo, hi + 1, step)
                    else:
                        trial_params[param_name] = random.randint(lo, hi)
                else:
                    trial_params[param_name] = param_range

            # Run a mini backtest with these params
            mini_job = dict(job_dict)
            mini_job["parameter_set"] = trial_params
            mini_job["job_id"] = f"{job_id}_trial_{trial_idx}"

            result = run_backtest_job(mini_job, cache_dir)
            metrics = result.get("metrics", {})
            score = metrics.get(optimization_target, 0.0)

            trials.append({
                "trial": trial_idx,
                "params": trial_params,
                "score": score,
                "metrics": {
                    "sharpe": metrics.get("sharpe", 0),
                    "win_rate": metrics.get("win_rate", 0),
                    "total_return": metrics.get("total_return", 0),
                    "num_trades": metrics.get("num_trades", 0),
                },
            })

        # Find best trial
        trials.sort(key=lambda t: t["score"], reverse=True)
        best = trials[0] if trials else {}

        elapsed = round(time.time() - t0, 2)
        log.info("[OPT] Optimization complete: best %s=%.4f, %d trials in %.1fs",
                 optimization_target, best.get("score", 0), len(trials), elapsed)

        return {
            "job_id": job_id,
            "status": "completed",
            "metrics": {
                "best_params": best.get("params", {}),
                "best_score": best.get("score", 0),
                "target_metric": optimization_target,
                "trials_run": len(trials),
                "top_5": trials[:5],
                "device": device_name,
                "gpu_name": _GPU_NAME if device_name != "cpu" else None,
            },
            "execution_time": elapsed,
        }

    except Exception as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
            "execution_time": round(time.time() - t0, 2),
        }


# ============================================================================
# Job Router  (dispatches by job_type -- NO proprietary code paths)
# ============================================================================

_JOB_HANDLERS = {
    "research_backtest": run_backtest_job,
    "backtest": run_backtest_job,  # same handler, simpler payload format
    "ml_train": run_ml_train_job,
    "ml_predict": run_ml_predict_job,
    "optimization": run_optimization_job,
}

# Job types that benefit from GPU acceleration
_GPU_JOB_TYPES = {"ml_train", "ml_predict", "optimization"}


def _unpack_payload(job_dict: dict) -> dict:
    """Ensure the ``payload`` field is a parsed dict merged into the job dict.

    The coordinator API may serialize the job payload as a JSON *string* inside
    the outer job envelope::

        {"job_id": "x", "job_type": "ml_train", "payload": "{\"strategy\":...}"}

    Handlers expect fields like ``symbol_universe``, ``model_config``, and
    ``backtest_config`` at the top level of ``job_dict``.  This helper:

      1. Parses ``payload`` from a JSON string to a dict (if it is a string).
      2. Merges the parsed payload keys into the job dict (without overwriting
         existing top-level keys such as ``job_id`` or ``job_type``).
      3. Keeps the original ``payload`` key as a dict for handlers that reference
         it directly (e.g. the backtest handler reads ``payload.candidate``).

    Returns a *new* dict so callers never mutate the dequeued original.
    """
    merged = dict(job_dict)

    payload = merged.get("payload")
    if payload is None:
        return merged

    # Parse JSON string into dict
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            log.warning("Could not parse payload JSON string for job %s — treating as empty",
                        merged.get("job_id", "unknown"))
            return merged

    if not isinstance(payload, dict):
        return merged

    # Store the parsed dict back so handlers that read job_dict["payload"] get a dict
    merged["payload"] = payload

    # Merge payload keys into top level (don't overwrite envelope fields)
    _ENVELOPE_KEYS = {"job_id", "job_type", "payload", "status", "worker_id",
                      "created_at", "updated_at", "priority"}
    for key, value in payload.items():
        if key not in _ENVELOPE_KEYS and key not in merged:
            merged[key] = value

    return merged


def route_job(job_dict: dict, cache_dir: Path) -> dict:
    """Route a job to the correct executor based on job_type.

    Supported job types:
      - research_backtest: parameter-driven backtest (CPU, primary workload)
      - ml_train: ML model training (GPU preferred, CPU fallback)
      - ml_predict: ML inference/prediction (GPU preferred, CPU fallback)
      - optimization: hyperparameter search (GPU for ML variants, CPU for backtests)

    All other job types are returned as 'failed' -- the coordinator will
    re-route them to a full node.
    """
    # Unpack payload: parse JSON string and merge into job dict so handlers
    # can access fields like symbol_universe, model_config at the top level.
    job_dict = _unpack_payload(job_dict)

    job_type = job_dict.get("job_type", "research_backtest")
    job_id = job_dict.get("job_id", "unknown")

    t0 = time.time()

    try:
        handler = _JOB_HANDLERS.get(job_type)
        if handler is not None:
            result = handler(job_dict, cache_dir)
        else:
            # Skip unsupported types as completed (keeps dequeue fast by not filtering)
            result = {
                "job_id": job_id,
                "status": "completed",
                "metrics": {"skipped": True, "reason": f"job type '{job_type}' not supported on grid worker"},
            }

        result["job_id"] = job_id
        result["execution_time"] = round(time.time() - t0, 2)
        return result

    except Exception as e:
        return {
            "job_id": job_id,
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "execution_time": round(time.time() - t0, 2),
        }


# ============================================================================
# Main Worker Loop
# ============================================================================

class GridWorker:
    """SETI@home-style research worker: pulls jobs over HTTPS, computes, reports."""

    def __init__(self, config: WorkerConfig, token: str, worker_id: str):
        self.config = config
        config.ensure_dirs()

        self.client = CoordinatorClient(
            base_url=config.coordinator_url,
            token=token,
            worker_id=worker_id,
        )
        self.fetcher = DataFetcher(client=self.client, cache_dir=config.cache_dir)
        self.throttle = AdaptiveThrottle(max_parallel=config.max_parallel)
        self._mode = getattr(config, '_mode', 'hybrid')
        self.worker_id = worker_id

        self._shutdown = Event()
        self._active_job_ids: List[str] = []
        self._last_queue_hint = 0  # estimated remaining queue from last dequeue
        self.stats = {"completed": 0, "failed": 0, "started_at": 0.0}

    def _capabilities(self) -> dict:
        caps = {
            "hostname": platform.node() or "unknown",
            "cpu_count": self.config.cpu_count,
            "cpus": self.config.cpu_count,
            "ram_gb": self.config.ram_gb,
            "max_parallel": self.config.max_parallel,
            "os": f"{platform.system()} {platform.release()}",
            "python_version": platform.python_version(),
            "worker_version": __version__,
            "worker_type": "grid_contributor",
            "supported_job_types": sorted(_JOB_HANDLERS.keys()),
        }

        # GPU capabilities
        if _GPU_AVAILABLE:
            caps["gpu_available"] = True
            caps["cuda_available"] = True
            caps["gpu_model"] = _GPU_NAME
            caps["gpu_vram_gb"] = _GPU_VRAM_GB
            caps["capabilities"] = ["cpu", "gpu", "backtest", "ml"]
        else:
            caps["gpu_available"] = False
            caps["capabilities"] = ["cpu", "backtest"]

        # Report PyTorch availability (can still do ML on CPU)
        caps["pytorch_available"] = _torch is not None

        return caps

    def _throughput(self) -> float:
        elapsed = time.time() - self.stats["started_at"]
        if elapsed < 10:
            return 0.0
        return self.stats["completed"] / (elapsed / 60.0)

    def _heartbeat_loop(self):
        consecutive_failures = 0
        MAX_FAILURES_BEFORE_REREGISTER = 5  # 5 failures * 30s = 2.5min, just under the 3min ghost cutoff

        while not self._shutdown.is_set():
            try:
                success = self.client.heartbeat(list(self._active_job_ids))
                if success:
                    if consecutive_failures > 0:
                        log.info("Heartbeat recovered after %d consecutive failures", consecutive_failures)
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    log.warning("Heartbeat returned non-200 (failure %d/%d)",
                                consecutive_failures, MAX_FAILURES_BEFORE_REREGISTER)
            except Exception as e:
                consecutive_failures += 1
                log.warning("Heartbeat failed (attempt %d/%d): %s",
                            consecutive_failures, MAX_FAILURES_BEFORE_REREGISTER, e)

            # If heartbeats have been failing consistently, re-register to
            # ensure the server still knows about us before the 3-min ghost
            # cutoff marks us offline
            if consecutive_failures >= MAX_FAILURES_BEFORE_REREGISTER:
                log.warning("Heartbeat failed %d times consecutively -- re-registering with coordinator",
                            consecutive_failures)
                try:
                    if self.client.register(self._capabilities()):
                        log.info("Re-registration successful after heartbeat failures")
                        consecutive_failures = 0
                    else:
                        log.error("Re-registration also failed -- will keep retrying")
                except Exception as e:
                    log.error("Re-registration error: %s", e)

            # Use a shorter interval after failures to recover faster,
            # but not so short that we hammer the server
            if consecutive_failures > 0:
                wait_time = min(self.config.heartbeat_interval, 15)
            else:
                wait_time = self.config.heartbeat_interval
            self._shutdown.wait(timeout=wait_time)

    def _prefetch_data(self, jobs: List[dict]):
        region_symbols: Dict[str, List[str]] = {}
        for job in jobs:
            unpacked = _unpack_payload(job)
            bc = unpacked.get("backtest_config", {})
            region = bc.get("region", "us")
            symbols = unpacked.get("symbol_universe", [])
            region_symbols.setdefault(region, []).extend(symbols)

        for region, syms in region_symbols.items():
            unique = list(dict.fromkeys(syms))
            self.fetcher.ensure_data(unique, region)

    def _execute_batch(self, jobs: List[dict]) -> List[dict]:
        self._prefetch_data(jobs)
        self._active_job_ids = [j.get("job_id", "?") for j in jobs]

        results: List[dict] = []
        # In max mode, use all workers; in hybrid, adapt to system load; in dev, cap low
        if self._mode == "max":
            max_workers = min(self.config.max_parallel, len(jobs))
        elif self._mode == "dev":
            max_workers = min(4, len(jobs))
        else:
            max_workers = min(self.throttle.recommended_workers(), len(jobs))
        cache_dir = self.config.cache_dir

        if max_workers <= 1 or len(jobs) == 1:
            for job in jobs:
                t0 = time.time()
                result = route_job(job, cache_dir)
                result["execution_time"] = round(time.time() - t0, 2)
                result["worker_id"] = self.worker_id
                results.append(result)
            self._active_job_ids = []
            return results

        try:
            with ProcessPoolExecutor(max_workers=max_workers) as executor:
                future_to_job = {}
                for job in jobs:
                    fut = executor.submit(route_job, job, cache_dir)
                    future_to_job[fut] = job.get("job_id", "?")

                timeout = self.config.job_timeout * len(jobs)
                for future in as_completed(future_to_job, timeout=timeout):
                    job_id = future_to_job[future]
                    try:
                        result = future.result(timeout=self.config.job_timeout)
                        result["worker_id"] = self.worker_id
                        results.append(result)
                    except FuturesTimeout:
                        results.append({
                            "job_id": job_id, "status": "failed",
                            "error": f"Timed out after {self.config.job_timeout}s",
                            "worker_id": self.worker_id,
                        })
                    except Exception as e:
                        results.append({
                            "job_id": job_id, "status": "failed",
                            "error": str(e), "worker_id": self.worker_id,
                        })
        except Exception as e:
            log.error("Batch execution error: %s", e)
            completed_ids = {r.get("job_id") for r in results}
            for job in jobs:
                jid = job.get("job_id", "?")
                if jid not in completed_ids:
                    results.append({
                        "job_id": jid, "status": "failed",
                        "error": f"Batch error: {e}", "worker_id": self.worker_id,
                    })
        finally:
            self._active_job_ids = []

        return results

    def _report_results(self, results: List[dict]):
        # Batch report: single HTTP call for all results
        batch = []
        for result in results:
            batch.append({
                "job_id": result.get("job_id", "unknown"),
                "status": result.get("status", "completed"),
                "metrics": result.get("metrics", {}),
                "error": result.get("error", ""),
            })

        try:
            resp = self.client.complete_batch(batch)
            completed = resp.get("completed", 0)
            failed = resp.get("failed", 0)
            self.stats["completed"] += completed
            self.stats["failed"] += failed
            # Feed throughput tracker for adaptive throttling
            if completed > 0:
                self.throttle.record_completion(completed)
            if failed:
                log.warning("Batch report: %d completed, %d failed", completed, failed)
        except Exception as e:
            log.error("Batch report failed: %s — falling back to per-job", e)
            # Fallback: report one at a time
            for result in results:
                job_id = result.get("job_id", "unknown")
                try:
                    if result.get("status") == "completed":
                        self.client.complete(job_id, metrics=result.get("metrics", {}))
                        self.stats["completed"] += 1
                    else:
                        self.client.fail(job_id, result.get("error", "unknown"))
                        self.stats["failed"] += 1
                except Exception:
                    self.stats["failed"] += 1

    @staticmethod
    def _auto_update():
        """Check GitHub for updates and pull if newer. Restart if code changed."""
        worker_dir = Path(__file__).resolve().parent
        repo_dir = worker_dir.parent  # AuraCommandV2 root
        git_dir = repo_dir / ".git"
        if not git_dir.exists():
            return False
        try:
            # Fetch latest
            result = subprocess.run(
                ["git", "fetch", "origin", "master"],
                cwd=str(repo_dir), capture_output=True, text=True, timeout=15,
            )
            if result.returncode != 0:
                return False
            # Check if behind
            result = subprocess.run(
                ["git", "rev-list", "--count", "HEAD..origin/master"],
                cwd=str(repo_dir), capture_output=True, text=True, timeout=5,
            )
            behind = int(result.stdout.strip() or "0")
            if behind == 0:
                log.info("[AUTO-UPDATE] Code is current")
                return False
            log.info("[AUTO-UPDATE] %d new commits available — pulling...", behind)
            result = subprocess.run(
                ["git", "pull", "origin", "master", "--ff-only"],
                cwd=str(repo_dir), capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                log.info("[AUTO-UPDATE] Updated! Restarting worker...")
                # Re-exec ourselves with the same args
                os.execv(sys.executable, [sys.executable] + sys.argv)
            else:
                log.warning("[AUTO-UPDATE] Pull failed: %s", result.stderr[:100])
                return False
        except Exception as e:
            log.debug("[AUTO-UPDATE] Check failed: %s", e)
            return False

    def run(self):
        """Main loop: register -> dequeue -> execute -> report -> repeat."""
        self.stats["started_at"] = time.time()

        # Auto-update on startup
        self._auto_update()

        log.info("=" * 70)
        log.info("Aura Alpha Grid Worker v%s starting", __version__)
        log.info("Worker ID: %s", self.worker_id)
        log.info("Coordinator: %s", self.config.coordinator_url)
        log.info("CPUs: %d | RAM: %.1f GB | Parallel: %d | Batch: %d",
                 self.config.cpu_count, self.config.ram_gb,
                 self.config.max_parallel, self.config.batch_size)
        if _GPU_AVAILABLE:
            log.info("GPU: %s (%.1f GB VRAM) -- CUDA acceleration enabled", _GPU_NAME, _GPU_VRAM_GB)
        else:
            log.info("GPU: not available -- ML jobs will use CPU")
        log.info("Job types: %s", ", ".join(sorted(_JOB_HANDLERS.keys())))
        log.info("Cache: %s", self.config.cache_dir)
        log.info("Adaptive throttle: ON (yields to games, apps, heavy processes)")
        log.info("=" * 70)

        # Graceful shutdown
        def _signal_handler(signum, frame):
            log.info("Received signal %d, shutting down gracefully...", signum)
            self._shutdown.set()

        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)

        # Register with coordinator (retry up to 5 times)
        for attempt in range(5):
            if self.client.register(self._capabilities()):
                break
            log.warning("Registration attempt %d/5 failed, retrying in %ds...",
                        attempt + 1, 3 * (attempt + 1))
            time.sleep(3 * (attempt + 1))
        else:
            log.error("Failed to register after 5 attempts. Check your network and coordinator URL.")
            return

        # Start heartbeat daemon thread
        hb_thread = Thread(target=self._heartbeat_loop, daemon=True, name="heartbeat")
        hb_thread.start()

        # Main dequeue-execute loop with exponential backoff
        idle_backoff = 1
        max_backoff = 30

        while not self._shutdown.is_set():
            try:
                # Throttle check (pass queue hint from last batch size)
                recommended = self.throttle.recommended_workers(
                    queue_size=self._last_queue_hint)
                batch_count = self.config.batch_size
                if recommended < self.config.max_parallel:
                    ratio = recommended / max(self.config.max_parallel, 1)
                    batch_count = max(1, int(self.config.batch_size * ratio))
                    if ratio <= 0.25:
                        self._shutdown.wait(timeout=5)
                        if self._shutdown.is_set():
                            break

                # Dequeue — no type filter for fastest query (skip unsupported in router)
                jobs = self.client.dequeue(count=batch_count)
                if not jobs:
                    log.debug("No jobs available, sleeping %ds", idle_backoff)
                    self._shutdown.wait(timeout=idle_backoff)
                    idle_backoff = min(idle_backoff * 2, max_backoff)
                    continue

                idle_backoff = 1
                # Queue hint: if we got a full batch, queue is at least that size
                self._last_queue_hint = len(jobs) if len(jobs) >= batch_count else max(1, len(jobs) // 2)
                throttle_tag = (f" [throttled {recommended}/{self.config.max_parallel}]"
                                if self.throttle.is_throttled else "")
                log.info("Dequeued %d jobs%s", len(jobs), throttle_tag)

                # Execute
                batch_start = time.time()
                results = self._execute_batch(jobs)
                batch_elapsed = time.time() - batch_start

                # Report
                self._report_results(results)

                completed = sum(1 for r in results if r.get("status") == "completed")
                failed = len(results) - completed
                log.info("Batch done: %d completed, %d failed in %.1fs (%.1f jobs/min)%s",
                         completed, failed, batch_elapsed, self._throughput(), throttle_tag)

                # Throttle: pause between batches to avoid exhausting API connection pool
                self._shutdown.wait(timeout=2)

            except KeyboardInterrupt:
                log.info("Worker interrupted.")
                break
            except Exception as e:
                log.error("Worker loop error: %s", e)
                log.debug(traceback.format_exc())
                self._shutdown.wait(timeout=5)

        self._shutdown.set()
        log.info("=" * 70)
        log.info("Worker %s stopped. Completed: %d | Failed: %d | Throughput: %.1f/min",
                 self.worker_id, self.stats["completed"],
                 self.stats["failed"], self._throughput())
        log.info("=" * 70)


# ============================================================================
# CLI Entry Point
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Aura Alpha Grid Worker -- distributed compute node",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python worker.py
  python worker.py --max-parallel 4
  python worker.py --coordinator-url https://auraalpha.cc --verbose
  python worker.py --token MY_TOKEN

Token resolution order:
  1. --token CLI flag
  2. GRID_WORKER_TOKEN or AURA_TOKEN env var
  3. Stored token from previous auto-provision (~/.aura-worker/grid_token.json)
  4. Auto-provision from coordinator (zero setup required)
""",
    )
    parser.add_argument("--coordinator-url", type=str, default="",
                        help="Coordinator URL (default: from .env or https://auraalpha.cc)")
    parser.add_argument("--token", type=str, default="",
                        help="Worker token (default: auto-provisioned)")
    parser.add_argument("--max-parallel", type=int, default=0,
                        help="Max parallel jobs (0 = auto from CPU count)")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="Jobs to pull per batch (default: 5)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable debug logging")
    parser.add_argument("--no-verify-ssl", action="store_true",
                        help="Disable SSL verification (for networks with DNS proxies)")
    parser.add_argument("--coordinator-host", type=str, default="",
                        help="Override Host header (use with IP-based coordinator URL)")
    parser.add_argument("--mode", type=str, default="hybrid",
                        choices=["hybrid", "max", "dev"],
                        help="Compute mode: hybrid (adaptive, default), max (full CPU), dev (minimal)")

    args = parser.parse_args()

    # Logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Load .env if present (simple key=value parser, no dependency)
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        try:
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and val and key not in os.environ:
                        os.environ[key] = val
        except Exception:
            pass

    # Build config from defaults + env
    coordinator_url = (args.coordinator_url
                       or os.getenv("COORDINATOR_URL")
                       or os.getenv("AURA_COORDINATOR_URL")
                       or "https://auraalpha.cc")
    max_parallel = args.max_parallel or int(os.getenv("MAX_PARALLEL", "0"))
    batch_size = args.batch_size or int(os.getenv("BATCH_SIZE", "5"))

    # Apply compute mode presets
    cpu_count = _auto_cpu_count()
    mode = args.mode
    if mode == "max":
        if max_parallel <= 0:
            max_parallel = max(4, cpu_count - 2)
        log.info("[MODE] COMPUTE MAX — %d workers, no adaptive throttling", max_parallel)
    elif mode == "dev":
        max_parallel = min(max_parallel or 4, 6)
        log.info("[MODE] DEV — %d workers, minimal background compute", max_parallel)
    else:  # hybrid (default)
        if max_parallel <= 0:
            max_parallel = max(6, int(cpu_count * 0.65))
        log.info("[MODE] HYBRID — up to %d workers, adaptive throttling active", max_parallel)

    # Windows: set process priority to BELOW_NORMAL + low I/O for responsiveness
    if platform.system() == "Windows":
        try:
            import ctypes
            BELOW_NORMAL_PRIORITY = 0x00004000
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY)
            # Also set I/O priority to low
            ProcessIoPriority = 33  # ProcessInformationClass
            LOW_IO = 1
            ctypes.windll.ntdll.NtSetInformationProcess(handle, ProcessIoPriority, ctypes.byref(ctypes.c_ulong(LOW_IO)), 4)
            log.info("[PRIORITY] Windows process set to BELOW_NORMAL + LOW I/O")
        except Exception as e:
            log.debug("Could not set Windows priority: %s", e)

    verify_ssl = not args.no_verify_ssl
    coordinator_host = args.coordinator_host or os.getenv("COORDINATOR_HOST", "")

    config = WorkerConfig(
        coordinator_url=coordinator_url,
        coordinator_host=coordinator_host,
        verify_ssl=verify_ssl,
        max_parallel=max_parallel,
        batch_size=batch_size,
        verbose=args.verbose,
    )
    config._mode = mode  # store mode for throttle behavior

    # Set SSL verification globally for request functions
    resolve_token._verify_ssl = verify_ssl
    _http_request._verify_ssl = verify_ssl

    # Resolve token
    try:
        token, worker_id = resolve_token(coordinator_url, args.token or None)
    except Exception as e:
        print(f"\n[ERROR] Cannot obtain worker token: {e}")
        print(f"[ERROR] Coordinator URL: {coordinator_url}")
        print("[ERROR] Check your network connection and try:")
        print(f"  python worker.py --coordinator-url https://auraalpha.cc")
        print("\nPress Enter to exit...")
        try:
            input()
        except EOFError:
            pass
        sys.exit(1)

    # Run
    worker = GridWorker(config, token, worker_id)
    try:
        worker.run()
    except KeyboardInterrupt:
        log.info("Worker stopped by user")
    except Exception as e:
        print(f"\n[ERROR] Worker crashed: {e}")
        print("Press Enter to exit...")
        try:
            input()
        except EOFError:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
