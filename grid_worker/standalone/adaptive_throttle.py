"""
Adaptive Throttle — Monitors system load and yields to other processes.
========================================================================
Checks CPU and RAM pressure from non-worker processes (games, apps, etc.)
and dynamically reduces/increases the worker pool size.

Rules:
  - If other processes use >60% CPU → drop to 25% of max workers
  - If other processes use >40% CPU → drop to 50% of max workers
  - If other processes use >20% CPU → drop to 75% of max workers
  - If RAM available <25% → drop to minimum (2 workers)
  - Otherwise → full max_parallel
  - Never drops below 1 worker
  - Changes are gradual (ramp up slowly, drop fast)

Cross-platform: works on Windows, Linux, macOS.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

log = logging.getLogger("standalone.throttle")

# How often to re-check (seconds)
CHECK_INTERVAL = 10

# Thresholds for "other process" CPU usage (percentage of total CPU)
# Aggressive: trading bots + API + IBKR are expected background load, not contention
HEAVY_LOAD = 85    # only yield for truly heavy workloads (games, video rendering)
MEDIUM_LOAD = 70   # significant external load — still keep most workers
LIGHT_LOAD = 50    # normal trading ops — run at near-full capacity

# RAM threshold — if available RAM drops below this %, go minimal
RAM_CRITICAL_PCT = 15  # 64GB machine: only panic below ~10GB free

# How fast to ramp back up (prevents yo-yoing)
RAMP_UP_STEP = 16  # ramp aggressively — reach max in ~2 checks
RAMP_DOWN_INSTANT = True  # drop immediately when load detected


def _get_system_metrics() -> dict:
    """Get CPU and RAM metrics. Returns {cpu_pct, ram_available_pct, cpu_count}."""
    try:
        import psutil
        # CPU: average over 1 second (non-blocking if called periodically)
        cpu_pct = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        return {
            "cpu_pct": cpu_pct,
            "ram_available_pct": mem.available / mem.total * 100,
            "ram_used_gb": (mem.total - mem.available) / (1024 ** 3),
            "ram_total_gb": mem.total / (1024 ** 3),
            "cpu_count": psutil.cpu_count(),
        }
    except ImportError:
        pass

    # Fallback: /proc on Linux
    try:
        # CPU from /proc/stat
        with open("/proc/stat") as f:
            parts = f.readline().split()
            idle = int(parts[4])
            total = sum(int(p) for p in parts[1:])

        time.sleep(0.3)

        with open("/proc/stat") as f:
            parts2 = f.readline().split()
            idle2 = int(parts2[4])
            total2 = sum(int(p) for p in parts2[1:])

        d_total = total2 - total
        d_idle = idle2 - idle
        cpu_pct = ((d_total - d_idle) / max(d_total, 1)) * 100

        # RAM from /proc/meminfo
        meminfo = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                meminfo[parts[0].rstrip(":")] = int(parts[1])

        total_kb = meminfo.get("MemTotal", 1)
        avail_kb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0))

        return {
            "cpu_pct": round(cpu_pct, 1),
            "ram_available_pct": round(avail_kb / total_kb * 100, 1),
            "ram_used_gb": round((total_kb - avail_kb) / (1024 ** 2), 1),
            "ram_total_gb": round(total_kb / (1024 ** 2), 1),
            "cpu_count": os.cpu_count() or 1,
        }
    except Exception:
        return {
            "cpu_pct": 0,
            "ram_available_pct": 100,
            "ram_used_gb": 0,
            "ram_total_gb": 0,
            "cpu_count": os.cpu_count() or 1,
        }


def _estimate_worker_cpu(max_parallel: int, cpu_count: int) -> float:
    """Estimate how much CPU our workers use (rough: each worker ≈ 1 core)."""
    return (max_parallel / max(cpu_count, 1)) * 100


class AdaptiveThrottle:
    """Monitors system load and recommends worker count."""

    def __init__(self, max_parallel: int):
        self.max_parallel = max_parallel
        self.current_parallel = max_parallel
        self._last_check = 0.0
        self._last_metrics: Optional[dict] = None

    def recommended_workers(self) -> int:
        """Returns the recommended number of parallel workers right now.

        Call this before each batch. It checks system metrics and adjusts.
        Caches the result for CHECK_INTERVAL seconds to avoid hammering /proc.
        """
        now = time.time()
        if now - self._last_check < CHECK_INTERVAL:
            return self.current_parallel

        self._last_check = now
        metrics = _get_system_metrics()
        self._last_metrics = metrics

        total_cpu = metrics["cpu_pct"]
        ram_avail = metrics["ram_available_pct"]
        cpu_count = metrics["cpu_count"]

        # Estimate how much CPU is US vs OTHER processes
        our_estimated_cpu = _estimate_worker_cpu(self.current_parallel, cpu_count)
        other_cpu = max(0, total_cpu - our_estimated_cpu)

        # Determine target based on OTHER process load
        # Aggressive: keep most workers running even under normal trading load
        if ram_avail < RAM_CRITICAL_PCT:
            target = max(2, self.max_parallel // 4)
            reason = f"RAM critical ({ram_avail:.0f}% available)"
        elif other_cpu >= HEAVY_LOAD:
            target = max(4, self.max_parallel // 2)
            reason = f"heavy load ({other_cpu:.0f}% other CPU)"
        elif other_cpu >= MEDIUM_LOAD:
            target = max(4, int(self.max_parallel * 0.70))
            reason = f"medium load ({other_cpu:.0f}% other CPU)"
        elif other_cpu >= LIGHT_LOAD:
            target = max(4, int(self.max_parallel * 0.85))
            reason = f"light load ({other_cpu:.0f}% other CPU)"
        else:
            target = self.max_parallel
            reason = "idle"

        prev = self.current_parallel

        # Drop fast, ramp up slowly
        if target < self.current_parallel:
            self.current_parallel = target
        elif target > self.current_parallel:
            self.current_parallel = min(target, self.current_parallel + RAMP_UP_STEP)

        if self.current_parallel != prev:
            log.info(
                "Throttle: %d → %d workers (%s) | CPU: %.0f%% (other: %.0f%%) | RAM: %.0f%% free",
                prev, self.current_parallel, reason,
                total_cpu, other_cpu, ram_avail,
            )

        return self.current_parallel

    @property
    def metrics(self) -> Optional[dict]:
        """Last captured system metrics."""
        return self._last_metrics

    @property
    def is_throttled(self) -> bool:
        """True if currently running below max capacity."""
        return self.current_parallel < self.max_parallel


# ══════════════════════════════════════════════════════════════════════
#  Auto-Tuner — continuously benchmarks and adjusts batch size,
#  worker count, and GPU routing based on actual throughput.
# ══════════════════════════════════════════════════════════════════════

def _get_gpu_metrics() -> dict:
    """Get GPU utilization, memory, and temperature. Returns empty dict if no GPU."""
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split(", ")
            return {
                "gpu_util_pct": float(parts[0]),
                "gpu_mem_pct": float(parts[1]),
                "gpu_mem_used_mb": float(parts[2]),
                "gpu_mem_total_mb": float(parts[3]),
                "gpu_temp_c": float(parts[4]),
                "gpu_available": True,
            }
    except Exception:
        pass
    return {"gpu_available": False}


def _get_cpu_temp() -> float:
    """Get CPU temperature in °C. Tries WMI via PowerShell (WSL2), falls back to thermal_zone."""
    # WSL2: read from Windows WMI
    try:
        import subprocess
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "(Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi "
             "2>$null).CurrentTemperature"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            decikelvin = float(result.stdout.strip())
            return round(decikelvin / 10.0 - 273.15, 1)
    except Exception:
        pass
    # Linux native: /sys/class/thermal
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except Exception:
        pass
    return -1.0  # unknown


# Thermal thresholds (°C) — safe operating ranges
CPU_TEMP_RAMP = 60     # below this: scale up aggressively
CPU_TEMP_HOLD = 70     # above this: stop scaling up
CPU_TEMP_REDUCE = 80   # above this: reduce workers
CPU_TEMP_CRITICAL = 85 # above this: drop to minimum

GPU_TEMP_RAMP = 65     # below this: enable GPU, scale up
GPU_TEMP_HOLD = 75     # above this: stop GPU scaling
GPU_TEMP_REDUCE = 82   # above this: disable GPU
GPU_TEMP_CRITICAL = 88 # above this: force disable GPU


class AutoTuner:
    """Continuously benchmarks and adjusts processing parameters.

    Monitors:
      - CPU utilization (per-core and aggregate)
      - RAM pressure
      - GPU utilization and VRAM
      - Per-batch throughput (jobs/sec)
      - Per-job execution time
      - Network overhead (dequeue + complete latency)

    Adjusts:
      - batch_size: bigger when jobs are fast, smaller when heavy
      - max_parallel: scale with available headroom
      - gpu_preferred: route ML jobs to GPU when available and underused

    Philosophy: maximize throughput without impacting user experience.
    Drop fast on user activity, ramp aggressively when idle.
    """

    def __init__(self, initial_parallel: int, initial_batch: int):
        self.max_parallel = initial_parallel
        self.batch_size = initial_batch
        self.gpu_preferred = False

        # Benchmarking state
        self._history: list[dict] = []  # last N batch results
        self._max_history = 20
        self._tune_interval = 30.0  # seconds between tune cycles
        self._last_tune = 0.0

        # Bounds — thermal governor controls the ceiling, not a fixed cap.
        # initial_parallel is the RAM-aware ceiling computed by
        # grid_worker_daemon.sh (cgroup MemoryHigh / per-worker budget).
        # Scaling ABOVE it causes swap thrash: on a 47GB/22-core laptop
        # with MemoryHigh=32G and ~1.5GB per worker, the RAM ceiling is
        # 18 but cpu_count-4=28 — going to 22+ pushes 6GB into swap and
        # tanks throughput. Treat initial_parallel as a hard upper bound.
        self._min_batch = 8
        self._max_batch = min(initial_parallel * 6, 400)
        self._min_parallel = 4
        self._max_parallel_cap = initial_parallel

    def record_batch(self, jobs_count: int, exec_seconds: float,
                     report_seconds: float, dequeue_seconds: float):
        """Record timing for one batch cycle."""
        total = exec_seconds + report_seconds + dequeue_seconds
        self._history.append({
            "ts": time.time(),
            "jobs": jobs_count,
            "exec_s": exec_seconds,
            "report_s": report_seconds,
            "dequeue_s": dequeue_seconds,
            "total_s": total,
            "jobs_per_sec": jobs_count / max(total, 0.01),
        })
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

    def tune(self) -> dict:
        """Run a tuning cycle. Returns current settings + adjustments made.

        Call this periodically (every ~30s). It analyzes recent batch
        history and system metrics to adjust parameters.
        """
        now = time.time()
        if now - self._last_tune < self._tune_interval:
            return self.settings
        self._last_tune = now

        if len(self._history) < 3:
            return self.settings

        adjustments = []
        sys_metrics = _get_system_metrics()
        gpu_metrics = _get_gpu_metrics()

        # ── Analyze recent performance ────────────────────────────
        recent = self._history[-10:]
        avg_exec = sum(h["exec_s"] for h in recent) / len(recent)
        avg_report = sum(h["report_s"] for h in recent) / len(recent)
        avg_dequeue = sum(h["dequeue_s"] for h in recent) / len(recent)
        avg_throughput = sum(h["jobs_per_sec"] for h in recent) / len(recent)
        avg_jobs = sum(h["jobs"] for h in recent) / len(recent)

        cpu_pct = sys_metrics.get("cpu_pct", 50)
        ram_avail_pct = sys_metrics.get("ram_available_pct", 50)

        # ── Batch size tuning ─────────────────────────────────────
        # If jobs are fast (<1s exec), increase batch to reduce overhead ratio
        if avg_exec < 1.0 and avg_report > avg_exec * 0.5:
            new_batch = min(self.batch_size + 16, self._max_batch)
            if new_batch != self.batch_size:
                adjustments.append(f"batch {self.batch_size}→{new_batch} (fast jobs, amortize network)")
                self.batch_size = new_batch

        # If jobs are heavy (>10s exec), reduce batch to avoid timeouts
        elif avg_exec > 10.0:
            new_batch = max(self.batch_size // 2, self._min_batch)
            if new_batch != self.batch_size:
                adjustments.append(f"batch {self.batch_size}→{new_batch} (heavy jobs)")
                self.batch_size = new_batch

        # ── Thermal-aware parallel worker tuning ─────────────────
        # Temperature is the PRIMARY governor. CPU util + RAM are secondary.
        cpu_temp = _get_cpu_temp()
        cpu_temp_tag = f"{cpu_temp:.0f}°C" if cpu_temp > 0 else "N/A"

        if cpu_temp > CPU_TEMP_CRITICAL:
            # Emergency: drop to minimum
            new_parallel = self._min_parallel
            if new_parallel != self.max_parallel:
                adjustments.append(f"parallel {self.max_parallel}→{new_parallel} (CPU {cpu_temp_tag} CRITICAL)")
                self.max_parallel = new_parallel
        elif cpu_temp > CPU_TEMP_REDUCE:
            # Hot: shed workers
            new_parallel = max(self.max_parallel - 4, self._min_parallel)
            if new_parallel != self.max_parallel:
                adjustments.append(f"parallel {self.max_parallel}→{new_parallel} (CPU {cpu_temp_tag} hot)")
                self.max_parallel = new_parallel
        elif cpu_temp > CPU_TEMP_HOLD:
            # Warm: hold steady, don't add more
            pass
        elif ram_avail_pct < 15:
            # RAM pressure overrides thermal headroom
            new_parallel = max(self.max_parallel - 4, self._min_parallel)
            if new_parallel != self.max_parallel:
                adjustments.append(f"parallel {self.max_parallel}→{new_parallel} (RAM {ram_avail_pct:.0f}%)")
                self.max_parallel = new_parallel
        else:
            # Cool CPU + healthy RAM: ramp up aggressively
            new_parallel = min(self.max_parallel + 4, self._max_parallel_cap)
            if new_parallel != self.max_parallel:
                adjustments.append(
                    f"parallel {self.max_parallel}→{new_parallel} "
                    f"(CPU {cpu_temp_tag}, {cpu_pct:.0f}% util, thermal headroom)")
                self.max_parallel = new_parallel

        # ── GPU thermal-aware routing ─────────────────────────────
        if gpu_metrics.get("gpu_available"):
            gpu_util = gpu_metrics.get("gpu_util_pct", 0)
            gpu_mem_pct = gpu_metrics.get("gpu_mem_pct", 0)
            gpu_temp = gpu_metrics.get("gpu_temp_c", 0)

            if gpu_temp > GPU_TEMP_REDUCE:
                # GPU too hot — disable
                if self.gpu_preferred:
                    self.gpu_preferred = False
                    adjustments.append(f"GPU disabled ({gpu_temp:.0f}°C hot)")
            elif gpu_temp < GPU_TEMP_RAMP and gpu_util < 70 and gpu_mem_pct < 70:
                # GPU cool and available — enable
                if not self.gpu_preferred:
                    self.gpu_preferred = True
                    adjustments.append(f"GPU enabled ({gpu_temp:.0f}°C, util={gpu_util:.0f}%)")
            elif gpu_temp >= GPU_TEMP_HOLD and self.gpu_preferred:
                # GPU warm — hold, but log it
                pass
            elif (gpu_util > 90 or gpu_mem_pct > 85) and self.gpu_preferred:
                self.gpu_preferred = False
                adjustments.append(f"GPU disabled (util={gpu_util:.0f}%, mem={gpu_mem_pct:.0f}%)")

        if adjustments:
            log.info("AutoTune: %s | throughput=%.1f jobs/s | CPU=%.0f%% RAM=%.0f%% free",
                     " | ".join(adjustments), avg_throughput, cpu_pct, ram_avail_pct)

        return self.settings

    @property
    def settings(self) -> dict:
        return {
            "max_parallel": self.max_parallel,
            "batch_size": self.batch_size,
            "gpu_preferred": self.gpu_preferred,
        }
