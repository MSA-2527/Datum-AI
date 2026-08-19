# DATUM Setup Script - Installs everything and runs the dev server

param(
    [switch]$SkipNodeCheck = $false,
    [switch]$SkipDotnetCheck = $false
)

Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     DATUM - Complete Setup & Run       ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$exitOnError = $true

# Check Node.js
if (-not $SkipNodeCheck) {
    Write-Host "Checking Node.js..." -ForegroundColor Yellow
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "❌ Node.js not found!" -ForegroundColor Red
        Write-Host "   Install from: https://nodejs.org/ (LTS recommended)" -ForegroundColor Red
        exit 1
    }
    $nodeVersion = & node --version
    Write-Host "✓ Node.js $nodeVersion found" -ForegroundColor Green
}

# Check npm
Write-Host "Checking npm..." -ForegroundColor Yellow
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "❌ npm not found!" -ForegroundColor Red
    Write-Host "   npm comes with Node.js. Install from: https://nodejs.org/" -ForegroundColor Red
    exit 1
}
$npmVersion = & npm --version
Write-Host "✓ npm $npmVersion found" -ForegroundColor Green

Write-Host ""

# Install UI dependencies
Write-Host "Installing UI dependencies..." -ForegroundColor Yellow
Write-Host "Running: npm --prefix ui install" -ForegroundColor Cyan
npm --prefix ui install
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install UI dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✓ UI dependencies installed" -ForegroundColor Green

Write-Host ""
Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║    Starting Development Server...      ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Your app will be available at:" -ForegroundColor Cyan
Write-Host "   http://localhost:5273" -ForegroundColor Cyan
Write-Host ""
Write-Host "Commands:" -ForegroundColor Cyan
Write-Host "   Build for production: npm --prefix ui run build" -ForegroundColor Cyan
Write-Host "   Run tests: npm --prefix ui run test" -ForegroundColor Cyan
Write-Host ""

# Start dev server
npm --prefix ui run dev
