#!/usr/bin/env node
//
// check-dist-fresh.js — pre-build guard against shipping a stale frontend.
//
// Runs as `prebuild` before electron-builder packages the asar. The
// repeated trading-page crashes through 2026-04-27 traced to dist/ chunks
// in the asar that were older than the source they were built from. This
// script fails the build if it detects that condition locally.
//
// Behavior:
//   - If `~/AuraCommandV2/frontend/src` (or env AURA_FRONTEND_SRC) exists,
//     compare its newest .jsx/.js/.ts/.tsx/.css mtime to the newest file
//     in `./dist`. Stale = exit 1.
//   - If the source tree isn't present (CI runners that don't check out
//     AuraCommandV2), pass silently — CI trusts what was committed and
//     enforcement happens on Shawn's box at tag time.
//
// Override:  set AURA_SKIP_DIST_CHECK=1 to bypass (don't make this a habit).
//

const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.AURA_SKIP_DIST_CHECK === '1') {
  console.log('[check-dist-fresh] skipped via AURA_SKIP_DIST_CHECK=1');
  process.exit(0);
}

const SRC = process.env.AURA_FRONTEND_SRC
  || path.join(os.homedir(), 'AuraCommandV2', 'frontend', 'src');
const DIST = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(SRC)) {
  // Likely CI without the AuraCommandV2 checkout — skip silently.
  console.log(`[check-dist-fresh] frontend source ${SRC} not present, skipping (CI mode)`);
  process.exit(0);
}

if (!fs.existsSync(DIST)) {
  console.error(`[check-dist-fresh] FAIL — dist/ missing. Run \`npm run sync-frontend\` first.`);
  process.exit(1);
}

function newestMtime(dir, exts) {
  let newest = 0;
  let newestFile = '';
  function walk(p) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      // skip noisy/non-source dirs
      const base = path.basename(p);
      if (['node_modules', 'dist', '.git', '__pycache__', 'coverage'].includes(base)) return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    } else if (stat.isFile()) {
      if (exts && !exts.some(e => p.endsWith(e))) return;
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
        newestFile = p;
      }
    }
  }
  walk(dir);
  return { mtime: newest, file: newestFile };
}

const srcNewest = newestMtime(SRC, ['.jsx', '.tsx', '.js', '.ts', '.css', '.html']);
const distNewest = newestMtime(DIST);

if (srcNewest.mtime === 0) {
  console.log('[check-dist-fresh] no source files matched, skipping');
  process.exit(0);
}
if (distNewest.mtime === 0) {
  console.error('[check-dist-fresh] FAIL — dist/ exists but contains no files.');
  process.exit(1);
}

const srcDate = new Date(srcNewest.mtime).toISOString();
const distDate = new Date(distNewest.mtime).toISOString();

if (srcNewest.mtime > distNewest.mtime) {
  console.error('');
  console.error('  ╔══════════════════════════════════════════════════════════════════╗');
  console.error('  ║  STALE FRONTEND DETECTED — BUILD HALTED                           ║');
  console.error('  ╚══════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`  Newest source file:  ${srcNewest.file}`);
  console.error(`                       (${srcDate})`);
  console.error(`  Newest dist file:    ${distNewest.file}`);
  console.error(`                       (${distDate})`);
  console.error('');
  console.error('  The frontend source is newer than the bundled dist/. Shipping');
  console.error('  this build would put stale chunks in the asar — same root');
  console.error('  cause as the 2026-04-27 trading-page crash.');
  console.error('');
  console.error('  Fix:  npm run sync-frontend');
  console.error('  Then re-run the build.');
  console.error('');
  console.error('  (Override only when you know dist is intentionally stale:');
  console.error('   AURA_SKIP_DIST_CHECK=1 npm run build)');
  console.error('');
  process.exit(1);
}

console.log(`[check-dist-fresh] OK — dist (${distDate}) ≥ source (${srcDate})`);
process.exit(0);
