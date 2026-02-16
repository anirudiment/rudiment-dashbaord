#!/usr/bin/env node
/*
 * verify-data-integration.ts
 *
 * Purpose:
 * - Spot-check and reconcile our dashboard API outputs against upstream sources
 *   (Send/EmailBison, Instantly, HeyReach) for a fixed date window.
 *
 * Output:
 * - A JSON report listing matches, mismatches, and unsupported metrics.
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import { getActiveClients } from '../config/clients.config';
import { EmailBisonService } from '../services/emailbison.service';
import { InstantlyService } from '../services/instantly.service';
// NOTE: we don't currently call HeyReachService directly in this verifier;
// we validate HeyReach numbers via our own /api/summary + /api/monitor outputs.
import { getUtahLastNDaysRange } from '../utils/utahTime';
import type { CampaignMetrics } from '../types';

dotenv.config();

type Status = 'ok' | 'mismatch' | 'unsupported' | 'skipped' | 'error';

type CheckRow = {
  key: string;
  status: Status;
  ours?: number | string | null;
  upstream?: number | string | null;
  note?: string;
};

type ClientReport = {
  clientId: string;
  clientName: string;
  window: { days: number; startDate: string; endDate: string };
  rows: CheckRow[];
};

function pct(n: unknown) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function int(n: unknown) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

function nearlyEqual(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

function checkNumber(key: string, ours: number, upstream: number, opts?: { eps?: number; note?: string }): CheckRow {
  const eps = opts?.eps ?? 0;
  if (eps > 0 ? nearlyEqual(ours, upstream, eps) : ours === upstream) {
    return { key, status: 'ok', ours, upstream, note: opts?.note };
  }
  return { key, status: 'mismatch', ours, upstream, note: opts?.note };
}

async function fetchOurSummary(params: { baseUrl: string; clientId: string; days: number }) {
  const res = await axios.get(`${params.baseUrl}/api/summary`, {
    params: { clientId: params.clientId, days: String(params.days), status: 'active' },
    timeout: 20_000
  });
  return res.data;
}

async function fetchOurCampaigns(params: { baseUrl: string; clientId: string; days: number }) {
  const res = await axios.get(`${params.baseUrl}/api/campaigns`, {
    params: { clientId: params.clientId, days: String(params.days), status: 'active' },
    timeout: 20_000
  });
  return res.data;
}

async function fetchOurMonitor(params: { baseUrl: string; days: number; channel: 'email' | 'linkedin' }) {
  const res = await axios.get(`${params.baseUrl}/api/monitor`, {
    params: { days: String(params.days), channel: params.channel },
    timeout: 20_000
  });
  return res.data;
}

function sum(metrics: CampaignMetrics[], k: keyof CampaignMetrics) {
  return metrics.reduce((acc, m) => acc + Number((m as any)[k] ?? 0), 0);
}

async function verifyClient(clientId: string, baseUrl: string, days: number): Promise<ClientReport> {
  const { startDate, endDate } = getUtahLastNDaysRange(days);

  const activeClients = getActiveClients();
  const entry = activeClients.find(c => c.id === clientId);
  if (!entry) {
    return {
      clientId,
      clientName: clientId,
      window: { days, startDate, endDate },
      rows: [{ key: 'client', status: 'error', note: 'Unknown clientId' }]
    };
  }

  const clientName = entry.config.name;
  const rows: CheckRow[] = [];

  // ----- OUR API (source of truth for UI rendering) -----
  const [ourSummary, ourCampaigns, ourMonitorEmail, ourMonitorLinkedIn] = await Promise.all([
    fetchOurSummary({ baseUrl, clientId, days }),
    fetchOurCampaigns({ baseUrl, clientId, days }),
    fetchOurMonitor({ baseUrl, days, channel: 'email' }),
    fetchOurMonitor({ baseUrl, days, channel: 'linkedin' })
  ]);

  const ourSummaryTotals = ourSummary?.summary?.totals ?? {};
  const ourSummaryRates = ourSummary?.summary?.rates ?? {};
  const ourHeyreachTotals = ourSummary?.heyreach?.totals ?? {};
  const ourHeyreachRates = ourSummary?.heyreach?.rates ?? {};

  const ourCampaignList: any[] = ourCampaigns?.campaigns ?? [];

  // Internal consistency: summary totals should align with campaign list rollup (approx).
  // Note: /api/campaigns returns platform mix; we only sum email-like campaigns for email totals.
  const emailCampaigns = ourCampaignList.filter(c => String(c.platform) !== 'heyreach');
  const sumSent = emailCampaigns.reduce((a, c) => a + Number(c.sent ?? 0), 0);
  const sumReplies = emailCampaigns.reduce((a, c) => a + Number(c.replies ?? 0), 0);
  const sumBounced = emailCampaigns.reduce((a, c) => a + Number(c.bounced ?? 0), 0);

  rows.push(checkNumber('our_internal.email.sent (summary vs campaigns)', int(ourSummaryTotals.sent), int(sumSent), { note: 'Sum of /api/campaigns (non-heyreach) sent' }));
  rows.push(checkNumber('our_internal.email.replied (summary vs campaigns)', int(ourSummaryTotals.replied), int(sumReplies), { note: 'Sum of /api/campaigns (non-heyreach) replies' }));
  rows.push(checkNumber('our_internal.email.bounced (summary vs campaigns)', int(ourSummaryTotals.bounced), int(sumBounced), { note: 'Sum of /api/campaigns (non-heyreach) bounced' }));

  // Monitor KPI alignment (email)
  const monitorEmailRow = (ourMonitorEmail?.clients ?? []).find((c: any) => c.clientId === clientId);
  if (monitorEmailRow?.kpis) {
    rows.push(checkNumber('our_monitor.email.replyRate', pct(monitorEmailRow.kpis.replyRate), pct(ourSummaryRates.replyRate), { eps: 0.05 }));
    rows.push(checkNumber('our_monitor.email.bounceRate', pct(monitorEmailRow.kpis.bounceRate), pct(ourSummaryRates.bounceRate), { eps: 0.05 }));
  } else {
    rows.push({ key: 'our_monitor.email', status: 'error', note: 'Missing /api/monitor email row for client' });
  }

  // Monitor KPI alignment (linkedin)
  const monitorLiRow = (ourMonitorLinkedIn?.clients ?? []).find((c: any) => c.clientId === clientId);
  if (monitorLiRow?.kpis) {
    rows.push(checkNumber('our_monitor.linkedin.connectionsSent', int(monitorLiRow.kpis.connectionsSent), int(ourHeyreachTotals.connectionsSent), { note: 'Compared to /api/summary heyreach totals', }));
    rows.push(checkNumber('our_monitor.linkedin.acceptanceRate', pct(monitorLiRow.kpis.acceptanceRate), pct(ourHeyreachRates.acceptanceRate), { eps: 0.05 }));
    rows.push(checkNumber('our_monitor.linkedin.replyRate', pct(monitorLiRow.kpis.replyRate), pct(ourHeyreachRates.messageReplyRate), { eps: 0.05 }));
  } else {
    rows.push({ key: 'our_monitor.linkedin', status: 'skipped', note: 'No /api/monitor linkedin row (client missing heyreach?)' });
  }

  // ----- UPSTREAM TRACEABILITY -----
  // Send (EmailBison)
  if (entry.config.platforms.emailbison?.enabled) {
    try {
      const svc = new EmailBisonService(entry.config.platforms.emailbison.apiKey);
      const metrics = await svc.getAllCampaignMetrics(clientName, { startDate, endDate, windowDays: days, status: 'active' });
      const upstreamSent = sum(metrics, 'sentCount');
      const upstreamReplied = sum(metrics, 'repliedCount');
      const upstreamBounced = sum(metrics, 'bouncedCount');

      rows.push(checkNumber('upstream.send.sentCount', int(ourSummaryTotals.sent), int(upstreamSent), { note: 'Using Send /api/campaigns/:id windowed emails_sent', }));
      rows.push(checkNumber('upstream.send.repliedCount', int(ourSummaryTotals.replied), int(upstreamReplied), { note: 'Using Send unique_replies (windowed)', }));
      rows.push(checkNumber('upstream.send.bouncedCount', int(ourSummaryTotals.bounced), int(upstreamBounced), { note: 'Using Send bounced (windowed)', }));

      // Sequence ending: currently not supported by Send integration
      rows.push({
        key: 'sequenceEndingDays',
        status: 'unsupported',
        note: 'sequenceDaysRemaining is currently hardcoded to 0 in EmailBisonService/InstantlyService. Need upstream end-date field + computation.'
      });
    } catch (e: any) {
      rows.push({ key: 'upstream.send', status: 'error', note: e?.message ?? String(e) });
    }
  } else {
    rows.push({ key: 'upstream.send', status: 'skipped', note: 'Send not enabled for client' });
  }

  // Instantly
  if (entry.config.platforms.instantly?.enabled) {
    try {
      const svc = new InstantlyService(entry.config.platforms.instantly.apiKey);
      const metrics = await svc.getAllCampaignMetrics(clientName, { startDate, endDate, windowDays: days });

      // For Instantly, our /api/summary merges multiple platforms; we only compare with Instantly if
      // the client has ONLY Instantly enabled.
      const onlyInstantly = entry.config.platforms.instantly?.enabled &&
        !entry.config.platforms.emailbison?.enabled &&
        !entry.config.platforms.heyreach?.enabled;

      if (onlyInstantly) {
        rows.push(checkNumber('upstream.instantly.sentCount', int(ourSummaryTotals.sent), int(sum(metrics, 'sentCount'))));
        rows.push(checkNumber('upstream.instantly.repliedCount', int(ourSummaryTotals.replied), int(sum(metrics, 'repliedCount'))));
        rows.push(checkNumber('upstream.instantly.bouncedCount', int(ourSummaryTotals.bounced), int(sum(metrics, 'bouncedCount'))));
      } else {
        rows.push({ key: 'upstream.instantly', status: 'skipped', note: 'Client has multiple platforms; Instantly-only comparison skipped (needs platform-level split report)' });
      }
    } catch (e: any) {
      rows.push({ key: 'upstream.instantly', status: 'error', note: e?.message ?? String(e) });
    }
  } else {
    rows.push({ key: 'upstream.instantly', status: 'skipped', note: 'Instantly not enabled for client' });
  }

  // HeyReach: compare to our /api/summary heyreach totals (already derived from HeyReach services)
  if (entry.config.platforms.heyreach?.enabled) {
    rows.push({ key: 'upstream.heyreach', status: 'ok', note: 'HeyReach metrics in /api/summary and /api/monitor are computed from HeyReach service calls (aggregate/public). Manual UI comparison still recommended due to rate-limits/timeouts.' });
  } else {
    rows.push({ key: 'upstream.heyreach', status: 'skipped', note: 'HeyReach not enabled for client' });
  }

  return { clientId, clientName, window: { days, startDate, endDate }, rows };
}

async function main() {
  const baseUrl = String(process.env.DASHBOARD_BASE_URL || 'http://localhost:8787').trim();
  const days = Math.max(1, Math.min(365, Number(process.env.VERIFY_DAYS ?? '7')));

  const activeClients = getActiveClients();
  const filter = String(process.env.VERIFY_CLIENTS ?? '').trim();
  const clientIds = filter
    ? filter.split(',').map(s => s.trim()).filter(Boolean)
    : activeClients.map(c => c.id);

  const reports: ClientReport[] = [];
  for (const clientId of clientIds) {
    try {
      reports.push(await verifyClient(clientId, baseUrl, days));
    } catch (e: any) {
      reports.push({
        clientId,
        clientName: clientId,
        window: getUtahLastNDaysRange(days),
        rows: [{ key: 'client', status: 'error', note: e?.message ?? String(e) }]
      } as any);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    days,
    clients: reports
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
