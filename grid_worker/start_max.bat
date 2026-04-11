@echo off
title Aura Grid Worker - MAX COMPUTE
cd /d C:\Users\shawn\AuraCommandV2\grid_worker
set BATCH_SIZE=50
set OMP_NUM_THREADS=14
set MKL_NUM_THREADS=14
set NUMBA_NUM_THREADS=14
echo.
echo === Aura Grid Worker — MAX COMPUTE (Windows Native) ===
echo All cores ^| No throttling ^| OMP=14 threads
echo.
C:\Users\shawn\AppData\Local\Programs\Python\Python311\python.exe worker.py --coordinator-url https://auraalpha.cc --max-parallel 14 --mode max --verbose
pause
