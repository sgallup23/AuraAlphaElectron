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

  // Resolve JAR: glob jar/code_sign_tool-*.jar so version bumps don't break this.
  let jarPath = null;
  const jarDir = path.join(codeSignToolDir, 'jar');
  if (fs.existsSync(jarDir)) {
    const cands = fs.readdirSync(jarDir).filter(n => /^code_sign_tool-.*\.jar$/.test(n));
    if (cands.length) jarPath = path.join(jarDir, cands.sort().pop());
  }
  if (!jarPath) {
    throw new Error(
      `[sign-with-esigner] code_sign_tool-*.jar not found under ${jarDir}\n` +
      '  Set CODESIGNTOOL_DIR or install to the default path.'
    );
  }

  // CodeSignTool needs cwd at its install dir so its `conf/code_sign_tool.properties`
  // is found relative to the JAR. Also: -override replaces the input file in place.
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

  console.log(`[sign-with-esigner] signing ${path.basename(target)} via SSL.com eSigner...`);
  try {
    execFileSync(javaExe, args, {
      cwd: codeSignToolDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      // Don't leak the secrets to subprocess env unless it needs them.
      env: { ...process.env },
    });
  } catch (err) {
    throw new Error(`[sign-with-esigner] CodeSignTool failed for ${target}: ${err.message}`);
  }
  console.log(`[sign-with-esigner] OK — ${path.basename(target)}`);
};
