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

  // Auth token — renderer pushes the signed-in user's token after login
  // so the grid worker can register with the coordinator. Cleared on
  // sign-out. Stored encrypted on disk via Electron safeStorage.
  setAuthToken: (token) => ipcRenderer.invoke('set-auth-token', token),
  clearAuthToken: () => ipcRenderer.invoke('clear-auth-token'),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),

  platform: process.platform,
  version: require('./package.json').version,
});
