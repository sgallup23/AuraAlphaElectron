#!/usr/bin/env node
//
// verify-dist-integrity.js — pre-pack guard that catches broken dist/.
//
// Runs in CI (and locally) to catch the case where dist/index.html
// references chunks that don't exist on disk. This is the renderer-side
// failure mode for the 2026-04-27 trading-page crash: the asar shipped
// stale chunks because nothing validated that index.html's referenced
// assets were all present.
//
// Exits 1 on any missing chunk. Otherwise quietly passes.
//

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const INDEX = path.join(DIST, 'index.html');

if (!fs.existsSync(INDEX)) {
  console.error('[verify-dist-integrity] FAIL — dist/index.html missing');
  process.exit(1);
}

const refs = new Set();
const chunkRe = /["'`]\/?(assets\/[A-Za-z0-9._-]+\.(?:js|css))["'`]/g;

function harvest(text) {
  // Tag attributes (script/link)
  const re = /(?:src|href)=["']\/?(assets\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) refs.add(m[1]);
  // Inline string references — vite modulepreload + lazy import("/assets/X.js")
  while ((m = chunkRe.exec(text))) refs.add(m[1]);
}

// Start from index.html, then expand by also scanning the entry chunks it
// loads. This catches lazy-loaded chunk references inside JS bundles —
// the failure mode that caused the 2026-04-27 trading-page crash, where
// BotDetailPage referenced an older sibling chunk by hash.
harvest(fs.readFileSync(INDEX, 'utf8'));
const initialRefs = new Set(refs);
for (const ref of initialRefs) {
  if (!ref.endsWith('.js')) continue;
  const p = path.join(DIST, ref);
  if (fs.existsSync(p)) {
    harvest(fs.readFileSync(p, 'utf8'));
  }
}

if (refs.size === 0) {
  console.error('[verify-dist-integrity] FAIL — index.html references no chunks');
  process.exit(1);
}

const missing = [];
for (const ref of refs) {
  const p = path.join(DIST, ref);
  if (!fs.existsSync(p)) missing.push(ref);
}

if (missing.length > 0) {
  console.error('');
  console.error('  ╔══════════════════════════════════════════════════════════════════╗');
  console.error('  ║  BROKEN DIST DETECTED — BUILD HALTED                              ║');
  console.error('  ╚══════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`  index.html references ${missing.length} chunk(s) that don't exist on disk:`);
  for (const ref of missing) console.error(`    - ${ref}`);
  console.error('');
  console.error('  This means dist/ is internally inconsistent. Most likely cause:');
  console.error('  index.html and assets/ came from different builds. Fix:');
  console.error('    npm run sync-frontend');
  console.error('');
  process.exit(1);
}

console.log(`[verify-dist-integrity] OK — all ${refs.size} chunks present`);
process.exit(0);
