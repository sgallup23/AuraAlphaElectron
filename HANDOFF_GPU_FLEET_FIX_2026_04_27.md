# Electron Handoff — Fleet GPU + ml_train fix

**Date**: 2026-04-27 (next release window)
**Author**: laptop-claude (live triage) + synthesizer agent (release prep)
**Target version**: v9.4.3 (or v9.5.0 if you want a feature bump)
**Branch**: `fix/grid-worker-ml-train-deps-2026-04-27`
**Files edited**: `worker.js`, `grid_worker/standalone/job_router.py`,
`grid_worker/standalone/worker.py`, `grid_worker/standalone/api_client.py`,
`grid_worker/requirements.txt` (+ new `scripts/fleet_data_sync.sh`)

## What we found (root cause)

The Electron grid worker on Trading_Laptop never produced ml_train results despite the box having a 4090. Diagnosis through the live triage:

1. **Server side, Redis**: ml_train jobs were sitting at score ~8100 while research_backtest sat at ~5.001. `compute_priority_score()` and `auto_replenish.py` use **incompatible score scales**, so any ml_train job touched by `compute_priority_score` (e.g. when a worker rejected it via job_types filter) ended up buried 1620× behind research_backtest. Top of queue was 100% research_backtest with 3.8M ml_train queued.
   - **Fixed server-side**: prodesk commit `a18a617` rescaled `compute_priority_score` to `5.0±ε` matching the rest of the pipeline.
   - **Fixed backlog**: bulk-rescored 92k ml_train jobs from ~8100 → 4.99 so they surface.

2. **Server side, dispatcher**: `scripts/queue_keeper.sh` was dispatching ml_train for **all 79 catalogue strategies** even though `train_strategy_model_v2` only succeeds for 3 of them (`volume_climax_short`, `golden_cross`, `death_cross` — the ones with ≥100 joined feature/label rows). 96% of ml_train dispatches were guaranteed-fail dead-letters.
   - **Fixed server-side**: prodesk commit `2311cf5` filters strategies via `_load_backtest_labels` × `_load_features_v2` join, only dispatches the trainable ones.
   - **Backlog cleanup**: 83k dead-letter ml_train jobs purged from Redis; 18k matching PG rows deleted (data-only, not committed).

3. **Client side, Electron worker — REQUIRED_PY_DEPS**: The Windows-side Python that the Electron worker spawns (`C:\Python314\python.exe`) was **missing** `xgboost`, `lightgbm`, `optuna`, `scikit-learn`. So even when an ml_train job for a trainable strategy was claimed, the trainer crashed on `import xgboost` and the job was reported as failed. The misleading worker-side error was "insufficient data or split too small" (a generic fallback in `grid_worker/standalone/job_router.py` that masks the real exception).

4. **Client side, Electron worker — BASE detection**: `grid_worker/standalone/job_router.py` probes for the prodesk root using `Path.home() / TRADING_DESK / prodesk` etc. On a Windows install, when prodesk lives in WSL, **none** of those resolve, so `BASE = None` and every phase2-importing job fails. Failure was again masked by the catch-all error.

5. **Client side, Electron worker — AURA_JOB_TYPES**: there was no way to bias an individual worker toward ml_train, so during triage we had to live-patch the dequeue site. The plumbing for the server-side filter was already in place but the client wasn't passing the env through.

## What ships in v9.4.3

### Change 1 — extend `REQUIRED_PY_DEPS` in `worker.js`

Added `xgboost>=3.0.0`, `lightgbm>=4.5.0`, `optuna>=4.0.0`, `scikit-learn>=1.4.0` to the always-install list. Combined ~80 MB; pip is fast on already-satisfied. Without these, every ml_train job crashes on import.

### Change 2 — nvidia-smi-gated torch+CUDA install in `worker.js`

`ensurePythonDeps()` now probes `nvidia-smi` after the base install. If a GPU is detected AND torch isn't already importable with `cuda.is_available() == True`, pip-installs the cu124 wheel from `https://download.pytorch.org/whl/cu124`. CPU-only boxes skip the 2.5 GB download entirely. Idempotent: a follow-up launch with torch+CUDA already present is a sub-second no-op.

### Change 3 — WSL UNC fallback for BASE detection in `grid_worker/standalone/job_router.py`

When `os.name == "nt"`, append `\\wsl.localhost\Ubuntu\home\shawn\TRADING_DESK\prodesk` and the legacy `\\wsl$\` alias to the BASE candidate list, with `OSError` swallowed per-candidate so unavailable shares don't crash import. Long-term improvement: bundle a slimmed `phase2/` subset under `extraResources` and have it be the first candidate; the UNC fallback then becomes a safety net rather than the hot path.

### Change 4 — `AURA_JOB_TYPES` env passthrough in `grid_worker/standalone/worker.py` + `api_client.py`

`StandaloneWorker.run()` now reads `os.environ.get("AURA_JOB_TYPES")`, parses comma-separated tokens, and passes the list to `self.client.dequeue(count, job_types=…)`. `CoordinatorClient.dequeue()` accepts the new optional kwarg and includes it in the POST body — the server-side filter in `phase2/app/routes/grid_contributor.py` already accepts it. Unset env → no filter, identical behaviour to today.

### Change 5 — `grid_worker/requirements.txt` updated

Adds the four new ML deps, calls out the cu124 install command in comments, and notes that Electron auto-installs at launch (so the file is for manual / CI installs only).

## Validation checklist

A fresh installer goes through these 5 steps to confirm it's contributing GPU compute:

1. **Install Aura Alpha v9.4.3** (Windows installer or Linux AppImage). On first launch the worker should auto-install `xgboost+lightgbm+optuna+scikit-learn` (visible in worker log: `[worker] Checking Python dependencies...` → `[worker] Python dependencies satisfied`).
2. **Confirm GPU detection** — log line `[worker] Installing torch+CUDA...` (first install) or `[worker] torch+CUDA already present` (subsequent launches). On a CPU-only box, expect `[worker] No NVIDIA GPU detected, skipping torch+CUDA install`.
3. **Watch the leaderboard row** at `https://auraalpha.cc/api/grid/leaderboard` — within ~60s, the new worker's row should appear with `cuda_available=true`, `gpu_vram_gb` set, and `jobs_completed` incrementing (not stuck at 0 with rising heartbeats).
4. **Force an ml_train pull** to validate the trio + BASE detection: set `AURA_JOB_TYPES=ml_train` in the launcher env, restart the worker, and watch for `[worker] AURA_JOB_TYPES filter active: ['ml_train']`. The next batch should claim and **complete** ml_train jobs (not fail with "insufficient data or split too small").
5. **Cross-check on `/api/grid/status`** that this worker's `jobs_failed` rate stays under 5% over the first 30 minutes; a sustained 100% failure rate means torch/xgboost still isn't importing on this Python interpreter (check `[worker:stderr]` for `ModuleNotFoundError`).

## Data file requirements

The trainer reads two state files that **must** be available to the Python process:

- `state/ml_features_v2.parquet` — feature matrix joined to outcomes. Built nightly on EC2 by `scripts/build_ml_features_v2.py`.
- `state/aura_alpha_backtest_results_us.json` — **the `_us.json` suffixed variant**, NOT the no-suffix one. This is the file `train_strategy_model_v2` actually reads to find the trainable-strategy whitelist. Confusingly the no-suffix sibling exists and is loaded elsewhere; the trainer only honours `_us.json`.

These currently live on EC2 only; workers fetch them by path (which works inside WSL on prodesk-ec2 but not on a Windows-only laptop without the WSL UNC fallback). Two ways to handle them in v9.4.3+:

1. **Per-worker rsync (now)**: run `scripts/fleet_data_sync.sh` once a day from each contributor box (cron-friendly, idempotent, logs to `~/.aura-worker/state-sync.log`). Targets `prodesk-ec2.tail62e000.ts.net` over Tailscale; falls back to `$AURA_SYNC_HOST` env if set.
2. **API-served (next release)**: extend the contributor API with `/api/cluster/contributor/state/{name}` so the worker can lazy-fetch on first ml_train job. Removes the rsync dependency entirely; worth doing once we ship more state-dependent job types.

## What ships in the next grid-batch push (this PR)

1. `worker.js` — Changes 1 + 2 + AURA_JOB_TYPES doc-comment (no functional change there beyond plumbing through `process.env`).
2. `grid_worker/standalone/job_router.py` — Change 3.
3. `grid_worker/standalone/worker.py` + `grid_worker/standalone/api_client.py` — Change 4.
4. `grid_worker/requirements.txt` — Change 5.
5. `scripts/fleet_data_sync.sh` — bonus daily rsync helper.

**Not bumped**: `package.json` version. Shawn picks the bump (`9.4.2 → 9.4.3` patch or `→ 9.5.0` minor). The PR leaves package.json untouched so the bump is the explicit release-tag commit.

## Live state at handoff (per-machine)

The three peer agents handling each box will fill in their rows below. Placeholders left for Shawn to confirm before tagging.

| Box | Worker | torch | ml_train trio | sklearn | BASE found | jobs_completed (last 1h) | jobs_failed (last 1h) |
|---|---|---|---|---|---|---|---|
| TradingDesktop | standalone CLI | 2.6.0+cu124 | TBD by desktop-claude | TBD | TBD | TBD | TBD |
| Trading_Laptop | Electron v9.2.1 (live-patched) | 2.11.0+cu126 (Win Py) | installed | installed | yes (UNC) | TBD by laptop-claude | TBD |
| RedFishy | standalone CLI | 2.6.0+cu124 | TBD by redfishy-claude | TBD | TBD | TBD | TBD |
| sj-node | standalone CLI | TBD | TBD by sj-claude | TBD | TBD | TBD | TBD |

## Server-side fixes already shipped (`feature/seo-foundation`)

- `9d19dad` — broker test endpoint
- `3e0cf8e` — SQL placeholder fixes
- `a18a617` — `compute_priority_score` rescale
- `2311cf5` — queue_keeper trainable-strategy filter
- (data-only, not commit) 92k Redis rescores + 83k dead-letter purge

## Notes / loose ends

- `_load_strategy_names()` in `intelligence_feeder.py` is still used by the optimization-job dispatch path. That path may have some dead-letters too but it's ~5% of the queue versus the 10% ml_train share, so I left it alone for this pass. Worth a follow-up audit when training data grows.
- Tailscale tailnet has Desktop Windows offline since ~12h ago. Doesn't block fleet compute (Desktop WSL is online), but worth a manual reconnect when convenient.
- The `extraResources` bundling of `phase2/` (mentioned under Change 3) is a future improvement — it would eliminate the WSL dependency entirely and let the Electron worker run on macOS / Linux laptops that have no WSL.
