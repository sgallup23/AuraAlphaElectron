const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let workerProcess = null;
let workerMode = null;
let workerStartTime = null;
let jobsCompleted = 0;
let restartCount = 0;
let logCallback = null;
let setupComplete = false;

const MAX_RESTARTS = 3;
const COORDINATOR_URL = 'https://auraalpha.cc';
const AURA_DIR = path.join(os.homedir(), '.aura-worker');

// ── Resolve resource path (works in dev AND packaged app) ──────────
function resourcePath(...parts) {
  const base = process.resourcesPath || __dirname;
  return path.join(base, ...parts);
}

// ── Find Python executable (cross-platform) ─────────────────────────
function findPython() {
  // 1. Bundled Python (always works, no install needed)
  const embeddedExe = process.platform === 'win32' ? 'python.exe' : 'python3';
  const embedded = resourcePath('resources', 'python-embed', embeddedExe);
  if (fs.existsSync(embedded)) return embedded;

  // Also check dev path
  const devEmbed = path.join(__dirname, 'resources', 'python-embed', embeddedExe);
  if (fs.existsSync(devEmbed)) return devEmbed;

  // 2. System Python — platform-specific paths first, then generic
  const candidates = [];

  if (process.platform === 'win32') {
    // Windows: check common install locations
    const userHome = os.homedir();
    for (const ver of ['312', '313', '311', '310']) {
      candidates.push(
        path.join(userHome, 'AppData', 'Local', 'Programs', 'Python', `Python${ver}`, 'python.exe'),
      );
    }
    candidates.push(
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Python313\\python.exe',
      'C:\\Python310\\python.exe',
    );
    // Try generic commands last on Windows
    candidates.push('python', 'python3');
  } else if (process.platform === 'darwin') {
    // macOS: Homebrew (arm64 + Intel), system, pyenv
    candidates.push(
      '/opt/homebrew/bin/python3',          // Homebrew ARM64 (Apple Silicon)
      '/usr/local/bin/python3',             // Homebrew Intel
      '/usr/bin/python3',                   // System Python
      path.join(os.homedir(), '.pyenv', 'shims', 'python3'), // pyenv
    );
    candidates.push('python3', 'python');
  } else {
    // Linux: standard paths
    candidates.push(
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/snap/bin/python3',                  // Snap package
      path.join(os.homedir(), '.pyenv', 'shims', 'python3'), // pyenv
      '/usr/bin/python',
    );
    candidates.push('python3', 'python');
  }

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 5000 });
      return cmd;
    } catch (_) { /* try next */ }
  }
  return null;
}

// ── Find worker.py ────────────────────────────────────────────────────
function findWorkerScript() {
  const searchPaths = [
    // Bundled in resources (packaged app)
    resourcePath('resources', 'grid_worker', 'worker.py'),
    // Dev paths
    path.join(__dirname, 'resources', 'grid_worker', 'worker.py'),
    path.join(__dirname, 'grid_worker', 'worker.py'),
    path.join(__dirname, '..', 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(os.homedir(), 'AuraCommandV2', 'grid_worker', 'worker.py'),
    path.join(__dirname, 'worker.py'),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── First-run setup: ensure pip + dependencies ────────────────────────
function ensureDependencies(python, onProgress) {
  const flagFile = path.join(AURA_DIR, 'deps_installed_v8');

  if (fs.existsSync(flagFile)) {
    return { success: true, cached: true };
  }

  // Create .aura-worker dir
  if (!fs.existsSync(AURA_DIR)) {
    fs.mkdirSync(AURA_DIR, { recursive: true });
  }

  onProgress('Installing Python dependencies... (first run only)');

  try {
    // Enable pip in embedded Python (modify ._pth file) — Windows only
    if (process.platform === 'win32') {
      const pythonDir = path.dirname(python);
      const pthFiles = fs.readdirSync(pythonDir).filter(f => f.endsWith('._pth'));
      for (const pth of pthFiles) {
        const pthPath = path.join(pythonDir, pth);
        let content = fs.readFileSync(pthPath, 'utf-8');
        if (content.includes('#import site')) {
          content = content.replace('#import site', 'import site');
          fs.writeFileSync(pthPath, content);
        }
      }
    }

    // Install pip via ensurepip
    onProgress('Installing pip...');
    try {
      execFileSync(python, ['-m', 'ensurepip', '--default-pip'], {
        stdio: 'pipe', timeout: 60000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (e) {
      // pip might already be installed
      onProgress('pip already available');
    }

    // Install requirements
    const workerScript = findWorkerScript();
    const reqFile = workerScript
      ? path.join(path.dirname(workerScript), 'requirements.txt')
      : null;

    if (reqFile && fs.existsSync(reqFile)) {
      onProgress('Installing numpy, polars, psutil, requests...');
      execFileSync(python, ['-m', 'pip', 'install', '--quiet', '-r', reqFile], {
        stdio: 'pipe', timeout: 300000, // 5 min max
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    } else {
      // Install core deps directly
      onProgress('Installing core dependencies...');
      execFileSync(python, ['-m', 'pip', 'install', '--quiet',
        'psutil', 'requests', 'pyyaml', 'numpy', 'polars'], {
        stdio: 'pipe', timeout: 300000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    }

    // Write flag file
    fs.writeFileSync(flagFile, JSON.stringify({
      installed_at: new Date().toISOString(),
      python: python,
      platform: process.platform,
      arch: process.arch,
    }));

    onProgress('Dependencies installed!');
    return { success: true, cached: false };
  } catch (err) {
    onProgress(`Dependency install failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Full setup (called on first launch) ───────────────────────────────
function setup(onProgress) {
  onProgress = onProgress || (() => {});

  const python = findPython();
  if (!python) {
    return { success: false, error: 'Python not found. The app should bundle Python — this is a build error.' };
  }
  onProgress(`Python found: ${python}`);

  const script = findWorkerScript();
  if (!script) {
    return { success: false, error: 'worker.py not found. The app should bundle it — this is a build error.' };
  }
  onProgress(`Worker: ${script}`);

  const deps = ensureDependencies(python, onProgress);
  if (!deps.success) {
    return { success: false, error: `Dependency install failed: ${deps.error}` };
  }

  setupComplete = true;
  onProgress('Setup complete — ready to compute!');
  return { success: true, python, script };
}

// ── Parse stdout for job completion ───────────────────────────────────
function parseOutput(data) {
  const text = data.toString();
  const lines = text.split('\n');
  for (const line of lines) {
    if (/batch done|completed/i.test(line)) {
      jobsCompleted++;
    }
    // Parse "Batch done: 25 completed" pattern
    const match = line.match(/Batch done: (\d+) completed/i);
    if (match) {
      jobsCompleted += parseInt(match[1], 10) - 1; // -1 because we already counted the line
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
    return { success: false, error: 'Python not found.' };
  }

  const script = findWorkerScript();
  if (!script) {
    return { success: false, error: 'worker.py not found.' };
  }

  logCallback = onLog || (() => {});
  workerMode = mode || 'hybrid';
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

    logCallback(`[worker] Started PID ${workerProcess.pid} (${workerMode} mode)`);

    workerProcess.stdout.on('data', (data) => {
      const msg = parseOutput(data);
      if (msg) logCallback(`[worker] ${msg}`);
    });

    workerProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logCallback(`[worker:err] ${msg}`);
    });

    workerProcess.on('exit', (code, signal) => {
      logCallback(`[worker] Exited (code=${code}, signal=${signal})`);
      workerProcess = null;

      if (code !== 0 && code !== null && restartCount < MAX_RESTARTS) {
        restartCount++;
        logCallback(`[worker] Auto-restart ${restartCount}/${MAX_RESTARTS}...`);
        setTimeout(() => startWorker(workerMode, logCallback), 2000);
      } else if (restartCount >= MAX_RESTARTS) {
        logCallback(`[worker] Max restarts reached.`);
        restartCount = 0;
      }
    });

    workerProcess.on('error', (err) => {
      logCallback(`[worker] Error: ${err.message}`);
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
    return { success: true, message: 'Not running' };
  }

  const pid = workerProcess.pid;
  restartCount = MAX_RESTARTS; // Prevent auto-restart

  try {
    if (process.platform === 'win32') {
      workerProcess.kill('SIGTERM');
    } else {
      workerProcess.kill('SIGTERM');
    }
  } catch (_) {}

  const forceKill = setTimeout(() => {
    try { if (workerProcess) workerProcess.kill('SIGKILL'); } catch (_) {}
  }, 5000);

  workerProcess.once('exit', () => {
    clearTimeout(forceKill);
    workerProcess = null;
    restartCount = 0;
  });

  if (logCallback) logCallback(`[worker] Stopping PID ${pid}...`);
  return { success: true, pid };
}

// ── Restart worker ───────────────────────────────────────────────────
function restartWorker(onLog) {
  const currentMode = workerMode || 'hybrid';
  const currentLogCallback = onLog || logCallback || (() => {});

  if (workerProcess) {
    currentLogCallback('[worker] Stopping for restart...');
    stopWorker();

    // Wait for process to actually exit, then start again
    const waitForStop = () => {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (!workerProcess) {
            clearInterval(check);
            resolve();
          }
        }, 200);
        // Max wait 6s then force proceed
        setTimeout(() => {
          clearInterval(check);
          workerProcess = null;
          restartCount = 0;
          resolve();
        }, 6000);
      });
    };

    waitForStop().then(() => {
      currentLogCallback('[worker] Restarting...');
      startWorker(currentMode, currentLogCallback);
    });

    return { success: true, message: 'Restarting...' };
  } else {
    currentLogCallback('[worker] Not running — starting fresh...');
    return startWorker(currentMode, currentLogCallback);
  }
}

// ── Get status ────────────────────────────────────────────────────────
function getStatus() {
  return {
    running: workerProcess !== null,
    pid: workerProcess?.pid || null,
    mode: workerMode,
    jobsCompleted,
    uptimeSeconds: workerStartTime ? Math.round((Date.now() - workerStartTime) / 1000) : 0,
    restartCount,
    setupComplete,
  };
}

module.exports = { setup, startWorker, stopWorker, restartWorker, getStatus };
