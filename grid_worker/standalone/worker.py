"""
StandaloneWorker — main worker loop.
Connects to coordinator via HTTPS, pulls jobs, executes backtests in parallel,
reports results. No Redis or shared filesystem needed.
"""
from __future__ import annotations

import logging
import multiprocessing as mp
import os
import platform
import signal
import sys
import time
import traceback
import requests
from concurrent.futures import ProcessPoolExecutor, as_completed, TimeoutError as FuturesTimeout
from threading import Event, Thread
from typing import Any, Dict, List, Optional

from .adaptive_throttle import AdaptiveThrottle, AutoTuner
from .api_client import CoordinatorClient
from .backtest_engine import run_single_research_job
from .config import WorkerConfig
from .data_fetcher import DataFetcher
from .job_router import route_job

log = logging.getLogger("standalone.worker")


class StandaloneWorker:
    """SETI@home-style research worker that pulls jobs over HTTPS."""

    def __init__(self, config: WorkerConfig):
        self.config = config
        config.ensure_dirs()

        self.client = CoordinatorClient(
            coordinator_url=config.coordinator_url,
            token=config.token,
            worker_id=config.worker_id,
        )
        self.fetcher = DataFetcher(client=self.client, cache_dir=config.cache_dir)

        self._shutdown = Event()
        self._active_job_ids: List[str] = []
        self._heartbeat_thread: Optional[Thread] = None

        # Adaptive throttle — yields to games, apps, etc.
        self.throttle = AdaptiveThrottle(max_parallel=config.max_parallel)
        self.tuner = AutoTuner(initial_parallel=config.max_parallel, initial_batch=config.batch_size)

        # GPU info (cached at startup)
        self._gpu_info: Dict[str, Any] = {"cpu_cores": config.cpu_count, "memory_gb": config.ram_gb}
        try:
            from ..gpu_detect import detect_gpu
            gpu_model, gpu_vram_gb, cuda_available = detect_gpu()
            self._gpu_info.update({
                "gpu_model": gpu_model,
                "gpu_vram_gb": gpu_vram_gb,
                "cuda_available": cuda_available,
            })
        except Exception:
            pass

        # Stats
        self.stats = {
            "completed": 0,
            "failed": 0,
            "started_at": 0.0,
            "total_job_seconds": 0.0,
        }

    # ── Capabilities ──────────────────────────────────────────────────

    def _capabilities(self) -> Dict[str, Any]:
        """Build capabilities dict for registration, including GPU."""
        caps = {
            "hostname": platform.node() or "unknown",
            "cpu_count": self.config.cpu_count,
            "ram_gb": self.config.ram_gb,
            "max_parallel": self.config.max_parallel,
            "os": f"{platform.system()} {platform.release()}",
            "python_version": platform.python_version(),
            "worker_version": "2.1.0",
        }
        # Detect GPU
        try:
            from ..gpu_detect import detect_gpu
            gpu_model, gpu_vram_gb, cuda_available = detect_gpu()
            caps["gpu_model"] = gpu_model
            caps["gpu_vram_gb"] = gpu_vram_gb
            caps["cuda_available"] = cuda_available
        except Exception:
            pass
        # Declare what we can actually run. Three layers:
        #   1. Explicit --job-types CLI flag (operator override) wins.
        #   2. No flag + phase2/ on disk (dev/internal box) → server falls
        #      back to legacy all-7 list (preserves WSL fleet behavior).
        #   3. No flag + no phase2/ (customer Electron install) → narrow to
        #      handlers that don't import phase2. Otherwise the server
        #      dispatches ml_train/optimization/walk_forward/etc., they hit
        #      `if not BASE: return failed` in job_router._run_*, and the
        #      customer's worker fails 100% of dispatched work.
        if self.config.job_types:
            caps["supported_job_types"] = list(self.config.job_types)
        else:
            try:
                from .job_router import BASE as _base
            except Exception:
                _base = None
            if _base is None:
                caps["supported_job_types"] = ["research_backtest", "backtest"]
        return caps

    def _throughput(self) -> float:
        """Jobs per minute since start."""
        elapsed = time.time() - self.stats["started_at"]
        if elapsed < 10:
            return 0.0
        return self.stats["completed"] / (elapsed / 60.0)

    # ── Heartbeat ─────────────────────────────────────────────────────

    def _heartbeat_loop(self) -> None:
        """Background daemon thread: sends heartbeats with hardware info."""
        while not self._shutdown.is_set():
            try:
                # Include live GPU active status from adaptive tuner
                hw = {**self._gpu_info, "gpu_active": self.tuner.gpu_preferred}
                # Re-declare supported types each heartbeat so an operator
                # narrowing/widening config.job_types lands without a restart.
                sjt = list(self.config.job_types) if self.config.job_types else None
                self.client.heartbeat(
                    list(self._active_job_ids),
                    hostname=platform.node() or "unknown",
                    hardware=hw,
                    throughput_jpm=round(self._throughput(), 2),
                    supported_job_types=sjt,
                )
            except Exception as e:
                log.debug("Heartbeat error: %s", e)
            self._shutdown.wait(timeout=self.config.heartbeat_interval)

    def _start_heartbeat(self) -> None:
        """Start the heartbeat daemon thread."""
        self._heartbeat_thread = Thread(
            target=self._heartbeat_loop, daemon=True, name="heartbeat"
        )
        self._heartbeat_thread.start()

    # ── Batch Execution ───────────────────────────────────────────────

    def _prefetch_data(self, jobs: List[Dict]) -> None:
        """Download any missing OHLCV data before running backtests."""
        # Collect all (region, symbols) pairs
        region_symbols: Dict[str, List[str]] = {}
        for job in jobs:
            config = job.get("backtest_config", {})
            region = config.get("region", "us")
            symbols = job.get("symbol_universe", [])
            if region not in region_symbols:
                region_symbols[region] = []
            region_symbols[region].extend(symbols)

        # Deduplicate and fetch
        for region, syms in region_symbols.items():
            unique_syms = list(dict.fromkeys(syms))  # preserve order, dedupe
            self.fetcher.ensure_data(unique_syms, region)

    def _execute_batch(self, jobs: List[Dict]) -> List[Dict[str, Any]]:
        """Prefetch data, then run backtests in parallel via ProcessPoolExecutor."""
        # Prefetch all needed data
        self._prefetch_data(jobs)

        # Track active jobs for heartbeats
        self._active_job_ids = [j["job_id"] for j in jobs]

        results: List[Dict[str, Any]] = []
        # Ask throttle how many workers we can use right now
        max_workers = min(self.throttle.recommended_workers(), len(jobs))
        cache_dir = self.config.cache_dir

        if max_workers <= 1 or len(jobs) == 1:
            # Sequential execution
            for job in jobs:
                start = time.time()
                result = route_job(job, cache_dir)
                result["execution_time"] = round(time.time() - start, 2)
                result["worker_id"] = self.config.worker_id
                results.append(result)
            self._active_job_ids = []
            return results

        # Parallel execution
        try:
            with ProcessPoolExecutor(max_workers=max_workers, mp_context=mp.get_context("spawn")) as executor:
                future_to_job = {}
                for job in jobs:
                    fut = executor.submit(route_job, job, cache_dir)
                    future_to_job[fut] = job["job_id"]

                timeout = self.config.job_timeout * len(jobs)
                for future in as_completed(future_to_job, timeout=timeout):
                    job_id = future_to_job[future]
                    try:
                        result = future.result(timeout=self.config.job_timeout)
                        result["worker_id"] = self.config.worker_id
                        results.append(result)
                    except FuturesTimeout:
                        results.append({
                            "job_id": job_id,
                            "status": "failed",
                            "error": f"Job timed out after {self.config.job_timeout}s",
                            "worker_id": self.config.worker_id,
                        })
                    except Exception as e:
                        results.append({
                            "job_id": job_id,
                            "status": "failed",
                            "error": str(e),
                            "worker_id": self.config.worker_id,
                        })
        except Exception as e:
            log.error("Batch execution error: %s", e)
            completed_ids = {r["job_id"] for r in results}
            for job in jobs:
                if job["job_id"] not in completed_ids:
                    results.append({
                        "job_id": job["job_id"],
                        "status": "failed",
                        "error": f"Batch error: {e}",
                        "worker_id": self.config.worker_id,
                    })
        finally:
            self._active_job_ids = []

        return results

    # ── Result Reporting ──────────────────────────────────────────────

    def _report_results(self, results: List[Dict]) -> None:
        """Report completed/failed jobs back to the coordinator.

        Uses batch completion when available, falls back to per-job reporting.
        On 401 (typically a fresh API container after a deploy), re-registers
        and retries the batch once before falling back — keeps in-flight job
        results from being lost when the server restarts.
        """
        batch = []
        for result in results:
            batch.append({
                "job_id": result.get("job_id", "unknown"),
                "status": result.get("status", "completed"),
                "metrics": result.get("metrics", {}),
                "error": result.get("error", ""),
            })

        def _bump_local_stats() -> None:
            for result in results:
                if result.get("status") == "completed":
                    self.stats["completed"] += 1
                    self.stats["total_job_seconds"] += result.get("execution_time", 0)
                else:
                    self.stats["failed"] += 1

        # Try batch completion first (single network call)
        try:
            self.client.complete_batch(batch)
            _bump_local_stats()
            return
        except AttributeError:
            # complete_batch method not available on older coordinators
            pass
        except requests.exceptions.HTTPError as e:
            code = e.response.status_code if e.response is not None else 0
            if code == 401:
                # Stale auth — typical after API container restart. Re-register
                # then retry the batch once before falling back.
                log.warning(
                    "complete_batch 401 — re-registering and retrying batch once",
                )
                try:
                    resp = self.client.register(self._capabilities())
                    log.info("Re-registered (mid-batch): %s", resp.get("message", "ok"))
                    self.client.complete_batch(batch)
                    _bump_local_stats()
                    return
                except Exception as retry_err:
                    log.error(
                        "complete_batch retry after re-register failed (%s) — "
                        "falling back to per-job reporting",
                        retry_err,
                    )
            else:
                log.warning(
                    "complete_batch HTTP %d failed (%s) — falling back to per-job",
                    code, e,
                )
        except Exception as e:
            # Log the real error so we don't just see masked 401s in the fallback
            log.warning(
                "complete_batch failed (%s: %s) — falling back to per-job reporting",
                type(e).__name__, e,
            )

        # Fallback: report one at a time
        for result in results:
            job_id = result.get("job_id", "unknown")
            try:
                if result.get("status") == "completed":
                    self.client.complete(job_id, result.get("metrics", {}))
                    self.stats["completed"] += 1
                    self.stats["total_job_seconds"] += result.get("execution_time", 0)
                else:
                    self.client.fail(job_id, result.get("error", "unknown error"))
                    self.stats["failed"] += 1
            except Exception as e:
                log.error("Failed to report result for job %s: %s", job_id, e)
                self.stats["failed"] += 1

    # ── Main Loop ─────────────────────────────────────────────────────

    def run(self) -> None:
        """Main worker loop: register -> dequeue -> execute -> report -> repeat."""
        self.stats["started_at"] = time.time()

        log.info("=" * 70)
        log.info("Aura Alpha Standalone Worker starting: %s", self.config.worker_id)
        log.info(
            "Coordinator: %s | CPUs: %d | RAM: %.1fGB | Parallel: %d | Batch: %d",
            self.config.coordinator_url,
            self.config.cpu_count,
            self.config.ram_gb,
            self.config.max_parallel,
            self.config.batch_size,
        )
        log.info("Cache: %s", self.config.cache_dir)
        log.info("Adaptive throttle: ON (yields to games, apps, heavy processes)")
        log.info("=" * 70)

        # Graceful shutdown handlers
        def _signal_handler(signum, frame):
            log.info("Received signal %d, shutting down gracefully...", signum)
            self._shutdown.set()

        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)

        # Register with coordinator
        try:
            resp = self.client.register(self._capabilities())
            log.info("Registered with coordinator: %s", resp.get("message", "ok"))
        except Exception as e:
            log.error("Failed to register with coordinator: %s", e)
            log.error("Check your --token and --coordinator-url settings.")
            return

        # Start heartbeat thread
        self._start_heartbeat()

        # Main dequeue-execute loop with exponential backoff on idle
        idle_backoff = 1  # seconds
        max_backoff = 30

        while not self._shutdown.is_set():
            try:
                # Check throttle — scale batch size with available capacity
                recommended = self.throttle.recommended_workers()
                batch_count = self.config.batch_size
                if recommended < self.config.max_parallel:
                    # Throttled — pull fewer jobs proportionally
                    ratio = recommended / max(self.config.max_parallel, 1)
                    batch_count = max(1, int(self.config.batch_size * ratio))

                    # If heavily throttled (<25% capacity), add a cooldown
                    if ratio <= 0.25:
                        self._shutdown.wait(timeout=5)
                        if self._shutdown.is_set():
                            break

                # Dequeue a batch
                jobs = self.client.dequeue(
                    count=batch_count,
                    job_types=self.config.job_types or None,
                )

                if not jobs:
                    # No work available — back off
                    log.debug("No jobs available, sleeping %ds", idle_backoff)
                    self._shutdown.wait(timeout=idle_backoff)
                    idle_backoff = min(idle_backoff * 2, max_backoff)
                    continue

                # Reset backoff on successful dequeue
                idle_backoff = 1
                throttle_tag = f" [throttled {recommended}/{self.config.max_parallel}]" if self.throttle.is_throttled else ""
                log.info("Dequeued %d jobs%s", len(jobs), throttle_tag)

                # Execute batch
                batch_start = time.time()
                results = self._execute_batch(jobs)
                exec_elapsed = time.time() - batch_start

                # Report results
                report_start = time.time()
                self._report_results(results)
                report_elapsed = time.time() - report_start

                completed = sum(1 for r in results if r.get("status") == "completed")
                failed = len(results) - completed
                batch_elapsed = exec_elapsed + report_elapsed
                log.info(
                    "Batch done: %d completed, %d failed in %.1fs (%.1f jobs/min total)%s",
                    completed, failed, batch_elapsed, self._throughput(), throttle_tag,
                )

                # Auto-tune: record timing and adjust parameters
                self.tuner.record_batch(
                    jobs_count=len(jobs),
                    exec_seconds=exec_elapsed,
                    report_seconds=report_elapsed,
                    dequeue_seconds=0.0,  # measured in dequeue call
                )
                tuned = self.tuner.tune()
                # Apply tuned max_parallel only — keep batch_size locked at startup value
                self.throttle.max_parallel = tuned["max_parallel"]

            except KeyboardInterrupt:
                log.info("Worker interrupted.")
                break
            except requests.exceptions.HTTPError as e:
                code = e.response.status_code if e.response is not None else 0
                if code == 401:
                    log.warning("Auth rejected (401) — re-registering with coordinator...")
                    try:
                        resp = self.client.register(self._capabilities())
                        log.info("Re-registered: %s", resp.get("message", "ok"))
                    except Exception as re_err:
                        log.error("Re-registration failed: %s — retrying in 30s", re_err)
                        self._shutdown.wait(timeout=30)
                else:
                    log.error("HTTP error %d: %s", code, e)
                    self._shutdown.wait(timeout=10)
            except Exception as e:
                log.error("Worker loop error: %s", e)
                log.debug(traceback.format_exc())
                self._shutdown.wait(timeout=5)

        # Shutdown
        self._shutdown.set()
        log.info("=" * 70)
        log.info(
            "Worker %s stopped. Completed: %d | Failed: %d | Throughput: %.1f/min",
            self.config.worker_id,
            self.stats["completed"],
            self.stats["failed"],
            self._throughput(),
        )
        log.info("=" * 70)
