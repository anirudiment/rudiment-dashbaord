# Rudiment Monitor — Dashboard (V1)

This is a minimal, MVP-friendly dashboard intended for internal weekly check-ins.

## Run locally

1. Ensure you have `.env` configured (see root `README.md`).
2. Start the dashboard:

```bash
npm run dashboard
```

Then open:

- http://localhost:8787

## HeyReach 429 / rate-limit notes (stability)

HeyReach’s **per-campaign stats** endpoint can return **HTTP 429** if the dashboard refreshes a lot (the API is rate limited).

To keep the dashboard stable:

- HeyReach per-campaign stats enrichment is **OFF by default**.
- HeyReach KPI cards use a **single aggregated stats request** (more stable than per-campaign).
- The dashboard uses a small **in-memory cache** (default 60s) to prevent repeated refreshes from spamming upstream APIs.

## Evergreen HeyReach per-campaign stats (recommended)

HeyReach’s public API is rate limited (e.g. **10 requests / 2 seconds**). The dashboard avoids 429s by:

- fetching HeyReach campaign list only **once** per refresh (and de-duping concurrent requests)
- populating per-campaign HeyReach engagement stats via a **server-side cache warmer**

Behavior:

- First load may show “—” in the HeyReach campaign table for ~10–30s.
- Then refresh and the per-campaign table fills.
- After that, values are served from cache (no constant spamming).

Tuning knobs (optional env vars):

```bash
# how long to keep per-campaign HeyReach stats (seconds)
HEYREACH_STATS_CACHE_SECONDS=900

# minimum time between refresh attempts for the same window
HEYREACH_STATS_MIN_INTERVAL_SECONDS=15

# throttle: how many campaigns to fetch in parallel (public API fallback)
HEYREACH_STATS_CONCURRENCY=1

# throttle: delay between per-campaign calls (ms)
HEYREACH_STATS_DELAY_MS=250
```

### Opt-in to HeyReach stats enrichment

You can enable HeyReach stats enrichment in one of two ways:

1) Query param (per request):

```
http://localhost:8787/?heyreachStats=1
```

2) Environment variable (global):

```bash
DASHBOARD_HEYREACH_STATS=1 npm run dashboard
```

### Cache TTL

Default cache TTL is 60 seconds. To change:

```bash
DASHBOARD_CACHE_SECONDS=120 npm run dashboard
```

## What it shows

- KPI cards: sent, contacted, replies, interested, reply rate, bounce rate
- Active campaigns table
- Simple daily chart (EmailBison time-series only for now)

## Notes

- This V1 uses live API calls on refresh (no persistence yet).
- “Interested” is currently pulled from EmailBison `Interested` event counts.

