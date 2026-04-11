# Aura Alpha Grid Worker — DEV MODE
# Minimal background compute. Full system available for development.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - DEV"
$env:BATCH_SIZE = "5"
Write-Host "`n=== Aura Grid Worker — DEV MODE ===" -ForegroundColor Yellow
Write-Host "4 workers | Minimal CPU usage | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop fully responsive for development.`n" -ForegroundColor DarkGray
python worker.py --coordinator-url https://auraalpha.cc --max-parallel 4 --mode dev
