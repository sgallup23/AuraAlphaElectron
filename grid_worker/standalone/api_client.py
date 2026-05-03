"""
HTTP client for the coordinator API at /api/cluster/contributor/*.
All calls include contributor token and worker ID headers.
Retry logic with exponential backoff.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger("standalone.api_client")

# Retry settings
MAX_RETRIES = 5
BACKOFF_BASE = 2  # seconds: 2, 4, 8, 16, 32


class CoordinatorClient:
    """Thin HTTP wrapper around the coordinator contributor API."""

    def __init__(self, coordinator_url: str, token: str, worker_id: str):
        self.base_url = coordinator_url.rstrip("/")
        self.token = token
        self.worker_id = worker_id
        self.session = requests.Session()
        self.session.headers.update({
            "X-Contributor-Token": self.token,
            "X-Worker-Id": self.worker_id,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; AuraAlpha-GridWorker/2.0)",
        })
        # Reasonable timeouts: (connect, read)
        self.timeout = (10, 60)

    # ── Internal helpers ───────────────────────────────────────────────

    def _url(self, path: str) -> str:
        return f"{self.base_url}/api/cluster/contributor/{path.lstrip('/')}"

    def _request(
        self,
        method: str,
        path: str,
        json: Optional[Dict] = None,
        params: Optional[Dict] = None,
        stream: bool = False,
        timeout: Optional[tuple] = None,
    ) -> requests.Response:
        """Make an HTTP request with retry logic and exponential backoff."""
        url = self._url(path)
        last_exc: Optional[Exception] = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = self.session.request(
                    method=method,
                    url=url,
                    json=json,
                    params=params,
                    stream=stream,
                    timeout=timeout or self.timeout,
                )
                resp.raise_for_status()
                return resp
            except requests.exceptions.HTTPError as e:
                # Retry on 429 (rate limit), 502/503/504 (server overloaded)
                # Don't retry on other 4xx client errors
                if e.response is not None:
                    code = e.response.status_code
                    if code in (429, 502, 503, 504):
                        last_exc = e  # will retry
                    elif 400 <= code < 500:
                        raise  # client error, don't retry
                    else:
                        last_exc = e
                else:
                    last_exc = e
            except (requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout,
                    requests.exceptions.ChunkedEncodingError) as e:
                last_exc = e

            # Exponential backoff
            if attempt < MAX_RETRIES - 1:
                wait = BACKOFF_BASE * (2 ** attempt)
                log.warning(
                    "Request %s %s failed (attempt %d/%d), retrying in %ds: %s",
                    method, path, attempt + 1, MAX_RETRIES, wait, last_exc,
                )
                time.sleep(wait)

        raise ConnectionError(
            f"Failed after {MAX_RETRIES} retries: {method} {path} — {last_exc}"
        )

    # ── Public API methods ─────────────────────────────────────────────

    def ping(self) -> Dict[str, Any]:
        """Simple connectivity check."""
        resp = self._request("GET", "ping")
        return resp.json()

    def register(self, capabilities: Dict[str, Any]) -> Dict[str, Any]:
        """Register this worker with the coordinator, including GPU info."""
        body: Dict[str, Any] = {
            "hostname": capabilities.get("hostname", self.worker_id),
            "cpus": capabilities.get("cpu_count", capabilities.get("cpus", 1)),
            "ram_gb": capabilities.get("ram_gb", 0),
            "os": capabilities.get("os", "unknown"),
            "max_parallel": capabilities.get("max_parallel", 1),
            "gpu_model": capabilities.get("gpu_model", ""),
            "gpu_vram_gb": capabilities.get("gpu_vram_gb", 0),
            "cuda_available": capabilities.get("cuda_available", False),
        }
        sjt = capabilities.get("supported_job_types")
        if sjt is not None:
            body["supported_job_types"] = list(sjt)
        resp = self._request("POST", "register", json=body)
        return resp.json()

    def dequeue(
        self,
        count: int = 5,
        job_types: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Request a batch of jobs from the coordinator.

        Args:
            count: Maximum number of jobs to claim.
            job_types: If provided, server filters dequeue to these job_types
                only. Lets the worker avoid wasting cycles on jobs it would
                immediately skip (e.g. ml_train under STANDALONE_MODE).

        Returns list of job dicts, possibly empty if no work available.
        """
        body: Dict[str, Any] = {
            "worker_id": self.worker_id,
            "count": count,
        }
        if job_types:
            body["job_types"] = list(job_types)
        resp = self._request("POST", "dequeue", json=body)
        data = resp.json()
        return data.get("jobs", [])

    def complete(self, job_id: str, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Report a successfully completed job."""
        resp = self._request("POST", "complete", json={
            "job_id": job_id,
            "metrics": metrics,
        })
        return resp.json()

    def fail(self, job_id: str, error: str) -> Dict[str, Any]:
        """Report a failed job."""
        resp = self._request("POST", "fail", json={
            "job_id": job_id,
            "error": error,
        })
        return resp.json()

    def complete_batch(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Report multiple completed/failed jobs in a single request."""
        resp = self._request("POST", "complete_batch", json={
            "results": results,
        })
        return resp.json()

    def heartbeat(
        self,
        job_ids: List[str],
        hostname: str = "",
        hardware: Optional[Dict[str, Any]] = None,
        throughput_jpm: Optional[float] = None,
        supported_job_types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Send heartbeat with hardware info to extend leases and update registration."""
        payload: Dict[str, Any] = {
            "worker_id": self.worker_id,
            "job_ids": job_ids,
        }
        if hostname:
            payload["hostname"] = hostname
        if hardware:
            payload["cpu_cores"] = hardware.get("cpu_cores")
            payload["memory_gb"] = hardware.get("memory_gb")
            payload["gpu_model"] = hardware.get("gpu_model")
            payload["gpu_vram_gb"] = hardware.get("gpu_vram_gb")
            payload["cuda_available"] = hardware.get("cuda_available")
            payload["gpu_active"] = hardware.get("gpu_active", False)
        if throughput_jpm is not None:
            payload["throughput_jpm"] = throughput_jpm
        if supported_job_types is not None:
            payload["supported_job_types"] = list(supported_job_types)
        resp = self._request("POST", "heartbeat", json=payload)
        return resp.json()

    def download_data(self, region: str, symbol: str, dest_path: Path) -> bool:
        """Download a parquet file from the coordinator.

        Streams the response to dest_path. Returns True on success.
        """
        try:
            resp = self._request(
                "GET",
                f"data/{region}/{symbol}",
                stream=True,
                timeout=(10, 300),  # longer read timeout for data downloads
            )
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            with open(dest_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
            return True
        except Exception as e:
            log.warning("Failed to download %s/%s: %s", region, symbol, e)
            return False

    def get_stats(self) -> Dict[str, Any]:
        """Get cluster/worker stats from the coordinator."""
        resp = self._request("GET", "stats")
        return resp.json()
