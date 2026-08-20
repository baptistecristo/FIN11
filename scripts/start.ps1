# Starts the hub and opens the viewer in its own Chrome window.
#
#   .\scripts\start.ps1                       live capture
#   .\scripts\start.ps1 -Replay <file>        replay a recorded or exported session
#   .\scripts\start.ps1 -Replay <file> -Speed 40
#   .\scripts\start.ps1 -NoWindow             hub only

[CmdletBinding()]
param(
  [string]$Replay,
  [int]$Speed = 20,
  [int]$Port = 8787,
  [switch]$NoWindow
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js is not on PATH. Install it from https://nodejs.org and run this again.'
}

# A hub already listening means a second one would just fail on the port.
$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { }
if ($busy) {
  Write-Host "A hub is already listening on port $Port." -ForegroundColor Yellow
  if (-not $NoWindow) { Start-Process chrome.exe -ArgumentList "--app=$url" }
  return
}

$hubArgs = @((Join-Path $root 'hub\server.js'))
if ($Replay) {
  if (-not (Test-Path $Replay)) { Write-Error "Replay file not found: $Replay" }
  $hubArgs += @('--replay', (Resolve-Path $Replay).Path, '--speed', $Speed)
}

$env:FTS_PORT = $Port
Write-Host "Starting hub on $url" -ForegroundColor Cyan
$hub = Start-Process node -ArgumentList $hubArgs -WorkingDirectory $root -PassThru -NoNewWindow

# Wait for the port rather than sleeping a fixed amount.
$ready = $false
foreach ($attempt in 1..40) {
  Start-Sleep -Milliseconds 150
  if ($hub.HasExited) { Write-Error "Hub exited immediately (code $($hub.ExitCode))." }
  try {
    Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch { }
}
if (-not $ready) { Write-Error "Hub did not come up on $url." }

if (-not $NoWindow) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($chrome) {
    # App mode: no address bar, its own taskbar entry, its own window.
    & $chrome "--app=$url" "--window-size=1440,940" | Out-Null
    Write-Host 'Viewer window opened.' -ForegroundColor Green
  } else {
    Write-Host "Chrome not found. Open $url in a browser." -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Hub is running. Press Ctrl+C to stop it.' -ForegroundColor Cyan
try { Wait-Process -Id $hub.Id } finally {
  if (-not $hub.HasExited) { Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue }
}
