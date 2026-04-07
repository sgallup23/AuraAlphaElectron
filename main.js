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
  Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initUpdater } = require('./updater');
const {
  setup: setupWorker,
  startWorker,
  stopWorker,
  restartWorker,
  getStatus: getWorkerStatus,
} = require('./worker');

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
// Direct to EC2 for speed (skip Cloudflare ~150ms per request)
// Falls back to Cloudflare if direct fails
const API_BASE_DIRECT = 'http://54.172.235.137:8020';
const API_BASE_CDN = 'https://auraalpha.cc';
const API_BASE = API_BASE_DIRECT;
const SCHEME = 'aura';

// ── Log ring buffer ──────────────────────────────────────────────────
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];

function pushLog(level, source, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
  // Push to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('worker-log', `[${source}] ${message}`);
    } catch (_) { /* window may be closing */ }
  }
  return entry;
}

// ── Notification system ──────────────────────────────────────────────
const notificationThrottles = {};
const NOTIFICATION_THROTTLE_MS = 30000; // 30 seconds per category

function sendNotification(category, title, body) {
  const now = Date.now();
  const lastSent = notificationThrottles[category] || 0;

  if (now - lastSent < NOTIFICATION_THROTTLE_MS) {
    return; // Throttled
  }

  notificationThrottles[category] = now;

  if (Notification.isSupported()) {
    const notif = new Notification({ title, body, silent: false });
    notif.show();
  }

  // Also send to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('notification', { category, title, body, timestamp: new Date().toISOString() });
    } catch (_) { /* ignore */ }
  }
}

// ── Event polling system ─────────────────────────────────────────────
let eventPollingInterval = null;

function startEventPolling() {
  if (eventPollingInterval) return;

  eventPollingInterval = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
      // Worker status
      const workerStatus = getWorkerStatus();

      // API health check
      let apiHealth = { status: 'unknown' };
      try {
        const resp = await net.fetch(`${API_BASE_DIRECT}/api/health`, { method: 'GET' });
        if (resp.ok) {
          apiHealth = await resp.json();
          apiHealth.status = 'healthy';
        } else {
          apiHealth.status = 'degraded';
        }
      } catch (_) {
        apiHealth.status = 'offline';
      }

      const event = {
        type: 'status-update',
        timestamp: new Date().toISOString(),
        worker: workerStatus,
        api: apiHealth,
      };

      mainWindow.webContents.send('system-event', event);
    } catch (_) { /* ignore polling errors */ }
  }, 5000);
}

function stopEventPolling() {
  if (eventPollingInterval) {
    clearInterval(eventPollingInterval);
    eventPollingInterval = null;
  }
}

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
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const urlPath = decodeURIComponent(url.pathname);

    // Proxy /api/* requests — try direct EC2 first, fallback to Cloudflare
    if (urlPath.startsWith('/api/')) {
      const fetchOpts = {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        duplex: request.method !== 'GET' && request.method !== 'HEAD' ? 'half' : undefined,
      };
      const directUrl = `${API_BASE_DIRECT}${urlPath}${url.search}`;
      const cdnUrl = `${API_BASE_CDN}${urlPath}${url.search}`;
      try {
        const resp = await net.fetch(directUrl, fetchOpts);
        if (resp.ok || resp.status === 401 || resp.status === 422) return resp;
        // Direct failed with server error — try CDN
        return net.fetch(cdnUrl, fetchOpts);
      } catch (_) {
        // Direct unreachable — fallback to Cloudflare
        return net.fetch(cdnUrl, fetchOpts);
      }
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
  mainWindow.loadURL(`${SCHEME}://app/index.html`);

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
    if (details.url.startsWith(API_BASE_DIRECT) || details.url.startsWith(API_BASE_CDN)) {
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
  updateTrayMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const status = getWorkerStatus();
  const workerRunning = status.running;

  tray.setToolTip(
    workerRunning
      ? `Aura Alpha v8.2.0 | Worker: ${status.mode} (${status.jobsCompleted} jobs, ${status.uptimeSeconds}s)`
      : 'Aura Alpha v8.2.0 | Worker: stopped'
  );

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: `Worker Status: ${workerRunning ? 'Running' : 'Stopped'}`,
      enabled: false,
    },
    workerRunning
      ? {
          label: 'Stop Worker',
          click: () => {
            stopWorker();
            pushLog('info', 'tray', 'Worker stopped via tray');
            sendNotification('worker', 'Aura Alpha', 'Worker stopped');
            updateTrayMenu();
          },
        }
      : {
          label: 'Start Worker',
          click: () => {
            const logFn = (msg) => pushLog('info', 'worker', msg);
            startWorker('hybrid', logFn);
            sendNotification('worker', 'Aura Alpha', 'Worker started in hybrid mode');
            updateTrayMenu();
          },
        },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        stopWorker();
        stopEventPolling();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// Periodically update tray menu to reflect worker state
setInterval(() => {
  try { updateTrayMenu(); } catch (_) { /* ignore */ }
}, 15000);

// ── IPC handlers ─────────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-system-info', () => {
    try {
      const cpus = os.cpus();
      return {
        success: true,
        data: {
          cpuCount: cpus.length,
          cpuModel: cpus[0]?.model || 'Unknown',
          totalRAM: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
          freeRAM: Math.round(os.freemem() / (1024 * 1024 * 1024)),
          platform: process.platform,
          arch: process.arch,
          hostname: os.hostname(),
          gpu: 'Use chrome://gpu in DevTools to check',
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          uptime: Math.round(os.uptime()),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-worker-status', () => {
    try {
      return { success: true, data: getWorkerStatus() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('start-worker', (_, mode) => {
    try {
      const logFn = (msg) => pushLog('info', 'worker', msg);
      const result = startWorker(mode || 'hybrid', logFn);
      if (result.success) {
        sendNotification('worker', 'Aura Alpha', `Worker started in ${mode || 'hybrid'} mode (PID ${result.pid})`);
        updateTrayMenu();
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-worker', () => {
    try {
      const result = stopWorker();
      sendNotification('worker', 'Aura Alpha', 'Worker stopped');
      updateTrayMenu();
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('restart-worker', async () => {
    try {
      const logFn = (msg) => pushLog('info', 'worker', msg);
      const result = restartWorker(logFn);
      sendNotification('worker', 'Aura Alpha', 'Worker restarting...');
      updateTrayMenu();
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-logs', () => {
    try {
      // Return last 100 entries
      const logs = logBuffer.slice(-100);
      return { success: true, data: logs };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-health', async () => {
    try {
      const workerStatus = getWorkerStatus();

      // API health
      let apiHealth = { status: 'unknown', latencyMs: null };
      try {
        const start = Date.now();
        const resp = await net.fetch(`${API_BASE_DIRECT}/api/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        apiHealth.latencyMs = Date.now() - start;
        if (resp.ok) {
          const data = await resp.json();
          apiHealth = { ...apiHealth, ...data, status: 'healthy' };
        } else {
          apiHealth.status = 'degraded';
          apiHealth.statusCode = resp.status;
        }
      } catch (_) {
        apiHealth.status = 'offline';
      }

      // Gateway health
      let gatewayHealth = { status: 'unknown' };
      try {
        const resp = await net.fetch(`${API_BASE_DIRECT}/api/gateway/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          gatewayHealth = await resp.json();
          gatewayHealth.status = 'connected';
        } else {
          gatewayHealth.status = 'disconnected';
        }
      } catch (_) {
        gatewayHealth.status = 'unknown';
      }

      return {
        success: true,
        data: {
          worker: {
            status: workerStatus.running ? 'running' : 'stopped',
            ...workerStatus,
          },
          api: apiHealth,
          gateway: gatewayHealth,
          overall: workerStatus.running && apiHealth.status === 'healthy' ? 'healthy' : 'degraded',
          checkedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-queue-stats', async () => {
    try {
      const resp = await net.fetch(`${API_BASE_CDN}/api/grid/stats`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return { success: true, data };
      }
      return { success: false, error: `HTTP ${resp.status}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('flush-queue', async () => {
    try {
      const resp = await net.fetch(`${API_BASE_CDN}/api/grid/flush`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        pushLog('info', 'grid', 'Queue flushed');
        return { success: true, data };
      }
      return { success: false, error: `HTTP ${resp.status}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('subscribe-events', () => {
    try {
      startEventPolling();
      pushLog('info', 'events', 'Event subscription started');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('unsubscribe-events', () => {
    try {
      stopEventPolling();
      pushLog('info', 'events', 'Event subscription stopped');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-intelligence', async () => {
    try {
      // System confidence from the API
      let confidence = null;
      let lastTrade = null;
      let learningFeed = [];

      try {
        const confResp = await net.fetch(`${API_BASE_DIRECT}/api/meta-brain/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        if (confResp.ok) {
          const data = await confResp.json();
          confidence = data.health_score || data.confidence || null;
        }
      } catch (_) { /* API unavailable */ }

      try {
        const tradeResp = await net.fetch(`${API_BASE_DIRECT}/api/track-record/signals?limit=1`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        if (tradeResp.ok) {
          const data = await tradeResp.json();
          if (Array.isArray(data) && data.length > 0) {
            lastTrade = data[0];
          } else if (data.signals && data.signals.length > 0) {
            lastTrade = data.signals[0];
          }
        }
      } catch (_) { /* API unavailable */ }

      try {
        const feedResp = await net.fetch(`${API_BASE_DIRECT}/api/realtime/signals`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        if (feedResp.ok) {
          const data = await feedResp.json();
          learningFeed = Array.isArray(data) ? data.slice(0, 10) : [];
        }
      } catch (_) { /* API unavailable */ }

      return {
        success: true,
        data: {
          systemConfidence: confidence,
          lastTradeExplanation: lastTrade,
          learningFeed,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setupProtocol();
  setupCorsBypass();
  registerIPC();
  createWindow();
  createTray();
  initUpdater(mainWindow);

  pushLog('info', 'app', `Aura Alpha v8.2.0 started (${process.platform}/${process.arch})`);

  // Auto-setup + start worker on launch (3s delay)
  setTimeout(() => {
    const logFn = (msg) => pushLog('info', 'worker', msg);
    const result = setupWorker(logFn);
    if (result.success) {
      logFn('Starting grid worker in hybrid mode...');
      startWorker('hybrid', logFn);
      sendNotification('worker', 'Aura Alpha', 'Grid worker started automatically');
      updateTrayMenu();
    } else {
      logFn(`Setup failed: ${result.error}`);
    }
  }, 3000);

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
  stopEventPolling();
  if (mainWindow) saveWindowState(mainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
