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
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initUpdater } = require('./updater');
const { startWorker, stopWorker, getStatus: getWorkerStatus } = require('./worker');
const networkConfig = require('./network-config');

// ── Single instance lock ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── Paths ─────────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const stateFile = path.join(userDataPath, 'window-state.json');
const isDev = !app.isPackaged;
const DIST_PATH = path.join(__dirname, 'dist');
// API_BASE is resolved at startup by network-config.js (handles xFi/SafeDNS-style
// content filters, falls through primary → backup hostnames → direct EC2 IP →
// user-supplied custom URL). Default keeps the public hostname so dev/source
// builds still work before the resolver runs.
let API_BASE = networkConfig.PRIMARY_URL;
let API_SOURCE = 'primary';
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
    }, API_BASE);
  });

  ipcMain.handle('stop-worker', () => stopWorker());

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
  registerIPC();
  createWindow();
  createTray();
  initUpdater();

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
