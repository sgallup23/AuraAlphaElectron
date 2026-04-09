# CLAUDE.md — Aura Alpha Desktop (Electron)

## Overview

Aura Alpha Desktop is the Electron-based desktop application for the Aura Alpha autonomous trading platform. It bundles the web frontend (from AuraCommandV2) with a native grid compute worker, auto-updater, and IBKR Gateway proxy.

- **Repo**: github.com/sgallup23/AuraAlphaElectron
- **Current release**: v8.2.1
- **Framework**: Electron (Node.js main process + Chromium renderer)
- **Frontend source**: ~/AuraCommandV2/frontend/ (Vite + React, built into dist/)

## Architecture

```
main.js          — Electron main process (window management, API proxy, IPC)
preload.js       — Context bridge (exposes native APIs to renderer)
worker.js        — Grid compute worker (backtests, ML training, optimization)
updater.js       — Auto-update checker (GitHub releases)
dist/            — Bundled frontend (from AuraCommandV2/frontend npm build)
assets/          — App icons, images
```

## Key Configuration (in main.js)

```
API_BASE_DIRECT = 'http://54.172.235.137:8020'   — EC2 direct
API_BASE_CDN    = 'https://auraalpha.cc'          — via Cloudflare
COORDINATOR_URL = 'https://auraalpha.cc'          — grid job coordinator
```

## Grid Worker (worker.js)

The desktop app includes a built-in grid compute worker that:
- Connects to the coordinator at auraalpha.cc
- Picks up research_backtest, alpha_factory, optimization, ml_train jobs
- Uses GPU (NVIDIA RTX) when available via CUDA
- Auto-throttles when user is gaming or running heavy apps
- Reports to leaderboard (hostname: TradingDesktop)

## Build & Release Process

### Repack frontend into installed app (development)
```bash
# 1. Build frontend
cd ~/AuraCommandV2/frontend && npm run build

# 2. Repack asar (kills app, replaces bundle, clears caches)
cd ~/AuraAlphaDesktop && bash build-desktop.sh --skip-build
# Or with EC2 deploy: bash build-desktop.sh --deploy

# 3. Launch
# App auto-launches, or: Start from Windows Start Menu
```

### Create new release
```bash
cd ~/AuraAlphaElectron
# 1. Update version in package.json
# 2. Build: npm run build (creates installers in release/)
# 3. Tag and push: git tag v8.x.x && git push --tags
# 4. GitHub Actions CI builds Windows/macOS/Linux installers
# 5. Create GitHub release with the tag
```

## Important Paths (Windows)

```
Install:    C:\Users\shawn\AppData\Local\Programs\aura-alpha-desktop\
Asar:       ...\resources\app.asar
App data:   C:\Users\shawn\AppData\Roaming\aura-alpha-desktop\
Caches:     ...\Cache\, Code Cache\, GPUCache\, DawnGraphiteCache\, DawnWebGPUCache\
Exe:        ...\Aura Alpha.exe
```

## Known Issues & Recent Fixes (2026-04-09)

### Fixed
1. **Grid LIVE SPEED shows 0/min when workers are busy**
   - EMA decay was too aggressive (0.85). Worker heartbeats batch `jobs_completed` updates,
     so identical values between 15s polls → delta=0 → speed decays to zero.
   - Fix: decay 0.85 → 0.95 when worker status is busy/online (GridCompetition.jsx)
   - Also added `job_queue` real-time counts to leaderboard API

2. **Sentry 8066 errors flooding nginx**
   - VITE_SENTRY_DSN was set but GlitchTip relay on port 8066 wasn't running
   - Fix: cleared DSN from .env/.env.production, commented out nginx 8066 proxy

3. **App hangs on open after asar repack**
   - Old Electron processes hold file locks on app.asar
   - Fix: Kill all Aura processes first, clear all caches, then repack

4. **Login page logo layout**
   - Desktop login: logo fills left panel, "Autonomous Trading Intelligence" text directly below
   - No mirror reflection on desktop (cleaner look)

### Architecture Notes
- `AuraAlphaDesktop` repo (Tauri-based) is LEGACY — not the running app
- `AuraAlphaElectron` repo is the REAL desktop app
- Frontend is shared with web (AuraCommandV2) — same React codebase
- build-desktop.sh in AuraAlphaDesktop repacks the asar for development iteration

## Server-Side Intelligence Pipeline (connected to desktop)

The desktop app connects to EC2 which runs:
- Intelligence pipeline every 15 min (market_intel → regime → snapshot → allocator)
- Research engine (systemd, continuous backtesting)
- Signal scanner (60s loop, 8 regions including Europe/Asia)
- Grid job dispatch (nightly 3 AM UTC, 10K+ jobs)
- Portfolio snapshot (every 5 min during market hours)

The grid worker in the desktop app processes jobs dispatched by this pipeline.

## Do NOT

- Use the `AuraAlphaDesktop` Tauri source for anything — it's dead weight
- Hardcode `shawndeggans` anywhere — all repos are under `sgallup23`
- Deploy to EC2 during US market hours (9:30 AM – 4:00 PM ET)
- Remove the grid worker from the Electron build — users need it for compute contribution
