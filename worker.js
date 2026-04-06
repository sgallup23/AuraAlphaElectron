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
const COORDINATOR_URL = 'https://auraalpha.cc';

// ── Find Python executable ────────────────────────────────────────────
function findPython() {
  const candidates = ['python3', 'python'];

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Python311\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python313\\python.exe',
    );
    // Search common user install locations
    const userHome = os.homedir();
    for (const ver of ['311', '312', '313', '310']) {
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

// ── Find worker.py ────────────────────────────────────────────────────
function findWorkerScript() {
  const searchPaths = [
    path.join(__dirname, 'grid_worker', 'worker.py'),
    path.join(__dirname, '..', 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(os.homedir(), 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(os.homedir(), 'AuraCommandV2', 'frontend', 'grid_worker', 'worker.py'),
    path.join(__dirname, 'worker.py'),
  ];

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
function startWorker(mode, onLog) {
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

  const args = [
    script,
    '--coordinator-url', COORDINATOR_URL,
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

module.exports = { startWorker, stopWorker, getStatus };
