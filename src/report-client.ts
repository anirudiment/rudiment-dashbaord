#!/usr/bin/env node
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

import { getActiveClients } from './config/clients.config';
import { EmailBisonService } from './services/emailbison.service';
import { HeyReachService } from './services/heyreach.service';
import { CampaignMetrics } from './types';

dotenv.config();

function getArg(args: string[], key: string) {
  const eq = args.find(a => a.startsWith(`${key}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = args.findIndex(a => a === key);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function pct(n: number) {
  return `${n.toFixed(2)}%`;
}

function sum(metrics: CampaignMetrics[], key: keyof CampaignMetrics) {
  return metrics.reduce((acc, m) => acc + Number((m as any)[key] ?? 0), 0);
}

function groupByPlatform(metrics: CampaignMetrics[]) {
  const by: Record<string, CampaignMetrics[]> = {};
  for (const m of metrics) {
    const k = String(m.platform);
    by[k] = by[k] ?? [];
    by[k].push(m);
  }
  return by;
}

async function main() {
  const args = process.argv.slice(2);
  const clientId = getArg(args, '--client');

  if (!clientId) {
    console.error('Missing --client. Example: tsx src/report-client.ts --client=client2');
    process.exit(1);
  }

  const active = getActiveClients();
  const entry = active.find(c => c.id === clientId);
  if (!entry) {
    console.error(`Unknown/inactive clientId: ${clientId}`);
    console.error(`Active clients: ${active.map(c => c.id).join(', ') || '(none)'}`);
    process.exit(2);
  }

  const clientName = entry.config.name;
  const allMetrics: CampaignMetrics[] = [];

  if (entry.config.platforms.emailbison?.enabled) {
    const svc = new EmailBisonService(entry.config.platforms.emailbison.apiKey);
    // For reporting, enrich EmailBison campaigns with lifetime Interested counts.
    const emailMetrics = await svc.getAllCampaignMetrics(clientName);

    for (const m of emailMetrics) {
      // Attempt to fetch lifetime event totals to compute success metrics like Interested rate.
      const id = Number(m.campaignId);
      if (Number.isFinite(id)) {
        try {
          const totals = await svc.getLifetimeEventTotals(id);
          const interested = Number(totals['Interested'] ?? 0);
          const replied = Number(totals['Replied'] ?? m.repliedCount ?? 0);
          m.interestedCount = interested;
          // Interested rate definition: Interested / Replied
          (m as any).interestedRate = replied > 0 ? (interested / replied) * 100 : 0;
        } catch {
          // ignore enrichment failures
        }
      }
      allMetrics.push(m);
    }
  }

  if (entry.config.platforms.heyreach?.enabled) {
    const svc = new HeyReachService(entry.config.platforms.heyreach.apiKey);
    allMetrics.push(...(await svc.getAllCampaignMetrics(clientName)));
  }

  if (entry.config.platforms.instantly?.enabled) {
    // optional: include Instantly if enabled for this client
    const { InstantlyService } = await import('./services/instantly.service');
    const svc = new InstantlyService(entry.config.platforms.instantly.apiKey);
    allMetrics.push(...(await svc.getAllCampaignMetrics(clientName)));
  }

  const generatedAt = new Date().toISOString();
  const campaigns = allMetrics.length;

  const sent = sum(allMetrics, 'sentCount');
  const bounced = sum(allMetrics, 'bouncedCount');
  const replied = sum(allMetrics, 'repliedCount');
  const interested = sum(allMetrics, 'interestedCount');
  const leadsTotal = sum(allMetrics, 'leadsTotal');
  const leadsRemaining = sum(allMetrics, 'leadsRemaining');

  const bounceRate = sent > 0 ? (bounced / sent) * 100 : 0;
  const replyRate = sent > 0 ? (replied / sent) * 100 : 0;

  const byPlatform = groupByPlatform(allMetrics);

  const lines: string[] = [];
  lines.push(`# Campaign Overview — ${clientName}`);
  lines.push('');
  // Avoid escaping backticks inside template strings (tsx/esbuild can be picky)
  lines.push('**Client ID:** ' + '`' + clientId + '`');
  lines.push(`**Generated at:** ${generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Campaigns monitored: **${campaigns}**`);
  lines.push(`- Leads remaining (sum): **${leadsRemaining} / ${leadsTotal}**`);
  lines.push(`- Sent (sum): **${sent}**`);
  lines.push(`- Replies (sum): **${replied}**`);
  lines.push(`- Interested (sum): **${interested}**`);
  lines.push(`- Bounced (sum): **${bounced}**`);
  lines.push(`- Reply rate (overall): **${pct(replyRate)}**`);
  lines.push(`- Bounce rate (overall): **${pct(bounceRate)}**`);
  lines.push('');

  lines.push('## By platform');
  lines.push('');
  lines.push('| Platform | Campaigns | Leads remaining | Sent | Replies | Interested | Bounced | Reply rate | Bounce rate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [platform, ms] of Object.entries(byPlatform)) {
    const pSent = sum(ms, 'sentCount');
    const pBounced = sum(ms, 'bouncedCount');
    const pReplied = sum(ms, 'repliedCount');
    const pInterested = sum(ms, 'interestedCount');
    const pLeadsTotal = sum(ms, 'leadsTotal');
    const pLeadsRemaining = sum(ms, 'leadsRemaining');

    const pBounceRate = pSent > 0 ? (pBounced / pSent) * 100 : 0;
    const pReplyRate = pSent > 0 ? (pReplied / pSent) * 100 : 0;

    lines.push(
      `| ${platform} | ${ms.length} | ${pLeadsRemaining}/${pLeadsTotal} | ${pSent} | ${pReplied} | ${pInterested} | ${pBounced} | ${pct(pReplyRate)} | ${pct(pBounceRate)} |`
    );
  }

  lines.push('');
  lines.push('## Campaigns');
  lines.push('');
  lines.push('| Platform | Campaign | Leads remaining | Sent | Replies | Interested | Interested rate* | Bounced | Reply rate | Bounce rate |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');

  // Sort: lowest leads remaining first
  const sorted = [...allMetrics].sort((a, b) => (a.leadsRemaining ?? 0) - (b.leadsRemaining ?? 0));
  for (const m of sorted) {
    const interestedRate = Number((m as any).interestedRate ?? 0);
    lines.push(
      `| ${m.platform} | ${m.campaignName ?? m.campaignId} | ${m.leadsRemaining}/${m.leadsTotal} | ${m.sentCount ?? m.emailsSent} | ${m.repliedCount ?? 0} | ${m.interestedCount ?? 0} | ${pct(interestedRate)} | ${m.bouncedCount ?? 0} | ${pct(m.replyRate)} | ${pct(m.bounceRate)} |`
    );
  }

  lines.push('');
  lines.push('*Interested rate = Interested / Replied (lifetime, where available).');

  const outDir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${clientId}-overview.md`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');

  console.log(`✅ Wrote report: ${outPath}`);
  console.log(`   Campaigns: ${campaigns}`);
  console.log(`   Reply rate: ${pct(replyRate)} | Bounce rate: ${pct(bounceRate)}`);
}

main().catch(err => {
  console.error('Report generation failed:', err);
  process.exit(1);
});
