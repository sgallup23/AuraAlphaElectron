# Aura Alpha Grid Worker - HYBRID MODE
# Desktop stays usable while computing. Adaptive throttling scales workers based on system load.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - HYBRID"
Set-Location -LiteralPath $PSScriptRoot
$env:BATCH_SIZE = "25"

# Find Python
$python = $null
foreach ($name in @('python','py')) {
    if (Get-Command $name -ErrorAction SilentlyContinue) { $python = $name; break }
}
if (-not $python) {
    foreach ($v in @('Python312','Python311')) {
        $candidate = "$env:LOCALAPPDATA\Programs\Python\$v\python.exe"
        if (Test-Path $candidate) { $python = $candidate; break }
    }
}
if (-not $python) {
    Write-Host "[ERROR] Python not found. Run install.bat first." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "`n=== Aura Grid Worker - HYBRID MODE ===" -ForegroundColor Cyan
Write-Host "Adaptive throttling: ON | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop will remain responsive while computing.`n" -ForegroundColor DarkGray

& $python worker.py --coordinator-url https://auraalpha.cc --max-parallel 20 --mode hybrid
