const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auraDesktop', {
  getWorkerStatus: () => ipcRenderer.invoke('get-worker-status'),
  startWorker: (mode) => ipcRenderer.invoke('start-worker', mode),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  onWorkerLog: (cb) => ipcRenderer.on('worker-log', (_, msg) => cb(msg)),
  platform: process.platform,
  version: require('./package.json').version,
});
