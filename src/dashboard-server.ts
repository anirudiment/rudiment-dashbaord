#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import * as dotenv from 'dotenv';
import { getActiveClients } from './config/clients.config';
import { EmailBisonService } from './services/emailbison.service';
import { HeyReachService } from './services/heyreach.service';
import { InstantlyService } from './services/instantly.service';
import { CampaignMetrics } from './types';
import { getUtahLastNDaysRange, listDaysInclusive, addDaysYmd } from './utils/utahTime';

dotenv.config();

type ClientMetricsResult = {
  clientId: string;
  clientName: string;
  metrics: CampaignMetrics[];
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function parseDateRange(searchParams: URLSearchParams) {
  const raw = (searchParams.get('days') ?? '7').toLowerCase();

  // Utah time requirement: use fixed MST (UTC-7) for calendar day boundaries.
  // NOTE: We keep lifetime end date as “today in Utah” too so it aligns with platform UI.
  const todayUtah = getUtahLastNDaysRange(1).endDate;

  // Lifetime means: very early start date to today.
  if (raw === 'lifetime') {
    return { days: 3650, startDate: '2000-01-01', endDate: todayUtah, isLifetime: true };
  }

  // Default: last N days (cap at 365 for safety)
  const days = Math.max(1, Math.min(365, Number(raw || 7)));
  const { startDate, endDate } = getUtahLastNDaysRange(days);
  return { days, startDate, endDate, isLifetime: false };
}

async function fetchClientMetrics(params: {
  clientId: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  status?: string;
}): Promise<ClientMetricsResult | null> {
  const activeClients = getActiveClients();
  const entry = activeClients.find(c => c.id === params.clientId);
  if (!entry) return null;

  const { config } = entry;
  const clientName = config.name;
  const metrics: CampaignMetrics[] = [];

  const status = String(params.status || 'active').toLowerCase();

  // Instantly
  if (config.platforms.instantly?.enabled) {
    try {
      const svc = new InstantlyService(config.platforms.instantly.apiKey);

      // Build campaign id set based on requested status
      const campaigns = await svc.getCampaigns();
      const ids = new Set(
        campaigns
          .filter((c: any) => {
            const s = (c as any)?.status;
            // Best-effort mapping for Instantly v2 numeric status.
            const norm = typeof s === 'number' ? s : String(s ?? '').toLowerCase();
            const isActive = norm === 1 || norm === 'active';
            const isPaused = norm === 2 || norm === 'paused';
            // Completed in Instantly can be represented by other numeric statuses; treat anything not active/paused as completed.
            const isCompleted = !isActive && !isPaused;

            if (status === 'all') return true;
            if (status === 'active') return isActive;
            if (status === 'paused') return isPaused;
            if (status === 'completed') return isCompleted;
            return isActive;
          })
          .map((c: any) => String((c as any)?.id ?? (c as any)?.campaign_id ?? ''))
          .filter(Boolean)
      );

      metrics.push(
        ...(await svc.getAllCampaignMetrics(clientName, {
          startDate: params.startDate,
          endDate: params.endDate,
          windowDays: params.days,
          activeCampaignIds: Array.from(ids)
        }))
      );
    } catch (e) {
      console.error(`[dashboard] Instantly fetch failed for ${params.clientId}:`, (e as any)?.message ?? e);
    }
  }

  if (config.platforms.emailbison?.enabled) {
    try {
      const svc = new EmailBisonService(config.platforms.emailbison.apiKey);
      // Fetch active campaigns and compute totals over the selected window.
      // If no window is provided, EmailBisonService falls back to lifetime totals.
      metrics.push(
        ...(await svc.getAllCampaignMetrics(clientName, {
          startDate: params.startDate,
          endDate: params.endDate,
          windowDays: params.days,
          status
        }))
      );
    } catch (e) {
      console.error(`[dashboard] EmailBison fetch failed for ${params.clientId}:`, (e as any)?.message ?? e);
    }
  }
  if (config.platforms.heyreach?.enabled) {
    try {
      const svc = new HeyReachService(config.platforms.heyreach.apiKey, {
        bearerToken: (config.platforms.heyreach as any).bearerToken,
        organizationUnits: (config.platforms.heyreach as any).organizationUnits
      });

      metrics.push(
        ...(await svc.getAllCampaignMetrics(clientName, {
          status,
          startDate: params.startDate,
          endDate: params.endDate,
          includeDashboardStats: true
        }))
      );
    } catch (e) {
      console.error(`[dashboard] HeyReach fetch failed for ${params.clientId}:`, (e as any)?.message ?? e);
    }
  }

  return { clientId: params.clientId, clientName, metrics };
}

function computeSummary(metrics: CampaignMetrics[]) {
  const sum = <T extends keyof CampaignMetrics>(k: T) =>
    metrics.reduce((acc, m) => acc + Number((m[k] as any) ?? 0), 0);

  const sent = sum('sentCount');
  const bounced = sum('bouncedCount');
  const replied = sum('repliedCount');
  const interested = sum('interestedCount');
  const contacted = sum('leadsContacted');

  // Match EmailBison UI-style rates where possible:
  // prefer “per contacted” denominators (unique replies per contacted, bounces per contacted).
  // If contacted isn't available for a client/platform mix, fall back to sent.
  const denomForRates = contacted > 0 ? contacted : sent;

  const bounceRate = denomForRates > 0 ? (bounced / denomForRates) * 100 : 0;
  const replyRate = denomForRates > 0 ? (replied / denomForRates) * 100 : 0;

  // “Positive reply %” (EmailBison): Interested / Unique Replies.
  // When there are no replies, define as 0.
  const positiveReplyRate = replied > 0 ? (interested / replied) * 100 : 0;

  return {
    totals: {
      sent,
      contacted,
      replied,
      interested,
      bounced
    },
    rates: {
      bounceRate,
      replyRate,
      positiveReplyRate
    }
  };
}

function computeHeyReachSummary(metrics: CampaignMetrics[]) {
  const hey = metrics.filter(m => String(m.platform) === 'heyreach');

  const sum = (k: keyof CampaignMetrics) => hey.reduce((acc, m) => acc + Number((m as any)[k] ?? 0), 0);
  const connectionsSent = sum('connectionsSent');
  const connectionsAccepted = sum('connectionsAccepted');

  // In our mapping, HeyReach “Messages Sent” is already aligned to HeyReach UI (TotalMessageStarted).
  const messagesSent = sum('messagesSent');
  const messageReplies = sum('messageReplies');
  const inMailsSent = sum('inMailsSent');
  const inMailReplies = sum('inMailReplies');

  // Use HeyReach's own definitions: these denominators match UI.
  const acceptanceRate = connectionsSent > 0 ? (connectionsAccepted / connectionsSent) * 100 : 0;
  const messageReplyRate = messagesSent > 0 ? (messageReplies / messagesSent) * 100 : 0;
  const inMailReplyRate = inMailsSent > 0 ? (inMailReplies / inMailsSent) * 100 : 0;

  return {
    totals: {
      connectionsSent,
      connectionsAccepted,
      messagesSent,
      messageReplies,
      inMailsSent,
      inMailReplies
    },
    rates: {
      acceptanceRate,
      messageReplyRate,
      inMailReplyRate
    }
  };
}

function guessContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const parsed = url.parse(req.url || '/');
  const pathname = parsed.pathname || '/';

  const publicDir = path.resolve(process.cwd(), 'dashboard/public');
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    sendText(res, 400, 'Bad request');
    return;
  }

  let filePath = safePath;
  if (pathname === '/' || pathname.endsWith('/')) {
    filePath = path.join(safePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    const fallback = path.join(publicDir, 'index.html');
    if (fs.existsSync(fallback)) {
      const data = fs.readFileSync(fallback);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
      return;
    }

    sendText(res, 404, 'Not found');
    return;
  }

  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': guessContentType(filePath), 'Cache-Control': 'no-store' });
  res.end(data);
}

async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);

  const status = (reqUrl.searchParams.get('status') || 'active').toLowerCase();
  const { startDate, endDate, days, isLifetime } = parseDateRange(reqUrl.searchParams) as any;

  // API routes
  if (reqUrl.pathname === '/api/clients') {
    // SECURITY: never expose API keys to the browser.
    const activeClients = getActiveClients().map(c => ({
      id: c.id,
      name: c.config.name,
      platforms: Object.fromEntries(
        Object.entries(c.config.platforms).map(([platform, p]: any) => [
          platform,
          {
            enabled: !!p?.enabled
          }
        ])
      )
    }));
    return sendJson(res, 200, { clients: activeClients });
  }

  if (reqUrl.pathname === '/api/summary') {
    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });
    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, status });
    if (!data) return sendJson(res, 404, { error: 'Unknown clientId' });
    return sendJson(res, 200, {
      clientId: data.clientId,
      clientName: data.clientName,
      generatedAt: new Date().toISOString(),
      window: { days, startDate, endDate, status, isLifetime: !!isLifetime },
      summary: computeSummary(data.metrics),
      heyreach: computeHeyReachSummary(data.metrics)
    });
  }

  // Debug endpoint to help reconcile dashboard totals against platform UI.
  // IMPORTANT: this endpoint does not expose API keys.
  // Enable only when DASHBOARD_DEBUG=1.
  if (reqUrl.pathname === '/api/debug/reconcile') {
    if (process.env.DASHBOARD_DEBUG !== '1') return sendJson(res, 404, { error: 'Not found' });

    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });

    // Allow overriding dates for exact screenshot-based comparisons.
    const overrideStart = reqUrl.searchParams.get('startDate') || undefined;
    const overrideEnd = reqUrl.searchParams.get('endDate') || undefined;

    const data = await fetchClientMetrics({
      clientId,
      startDate: overrideStart ?? startDate,
      endDate: overrideEnd ?? endDate,
      days,
      status
    });
    if (!data) return sendJson(res, 404, { error: 'Unknown clientId' });

    const windowUsed = {
      days,
      startDate: overrideStart ?? startDate,
      endDate: overrideEnd ?? endDate,
      status,
      isLifetime: !!isLifetime,
      tzMode: 'fixed',
      tzOffsetMinutes: Number(process.env.DASHBOARD_TZ_OFFSET_MINUTES ?? '-420')
    };

    const byPlatform: Record<string, any> = {};
    for (const m of data.metrics) {
      const p = String(m.platform);
      byPlatform[p] = byPlatform[p] ?? { campaigns: 0, totals: { sent: 0, contacted: 0, replied: 0, interested: 0, bounced: 0 } };
      byPlatform[p].campaigns += 1;
      byPlatform[p].totals.sent += Number(m.sentCount ?? m.emailsSent ?? 0);
      byPlatform[p].totals.contacted += Number(m.leadsContacted ?? 0);
      byPlatform[p].totals.replied += Number(m.repliedCount ?? 0);
      byPlatform[p].totals.interested += Number(m.interestedCount ?? 0);
      byPlatform[p].totals.bounced += Number(m.bouncedCount ?? 0);
    }

    return sendJson(res, 200, {
      clientId: data.clientId,
      clientName: data.clientName,
      generatedAt: new Date().toISOString(),
      window: windowUsed,
      summary: computeSummary(data.metrics),
      byPlatform,
      sampleCampaigns: data.metrics.slice(0, 10).map(m => ({
        platform: m.platform,
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        sent: m.sentCount ?? m.emailsSent,
        contacted: m.leadsContacted ?? null,
        replied: m.repliedCount ?? null,
        interested: m.interestedCount ?? null,
        bounced: m.bouncedCount ?? null
      }))
    });
  }

  if (reqUrl.pathname === '/api/campaigns') {
    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });
    const platform = reqUrl.searchParams.get('platform');
    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, status });
    if (!data) return sendJson(res, 404, { error: 'Unknown clientId' });

    const campaigns = data.metrics
      .filter(m => (platform ? String(m.platform) === platform : true))
      .map(m => ({
        // For HeyReach, engagement stats may be unavailable. In that case,
        // return nulls rather than misleading 0s.
        ...(String(m.platform) === 'heyreach' && m.hasEngagementStats === false
          ? {
              sent: null,
              replies: null,
              replyRate: null
            }
          : null),
        campaignId: m.campaignId,
        platform: m.platform,
        campaignName: m.campaignName,
        leadsTotal: m.leadsTotal,
        leadsRemaining: m.leadsRemaining,
        leadsContacted: m.leadsContacted ?? null,
        sent: (String(m.platform) === 'heyreach' && m.hasEngagementStats === false) ? null : (m.sentCount ?? m.emailsSent),
        replies: (String(m.platform) === 'heyreach' && m.hasEngagementStats === false) ? null : (m.repliedCount ?? null),
        interested: m.interestedCount ?? null,
        interestedRate: m.interestedRate ?? null,
        bounced: m.bouncedCount ?? null,
        replyRate: (String(m.platform) === 'heyreach' && m.hasEngagementStats === false) ? null : m.replyRate,
        bounceRate: m.bounceRate,

        // Platform-specific extras (safe to ignore in the UI for now)
        hasEngagementStats: m.hasEngagementStats ?? null,
        connectionsSent: (m as any).connectionsSent ?? null,
        connectionsAccepted: (m as any).connectionsAccepted ?? null,
        connectionAcceptanceRate: (m as any).connectionAcceptanceRate ?? null,
        messagesSent: (m as any).messagesSent ?? null,
        messageReplies: (m as any).messageReplies ?? null,
        messageReplyRate: (m as any).messageReplyRate ?? null,
        inMailsSent: (m as any).inMailsSent ?? null,
        inMailReplies: (m as any).inMailReplies ?? null,
        inMailReplyRate: (m as any).inMailReplyRate ?? null
      }));

    return sendJson(res, 200, { clientId: data.clientId, clientName: data.clientName, campaigns });
  }

  // Daily series endpoint (EmailBison only for now, to show a chart)
  if (reqUrl.pathname === '/api/timeseries') {
    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });

    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, status });
    if (!data) return sendJson(res, 404, { error: 'Unknown clientId' });

    // Fetch daily series for EmailBison campaigns and sum by day.
    const activeClients = getActiveClients();
    const entry = activeClients.find(c => c.id === clientId);
    const apiKey = entry?.config.platforms.emailbison?.enabled ? entry?.config.platforms.emailbison.apiKey : null;
    if (!apiKey) {
      return sendJson(res, 200, {
        clientId,
        clientName: data.clientName,
        days,
        startDate,
        endDate,
        series: []
      });
    }

    const svc = new EmailBisonService(apiKey);
    const emailBisonCampaignIds = data.metrics
      .filter(m => m.platform === 'emailbison')
      .map(m => Number(m.campaignId))
      .filter(n => Number.isFinite(n));

    // Initialize days list (Utah calendar days, inclusive)
    // Don’t try to plot “lifetime” as a time series; cap chart at 30 days for readability.
    const chartDays = Math.min(30, Number(days) || 7);
    const chartStart = addDaysYmd(endDate, -(chartDays - 1));
    const seriesDays = listDaysInclusive(chartStart, endDate);

    const totalsByDay: Record<string, { sent: number; replied: number; interested: number; bounced: number }> = {};
    for (const day of seriesDays) {
      totalsByDay[day] = { sent: 0, replied: 0, interested: 0, bounced: 0 };
    }

    for (const id of emailBisonCampaignIds) {
      try {
        // Use the same chart range we computed (seriesDays) to fetch the series window.
        const byLabel = await svc.getCampaignEventSeries({ startDate: seriesDays[0], endDate, campaignId: id });
        const sent = byLabel['Sent'] ?? {};
        const replied = byLabel['Replied'] ?? {};
        const interested = byLabel['Interested'] ?? {};
        const bounced = byLabel['Bounced'] ?? {};

        for (const day of seriesDays) {
          totalsByDay[day].sent += Number(sent[day] ?? 0);
          totalsByDay[day].replied += Number(replied[day] ?? 0);
          totalsByDay[day].interested += Number(interested[day] ?? 0);
          totalsByDay[day].bounced += Number(bounced[day] ?? 0);
        }
      } catch {
        // ignore individual campaign series failures
      }
    }

    const series = seriesDays.map(day => ({ day, ...totalsByDay[day] }));
    return sendJson(res, 200, { clientId, clientName: data.clientName, days: seriesDays.length, startDate: seriesDays[0], endDate, series });
  }

  // Static
  return serveStatic(req, res);
}

// Most hosting providers (incl. AWS App Runner) expose the listen port as PORT.
const port = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 8787);
const server = http.createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error('Dashboard server error:', err);
    sendJson(res, 500, { error: 'Internal server error' });
  });
});

server.listen(port, () => {
  console.log(`\n📊 Rudiment Dashboard running at http://localhost:${port}`);
  console.log(`   - UI:        http://localhost:${port}/`);
  console.log(`   - API:       http://localhost:${port}/api/clients`);
  console.log('');
});
