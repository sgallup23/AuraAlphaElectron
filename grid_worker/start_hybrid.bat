@echo off
title Aura Grid Worker - HYBRID MODE
cd /d C:\Users\shawn\AuraCommandV2\grid_worker
set BATCH_SIZE=25
echo.
echo === Aura Grid Worker — HYBRID MODE (Windows Native) ===
echo Adaptive throttling: ON ^| Priority: Below Normal ^| GPU: Auto-detect
echo.
C:\Users\shawn\AppData\Local\Programs\Python\Python311\python.exe worker.py --coordinator-url https://auraalpha.cc --max-parallel 20 --mode hybrid --verbose
pause
