import axios, { AxiosInstance } from 'axios';
import { CampaignMetrics, InstantlyResponse, ReplyLead } from '../types';

export class InstantlyService {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      // Instantly API V2 base URL (per official docs)
      baseURL: 'https://api.instantly.ai',
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Fetch all campaigns from Instantly
   */
  async getCampaigns(): Promise<InstantlyResponse[]> {
    try {
      // Instantly API V2 uses an API key passed as Authorization: Bearer <token>
      // Docs: https://developer.instantly.ai/api/v2/campaign/listcampaign
      const response = await this.client.get('/api/v2/campaigns', {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        params: {
          // Max allowed per docs is 100
          limit: 100
        }
      });

      // The v2 response is usually { items: [...], next_starting_after?: string }.
      // We keep it loosely typed and normalize in transform step.
      const data = response.data;
      if (Array.isArray(data)) return data as any;
      if (Array.isArray(data?.items)) return data.items as any;
      return [];
    } catch (error) {
      console.error('Error fetching Instantly campaigns:', error);
      throw error;
    }
  }

  /**
   * Fetch campaign analytics totals from Instantly.
   *
   * Endpoint supports an optional start_date/end_date.
   * If omitted, Instantly will compute over its default period.
   *
   * Docs: https://developer.instantly.ai/api/v2/analytics/getcampaignanalytics
   */
  async getCampaignAnalytics(params: { campaignId: string; startDate?: string; endDate?: string }) {
    const response = await this.client.get('/api/v2/campaigns/analytics', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      params: {
        id: params.campaignId,
        ...(params.startDate ? { start_date: params.startDate } : null),
        ...(params.endDate ? { end_date: params.endDate } : null),
        exclude_total_leads_count: false
      }
    });
    return response.data;
  }

  /**
   * Fetch analytics for all campaigns (optionally for a date window).
   *
   * This endpoint is what powers the dashboard’s “Last N days” totals.
   */
  async getAllCampaignAnalytics(params?: { startDate?: string; endDate?: string }) {
    const response = await this.client.get('/api/v2/campaigns/analytics', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      params: {
        ...(params?.startDate ? { start_date: params.startDate } : null),
        ...(params?.endDate ? { end_date: params.endDate } : null),
        exclude_total_leads_count: false
      }
    });
    return response.data;
  }

  /**
   * Fetch a specific campaign by ID
   */
  async getCampaign(campaignId: string): Promise<InstantlyResponse> {
    try {
      const response = await this.client.get(`/api/v2/campaigns/${campaignId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });
      return response.data;
    } catch (error) {
      console.error(`Error fetching Instantly campaign ${campaignId}:`, error);
      throw error;
    }
  }

  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId: string): Promise<any> {
    try {
      return await this.getCampaignAnalytics({ campaignId });
    } catch (error) {
      console.error(`Error fetching Instantly stats for ${campaignId}:`, error);
      throw error;
    }
  }

  /**
   * Transform Instantly API response to standardized CampaignMetrics
   */
  transformToMetrics(campaign: InstantlyResponse, clientName: string): CampaignMetrics {
    const totalSent = campaign.stats?.sent || 0;
    const bounced = campaign.stats?.bounced || 0;
    const replied = campaign.stats?.replied || 0;
    const opened = campaign.stats?.opened || 0;

    const id = String((campaign as any).id ?? campaign.campaign_id ?? '');
    const name = (campaign as any).name ?? campaign.campaign_name;

    // Normalize status best-effort.
    // Observed: v2 status numeric 1=Active, 2=Paused.
    const rawStatus = (campaign as any)?.status;
    const n = Number(rawStatus);
    const s = String(rawStatus ?? '').toLowerCase();
    const campaignStatus =
      Number.isFinite(n) ? (n === 1 ? 'active' : n === 2 ? 'paused' : 'completed') :
      (s.includes('pause') ? 'paused' : s.includes('active') || s.includes('run') || s.includes('queue') ? 'active' : 'completed');

    // If we don't have leads breakdown, leave best-effort zeros.
    const leadsTotal = campaign.leads?.total ?? 0;
    const leadsContacted = campaign.leads?.completed ?? undefined;
    const leadsRemaining = campaign.leads?.remaining ?? 0;

    return {
      campaignId: id,
      platform: 'instantly',
      campaignName: name,
      campaignStatus,
      leadsRemaining,
      leadsTotal,
      leadsContacted,
      emailsSent: totalSent,
      sentCount: totalSent,
      bouncedCount: bounced,
      repliedCount: replied,
      openedCount: opened,
      bounceRate: totalSent > 0 ? (bounced / totalSent) * 100 : 0,
      replyRate: totalSent > 0 ? (replied / totalSent) * 100 : 0,
      openRate: totalSent > 0 ? (opened / totalSent) * 100 : 0,
      sequenceDaysRemaining: 0, // Requires additional calculation based on sequence settings
      campaignDuration: 0, // Requires campaign start date
      dailySendVolume: totalSent, // Simplified - requires historical data for accurate calculation
      timestamp: new Date()
    };
  }

  /**
   * Transform Instantly analytics payload into CampaignMetrics.
   *
   * Analytics example fields (from API):
   *   leads_count, contacted_count, emails_sent_count, reply_count, bounced_count,
   *   open_count, campaign_id, campaign_name
   */
  transformAnalyticsToMetrics(analytics: any): CampaignMetrics {
    const sent = Number(analytics?.emails_sent_count ?? 0);
    const bounced = Number(analytics?.bounced_count ?? 0);

    // Prefer human unique replies (exclude automatic replies) to match Instantly UI list:
    // UI shows e.g. "28 | 2.6%" when analytics has reply_count_unique=30 and reply_count_automatic_unique=2.
    const replyUnique = Number(analytics?.reply_count_unique ?? analytics?.reply_count ?? 0);
    const replyAutoUnique = Number(analytics?.reply_count_automatic_unique ?? 0);
    const replied = Math.max(0, replyUnique - replyAutoUnique);
    const opened = Number(analytics?.open_count ?? analytics?.open_count_unique ?? 0);
    // Instantly UI calls this "Sequence started".
    const leadsTotal = Number(analytics?.leads_count ?? 0);

    // For Instantly, we want Reply % like the Instantly UI list.
    // Observed:
    // - Lifetime UI seems to use replies / leads_count (sequence started)
    // - Short ranges (e.g. last 7 days) appear to use replies / new_leads_contacted_count
    //   (example: replies=2, reply_rate=2.5% implies denom=80)
    // We approximate this by using new_leads_contacted_count when it exists and is non-zero;
    // otherwise fall back to leads_count.
    const newLeadsContacted = Number(analytics?.new_leads_contacted_count ?? 0);
    const leadsContacted = Number.isFinite(newLeadsContacted) && newLeadsContacted > 0 ? newLeadsContacted : leadsTotal;
    const completed = Number(analytics?.completed_count ?? 0);
    const leadsRemaining = leadsTotal > 0 ? Math.max(0, leadsTotal - completed) : 0;

    // Instantly calls “Interested” as “Opportunities”.
    // In analytics payload we observed: total_opportunities, total_opportunity_value.
    const opportunities = Number(analytics?.total_opportunities ?? 0);

    // Derive “positive reply %” as Opportunities / Replies.
    const interestedRate = replied > 0 ? (opportunities / replied) * 100 : 0;

    // Rate denominators:
    // - Reply rate: per sequence started (leadsTotal)
    // - Bounce/Open rate: per sent (classic email denominators)
    const replyDenom = Number.isFinite(leadsContacted) && leadsContacted > 0 ? leadsContacted : (leadsTotal > 0 ? leadsTotal : sent);
    const sentDenom = sent;

    return {
      campaignId: String(analytics?.campaign_id ?? ''),
      platform: 'instantly',
      campaignName: analytics?.campaign_name ?? undefined,
      // Analytics endpoint doesn't always return status; best-effort default to active.
      campaignStatus: analytics?.status != null ? String(analytics.status) : 'active',
      leadsRemaining,
      leadsTotal,
      leadsContacted: Number.isFinite(leadsContacted) ? leadsContacted : undefined,
      emailsSent: sent,
      sentCount: sent,
      bouncedCount: bounced,
      repliedCount: replied,
      openedCount: opened,
      interestedCount: Number.isFinite(opportunities) ? opportunities : 0,
      interestedRate,
      bounceRate: sentDenom > 0 ? (bounced / sentDenom) * 100 : 0,
      replyRate: replyDenom > 0 ? (replied / replyDenom) * 100 : 0,
      openRate: sentDenom > 0 ? (opened / sentDenom) * 100 : 0,
      sequenceDaysRemaining: 0,
      campaignDuration: 0,
      dailySendVolume: sent,
      timestamp: new Date()
    };
  }

  /**
   * Fetch and transform all campaign metrics
   */
  async getAllCampaignMetrics(
    clientName: string,
    window?: { startDate?: string; endDate?: string; windowDays?: number; activeCampaignIds?: string[] }
  ): Promise<CampaignMetrics[]> {
    try {
      // Best-effort status map (campaign list includes status; analytics often doesn't).
      const statusById = new Map<string, string>();
      try {
        const campaigns = await this.getCampaigns();
        for (const c of campaigns as any[]) {
          const id = c?.id != null ? String(c.id) : (c?.campaign_id != null ? String(c.campaign_id) : null);
          if (!id) continue;
          const raw = c?.status;
          const n = Number(raw);
          const s = String(raw ?? '').toLowerCase();
          const status =
            Number.isFinite(n) ? (n === 1 ? 'active' : n === 2 ? 'paused' : 'completed') :
            (s.includes('pause') ? 'paused' : s.includes('active') || s.includes('run') || s.includes('queue') ? 'active' : 'completed');
          statusById.set(id, status);
        }
      } catch {
        // ignore; status remains best-effort
      }

      // Prefer analytics endpoint because it includes totals (sent/replied/bounced etc)
      // and can be used as lifetime metrics.
      const data = await this.getAllCampaignAnalytics({ startDate: window?.startDate, endDate: window?.endDate });
      const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

      const activeSet = window?.activeCampaignIds?.length ? new Set(window.activeCampaignIds) : null;
      return (items as any[])
        .filter(a => (activeSet ? activeSet.has(String(a?.campaign_id ?? a?.id ?? '')) : true))
        .map(a => {
          const m = this.transformAnalyticsToMetrics(a);
          const id = String((a as any)?.campaign_id ?? (a as any)?.id ?? m.campaignId ?? '');
          const st = statusById.get(id);
          // Prefer list status when available; else keep analytics best-effort.
          if (st) m.campaignStatus = st;
          return { ...m, windowDays: window?.windowDays };
        });
    } catch (error) {
      console.error('Error fetching all Instantly campaign metrics:', error);
      return [];
    }
  }

  /**
   * List Unibox emails.
   *
   * Docs: GET /api/v2/emails
   * Returns: { items: Email[], next_starting_after?: string }
   */
  async listEmails(params?: {
    limit?: number;
    startingAfter?: string;
    /** Optional server-side filter (may not be reliable across orgs). */
    ueType?: number;
  }): Promise<{ items: any[]; next_starting_after?: string } | any> {
    const limit = Math.max(1, Math.min(100, Number(params?.limit ?? 50)));
    const response = await this.client.get('/api/v2/emails', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      params: {
        limit,
        ...(params?.startingAfter ? { starting_after: params.startingAfter } : null),
        ...(params?.ueType != null ? { ue_type: params.ueType } : null)
      }
    });
    return response.data;
  }

  /**
   * Fetch recent reply leads (Instantly Unibox).
   *
   * Instantly does not currently expose a clean server-side date filter for /emails,
   * so we page newest->older and stop once we reach older-than-startDate.
   */
  async getReplyLeads(params: {
    clientId: string;
    clientName: string;
    startDate?: string; // YYYY-MM-DD
    endDate?: string; // YYYY-MM-DD
    campaignId?: string;
    limit?: number;
    /** Max pages to scan (protect against large inboxes). */
    maxPages?: number;
  }): Promise<ReplyLead[]> {
    const limit = Math.max(1, Math.min(200, Number(params.limit ?? 50)));
    const maxPages = Math.max(1, Math.min(30, Number(params.maxPages ?? 10)));

    const startMs = params.startDate ? new Date(`${params.startDate}T00:00:00.000Z`).getTime() : null;
    const endMs = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`).getTime() : null;

    const out: ReplyLead[] = [];
    let startingAfter: string | undefined = undefined;

    // Campaign name enrichment
    const campaignNameById = new Map<string, string>();
    try {
      const campaigns = await this.getCampaigns();
      for (const c of campaigns as any[]) {
        const id = c?.id != null ? String(c.id) : (c?.campaign_id != null ? String(c.campaign_id) : null);
        if (!id) continue;
        const name = c?.name ?? c?.campaign_name;
        if (name) campaignNameById.set(id, String(name));
      }
    } catch {
      // ignore enrichment failures
    }

    const toPlain = (html: string) =>
      String(html ?? '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n\s+/g, '\n')
        .replace(/[\t\r]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const isInbound = (e: any) => {
      const from = String(e?.from_address_email ?? '').toLowerCase();
      const lead = String(e?.lead ?? '').toLowerCase();
      const acct = String(e?.eaccount ?? '').toLowerCase();

      // If sender matches lead and not the sending account, treat as inbound.
      if (lead && from === lead && acct && from !== acct) return true;

      // Fallback: if from is not the sending account, likely inbound.
      if (acct && from && from !== acct) return true;
      return false;
    };

    const parseMs = (e: any) => {
      const raw = e?.timestamp_email ?? e?.timestamp_created;
      const ms = raw ? new Date(String(raw)).getTime() : 0;
      return Number.isFinite(ms) ? ms : 0;
    };

    for (let page = 1; page <= maxPages; page++) {
      const data = await this.listEmails({ limit: 100, startingAfter });
      const items: any[] = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      if (!items.length) break;

      for (const e of items) {
        if (!e) continue;
        if (params.campaignId && String(e?.campaign_id ?? '') !== String(params.campaignId)) continue;
        if (!isInbound(e)) continue;

        const ms = parseMs(e);
        if (startMs != null && ms && ms < startMs) {
          // We’re iterating newest->older, so once we cross start date we can stop.
          page = maxPages + 1;
          break;
        }
        if (endMs != null && ms && ms > endMs) continue;

        const messageHtml = e?.body?.html ?? '';
        const message = messageHtml ? toPlain(String(messageHtml)).slice(0, 400) : null;

        const campaignId = e?.campaign_id ? String(e.campaign_id) : null;
        const campaignName = campaignId ? (campaignNameById.get(campaignId) || null) : null;

        out.push({
          platform: 'instantly',
          clientId: params.clientId,
          clientName: params.clientName,
          category: 'replied',
          campaignId,
          campaignName,
          fullName: null,
          email: e?.lead ? String(e.lead) : null,
          replyDate: e?.timestamp_email ? String(e.timestamp_email) : (e?.timestamp_created ? String(e.timestamp_created) : null),
          message,
          sourceReplyId: e?.id ?? null,
          sourceLeadId: null
        });

        if (out.length >= limit) break;
      }

      if (out.length >= limit) break;
      startingAfter = data?.next_starting_after ? String(data.next_starting_after) : undefined;
      if (!startingAfter) break;
    }

    // newest first
    out.sort((a, b) => String(b.replyDate ?? '').localeCompare(String(a.replyDate ?? '')));
    return out.slice(0, limit);
  }
}
