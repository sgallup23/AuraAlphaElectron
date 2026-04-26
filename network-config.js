const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// ── Constants ─────────────────────────────────────────────────────────
const PRIMARY_URL = 'https://auraalpha.cc';
// Backup hostnames — fill in once registered. main.js auto-tries each in order.
const BACKUP_URLS = [
  // 'https://aura-trading.com',
  // 'https://auraalpha.app',
];
// Last-resort direct EC2 IP (HTTP, no Cloudflare). Bypasses TLS-MITM filters
// but won't survive an EC2 reboot if Elastic IP is detached.
const DIRECT_IP_URL = 'http://54.172.235.137:8020';

// ── Settings persistence ─────────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'network-settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* missing or invalid — return defaults */ }
  return {};
}

function saveSettings(settings) {
  const safe = {
    customServerUrl: typeof settings.customServerUrl === 'string'
      ? settings.customServerUrl.trim().replace(/\/+$/, '')
      : '',
    lastWorkingUrl: typeof settings.lastWorkingUrl === 'string'
      ? settings.lastWorkingUrl
      : '',
    blockDetectedAt: settings.blockDetectedAt || null,
  };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(safe, null, 2));
    return safe;
  } catch (err) {
    return { error: err.message };
  }
}

// ── Probe a single URL ───────────────────────────────────────────────
// Returns { ok: bool, status?: number, errorClass?: string, error?: string, ms: number }.
// errorClass identifies why we failed so the renderer can show the right help:
//   'ssl_intercept'    — TLS handshake mangled (xFi / Bitdefender style filter)
//   'dns_block'        — DNS sinkhole / NXDOMAIN
//   'http_redirect'    — HTTP 30x to a third-party block page (SafeDNS etc.)
//   'connection'       — TCP refused / unreachable
//   'timeout'          — slow filter / captive portal
//   'http_error'       — server reachable but returned non-2xx (probably fine)
async function probeUrl(url, timeoutMs = 6000) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...result });
    };

    let req;
    try {
      req = net.request({ method: 'GET', url: `${url}/api/health` });
    } catch (err) {
      return finish({ ok: false, errorClass: classifyError(err.message), error: err.message });
    }

    const to = setTimeout(() => {
      try { req.abort(); } catch (_) { /* ignore */ }
      finish({ ok: false, errorClass: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    req.on('response', (resp) => {
      clearTimeout(to);
      // Detect 30x redirects to known block-page domains
      if ([301, 302, 303, 307, 308].includes(resp.statusCode)) {
        const loc = (resp.headers['location'] || resp.headers['Location'] || '').toString();
        if (/safebrowse\.io|opendns\.com|cleanbrowsing|nextdns|umbrella/i.test(loc)) {
          return finish({ ok: false, errorClass: 'http_redirect', error: `redirected to filter: ${loc}` });
        }
      }
      // Drain body
      resp.on('data', () => { /* discard */ });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 500) {
          // 2xx + 3xx + 4xx (incl. 401/405) all mean the server is reachable.
          // We only care about transport-layer reachability here.
          finish({ ok: true, status: resp.statusCode });
        } else {
          finish({ ok: false, errorClass: 'http_error', error: `HTTP ${resp.statusCode}` });
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(to);
      finish({ ok: false, errorClass: classifyError(err.message || String(err)), error: err.message || String(err) });
    });

    try { req.end(); } catch (err) {
      clearTimeout(to);
      finish({ ok: false, errorClass: 'connection', error: err.message });
    }
  });
}

function classifyError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('wrong version number') || m.includes('ssl') || m.includes('tls') ||
      m.includes('handshake') || m.includes('protocol_error') || m.includes('err_ssl')) {
    return 'ssl_intercept';
  }
  if (m.includes('name not resolved') || m.includes('enotfound') || m.includes('getaddrinfo') ||
      m.includes('err_name_not_resolved')) {
    return 'dns_block';
  }
  if (m.includes('econnrefused') || m.includes('refused') || m.includes('unreachable')) {
    return 'connection';
  }
  if (m.includes('timeout') || m.includes('etimedout')) {
    return 'timeout';
  }
  return 'connection';
}

// ── Resolve effective server URL ─────────────────────────────────────
// Probes in priority order: customServerUrl (if user set one) → primary → backups → direct IP.
// Returns { url, source, probes }. `source` is one of: custom, primary, backup, direct, none.
async function resolveServerUrl() {
  const settings = loadSettings();
  const probes = [];
  const tryUrl = async (url, source) => {
    if (!url) return null;
    const result = await probeUrl(url);
    probes.push({ url, source, ...result });
    return result.ok ? { url, source } : null;
  };

  // 1. Custom URL set in settings (e.g. Tailscale hostname)
  if (settings.customServerUrl) {
    const hit = await tryUrl(settings.customServerUrl, 'custom');
    if (hit) return { ...hit, probes };
  }

  // 2. Primary
  const primary = await tryUrl(PRIMARY_URL, 'primary');
  if (primary) return { ...primary, probes };

  // 3. Each backup hostname in turn
  for (const backup of BACKUP_URLS) {
    const hit = await tryUrl(backup, 'backup');
    if (hit) return { ...hit, probes };
  }

  // 4. Direct EC2 IP — last resort
  const direct = await tryUrl(DIRECT_IP_URL, 'direct');
  if (direct) return { ...direct, probes };

  // Nothing worked — caller will show the friendly modal
  return { url: null, source: 'none', probes };
}

// ── Quick-test handler for the renderer "Test custom URL" button ─────
async function testCustomUrl(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'No URL provided' };
  }
  const cleaned = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }
  const result = await probeUrl(cleaned, 8000);
  return { ...result, url: cleaned };
}

module.exports = {
  PRIMARY_URL,
  BACKUP_URLS,
  DIRECT_IP_URL,
  loadSettings,
  saveSettings,
  probeUrl,
  resolveServerUrl,
  testCustomUrl,
  classifyError,
};
