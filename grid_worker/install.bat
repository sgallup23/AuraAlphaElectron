@echo off
title Aura Alpha Grid Worker — Installer
echo.
echo ============================================================
echo   Aura Alpha Grid Worker — Setup
echo ============================================================
echo.

:: Find Python
set PYTHON=
where python >nul 2>&1 && set PYTHON=python
if not defined PYTHON (
    where py >nul 2>&1 && set PYTHON=py
)
if not defined PYTHON (
    if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe" (
        set PYTHON=C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe
    )
)
if not defined PYTHON (
    if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe" (
        set PYTHON=C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe
    )
)
if not defined PYTHON (
    echo [ERROR] Python not found. Install Python 3.10+ from python.org
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [OK] Python found: %PYTHON%
%PYTHON% --version
echo.

:: Check NVIDIA GPU
echo Checking GPU...
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader >nul 2>&1
if %errorlevel%==0 (
    echo [OK] NVIDIA GPU detected:
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    set HAS_GPU=1
) else (
    echo [--] No NVIDIA GPU detected — will use CPU only
    set HAS_GPU=0
)
echo.

:: Install core dependencies
echo Installing core dependencies...
%PYTHON% -m pip install --quiet psutil requests pyyaml numpy polars yfinance
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)
echo [OK] Core dependencies installed
echo.

:: Install PyTorch (CUDA or CPU)
if "%HAS_GPU%"=="1" (
    echo Installing PyTorch with CUDA support (this may take a few minutes)...
    %PYTHON% -m pip install torch --index-url https://download.pytorch.org/whl/cu124 --quiet
    if %errorlevel% neq 0 (
        echo [WARN] CUDA torch failed — falling back to CPU version
        %PYTHON% -m pip install torch --quiet
    )
) else (
    echo Installing PyTorch (CPU only)...
    %PYTHON% -m pip install torch --quiet
)
echo [OK] PyTorch installed
echo.

:: Verify
echo ============================================================
echo   Verification
echo ============================================================
%PYTHON% -c "import psutil; print(f'  CPUs: {psutil.cpu_count()}'); print(f'  RAM: {round(psutil.virtual_memory().total/1024**3,1)} GB')"
%PYTHON% -c "import torch; cuda=torch.cuda.is_available(); print(f'  CUDA: {cuda}'); gpu=torch.cuda.get_device_name(0) if cuda else 'CPU only'; print(f'  GPU: {gpu}')"
echo.

echo ============================================================
echo   Setup Complete!
echo ============================================================
echo.
echo To start the worker:
echo   Hybrid mode:  start_hybrid.bat  (recommended)
echo   Max compute:  start_max.bat     (overnight)
echo   Dev mode:     start_dev.bat     (light)
echo.
echo The worker will automatically:
echo   - Connect to https://auraalpha.cc
echo   - Register this machine
echo   - Start processing research jobs
echo   - Adapt to your CPU/GPU load
echo.
pause
