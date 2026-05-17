const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auraDesktop', {
  getWorkerStatus: () => ipcRenderer.invoke('get-worker-status'),
  startWorker: (mode) => ipcRenderer.invoke('start-worker', mode),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  onWorkerLog: (cb) => ipcRenderer.on('worker-log', (_, msg) => cb(msg)),

  // Network config (Tier 1 of network-block mitigation)
  getNetworkStatus: () => ipcRenderer.invoke('network-get-status'),
  getNetworkSettings: () => ipcRenderer.invoke('network-get-settings'),
  saveNetworkSettings: (s) => ipcRenderer.invoke('network-save-settings', s),
  testServerUrl: (url) => ipcRenderer.invoke('network-test-url', url),
  resolveServer: () => ipcRenderer.invoke('network-resolve'),
  onOpenNetworkSettings: (cb) => ipcRenderer.on('open-network-settings', () => cb()),

  // Auth tokens — renderer pushes BOTH the access and (optional) refresh
  // tokens after login so they survive an Electron restart. Without
  // refresh-token persistence, every Electron relaunch forced a full
  // re-login because the renderer-side localStorage entry was gone.
  setAuthToken: (token, refreshToken) => ipcRenderer.invoke('set-auth-token', token, refreshToken),
  clearAuthToken: () => ipcRenderer.invoke('clear-auth-token'),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),
  getStoredAuth: () => ipcRenderer.invoke('get-stored-auth'),

  // Boot autostart — user-toggleable. When ON, the app launches hidden
  // (to tray) on system boot. The grid worker only spawns once the app
  // is up, so there are no orphan workers when this is OFF.
  getAutostart: () => ipcRenderer.invoke('autostart-get'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart-set', enabled),

  platform: process.platform,
  version: require('./package.json').version,
});

// ── Cloud-coordinated auto-update API surface ────────────────────────
// Renderer's update banner consumes this. `onUpdateDownloaded` returns
// an unsubscribe callback the React component should call from its
// cleanup phase so we don't leak ipcRenderer listeners on remount.
// `restartNow` is the ONLY renderer path that triggers an actual
// restart (paired with the tray menu item) — banner-only UX requires
// an explicit user click; never auto-fire.
contextBridge.exposeInMainWorld('auraUpdate', {
  getPendingInfo: () => ipcRenderer.invoke('get-pending-update-info'),
  restartNow: () => ipcRenderer.invoke('restart-to-apply-update'),
  snooze: (hours) => ipcRenderer.invoke('snooze-update', { hours }),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  onUpdateDownloaded: (cb) => {
    const handler = (_event, info) => {
      try { cb(info); } catch (_) { /* renderer cb errors stay in renderer */ }
    };
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
});
