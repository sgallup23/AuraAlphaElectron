// GPU acceleration setup — one-time post-install offer.
//
// After the app's first launch (and the basic CPU deps install), if the
// machine has an NVIDIA GPU but no `torch` with CUDA, prompt the user to
// install it as a side download. Accepted: ~10–20× faster grid throughput.
// Declined: persisted so we don't ask again.
//
// Lives in the main process. Triggered from main.js after the worker
// auto-starts. Non-blocking, fully async, fails closed (no popup) if any
// detection step errors.

const { dialog, app } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'gpu_setup.json');

// Pinned wheel index for the only Python version we currently support
// for the bundled worker. cu126 is the highest stable wheel for cp314 as of
// 2026-04-27. If a future release changes the Python pin, update this.
const TORCH_WHEEL_INDEX = 'https://download.pytorch.org/whl/cu126';
const ESTIMATED_DOWNLOAD_MB = 2100; // ~2.1 GB
const ESTIMATED_SPEEDUP = '10–20×';

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  } catch (err) {
    // non-fatal — worst case we ask again next launch
  }
}

// Detect a usable NVIDIA GPU via nvidia-smi. Returns the first device name,
// or null if no GPU / driver / smi binary.
function detectNvidiaGpu() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      stdio: 'pipe',
      timeout: 4000,
    }).toString().trim();
    if (!out || /not found|N\/A/i.test(out)) return null;
    return out.split('\n')[0].trim();
  } catch (_) {
    return null;
  }
}

// Check whether torch with CUDA is importable. Returns true only if both
// torch is importable AND torch.cuda.is_available() is True.
function hasTorchCuda(python) {
  try {
    const out = execFileSync(
      python,
      ['-c', 'import torch,sys;sys.stdout.write("YES" if torch.cuda.is_available() else "NO")'],
      { stdio: 'pipe', timeout: 15000 },
    ).toString().trim();
    return out === 'YES';
  } catch (_) {
    return false;
  }
}

// Spawn the pip install in the background. Streams progress to onLog.
// Calls onDone(success, errorMessage) when finished.
function installTorchCuda(python, onLog, onDone) {
  const args = [
    '-m', 'pip', 'install', '--user',
    'torch',
    '--index-url', TORCH_WHEEL_INDEX,
  ];
  onLog && onLog('[gpu-setup] Starting torch+CUDA download (~2 GB, runs in background)…');
  const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let lastLine = '';
  const emit = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t === lastLine) continue;
      lastLine = t;
      // Only forward useful progress lines, not pip's noisy progress bar
      if (/Downloading|Collecting torch|Installing collected|Successfully installed|ERROR|error:/i.test(t)) {
        onLog && onLog(`[gpu-setup] ${t}`);
      }
    }
  };
  proc.stdout.on('data', emit);
  proc.stderr.on('data', emit);
  proc.on('exit', (code) => {
    if (code === 0) {
      onLog && onLog('[gpu-setup] torch+CUDA installed. Restart the worker to enable GPU.');
      onDone && onDone(true, null);
    } else {
      onLog && onLog(`[gpu-setup] install failed (exit ${code})`);
      onDone && onDone(false, `pip exited ${code}`);
    }
  });
  proc.on('error', (err) => {
    onLog && onLog(`[gpu-setup] spawn error: ${err.message}`);
    onDone && onDone(false, err.message);
  });
  return proc;
}

// Public: run the one-time detection + popup flow.
// Safe to call repeatedly — it self-skips if already accepted, declined,
// or if the box doesn't have an NVIDIA GPU.
//
// findPython: () => string|null  — same helper worker.js uses
// onLog:      (msg) => void      — log sink (forwarded to renderer)
// onInstalled: () => void        — called on successful install (so caller
//                                  can restart the worker with GPU enabled)
async function maybeOfferGpuInstall({ findPython, onLog, onInstalled, parentWindow } = {}) {
  try {
    const settings = loadSettings();
    if (settings.declined || settings.installed) return;

    const gpu = detectNvidiaGpu();
    if (!gpu) return; // no GPU, nothing to offer

    const python = findPython && findPython();
    if (!python) return; // can't install without python; the basic-deps path will surface it first

    if (hasTorchCuda(python)) {
      // already installed (e.g. user pre-installed it) — record so we never re-prompt
      saveSettings({ ...settings, installed: true, installed_at: new Date().toISOString() });
      return;
    }

    const choice = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: 'Enable GPU acceleration?',
      message: 'GPU acceleration available',
      detail:
        `We detected an NVIDIA GPU (${gpu}). ` +
        `Installing GPU compute support gives ${ESTIMATED_SPEEDUP} faster research throughput on this machine.\n\n` +
        `One-time download: ~${ESTIMATED_DOWNLOAD_MB} MB. Runs in the background — Aura Alpha stays usable while it installs.`,
      buttons: ['Install', 'Skip'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (choice.response !== 0) {
      saveSettings({ ...settings, declined: true, declined_at: new Date().toISOString() });
      onLog && onLog('[gpu-setup] User declined GPU install — will not ask again.');
      return;
    }

    onLog && onLog(`[gpu-setup] User accepted. Installing torch+CUDA for ${gpu}…`);
    installTorchCuda(python, onLog, (success, err) => {
      if (success) {
        saveSettings({ ...settings, installed: true, installed_at: new Date().toISOString() });
        onInstalled && onInstalled();
      } else {
        // Don't record decline — user accepted but install failed, so we can retry next launch.
        saveSettings({ ...settings, last_error: err || 'unknown', last_error_at: new Date().toISOString() });
      }
    });
  } catch (err) {
    // never let this crash the app — log and move on
    onLog && onLog(`[gpu-setup] unexpected error: ${err.message}`);
  }
}

module.exports = { maybeOfferGpuInstall };
