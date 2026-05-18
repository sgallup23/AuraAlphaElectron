// sign-with-esigner.js — electron-builder custom sign hook that calls
// SSL.com CodeSignTool (eSigner cloud signing) against AuraHoldings's
// EV cert. Wired in via package.json: build.win.sign = "./scripts/sign-with-esigner.js".
//
// Secrets live in C:\Users\shawn\.codesigntool.env (gitignored, never logged).
// Required vars:
//   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID
// Optional:
//   CODESIGNTOOL_DIR (default: C:\Users\shawn\Tools\CodeSignTool)
//   ESIGNER_PROGRAM_NAME (default: "Aura Alpha")
//
// Override path: set AURA_SKIP_SIGN=1 to bypass entirely (matches the old
// unsigned-build behavior). Use sparingly.

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_FILE = process.env.CODESIGNTOOL_ENV_FILE
  || path.join(os.homedir(), '.codesigntool.env');

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    out[k] = v;
  }
  return out;
}

module.exports = async function sign(configuration) {
  if (process.env.AURA_SKIP_SIGN === '1') {
    console.log('[sign-with-esigner] AURA_SKIP_SIGN=1 — skipping signature');
    return;
  }

  const target = configuration.path;
  if (!target || !fs.existsSync(target)) {
    throw new Error(`[sign-with-esigner] target path missing: ${target}`);
  }

  const env = { ...loadDotenv(ENV_FILE), ...process.env };
  const username = env.ESIGNER_USERNAME;
  const password = env.ESIGNER_PASSWORD;
  const totp = env.ESIGNER_TOTP_SECRET;
  const credentialId = env.ESIGNER_CREDENTIAL_ID;
  const programName = env.ESIGNER_PROGRAM_NAME || 'Aura Alpha';
  const codeSignToolDir = env.CODESIGNTOOL_DIR
    || 'C:\\Users\\shawn\\Tools\\CodeSignTool';

  const missing = [];
  if (!username) missing.push('ESIGNER_USERNAME');
  if (!password) missing.push('ESIGNER_PASSWORD');
  if (!totp) missing.push('ESIGNER_TOTP_SECRET');
  if (!credentialId) missing.push('ESIGNER_CREDENTIAL_ID');
  if (missing.length) {
    throw new Error(
      `[sign-with-esigner] missing eSigner env vars: ${missing.join(', ')}\n` +
      `  Expected in ${ENV_FILE} or process env.`
    );
  }

  // Resolve Java: bundled JRE first (matches local install), then JAVA_HOME,
  // then 'java' from PATH (the CI runner uses actions/setup-java).
  let javaExe = path.join(codeSignToolDir, 'jdk-11.0.2', 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      const candidate = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(candidate)) javaExe = candidate;
    }
  }
  if (!fs.existsSync(javaExe)) {
    javaExe = process.platform === 'win32' ? 'java.exe' : 'java';  // PATH lookup
  }

  // Locate the real CodeSignTool root by finding conf/code_sign_tool.properties.
  // SSL.com's zip has flaky layouts (sometimes top-level, sometimes nested inside
  // a wrapper dir, sometimes flattened wrong by a workflow flatten step). The
  // single source of truth is wherever conf/code_sign_tool.properties lives —
  // its parent is the dir CodeSignTool wants as its cwd (it reads `.\conf\...`
  // cwd-relative). Walk up to 3 levels deep, then fail loudly.
  function findCsRoot(start) {
    const queue = [start];
    const seen = new Set();
    let depth = 0;
    while (queue.length && depth < 200) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const propsPath = path.join(cur, 'conf', 'code_sign_tool.properties');
      if (fs.existsSync(propsPath)) return cur;
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (e.isDirectory() && path.relative(start, cur).split(path.sep).length < 3) {
          queue.push(path.join(cur, e.name));
        }
      }
      depth++;
    }
    return null;
  }
  const csRoot = findCsRoot(codeSignToolDir);
  if (!csRoot) {
    throw new Error(
      `[sign-with-esigner] conf/code_sign_tool.properties not found under ${codeSignToolDir}\n` +
      '  CodeSignTool layout is broken — re-extract the SSL.com zip without flattening.'
    );
  }

  // Resolve JAR by globbing jar/code_sign_tool-*.jar UNDER the real root.
  const jarDir = path.join(csRoot, 'jar');
  let jarPath = null;
  if (fs.existsSync(jarDir)) {
    const cands = fs.readdirSync(jarDir).filter(n => /^code_sign_tool-.*\.jar$/.test(n));
    if (cands.length) jarPath = path.join(jarDir, cands.sort().pop());
  }
  if (!jarPath) {
    throw new Error(`[sign-with-esigner] code_sign_tool-*.jar not found under ${jarDir}`);
  }

  // CodeSignTool needs cwd at csRoot so its `.\conf\code_sign_tool.properties`
  // resolves. -override replaces the input file in place.
  const args = [
    '-jar', jarPath,
    'sign',
    `-username=${username}`,
    `-password=${password}`,
    `-totp_secret=${totp}`,
    `-credential_id=${credentialId}`,
    `-program_name=${programName}`,
    `-input_file_path=${target}`,
    '-override',
  ];

  console.log(`[sign-with-esigner] signing ${path.basename(target)} via SSL.com eSigner... (csRoot=${csRoot})`);
  // Capture output so we can verify CodeSignTool actually succeeded. The tool
  // sometimes exits 0 even when it logs a fatal exception (e.g.
  // FileNotFoundException on conf/code_sign_tool.properties), so exit-code
  // alone is not enough — we MUST grep stdout for "Code signed successfully".
  let result;
  try {
    result = require('child_process').spawnSync(javaExe, args, {
      cwd: csRoot,
      env: { ...process.env },
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(`[sign-with-esigner] failed to spawn java for ${target}: ${err.message}`);
  }
  const out = (result.stdout || '') + (result.stderr || '');
  // Always echo CodeSignTool's output so logs show what happened.
  if (out) process.stdout.write(out);
  if (result.status !== 0) {
    throw new Error(`[sign-with-esigner] CodeSignTool exited ${result.status} for ${target}`);
  }
  if (!/Code signed successfully/.test(out)) {
    throw new Error(
      `[sign-with-esigner] CodeSignTool exited 0 but did NOT report success for ${target}.\n` +
      '  Output above. Common causes: missing conf/, OTP invalid, malware scan, network.'
    );
  }
  console.log(`[sign-with-esigner] OK — ${path.basename(target)}`);
};
