@echo off
title Aura Alpha Grid Worker - Update
cd /d "%~dp0"
echo.
echo ============================================================
echo   Aura Alpha Grid Worker - Manual Update
echo ============================================================
echo.
echo The worker auto-updates on startup (v9.4.10+). Just restart
echo your worker and it will pull the latest release.
echo.
echo To force a manual update now, downloading latest from GitHub...
echo.

:: Download latest GPU Pack ZIP via PowerShell
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; try { $rel = Invoke-RestMethod 'https://api.github.com/repos/sgallup23/AuraAlphaElectron/releases/latest'; $asset = $rel.assets | Where-Object { $_.name -like 'AuraAlphaGridWorker_*.zip' } | Select-Object -First 1; if (-not $asset) { Write-Error 'No GPU Pack asset found in latest release'; exit 1 }; Write-Host \"Downloading $($asset.name) ($($rel.tag_name))...\"; Invoke-WebRequest $asset.browser_download_url -OutFile '_update.zip'; Write-Host 'Extracting...'; Expand-Archive -Path '_update.zip' -DestinationPath '_update_tmp' -Force; $src = Get-ChildItem '_update_tmp' -Directory | Select-Object -First 1; if ($src) { Copy-Item -Path \"$($src.FullName)\*\" -Destination '.' -Recurse -Force -Exclude '.env','data','logs','VERSION.json' } else { Copy-Item -Path '_update_tmp\*' -Destination '.' -Recurse -Force -Exclude '.env','data','logs','VERSION.json' }; Remove-Item '_update.zip','_update_tmp' -Recurse -Force; Write-Host '[OK] Updated to' $rel.tag_name } catch { Write-Error $_.Exception.Message; exit 1 }"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Update failed. You can also let the worker auto-update on startup.
    pause
    exit /b 1
)

echo.
echo [OK] Update complete. Restart your worker to apply changes.
echo.
pause
