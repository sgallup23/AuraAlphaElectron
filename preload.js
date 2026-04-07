const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auraDesktop', {
  // ── System ──────────────────────────────────────────────────────────
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  platform: process.platform,
  version: require('./package.json').version,

  // ── Worker management ───────────────────────────────────────────────
  getWorkerStatus: () => ipcRenderer.invoke('get-worker-status'),
  startWorker: (mode) => ipcRenderer.invoke('start-worker', mode),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  restartWorker: () => ipcRenderer.invoke('restart-worker'),

  // ── Logs ────────────────────────────────────────────────────────────
  getLogs: () => ipcRenderer.invoke('get-logs'),

  // ── Health ──────────────────────────────────────────────────────────
  getHealth: () => ipcRenderer.invoke('get-health'),

  // ── Grid queue ──────────────────────────────────────────────────────
  getQueueStats: () => ipcRenderer.invoke('get-queue-stats'),
  flushQueue: () => ipcRenderer.invoke('flush-queue'),

  // ── Event subscriptions ─────────────────────────────────────────────
  subscribeEvents: (callback) => {
    ipcRenderer.invoke('subscribe-events');
    ipcRenderer.on('system-event', (_, event) => {
      if (typeof callback === 'function') callback(event);
    });
  },
  unsubscribeEvents: () => {
    ipcRenderer.invoke('unsubscribe-events');
    ipcRenderer.removeAllListeners('system-event');
  },

  // ── Intelligence ────────────────────────────────────────────────────
  getIntelligence: () => ipcRenderer.invoke('get-intelligence'),

  // ── Worker log stream ───────────────────────────────────────────────
  onWorkerLog: (callback) => {
    ipcRenderer.on('worker-log', (_, msg) => {
      if (typeof callback === 'function') callback(msg);
    });
  },

  // ── Notification stream ─────────────────────────────────────────────
  onNotification: (callback) => {
    ipcRenderer.on('notification', (_, data) => {
      if (typeof callback === 'function') callback(data);
    });
  },
});
