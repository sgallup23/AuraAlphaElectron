const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { app } = require('electron');

// ── Constants ─────────────────────────────────────────────────────────
// Tailscale-routed endpoint — preferred for the fleet during the Google +
// Microsoft reputation warmup (see memory: aura_alpha_tailscale_routing_2026_04_27).
// MagicDNS resolves only inside the tailnet, so non-tailnet clients fail fast
// (dns_block) and fall through to PRIMARY_URL transparently.
const TAILSCALE_URL = 'http://prodesk-ec2:8020';
const PRIMARY_URL = 'https://auraalpha.cc';
// Backup hostnames — fill in once registered. main.js auto-tries each in order.
// Tailnet hostname (Tailscale magicDNS) is a backup so workers on the tailnet
// route around ISP-level filtering of auraalpha.cc without any user config.
// Only resolves when the local machine is on the tailnet, so it's harmless
// for users who aren't.
const BACKUP_URLS = [
  'http://prodesk-ec2.tail62e000.ts.net:8020',
  // 'https://aura-trading.com',
  // 'https://auraalpha.app',
];

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
  // First try via Node's native http(s) — bypasses Chromium's net stack and
  // therefore Cloudflare WARP, which RSTs Tailscale-CGNAT IPs even when the
  // OS routes them correctly. If Node-native succeeds, the URL works.
  // If it fails, fall through to Electron's net.request as a second opinion
  // (some corp filters block Node's user-agent but allow Chromium's).
  const nodeResult = await probeViaNode(url, timeoutMs);
  if (nodeResult.ok) return nodeResult;
  const electronResult = await probeViaElectronNet(url, timeoutMs);
  if (electronResult.ok) return electronResult;
  // Return the more informative of the two failures (Node usually has the
  // better errorClass since it doesn't get filtered by WARP).
  return nodeResult;
}

// ── Probe via Node's native http/https ────────────────────────────
// This goes straight through the Win32 socket layer, bypassing Chromium
// (and therefore bypassing Cloudflare WARP, which intercepts Chromium
// traffic and resets connections to private/CGNAT IPs like Tailscale).
function probeViaNode(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...result });
    };
    let parsed;
    try { parsed = new URL(`${url}/api/health`); }
    catch (err) {
      return finish({ ok: false, errorClass: 'connection', error: err.message });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      timeout: timeoutMs,
      headers: { 'User-Agent': 'AuraAlpha-Probe/1.0' },
    }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode)) {
        const loc = (resp.headers['location'] || '').toString();
        if (/safebrowse\.io|opendns\.com|cleanbrowsing|nextdns|umbrella/i.test(loc)) {
          return finish({ ok: false, errorClass: 'http_redirect', error: `redirected to filter: ${loc}` });
        }
      }
      resp.on('data', () => { /* discard */ });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 500) {
          finish({ ok: true, status: resp.statusCode, via: 'node' });
        } else {
          finish({ ok: false, errorClass: 'http_error', error: `HTTP ${resp.statusCode}`, via: 'node' });
        }
      });
    });
    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
      finish({ ok: false, errorClass: 'timeout', error: `timeout after ${timeoutMs}ms`, via: 'node' });
    });
    req.on('error', (err) => {
      finish({ ok: false, errorClass: classifyError(err.code || err.message || String(err)), error: err.message || String(err), via: 'node' });
    });
    try { req.end(); }
    catch (err) {
      finish({ ok: false, errorClass: 'connection', error: err.message, via: 'node' });
    }
  });
}

function probeViaElectronNet(url, timeoutMs) {
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
      return finish({ ok: false, errorClass: classifyError(err.message), error: err.message, via: 'electron' });
    }

    const to = setTimeout(() => {
      try { req.abort(); } catch (_) { /* ignore */ }
      finish({ ok: false, errorClass: 'timeout', error: `timeout after ${timeoutMs}ms`, via: 'electron' });
    }, timeoutMs);

    req.on('response', (resp) => {
      clearTimeout(to);
      if ([301, 302, 303, 307, 308].includes(resp.statusCode)) {
        const loc = (resp.headers['location'] || resp.headers['Location'] || '').toString();
        if (/safebrowse\.io|opendns\.com|cleanbrowsing|nextdns|umbrella/i.test(loc)) {
          return finish({ ok: false, errorClass: 'http_redirect', error: `redirected to filter: ${loc}`, via: 'electron' });
        }
      }
      resp.on('data', () => { /* discard */ });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 500) {
          finish({ ok: true, status: resp.statusCode, via: 'electron' });
        } else {
          finish({ ok: false, errorClass: 'http_error', error: `HTTP ${resp.statusCode}`, via: 'electron' });
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(to);
      finish({ ok: false, errorClass: classifyError(err.message || String(err)), error: err.message || String(err), via: 'electron' });
    });

    try { req.end(); } catch (err) {
      clearTimeout(to);
      finish({ ok: false, errorClass: 'connection', error: err.message, via: 'electron' });
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

  // 2. Tailscale (MagicDNS) — preferred during reputation warmup. Fails fast
  //    (DNS lookup error) on non-tailnet clients, then falls through to primary.
  const tailscale = await tryUrl(TAILSCALE_URL, 'tailscale');
  if (tailscale) return { ...tailscale, probes };

  // 3. Primary
  const primary = await tryUrl(PRIMARY_URL, 'primary');
  if (primary) return { ...primary, probes };

  // 4. Each backup hostname in turn
  for (const backup of BACKUP_URLS) {
    const hit = await tryUrl(backup, 'backup');
    if (hit) return { ...hit, probes };
  }

  // Nothing worked — caller will show the friendly modal.
  // (Direct-IP fallback removed in v9.4.15 — public port 8020 isn't open
  // to the internet anyway, and EC2 stop/start changes the IP, so probing
  // a hardcoded IP only delayed the friendly modal by ~6s. Tunnel-CNAME
  // on auraalpha.cc is the durable path now.)
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
  TAILSCALE_URL,
  PRIMARY_URL,
  BACKUP_URLS,
  loadSettings,
  saveSettings,
  probeUrl,
  resolveServerUrl,
  testCustomUrl,
  classifyError,
};
