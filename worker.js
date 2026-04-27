const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let workerProcess = null;
let workerMode = null;
let workerStartTime = null;
let jobsCompleted = 0;
let restartCount = 0;
let logCallback = null;

const MAX_RESTARTS = 3;
const DEFAULT_COORDINATOR_URL = 'https://auraalpha.cc';

// ── Find Python executable ────────────────────────────────────────────
function findPython() {
  const candidates = ['python3', 'python'];

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Python314\\python.exe',
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
    );
    // Search common user install locations
    const userHome = os.homedir();
    for (const ver of ['314', '313', '312', '311', '310']) {
      candidates.push(
        path.join(userHome, 'AppData', 'Local', 'Programs', 'Python', `Python${ver}`, 'python.exe'),
      );
    }
  }

  for (const cmd of candidates) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 5000 });
      return cmd;
    } catch (_) { /* try next */ }
  }
  return null;
}

// ── Ensure required Python deps are installed ─────────────────────────
// The grid worker needs numpy/polars/psutil/requests/pyyaml/yfinance to run
// any actual job. Without them, worker.py starts (its top-level imports are
// stdlib-only) but every job fails with ModuleNotFoundError, so the box
// looks busy on the leaderboard but contributes zero results. This was the
// root cause of the 2026-04-26/27 tradinglaptop-local production stall.
//
// We pip-install --user (no admin needed) on every launch; pip is fast on
// already-satisfied deps so the no-op cost is ~1s. Failures here are
// non-fatal — worker.py will still try and surface a clear error.
const REQUIRED_PY_DEPS = [
  'numpy>=1.24.0', 'polars>=0.20.0', 'psutil>=5.9.0',
  'requests>=2.28.0', 'pyyaml>=6.0', 'yfinance>=0.2.0',
  // scipy enables the lfilter fast path for EMA/RSI in worker.py
  // (16×/7× speedup, numerically identical to the Python loop).
  'scipy>=1.11.0',
];

function ensurePythonDeps(python, onLog) {
  try {
    const { execFileSync } = require('child_process');
    onLog && onLog('[worker] Checking Python dependencies...');
    execFileSync(
      python,
      ['-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', ...REQUIRED_PY_DEPS],
      { stdio: 'pipe', timeout: 120000 },
    );
    onLog && onLog('[worker] Python dependencies satisfied');
    return true;
  } catch (err) {
    const msg = (err && err.stderr) ? err.stderr.toString().slice(0, 400) : String(err).slice(0, 400);
    onLog && onLog(`[worker] dep install warning (continuing): ${msg}`);
    return false;
  }
}

// ── Find worker.py ────────────────────────────────────────────────────
function findWorkerScript() {
  // When packaged, extraResources lives at process.resourcesPath/grid_worker/
  // Fall back to dev paths when running from source.
  const searchPaths = [];

  // 1. Packaged installer: resources/grid_worker/worker.py
  if (process.resourcesPath) {
    searchPaths.push(path.join(process.resourcesPath, 'grid_worker', 'worker.py'));
  }
  // 2. Local dev: grid_worker/ next to this file
  searchPaths.push(path.join(__dirname, 'grid_worker', 'worker.py'));
  // 3. Dev fallbacks
  searchPaths.push(
    path.join(__dirname, '..', 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(os.homedir(), 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(os.homedir(), 'AuraCommandV2', 'frontend', 'grid_worker', 'worker.py'),
    path.join(__dirname, 'worker.py'),
  );

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Parse stdout for job completion ───────────────────────────────────
function parseOutput(data) {
  const text = data.toString();
  // Look for common patterns like "Completed job" or "jobs: N"
  const match = text.match(/(?:completed|finished|done).*?(\d+)/i);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n > jobsCompleted) jobsCompleted = n;
  }
  // Also count lines containing "result" or "completed" as individual jobs
  const lines = text.split('\n');
  for (const line of lines) {
    if (/(?:result|completed job|task done|batch done)/i.test(line)) {
      jobsCompleted++;
    }
  }
  return text.trim();
}

// ── Start worker ──────────────────────────────────────────────────────
// `coordinatorUrl` is passed in by main.js after network-config resolves the
// best reachable endpoint (handles xFi/SafeDNS-style network filters by
// falling through primary → backup → direct IP → user-supplied tunnel URL).
function startWorker(mode, onLog, coordinatorUrl) {
  if (workerProcess) {
    return { success: false, error: 'Worker already running' };
  }

  const python = findPython();
  if (!python) {
    return { success: false, error: 'Python not found. Install Python 3.10+ and add to PATH.' };
  }

  const script = findWorkerScript();
  if (!script) {
    return { success: false, error: 'worker.py not found. Place it in grid_worker/ directory.' };
  }

  logCallback = onLog || (() => {});
  workerMode = mode || 'compute';
  jobsCompleted = 0;
  workerStartTime = Date.now();

  // Install/refresh Python dependencies before spawning. Non-blocking on
  // failure — worker.py will still launch and emit a clear error if
  // numpy/etc are still missing.
  ensurePythonDeps(python, logCallback);

  const url = (coordinatorUrl && typeof coordinatorUrl === 'string' && coordinatorUrl.trim())
    ? coordinatorUrl.trim()
    : DEFAULT_COORDINATOR_URL;

  const args = [
    script,
    '--coordinator-url', url,
    '--mode', workerMode,
    '--max-parallel', '20',
  ];

  const env = { ...process.env, BATCH_SIZE: '25' };

  try {
    workerProcess = spawn(python, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    logCallback(`[worker] Started PID ${workerProcess.pid} (${python} ${workerMode} mode)`);

    workerProcess.stdout.on('data', (data) => {
      const msg = parseOutput(data);
      if (msg) logCallback(`[worker:stdout] ${msg}`);
    });

    workerProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logCallback(`[worker:stderr] ${msg}`);
    });

    workerProcess.on('exit', (code, signal) => {
      logCallback(`[worker] Exited (code=${code}, signal=${signal})`);
      const pid = workerProcess?.pid;
      workerProcess = null;

      // Auto-restart on crash (not on intentional stop)
      if (code !== 0 && code !== null && restartCount < MAX_RESTARTS) {
        restartCount++;
        logCallback(`[worker] Auto-restart attempt ${restartCount}/${MAX_RESTARTS}...`);
        setTimeout(() => startWorker(workerMode, logCallback), 2000);
      } else if (restartCount >= MAX_RESTARTS) {
        logCallback(`[worker] Max restarts (${MAX_RESTARTS}) reached. Giving up.`);
        restartCount = 0;
      }
    });

    workerProcess.on('error', (err) => {
      logCallback(`[worker] Spawn error: ${err.message}`);
      workerProcess = null;
    });

    restartCount = 0;
    return { success: true, pid: workerProcess.pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Stop worker ───────────────────────────────────────────────────────
function stopWorker() {
  if (!workerProcess) {
    return { success: true, message: 'Worker not running' };
  }

  const pid = workerProcess.pid;
  restartCount = MAX_RESTARTS; // Prevent auto-restart

  try {
    workerProcess.kill('SIGTERM');
  } catch (_) { /* ignore */ }

  // Force kill after 5 seconds
  const forceKillTimer = setTimeout(() => {
    try {
      if (workerProcess) {
        workerProcess.kill('SIGKILL');
        if (logCallback) logCallback(`[worker] Force killed PID ${pid}`);
      }
    } catch (_) { /* ignore */ }
  }, 5000);

  workerProcess.once('exit', () => {
    clearTimeout(forceKillTimer);
    workerProcess = null;
    restartCount = 0;
  });

  if (logCallback) logCallback(`[worker] Stopping PID ${pid}...`);
  return { success: true, pid };
}

// ── Get status ────────────────────────────────────────────────────────
function getStatus() {
  return {
    running: workerProcess !== null,
    pid: workerProcess?.pid || null,
    mode: workerMode,
    jobsCompleted,
    uptimeSeconds: workerStartTime
      ? Math.round((Date.now() - workerStartTime) / 1000)
      : 0,
    restartCount,
  };
}

module.exports = { startWorker, stopWorker, getStatus, findPython };
