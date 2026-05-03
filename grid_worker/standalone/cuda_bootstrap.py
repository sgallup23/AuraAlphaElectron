"""
First-run CUDA PyTorch bootstrap for the standalone grid worker.

On launch, if an NVIDIA GPU is detected but a CUDA-enabled torch isn't already
installed, fetch the right wheel from download.pytorch.org automatically.
CPU-only hosts and hosts that already have CUDA torch skip silently.

Modelled on Ollama / ComfyUI / LM Studio: users shouldn't have to pick a CUDA
version or run pip themselves.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("standalone.cuda_bootstrap")

DEFAULT_INDEX_URL = "https://download.pytorch.org/whl/cu124"


def _has_cuda_torch() -> bool:
    try:
        import torch
    except ImportError:
        return False
    try:
        return bool(getattr(torch.version, "cuda", None))
    except Exception:
        return False


def _has_nvidia_gpu() -> bool:
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and "GPU" in result.stdout:
            return True
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    if Path("/dev/dxg").exists():
        try:
            result = subprocess.run(
                ["nvidia-smi", "-L"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and "GPU" in result.stdout:
                return True
        except (FileNotFoundError, subprocess.SubprocessError):
            pass
    return False


def ensure_cuda_torch(skip: bool = False) -> None:
    """Install CUDA PyTorch on first run if an NVIDIA GPU is present.

    Silent no-op when:
      - skip=True or AURA_SKIP_CUDA_BOOTSTRAP=1
      - CUDA torch already importable
      - no NVIDIA GPU detected
    """
    if skip or os.environ.get("AURA_SKIP_CUDA_BOOTSTRAP") == "1":
        return
    if _has_cuda_torch():
        return
    if not _has_nvidia_gpu():
        return

    index_url = os.environ.get("AURA_TORCH_INDEX_URL", DEFAULT_INDEX_URL)
    print(
        f"[aura-worker] NVIDIA GPU detected — fetching CUDA PyTorch from {index_url}",
        file=sys.stderr, flush=True,
    )
    print(
        "[aura-worker] One-time download, ~2.5 GB. Use --skip-cuda-bootstrap to disable.",
        file=sys.stderr, flush=True,
    )
    cmd = [
        sys.executable, "-m", "pip", "install", "--upgrade",
        "torch", "--index-url", index_url,
    ]
    try:
        subprocess.run(cmd, check=True)
    except KeyboardInterrupt:
        print("[aura-worker] CUDA torch install cancelled — worker will run CPU-only.",
              file=sys.stderr, flush=True)
        return
    except subprocess.CalledProcessError as e:
        log.warning("CUDA torch install failed (exit %s) — worker will run CPU-only", e.returncode)
        return
    except FileNotFoundError:
        log.warning("pip not found — worker will run CPU-only")
        return

    if _has_cuda_torch():
        print("[aura-worker] CUDA PyTorch ready.", file=sys.stderr, flush=True)
    else:
        log.warning("CUDA torch install completed but torch.version.cuda still empty")
