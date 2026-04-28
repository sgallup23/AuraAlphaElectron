@echo off
title Aura Grid Worker - DEV MODE
cd /d "%~dp0"
set BATCH_SIZE=5

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
echo === Aura Grid Worker - DEV MODE (Windows Native) ===
echo 4 workers ^| Minimal CPU
echo.

%PYTHON% worker.py --coordinator-url https://auraalpha.cc --max-parallel 4 --mode dev
pause
