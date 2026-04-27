#!/usr/bin/env node
//
// sync-frontend.js — single-command "build the AuraCommandV2 frontend and
// drop its dist/ into this repo's dist/" so the next electron-builder run
// packages the latest renderer.
//
// Replaces the silent-failure mode where someone tags a release with a
// stale dist/ (the root cause of the 2026-04-27 trading-page crash).
//
// Override the source dir with AURA_FRONTEND_SRC (default
// ~/AuraCommandV2/frontend).
//

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FRONTEND = process.env.AURA_FRONTEND_SRC
  || path.join(os.homedir(), 'AuraCommandV2', 'frontend');
const DEST = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(FRONTEND)) {
  console.error(`[sync-frontend] FAIL — frontend source ${FRONTEND} not found.`);
  console.error('  Set AURA_FRONTEND_SRC to point at the AuraCommandV2 frontend directory.');
  process.exit(1);
}

function run(cmd, cwd) {
  console.log(`[sync-frontend] $ ${cmd}  (cwd: ${cwd || process.cwd()})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

console.log(`[sync-frontend] frontend source: ${FRONTEND}`);
console.log(`[sync-frontend] target dist:     ${DEST}`);

// Build the frontend — caller is expected to have node_modules in place
// already (typically AuraCommandV2 has its own venv-equivalent). If not,
// run `npm ci` first.
const hasNodeModules = fs.existsSync(path.join(FRONTEND, 'node_modules'));
if (!hasNodeModules) {
  console.log('[sync-frontend] node_modules missing — running npm ci first');
  run('npm ci --no-audit --prefer-offline', FRONTEND);
}

run('npm run build', FRONTEND);

const builtDist = path.join(FRONTEND, 'dist');
if (!fs.existsSync(builtDist)) {
  console.error(`[sync-frontend] FAIL — ${builtDist} did not appear after build`);
  process.exit(1);
}

// Replace dist/ atomically: write to a sibling, swap, remove old.
const tmp = DEST + '.new';
if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
console.log('[sync-frontend] copying built dist → ' + DEST);
fs.cpSync(builtDist, tmp, { recursive: true });

const old = DEST + '.old';
if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
if (fs.existsSync(DEST)) fs.renameSync(DEST, old);
fs.renameSync(tmp, DEST);
if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });

console.log('[sync-frontend] done');
