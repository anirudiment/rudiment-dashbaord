import axios, { AxiosInstance } from 'axios';
import { CampaignMetrics, ReplyLead } from '../types';

type RepliesCacheEntry = {
  expiresAt: number;
  rows: any[];
  exhausted: boolean;
  nextRawPage: number;
  scannedPages: number;
};

// Module-level cache shared across service instances (per process)
const repliesCache = new Map<string, RepliesCacheEntry>();

type SendEventStatsLabel =
  | 'Replied'
  | 'Total Opens'
  | 'Unique Opens'
  | 'Sent'
  | 'Bounced'
  | 'Unsubscribed'
  | 'Interested';

type SendEventStatsResponse = {
  data: Array<{
    label: SendEventStatsLabel | string;
    color?: string;
    dates: Array<[string, number]>; // [YYYY-MM-DD, count]
  }>;
};

/**
 * EmailBison in this project corresponds to Rudiment's Send API.
 *
 * Base URL & auth (from docs):
 *   https://send.getrudiment.com
 *   Authorization: Bearer <token>
 *
 * Campaign listing is a POST to /api/campaigns with filter payload.
 */
export class EmailBisonService {
  private client: AxiosInstance;

  constructor(private apiKey: string) {
    this.client = axios.create({
      baseURL: 'https://send.getrudiment.com',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });
  }

  /**
   * List campaigns (Send API)
   * Confirmed working via auth probe:
   *   GET /api/campaigns -> 200 { data: [...] }
   */
  async getCampaigns(): Promise<any[]> {
    try {
      const response = await this.client.get('/api/campaigns');

      const data = response.data;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.campaigns)) return data.campaigns;
      if (Array.isArray(data?.data)) return data.data;
      return [];
    } catch (error) {
      console.error('Error fetching EmailBison/SEND campaigns:', this.summarizeAxiosError(error));
      throw error;
    }
  }

  /**
   * Fetch single campaign details.
   * Confirmed working:
   *   GET /api/campaigns/:id -> 200 and includes totals like emails_sent/replied/bounced/opened/total_leads.
   */
  async getCampaignDetails(
    campaignId: number | string,
    params?: {
      /** YYYY-MM-DD */
      startDate?: string;
      /** YYYY-MM-DD */
      endDate?: string;
    }
  ): Promise<any> {
    try {
      // The Send API supports optional start_date/end_date query params on this endpoint.
      // This is key for matching the platform UI (e.g. “Last 60 days”) because it returns
      // windowed totals like emails_sent, unique_replies, total_leads_contacted, etc.
      const query = params?.startDate && params?.endDate ? { start_date: params.startDate, end_date: params.endDate } : undefined;
      const response = await this.client.get(`/api/campaigns/${campaignId}`, query ? { params: query } : undefined);
      return response.data?.data ?? response.data;
    } catch (error) {
      console.error('Error fetching EmailBison/SEND campaign details:', this.summarizeAxiosError(error));
      throw error;
    }
  }

  private summarizeAxiosError(error: any) {
    return {
      message: error?.message,
      status: error?.response?.status,
      url: error?.config?.baseURL ? `${error.config.baseURL}${error.config.url}` : error?.config?.url,
      data: error?.response?.data
    };
  }

  /**
   * Transform Send campaign payload to our standardized metrics.
   *
   * The Send API exposes useful totals on GET /api/campaigns/:id:
   *   emails_sent, replied, bounced, opened/unique_opens, total_leads
   *
   * We optionally accept `windowTotals` (e.g. last 7 days) from /api/campaign-events/stats.
   * If you want lifetime, call this method without `windowTotals`.
   */
  transformToMetrics(
    campaign: any,
    windowTotals?: { sent: number; bounced: number; replied: number; opened: number; interested?: number }
  ): CampaignMetrics {
    // Prefer time-window totals when provided, else fall back to campaign totals.
    const sent = Number(windowTotals?.sent ?? campaign?.emails_sent ?? campaign?.sent ?? 0);
    const bounces = Number(windowTotals?.bounced ?? campaign?.bounced ?? 0);
    const replies = Number(windowTotals?.replied ?? campaign?.replied ?? 0);
    const opens = Number(windowTotals?.opened ?? campaign?.opened ?? campaign?.unique_opens ?? 0);
    const interested = Number(windowTotals?.interested ?? 0);

    const totalLeads = Number(campaign?.total_leads ?? 0);

    // Normalize status best-effort.
    const rawStatus = String(campaign?.status ?? '').toLowerCase();
    const campaignStatus =
      rawStatus.includes('pause')
        ? 'paused'
        : ['completed', 'done', 'finished', 'stopped', 'ended', 'inactive', 'archived'].some(x => rawStatus.includes(x))
          ? 'completed'
          : 'active';

    // Send API does not expose leads_remaining directly; derive best-effort.
    const leadsRemaining = Number(
      campaign?.leads_remaining ??
        (totalLeads > 0 ? Math.max(0, totalLeads - Number(campaign?.total_leads_contacted ?? 0)) : 0)
    );

    const leadsContacted = Number(
      campaign?.total_leads_contacted ??
        campaign?.leads_contacted ??
        (totalLeads > 0 ? Math.max(0, totalLeads - leadsRemaining) : 0)
    );

    // EmailBison UI % badges are typically computed “per contacted”, not “per sent”
    // (e.g. Unique Replies %, Bounced %, Unique Opens %).
    // If contacted is unavailable (some endpoints), fall back to sent.
    const denomForContactRates = Number.isFinite(leadsContacted) && leadsContacted > 0 ? leadsContacted : sent;

    // Prefer API-provided interested rate if present; fall back to computed Interested/Replied.
    // Field name is not confirmed; we support a few common variants.
    const apiInterestedRate =
      campaign?.interested_rate ??
      campaign?.interestedRate ??
      campaign?.metrics?.interested_rate ??
      campaign?.metrics?.interestedRate;

    const parseInterestedRate = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v !== 'string') return undefined;

      // common UI-like formats: "60%" or "60" or "0.6"
      const s = v.trim();
      const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (!m) return undefined;
      const num = Number(m[1]);
      if (!Number.isFinite(num)) return undefined;
      if (s.includes('%')) return num;
      // If API returns 0..1, convert to percent
      if (num > 0 && num <= 1) return num * 100;
      return num;
    };

    const interestedRate =
      parseInterestedRate(apiInterestedRate) ??
      (replies > 0 ? (interested / replies) * 100 : 0);

    return {
      campaignId: String(campaign?.id ?? campaign?.campaign_id ?? ''),
      platform: 'emailbison',
      campaignName: campaign?.name ?? campaign?.campaign_name ?? undefined,
      campaignStatus,
      windowDays: undefined,
      leadsRemaining,
      leadsTotal: totalLeads,
      leadsContacted: Number.isFinite(leadsContacted) ? leadsContacted : undefined,
      emailsSent: sent,
      sentCount: sent,
      bouncedCount: bounces,
      repliedCount: replies,
      openedCount: opens,
      interestedCount: interested,
      interestedRate,
      // Match EmailBison dashboard calculations
      bounceRate: denomForContactRates > 0 ? (bounces / denomForContactRates) * 100 : 0,
      replyRate: denomForContactRates > 0 ? (replies / denomForContactRates) * 100 : 0,
      openRate: denomForContactRates > 0 ? (opens / denomForContactRates) * 100 : 0,
      sequenceDaysRemaining: 0,
      campaignDuration: 0,
      dailySendVolume: sent,
      timestamp: new Date()
    };
  }

  /**
   * Fetch campaign event stats for a date range, optionally filtered by campaign IDs.
   */
  async getCampaignEventStats(params: {
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
    campaignIds?: number[];
    senderEmailIds?: number[];
  }): Promise<SendEventStatsResponse> {
    try {
      const qs = new URLSearchParams();
      qs.set('start_date', params.startDate);
      qs.set('end_date', params.endDate);

      (params.campaignIds ?? []).forEach(id => qs.append('campaign_ids[]', String(id)));
      (params.senderEmailIds ?? []).forEach(id => qs.append('sender_email_ids[]', String(id)));

      const response = await this.client.get(`/api/campaign-events/stats?${qs.toString()}`);
      return response.data as SendEventStatsResponse;
    } catch (error) {
      console.error('Error fetching EmailBison/SEND event stats:', this.summarizeAxiosError(error));
      throw error;
    }
  }

  /**
   * Fetch time series per label for the given campaign/date range.
   * Returns a YYYY-MM-DD -> count map.
   */
  async getCampaignEventSeries(params: {
    startDate: string;
    endDate: string;
    campaignId: number;
  }): Promise<Record<string, Record<string, number>>> {
    const stats = await this.getCampaignEventStats({
      startDate: params.startDate,
      endDate: params.endDate,
      campaignIds: [params.campaignId]
    });

    const byLabel: Record<string, Record<string, number>> = {};
    for (const series of stats?.data ?? []) {
      const label = String(series.label);
      byLabel[label] = byLabel[label] ?? {};
      for (const [day, count] of series.dates ?? []) {
        byLabel[label][day] = Number(count ?? 0);
      }
    }
    return byLabel;
  }

  private sumEventStats(stats: SendEventStatsResponse): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const series of stats?.data ?? []) {
      const sum = (series?.dates ?? []).reduce((acc, [, v]) => acc + Number(v ?? 0), 0);
      totals[String(series.label)] = sum;
    }
    return totals;
  }

  /**
   * Fetch lifetime-ish event totals for a campaign.
   *
   * The Send API requires a date range, so we use a very early start date.
   * This is intended for reporting (not high-frequency monitoring) because it
   * adds extra API calls.
   */
  async getLifetimeEventTotals(campaignId: number): Promise<Record<string, number>> {
    const end = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const startDate = '2000-01-01';
    const endDate = fmt(end);
    const stats = await this.getCampaignEventStats({ startDate, endDate, campaignIds: [campaignId] });
    return this.sumEventStats(stats);
  }

  /**
   * Fetch and transform all campaign metrics.
   *
   * We prefer **lifetime totals** from GET /api/campaigns/:id for each campaign.
   *
   * Note: the Send API also supports date-window stats via /api/campaign-events/stats,
   * but for alerting we default to lifetime to avoid misleading small-sample windows.
   */
  async getAllCampaignMetrics(
    clientName: string,
    window?: { startDate?: string; endDate?: string; windowDays?: number; status?: string }
  ): Promise<CampaignMetrics[]> {
    try {
      const campaigns = await this.getCampaigns();

      const statusFilter = String(window?.status || 'active').toLowerCase();

      const activeLike = (status: unknown) => {
        const s = String(status ?? '').toLowerCase();
        return s === 'active' || s === 'running' || s === 'queued' || s === 'in_progress' || s === '';
      };

      const normStatus = (s: unknown) => String(s ?? '').toLowerCase();
      const isCompleted = (s: string) => ['completed', 'done', 'finished', 'stopped', 'ended', 'inactive', 'archived'].includes(s);
      const isPaused = (s: string) => ['paused'].includes(s);
      const isActive = (s: string) => activeLike(s) && !isPaused(s) && !isCompleted(s);

      const filtered = campaigns.filter(c => {
        const s = normStatus(c?.status);
        if (statusFilter === 'all') return true;
        if (statusFilter === 'active') return isActive(s);
        if (statusFilter === 'paused') return isPaused(s);
        if (statusFilter === 'completed') return isCompleted(s);
        return isActive(s);
      });

      const campaignIds = filtered.map(c => Number(c?.id)).filter(n => Number.isFinite(n));

      const result: CampaignMetrics[] = [];

      for (const campaignId of campaignIds) {
        // If a window is provided, prefer campaign details with start_date/end_date.
        // This matches the platform UI more closely (e.g. it includes unique_replies and
        // total_leads_contacted for that period). Falling back to event-stats sums can
        // drift vs UI because it may represent *total replies* rather than *unique replies*.
        if (window?.startDate && window?.endDate) {
          try {
            const details = await this.getCampaignDetails(campaignId, { startDate: window.startDate, endDate: window.endDate });

            const sent = Number(details?.emails_sent ?? 0);
            const bounced = Number(details?.bounced ?? 0);
            const uniqueReplies = Number(details?.unique_replies ?? 0);
            const opened = Number(details?.unique_opens ?? details?.opened ?? 0);
            const interested = Number(details?.interested ?? 0);

            result.push({
              ...this.transformToMetrics(details, {
                sent,
                bounced,
                replied: uniqueReplies,
                opened,
                interested
              }),
              windowDays: window.windowDays
            });
          } catch {
            // fallback to lifetime details
            const details = await this.getCampaignDetails(campaignId);
            result.push({ ...this.transformToMetrics(details), windowDays: window.windowDays });
          }
        } else {
          // Lifetime totals only
          const details = await this.getCampaignDetails(campaignId);
          result.push(this.transformToMetrics(details));
        }
      }

      return result;
    } catch (error) {
      console.error('Error fetching all EmailBison/SEND campaign metrics:', this.summarizeAxiosError(error));
      return [];
    }
  }

  private parseReplyDateMs(r: any): number {
    const raw = r?.date_received ?? r?.created_at;
    const ms = raw ? new Date(String(raw)).getTime() : 0;
    return Number.isFinite(ms) ? ms : 0;
  }

  private getRepliesCacheKey(params: {
    kind: 'replied' | 'interested';
    startDate?: string;
    endDate?: string;
    includeAutomated?: boolean;
    campaignId?: string | number | null;
  }) {
    return JSON.stringify({
      kind: params.kind,
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
      includeAutomated: !!params.includeAutomated,
      campaignId: params.campaignId != null ? String(params.campaignId) : null
    });
  }

  private getRepliesCacheTtlMs() {
    const s = Number(process.env.EMAILBISON_REPLIES_CACHE_SECONDS ?? '60');
    return Math.max(5, Math.min(600, Number.isFinite(s) ? s : 60)) * 1000;
  }

  private getRepliesMaxRawPages() {
    // Hard safety cap; “unlimited” is achieved by stopping at windowStart.
    const n = Number(process.env.EMAILBISON_REPLIES_MAX_RAW_PAGES ?? '2000');
    return Math.max(1, Math.min(5000, Number.isFinite(n) ? n : 2000));
  }

  private isSystemOrNoise(r: any) {
    const type = String(r?.type ?? '').toLowerCase();
    const subject = String(r?.subject ?? '').toLowerCase();
    const from = String(r?.from_email_address ?? '').toLowerCase();

    // Explicit platform types
    if (type === 'bounce' || type === 'bounced') return true;
    if (type === 'outgoing email' || type === 'outgoing') return true;
    if (type === 'untracked reply') return true;

    // DMARC / system senders
    if (from.includes('dmarc') || from.includes('postmaster') || from.includes('mailer-daemon')) return true;
    if (from.includes('mimecast') || from.includes('dmarcreport')) return true;

    // DMARC report subject patterns
    if (subject.includes('dmarc')) return true;
    if (subject.includes('report domain')) return true;
    if (subject.includes('aggregate report')) return true;
    if (subject.includes('report-id')) return true;

    return false;
  }

  /**
   * Fetch replies with pagination.
   *
   * Notes:
   * - The Send API appears to ignore start_date/end_date for /api/replies in this workspace.
   * - We therefore paginate and stop when we reach replies older than `stopBeforeDate`.
   */
  private async fetchRepliesPaged(params: {
    perPage: number;
    maxPages: number;
    /** 1-indexed */
    startPage?: number;
    stopBeforeDate?: string; // YYYY-MM-DD
  }): Promise<any[]> {
    const perPage = Math.max(1, Math.min(200, Number(params.perPage)));
    const maxPages = Math.max(1, Math.min(50, Number(params.maxPages)));
    const stopBeforeMs = params.stopBeforeDate ? new Date(`${params.stopBeforeDate}T00:00:00.000Z`).getTime() : null;

    const out: any[] = [];
    const startPage = Math.max(1, Number(params.startPage ?? 1));
    for (let page = startPage; page <= startPage + maxPages - 1; page++) {
      const res = await this.client.get('/api/replies', { params: { per_page: perPage, page } });
      const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!rows.length) break;
      out.push(...rows);

      if (stopBeforeMs != null) {
        const last = rows[rows.length - 1];
        const lastMs = this.parseReplyDateMs(last);
        if (lastMs > 0 && lastMs < stopBeforeMs) break;
      }
    }
    return out;
  }

  /**
   * Build a filtered, windowed list of replies by scanning raw pages from newest -> older.
   *
   * Why: The Send API paginates raw replies, but filtering out DMARC/bounces/etc changes the
   * notion of a “page”. We therefore paginate on the filtered stream.
   */
  private async buildFilteredRepliesList(params: {
    startDate?: string;
    endDate?: string;
    include: (r: any) => boolean;
  }): Promise<{ rows: any[]; exhausted: boolean }> {
    const startMs = params.startDate ? new Date(`${params.startDate}T00:00:00.000Z`).getTime() : null;
    const endMs = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`).getTime() : null;

    const maxRawPages = this.getRepliesMaxRawPages();

    const out: any[] = [];
    let exhausted = false;

    for (let page = 1; page <= maxRawPages; page++) {
      const res = await this.client.get('/api/replies', { params: { page } });
      const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!rows.length) {
        exhausted = true;
        break;
      }

      for (const r of rows) {
        const ms = this.parseReplyDateMs(r);
        if (endMs != null && ms && ms > endMs) continue;
        if (startMs != null && ms && ms < startMs) continue;
        if (!params.include(r)) continue;
        out.push(r);
      }

      // Stop early if we've crossed the start boundary (newest-first API).
      if (startMs != null) {
        const last = rows[rows.length - 1];
        const lastMs = this.parseReplyDateMs(last);
        if (lastMs && lastMs < startMs) {
          exhausted = true;
          break;
        }
      }
    }

    return { rows: out, exhausted };
  }

  private async getFilteredRepliesStreamPage(params: {
    kind: 'replied' | 'interested';
    page: number;
    perPage: number;
    startDate?: string;
    endDate?: string;
    includeAutomated?: boolean;
    include: (r: any) => boolean;
    campaignId?: string | number;
  }): Promise<{ rows: any[]; hasMore: boolean }> {
    const page = Math.max(1, Math.min(1000, Number(params.page)));
    const perPage = Math.max(1, Math.min(200, Number(params.perPage)));

    const key = this.getRepliesCacheKey({
      kind: params.kind,
      startDate: params.startDate,
      endDate: params.endDate,
      includeAutomated: params.includeAutomated,
      campaignId: params.campaignId ?? null
    });

    const startMs = params.startDate ? new Date(`${params.startDate}T00:00:00.000Z`).getTime() : null;
    const endMs = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`).getTime() : null;

    const maxRawPages = this.getRepliesMaxRawPages();
    const now = Date.now();

    let entry = repliesCache.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = {
        expiresAt: now + this.getRepliesCacheTtlMs(),
        rows: [],
        exhausted: false,
        nextRawPage: 1,
        scannedPages: 0
      };
      repliesCache.set(key, entry);
    }

    // Ensure we have enough filtered rows to serve the requested page.
    const offset = (page - 1) * perPage;
    const needed = offset + perPage;

    while (entry.rows.length < needed && !entry.exhausted && entry.scannedPages < maxRawPages) {
      const res = await this.client.get('/api/replies', { params: { page: entry.nextRawPage } });
      entry.nextRawPage += 1;
      entry.scannedPages += 1;

      const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!rows.length) {
        entry.exhausted = true;
        break;
      }

      for (const r of rows) {
        const ms = this.parseReplyDateMs(r);
        if (endMs != null && ms && ms > endMs) continue;
        if (startMs != null && ms && ms < startMs) continue;
        if (!params.include(r)) continue;
        entry.rows.push(r);
      }

      // Stop early if we've crossed the start boundary (newest-first API).
      if (startMs != null) {
        const last = rows[rows.length - 1];
        const lastMs = this.parseReplyDateMs(last);
        if (lastMs && lastMs < startMs) {
          entry.exhausted = true;
          break;
        }
      }
    }

    const slice = entry.rows.slice(offset, offset + perPage);
    const hasMore = offset + perPage < entry.rows.length ? true : (!entry.exhausted && entry.scannedPages < maxRawPages);
    return { rows: slice, hasMore };
  }

  /**
   * Fetch a page of replies AFTER applying noise/automation filters.
   *
   * Why: the Send API returns newest-first pages and may include many non-human/system replies
   * (DMARC, bounces, outgoing, etc.). If we paginate raw pages first, page 1 can be "empty"
   * after filtering, which looks like the dashboard is broken.
   *
   * Strategy:
   * - walk raw pages from `startPage` forward
   * - apply `include` predicate
   * - collect until we have `perPage` items or we hit `maxRawPages`
   */
  private async fetchFilteredRepliesPage(params: {
    perPage: number;
    page: number;
    maxRawPages?: number;
    stopBeforeDate?: string;
    include: (r: any) => boolean;
  }): Promise<{ rows: any[]; hasMore: boolean }> {
    const perPage = Math.max(1, Math.min(200, Number(params.perPage)));
    const page = Math.max(1, Math.min(1000, Number(params.page)));
    const maxRawPages = Math.max(1, Math.min(50, Number(params.maxRawPages ?? 20)));

    const collected: any[] = [];
    let rawPage = page;
    let hasMore = false;

    for (let i = 0; i < maxRawPages; i++) {
      const raw = await this.fetchRepliesPaged({
        perPage,
        startPage: rawPage,
        maxPages: 1,
        stopBeforeDate: params.stopBeforeDate
      });

      if (!raw.length) {
        hasMore = false;
        break;
      }

      for (const r of raw) {
        if (!params.include(r)) continue;
        collected.push(r);
        if (collected.length >= perPage) break;
      }

      // If we filled, there's *probably* more after this rawPage.
      if (collected.length >= perPage) {
        hasMore = true;
        break;
      }

      // otherwise keep going to next raw page
      rawPage += 1;
      hasMore = true;
    }

    return { rows: collected.slice(0, perPage), hasMore };
  }

  /**
   * Fetch “Interested” replies (AI labeled) and join them to leads.
   *
   * Returns a list of ReplyLead objects for dashboard display.
   *
   * Notes:
   * - Send replies can include automated/bounce notifications. We exclude automated replies by default.
   * - Not every reply is associated to a lead/campaign (lead_id/campaign_id can be null).
   */
  async getInterestedReplyLeads(params: {
    clientId: string;
    clientName: string;
    /** YYYY-MM-DD */
    startDate?: string;
    /** YYYY-MM-DD */
    endDate?: string;
    campaignId?: number | string;
    limit?: number;
    includeAutomated?: boolean;
    /** 1-indexed page for dashboard pagination (applies before filtering). */
    page?: number;
    /** Page size. Defaults to 50. */
    perPage?: number;
  }): Promise<ReplyLead[]> {
    const { items } = await this.getInterestedReplyLeadsPage(params);
    return items;
  }

  /**
   * Same as getInterestedReplyLeads, but returns paging metadata.
   */
  async getInterestedReplyLeadsPage(params: {
    clientId: string;
    clientName: string;
    startDate?: string;
    endDate?: string;
    campaignId?: number | string;
    limit?: number;
    includeAutomated?: boolean;
    page?: number;
    perPage?: number;
  }): Promise<{ items: ReplyLead[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(200, Number(params.limit ?? 50)));
    const windowStart = params.startDate;

    const perPage = Math.max(1, Math.min(200, Number(params.perPage ?? 50)));
    const page = Math.max(1, Math.min(50, Number(params.page ?? 1)));

    const isInterested = (v: any) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

    const { rows: filtered, hasMore } = await this.getFilteredRepliesStreamPage({
      kind: 'interested',
      perPage,
      page,
      startDate: params.startDate,
      endDate: params.endDate,
      includeAutomated: params.includeAutomated,
      include: (r: any) => {
        if (!r) return false;
        if (!isInterested(r.interested)) return false;
        if (!params.includeAutomated && r.automated_reply) return false;
        // Some workspaces tag system replies as interested; still exclude noise
        if (this.isSystemOrNoise(r)) return false;
        return true;
      },
      campaignId: params.campaignId
    });

    // De-dupe lead fetches (best-effort)
    const uniqueLeadIds = Array.from(new Set(filtered.map(r => Number(r.lead_id)).filter(n => Number.isFinite(n))));

    const leadById = new Map<number, any>();
    for (const id of uniqueLeadIds) {
      try {
        const res = await this.client.get(`/api/leads/${id}`);
        const lead = res.data?.data ?? res.data;
        if (lead) leadById.set(id, lead);
      } catch {
        // ignore missing lead
      }
    }

    // Optional campaign name enrichment
    const campaignNameById = new Map<string, string>();
    const uniqueCampaignIds = Array.from(new Set(filtered.map(r => r.campaign_id).filter(Boolean).map((x: any) => String(x))));
    if (uniqueCampaignIds.length) {
      try {
        const campaigns = await this.getCampaigns();
        for (const c of campaigns) {
          const id = c?.id != null ? String(c.id) : null;
          if (!id) continue;
          if (!uniqueCampaignIds.includes(id)) continue;
          campaignNameById.set(id, String(c?.name ?? ''));
        }
      } catch {
        // ignore
      }
    }

    const out: ReplyLead[] = [];
    for (const r of filtered) {
      // Ensure reply is within the requested window (when provided)
      if (params.startDate) {
        const ms = this.parseReplyDateMs(r);
        const startMs = new Date(`${params.startDate}T00:00:00.000Z`).getTime();
        if (ms && ms < startMs) continue;
      }
      if (params.endDate) {
        const ms = this.parseReplyDateMs(r);
        const endMs = new Date(`${params.endDate}T23:59:59.999Z`).getTime();
        if (ms && ms > endMs) continue;
      }

      const leadIdNum = Number(r.lead_id);
      const lead = Number.isFinite(leadIdNum) ? leadById.get(leadIdNum) : null;

      const first = String(lead?.first_name ?? '').trim();
      const last = String(lead?.last_name ?? '').trim();
      const fullName = [first, last].filter(Boolean).join(' ') || (r.from_name ? String(r.from_name) : null);
      const email = (lead?.email ? String(lead.email) : (r.from_email_address ? String(r.from_email_address) : null)) as string | null;

      const msg = (r.text_body ?? r.html_body ?? r.raw_body ?? null) as any;
      const message = msg ? String(msg).trim().slice(0, 400) : null;

      const campaignId = r.campaign_id != null ? String(r.campaign_id) : null;
      const campaignName = campaignId ? (campaignNameById.get(campaignId) || null) : null;

      out.push({
        platform: 'emailbison',
        clientId: params.clientId,
        clientName: params.clientName,
        category: 'interested',
        campaignId,
        campaignName,
        fullName,
        email,
        replyDate: r.date_received ? String(r.date_received) : (r.created_at ? String(r.created_at) : null),
        message,
        sourceReplyId: r.id ?? null,
        sourceLeadId: r.lead_id ?? null
      });
    }

    // newest first
    out.sort((a, b) => String(b.replyDate ?? '').localeCompare(String(a.replyDate ?? '')));
    return { items: out.slice(0, limit), hasMore };
  }

  /**
   * Fetch recent replies (any reply) and join to leads where possible.
   * This is useful because some workspaces may have 0 Interested replies.
   */
  async getReplyLeads(params: {
    clientId: string;
    clientName: string;
    /** YYYY-MM-DD */
    startDate?: string;
    /** YYYY-MM-DD */
    endDate?: string;
    campaignId?: number | string;
    limit?: number;
    includeAutomated?: boolean;
    /** 1-indexed page for dashboard pagination (applies before filtering). */
    page?: number;
    /** Page size. Defaults to 50. */
    perPage?: number;
  }): Promise<ReplyLead[]> {
    const { items } = await this.getReplyLeadsPage(params);
    return items;
  }

  /**
   * Same as getReplyLeads, but returns paging metadata.
   */
  async getReplyLeadsPage(params: {
    clientId: string;
    clientName: string;
    startDate?: string;
    endDate?: string;
    campaignId?: number | string;
    limit?: number;
    includeAutomated?: boolean;
    page?: number;
    perPage?: number;
  }): Promise<{ items: ReplyLead[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(200, Number(params.limit ?? 50)));
    const perPage = Math.max(1, Math.min(200, Number(params.perPage ?? 50)));
    const page = Math.max(1, Math.min(50, Number(params.page ?? 1)));

    // Fetch a page from the filtered stream so “Older” pages don’t repeat.
    const { rows: filtered, hasMore } = await this.getFilteredRepliesStreamPage({
      kind: 'replied',
      perPage,
      page,
      startDate: params.startDate,
      endDate: params.endDate,
      includeAutomated: params.includeAutomated,
      include: (r: any) => {
        if (!r) return false;
        if (!params.includeAutomated && r.automated_reply) return false;
        if (this.isSystemOrNoise(r)) return false;
        return true;
      },
      campaignId: params.campaignId
    });

    const uniqueLeadIds = Array.from(
      new Set(filtered.map(r => Number(r.lead_id)).filter(n => Number.isFinite(n)))
    );

    const leadById = new Map<number, any>();
    for (const id of uniqueLeadIds) {
      try {
        const res = await this.client.get(`/api/leads/${id}`);
        const lead = res.data?.data ?? res.data;
        if (lead) leadById.set(id, lead);
      } catch {
        // ignore
      }
    }

    const campaignNameById = new Map<string, string>();
    const uniqueCampaignIds = Array.from(new Set(filtered.map(r => r.campaign_id).filter(Boolean).map((x: any) => String(x))));
    if (uniqueCampaignIds.length) {
      try {
        const campaigns = await this.getCampaigns();
        for (const c of campaigns) {
          const id = c?.id != null ? String(c.id) : null;
          if (!id) continue;
          if (!uniqueCampaignIds.includes(id)) continue;
          campaignNameById.set(id, String(c?.name ?? ''));
        }
      } catch {
        // ignore
      }
    }

    const out: ReplyLead[] = [];
    for (const r of filtered) {
      // Ensure within window
      if (params.startDate) {
        const ms = this.parseReplyDateMs(r);
        const startMs = new Date(`${params.startDate}T00:00:00.000Z`).getTime();
        if (ms && ms < startMs) continue;
      }
      if (params.endDate) {
        const ms = this.parseReplyDateMs(r);
        const endMs = new Date(`${params.endDate}T23:59:59.999Z`).getTime();
        if (ms && ms > endMs) continue;
      }
      const leadIdNum = Number(r.lead_id);
      const lead = Number.isFinite(leadIdNum) ? leadById.get(leadIdNum) : null;

      const first = String(lead?.first_name ?? '').trim();
      const last = String(lead?.last_name ?? '').trim();
      const fullName = [first, last].filter(Boolean).join(' ') || (r.from_name ? String(r.from_name) : null);

      const email = (lead?.email ? String(lead.email) : (r.from_email_address ? String(r.from_email_address) : null)) as string | null;

      const msg = (r.text_body ?? r.html_body ?? r.raw_body ?? null) as any;
      const message = msg ? String(msg).trim().slice(0, 400) : null;

      const campaignId = r.campaign_id != null ? String(r.campaign_id) : null;
      const campaignName = campaignId ? (campaignNameById.get(campaignId) || null) : null;

      out.push({
        platform: 'emailbison',
        clientId: params.clientId,
        clientName: params.clientName,
        category: 'replied',
        campaignId,
        campaignName,
        fullName: fullName || null,
        email,
        replyDate: r.date_received ? String(r.date_received) : (r.created_at ? String(r.created_at) : null),
        message,
        sourceReplyId: r.id ?? null,
        sourceLeadId: r.lead_id ?? null
      });
    }

    out.sort((a, b) => String(b.replyDate ?? '').localeCompare(String(a.replyDate ?? '')));
    return { items: out.slice(0, limit), hasMore };
  }
}
