# Installs the Chief of Staff voice daemon (server/voice/voiced.py) into its own venv.
#
# Checks the machine first, then picks the recipe:
#   - CUDA: an NVIDIA card with at least 6 GB of video memory, a driver new enough for CUDA 12.4
#     and a compute capability that PyTorch 2.6 cu124 builds for (5.0 to 9.0). Chatterbox is the
#     main voice, Kokoro the fallback, faster-whisper large-v3-turbo for speech to text.
#   - CPU otherwise: Kokoro is the main voice, faster-whisper small.en int8 for speech to text.
# After installing, it proves the choice with a self-check (load every model, speak a phrase
# into memory, transcribe it). If the GPU fails the self-check, it switches to the CPU on its own.
#
# Everything goes into %USERPROFILE%\.claude\chief-of-staff (HOME): HOME\venv, HOME\models,
# HOME\logs, HOME\voice.json. Large models (faster-whisper, Chatterbox) go to the Hugging Face
# cache. No admin rights, no Python of your own: uv fetches Python 3.11.
# Safe to run again: it skips what is already in place.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1                 # pick for me
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Device cpu     # force the CPU recipe
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Device gpu     # force CUDA
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -CheckOnly      # report, install nothing
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -SkipSelfCheck  # install only

param(
    [ValidateSet('auto', 'gpu', 'cpu')]
    [string]$Device = 'auto',
    [string]$Target = $(if ($env:COS_HOME) { $env:COS_HOME } else { "$env:USERPROFILE\.claude\chief-of-staff" }),
    [switch]$CheckOnly,
    [switch]$SkipSelfCheck
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with the bar

# Chatterbox (3.0 GB) + whisper large-v3-turbo int8_float16 (1.1 GB) + the desktop needs 6 GB.
$MinVramMiB = 6144
# PyTorch 2.6 cu124 wheels cover compute capability 5.0 to 9.0. Blackwell (10.0 and up) is not in them.
$MinComputeCap = [version]'5.0'
$MaxComputeCap = [version]'9.0'
# Lowest Windows driver for CUDA 12.x (minor-version compatibility).
$MinDriver = [version]'528.33'

$PythonVersion = '3.11'
$ServerDir = $PSScriptRoot
$Requirements = Join-Path $ServerDir 'requirements-voice.txt'
$Voiced = Join-Path $ServerDir 'voice\voiced.py'
$SpikeDir = Join-Path $env:USERPROFILE '.claude\chief-of-staff\spike'

$KokoroFiles = @{
    'kokoro-v1.0.onnx' = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'
    'voices-v1.0.bin'  = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
}
$KwsName = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
$KwsUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$KwsName.tar.bz2"

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
    $rows = Read-Native { & $smi --query-gpu=name,memory.total,memory.used,compute_cap,driver_version --format=csv,noheader,nounits }
    if (-not $rows) { return $null }
    $gpus = foreach ($row in @($rows)) {
        $f = "$row" -split ',\s*'
        if ($f.Count -lt 5) { continue }
        try {
            [pscustomobject]@{
                Name       = $f[0].Trim()
                VramMiB    = [int]$f[1]
                UsedMiB    = [int]$f[2]
                ComputeCap = [version]$f[3].Trim()
                Driver     = [version]$f[4].Trim()
                DriverText = $f[4].Trim()
            }
        } catch { continue }
    }
    return $gpus | Sort-Object VramMiB -Descending | Select-Object -First 1
}

function New-Choice([string]$DeviceName, [string]$Reason, $Gpu) {
    return [pscustomobject]@{ Device = $DeviceName; Reason = $Reason; Gpu = $Gpu }
}

function Select-Device {
    $graphics = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', '
    $gpu = Get-NvidiaGpu

    if ($Device -eq 'cpu') { return New-Choice 'cpu' 'you asked for the CPU' $gpu }
    if (-not $gpu) {
        $why = if ($graphics) { "no NVIDIA GPU found (graphics: $graphics)" } else { 'no NVIDIA GPU found' }
        if ($Device -eq 'gpu') { throw "You asked for the GPU, but $why. The CUDA recipe needs an NVIDIA card." }
        return New-Choice 'cpu' $why $null
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        return New-Choice 'cpu' 'PyTorch has no CUDA build for Windows on ARM' $gpu
    }

    $problems = @()
    if ($gpu.ComputeCap -lt $MinComputeCap -or $gpu.ComputeCap -gt $MaxComputeCap) {
        $problems += "compute capability $($gpu.ComputeCap) is outside $MinComputeCap to $MaxComputeCap that torch 2.6 cu124 supports"
    }
    if ($gpu.VramMiB -lt $MinVramMiB) { $problems += "$($gpu.VramMiB) MiB of video memory is below $MinVramMiB MiB" }
    if ($gpu.Driver -lt $MinDriver) { $problems += "driver $($gpu.DriverText) is older than $MinDriver; update the NVIDIA driver to use the GPU" }

    if ($problems.Count -gt 0) {
        $why = "$($gpu.Name): " + ($problems -join '; ')
        if ($Device -ne 'gpu') { return New-Choice 'cpu' $why $gpu }
        Write-Warning "Forcing the GPU anyway: $why"
    }
    $gb = [math]::Round($gpu.VramMiB / 1024, 1)
    return New-Choice 'cuda' "$($gpu.Name), $gb GB, compute $($gpu.ComputeCap), driver $($gpu.DriverText)" $gpu
}

function Get-Where([string]$DeviceName) { if ($DeviceName -eq 'cuda') { 'GPU' } else { 'CPU' } }

Step 'Checking this machine'
$cpuName = "$((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)".Trim()
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Write-Host "    CPU: $cpuName, $ramGb GB RAM, $([Environment]::ProcessorCount) threads"
$choice = Select-Device
Write-Host "    Recipe: $(Get-Where $choice.Device) ($($choice.Reason))"
if ($choice.Gpu) { Write-Host "    Video memory in use now: $($choice.Gpu.UsedMiB) of $($choice.Gpu.VramMiB) MiB" }
if (-not (Test-Path $Requirements)) { throw "Missing $Requirements" }
if (-not (Test-Path $Voiced)) { throw "Missing $Voiced" }
if ($CheckOnly) { exit 0 }

# --- 2. uv, then Python 3.11 in HOME\venv -------------------------------------------------

$logs = Join-Path $Target 'logs'
$models = Join-Path $Target 'models'
$tools = Join-Path $Target 'tools'
$venv = Join-Path $Target 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
New-Item -ItemType Directory -Force $logs, $models | Out-Null
Start-Transcript -Path (Join-Path $logs 'setup.log') -Force | Out-Null

function Get-Uv {
    $onPath = Get-Command uv -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($path in (Join-Path $env:USERPROFILE '.local\bin\uv.exe'), (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe'), (Join-Path $tools 'uv.exe')) {
        if (Test-Path $path) { return $path }
    }
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
    $local = Join-Path $tools 'uv.exe'
    if (-not (Test-Path $local)) { throw "uv.exe was not in $url" }
    return $local
}

# A running daemon holds files open in the venv. Stop it before changing anything.
$running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('voiced.py') -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($venv, [StringComparison]::OrdinalIgnoreCase) }
foreach ($p in @($running)) {
    if (-not $p) { continue }
    Step "Stopping the running voice daemon (PID $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$uv = Get-Uv
Write-Host "    uv: $uv"
# Copy, not hardlink: the uv cache is often on another drive than the venv.
$env:UV_LINK_MODE = 'copy'
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'

if (-not (Test-Path $python)) {
    Invoke-Checked "Creating the Python $PythonVersion environment in $venv" { & $uv venv --python $PythonVersion $venv }
}

# --- 3. Packages: the spike lock, exactly ---------------------------------------------------

$reqFile = $Requirements
if ($choice.Device -ne 'cuda') {
    # CPU recipe: no CUDA index, no NVIDIA DLL packages, PyPI torch (the CPU wheel on Windows).
    $reqFile = Join-Path $Target 'run\requirements-cpu.txt'
    New-Item -ItemType Directory -Force (Split-Path $reqFile) | Out-Null
    $lines = Get-Content $Requirements | Where-Object { $_ -notmatch '^--extra-index-url' -and $_ -notmatch '^nvidia-' } |
        ForEach-Object { $_ -replace '\+cu124', '' }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($reqFile, $lines, $utf8)
}

function Get-TorchBuild {
    $out = Read-Native { & $python -c "import torch; v = torch.version.cuda; print('cu' + v.replace('.', '') if v else 'cpu')" }
    if (-not $out) { return $null }
    return "$out".Trim()
}

$want = if ($choice.Device -eq 'cuda') { 'cu124' } else { 'cpu' }
$have = Get-TorchBuild
if ($have) { Write-Host "    PyTorch build now in the venv: $have" }
# uv pip sync makes the venv match the lock exactly; when it already does, it only audits.
# About 7 GB on the CUDA recipe the first time. uv reuses its cache on later runs.
Invoke-Checked "Installing packages ($want)" { & $uv pip sync --python $python --index-strategy unsafe-best-match $reqFile }
$have = Get-TorchBuild
if ($have -ne $want) { throw "PyTorch in the venv is '$have', expected '$want'." }

# --- 4. Models -----------------------------------------------------------------------------

function Get-File([string]$Url, [string]$Dest) {
    $tmp = "$Dest.part"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $tmp
    Move-Item -Force $tmp $Dest
}

# Kokoro: copy the spike's files when they exist, else download them.
$kokoroDir = Join-Path $models 'kokoro'
New-Item -ItemType Directory -Force $kokoroDir | Out-Null
foreach ($name in $KokoroFiles.Keys) {
    $dest = Join-Path $kokoroDir $name
    if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 1MB) { continue }
    $spike = Join-Path $SpikeDir "models\kokoro\$name"
    if (Test-Path $spike) {
        Step "Copying Kokoro $name from the spike"
        Copy-Item $spike $dest -Force
    } else {
        Step "Downloading Kokoro $name"
        Get-File $KokoroFiles[$name] $dest
    }
}

# sherpa-onnx keyword spotter for "hey chief" (used when HOME\models\hey_chief.onnx is missing).
$kwsDir = Join-Path $models "kws\$KwsName"
if (-not (Test-Path (Join-Path $kwsDir 'tokens.txt'))) {
    Step 'Downloading the sherpa-onnx keyword spotter (about 20 MB)'
    $archive = Join-Path $models 'kws.tar.bz2'
    New-Item -ItemType Directory -Force (Join-Path $models 'kws') | Out-Null
    Get-File $KwsUrl $archive
    $extract = "import sys, tarfile; t = tarfile.open(sys.argv[1]); t.extractall(sys.argv[2], filter='data')"
    Invoke-Checked 'Unpacking the keyword spotter' { & $python -c $extract $archive (Join-Path $models 'kws') }
    Remove-Item $archive -ErrorAction SilentlyContinue
}

# openWakeWord feature models and Silero VAD (small files inside the venv), Whisper and
# Chatterbox into the Hugging Face cache. voiced.py --prefetch skips what is already there.
$sttModel = if ($choice.Device -eq 'cuda') { 'large-v3-turbo' } else { 'small.en' }
Invoke-Checked 'Fetching wake, VAD, speech-to-text and voice models (skips cached ones)' {
    & $python $Voiced --prefetch --device $choice.Device --stt-model $sttModel
}

# --- 5. Prove it -----------------------------------------------------------------------------

function Save-Config([string]$DeviceName, [string]$Reason) {
    $cuda = $DeviceName -eq 'cuda'
    # openWakeWord model for "hey chief", when one was trained. hey_chief.json beside it may
    # carry the threshold picked from its validation run.
    $wakeModel = Join-Path $models 'hey_chief.onnx'
    $wakeThreshold = 0.5
    $wakeMeta = Join-Path $models 'hey_chief.json'
    if (Test-Path $wakeMeta) {
        try {
            $t = [double](Get-Content $wakeMeta -Raw | ConvertFrom-Json).threshold
            if ($t -gt 0 -and $t -lt 1) { $wakeThreshold = $t }
        } catch { }
    }
    $config = [ordered]@{
        device       = $DeviceName
        reason       = $Reason
        tts          = if ($cuda) { 'chatterbox' } else { 'kokoro' }
        fallbackTts  = if ($cuda) { 'kokoro' } else { 'chatterbox' }
        sttModel     = if ($cuda) { 'large-v3-turbo' } else { 'small.en' }
        sttCompute   = if ($cuda) { 'int8_float16' } else { 'int8' }
        kokoroDir    = $kokoroDir
        kwsDir       = $kwsDir
        wakeModel    = if (Test-Path $wakeModel) { $wakeModel } else { $null }
        wakeThreshold = $wakeThreshold
        gpu         = if ($choice.Gpu) { $choice.Gpu.Name } else { $null }
        cpu          = $cpuName
        checked      = (Get-Date).ToString('s')
    }
    # Without a byte order mark, so Python's json module reads it.
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $Target 'voice.json'), ($config | ConvertTo-Json), $utf8)
}

function Test-Voice([string]$DeviceName) {
    Step "Self-check on the $(Get-Where $DeviceName): load every model, speak and transcribe a phrase"
    $code = Invoke-Native { & $python $Voiced --self-check --device $DeviceName }
    return $code -eq 0
}

$final = $choice.Device
$reason = $choice.Reason
Save-Config $final $reason
if (-not $SkipSelfCheck) {
    if (-not (Test-Voice $final)) {
        if ($final -ne 'cuda') { throw 'The voice self-check failed on the CPU. The output above says why.' }
        Write-Warning 'The voice self-check failed on the GPU. Switching to the CPU recipe settings.'
        $final = 'cpu'
        $reason = "the GPU self-check failed on $($choice.Reason)"
        Save-Config $final $reason
        Invoke-Checked 'Fetching the CPU speech-to-text model' { & $python $Voiced --prefetch --device cpu --stt-model small.en }
        if (-not (Test-Voice 'cpu')) { throw 'The voice self-check failed on the CPU too. The output above says why.' }
    }
}

$wake = if (Test-Path (Join-Path $models 'hey_chief.onnx')) { 'openWakeWord hey_chief.onnx' } else { 'sherpa-onnx keyword spotting' }
$voices = if ($final -eq 'cuda') { 'chatterbox (main), kokoro (fallback)' } else { 'kokoro (main), chatterbox (opt-in, slow on CPU)' }
$stt = if ($final -eq 'cuda') { 'faster-whisper large-v3-turbo int8_float16' } else { 'faster-whisper small.en int8' }
$checked = if ($SkipSelfCheck) { ' Self-check skipped.' } else { '' }
$selfCheck = Join-Path $Target 'run\selfcheck.json'
if (-not $SkipSelfCheck -and (Test-Path $selfCheck)) {
    try {
        $sc = Get-Content $selfCheck -Raw | ConvertFrom-Json
        $checked = " Self-check: main voice now $($sc.tts), heard `"$($sc.transcript)`"."
        $mainWanted = if ($final -eq 'cuda') { 'chatterbox' } else { 'kokoro' }
        if ($sc.tts -ne $mainWanted -and $sc.tts_reasons) {
            $checked += " $mainWanted was not used: $(@($sc.tts_reasons)[-1]). The daemon checks again each time it starts."
        }
    } catch { }
}
Stop-Transcript | Out-Null
Write-Host "DONE: device $final ($(Get-Where $final)). Voices: $voices. STT: $stt. Wake word: hey chief via $wake. Venv: $venv.$checked"
