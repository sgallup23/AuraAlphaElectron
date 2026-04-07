const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
let win = null;

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, data);
    } catch (_) { /* window may be closing */ }
  }
}

function initUpdater(mainWindow) {
  win = mainWindow || null;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
    sendToRenderer('worker-log', '[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    const msg = `Update available: v${info.version}`;
    console.log(`[updater] ${msg}`);
    sendToRenderer('worker-log', `[updater] ${msg}`);
    sendToRenderer('notification', {
      category: 'update',
      title: 'Aura Alpha Update Available',
      body: `Version ${info.version} is downloading...`,
      timestamp: new Date().toISOString(),
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] No updates available.');
    sendToRenderer('worker-log', '[updater] No updates available.');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[updater] Downloading: ${pct}%`);
    if (pct % 25 === 0 || pct === 100) {
      sendToRenderer('worker-log', `[updater] Downloading: ${pct}%`);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const msg = `Update downloaded: v${info.version}. Will install on quit.`;
    console.log(`[updater] ${msg}`);
    sendToRenderer('worker-log', `[updater] ${msg}`);
    sendToRenderer('notification', {
      category: 'update',
      title: 'Aura Alpha Update Ready',
      body: `Version ${info.version} downloaded. Restart to install.`,
      timestamp: new Date().toISOString(),
    });
  });

  autoUpdater.on('error', (err) => {
    // Don't spam errors when offline
    const msg = err.message || 'Unknown error';
    const isNetworkError = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR/i.test(msg);

    if (isNetworkError) {
      console.log('[updater] Offline — will retry later.');
    } else {
      console.error(`[updater] Error: ${msg}`);
      sendToRenderer('worker-log', `[updater] Error: ${msg}`);
    }
  });

  // Check on startup (delay 10s to let app fully load)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      const isNetworkError = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(err?.message || '');
      if (!isNetworkError) {
        console.error('[updater] Initial check failed:', err?.message);
      }
    });
  }, 10000);

  // Check periodically
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

module.exports = { initUpdater };
