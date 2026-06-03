
# setup.ps1 - One-time dependency installer for native Windows execution
# Usage: .\setup.ps1

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "======================================================"
Write-Host "   Purplle Store Intelligence - Native Windows Setup  "
Write-Host "======================================================"
Write-Host ""

# Step 1: Check Node.js
Write-Host "[1/3] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVer = node --version
    Write-Host "      Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "      ERROR: Node.js not found. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Step 2: Install backend npm packages
Write-Host ""
Write-Host "[2/3] Installing backend Node.js dependencies..." -ForegroundColor Yellow
Set-Location "$ROOT\backend"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "      ERROR: npm install failed." -ForegroundColor Red
    exit 1
}
Write-Host "      Backend dependencies installed." -ForegroundColor Green
Set-Location $ROOT

# Step 3: Install cv-pipeline Python packages directly (no venv - Python 3.14 compat)
Write-Host ""
Write-Host "[3/3] Installing Python dependencies for cv-pipeline..." -ForegroundColor Yellow
Write-Host "      Using system Python directly (no venv - Python 3.14 compatible)." -ForegroundColor Gray
Write-Host "      Installing PyTorch CPU + OpenCV + Ultralytics..." -ForegroundColor Gray
Write-Host "      This may take 5-10 minutes on first run." -ForegroundColor Gray

python -m pip install --upgrade pip
python -m pip install --extra-index-url https://download.pytorch.org/whl/cpu `
    torch torchvision ultralytics opencv-python-headless `
    requests==2.32.3 python-dotenv==1.0.1 numpy

if ($LASTEXITCODE -ne 0) {
    Write-Host "      ERROR: pip install failed." -ForegroundColor Red
    exit 1
}

Write-Host "      CV pipeline dependencies installed." -ForegroundColor Green

Write-Host ""
Write-Host "======================================================"
Write-Host "   Setup complete! Now run: .\start_system.ps1        "
Write-Host "======================================================"
Write-Host ""
