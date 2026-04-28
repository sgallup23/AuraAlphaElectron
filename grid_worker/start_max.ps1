# Aura Alpha Grid Worker - MAX COMPUTE MODE
# Full CPU utilization. Use overnight or when not using the desktop.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - MAX COMPUTE"
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

Write-Host "`n=== Aura Grid Worker - MAX COMPUTE ===" -ForegroundColor Green
Write-Host "All cores active | No throttling | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop may be slow while running.`n" -ForegroundColor Yellow

& $python worker.py --coordinator-url https://auraalpha.cc --max-parallel 28 --mode max
