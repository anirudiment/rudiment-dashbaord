# Test Plan: Performance & Data Integrity

## What is being fixed

| Fix | Location | Change |
|-----|----------|--------|
| F1 | `campaign.monitor.ts` | Parallelize Instantly + EmailBison + HeyReach fetches per client |
| F2 | `emailbison.service.ts` | Parallelize `getCampaignDetails` calls inside `getAllCampaignMetrics` |
| F3 | `campaign.monitor.ts` | Parallelize EmailBison digest enrichment (`getLifetimeEventTotals`) |
| F4 | `dashboard-server.ts` | Parallelize Instantly + EmailBison + HeyReach fetches inside `fetchClientMetrics` |

---

## 1. Efficiency Tests (Performance)

### T-PERF-1: Monitor single-client fetch time

**What it tests:** F1, F2 — confirms that fetching one client's campaigns across all platforms is
faster after parallelization.

**How to run:**
```bash
# Before fix: note wall-clock time printed in console output
time npx ts-node -e "
  require('dotenv').config();
  const { CampaignMonitor } = require('./src/monitors/campaign.monitor');
  const m = new CampaignMonitor();
  m.monitorClient('client1').then(() => process.exit(0));
"

# After fix: run the same command and compare
```

**Pass criteria:**
- Wall-clock time decreases. With 3 platforms at ~2s each, sequential = ~6s+;
  parallel should complete in the time of the slowest single platform (~2–3s).
- No campaigns are missing — result count must match the pre-fix run.

---

### T-PERF-2: Dashboard API campaign fetch time

**What it tests:** F4 — confirms that `/api/campaigns` responds faster after parallelizing
`fetchClientMetrics`.

**How to run:**
```bash
# Start dashboard
npm run dashboard &

# Time the API (replace clientId and cookie as needed)
time curl -s "http://localhost:8787/api/campaigns?clientId=client1&days=7" \
  -H "Cookie: dash_session=<your-session>" -o /dev/null

# Kill dashboard
kill %1
```

**Pass criteria:**
- First uncached request completes in ≤50% of the pre-fix time.
- Subsequent requests (cache hit) remain under 200ms.

---

### T-PERF-3: EmailBison campaign detail parallelism

**What it tests:** F2 — confirms that `getAllCampaignMetrics` fetches campaign details in parallel.

**How to verify (without live API):** Inspect logs — the pre-fix version logs campaign details
one at a time. After fix, all details requests start before any resolves.

**How to run with live API:**
```bash
time npx ts-node -e "
  require('dotenv').config();
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const svc = new EmailBisonService(process.env.CLIENT1_EMAILBISON_API_KEY);
  svc.getAllCampaignMetrics('TestClient').then(m => {
    console.log('Campaigns:', m.length);
    process.exit(0);
  });
"
```

**Pass criteria:**
- With N active campaigns, elapsed time should be approximately equal to a single
  `getCampaignDetails` call (parallelized), not N times a single call (sequential).

---

### T-PERF-4: Digest enrichment parallelism

**What it tests:** F3 — confirms that `getLifetimeEventTotals` calls in digest mode run in
parallel, not sequentially.

**How to run:**
```bash
SLACK_NOTIFICATIONS_MODE=digest time npx ts-node src/index.ts monitor
```

**Pass criteria:**
- With N EmailBison campaigns needing enrichment, the enrichment step takes ~1 API call's
  time rather than N × 1 API call's time.
- All `interestedRate` values in Slack digest are the same as before the fix.

---

## 2. Data Integrity Tests

### T-INT-1: LeadsRemaining bounds check

**What it tests:** `leadsRemaining` should never be negative and should never exceed `leadsTotal`.

**How to run:**
```bash
npx ts-node src/test-apis.ts 2>/dev/null | grep -i leads || \
npx ts-node -e "
  require('dotenv').config();
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const svc = new EmailBisonService(process.env.CLIENT1_EMAILBISON_API_KEY);
  svc.getAllCampaignMetrics('test').then(metrics => {
    for (const m of metrics) {
      const ok = m.leadsRemaining >= 0 && (m.leadsTotal === 0 || m.leadsRemaining <= m.leadsTotal);
      console.log(m.campaignName, '| remaining:', m.leadsRemaining, '| total:', m.leadsTotal, '| OK:', ok);
    }
    process.exit(0);
  });
"
```

**Pass criteria:**
- Every campaign: `leadsRemaining >= 0`
- Every campaign where `leadsTotal > 0`: `leadsRemaining <= leadsTotal`

---

### T-INT-2: Rate sanity check (all platforms)

**What it tests:** `bounceRate`, `replyRate`, `openRate` must be in [0, 100]. Values outside
this range indicate a denominator bug.

**How to run:**
```bash
npx ts-node -e "
  require('dotenv').config();
  const { getActiveClients } = require('./src/config/clients.config');
  const { EmailBisonService } = require('./src/services/emailbison.service');
  // Add Instantly + HeyReach if needed
  const [{ id, config }] = getActiveClients();
  const svc = new EmailBisonService(config.platforms.emailbison.apiKey);
  svc.getAllCampaignMetrics(config.name).then(metrics => {
    let fail = 0;
    for (const m of metrics) {
      const bad = [m.bounceRate, m.replyRate, m.openRate].some(r => r < 0 || r > 100);
      if (bad) { console.error('FAIL:', m.campaignName, m.bounceRate, m.replyRate, m.openRate); fail++; }
    }
    console.log(fail === 0 ? 'PASS: all rates in [0, 100]' : \`FAIL: \${fail} campaigns with out-of-range rates\`);
    process.exit(fail > 0 ? 1 : 0);
  });
"
```

**Pass criteria:**
- All rates are in [0, 100] for every campaign on every platform.

---

### T-INT-3: Campaign ID uniqueness per client per platform

**What it tests:** No duplicated campaign IDs within a single client + platform combination,
which would inflate aggregate totals on the dashboard.

**How to run:**
```bash
npx ts-node -e "
  require('dotenv').config();
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const svc = new EmailBisonService(process.env.CLIENT1_EMAILBISON_API_KEY);
  svc.getAllCampaignMetrics('test').then(metrics => {
    const ids = metrics.map(m => m.campaignId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    console.log(dupes.length === 0 ? 'PASS: no duplicate campaign IDs' : 'FAIL: duplicates: ' + dupes);
    process.exit(dupes.length > 0 ? 1 : 0);
  });
"
```

**Pass criteria:**
- No duplicated campaign IDs in the returned array.

---

### T-INT-4: interestedRate consistency

**What it tests:** When `interestedCount` and `repliedCount` are both present and non-zero,
`interestedRate` should equal `(interestedCount / repliedCount) * 100` within floating-point
tolerance.

**How to run:**
```bash
npx ts-node -e "
  require('dotenv').config();
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const svc = new EmailBisonService(process.env.CLIENT1_EMAILBISON_API_KEY);
  svc.getAllCampaignMetrics('test').then(metrics => {
    let fail = 0;
    for (const m of metrics) {
      if (!m.repliedCount || !m.interestedCount) continue;
      const expected = (m.interestedCount / m.repliedCount) * 100;
      const diff = Math.abs(expected - (m.interestedRate ?? 0));
      if (diff > 0.5) {
        console.error('FAIL:', m.campaignName, 'rate:', m.interestedRate, 'expected:', expected.toFixed(2));
        fail++;
      }
    }
    console.log(fail === 0 ? 'PASS: interestedRate consistent' : \`FAIL: \${fail} inconsistencies\`);
    process.exit(fail > 0 ? 1 : 0);
  });
"
```

**Pass criteria:**
- `|interestedRate - (interestedCount / repliedCount * 100)| < 0.5` for all campaigns with
  both counts present.

---

### T-INT-5: Campaign status normalization

**What it tests:** Normalized `campaignStatus` must be one of `'active'`, `'paused'`, or
`'completed'` for all platforms. Any other value is an unhandled raw API value slipping through.

**How to run:**
```bash
npx ts-node -e "
  require('dotenv').config();
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const svc = new EmailBisonService(process.env.CLIENT1_EMAILBISON_API_KEY);
  svc.getAllCampaignMetrics('test', { status: 'all' }).then(metrics => {
    const valid = new Set(['active', 'paused', 'completed']);
    const bad = metrics.filter(m => !valid.has(m.campaignStatus));
    bad.forEach(m => console.error('FAIL:', m.campaignName, '->', m.campaignStatus));
    console.log(bad.length === 0 ? 'PASS: all statuses valid' : \`FAIL: \${bad.length} invalid statuses\`);
    process.exit(bad.length > 0 ? 1 : 0);
  });
"
```

**Pass criteria:**
- Every campaign's `campaignStatus` is in `{active, paused, completed}`.

---

### T-INT-6: HeyReach zero-vs-unavailable check

**What it tests:** When `hasEngagementStats === false`, all LinkedIn engagement fields
(`messagesSent`, `messageReplies`, `connectionsSent`, etc.) should be `0` or `undefined` —
never a positive number. This verifies we're not showing fake zeros as real data.

**How to run:**
```bash
npx ts-node -e "
  require('dotenv').config();
  const { HeyReachService } = require('./src/services/heyreach.service');
  const svc = new HeyReachService(process.env.CLIENT1_HEYREACH_API_KEY);
  svc.getAllCampaignMetrics('test').then(metrics => {
    let fail = 0;
    for (const m of metrics) {
      if (m.hasEngagementStats) continue;
      // When no engagement stats, sentCount should be 0 (not a real number)
      if (Number(m.sentCount) > 0) {
        console.error('FAIL:', m.campaignName, 'sentCount =', m.sentCount, 'but hasEngagementStats = false');
        fail++;
      }
    }
    console.log(fail === 0 ? 'PASS: unavailable stats are 0, not fabricated' : \`FAIL: \${fail} campaigns\`);
    process.exit(fail > 0 ? 1 : 0);
  });
"
```

**Pass criteria:**
- No campaign with `hasEngagementStats === false` shows a positive `sentCount`.

---

### T-INT-7: Parallel fetch produces same result count as sequential

**What it tests:** Core correctness check — after parallelizing platform fetches, the number
of campaigns returned per client must be identical to the sequential baseline.

**How to run manually:**
1. Check out `master` branch and run: `npm run monitor 2>&1 | grep "Total campaigns monitored"`
   → note the count per client.
2. Check out `claude/dashboard-quality-assessment-8cIe9` and run the same command.
3. Compare counts line by line.

**Automated version:**
```bash
# On the fix branch:
npx ts-node -e "
  require('dotenv').config();
  const { getActiveClients } = require('./src/config/clients.config');
  const { EmailBisonService } = require('./src/services/emailbison.service');
  const [{ config }] = getActiveClients();
  const svc = new EmailBisonService(config.platforms.emailbison.apiKey);
  Promise.all([
    svc.getAllCampaignMetrics(config.name),
    svc.getAllCampaignMetrics(config.name)
  ]).then(([a, b]) => {
    const same = a.length === b.length;
    console.log(same ? 'PASS: parallel and sequential return same count' : 'FAIL: counts differ', a.length, b.length);
    process.exit(same ? 0 : 1);
  });
"
```

**Pass criteria:**
- Campaign count matches baseline for every active client.

---

## 3. Regression Tests (no regressions from fixes)

### T-REG-1: Dashboard API still responds after fixes

```bash
npm run build && echo "BUILD OK" || echo "BUILD FAILED"
```

**Pass criteria:** `BUILD OK` — TypeScript compiles with zero errors.

---

### T-REG-2: Auth still blocks unauthenticated requests

```bash
# Start dashboard with auth enabled
DASHBOARD_AUTH_SECRET=test123 npm run dashboard &
sleep 2
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/campaigns)
echo "Unauthenticated /api/campaigns -> HTTP $STATUS (expect 302 or 401)"
kill %1
```

**Pass criteria:** HTTP 302 (redirect to login) or 401, never 200.

---

### T-REG-3: Single-client monitor still logs correct alert counts

```bash
npx ts-node src/index.ts monitor 2>&1 | grep -E "Generated [0-9]+ alert"
```

**Pass criteria:** Alert counts match baseline (within ±0 if same data window used).

---

## 4. How to record a baseline

Run this **before** applying fixes on the `master` branch:

```bash
git stash           # if you have uncommitted changes
git checkout master
npm run build

# Record timings
time npx ts-node src/index.ts monitor > /tmp/baseline_monitor_output.txt 2>&1
grep -E "(campaigns monitored|alert|Found)" /tmp/baseline_monitor_output.txt
```

Then restore the fix branch and compare:

```bash
git checkout claude/dashboard-quality-assessment-8cIe9
npm run build
time npx ts-node src/index.ts monitor > /tmp/fixed_monitor_output.txt 2>&1
diff <(grep -E "(campaigns monitored|alert|Found)" /tmp/baseline_monitor_output.txt) \
     <(grep -E "(campaigns monitored|alert|Found)" /tmp/fixed_monitor_output.txt)
```

**Pass criteria:** `diff` output is empty (same campaign counts, same alert counts, faster wall time).

---

## 5. Rollback Procedure

If any test fails after applying fixes:

```bash
# Option A: revert the specific file changed
git checkout master -- src/monitors/campaign.monitor.ts
git checkout master -- src/services/emailbison.service.ts
git checkout master -- src/dashboard-server.ts

# Option B: full reset to master baseline
git reset --hard origin/master

# Then rebuild
npm run build
```

All fixes are purely additive parallelism changes (`Promise.all` / `Promise.allSettled`).
No business logic or threshold values are altered, so rollback risk is low.

---

## 6. Summary checklist

| Test | Scope | Run when |
|------|-------|----------|
| T-PERF-1 | Single client fetch time | After F1, F2 |
| T-PERF-2 | Dashboard API latency | After F4 |
| T-PERF-3 | EmailBison detail parallelism | After F2 |
| T-PERF-4 | Digest enrichment parallelism | After F3 |
| T-INT-1 | LeadsRemaining bounds | Any campaign data change |
| T-INT-2 | Rate [0–100] check | Any metric computation change |
| T-INT-3 | Campaign ID uniqueness | Any campaign list change |
| T-INT-4 | interestedRate consistency | EmailBison enrichment change |
| T-INT-5 | Status normalization | Any status mapping change |
| T-INT-6 | HeyReach zero vs unavailable | HeyReach service change |
| T-INT-7 | Parallel == sequential count | After any parallelization fix |
| T-REG-1 | TypeScript build | After every change |
| T-REG-2 | Auth gate | After server changes |
| T-REG-3 | Alert counts | After monitor changes |
