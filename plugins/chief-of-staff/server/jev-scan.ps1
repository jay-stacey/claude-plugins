# Looks at this machine for Jev, the Chief's small decision model, and prints ONE JSON line.
#
# Read-only: no admin rights, installs nothing, writes nothing. Every probe is wrapped so one
# failure gives null (or false) for that field, never a crash. server/jev_setup.py reads the line
# and picks a tier with cos/jev/tiers.py.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File jev-scan.ps1
#
# Video memory: never Win32_VideoController.AdapterRAM (a 32-bit field that tops out at 4 GB).
# NVIDIA numbers come from nvidia-smi; other cards from the driver's HardwareInformation.qwMemorySize.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

function Try-Get([scriptblock]$Probe, $Default = $null) {
    try { $v = & $Probe; if ($null -eq $v) { return $Default } return $v } catch { return $Default }
}

function To-Int($Value) {
    try { if ($null -eq $Value -or "$Value".Trim() -eq '') { return $null } return [int64]("$Value".Trim()) } catch { return $null }
}

$homeDir = if ($env:COS_HOME) { $env:COS_HOME } else { Join-Path $env:USERPROFILE '.claude\chief-of-staff' }

# --- Operating system and processor ---------------------------------------------------------

$os = Try-Get { if ($env:OS -eq 'Windows_NT') { 'windows' } else { "$([Environment]::OSVersion.Platform)".ToLower() } } 'windows'

$arch = Try-Get {
    $a = $null
    try { $a = "$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)".ToLower() } catch { }
    if (-not $a) {
        $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $a = "$a".ToLower()
    }
    switch ($a) { 'amd64' { 'x64' } 'x64' { 'x64' } 'arm64' { 'arm64' } 'x86' { 'x86' } default { $a } }
}

$procs = Try-Get { @(Get-CimInstance Win32_Processor) } @()
$cpuName = Try-Get { "$($procs[0].Name)".Trim() }
$cores = Try-Get { $n = 0; foreach ($p in $procs) { $n += [int]$p.NumberOfCores }; if ($n -gt 0) { $n } else { $null } }
$threads = Try-Get { $n = 0; foreach ($p in $procs) { $n += [int]$p.NumberOfLogicalProcessors }; if ($n -gt 0) { $n } else { [Environment]::ProcessorCount } }

# IsProcessorFeaturePresent: 39 = PF_AVX2_INSTRUCTIONS_AVAILABLE, 41 = PF_AVX512F_INSTRUCTIONS_AVAILABLE.
$avx2 = $null
$avx512 = $null
try {
    if (-not ('JevScan.Cpu' -as [type])) {
        Add-Type -Namespace JevScan -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
    }
    $avx2 = [bool][JevScan.Cpu]::IsProcessorFeaturePresent(39)
    $avx512 = [bool][JevScan.Cpu]::IsProcessorFeaturePresent(41)
} catch { }

# --- Memory -----------------------------------------------------------------------------------

$ramTotalMb = Try-Get { [int64]([double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) }
$ramFreeMb = Try-Get { [int64]([double](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024) }

# --- Graphics ---------------------------------------------------------------------------------

function Find-NvidiaSmi {
    $onPath = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($path in "$env:WINDIR\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe") {
        if (Test-Path $path) { return $path }
    }
    return $null
}

# Same query shape as setup.ps1 Get-NvidiaGpu, with memory.free in place of memory.used.
function Get-NvidiaRows {
    $smi = Find-NvidiaSmi
    if (-not $smi) { return @() }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $rows = & $smi --query-gpu=name,memory.total,memory.free,compute_cap,driver_version --format=csv,noheader,nounits 2>$null }
    catch { return @() }
    finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0 -or -not $rows) { return @() }
    $list = New-Object System.Collections.ArrayList
    foreach ($row in @($rows)) {
        $f = "$row" -split ',\s*'
        if ($f.Count -lt 5) { continue }
        [void]$list.Add([pscustomobject]@{
            Name = $f[0].Trim(); Total = To-Int $f[1]; Free = To-Int $f[2]
            Cap = $f[3].Trim(); Driver = $f[4].Trim(); Used = $false
        })
    }
    return $list
}

# Dedicated memory per display adapter from the driver's registry key, in MiB.
function Get-DedicatedMemory {
    $out = @{}
    $class = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    foreach ($key in @(Get-ChildItem $class -ErrorAction SilentlyContinue)) {
        if ($key.PSChildName -notmatch '^\d{4}$') { continue }
        try {
            $p = Get-ItemProperty $key.PSPath -ErrorAction Stop
            $bytes = $p.'HardwareInformation.qwMemorySize'
            if ($null -eq $bytes) { $bytes = $p.'HardwareInformation.MemorySize' }
            if ($bytes -is [byte[]]) {
                $bytes = if ($bytes.Length -ge 8) { [BitConverter]::ToUInt64($bytes, 0) } else { [BitConverter]::ToUInt32($bytes, 0) }
            }
            if ($null -eq $bytes) { continue }
            $mb = [int64]([double]$bytes / 1MB)
            if ($p.DriverDesc) { $out["name:$($p.DriverDesc)"] = $mb }
            if ($p.MatchingDeviceId) { $out["id:$("$($p.MatchingDeviceId)".ToUpper())"] = $mb }
        } catch { continue }
    }
    return $out
}

function Find-Dedicated($Table, [string]$Name, [string]$PnpId) {
    $id = "$PnpId".ToUpper()
    foreach ($k in $Table.Keys) {
        if ($k.StartsWith('id:') -and $id.StartsWith($k.Substring(3))) { return $Table[$k] }
    }
    if ($Table.ContainsKey("name:$Name")) { return $Table["name:$Name"] }
    return $null
}

function Test-Integrated([string]$Vendor, [string]$Name, $DedicatedMb) {
    if ($Vendor -eq 'nvidia') { return $false }
    if ($Vendor -eq 'intel' -and $Name -notmatch '\bArc\b') { return $true }
    if ($Vendor -eq 'amd' -and $Name -match 'Radeon\(TM\) Graphics|Radeon Graphics|Vega \d+ Graphics|Radeon \d+M\b') { return $true }
    if ($null -ne $DedicatedMb -and $DedicatedMb -lt 1024) { return $true }
    return $false
}

$gpus = New-Object System.Collections.ArrayList
try {
    $nvRows = Try-Get { Get-NvidiaRows } @()
    $dedicated = Try-Get { Get-DedicatedMemory } @{}
    $controllers = Try-Get { @(Get-CimInstance Win32_VideoController) } @()
    foreach ($c in $controllers) {
        try {
            $name = "$($c.Name)".Trim()
            $pnp = "$($c.PNPDeviceID)"
            if ($name -match 'Basic Render|Basic Display|Remote Display|Remote Desktop|Hyper-V|Virtual Display|Mirage|Parsec|Meta Virtual|Citrix') { continue }
            $vendor = if ($pnp -match 'VEN_10DE') { 'nvidia' } elseif ($pnp -match 'VEN_1002') { 'amd' } elseif ($pnp -match 'VEN_8086') { 'intel' } else { 'other' }
            $vram = $null; $free = $null; $cap = $null; $driver = $null
            if ($vendor -eq 'nvidia') {
                $match = $null
                foreach ($r in $nvRows) { if (-not $r.Used -and $r.Name -eq $name) { $match = $r; break } }
                if (-not $match) { foreach ($r in $nvRows) { if (-not $r.Used) { $match = $r; break } } }
                if ($match) {
                    $match.Used = $true
                    $vram = $match.Total; $free = $match.Free; $cap = $match.Cap; $driver = $match.Driver
                }
            }
            if ($null -eq $vram) { $vram = Find-Dedicated $dedicated $name $pnp }
            if ($null -eq $driver -and $c.DriverVersion) { $driver = "$($c.DriverVersion)" }
            $integrated = Test-Integrated $vendor $name $vram
            if ($integrated) { $vram = 0; $free = $null }
            [void]$gpus.Add([ordered]@{
                vendor = $vendor; name = $name; integrated = $integrated; vramMb = $vram
                freeVramMb = $free; computeCap = $cap; driver = $driver
            })
        } catch { continue }
    }
    # A card nvidia-smi sees that Windows did not list (rare): add it as is.
    foreach ($r in $nvRows) {
        if ($r.Used) { continue }
        [void]$gpus.Add([ordered]@{
            vendor = 'nvidia'; name = $r.Name; integrated = $false; vramMb = $r.Total
            freeVramMb = $r.Free; computeCap = $r.Cap; driver = $r.Driver
        })
    }
} catch { }

$npu = Try-Get { [bool](@(Get-PnpDevice -Class ComputeAccelerator -PresentOnly -ErrorAction Stop).Count -gt 0) } $false

# --- Disk and power ---------------------------------------------------------------------------

$diskFreeMb = Try-Get {
    $probe = $homeDir
    while ($probe -and -not (Test-Path $probe)) { $probe = Split-Path $probe -Parent }
    if (-not $probe) { $probe = $env:USERPROFILE }
    $letter = (Split-Path $probe -Qualifier).TrimEnd(':')
    [int64]([double](Get-PSDrive -Name $letter -PSProvider FileSystem).Free / 1MB)
}

# Win32_Battery.BatteryStatus: 1 discharging, 4 low, 5 critical mean it runs on the battery now.
$onBattery = Try-Get {
    $on = $false
    foreach ($b in @(Get-CimInstance Win32_Battery -ErrorAction Stop)) {
        if (@(1, 4, 5) -contains [int]$b.BatteryStatus) { $on = $true }
    }
    $on
} $false

# --- Runtimes ---------------------------------------------------------------------------------

$ollamaPath = Try-Get {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $cmd.Source }
    elseif ($env:LOCALAPPDATA -and (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")) { "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
}

$ollamaVersion = $null
$ollamaListening = $false
try {
    $req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:11434/api/version')
    $req.Timeout = 1000
    $req.ReadWriteTimeout = 1000
    $req.Proxy = $null
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
    } finally { $resp.Close() }
    $ollamaListening = $true
    $ollamaVersion = Try-Get { "$(($body | ConvertFrom-Json).version)".Trim() }
    if ($ollamaVersion -eq '') { $ollamaVersion = $null }
} catch { }

$loopbackOnly = Try-Get {
    $listen = @(Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction Stop)
    if ($listen.Count -eq 0) { $null }
    else {
        $ok = $true
        foreach ($l in $listen) { if (@('127.0.0.1', '::1') -notcontains "$($l.LocalAddress)") { $ok = $false } }
        $ok
    }
}

$llamaPath = Try-Get { (Get-Command llama-server -ErrorAction SilentlyContinue | Select-Object -First 1).Source }

# --- Out --------------------------------------------------------------------------------------

$result = [ordered]@{
    os          = $os
    arch        = $arch
    cpu         = [ordered]@{ name = $cpuName; cores = $cores; threads = $threads; avx2 = $avx2; avx512 = $avx512 }
    ramTotalMb  = $ramTotalMb
    ramFreeMb   = $ramFreeMb
    gpus        = [object[]]$gpus.ToArray()
    npu         = $npu
    diskFreeMb  = $diskFreeMb
    onBattery   = $onBattery
    ollama      = [ordered]@{
        found = [bool]($ollamaPath -or $ollamaListening); path = $ollamaPath; version = $ollamaVersion
        listening = $ollamaListening; loopbackOnly = $loopbackOnly
    }
    llamaServer = [ordered]@{ found = [bool]$llamaPath; path = $llamaPath }
}
# ConvertTo-Json in Windows PowerShell turns a one-item array into an object; keep it a list.
$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
if ($gpus.Count -eq 0) { $json = $json -replace '"gpus":(null|\{\})', '"gpus":[]' }
[Console]::Out.WriteLine($json)
