// ── ws_client_update.js ──────────────────────────────────────────────
// Device-side half of the cloud-coordinated auto-update system.
//
// Opens a persistent WebSocket to the EC2 prodesk API at
// `/ws/electron-update`. Sends `hello {device_id, version, hostname,
// platform, arch}` on connect. Server compares the device's version
// against the latest GitHub Release and pushes `update_available
// {latest_version, download_url, release_notes}` when the device is
// behind. We then trigger `autoUpdater.checkForUpdates()` which
// downloads in the background. When the download completes, we IPC the
// renderer so it can show a persistent banner — the user MUST click
// "Restart now" to apply. NEVER auto-restart. This is a hard product
// invariant for live-trading safety.
//
// Reconnect uses exponential backoff (1s → 2s → 5s → 10s → 30s → 60s →
// 120s, cap) so a server outage doesn't peg the device's CPU. Heartbeat
// every 60s keeps the connection from being reaped by stateful firewalls.
//
// Crash-safety: every external call (filesystem, network, autoUpdater)
// is wrapped in try/catch; failures are logged via console.warn and
// never thrown back into the main process.

const WebSocket = require('ws');
const { autoUpdater } = require('electron-updater');
const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Exponential backoff, capped at 120s. Index by reconnectAttempt; clamp
// to the last entry once we exceed the array length.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000, 120000];
const HEARTBEAT_INTERVAL_MS = 60_000;

// VERSION is captured at module load. We DO NOT use app.getVersion()
// because this file may be required before app is ready. package.json
// reading is synchronous and cheap.
let VERSION = '0.0.0';
try {
  VERSION = require('./package.json').version || '0.0.0';
} catch (e) {
  console.warn('[ws_update] package.json read failed:', e.message);
}

let deviceId = null;
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingUpdate = null;   // {version, downloaded_at, release_notes} | null
let listenersBound = false; // ensure autoUpdater listeners only attach once
let initialized = false;    // guard against double-init

// ── device_id ────────────────────────────────────────────────────────
// Stable per-install UUID v4 persisted to
// `app.getPath('userData')/aura_device_id.json`. First call generates +
// writes; subsequent calls read. If the file is corrupt or write fails,
// we still return a UUID so the rest of the system works — the server
// will just see a new device until persistence recovers.
function getDeviceId() {
  if (deviceId) return deviceId;
  let idFile = null;
  try {
    idFile = path.join(app.getPath('userData'), 'aura_device_id.json');
  } catch (e) {
    // app not ready yet — fall through to in-memory only
    console.warn('[ws_update] userData path unavailable:', e.message);
  }

  if (idFile) {
    try {
      if (fs.existsSync(idFile)) {
        const blob = JSON.parse(fs.readFileSync(idFile, 'utf-8'));
        if (blob && typeof blob.device_id === 'string' && blob.device_id.length >= 8) {
          deviceId = blob.device_id;
          return deviceId;
        }
      }
    } catch (e) {
      console.warn('[ws_update] device_id read failed:', e.message);
    }
  }

  // Generate a new UUID v4 (crypto.randomUUID is available in Node ≥14.17).
  try {
    deviceId = crypto.randomUUID();
  } catch (e) {
    // extreme fallback for ancient Node — manually-shaped UUID v4.
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString('hex');
    deviceId = `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
  }

  if (idFile) {
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(
        idFile,
        JSON.stringify({ device_id: deviceId, created_at: new Date().toISOString() }, null, 2),
      );
    } catch (e) {
      console.warn('[ws_update] device_id write failed:', e.message);
    }
  }
  return deviceId;
}

// ── Server URL resolution ────────────────────────────────────────────
// Priority:
//   1. $AURA_UPDATE_WS_URL (explicit override — used by ops)
//   2. Derive from current API_BASE (network-config.js resolved value,
//      injected by main.js via global.__auraGetApiBase()). Swap
//      http:// → ws://, https:// → wss://, append /ws/electron-update.
//   3. Fallback: wss://auraalpha.cc/ws/electron-update
//
// Deriving from API_BASE means the WS follows wherever the REST API is
// currently pointed (primary, tailscale, custom URL) without a separate
// config knob — which matches how the rest of the app behaves under the
// network-block mitigation tiers.
function getServerWsUrl() {
  const envUrl = (process.env.AURA_UPDATE_WS_URL || '').trim();
  if (envUrl) return envUrl;

  let apiBase = null;
  try {
    if (typeof global.__auraGetApiBase === 'function') {
      apiBase = global.__auraGetApiBase();
    }
  } catch (e) {
    console.warn('[ws_update] api-base lookup failed:', e.message);
  }

  if (apiBase && typeof apiBase === 'string' && apiBase.length > 0) {
    const trimmed = apiBase.replace(/\/+$/, '');
    if (trimmed.startsWith('https://')) {
      return `wss://${trimmed.slice('https://'.length)}/ws/electron-update`;
    }
    if (trimmed.startsWith('http://')) {
      return `ws://${trimmed.slice('http://'.length)}/ws/electron-update`;
    }
  }
  // Hardcoded fallback — production HTTPS endpoint.
  return 'wss://auraalpha.cc/ws/electron-update';
}

// ── Public API ───────────────────────────────────────────────────────

function initElectronUpdateWS() {
  if (initialized) {
    console.warn('[ws_update] initElectronUpdateWS already called; skipping');
    return;
  }
  initialized = true;

  // Prime device_id (async-safe — getDeviceId is sync).
  try {
    getDeviceId();
  } catch (e) {
    console.warn('[ws_update] getDeviceId at init failed:', e.message);
  }

  bindAutoUpdaterListeners();
  connect();
}

function bindAutoUpdaterListeners() {
  if (listenersBound) return;
  listenersBound = true;

  // Node EventEmitter supports multiple listeners — we layer on top of
  // updater.js' existing listeners without disrupting them.
  autoUpdater.on('update-downloaded', (info) => {
    try {
      pendingUpdate = {
        version: info && info.version ? String(info.version) : 'unknown',
        downloaded_at: new Date().toISOString(),
        release_notes: normalizeReleaseNotes(info && info.releaseNotes),
      };
      console.log(`[ws_update] update-downloaded fired: v${pendingUpdate.version}`);

      // Broadcast IPC to ALL renderer windows (today only mainWindow,
      // but use getAllWindows for robustness).
      try {
        BrowserWindow.getAllWindows().forEach((w) => {
          try {
            if (w && !w.isDestroyed()) {
              w.webContents.send('update-downloaded', pendingUpdate);
            }
          } catch (e) {
            console.warn('[ws_update] window send failed:', e.message);
          }
        });
      } catch (e) {
        console.warn('[ws_update] BrowserWindow.getAllWindows failed:', e.message);
      }

      // Tell the server we've staged the new version so its dashboard
      // can show "device pending restart". Best-effort — drop silently
      // if the socket isn't open.
      sendToServer({
        type: 'update_downloaded',
        device_id: getDeviceId(),
        downloaded_version: pendingUpdate.version,
        ts: new Date().toISOString(),
      });

      // main.js installs a global hook so we can update the tray
      // tooltip + reveal the "Restart to apply update" menu item without
      // a hard cross-require dependency.
      if (typeof global.__auraOnUpdatePending === 'function') {
        try {
          global.__auraOnUpdatePending(pendingUpdate);
        } catch (e) {
          console.warn('[ws_update] tray hook threw:', e.message);
        }
      }
    } catch (e) {
      console.error('[ws_update] update-downloaded handler crashed:', e.message);
    }
  });

  // Logging-only listeners — keep them lightweight so we don't double-
  // log against updater.js' own listeners (they coexist by design).
  autoUpdater.on('error', (err) => {
    try {
      console.warn('[ws_update] autoUpdater error:', err && err.message);
    } catch (_) { /* noop */ }
  });
}

// electron-updater hands releaseNotes back as either a string (plain
// text release) or an array of {version, note} objects (GitHub-style).
// Normalize to a single string the renderer can render verbatim.
function normalizeReleaseNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && n.note ? `v${n.version || '?'}\n${n.note}` : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  try {
    return String(notes);
  } catch (_) {
    return '';
  }
}

// ── WebSocket lifecycle ──────────────────────────────────────────────

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const url = getServerWsUrl();
  console.log(`[ws_update] connecting to ${url} (attempt ${reconnectAttempt + 1})`);

  try {
    ws = new WebSocket(url, {
      rejectUnauthorized: true,
      handshakeTimeout: 10_000,
      // Mark ourselves so the server can multiplex against other ws
      // endpoints if/when it grows them.
      headers: {
        'User-Agent': `AuraAlphaDesktop/${VERSION} (${process.platform}; ${process.arch})`,
      },
    });
  } catch (e) {
    console.error('[ws_update] WebSocket construct threw:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    try {
      reconnectAttempt = 0;
      console.log('[ws_update] connected');
      sendToServer({
        type: 'hello',
        device_id: getDeviceId(),
        version: VERSION,
        hostname: safeHostname(),
        platform: process.platform,
        arch: process.arch,
        ts: new Date().toISOString(),
      });
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        sendToServer({
          type: 'heartbeat',
          device_id: getDeviceId(),
          ts: new Date().toISOString(),
        });
      }, HEARTBEAT_INTERVAL_MS);
    } catch (e) {
      console.error('[ws_update] open handler crashed:', e.message);
    }
  });

  ws.on('message', (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.warn('[ws_update] bad message (not JSON):', e.message);
      return;
    }
    try {
      handleServerMessage(msg);
    } catch (e) {
      console.warn('[ws_update] server message handler threw:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    try {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      console.log(`[ws_update] closed (code=${code} reason=${reason ? reason.toString() : ''})`);
    } catch (_) { /* ignore */ }
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    // 'close' will follow; reconnect there. Just log here so the user
    // can see what went wrong in the console.
    try {
      console.warn('[ws_update] socket error:', e && e.message);
    } catch (_) { /* ignore */ }
  });

  // Defense in depth: some platforms don't deliver 'error' before
  // 'close' on handshake failure. The handshakeTimeout in the
  // constructor already covers that case, but we additionally
  // unconditionally reconnect on close above.
}

function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object' || !msg.type) return;
  switch (msg.type) {
    case 'ack':
      // Server acknowledged our hello. No action needed.
      break;
    case 'update_available':
      console.log(
        `[ws_update] server announces v${msg.latest_version || '?'} — triggering autoUpdater`,
      );
      // autoDownload=true is already set in updater.js → checkForUpdates
      // kicks off the download. We rely on the 'update-downloaded'
      // event we bound above to fire the IPC.
      try {
        autoUpdater.checkForUpdates()
          .catch((e) => console.warn('[ws_update] checkForUpdates rejected:', e && e.message));
      } catch (e) {
        console.warn('[ws_update] checkForUpdates threw:', e.message);
      }
      break;
    case 'force_install_now':
      // Banner-only product policy: even when the server requests force-
      // install, we DO NOT auto-restart. We treat it as update_available
      // — the user still has to click Restart from the banner. The hard
      // UX constraint is "NEVER auto-restart" for live trading safety.
      console.log(
        '[ws_update] server requested force-install; treating as update_available (banner-only policy)',
      );
      try {
        autoUpdater.checkForUpdates()
          .catch((e) => console.warn('[ws_update] checkForUpdates rejected:', e && e.message));
      } catch (e) {
        console.warn('[ws_update] checkForUpdates threw:', e.message);
      }
      break;
    case 'ping':
      sendToServer({
        type: 'pong',
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
      });
      break;
    default:
      // Unknown — ignore silently. Forward-compat for future server msgs.
      break;
  }
}

function sendToServer(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn('[ws_update] send failed:', e.message);
    return false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  const idx = Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
  const delay = RECONNECT_BACKOFF_MS[idx];
  reconnectAttempt += 1;
  console.log(`[ws_update] reconnect in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      connect();
    } catch (e) {
      console.warn('[ws_update] reconnect threw:', e.message);
      scheduleReconnect();
    }
  }, delay);
}

function safeHostname() {
  try {
    return os.hostname();
  } catch (e) {
    return 'unknown';
  }
}

module.exports = {
  initElectronUpdateWS,
  getDeviceId,
  getPendingUpdate: () => pendingUpdate,
  // Allow tests / external callers to clear pending state (eg. after a
  // successful quitAndInstall path). Not used by the banner flow today.
  _clearPendingUpdate: () => { pendingUpdate = null; },
};
