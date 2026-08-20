# Flotilla metrics collector for Windows. Emits one JSON object on stdout.
# Designed to be piped over ssh:
#   ssh <host> 'powershell -NoProfile -Command -' < windows.ps1
# Configuration arrives as $Counts/$Sessions assignments prepended to this script
# by the server -- "-Command -" refuses positional arguments -- so each is a
# comma-separated list of process names, defaulted only when nothing was sent:
#   counts    processes worth tallying   (dune, cargo, msbuild, ...)
#   sessions  processes worth listing    (claude, codex, ...)
if (-not $Counts)   { $Counts = "dune" }
if (-not $Sessions) { $Sessions = "claude,codex" }
$ErrorActionPreference = "SilentlyContinue"

$cpu = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue, 1)

# GPU: perf counters expose per-process engine utilization. Group by engine type
# (3D, Compute, Copy, ...) and report the busiest engine type as overall load —
# summing across types double-counts, and 3D alone misses compute workloads.
# (AMD submits Vulkan compute on the 3D engine; WSL CUDA shows under Compute.)
$gpu = $null
$samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples
if ($samples) {
  $byType = $samples | Group-Object { ($_.InstanceName -split 'engtype_')[1] } |
    ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum }
  $util = [math]::Round([math]::Min(100, ($byType | Measure-Object -Maximum).Maximum), 1)
  $memUsed = ((Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples |
    Measure-Object CookedValue -Sum).Sum
  # util_pct spans every adapter's engines, so name them all — picking one
  # mislabels multi-GPU machines (dGPU load reported under the iGPU's name).
  $name = (@(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) |
    Where-Object { $_ } | Select-Object -Unique) -join " + "
  $gpu = [ordered]@{
    kind = "windows"; name = "$name"; util_pct = $util
    mem_used_mb = [math]::Round($memUsed / 1MB, 0); mem_total_mb = $null
  }
}

function Get-AgentSessions([string]$procName) {
  # @() guards against PowerShell unwrapping a single-element result to a bare object.
  @(Get-Process -Name $procName | ForEach-Object {
    $etime = ""
    if ($_.StartTime) { $etime = ((Get-Date) - $_.StartTime).ToString("d\-hh\:mm\:ss") }
    [ordered]@{ pid = $_.Id; etime = $etime; cwd = ""; cwd_deleted = $false; cmd = "$($_.Path)" }
  })
}

$splitOpts = [System.StringSplitOptions]::RemoveEmptyEntries
$countsOut = [ordered]@{}
foreach ($name in $Counts.Split(",", $splitOpts)) {
  $countsOut[$name] = @(Get-Process -Name $name).Count
}
$sessionsOut = [ordered]@{}
foreach ($name in $Sessions.Split(",", $splitOpts)) {
  # @() at the assignment too: an empty result unrolls to $null on the way out
  # of the function, and ConvertTo-Json renders that as {} instead of [].
  $sessionsOut[$name] = @(Get-AgentSessions $name)
}

$result = [ordered]@{
  os       = "windows"
  host     = "$env:COMPUTERNAME".ToLower()
  ncpu     = [Environment]::ProcessorCount
  cpu_pct  = $cpu
  load1    = $null
  gpu      = $gpu
  counts   = $countsOut
  sessions = $sessionsOut
}

$result | ConvertTo-Json -Compress -Depth 5
