"""Coordinator URL probe-and-fallback for the standalone Compute Contributor Pack.

Mirrors network-config.js (commit 912c2d5) so a worker on a network that
intercepts auraalpha.cc (Xfinity xFi, Norton Family, Eero Secure, SafeDNS,
NextDNS family, corporate filters) can transparently route to a backup
hostname or the direct EC2 IP instead of dying with SSLError: wrong version
number.

Resolve order:
  1. Explicit override (--coordinator-url, COORDINATOR_URL,
     AURA_COORDINATOR_URL) — single URL, no probe, user takes the win.
  2. customServerUrl from ~/.aura-worker/network-settings.json — same.
  3. lastWorkingUrl from settings — probe first, fall through if it stopped
     working.
  4. PRIMARY_URL https://auraalpha.cc
  5. BACKUP_URLS (Tailscale magicDNS — no-op for non-tailnet, harmless)
  6. DIRECT_IP_URL http://54.172.235.137:8020 (last resort, exposes EC2 IP)

First URL that returns 2xx on /api/health within `timeout` seconds wins. The
result is cached back to settings so the next launch doesn't re-probe from
scratch.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

log = logging.getLogger("grid-worker.network")

PRIMARY_URL = "https://auraalpha.cc"
BACKUP_URLS = (
    "http://prodesk-ec2.tail62e000.ts.net:8020",
)
DIRECT_IP_URL = "http://54.172.235.137:8020"
PROBE_TIMEOUT = 8.0


def _settings_path() -> Path:
    return Path(os.getenv("AURA_WORKER_CACHE", str(Path.home() / ".aura-worker"))) / "network-settings.json"


def _load_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text())
    except (OSError, ValueError):
        return {}


def _save_settings(settings: dict) -> None:
    p = _settings_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(settings, indent=2))
    except OSError as e:
        log.debug("Could not persist network-settings.json: %s", e)


def _probe(url: str, timeout: float = PROBE_TIMEOUT) -> bool:
    """GET <url>/api/health. True iff HTTP status is 2xx within timeout."""
    probe_url = url.rstrip("/") + "/api/health"
    req = urllib.request.Request(
        probe_url,
        headers={"User-Agent": "aura-grid-worker/probe"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ok = 200 <= resp.status < 300
            log.debug("Probe %s -> %d in %.2fs", probe_url, resp.status, time.time() - t0)
            return ok
    except urllib.error.HTTPError as e:
        log.debug("Probe %s -> HTTP %d", probe_url, e.code)
        return False
    except Exception as e:
        log.debug("Probe %s failed in %.2fs: %s", probe_url, time.time() - t0, e)
        return False


def resolve_coordinator_url(
    cli_override: Optional[str] = None,
    *,
    skip_probe: bool = False,
) -> tuple[str, str]:
    """Pick a working coordinator URL. Returns (url, source) where source is
    one of: "cli", "env", "custom", "cached", "primary", "backup", "direct",
    "fallback" (last-resort PRIMARY_URL even if probe failed).

    If `skip_probe` is True, returns the first override-style URL found
    without testing it. Used by --diagnose so we don't double-probe.
    """
    # 1. Explicit override
    override = (cli_override
                or os.getenv("COORDINATOR_URL")
                or os.getenv("AURA_COORDINATOR_URL"))
    if override:
        return override.rstrip("/"), "cli" if cli_override else "env"

    settings = _load_settings()

    # 2. Custom server URL (Settings UI persists this)
    custom = settings.get("customServerUrl") or ""
    if custom:
        return custom.rstrip("/"), "custom"

    if skip_probe:
        return PRIMARY_URL, "primary"

    # 3. Last-working URL — probe first, fall through if it stopped working
    last_good = settings.get("lastWorkingUrl") or ""
    candidates: list[tuple[str, str]] = []
    if last_good:
        candidates.append((last_good.rstrip("/"), "cached"))

    # 4-6. Standard chain
    candidates.append((PRIMARY_URL, "primary"))
    for u in BACKUP_URLS:
        candidates.append((u, "backup"))
    candidates.append((DIRECT_IP_URL, "direct"))

    # Dedup while preserving order
    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for url, src in candidates:
        if url not in seen:
            seen.add(url)
            deduped.append((url, src))

    for url, src in deduped:
        if _probe(url):
            log.info("Coordinator URL: %s (%s)", url, src)
            settings["lastWorkingUrl"] = url
            settings["lastProbeAt"] = int(time.time())
            _save_settings(settings)
            return url, src

    # All probes failed. Mark and return PRIMARY_URL so the worker can still
    # try (the network may be flaky, not blocked).
    log.warning("All coordinator URL probes failed — falling back to %s", PRIMARY_URL)
    settings["blockDetectedAt"] = int(time.time())
    _save_settings(settings)
    return PRIMARY_URL, "fallback"
