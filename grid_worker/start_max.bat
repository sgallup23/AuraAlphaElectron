@echo off
title Aura Grid Worker - MAX COMPUTE
cd /d "%~dp0"
set BATCH_SIZE=50
set OMP_NUM_THREADS=14
set MKL_NUM_THREADS=14
set NUMBA_NUM_THREADS=14

:: Find Python
set PYTHON=
where python >nul 2>&1 && set PYTHON=python
if not defined PYTHON (
    where py >nul 2>&1 && set PYTHON=py
)
if not defined PYTHON (
    if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe" (
        set PYTHON=C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe
    )
)
if not defined PYTHON (
    if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe" (
        set PYTHON=C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe
    )
)
if not defined PYTHON (
    echo [ERROR] Python not found. Run install.bat first.
    pause
    exit /b 1
)

echo.
echo === Aura Grid Worker - MAX COMPUTE (Windows Native) ===
echo All cores ^| No throttling ^| OMP=14 threads
echo.

%PYTHON% worker.py --coordinator-url https://auraalpha.cc --max-parallel 14 --mode max --verbose
pause
