const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  session,
  protocol,
  net,
  safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initUpdater } = require('./updater');
const { startWorker, stopWorker, getStatus: getWorkerStatus, findPython } = require('./worker');
const { maybeOfferGpuInstall } = require('./gpu_setup');
const networkConfig = require('./network-config');

// ── Single instance lock ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── Paths ─────────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const stateFile = path.join(userDataPath, 'window-state.json');
const authFile = path.join(userDataPath, 'auth.json');

// ── Auth-token store (used by the grid worker) ────────────────────────
// The standalone Python worker requires a contributor token to register
// with the coordinator. The renderer signs the user in and pushes their
// token here via the `set-auth-token` IPC. We persist it on disk so the
// worker can auto-start on next launch without forcing a re-login.
//
// Storage uses Electron's safeStorage (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) when available; falls back to plaintext
// only if the platform truly can't encrypt. Falling back is logged so
// a user/operator can spot it.
let currentToken = null;

function loadStoredToken() {
  try {
    if (!fs.existsSync(authFile)) return null;
    const raw = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    if (raw && raw.encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')) || null;
      } catch (_) { return null; }
    }
    return (raw && typeof raw.token === 'string' && raw.token) || null;
  } catch (_) {
    return null;
  }
}

function persistToken(token) {
  try {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(String(token || ''));
      fs.writeFileSync(authFile, JSON.stringify({ encrypted: buf.toString('base64') }, null, 2));
    } else {
      console.warn('[auth] safeStorage not available — token persisted in plaintext');
      fs.writeFileSync(authFile, JSON.stringify({ token: String(token || '') }, null, 2));
    }
  } catch (err) {
    console.error('[auth] persistToken failed:', err.message);
  }
}

function clearPersistedToken() {
  try { fs.existsSync(authFile) && fs.unlinkSync(authFile); } catch (_) { /* ignore */ }
}
const isDev = !app.isPackaged;
const DIST_PATH = path.join(__dirname, 'dist');
// API_BASE is resolved at startup by network-config.js. Resolve order:
// custom → tailscale → primary → backups → direct IP. Default to TAILSCALE_URL
// so the fleet hits the tailnet first during the Google + Microsoft reputation
// warmup; non-tailnet clients fall through transparently.
let API_BASE = networkConfig.TAILSCALE_URL;
let API_SOURCE = 'tailscale';
const SCHEME = 'aura';

// ── Window state persistence ──────────────────────────────────────────
function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (_) { /* ignore */ }
  return { width: 1400, height: 900 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (_) { /* ignore */ }
}

// ── MIME types ────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.xml':  'application/xml',
  '.txt':  'text/plain',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.gz':   'application/gzip',
};

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ── Globals ───────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

// ── Custom protocol: serves dist/ files and proxies /api/* ───────────
// Register the scheme as privileged before app is ready
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

function setupProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const urlPath = decodeURIComponent(url.pathname);

    // Proxy /api/* requests to the production server
    if (urlPath.startsWith('/api/')) {
      const proxyUrl = `${API_BASE}${urlPath}${url.search}`;
      return net.fetch(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        duplex: request.method !== 'GET' && request.method !== 'HEAD' ? 'half' : undefined,
      });
    }

    // Serve static files from dist/
    let filePath = path.join(DIST_PATH, urlPath);

    // If path is a directory or doesn't exist, try index.html (SPA routing)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Check if path + index.html exists (directory index)
      const indexInDir = path.join(filePath, 'index.html');
      if (fs.existsSync(indexInDir)) {
        filePath = indexInDir;
      } else {
        // SPA fallback: serve index.html for client-side routing
        filePath = path.join(DIST_PATH, 'index.html');
      }
    }

    const mime = getMime(filePath);
    try {
      const data = fs.readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': mime },
      });
    } catch (err) {
      // 404 fallback to index.html for SPA
      try {
        const indexData = fs.readFileSync(path.join(DIST_PATH, 'index.html'));
        return new Response(indexData, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      } catch (_) {
        return new Response('Not Found', { status: 404 });
      }
    }
  });
}

// ── Create main window ───────────────────────────────────────────────
function createWindow() {
  const saved = loadWindowState();

  const winOpts = {
    width: saved.width || 1400,
    height: saved.height || 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0D1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  // Restore position if we have it
  if (saved.x !== undefined && saved.y !== undefined) {
    winOpts.x = saved.x;
    winOpts.y = saved.y;
  }

  // Dark title bar on Windows
  if (process.platform === 'win32') {
    winOpts.titleBarOverlay = {
      color: '#0D1117',
      symbolColor: '#8B949E',
      height: 32,
    };
  }

  mainWindow = new BrowserWindow(winOpts);

  if (saved.isMaximized) {
    mainWindow.maximize();
  }

  // Load via our custom protocol so absolute paths resolve correctly
  mainWindow.loadURL(`${SCHEME}://app/`);

  // Detect "boot autostart" launch — when the OS boots Aura with
  // --hidden (set by setLoginItemSettings) or macOS launches us hidden,
  // skip showing the window. The tray + worker still come up so research
  // runs in the background; the user can show the window from the tray.
  const launchHidden =
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);

  mainWindow.once('ready-to-show', () => {
    if (!launchHidden) mainWindow.show();
  });

  // Save state on move/resize
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('maximize', () => saveWindowState(mainWindow));
  mainWindow.on('unmaximize', () => saveWindowState(mainWindow));

  // Minimize to tray on close (don't quit)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // F12 dev tools in dev mode
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (isDev && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  return mainWindow;
}

// ── CORS bypass for direct API calls ─────────────────────────────────
function setupCorsBypass() {
  // If the React app makes direct calls to auraalpha.cc, strip CORS restrictions
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.url.startsWith(API_BASE)) {
      const headers = details.responseHeaders || {};
      headers['access-control-allow-origin'] = ['*'];
      headers['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS'];
      headers['access-control-allow-headers'] = ['*'];
      cb({ responseHeaders: headers });
    } else {
      cb({});
    }
  });
}

// ── System tray ──────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  const appVersion = app.getVersion();
  tray.setToolTip(`Aura Alpha v${appVersion}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Aura Alpha v${appVersion}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Worker Status',
      click: () => {
        const status = getWorkerStatus();
        const msg = status.running
          ? `Worker running (PID ${status.pid}, ${status.jobsCompleted} jobs, ${status.uptimeSeconds}s uptime)`
          : 'Worker stopped';
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('worker-log', msg);
        }
      },
    },
    {
      label: 'About',
      click: () => {
        const chromium = process.versions.chrome || '?';
        const electron = process.versions.electron || '?';
        const node = process.versions.node || '?';
        const detail = [
          `Aura Alpha Desktop v${appVersion}`,
          `Electron ${electron}`,
          `Chromium ${chromium}`,
          `Node ${node}`,
          `Platform ${process.platform} ${process.arch}`,
        ].join('\n');
        const { dialog } = require('electron');
        dialog.showMessageBox(mainWindow || null, {
          type: 'info',
          title: 'About Aura Alpha',
          message: `Aura Alpha Desktop v${appVersion}`,
          detail,
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        stopWorker();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-worker-status', () => getWorkerStatus());

  ipcMain.handle('start-worker', (_, mode) => {
    return startWorker(mode, (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('worker-log', msg);
      }
    }, API_BASE, currentToken);
  });

  ipcMain.handle('stop-worker', () => stopWorker());

  // ── Auth-token IPC ─────────────────────────────────────────────────
  // Renderer pushes the token here right after a successful sign-in.
  // Persists encrypted; replaces any in-flight worker so the new token
  // takes effect without forcing the user to restart the worker.
  ipcMain.handle('set-auth-token', (_, token) => {
    const t = (token && String(token).trim()) || '';
    if (!t) return { ok: false, error: 'Empty token' };
    currentToken = t;
    persistToken(t);
    return { ok: true };
  });

  ipcMain.handle('clear-auth-token', () => {
    currentToken = null;
    clearPersistedToken();
    try { stopWorker(); } catch (_) { /* ignore */ }
    return { ok: true };
  });

  ipcMain.handle('get-auth-state', () => ({
    hasToken: Boolean(currentToken),
  }));

  ipcMain.handle('get-system-info', () => {
    const cpus = os.cpus();
    return {
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'Unknown',
      totalRAM: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      freeRAM: Math.round(os.freemem() / (1024 * 1024 * 1024)),
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      gpu: 'Use chrome://gpu in DevTools to check',
    };
  });

  // ── Network config IPC (Tier 1: block detection + custom server URL) ─
  ipcMain.handle('network-get-status', () => ({
    apiBase: API_BASE,
    source: API_SOURCE,
    settings: networkConfig.loadSettings(),
  }));

  ipcMain.handle('network-get-settings', () => networkConfig.loadSettings());

  ipcMain.handle('network-save-settings', async (_, settings) => {
    const saved = networkConfig.saveSettings(settings || {});
    // Re-resolve immediately so the change takes effect without a restart
    const resolved = await networkConfig.resolveServerUrl();
    if (resolved.url) {
      API_BASE = resolved.url;
      API_SOURCE = resolved.source;
    }
    return { saved, apiBase: API_BASE, source: API_SOURCE };
  });

  ipcMain.handle('network-test-url', (_, url) => networkConfig.testCustomUrl(url));

  // ── Boot autostart (Windows/macOS) ─────────────────────────────────
  // Controls whether Aura Alpha auto-launches on system boot. When
  // enabled, the app starts hidden (tray-only) so it doesn't grab focus
  // on login. The grid worker auto-starts 3s after window-ready as long
  // as a token is present (see auto-start block ~line 567). Closing the
  // app stops the worker — no orphans.
  ipcMain.handle('autostart-get', () => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, openAtLogin: !!s.openAtLogin, openAsHidden: !!s.openAsHidden };
    } catch (err) {
      return { ok: false, error: err.message, openAtLogin: false };
    }
  });

  ipcMain.handle('autostart-set', (_, enabled) => {
    try {
      const want = !!enabled;
      app.setLoginItemSettings({
        openAtLogin: want,
        openAsHidden: want,        // macOS hint
        args: want ? ['--hidden'] : [],  // Windows: start minimized to tray
      });
      return { ok: true, openAtLogin: want };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  ipcMain.handle('network-resolve', async () => {
    const resolved = await networkConfig.resolveServerUrl();
    if (resolved.url) {
      API_BASE = resolved.url;
      API_SOURCE = resolved.source;
    }
    return resolved;
  });
}

// ── Friendly block-detection modal ───────────────────────────────────
async function handleNetworkBlock(probes) {
  const { dialog, shell } = require('electron');
  const ssl = probes.find((p) => p.errorClass === 'ssl_intercept');
  const redirect = probes.find((p) => p.errorClass === 'http_redirect');
  const dns = probes.find((p) => p.errorClass === 'dns_block');

  let cause = 'Your network is blocking AuraAlpha.';
  if (ssl) cause = 'A content filter on your network is intercepting our HTTPS connection (xFi Advanced Security, Norton Family, or similar).';
  else if (redirect) cause = 'A DNS-based filter on your network is redirecting AuraAlpha to a block page.';
  else if (dns) cause = 'A DNS filter on your network is blocking AuraAlpha entirely.';

  const detail = [
    cause,
    '',
    'Common fixes:',
    '  • Xfinity xFi → app → WiFi → Advanced Security → disable for this device',
    '  • Eero → Eero app → Discover → Eero Secure → Block & allow → allow auraalpha.cc',
    '  • Router family-safety → admin panel → allowlist auraalpha.cc',
    '  • Or click "Set Custom Server URL" to enter a tunnel/VPN endpoint',
    '',
    'Probes attempted:',
    ...probes.map((p) => `  • ${p.source}: ${p.url} → ${p.ok ? 'OK' : (p.errorClass || 'fail') + ' (' + (p.error || '?') + ')'}`),
  ].join('\n');

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Network Connection Blocked',
    message: 'AuraAlpha cannot reach our servers',
    detail,
    buttons: [
      'Install Cloudflare WARP (1-click fix)',
      'Set Custom Server URL',
      'Open Help Page',
      'Retry',
      'Continue Anyway',
    ],
    defaultId: 0,
    cancelId: 4,
  });

  if (result.response === 0) {
    // Tier 2: recommend Cloudflare WARP. Free 1-click VPN that tunnels DNS+
    // traffic through Cloudflare, defeats most consumer-grade content filters,
    // and is legitimate (no Tor stigma). After install + reboot the worker
    // will register against auraalpha.cc directly with no further config.
    shell.openExternal('https://1.1.1.1/');
  } else if (result.response === 1) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-network-settings');
    }
  } else if (result.response === 2) {
    shell.openExternal('https://auraalpha.cc/help/network-block');
  } else if (result.response === 3) {
    const re = await networkConfig.resolveServerUrl();
    if (re.url) {
      API_BASE = re.url;
      API_SOURCE = re.source;
    } else {
      handleNetworkBlock(re.probes);
    }
  }
}

// ── Startup probe — runs after app.ready (loadSettings needs userData path) ─
async function probeAndResolveAtStartup() {
  const resolved = await networkConfig.resolveServerUrl();
  if (resolved.url) {
    API_BASE = resolved.url;
    API_SOURCE = resolved.source;
    if (resolved.source !== 'primary') {
      const settings = networkConfig.loadSettings();
      networkConfig.saveSettings({ ...settings, lastWorkingUrl: resolved.url });
    }
    return;
  }
  setTimeout(() => handleNetworkBlock(resolved.probes), 1500);
}

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Probe in parallel with window setup; race a 6s timeout so a slow filter
  // doesn't block the UI from painting.
  const probePromise = probeAndResolveAtStartup();
  await Promise.race([probePromise, new Promise((r) => setTimeout(r, 6000))]);

  setupProtocol();
  setupCorsBypass();
  // Load any persisted token before IPC + auto-start, so a returning user
  // who was signed in last session gets their worker auto-launched without
  // a re-login. New users (no token yet) skip auto-start with a clear msg.
  currentToken = loadStoredToken();
  registerIPC();
  createWindow();
  createTray();
  initUpdater();

  // ── First-launch orphan cleanup ────────────────────────────────────
  // Honors the "Electron app owns the worker lifecycle" rule. On first
  // launch (or after an upgrade that bumps the cleanup version), run
  // scripts/cleanup_orphan_autostarts.sh to disable any systemd-user
  // services or cron entries left behind by older fleet-start scripts
  // that respawn bots/workers without the app being open. Idempotent;
  // skipped silently if the script isn't present (eg packaged on macOS
  // with no bash). Linux/WSL only.
  try {
    const CLEANUP_VERSION = '1';   // bump to re-run after script changes
    const flagPath = path.join(userDataPath, 'orphan-cleanup-applied.json');
    let applied = null;
    try { applied = JSON.parse(fs.readFileSync(flagPath, 'utf8')); } catch (_) {}
    if (process.platform === 'linux' && (!applied || applied.version !== CLEANUP_VERSION)) {
      const scriptPath = path.join(__dirname, 'scripts', 'cleanup_orphan_autostarts.sh');
      if (fs.existsSync(scriptPath)) {
        const { spawn } = require('child_process');
        const proc = spawn('bash', [scriptPath, '--apply'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
        proc.stdout.on('data', (d) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('worker-log', `[orphan-cleanup] ${d.toString().trim()}`);
          }
        });
        proc.on('exit', (code) => {
          if (code === 0) {
            try {
              fs.writeFileSync(flagPath, JSON.stringify({
                version: CLEANUP_VERSION,
                applied_at: new Date().toISOString(),
              }, null, 2));
            } catch (_) {}
          }
        });
      }
    }
  } catch (err) {
    console.error('[orphan-cleanup] non-fatal:', err.message);
  }


  // Auto-start the grid worker once API_BASE is resolved AND we have a
  // contributor token. No token = the user hasn't signed in yet; we
  // surface a renderer hint instead of attempting to start.
  if (API_BASE && API_SOURCE !== 'none') {
    setTimeout(() => {
      try {
        const status = getWorkerStatus();
        if (!status.running) {
          if (!currentToken) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                'worker-log',
                '[worker] Sign in to Aura Alpha to enable the grid worker (no token yet).',
              );
            }
            return;
          }
          // Mode `max` = full compute lane, appropriate for dedicated rigs.
          // Renderer can stop/restart with a different mode via IPC.
          startWorker('max', (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('worker-log', msg);
            }
          }, API_BASE, currentToken);
        }
      } catch (err) {
        console.error('[auto-start] worker failed to start:', err);
      }
    }, 3000);

    // Offer GPU acceleration install once worker is up. Runs ~30s after
    // launch so we don't compete with the initial worker spin-up. Self-skips
    // on non-NVIDIA boxes, when torch+CUDA is already present, or when the
    // user has previously declined.
    setTimeout(() => {
      const log = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('worker-log', msg);
        }
      };
      maybeOfferGpuInstall({
        findPython,
        onLog: log,
        parentWindow: mainWindow,
        onInstalled: () => {
          log('[gpu-setup] Restarting worker to pick up GPU…');
          try {
            stopWorker();
            setTimeout(() => startWorker('max', log, API_BASE, currentToken), 4000);
          } catch (err) {
            log(`[gpu-setup] restart failed: ${err.message}`);
          }
        },
      });
    }, 30000);
  }

  // Second instance: show existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopWorker();
  if (mainWindow) saveWindowState(mainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
