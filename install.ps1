# HopWatch installer (Windows PowerShell). Delegates to the cross-platform Node script.
# Usage: .\install.ps1 [--create-db] [--skip-install] [--skip-migrate]
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 22.6+ is required and was not found on PATH."
  exit 1
}

node scripts/setup.mjs @args
exit $LASTEXITCODE
