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
import { CampaignMetrics, ReplyLead } from './types';
import { getUtahLastNDaysRange, listDaysInclusive, addDaysYmd } from './utils/utahTime';

dotenv.config();

type ClientMetricsResult = {
  clientId: string;
  clientName: string;
  metrics: CampaignMetrics[];
  heyreachAggregate?: any;
};

type ClientRepliesResult = {
  clientId: string;
  clientName: string;
  window: { days: number; startDate: string; endDate: string; status: string; isLifetime: boolean };
  items: ReplyLead[];
};

type CacheEntry<T> = { expiresAt: number; value: T };

// Simple in-memory cache to avoid hammering upstream APIs on refresh.
// NOTE: This is per-process; it resets on restart.
const cache = new Map<string, CacheEntry<ClientMetricsResult>>();
const cacheTtlMs = Math.max(5, Number(process.env.DASHBOARD_CACHE_SECONDS ?? '60')) * 1000;

// De-dupe concurrent refreshes for the same client/window.
// The dashboard UI calls /api/summary and /api/campaigns in parallel; without this,
// we can easily exceed upstream rate limits (esp. HeyReach).
const inFlight = new Map<string, Promise<ClientMetricsResult | null>>();

// Evergreen HeyReach per-campaign stats cache (public API; can be rate-limited).
// We keep a last-known-good cache and refresh it in the background.
type HeyreachStatsCacheEntry = {
  updatedAt: number;
  statsByCampaignId: Record<string, any>;
  status: 'idle' | 'refreshing' | 'error';
  error?: string;
};
const heyreachStatsCache = new Map<string, HeyreachStatsCacheEntry>();
const heyreachStatsTtlMs = Math.max(60, Number(process.env.HEYREACH_STATS_CACHE_SECONDS ?? '900')) * 1000;
const heyreachStatsMinIntervalMs = Math.max(5, Number(process.env.HEYREACH_STATS_MIN_INTERVAL_SECONDS ?? '15')) * 1000;
const heyreachStatsConcurrency = Math.max(1, Math.min(3, Number(process.env.HEYREACH_STATS_CONCURRENCY ?? '1')));
const heyreachStatsDelayMs = Math.max(0, Number(process.env.HEYREACH_STATS_DELAY_MS ?? '250'));

function heyreachCacheKey(params: {
  clientId: string;
  startDate: string;
  endDate: string;
  status: string;
}) {
  return [params.clientId, params.status, params.startDate, params.endDate].join('|');
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise(r => setTimeout(r, ms));
}

async function refreshHeyReachPerCampaignStats(params: {
  clientId: string;
  apiKey: string;
  bearerToken?: string;
  organizationUnits?: string;
  status: string;
  startDate: string;
  endDate: string;
  campaigns?: any[];
}) {
  const key = heyreachCacheKey({ clientId: params.clientId, status: params.status, startDate: params.startDate, endDate: params.endDate });
  const existing = heyreachStatsCache.get(key);

  // Debounce refreshes
  if (existing?.status === 'refreshing') return;
  if (existing?.updatedAt && Date.now() - existing.updatedAt < heyreachStatsMinIntervalMs) return;

  heyreachStatsCache.set(key, {
    updatedAt: existing?.updatedAt ?? 0,
    statsByCampaignId: existing?.statsByCampaignId ?? {},
    status: 'refreshing'
  });

  try {
    const svc = new HeyReachService(params.apiKey, {
      bearerToken: params.bearerToken,
      organizationUnits: params.organizationUnits
    });

    // Campaign list (needed for IDs + accountIds)
    const campaigns = params.campaigns ?? (await svc.getCampaigns());
    const norm = (s: unknown) => String(s ?? '').toUpperCase();
    const isActive = (s: string) => s === 'IN_PROGRESS';
    const isCompleted = (s: string) => s === 'FINISHED' || s === 'COMPLETED';
    const isPaused = (s: string) => s === 'PAUSED' || s === 'STOPPED';

    const selected = (campaigns as any[]).filter((c: any) => {
      const s = norm(c?.status);
      if (params.status === 'all') return true;
      if (params.status === 'active') return isActive(s);
      if (params.status === 'completed') return isCompleted(s);
      if (params.status === 'paused') return isPaused(s);
      return isActive(s);
    });

    const campaignIds = selected.map(c => Number(c?.id ?? c?.campaign_id)).filter((n: any) => Number.isFinite(n));
    const accountIds = Array.from(
      new Set(
        selected
          .flatMap((c: any) => (c?.campaignAccountIds ?? []).map((x: any) => Number(x)))
          .filter((n: any) => Number.isFinite(n))
      )
    );
    const organizationUnitIds = Array.from(
      new Set(selected.map((c: any) => Number(c?.organizationUnitId)).filter((n: any) => Number.isFinite(n)))
    );

    const startIso = new Date(params.startDate).toISOString();
    const endIso = new Date(params.endDate).toISOString();

    let statsByCampaignId: Record<string, any> = {};

    // Prefer bearer single-call if provided AND still valid.
    // This is not evergreen, but it’s safe to use opportunistically.
    // Otherwise use public API per-campaign with throttling.
    if ((params.bearerToken || '').trim()) {
      try {
        statsByCampaignId = await svc.getOverallStatsByCampaign({
          campaignIds,
          startDate: startIso,
          endDate: endIso,
          accountIds,
          organizationUnitIds
        });
      } catch (e: any) {
        // ignore; fall back to public
      }
    }

    if (!Object.keys(statsByCampaignId).length && campaignIds.length && accountIds.length) {
      // Public API fallback (one call per campaign) with throttling.
      const ids = campaignIds.slice();
      const out: Record<string, any> = {};
      let idx = 0;

      const worker = async () => {
        while (idx < ids.length) {
          const i = idx++;
          const id = ids[i];
          try {
            const per = await svc.getOverallStatsByCampaignPublic({
              campaignIds: [id],
              accountIds,
              organizationUnitIds,
              startDate: startIso,
              endDate: endIso,
              concurrency: 1
            });
            out[String(id)] = per[String(id)];
          } catch (e: any) {
            // swallow; keep last-known-good
          }
          await sleep(heyreachStatsDelayMs);
        }
      };

      await Promise.all(Array.from({ length: Math.min(heyreachStatsConcurrency, ids.length) }, () => worker()));
      statsByCampaignId = out;
    }

    // Only overwrite cache if we got at least something.
    const merged = {
      ...(existing?.statsByCampaignId ?? {}),
      ...statsByCampaignId
    };

    heyreachStatsCache.set(key, {
      updatedAt: Date.now(),
      statsByCampaignId: merged,
      status: 'idle'
    });
  } catch (e: any) {
    heyreachStatsCache.set(key, {
      updatedAt: existing?.updatedAt ?? 0,
      statsByCampaignId: existing?.statsByCampaignId ?? {},
      status: 'error',
      error: e?.message ?? String(e)
    });
  }
}

async function withRetry<T>(fn: () => Promise<T>, opts?: { tries?: number; baseDelayMs?: number; label?: string }) {
  const tries = Math.max(1, Number(opts?.tries ?? 3));
  const baseDelayMs = Math.max(50, Number(opts?.baseDelayMs ?? 300));
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.response?.status;
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (!retryable || attempt === tries) throw e;
      const wait = baseDelayMs * attempt;
      console.warn(`[dashboard] retrying${opts?.label ? ` ${opts.label}` : ''} after ${wait}ms (status=${status})`);
      await sleep(wait);
    }
  }
  // unreachable
  throw new Error('retry exhausted');
}

function getCacheKey(params: {
  clientId: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  status?: string;
  includeHeyReachStats?: boolean;
}) {
  return [
    params.clientId,
    params.startDate ?? '',
    params.endDate ?? '',
    String(params.days ?? ''),
    String(params.status ?? ''),
    params.includeHeyReachStats ? 'heyreachStats=1' : 'heyreachStats=0'
  ].join('|');
}

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

  // Lifetime means: start from a fixed “reasonable history” date to today.
  // Using 2000-01-01 makes some APIs slower / more error-prone.
  const lifetimeStart = String(process.env.DASHBOARD_LIFETIME_START ?? '2023-01-01');
  if (raw === 'lifetime') {
    return { days: 3650, startDate: lifetimeStart, endDate: todayUtah, isLifetime: true };
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
  isLifetime?: boolean;
  status?: string;
  includeHeyReachStats?: boolean;
}): Promise<ClientMetricsResult | null> {
  // In-flight de-dupe (first line of defense against rate limits)
  const inflightKey = getCacheKey({
    clientId: params.clientId,
    startDate: params.startDate,
    endDate: params.endDate,
    days: params.days,
    status: params.status,
    includeHeyReachStats: params.includeHeyReachStats
  });
  const existingPromise = inFlight.get(inflightKey);
  if (existingPromise) return existingPromise;

  const p = (async () => {
  // Cache first (stability + rate-limit protection)
  const key = getCacheKey({
    clientId: params.clientId,
    startDate: params.startDate,
    endDate: params.endDate,
    days: params.days,
    status: params.status,
    includeHeyReachStats: !!params.includeHeyReachStats
  });

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const activeClients = getActiveClients();
  const entry = activeClients.find(c => c.id === params.clientId);
  if (!entry) return null;

  const { config } = entry;
  const clientName = config.name;
  const metrics: CampaignMetrics[] = [];
  let heyreachAggregate: any = undefined;

  const status = String(params.status || 'active').toLowerCase();

  // Instantly
  if (config.platforms.instantly?.enabled) {
    try {
      const svc = new InstantlyService(config.platforms.instantly.apiKey);

      // Instantly UI “Last N days” appears to exclude “today” and uses a slightly different
      // day-boundary than our Utah-inclusive window. This causes mismatches for short ranges
      // (e.g. 7 days). To match Instantly UI, we shift the end date back by 1 day and compute
      // startDate as (endDate - days).
      const instEndDate =
        params.isLifetime || !params.endDate
          ? params.endDate
          : addDaysYmd(params.endDate, -1);
      const instStartDate =
        params.isLifetime || !instEndDate || !Number.isFinite(Number(params.days))
          ? params.startDate
          : addDaysYmd(instEndDate, -Number(params.days));

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
          startDate: instStartDate,
          endDate: instEndDate,
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

      // Fetch HeyReach campaigns ONCE (this endpoint is rate-limited).
      // We reuse it for:
      //  - base campaign metrics
      //  - aggregate stats
      //  - per-campaign cache warmer trigger
      const heyreachCampaigns = await withRetry(() => svc.getCampaigns(), { tries: 3, baseDelayMs: 500, label: 'heyreach.getCampaigns' });

      // Build base campaign metrics from the campaign list without extra requests.
      const norm = (s: unknown) => String(s ?? '').toUpperCase();
      const isActive = (s: string) => s === 'IN_PROGRESS';
      const isCompleted = (s: string) => s === 'FINISHED' || s === 'COMPLETED';
      const isPaused = (s: string) => s === 'PAUSED' || s === 'STOPPED';

      const statusFilter = String(params.status || 'active').toLowerCase();
      const selectedCampaigns = (heyreachCampaigns as any[]).filter((c: any) => {
        const s = norm(c?.status);
        if (statusFilter === 'all') return true;
        if (statusFilter === 'active') return isActive(s);
        if (statusFilter === 'completed') return isCompleted(s);
        if (statusFilter === 'paused') return isPaused(s);
        return isActive(s);
      });

      metrics.push(...selectedCampaigns.map(c => svc.transformToMetrics(c as any, clientName)));

      // Always try to compute an aggregate stats snapshot for HeyReach KPIs (1 request).
      // This is much more stable than fetching per-campaign stats.
      if (params.startDate && params.endDate) {
        try {
          const campaignIds = selectedCampaigns.map(c => Number((c as any)?.id ?? (c as any)?.campaign_id)).filter((n: any) => Number.isFinite(n));
          const accountIds = Array.from(
            new Set(
              selectedCampaigns
                .flatMap((c: any) => (c?.campaignAccountIds ?? []).map((x: any) => Number(x)))
                .filter((n: any) => Number.isFinite(n))
            )
          );
          const organizationUnitIds = Array.from(
            new Set(selectedCampaigns.map((c: any) => Number(c?.organizationUnitId)).filter((n: any) => Number.isFinite(n)))
          );

          if (campaignIds.length && accountIds.length) {
            const startIso = new Date(params.startDate).toISOString();
            const endIso = new Date(params.endDate).toISOString();
            heyreachAggregate = await svc.getOverallStatsAggregatePublic({
              campaignIds,
              accountIds,
              organizationUnitIds,
              startDate: startIso,
              endDate: endIso
            });
          }
        } catch (e: any) {
          // If rate-limited here, we still render campaigns table (lead totals) fine.
          console.warn('[dashboard] HeyReach aggregate stats unavailable:', e?.message ?? e);
        }
      }

      // NOTE: Per-campaign HeyReach stats are merged in the /api/campaigns handler.
      // We intentionally don't store them on the main cached value because /api/summary
      // and /api/campaigns share a cache key and the stats may become available after
      // the first response has already been cached.
    } catch (e) {
      console.error(`[dashboard] HeyReach fetch failed for ${params.clientId}:`, (e as any)?.message ?? e);
    }
  }

  const value = { clientId: params.clientId, clientName, metrics, heyreachAggregate };
  cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
  return value;
  })();

  inFlight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    inFlight.delete(inflightKey);
  }
}

function computeHeyReachSummaryFromAggregate(agg?: any) {
  if (!agg) {
    return {
      totals: {
        connectionsSent: 0,
        connectionsAccepted: 0,
        messagesSent: 0,
        messageReplies: 0,
        inMailsSent: 0,
        inMailReplies: 0
      },
      rates: {
        acceptanceRate: 0,
        messageReplyRate: 0,
        inMailReplyRate: 0
      },
      source: 'none'
    };
  }

  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pct = (v: any) => {
    const n = num(v);
    return n <= 1 ? n * 100 : n;
  };

  const connectionsSent = num(agg?.ConnectionsSent);
  const connectionsAccepted = num(agg?.ConnectionsAccepted);
  const messagesSent = num(agg?.TotalMessageStarted ?? agg?.MessagesSent);
  const messageReplies = num(agg?.TotalMessageReplies);
  const inMailsSent = num(agg?.TotalInmailStarted ?? agg?.InmailMessagesSent);
  const inMailReplies = num(agg?.TotalInmailReplies);

  return {
    totals: { connectionsSent, connectionsAccepted, messagesSent, messageReplies, inMailsSent, inMailReplies },
    rates: {
      acceptanceRate: pct(agg?.connectionAcceptanceRate ?? (connectionsSent > 0 ? connectionsAccepted / connectionsSent : 0)),
      messageReplyRate: pct(agg?.messageReplyRate ?? (messagesSent > 0 ? messageReplies / messagesSent : 0)),
      inMailReplyRate: pct(agg?.inMailReplyRate ?? (inMailsSent > 0 ? inMailReplies / inMailsSent : 0))
    },
    source: 'aggregate'
  };
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

  // HeyReach stats enrichment is expensive and can be rate-limited.
  // Opt-in via query param (heyreachStats=1) or env (DASHBOARD_HEYREACH_STATS=1).
  const includeHeyReachStats =
    reqUrl.searchParams.get('heyreachStats') === '1' || process.env.DASHBOARD_HEYREACH_STATS === '1';

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
    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, isLifetime: !!isLifetime, status, includeHeyReachStats });
    if (!data) return sendJson(res, 404, { error: 'Unknown clientId' });

    const heyreachSummary = data.heyreachAggregate
      ? computeHeyReachSummaryFromAggregate(data.heyreachAggregate)
      : computeHeyReachSummary(data.metrics);

    return sendJson(res, 200, {
      clientId: data.clientId,
      clientName: data.clientName,
      generatedAt: new Date().toISOString(),
      window: { days, startDate, endDate, status, isLifetime: !!isLifetime },
      summary: computeSummary(data.metrics),
      heyreach: heyreachSummary
    });
  }

  // Replies (EmailBison first). Returns lead-level replies for display.
  if (reqUrl.pathname === '/api/replies') {
    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });

    const platform = (reqUrl.searchParams.get('platform') || 'emailbison').toLowerCase();
    const filter = (reqUrl.searchParams.get('filter') || 'replied').toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(reqUrl.searchParams.get('limit') || '50')));

    const activeClients = getActiveClients();
    const entry = activeClients.find(c => c.id === clientId);
    if (!entry) return sendJson(res, 404, { error: 'Unknown clientId' });

    const { config } = entry;
    const clientName = config.name;

    const windowUsed = { days, startDate, endDate, status, isLifetime: !!isLifetime };

    // EmailBison interested replies
    if (platform === 'emailbison') {
      if (!config.platforms.emailbison?.enabled) {
        return sendJson(res, 200, { clientId, clientName, window: windowUsed, items: [] } satisfies ClientRepliesResult);
      }

      try {
        const svc = new EmailBisonService(config.platforms.emailbison.apiKey);
        const items =
          filter === 'interested'
            ? await svc.getInterestedReplyLeads({ clientId, clientName, startDate, endDate, limit })
            : await svc.getReplyLeads({ clientId, clientName, startDate, endDate, limit });

        return sendJson(res, 200, { clientId, clientName, window: windowUsed, items } satisfies ClientRepliesResult);
      } catch (e: any) {
        return sendJson(res, 500, { error: e?.message ?? String(e) });
      }
    }

    // HeyReach will be added after EmailBison is stable.
    if (platform === 'heyreach') {
      return sendJson(res, 501, { error: 'HeyReach replies not implemented yet (EmailBison first).' });
    }

    return sendJson(res, 400, { error: `Unsupported platform: ${platform}` });
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
      status,
      includeHeyReachStats
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
    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, isLifetime: !!isLifetime, status, includeHeyReachStats });
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

    // Evergreen per-campaign HeyReach stats: merge last-known-good values.
    // Important: we do this here (not in fetchClientMetrics) so it works even when
    // the main response is served from cache.
    let heyreachStatsInfo: any = { status: 'disabled' };
    if (startDate && endDate) {
      const key = heyreachCacheKey({ clientId, status, startDate, endDate });
      const entry = heyreachStatsCache.get(key);

      // Trigger refresh if stale (don’t await). This keeps it evergreen.
      const isStale = !entry?.updatedAt || Date.now() - entry.updatedAt > heyreachStatsTtlMs;
      if (isStale) {
        const activeClients = getActiveClients();
        const cfg = activeClients.find(c => c.id === clientId)?.config?.platforms?.heyreach;
        if (cfg?.enabled) {
          refreshHeyReachPerCampaignStats({
            clientId,
            apiKey: (cfg as any).apiKey,
            bearerToken: (cfg as any).bearerToken,
            organizationUnits: (cfg as any).organizationUnits,
            status,
            startDate,
            endDate
          }).catch(() => null);
        }
      }

      const statsByCampaignId = entry?.statsByCampaignId ?? {};
      const hasAny = Object.values(statsByCampaignId).some(Boolean);
      if (hasAny) {
        for (const c of campaigns) {
          if (String(c.platform) !== 'heyreach') continue;
          const s = statsByCampaignId[String(c.campaignId)];
          if (!s) continue;
          c.hasEngagementStats = true;
          c.connectionsSent = Number(s.ConnectionsSent ?? c.connectionsSent ?? 0);
          c.connectionsAccepted = Number(s.ConnectionsAccepted ?? c.connectionsAccepted ?? 0);
          c.connectionAcceptanceRate = Number(
            s.connectionAcceptanceRate ?? (c.connectionsSent > 0 ? c.connectionsAccepted / c.connectionsSent : 0)
          ) * 100;
          c.messagesSent = Number(s.TotalMessageStarted ?? c.messagesSent ?? 0);
          c.messageReplies = Number(s.TotalMessageReplies ?? c.messageReplies ?? 0);
          c.messageReplyRate = Number(
            s.messageReplyRate ?? (c.messagesSent > 0 ? c.messageReplies / c.messagesSent : 0)
          ) * 100;
        }
      }

      heyreachStatsInfo = {
        status: hasAny ? 'ready' : (entry?.status ?? 'warming'),
        updatedAt: entry?.updatedAt ?? null,
        error: entry?.status === 'error' ? (entry?.error ?? 'unknown') : null
      };
    }

    return sendJson(res, 200, {
      clientId: data.clientId,
      clientName: data.clientName,
      campaigns,
      heyreachStatsCache: heyreachStatsInfo
    });
  }

  // Daily series endpoint (EmailBison only for now, to show a chart)
  if (reqUrl.pathname === '/api/timeseries') {
    const clientId = reqUrl.searchParams.get('clientId') || '';
    if (!clientId) return sendJson(res, 400, { error: 'Missing clientId' });

    const data = await fetchClientMetrics({ clientId, startDate, endDate, days, isLifetime: !!isLifetime, status, includeHeyReachStats });
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
