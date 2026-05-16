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
