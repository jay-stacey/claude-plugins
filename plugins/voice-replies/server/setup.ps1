# Installs the local Kokoro voice server for the voice-replies plugin.
#
# Checks the machine first, then picks where Kokoro runs:
#   - the GPU, when there is an NVIDIA card with enough memory, a new enough driver and a
#     compute capability PyTorch still builds for;
#   - the CPU otherwise (AMD and Intel graphics, old or small NVIDIA cards, no GPU).
# After installing it proves the choice by speaking a test phrase into memory. If the GPU
# fails that test it switches to the CPU on its own.
#
# Everything goes into %USERPROFILE%\.claude\voice-replies. It needs no admin rights and no
# Python of your own: uv (a small Python installer) fetches Python 3.12 into that folder.
# First run downloads about 3 GB on the GPU path, or about 700 MB on the CPU path.
# Safe to run again: it skips what is already in place and copies the newest server.py.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1                 # pick for me
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Device cpu     # force the CPU
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Device gpu     # force the GPU
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -CheckOnly      # report, install nothing

param(
    [ValidateSet('auto', 'gpu', 'cpu')]
    [string]$Device = 'auto',
    [string]$Target = "$env:USERPROFILE\.claude\voice-replies",
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with the bar

# Kokoro-82M needs about 1 GB of video memory; 2 GB leaves room for the desktop.
$MinVramMiB = 2048
# CUDA 12.6 wheels cover compute capability 5.0 to 9.0. Blackwell (10.0 and up) needs CUDA 12.8.
$MinComputeCap = [version]'5.0'
$Blackwell = [version]'10.0'
# Lowest Windows driver for each CUDA build (CUDA 12.x minor-version compatibility).
$MinDriver = @{ cu126 = [version]'528.33'; cu128 = [version]'570.65' }

function Step([string]$What) { Write-Host "==> $What" }

# Runs a native command and shows its output. Windows PowerShell turns a native program's
# stderr into errors, which 'Stop' would make fatal, so this relies on the exit code instead.
function Invoke-Native([scriptblock]$Command) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command 2>&1 | ForEach-Object { Write-Host "    $_" } }
    finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

# Runs a native command and returns its stdout, or $null when it fails.
function Read-Native([scriptblock]$Command) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $Command 2>$null } catch { return $null }
    finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0) { return $null }
    return $out
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    Step $What
    $code = Invoke-Native $Command
    if ($code -ne 0) { throw "$What failed (exit $code)" }
}

# --- 1. Look at the machine -------------------------------------------------------------

function Find-NvidiaSmi {
    $onPath = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($path in "$env:WINDIR\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe") {
        if (Test-Path $path) { return $path }
    }
    return $null
}

# Returns the NVIDIA card with the most memory, or $null.
function Get-NvidiaGpu {
    $smi = Find-NvidiaSmi
    if (-not $smi) { return $null }
    $rows = Read-Native { & $smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader,nounits }
    if (-not $rows) { return $null }
    $gpus = foreach ($row in @($rows)) {
        $f = "$row" -split ',\s*'
        if ($f.Count -lt 4) { continue }
        try {
            [pscustomobject]@{
                Name       = $f[0].Trim()
                VramMiB    = [int]$f[1]
                ComputeCap = [version]$f[2].Trim()
                Driver     = [version]$f[3].Trim()
                DriverText = $f[3].Trim()
            }
        } catch { continue }
    }
    return $gpus | Sort-Object VramMiB -Descending | Select-Object -First 1
}

function New-Choice([string]$DeviceName, [string]$Build, [string]$Reason, $Gpu) {
    return [pscustomobject]@{ Device = $DeviceName; Build = $Build; Reason = $Reason; Gpu = $Gpu }
}

# Decides cuda or cpu and the PyTorch build.
function Select-Device {
    $graphics = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', '
    $gpu = Get-NvidiaGpu

    if ($Device -eq 'cpu') { return New-Choice 'cpu' 'cpu' 'you asked for the CPU' $gpu }
    if (-not $gpu) {
        $why = if ($graphics) { "no NVIDIA GPU found (graphics: $graphics)" } else { 'no NVIDIA GPU found' }
        if ($Device -eq 'gpu') { throw "You asked for the GPU, but $why. Kokoro on the GPU needs an NVIDIA card." }
        return New-Choice 'cpu' 'cpu' $why $null
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        return New-Choice 'cpu' 'cpu' 'PyTorch has no CUDA build for Windows on ARM' $gpu
    }

    $build = if ($gpu.ComputeCap -ge $Blackwell) { 'cu128' } else { 'cu126' }
    $problems = @()
    if ($gpu.ComputeCap -lt $MinComputeCap) { $problems += "compute capability $($gpu.ComputeCap) is below $MinComputeCap" }
    if ($gpu.VramMiB -lt $MinVramMiB) { $problems += "$($gpu.VramMiB) MiB of video memory is below $MinVramMiB MiB" }
    if ($gpu.Driver -lt $MinDriver[$build]) { $problems += "driver $($gpu.DriverText) is older than $($MinDriver[$build]); update the NVIDIA driver to use the GPU" }

    if ($problems.Count -gt 0) {
        $why = "$($gpu.Name): " + ($problems -join '; ')
        if ($Device -ne 'gpu') { return New-Choice 'cpu' 'cpu' $why $gpu }
        Write-Warning "Forcing the GPU anyway: $why"
    }
    $gb = [math]::Round($gpu.VramMiB / 1024, 1)
    return New-Choice 'cuda' $build "$($gpu.Name), $gb GB, compute $($gpu.ComputeCap), driver $($gpu.DriverText)" $gpu
}

function Get-Where([string]$DeviceName) { if ($DeviceName -eq 'cuda') { 'GPU' } else { 'CPU' } }

Step 'Checking this machine'
$cpuName = "$((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)".Trim()
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Write-Host "    CPU: $cpuName, $ramGb GB RAM, $([Environment]::ProcessorCount) threads"
$choice = Select-Device
Write-Host "    Kokoro will run on the $(Get-Where $choice.Device) ($($choice.Reason))"
Write-Host "    PyTorch build: $($choice.Build)"
if ($CheckOnly) { exit 0 }

# --- 2. uv, then Python 3.12 in a virtual environment -----------------------------------

New-Item -ItemType Directory -Force (Join-Path $Target 'logs') | Out-Null
Start-Transcript -Path (Join-Path $Target 'logs\install.log') -Force | Out-Null
$tools = Join-Path $Target 'tools'
$venv = Join-Path $Target 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$serverPy = Join-Path $Target 'server.py'

function Get-Uv {
    $onPath = Get-Command uv -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $local = Join-Path $tools 'uv.exe'
    if (Test-Path $local) { return $local }

    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
    $url = "https://github.com/astral-sh/uv/releases/latest/download/uv-$arch-pc-windows-msvc.zip"
    Step "Downloading uv ($arch)"
    $zip = Join-Path $env:TEMP "uv-$([guid]::NewGuid()).zip"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
        New-Item -ItemType Directory -Force $tools | Out-Null
        Expand-Archive -Path $zip -DestinationPath $tools -Force
    } finally {
        Remove-Item $zip -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $local)) { throw "uv.exe was not in $url" }
    return $local
}

# A running server holds files open in the venv. Stop it before changing anything.
$running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPy) }
foreach ($p in @($running)) {
    if (-not $p) { continue }
    Step "Stopping the running voice server (PID $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$uv = Get-Uv
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Target 'python'
$env:UV_CACHE_DIR = Join-Path $Target 'cache'
$env:UV_LINK_MODE = 'copy'
# Windows without Developer Mode has no symlinks; the model cache works anyway, so hide the warning.
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'

if (-not (Test-Path $python)) {
    # Kokoro supports Python 3.10 to 3.12. --seed adds pip, which spaCy uses to fetch its
    # English model the first time Kokoro runs.
    Invoke-Checked 'Creating the Python 3.12 environment' { & $uv venv --python 3.12 --seed $venv }
}

# --- 3. PyTorch for the chosen device, then Kokoro --------------------------------------

function Get-TorchBuild {
    $out = Read-Native { & $python -c "import torch; v = torch.version.cuda; print('cu' + v.replace('.', '') if v else 'cpu')" }
    if (-not $out) { return $null }
    return "$out".Trim()
}

function Install-Torch([string]$Build) {
    if ((Get-TorchBuild) -eq $Build) {
        Step "PyTorch ($Build) is already installed"
        return
    }
    Invoke-Checked "Installing PyTorch ($Build)" {
        & $uv pip install --python $python --reinstall-package torch torch --index-url "https://download.pytorch.org/whl/$Build"
    }
}

Install-Torch $choice.Build
Invoke-Checked 'Installing Kokoro' { & $uv pip install --python $python kokoro soundfile sounddevice }
Copy-Item (Join-Path $PSScriptRoot 'server.py') $serverPy -Force

# --- 4. Prove it: speak a phrase into memory on the chosen device ------------------------

function Test-Kokoro([string]$DeviceName) {
    Step "Testing Kokoro on the $(Get-Where $DeviceName) (downloads the 330 MB model the first time)"
    $code = Invoke-Native { & $python $serverPy --check $DeviceName }
    return $code -eq 0
}

function Save-Config([string]$DeviceName, [string]$Reason) {
    $config = [ordered]@{
        device  = $DeviceName
        reason  = $Reason
        gpu     = if ($choice.Gpu) { $choice.Gpu.Name } else { $null }
        cpu     = $cpuName
        checked = (Get-Date).ToString('s')
    }
    # Without a byte order mark, so Python's json module reads it.
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $Target 'config.json'), ($config | ConvertTo-Json), $utf8)
}

$final = $choice.Device
$reason = $choice.Reason
if (-not (Test-Kokoro $final)) {
    if ($final -ne 'cuda') { throw 'Kokoro did not run on the CPU. The output above says why.' }
    Write-Warning 'Kokoro did not run on the GPU. Switching to the CPU.'
    $final = 'cpu'
    $reason = "the GPU test failed on $($choice.Reason)"
    Install-Torch 'cpu'
    if (-not (Test-Kokoro 'cpu')) { throw 'Kokoro did not run on the CPU either. The output above says why.' }
}
Save-Config $final $reason

Write-Host "DONE: Kokoro runs on the $(Get-Where $final). The voice-replies plugin starts the server from $Target on its own."
