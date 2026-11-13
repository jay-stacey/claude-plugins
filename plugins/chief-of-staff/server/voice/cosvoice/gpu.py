"""CUDA helpers: DLL paths for faster-whisper and free video memory.

Order matters (spike RECIPE.md, known problem 2): import torch before faster-whisper loads,
so torch's cuDNN is in the process first. prepare_cuda() does both steps.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

LOG = logging.getLogger("cosvoice")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_registered = False


def register_cuda_dlls() -> None:
    """ctranslate2 needs the cuBLAS 12 and cuDNN 9 DLLs from the nvidia-* pip packages.
    Ported from Pepper stt.py _register_cuda_dlls."""
    global _registered
    if _registered or sys.platform != "win32":
        return
    _registered = True
    for sp in sys.path:
        nvidia = Path(sp) / "nvidia"
        if not nvidia.is_dir():
            continue
        for sub in ("cublas", "cudnn"):
            b = nvidia / sub / "bin"
            if b.is_dir():
                try:
                    os.add_dll_directory(str(b))
                    os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")
                except OSError:
                    pass


def prepare_cuda(device: str) -> bool:
    """Import torch first, then register the DLLs. Returns True when CUDA can be used."""
    if device == "cpu":
        return False
    try:
        import torch  # noqa: F401  (must load before faster-whisper)
    except Exception as e:  # torch missing or broken: CPU only
        LOG.warning("torch import failed (%s); using the CPU", e)
        return False
    register_cuda_dlls()
    try:
        ok = bool(torch.cuda.is_available())
    except Exception:
        ok = False
    if not ok and device == "cuda":
        LOG.warning("CUDA was asked for but torch.cuda.is_available() is False")
    return ok


def nvidia_smi(query: str) -> int | None:
    try:
        r = subprocess.run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=5, creationflags=NO_WINDOW)
        return int(r.stdout.strip().splitlines()[0])
    except Exception:
        return None


def free_vram_mib() -> int | None:
    """Free video memory of GPU 0 in MiB. nvidia-smi first (no CUDA context), then torch."""
    v = nvidia_smi("memory.free")
    if v is not None:
        return v
    try:
        import torch

        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return int(free / 2**20)
    except Exception:
        pass
    return None


def used_vram_mib() -> int | None:
    return nvidia_smi("memory.used")


def process_vram_mib() -> int | None:
    """This process's video memory, from nvidia-smi compute apps (None when unknown)."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=5, creationflags=NO_WINDOW)
        for line in r.stdout.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2 and parts[0] == str(os.getpid()):
                return int(parts[1])
    except Exception:
        pass
    return None
