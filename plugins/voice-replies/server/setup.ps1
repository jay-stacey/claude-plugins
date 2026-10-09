# Sets up the local Kokoro voice server for the voice-replies plugin.
#
# Creates a Python virtual environment, installs PyTorch with CUDA and Kokoro, and copies
# server.py next to it. Downloads about 3 GB on the first run (PyTorch 2.6 GB, Kokoro model
# 350 MB on the first start). Run it again after updating the plugin to copy the new server.py.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Cuda cpu    # no NVIDIA GPU

param(
    [string]$Target = "$env:USERPROFILE\.claude\voice-replies",
    [string]$Cuda = "cu126"
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    Write-Host "==> $What"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force $Target | Out-Null
$python = Join-Path $Target 'venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    # Kokoro supports Python 3.10 to 3.12.
    $made = $false
    foreach ($version in '3.11', '3.12', '3.10') {
        & py "-$version" -m venv (Join-Path $Target 'venv') 2>$null
        if ($LASTEXITCODE -eq 0) { $made = $true; break }
    }
    if (-not $made) { throw 'Python 3.10, 3.11 or 3.12 is needed (py launcher). Install one and run this again.' }
}

Invoke-Checked 'Upgrading pip' { & $python -m pip install --upgrade pip }
Invoke-Checked "Installing PyTorch ($Cuda)" { & $python -m pip install torch --index-url "https://download.pytorch.org/whl/$Cuda" }
Invoke-Checked 'Installing Kokoro' { & $python -m pip install kokoro soundfile sounddevice }

Copy-Item (Join-Path $PSScriptRoot 'server.py') (Join-Path $Target 'server.py') -Force
Invoke-Checked 'Checking the GPU' { & $python -c "import torch; print('CUDA available:', torch.cuda.is_available())" }

Write-Host "Done. The voice-replies plugin starts the server from $Target on its own."
