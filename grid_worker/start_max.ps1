# Aura Alpha Grid Worker — MAX COMPUTE MODE
# Full CPU utilization. Use overnight or when not using the desktop.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - MAX COMPUTE"
$env:BATCH_SIZE = "25"
Write-Host "`n=== Aura Grid Worker — MAX COMPUTE ===" -ForegroundColor Green
Write-Host "All cores active | No throttling | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop may be slow while running.`n" -ForegroundColor Yellow
python worker.py --coordinator-url https://auraalpha.cc --max-parallel 28 --mode max
