# Aura Alpha Grid Worker — HYBRID MODE
# Desktop stays usable while computing. Adaptive throttling scales workers based on system load.
$Host.UI.RawUI.WindowTitle = "Aura Grid Worker - HYBRID"
$env:BATCH_SIZE = "25"
Write-Host "`n=== Aura Grid Worker — HYBRID MODE ===" -ForegroundColor Cyan
Write-Host "Adaptive throttling: ON | Priority: Below Normal" -ForegroundColor DarkGray
Write-Host "Desktop will remain responsive while computing.`n" -ForegroundColor DarkGray
python worker.py --coordinator-url https://auraalpha.cc --max-parallel 20 --mode hybrid
