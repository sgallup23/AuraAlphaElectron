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
// Captured at startWorker() so auto-restart can re-launch with the same
// settings (token, coordinator URL, worker-id) instead of falling back
// to env vars and a hostname-derived id.
let lastCoordinatorUrl = null;
let lastToken = null;
let lastWorkerId = null;

const MAX_RESTARTS = 3;
// Tailnet-first default. main.js passes the resolved URL after probing, so
// this is only used if the resolver hasn't run yet (rare).
const DEFAULT_COORDINATOR_URL = 'http://prodesk-ec2:8020';

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
// CPU-only deps the standalone worker needs to run any job. torch+CUDA is
// NOT in this list — it's a separate consent-gated download handled by
// gpu_setup.js (maybeOfferGpuInstall) so users explicitly choose to fetch
// the ~2 GB CUDA wheel. Without torch the worker still runs the CPU lane
// (xgboost/lightgbm/sklearn/scipy all work CPU-only).
const REQUIRED_PY_DEPS = [
  'numpy>=1.24.0', 'polars>=0.20.0', 'pandas>=2.0.0', 'psutil>=5.9.0',
  'requests>=2.28.0', 'pyyaml>=6.0', 'yfinance>=0.2.0',
  'scipy>=1.11.0',
  'xgboost>=2.0.0', 'lightgbm>=4.0.0', 'optuna>=3.4.0', 'scikit-learn>=1.3.0',
];

function ensurePythonDeps(python, onLog) {
  try {
    const { execFileSync } = require('child_process');
    onLog && onLog('[worker] Checking Python dependencies...');
    execFileSync(
      python,
      ['-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', ...REQUIRED_PY_DEPS],
      { stdio: 'pipe', timeout: 180000 },
    );
    onLog && onLog('[worker] Python dependencies satisfied (CPU set)');
    return true;
  } catch (err) {
    const msg = (err && err.stderr) ? err.stderr.toString().slice(0, 400) : String(err).slice(0, 400);
    onLog && onLog(`[worker] dep install warning (continuing): ${msg}`);
    return false;
  }
}

// ── Find grid_worker directory ────────────────────────────────────────
// Returns the directory containing the `standalone/` Python package.
// We launch the worker via `python -m standalone` from this cwd, which
// runs the canonical, parity-tested bundled module — not the legacy
// 107 KB worker.py which had the 96% ml_train fail rate.
function findGridWorkerDir() {
  const searchPaths = [];

  // 1. Packaged installer: resources/grid_worker/standalone/
  if (process.resourcesPath) {
    searchPaths.push(path.join(process.resourcesPath, 'grid_worker'));
  }
  // 2. Local dev: grid_worker/ next to this file
  searchPaths.push(path.join(__dirname, 'grid_worker'));
  // 3. Dev fallbacks
  searchPaths.push(
    path.join(os.homedir(), 'AuraAlphaElectron', 'grid_worker'),
  );

  for (const p of searchPaths) {
    if (fs.existsSync(path.join(p, 'standalone', '__main__.py'))) return p;
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

// ── Mode → standalone-worker flag mapping ─────────────────────────────
// dev    = light footprint, just research_backtest + signal_gen for testing
// hybrid = standard fleet contributor with broad job-type coverage (no GPU)
// max    = full set, full parallelism — what we run on our internal fleet
const MODE_FLAGS = {
  dev:    { parallel: 4,  batch: 4,  jobTypes: 'research_backtest,backtest,signal_gen' },
  hybrid: { parallel: 8,  batch: 8,  jobTypes: 'optimization,research_backtest,signal_gen,alpha_factory,ohlcv_refresh,backtest' },
  max:    { parallel: 14, batch: 12, jobTypes: '' /* empty = all server-allowed types */ },
};

// ── Start worker ──────────────────────────────────────────────────────
// Spawns `python -m standalone` with mode-derived flags. The Python side
// is the canonical bundled module at grid_worker/standalone/, kept in
// parity with prodesk's distributed_research/standalone/ and verified
// before each release. The legacy grid_worker/worker.py is no longer
// invoked by this function.
//
// `coordinatorUrl` is passed by main.js after network-config resolves the
// best reachable endpoint (handles xFi/SafeDNS-style filters by falling
// through primary → backup → direct IP → user-supplied tunnel URL).
//
// Token resolution order:
//   1. token argument (preferred — main.js reads it from the user's
//      authenticated session and passes it in)
//   2. AURA_TOKEN environment variable
// If neither is present, we refuse to start and surface a clear message
// to the renderer so the user can sign in.
function startWorker(mode, onLog, coordinatorUrl, token, workerId) {
  if (workerProcess) {
    return { success: false, error: 'Worker already running' };
  }

  const python = findPython();
  if (!python) {
    return { success: false, error: 'Python not found. Install Python 3.10+ and add to PATH.' };
  }

  const gridDir = findGridWorkerDir();
  if (!gridDir) {
    return { success: false, error: 'grid_worker/standalone/ not found in app resources.' };
  }

  const resolvedToken = (token && String(token).trim()) || process.env.AURA_TOKEN || '';
  if (!resolvedToken) {
    return {
      success: false,
      error: 'No contributor token available. Sign in to Aura Alpha to enable the grid worker.',
    };
  }

  logCallback = onLog || (() => {});
  workerMode = mode || 'hybrid';
  jobsCompleted = 0;
  workerStartTime = Date.now();
  lastCoordinatorUrl = coordinatorUrl || null;
  lastToken = resolvedToken;

  // Install/refresh CPU-only Python deps before spawning. torch+CUDA is
  // NOT installed here — that's gpu_setup.js's consent-gated path.
  ensurePythonDeps(python, logCallback);

  const url = (coordinatorUrl && typeof coordinatorUrl === 'string' && coordinatorUrl.trim())
    ? coordinatorUrl.trim()
    : DEFAULT_COORDINATOR_URL;

  const flags = MODE_FLAGS[workerMode] || MODE_FLAGS.hybrid;
  const resolvedWorkerId = (workerId && String(workerId).trim()) ||
                           `${os.hostname()}-electron`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  lastWorkerId = resolvedWorkerId;

  const args = [
    '-m', 'standalone',
    '--token', resolvedToken,
    '--coordinator-url', url,
    '--worker-id', resolvedWorkerId,
    '--max-parallel', String(flags.parallel),
    '--batch-size', String(flags.batch),
    // Always skip the Python-side CUDA bootstrap; gpu_setup.js owns that
    // flow with explicit user consent + ~2 GB download dialog.
    '--skip-cuda-bootstrap',
  ];
  if (flags.jobTypes) args.push('--job-types', flags.jobTypes);

  // Env-var bias still honored: AURA_JOB_TYPES overrides --job-types if
  // set on the process (used during 2026-04-27 GPU-fleet triage to bias
  // 4090 boxes toward ml_train). Standalone reads this via config.py.
  const env = {
    ...process.env,
    AURA_SKIP_CUDA_BOOTSTRAP: '1', // belt + suspenders next to --skip-cuda-bootstrap
  };

  try {
    workerProcess = spawn(python, args, {
      cwd: gridDir, // so `-m standalone` resolves to grid_worker/standalone/
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    logCallback(`[worker] Started PID ${workerProcess.pid} (${python} mode=${workerMode} parallel=${flags.parallel} batch=${flags.batch})`);

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

      // Auto-restart on crash (not on intentional stop). Reuse the same
      // coordinator URL / token / worker-id so the restart isn't a different
      // worker from the API's perspective.
      if (code !== 0 && code !== null && restartCount < MAX_RESTARTS) {
        restartCount++;
        logCallback(`[worker] Auto-restart attempt ${restartCount}/${MAX_RESTARTS}...`);
        setTimeout(() => startWorker(workerMode, logCallback, lastCoordinatorUrl, lastToken, lastWorkerId), 2000);
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
