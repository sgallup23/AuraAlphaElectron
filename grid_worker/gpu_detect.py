"""
GPU Detection Utility
======================
Run on worker nodes to detect GPU capabilities for registration.
Tries PyTorch → nvidia-smi → WSL2 /dev/dxg → ROCm in order.

Usage:
    from distributed_research.gpu_detect import detect_gpu
    gpu_model, gpu_vram_gb, cuda_available = detect_gpu()
"""

import logging
import subprocess
from pathlib import Path

log = logging.getLogger("gpu-detect")


def detect_gpu() -> tuple[str, float, bool]:
    """Detect GPU model, VRAM (GB), and CUDA availability.
    Returns (gpu_model, gpu_vram_gb, cuda_available).
    """
    gpu_model, gpu_vram_gb, cuda_available = "", 0.0, False

    # Method 1: PyTorch (most reliable if installed)
    try:
        import torch
        if torch.cuda.is_available():
            cuda_available = True
            gpu_model = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            total_mem = getattr(props, 'total_memory', None) or getattr(props, 'total_mem', 0)
            gpu_vram_gb = round(total_mem / (1024 ** 3), 1)
            log.info("GPU detected via PyTorch: %s (%.1f GB)", gpu_model, gpu_vram_gb)
            return gpu_model, gpu_vram_gb, cuda_available
    except ImportError:
        pass
    except Exception as e:
        log.debug("PyTorch GPU detection failed: %s", e)

    # Method 2: nvidia-smi (works without PyTorch)
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split("\n")
            parts = lines[0].split(",")
            gpu_model = parts[0].strip()
            gpu_vram_gb = round(float(parts[1].strip()) / 1024, 1)  # MiB → GiB
            cuda_available = True
            log.info("GPU detected via nvidia-smi: %s (%.1f GB)", gpu_model, gpu_vram_gb)
            return gpu_model, gpu_vram_gb, cuda_available
    except FileNotFoundError:
        pass  # nvidia-smi not installed
    except Exception as e:
        log.debug("nvidia-smi GPU detection failed: %s", e)

    # Method 3: WSL2 GPU passthrough (/dev/dxg exists)
    if Path("/dev/dxg").exists():
        cuda_available = True
        gpu_model = "WSL2 GPU (passthrough)"
        # Try to get model name via nvidia-smi in WSL
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split("\n")[0].split(",")
                gpu_model = parts[0].strip()
                gpu_vram_gb = round(float(parts[1].strip()) / 1024, 1)
        except Exception:
            pass
        log.info("GPU detected via WSL2: %s (%.1f GB)", gpu_model, gpu_vram_gb)
        return gpu_model, gpu_vram_gb, cuda_available

    # Method 4: AMD ROCm
    try:
        result = subprocess.run(
            ["rocm-smi", "--showproductname", "--csv"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split("\n")[1:]:
                if line.strip():
                    gpu_model = line.strip().split(",")[0] if "," in line else line.strip()
                    cuda_available = False  # ROCm, not CUDA
                    break
            # Get VRAM
            vram_result = subprocess.run(
                ["rocm-smi", "--showmeminfo", "vram", "--csv"],
                capture_output=True, text=True, timeout=5,
            )
            if vram_result.returncode == 0:
                for line in vram_result.stdout.strip().split("\n")[1:]:
                    parts = line.split(",")
                    if len(parts) >= 2:
                        try:
                            gpu_vram_gb = round(float(parts[1].strip()) / (1024 ** 3), 1)
                        except ValueError:
                            pass
                        break
            log.info("GPU detected via ROCm: %s (%.1f GB)", gpu_model, gpu_vram_gb)
            return gpu_model, gpu_vram_gb, cuda_available
    except FileNotFoundError:
        pass
    except Exception as e:
        log.debug("ROCm GPU detection failed: %s", e)

    log.info("No GPU detected")
    return gpu_model, gpu_vram_gb, cuda_available


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    model, vram, cuda = detect_gpu()
    print(f"GPU Model:  {model or 'None'}")
    print(f"VRAM:       {vram} GB")
    print(f"CUDA:       {cuda}")
