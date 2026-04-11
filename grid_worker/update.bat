@echo off
title Aura Alpha Grid Worker — Update
echo.
echo Pulling latest worker code...
cd /d C:\Users\shawn\AuraCommandV2
git pull origin master
echo.
echo [OK] Updated. Restart your worker to apply changes.
echo.
pause
