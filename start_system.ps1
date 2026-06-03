
# start_system.ps1 - Start all services natively on Windows (MongoDB Atlas)
# Prerequisites: Run setup.ps1 first
# Usage: .\start_system.ps1

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "======================================================"
Write-Host "   Purplle Store Intelligence - Starting System       "
Write-Host "======================================================"

# Step 1: MongoDB Atlas - no local check needed
Write-Host ""
Write-Host "[1/3] Using MongoDB Atlas (cloud) - no local service needed." -ForegroundColor Green
Write-Host "      Connection is handled automatically by the backend." -ForegroundColor Gray

# Step 2: Start the Node.js backend
Write-Host ""
Write-Host "[2/3] Starting Node.js backend on port 3000..." -ForegroundColor Yellow

$backendLog    = "$ROOT\backend.log"
$backendErrLog = "$ROOT\backend_err.log"

$backendProcess = Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory "$ROOT\backend" `
    -RedirectStandardOutput $backendLog `
    -RedirectStandardError  $backendErrLog `
    -PassThru -NoNewWindow

Write-Host "      Backend PID: $($backendProcess.Id)" -ForegroundColor Gray
Write-Host "      Logs: $backendLog" -ForegroundColor Gray
Write-Host "      Waiting for backend to become healthy..." -ForegroundColor Gray

$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:3000/api/health" `
            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {}
    Write-Host "      Attempt $($i+1)/15..." -ForegroundColor Gray
}

if (-not $healthy) {
    Write-Host ""
    Write-Host "      ERROR: Backend did not start in time." -ForegroundColor Red
    Write-Host "      Check these log files for details:" -ForegroundColor Red
    Write-Host "        $backendLog" -ForegroundColor Yellow
    Write-Host "        $backendErrLog" -ForegroundColor Yellow
    $backendProcess | Stop-Process -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "      Backend is healthy at http://localhost:3000" -ForegroundColor Green

# Step 3: Start the CV pipeline
Write-Host ""
Write-Host "[3/3] Starting CV pipeline..." -ForegroundColor Yellow

$cvLog    = "$ROOT\cv_pipeline.log"
$cvErrLog = "$ROOT\cv_pipeline_err.log"

$cvProcess = Start-Process -FilePath "python" `
    -ArgumentList "tracker.py" `
    -WorkingDirectory "$ROOT\cv-pipeline" `
    -RedirectStandardOutput $cvLog `
    -RedirectStandardError  $cvErrLog `
    -PassThru -NoNewWindow

Write-Host "      CV Pipeline PID: $($cvProcess.Id)" -ForegroundColor Gray
Write-Host "      Logs: $cvLog" -ForegroundColor Gray

# All running
Write-Host ""
Write-Host "======================================================"
Write-Host "   All services are running!                          "
Write-Host "======================================================"
Write-Host ""
Write-Host "  Test these URLs in a new terminal:" -ForegroundColor Cyan
Write-Host "    curl http://localhost:3000/api/health"
Write-Host "    curl http://localhost:3000/api/metrics"
Write-Host "    curl http://localhost:3000/api/funnel"
Write-Host ""
Write-Host "  Press ENTER to stop all services." -ForegroundColor Yellow
Read-Host | Out-Null

# Cleanup
Write-Host "Stopping all services..." -ForegroundColor Yellow
$backendProcess | Stop-Process -Force -ErrorAction SilentlyContinue
$cvProcess      | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "Done." -ForegroundColor Green
