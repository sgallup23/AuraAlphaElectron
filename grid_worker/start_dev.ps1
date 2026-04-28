# Aura Alpha Grid Worker - DEV MODE
# Minimal background compute. Full system available for development.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - DEV"
Set-Location -LiteralPath $PSScriptRoot
$env:BATCH_SIZE = "5"

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

Write-Host "`n=== Aura Grid Worker - DEV MODE ===" -ForegroundColor Yellow
Write-Host "4 workers | Minimal CPU usage | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop fully responsive for development.`n" -ForegroundColor DarkGray

& $python worker.py --coordinator-url https://auraalpha.cc --max-parallel 4 --mode dev
