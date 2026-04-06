const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function initUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] No updates available.');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[updater] Downloading: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] Update downloaded: v${info.version}. Will install on quit.`);
  });

  autoUpdater.on('error', (err) => {
    console.error(`[updater] Error: ${err.message}`);
  });

  // Check on startup (delay 10s to let app fully load)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 10000);

  // Check periodically
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

module.exports = { initUpdater };
