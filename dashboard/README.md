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

## What it shows

- KPI cards: sent, contacted, replies, interested, reply rate, bounce rate
- Active campaigns table
- Simple daily chart (EmailBison time-series only for now)

## Notes

- This V1 uses live API calls on refresh (no persistence yet).
- “Interested” is currently pulled from EmailBison `Interested` event counts.

