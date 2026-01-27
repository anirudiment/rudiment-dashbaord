import axios, { AxiosInstance } from 'axios';
import { CampaignMetrics, HeyReachResponse } from '../types';

type HeyReachDashboardStat = {
  ProfileViews?: number;
  PostLikes?: number;
  Follows?: number;
  MessagesSent?: number;
  TotalMessageStarted?: number;
  TotalMessageReplies?: number;
  InmailMessagesSent?: number;
  TotalInmailStarted?: number;
  TotalInmailReplies?: number;
  ConnectionsSent?: number;
  ConnectionsAccepted?: number;
  messageReplyRate?: number; // 0..1 (per observed payload)
  inMailReplyRate?: number; // 0..1
  connectionAcceptanceRate?: number; // 0..1
};

type HeyReachDashboardStatsResponse = {
  result?: Record<string, HeyReachDashboardStat>;
  success?: boolean;
  error?: any;
};

// Public API stats response (confirmed via live probe)
type HeyReachPublicOverallStats = {
  profileViews?: number;
  postLikes?: number;
  follows?: number;
  messagesSent?: number;
  totalMessageStarted?: number;
  totalMessageReplies?: number;
  inmailMessagesSent?: number;
  totalInmailStarted?: number;
  totalInmailReplies?: number;
  connectionsSent?: number;
  connectionsAccepted?: number;
  messageReplyRate?: number;
  inMailReplyRate?: number;
  connectionAcceptanceRate?: number;
};

type HeyReachPublicGetOverallStatsResponse = {
  byDayStats?: Record<string, HeyReachPublicOverallStats>;
  overallStats?: HeyReachPublicOverallStats;
};

function decodeJwtExp(bearerToken: string): Date | null {
  try {
    const raw = bearerToken.trim().toLowerCase().startsWith('bearer ') ? bearerToken.trim().slice(7) : bearerToken.trim();
    const parts = raw.split('.');
    if (parts.length < 2) return null;
    const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (!payload?.exp) return null;
    const expMs = Number(payload.exp) * 1000;
    if (!Number.isFinite(expMs)) return null;
    return new Date(expMs);
  } catch {
    return null;
  }
}

export class HeyReachService {
  private client: AxiosInstance;
  private appClient: AxiosInstance;

  constructor(
    private apiKey: string,
    private opts?: {
      /** HeyReach webapp bearer token (Authorization: Bearer ...) */
      bearerToken?: string;
      /** HeyReach webapp header x-organization-units (comma-separated ids) */
      organizationUnits?: string;
    }
  ) {
    // HeyReach Postman docs: auth header is X-API-KEY and base path includes /api/public
    this.client = axios.create({
      baseURL: 'https://api.heyreach.io/api/public',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey
      }
    });

    // HeyReach webapp API (used by their dashboard). Requires Bearer token.
    this.appClient = axios.create({
      baseURL: 'https://api.heyreach.io/api',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Public API: fetch overall stats. This endpoint is evergreen (X-API-KEY).
   * Confirmed working: POST /api/public/stats/GetOverallStats
   * Observed: requires accountIds.
   */
  private async getPublicOverallStats(params: {
    accountIds: Array<string | number>;
    organizationUnitIds?: Array<string | number>;
    campaignIds?: Array<string | number>;
    startDate: string;
    endDate: string;
  }): Promise<HeyReachPublicGetOverallStatsResponse> {
    const payload = {
      accountIds: (params.accountIds ?? []).map(x => Number(x)).filter(n => Number.isFinite(n)),
      organizationUnitIds: (params.organizationUnitIds ?? []).map(x => Number(x)).filter(n => Number.isFinite(n)),
      campaignIds: (params.campaignIds ?? []).map(x => Number(x)).filter(n => Number.isFinite(n)),
      startDate: params.startDate,
      endDate: params.endDate
    };

    const res = await this.client.post<HeyReachPublicGetOverallStatsResponse>('/stats/GetOverallStats', payload);
    return res.data ?? {};
  }

  /**
   * Public API: fetch overall stats for the provided campaigns as a single aggregate.
   * This is more rate-limit friendly than calling once-per-campaign.
   */
  async getOverallStatsAggregatePublic(params: {
    campaignIds: Array<string | number>;
    startDate: string;
    endDate: string;
    accountIds: Array<string | number>;
    organizationUnitIds?: Array<string | number>;
  }): Promise<HeyReachDashboardStat> {
    const data = await this.getPublicOverallStats({
      accountIds: params.accountIds,
      organizationUnitIds: params.organizationUnitIds,
      campaignIds: params.campaignIds,
      startDate: params.startDate,
      endDate: params.endDate
    });

    const s = (data?.overallStats ?? {}) as HeyReachPublicOverallStats;
    return {
      ProfileViews: s.profileViews ?? 0,
      PostLikes: s.postLikes ?? 0,
      Follows: s.follows ?? 0,
      MessagesSent: s.messagesSent ?? 0,
      TotalMessageStarted: s.totalMessageStarted ?? 0,
      TotalMessageReplies: s.totalMessageReplies ?? 0,
      InmailMessagesSent: s.inmailMessagesSent ?? 0,
      TotalInmailStarted: s.totalInmailStarted ?? 0,
      TotalInmailReplies: s.totalInmailReplies ?? 0,
      ConnectionsSent: s.connectionsSent ?? 0,
      ConnectionsAccepted: s.connectionsAccepted ?? 0,
      messageReplyRate: s.messageReplyRate ?? 0,
      inMailReplyRate: s.inMailReplyRate ?? 0,
      connectionAcceptanceRate: s.connectionAcceptanceRate ?? 0
    };
  }

  /**
   * Evergreen per-campaign stats using Public API.
   * Since /stats/GetOverallStats returns one overallStats object, we call it once per campaignId.
   */
  async getOverallStatsByCampaignPublic(params: {
    campaignIds: Array<string | number>;
    startDate: string;
    endDate: string;
    accountIds: Array<string | number>;
    organizationUnitIds?: Array<string | number>;
    concurrency?: number;
  }): Promise<Record<string, HeyReachDashboardStat>> {
    const ids = (params.campaignIds ?? []).map(x => Number(x)).filter(n => Number.isFinite(n));
    const concurrency = Math.max(1, Math.min(10, Number(params.concurrency ?? 3)));

    const out: Record<string, HeyReachDashboardStat> = {};

    // Simple concurrency-limited worker pool
    let idx = 0;
    const worker = async () => {
      while (idx < ids.length) {
        const i = idx++;
        const campaignId = ids[i];
        try {
          const data = await this.getPublicOverallStats({
            accountIds: params.accountIds,
            organizationUnitIds: params.organizationUnitIds,
            campaignIds: [campaignId],
            startDate: params.startDate,
            endDate: params.endDate
          });

          const s = (data?.overallStats ?? {}) as HeyReachPublicOverallStats;

          // Adapt public schema to the dashboard-stat schema our code already uses.
          out[String(campaignId)] = {
            ProfileViews: s.profileViews ?? 0,
            PostLikes: s.postLikes ?? 0,
            Follows: s.follows ?? 0,
            MessagesSent: s.messagesSent ?? 0,
            TotalMessageStarted: s.totalMessageStarted ?? 0,
            TotalMessageReplies: s.totalMessageReplies ?? 0,
            InmailMessagesSent: s.inmailMessagesSent ?? 0,
            TotalInmailStarted: s.totalInmailStarted ?? 0,
            TotalInmailReplies: s.totalInmailReplies ?? 0,
            ConnectionsSent: s.connectionsSent ?? 0,
            ConnectionsAccepted: s.connectionsAccepted ?? 0,
            messageReplyRate: s.messageReplyRate ?? 0,
            inMailReplyRate: s.inMailReplyRate ?? 0,
            connectionAcceptanceRate: s.connectionAcceptanceRate ?? 0
          };
        } catch (e: any) {
          // Don't fail whole batch; just omit this campaign.
          console.error('[heyreach] public stats failed for campaign', campaignId, e?.message ?? e);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
    return out;
  }

  private getAppHeaders() {
    const bearer = (this.opts?.bearerToken || '').trim();
    if (!bearer) {
      throw new Error('HeyReach bearer token missing (set CLIENT*_HEYREACH_BEARER).');
    }

    // Guard: HeyReach webapp bearer is a JWT that expires.
    // When expired, HeyReach returns 401 "Current user did not login".
    const exp = decodeJwtExp(bearer);
    if (exp && exp.getTime() <= Date.now()) {
      throw new Error(`HeyReach bearer token expired at ${exp.toISOString()} (update CLIENT*_HEYREACH_BEARER).`);
    }

    const headers: Record<string, string> = {
      Authorization: bearer.toLowerCase().startsWith('bearer ') ? bearer : `Bearer ${bearer}`
    };

    const orgUnits = (this.opts?.organizationUnits || '').trim();
    if (orgUnits) headers['x-organization-units'] = orgUnits;
    headers['x-requested-with'] = 'XMLHttpRequest';
    return headers;
  }

  /**
   * Whether the provided bearer token exists and is not expired.
   * Useful for choosing between webapp endpoints vs public API.
   */
  hasBearer(): boolean {
    const bearer = (this.opts?.bearerToken || '').trim();
    if (!bearer) return false;
    const exp = decodeJwtExp(bearer);
    if (exp && exp.getTime() <= Date.now()) return false;
    return true;
  }

  /**
   * Fetch per-campaign performance stats used by HeyReach web dashboard.
   * Source: POST /api/Dashboard/GetOverallStatsByCampaign
   */
  async getOverallStatsByCampaign(params: {
    campaignIds: Array<string | number>;
    startDate: string; // ISO string
    endDate: string; // ISO string
    accountIds?: Array<string | number>;
    organizationUnitIds?: Array<string | number>;
  }): Promise<Record<string, HeyReachDashboardStat>> {
    const payload = {
      accountIds: params.accountIds ?? [],
      organizationUnitIds: params.organizationUnitIds ?? [],
      campaignIds: (params.campaignIds ?? []).map(x => Number(x)).filter(n => Number.isFinite(n)),
      startDate: params.startDate,
      endDate: params.endDate
    };

    const res = await this.appClient.post<HeyReachDashboardStatsResponse>(
      '/Dashboard/GetOverallStatsByCampaign',
      payload,
      { headers: this.getAppHeaders() }
    );

    if (res.data?.success === false) {
      throw new Error(res.data?.error ? String(res.data.error) : 'HeyReach GetOverallStatsByCampaign failed');
    }
    return (res.data?.result ?? {}) as Record<string, HeyReachDashboardStat>;
  }

  /**
   * Fetch all campaigns from HeyReach
   */
  async getCampaigns(): Promise<any[]> {
    try {
      // Confirmed via HeyReach Public API (Postman): campaign list is a POST endpoint.
      // POST /campaign/getAll returns { totalCount, items: [...] }
      // The API enforces Limit between 1 and 100, so we paginate.
      const limit = 100;
      let offset = 0;
      let totalCount: number | null = null;
      const allItems: any[] = [];

      while (totalCount === null || offset < totalCount) {
        const response = await this.client.post('/campaign/getAll', {
          offset,
          limit
        });

        const items = response.data?.items || [];
        totalCount = typeof response.data?.totalCount === 'number' ? response.data.totalCount : allItems.length + items.length;

        allItems.push(...items);
        offset += limit;

        if (items.length === 0) break;
      }

      // Adapt HeyReach's response shape to our legacy consumer expectations.
      // NOTE: /campaign/getAll does NOT include engagement counters (connections sent/accepted, etc)
      // so we DO NOT fabricate them as 0 — we mark them as unavailable.
      return allItems.map((c: any) => {
        const progress = c.progressStats || {};
        return {
          ...c,
          campaign_id: c.id,
          campaign_name: c.name,
          active: String(c.status || '').toUpperCase() === 'IN_PROGRESS',
          leads: c.leads ?? {
            total: progress.totalUsers ?? 0,
            contacted: (progress.totalUsersFinished ?? 0) + (progress.totalUsersInProgress ?? 0),
            remaining: progress.totalUsersPending ?? 0
          },
          // Engagement counters require a different API endpoint (or MCP). Leave undefined.
          engagement: c.engagement
        };
      });
    } catch (error: any) {
      console.error('Error fetching HeyReach campaigns:', {
        message: error?.message,
        status: error?.response?.status,
        url: error?.config?.baseURL ? `${error.config.baseURL}${error.config.url}` : error?.config?.url,
        data: error?.response?.data
      });
      throw error;
    }
  }

  /**
   * Fetch a specific campaign by ID
   */
  async getCampaign(campaignId: string): Promise<HeyReachResponse> {
    try {
      // HeyReach campaign list returns numeric `id`. Details endpoint is currently not confirmed.
      // Keeping a conservative path here; adjust once we confirm the exact endpoint.
      const response = await this.client.get(`/campaign/${campaignId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching HeyReach campaign ${campaignId}:`, error);
      throw error;
    }
  }

  /**
   * Transform HeyReach API response to standardized CampaignMetrics
   */
  transformToMetrics(campaign: HeyReachResponse, clientName: string): CampaignMetrics {
    // The POST /campaign/getAll endpoint returns a different shape than our legacy HeyReachResponse.
    // We keep this mapping best-effort for now; the monitor mainly needs campaign IDs & names.
    const anyCampaign: any = campaign as any;
    const progress = anyCampaign.progressStats || {};
    const hasEngagement = !!anyCampaign.engagement;
    const messagesSent = Number(anyCampaign.engagement?.messages_sent ?? 0);
    const replies = Number(anyCampaign.engagement?.replies ?? 0);
    const connections = Number(anyCampaign.engagement?.connections ?? 0);

    return {
      campaignId: String(anyCampaign.id ?? (campaign as any).campaign_id ?? ''),
      platform: 'heyreach',
      campaignName: anyCampaign.name ?? (campaign as any).campaign_name ?? undefined,
      leadsRemaining: anyCampaign.leads?.remaining ?? 0,
      leadsTotal: anyCampaign.leads?.total ?? progress.totalUsers ?? 0,
      leadsContacted: anyCampaign.leads?.contacted ?? undefined,
      // For HeyReach, “sentCount” is *not* email sent. We keep it 0 unless we have engagement stats.
      // This prevents misleading totals on the dashboard.
      emailsSent: hasEngagement ? messagesSent : 0,
      sentCount: hasEngagement ? messagesSent : 0,
      repliedCount: hasEngagement ? replies : 0,
      bounceRate: 0, // LinkedIn doesn't have bounces like email
      replyRate: hasEngagement && messagesSent > 0 ? (replies / messagesSent) * 100 : 0,
      openRate: hasEngagement && messagesSent > 0 ? (connections / messagesSent) * 100 : 0, // proxy
      sequenceDaysRemaining: 0,
      campaignDuration: 0,
      dailySendVolume: hasEngagement ? messagesSent : 0,
      hasEngagementStats: hasEngagement,
      // Keep fields ready for future enrichment once we locate the proper stats endpoint.
      messagesSent: hasEngagement ? messagesSent : undefined,
      messageReplies: hasEngagement ? replies : undefined,
      timestamp: new Date()
    };
  }

  /**
   * Merge HeyReach dashboard stats (from /api/Dashboard/GetOverallStatsByCampaign)
   * into our CampaignMetrics objects.
   */
  applyDashboardStats(metrics: CampaignMetrics[], statsByCampaignId: Record<string, HeyReachDashboardStat>) {
    for (const m of metrics) {
      const stat = statsByCampaignId[String(m.campaignId)];
      if (!stat) continue;

      const connectionsSent = Number(stat.ConnectionsSent ?? 0);
      const connectionsAccepted = Number(stat.ConnectionsAccepted ?? 0);
      // HeyReach UI “Messages Sent” corresponds to TotalMessageStarted (not MessagesSent).
      const messagesSent = Number(stat.TotalMessageStarted ?? 0);
      const messageReplies = Number(stat.TotalMessageReplies ?? 0);
      // HeyReach UI “InMails Sent” corresponds to TotalInmailStarted (not InmailMessagesSent).
      const inMailsSent = Number(stat.TotalInmailStarted ?? 0);
      const inMailReplies = Number(stat.TotalInmailReplies ?? 0);

      // HeyReach returns rates in 0..1; store as percent 0..100.
      const pct = (v: unknown) => {
        const n = Number(v ?? 0);
        if (!Number.isFinite(n)) return 0;
        return n <= 1 ? n * 100 : n;
      };

      (m as any).connectionsSent = connectionsSent;
      (m as any).connectionsAccepted = connectionsAccepted;
      (m as any).connectionAcceptanceRate = pct(stat.connectionAcceptanceRate);
      (m as any).messagesSent = messagesSent;
      (m as any).messageReplies = messageReplies;
      (m as any).messageReplyRate = pct(stat.messageReplyRate);
      (m as any).inMailsSent = inMailsSent;
      (m as any).inMailReplies = inMailReplies;
      (m as any).inMailReplyRate = pct(stat.inMailReplyRate);

      // We now have engagement stats (from dashboard endpoint).
      m.hasEngagementStats = true;

      // Do NOT override email totals fields; HeyReach is not email.
      // Keep sentCount/repliedCount at 0 so it doesn't pollute email KPIs.
    }
  }

  /**
   * Fetch and transform all campaign metrics
   */
  async getAllCampaignMetrics(
    clientName: string,
    opts?: { status?: string; startDate?: string; endDate?: string; includeDashboardStats?: boolean }
  ): Promise<CampaignMetrics[]> {
    try {
      const campaigns = await this.getCampaigns();

      const statusFilter = String(opts?.status || 'active').toLowerCase();
      const norm = (s: unknown) => String(s ?? '').toUpperCase();
      const isActive = (s: string) => s === 'IN_PROGRESS';
      const isCompleted = (s: string) => s === 'FINISHED' || s === 'COMPLETED';
      const isPaused = (s: string) => s === 'PAUSED' || s === 'STOPPED';

      const base = campaigns
        .filter((c: any) => {
          const s = norm(c?.status);
          if (statusFilter === 'all') return true;
          if (statusFilter === 'active') return isActive(s);
          if (statusFilter === 'completed') return isCompleted(s);
          if (statusFilter === 'paused') return isPaused(s);
          return isActive(s);
        })
        .map(campaign => this.transformToMetrics(campaign as any, clientName));

      // Optionally enrich with web-dashboard performance metrics.
      if (opts?.includeDashboardStats && opts?.startDate && opts?.endDate) {
        try {
          const ids = base.map(m => Number(m.campaignId)).filter(n => Number.isFinite(n));
          if (ids.length) {
            // Prefer HeyReach webapp endpoint (single call) when bearer is available.
            // Falls back to public API (many calls) when bearer isn't available.
            const campaignsAny = campaigns as any[];
            const accountIds = Array.from(
              new Set(
                campaignsAny
                  .flatMap((c: any) => (c?.campaignAccountIds ?? []).map((x: any) => Number(x)))
                  .filter((n: any) => Number.isFinite(n))
              )
            );
            const organizationUnitIds = Array.from(
              new Set(
                campaignsAny
                  .map((c: any) => Number(c?.organizationUnitId))
                  .filter((n: any) => Number.isFinite(n))
              )
            );

            const startIso = new Date(opts.startDate).toISOString();
            const endIso = new Date(opts.endDate).toISOString();

            if (this.hasBearer()) {
              const stats = await this.getOverallStatsByCampaign({
                campaignIds: ids,
                startDate: startIso,
                endDate: endIso
              });
              this.applyDashboardStats(base, stats);
            } else if (accountIds.length) {
              const stats = await this.getOverallStatsByCampaignPublic({
                campaignIds: ids,
                accountIds,
                organizationUnitIds,
                startDate: startIso,
                endDate: endIso,
                concurrency: 2
              });
              this.applyDashboardStats(base, stats);
            } else {
              console.warn('[heyreach] Skipping stats enrichment: no bearer token and no accountIds');
            }
          }
        } catch (e: any) {
          // Do not fail the whole dashboard; just log.
          console.error('[heyreach] Failed to fetch dashboard stats:', e?.message ?? e);
        }
      }

      return base;
    } catch (error) {
      console.error('Error fetching all HeyReach campaign metrics:', error);
      return [];
    }
  }
}
