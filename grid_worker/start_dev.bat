@echo off
title Aura Grid Worker - DEV MODE
cd /d C:\Users\shawn\AuraCommandV2\grid_worker
set BATCH_SIZE=5
echo.
echo === Aura Grid Worker — DEV MODE (Windows Native) ===
echo 4 workers ^| Minimal CPU
echo.
C:\Users\shawn\AppData\Local\Programs\Python\Python311\python.exe worker.py --coordinator-url https://auraalpha.cc --max-parallel 4 --mode dev
pause
