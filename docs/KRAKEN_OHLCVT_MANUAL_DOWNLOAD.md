# Kraken Full OHLCVT — Manual Download

The Kraken full historical OHLCVT zip is hosted on Google Drive and
is "popular enough" that Drive throttles automated download tools
like `gdown` with a quota error. This is permanent — no automation
fix without a paid Drive workaround.

## Manual recovery (Desktop, browser)

1. On Desktop, open Edge or Chrome.
2. Navigate to:
   `https://drive.google.com/file/d/1ptNqWYidLkhb2VAKuLCxmp2OXEfGO-AP/view?usp=sharing`
3. Click the **Download** icon (top-right). Drive may show a
   "can't scan for viruses, file is too large" page — click
   **Download anyway**.
4. Save the file as `kraken_full_ohlcvt.zip` to:
   `D:\AuraAlphaData\kraken\kraken_full_ohlcvt.zip`
5. Expected size: ~30 GB. At 35 Mbps residential, ~2 hours.

## After download

From WSL (or any shell with /mnt/d access):

```
cd /mnt/d/AuraAlphaData/kraken
unzip -q kraken_full_ohlcvt.zip -d extracted/
ls extracted | head
```

Each pair has its own CSV (e.g., `XBTUSD_60.csv` for 1-min, `XBTUSD_1440.csv`
for daily). Headers: timestamp, open, high, low, close, volume, trades.

## What this gets you

- 100+ Kraken trading pairs
- All available history (since pair launch)
- 1-min, 5-min, 15-min, 1-hr, 4-hr, daily resolutions
- Free, no API rate limit, no daily refresh — re-download monthly
  for fresh end-of-history data

## Why we don't auto-pull this

- Drive quota error blocks `gdown` and any other API-based fetch
- Setting up a Drive service-account is overkill for a once-monthly grab
- Kraken's own API gives last 720 candles per call, useless for full
  history backfill — yfinance + this manual zip is the simplest path

## Refresh cadence

Monthly re-download is sufficient. Live trading data flows separately
through the Kraken WebSocket API in `bots/equity/engine.py`.
