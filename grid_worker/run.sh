#!/usr/bin/env bash
# ============================================================
#  Aura Alpha Grid Worker -- macOS/Linux Runner
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -- Check venv exists --------------------------------------------
if [ ! -f "venv/bin/activate" ]; then
    echo "[ERROR] Virtual environment not found. Run ./setup.sh first."
    exit 1
fi

# -- Activate venv -------------------------------------------------
source venv/bin/activate

# -- Load .env into environment ------------------------------------
if [ -f ".env" ]; then
    set -a
    source <(grep -v '^\s*#' .env | grep -v '^\s*$')
    set +a
fi

# -- Auto-detect MAX_PARALLEL from hardware (if not set in .env) ---
# Constraint stack (take MIN):
#   (a) physical cores (HT lanes hurt BLAS/numpy throughput)
#   (b) RAM budget: (avail_ram_gb - reserve) / per_job_gb
#   (c) GPU lane (if CUDA): VRAM_free / vram_per_job
# Override per-host by setting MAX_PARALLEL in .env or env.
RAM_RESERVE_GB="${RAM_RESERVE_GB:-8}"
RAM_PER_JOB_GB="${RAM_PER_JOB_GB:-6}"
VRAM_PER_GPU_JOB_GB="${VRAM_PER_GPU_JOB_GB:-2}"

detect_phys_cpus() {
    local sockets cps
    sockets=$(lscpu 2>/dev/null | awk -F: '/^Socket\(s\):/ {gsub(/ /,"",$2); print $2}')
    cps=$(lscpu 2>/dev/null | awk -F: '/^Core\(s\) per socket:/ {gsub(/ /,"",$2); print $2}')
    if [ -n "$sockets" ] && [ -n "$cps" ] && [ "$sockets" -gt 0 ] && [ "$cps" -gt 0 ]; then
        echo $((sockets * cps))
    else
        # macOS fallback
        if command -v sysctl >/dev/null 2>&1; then
            sysctl -n hw.physicalcpu 2>/dev/null && return
        fi
        local n; n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
        echo $((n > 1 ? n / 2 : n))
    fi
}
detect_avail_ram_gb() {
    if [ -r /proc/meminfo ]; then
        local kb
        kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
        [ -z "$kb" ] || [ "$kb" -le 0 ] && kb=$(awk '/MemFree/ {print $2}' /proc/meminfo)
        echo $((kb / 1024 / 1024))
    elif command -v sysctl >/dev/null 2>&1; then
        # macOS: total physical memory; conservative since "available" is harder
        local b; b=$(sysctl -n hw.memsize 2>/dev/null || echo 8589934592)
        echo $((b / 1024 / 1024 / 1024 / 2))   # use half as a conservative budget
    else
        echo 8
    fi
}
detect_vram_free_gb() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        local v; v=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1)
        [ -n "$v" ] && [ "$v" -gt 0 ] && echo $((v / 1024)) && return
    fi
    python -c 'import torch,sys
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0).total_memory
    print(int(p/1024**3))
else:
    sys.exit(0)' 2>/dev/null || echo 0
}

if [ -z "$MAX_PARALLEL" ]; then
    PHYS=$(detect_phys_cpus)
    RAM_AVAIL=$(detect_avail_ram_gb)
    VRAM_FREE=$(detect_vram_free_gb)

    # GPU contribution: each GPU slot also uses host RAM for the worker process
    GPU_PAR=0
    if [ "${VRAM_FREE:-0}" -ge 2 ]; then
        GPU_PAR=$(( VRAM_FREE / VRAM_PER_GPU_JOB_GB ))
        [ "$GPU_PAR" -gt 4 ] && GPU_PAR=4
    fi

    RAM_FOR_CPU=$(( RAM_AVAIL - RAM_RESERVE_GB - GPU_PAR * RAM_PER_JOB_GB ))
    [ "$RAM_FOR_CPU" -lt 0 ] && RAM_FOR_CPU=0
    BY_RAM=$(( RAM_FOR_CPU / RAM_PER_JOB_GB ))

    AUTO=$PHYS
    [ "$BY_RAM" -lt "$AUTO" ] && AUTO=$BY_RAM
    AUTO=$(( AUTO + GPU_PAR ))   # GPU adds slots on top of CPU slots
    [ "$AUTO" -lt 2 ] && AUTO=2

    MAX_PARALLEL=$AUTO
    echo "[run.sh] auto-sized MAX_PARALLEL=$MAX_PARALLEL  (phys=$PHYS ram_avail=${RAM_AVAIL}GB vram_free=${VRAM_FREE}GB cpu_by_ram=$BY_RAM gpu=$GPU_PAR)"
fi

# -- Build args ----------------------------------------------------
ARGS=""
[ -n "$COORDINATOR_URL"   ] && ARGS="$ARGS --coordinator-url $COORDINATOR_URL"
[ -n "$MAX_PARALLEL"      ] && ARGS="$ARGS --max-parallel $MAX_PARALLEL"
[ -n "$GRID_WORKER_TOKEN" ] && ARGS="$ARGS --token $GRID_WORKER_TOKEN"

echo ""
echo "  Starting Aura Alpha Grid Worker..."
echo "  Press Ctrl+C to stop."
echo ""

python worker.py $ARGS "$@"
