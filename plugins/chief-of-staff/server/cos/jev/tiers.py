"""Picks Jev's tier from a machine scan (server/jev-scan.ps1), following the baseline
spec table in issue 33. Standard library only.

    local-gpu      NVIDIA, compute 5.0+, driver 550+, 2 GB VRAM free after the voice,
                   16 GB RAM, 5 GB disk, x64 with AVX2               -> qwen3.5-2b
    local-cpu      x64 with AVX2, 6+ cores, 16 GB total, 4 GB free, 5 GB disk -> qwen3.5-0.8b
    local-cpu-min  x64 with AVX2, 4-5 cores or 8-16 GB total, 2.5 GB free, 3 GB disk
                                                                    -> qwen3.5-0.8b, with a warning
    hosted         everything else; reasons say why

Two more rules: the model plus its working memory must fit in 60% of the free memory it
runs in (else one size down), and on battery the model drops one size. An integrated GPU
counts as no GPU. The live test in jev_setup.py has the final say.
"""

SMALL = "qwen3.5-0.8b"
LARGE = "qwen3.5-2b"
# Memory a model needs, working memory included, in MiB.
NEED_MIB = {SMALL: 1024, LARGE: 2048}
SMALLER = {LARGE: SMALL}
FIT_SHARE = 0.6

# A "16 GB" machine shows a little less than 16384 MiB once the firmware and the
# graphics take their share, so the gates allow for that.
GB16_MIB = 15000
GB8_MIB = 7400
FREE_CPU_MIB = 4096
FREE_MIN_MIB = 2560
DISK_FULL_MIB = 5120
DISK_MIN_MIB = 3072
GPU_FREE_MIB = 2048
MIN_COMPUTE = 5.0
MIN_DRIVER = 550


def _num(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _gb(mib):
    return f"{mib / 1024:.1f}".rstrip("0").rstrip(".") + " GB"


def _fits(model, free_mib):
    return free_mib is not None and NEED_MIB[model] <= FIT_SHARE * free_mib


def _gpu_check(scan, voice_vram_mib):
    """(gpu, problems): the best NVIDIA card and why it cannot run Jev ([] when it can)."""
    cards = [g for g in (scan.get("gpus") or []) if isinstance(g, dict)
             and g.get("vendor") == "nvidia" and not g.get("integrated")]
    if not cards:
        return None, ["No NVIDIA graphics card was found."]
    gpu = max(cards, key=lambda g: _num(g.get("freeVramMb")) or _num(g.get("vramMb")) or 0)
    problems = []
    cap = _num(gpu.get("computeCap"))
    if cap is None:
        problems.append("The graphics card's compute level could not be read.")
    elif cap < MIN_COMPUTE:
        problems.append(f"The graphics card's compute level {cap:g} is below {MIN_COMPUTE:g}.")
    driver = str(gpu.get("driver") or "")
    major = _num(driver.split(".")[0]) if driver else None
    if major is None:
        problems.append("The NVIDIA driver version could not be read.")
    elif major < MIN_DRIVER:
        problems.append(f"The NVIDIA driver {driver} is older than {MIN_DRIVER}.")
    free = _num(gpu.get("freeVramMb"))
    if free is None:
        problems.append("Free video memory could not be read.")
    else:
        left = free - max(0, voice_vram_mib or 0)
        if left < GPU_FREE_MIB:
            problems.append(f"Only {_gb(max(0, left))} of video memory is free after the voice, and Jev needs 2 GB.")
    return gpu, problems


def _hosted(reasons, warnings=None):
    return {"tier": "hosted", "model": None, "reasons": reasons, "warnings": warnings or []}


def _finish(tier, model, free_mib, reasons, warnings, on_battery):
    """Applies the 60% fit rule and the battery rule."""
    while not _fits(model, free_mib):
        smaller = SMALLER.get(model)
        if not smaller:
            return _hosted(reasons + [f"The model needs {_gb(NEED_MIB[model])} and that is more than 60% of the free memory."],
                           warnings)
        warnings.append(f"The larger model does not fit in 60% of the free memory, so Jev uses {smaller}.")
        model = smaller
    if on_battery:
        smaller = SMALLER.get(model)
        if smaller:
            warnings.append(f"This machine is on battery, so Jev uses the smaller {smaller}.")
            model = smaller
        else:
            warnings.append("This machine is on battery, so Jev may be slower until it is plugged in.")
    return {"tier": tier, "model": model, "reasons": reasons, "warnings": warnings}


def pick(scan: dict, voice_vram_mib: int = 0) -> dict:
    """{"tier", "model", "reasons", "warnings"} for a jev-scan.ps1 result."""
    if not isinstance(scan, dict):
        return _hosted(["The machine scan gave no result."])
    cpu = scan.get("cpu") if isinstance(scan.get("cpu"), dict) else {}
    arch = scan.get("arch")
    avx2 = cpu.get("avx2")
    cores = _num(cpu.get("cores"))
    total = _num(scan.get("ramTotalMb"))
    free = _num(scan.get("ramFreeMb"))
    disk = _num(scan.get("diskFreeMb"))
    on_battery = scan.get("onBattery") is True

    blockers = []
    if arch is None:
        blockers.append("The processor type could not be read.")
    elif arch != "x64":
        blockers.append(f"The processor is {arch}, and the local model needs an x64 processor.")
    if avx2 is None:
        blockers.append("Could not check the processor for AVX2.")
    elif avx2 is not True:
        blockers.append("The processor has no AVX2, which the local model needs.")
    if cores is None:
        blockers.append("The number of processor cores could not be read.")
    if total is None or free is None:
        blockers.append("The amount of memory could not be read.")
    if disk is None:
        blockers.append("The free disk space could not be read.")
    if blockers:
        return _hosted(blockers)

    gpu, gpu_problems = _gpu_check(scan, voice_vram_mib)
    if not gpu_problems and total >= GB16_MIB and disk >= DISK_FULL_MIB:
        left = _num(gpu.get("freeVramMb")) - max(0, voice_vram_mib or 0)
        reasons = [f"{gpu.get('name') or 'The NVIDIA card'} has {_gb(left)} of video memory free after the voice."]
        return _finish("local-gpu", LARGE, left, reasons, [], on_battery)

    notes = []
    if gpu is not None and gpu_problems:
        notes.append(f"{gpu.get('name') or 'The NVIDIA card'} is not used: {gpu_problems[0]}")
    elif gpu is not None:
        notes.append(f"{gpu.get('name') or 'The NVIDIA card'} is not used because the machine is below the GPU tier.")

    if cores >= 6 and total >= GB16_MIB and free >= FREE_CPU_MIB and disk >= DISK_FULL_MIB:
        reasons = notes + [f"The processor has {int(cores)} cores and AVX2, with {_gb(free)} of memory free."]
        return _finish("local-cpu", SMALL, free, reasons, [], on_battery)

    if cores >= 4 and total >= GB8_MIB and free >= FREE_MIN_MIB and disk >= DISK_MIN_MIB:
        reasons = notes + [f"The processor has {int(cores)} cores and AVX2, with {_gb(free)} of memory free."]
        why = []
        if cores < 6:
            why.append(f"{int(cores)} cores")
        if total < GB16_MIB:
            why.append(f"{_gb(total)} of memory")
        if free < FREE_CPU_MIB:
            why.append(f"{_gb(free)} free")
        if disk < DISK_FULL_MIB:
            why.append(f"{_gb(disk)} of free disk")
        warnings = [f"This machine is at the minimum for the local model ({', '.join(why)}), so Jev may be slow."]
        return _finish("local-cpu-min", SMALL, free, reasons, warnings, on_battery)

    reasons = []
    if cores < 4:
        reasons.append(f"The processor has {int(cores)} cores, and the local model needs at least 4.")
    if total < GB8_MIB:
        reasons.append(f"The machine has {_gb(total)} of memory, and the local model needs at least 8 GB.")
    if free < FREE_MIN_MIB:
        reasons.append(f"Only {_gb(free)} of memory is free, and the local model needs 2.5 GB.")
    if disk < DISK_MIN_MIB:
        reasons.append(f"Only {_gb(disk)} of disk is free, and the local model needs 3 GB.")
    if not reasons:
        reasons.append("The machine is below the local model baseline.")
    return _hosted(reasons)
