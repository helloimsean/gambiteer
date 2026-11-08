<#
.SYNOPSIS
  One-click start for Gambiteer (production mode).

.DESCRIPTION
  1. Builds the frontend (npm run build) when frontend\dist is missing or older than the sources
     (runs npm install first when frontend\node_modules is missing).
  2. Starts the FastAPI backend (uvicorn) on http://localhost:8000 in THIS window. It serves the
     built frontend at / and the API at /api.
  3. Opens http://localhost:8000 in the default browser as soon as the backend answers.
  Stop with Ctrl+C (the backend quits its Stockfish processes on shutdown).

  Works with Windows PowerShell 5.1 and PowerShell 7. The easiest way is to double-click
  start.bat, which runs this script. Or run it with:
    powershell -ExecutionPolicy Bypass -File .\start.ps1
  or right-click start.ps1 > "Run with PowerShell".

.PARAMETER Rebuild
  Always rebuild the frontend, even when dist looks up to date.

.PARAMETER NoBrowser
  Do not open the browser.

.PARAMETER Port
  Backend port (default 8000).
#>
param(
    [switch]$Rebuild,
    [switch]$NoBrowser,
    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Frontend = Join-Path $Root 'frontend'
$Backend = Join-Path $Root 'backend'
$Dist = Join-Path $Frontend 'dist'
$DistIndex = Join-Path $Dist 'index.html'
$Url = "http://localhost:$Port"
# Health checks use the IPv4 loopback: uvicorn listens on 127.0.0.1 only, and on Windows a refused
# connection to ::1 (what "localhost" tries first) takes about 2 s, longer than the check timeout.
$HealthBase = "http://127.0.0.1:$Port"

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Green
}

function Fail([string]$Text) {
    Write-Host ''
    Write-Host "ERROR: $Text" -ForegroundColor Red
    Write-Host ''
    # keep a double-clicked window open long enough to read the message
    if ([Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() -match '^-NonI')) {
        try { Read-Host 'Press Enter to close' | Out-Null } catch { }
    }
    exit 1
}

function Test-Health([string]$BaseUrl) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/health" -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# Newest write time among the files that feed the frontend build (test scripts excluded).
function Get-NewestSourceTime {
    $items = @()
    $items += Get-ChildItem -Path (Join-Path $Frontend 'src') -Recurse -File |
        Where-Object { $_.Extension -ne '.mjs' }
    $public = Join-Path $Frontend 'public'
    if (Test-Path $public) { $items += Get-ChildItem -Path $public -Recurse -File }
    foreach ($name in @('index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json')) {
        $p = Join-Path $Frontend $name
        if (Test-Path $p) { $items += Get-Item $p }
    }
    $newest = [datetime]::MinValue
    foreach ($i in $items) {
        if ($i.LastWriteTimeUtc -gt $newest) { $newest = $i.LastWriteTimeUtc }
    }
    return $newest
}

function Find-Python {
    foreach ($cmd in @('python', 'py')) {
        $c = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    return $null
}

Write-Host 'Gambiteer' -ForegroundColor Cyan
Write-Host "Project: $Root"

# ------------------------------------------------------------------ already running?
if (Test-Health $HealthBase) {
    Write-Step "A backend is already running on $Url"
    if (-not $NoBrowser) { Start-Process $Url }
    Write-Host 'Nothing else to do. (Stop the other instance first if you want a fresh start.)'
    exit 0
}

# ------------------------------------------------------------------ frontend build
$needBuild = $Rebuild.IsPresent
if (-not (Test-Path $DistIndex)) {
    $needBuild = $true
    Write-Step 'frontend\dist is missing: building the frontend'
} elseif (-not $needBuild) {
    $built = (Get-Item $DistIndex).LastWriteTimeUtc
    $newest = Get-NewestSourceTime
    if ($newest -gt $built) {
        $needBuild = $true
        Write-Step 'frontend sources changed since the last build: rebuilding'
    } else {
        Write-Step 'frontend\dist is up to date'
    }
} else {
    Write-Step 'Rebuilding the frontend (-Rebuild)'
}

if ($needBuild) {
    $npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command 'npm' -ErrorAction SilentlyContinue }
    if (-not $npm) { Fail 'npm was not found. Install Node.js (https://nodejs.org) and run this script again.' }
    Push-Location $Frontend
    $ErrorActionPreference = 'Continue'
    try {
        if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
            Write-Host 'Installing frontend dependencies (npm install)...'
            & $npm.Source install
            if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit code $LASTEXITCODE)." }
        }
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit code $LASTEXITCODE). See the errors above." }
    } finally {
        Pop-Location
        $ErrorActionPreference = 'Stop'
    }
}

# ------------------------------------------------------------------ backend checks
$python = Find-Python
if (-not $python) { Fail 'Python was not found on PATH. Install Python 3.12+ and run: pip install -r backend\requirements.txt' }
$pyArgs = @()
if ((Split-Path -Leaf $python) -like 'py.exe') { $pyArgs += '-3' }

# native commands: do not let stderr output turn into terminating errors (Windows PowerShell 5.1)
$ErrorActionPreference = 'Continue'
& $python @pyArgs -c 'import fastapi, uvicorn, chess, httpx' 2>$null
if ($LASTEXITCODE -ne 0) {
    Fail "Python packages are missing. Run:  $python -m pip install -r backend\requirements.txt"
}

$stockfish = if ($env:STOCKFISH_PATH) { $env:STOCKFISH_PATH } else { Join-Path $Root 'engines\stockfish19.exe' }
if (-not (Test-Path $stockfish)) {
    Write-Host "WARNING: Stockfish not found at $stockfish. Analysis, Play and Review will not work." -ForegroundColor Yellow
    Write-Host '         Download it as described in engines\README.md (or the Install section of README.md).' -ForegroundColor Yellow
}

$lc0 = if ($env:LC0_PATH) { $env:LC0_PATH } else { Join-Path $Root 'engines\lc0\lc0.exe' }
$maiaNets = if ($env:MAIA_WEIGHTS_DIR) { $env:MAIA_WEIGHTS_DIR } else { Join-Path $Root 'engines\maia' }
if (-not (Test-Path $lc0) -or -not (Test-Path (Join-Path $maiaNets 'maia-*.pb.gz'))) {
    Write-Host 'Info: the Maia bot is not installed (optional). To add it: python tools\install_maia.py, then restart.' -ForegroundColor Cyan
}

$fairy = if ($env:FAIRY_PATH) { $env:FAIRY_PATH } else { Join-Path $Root 'engines\fairy\fairy-stockfish.exe' }
if (-not (Test-Path $fairy)) {
    Write-Host 'Info: Fairy-Stockfish is not installed (optional, it plays 7 of the 8 variants). To add it: python tools\install_fairy.py, then restart.' -ForegroundColor Cyan
}

$busy = $null
try {
    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
} catch {
    $busy = $null
}
if ($busy) {
    Fail "Port $Port is already in use by process $($busy.OwningProcess). Close it or run: .\start.ps1 -Port 8001"
}

# ------------------------------------------------------------------ open the browser when ready
$opener = $null
if (-not $NoBrowser) {
    $opener = Start-Job -ArgumentList $Url, $HealthBase -ScriptBlock {
        param($u, $health)
        for ($i = 0; $i -lt 120; $i++) {
            try {
                $r = Invoke-WebRequest -UseBasicParsing -Uri "$health/api/health" -TimeoutSec 3
                if ($r.StatusCode -eq 200) { Start-Process $u; return }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
    }
}

# ------------------------------------------------------------------ run the backend (foreground)
Write-Step "Starting the backend on $Url  (Ctrl+C to stop)"
Push-Location $Backend
try {
    & $python @pyArgs -m uvicorn app.main:app --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
    if ($opener) { Remove-Job -Job $opener -Force -ErrorAction SilentlyContinue }
}
