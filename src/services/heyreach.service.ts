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

  private getAppHeaders() {
    const bearer = (this.opts?.bearerToken || '').trim();
    if (!bearer) {
      throw new Error('HeyReach bearer token missing (set CLIENT*_HEYREACH_BEARER).');
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
            const stats = await this.getOverallStatsByCampaign({
              campaignIds: ids,
              startDate: new Date(opts.startDate).toISOString(),
              endDate: new Date(opts.endDate).toISOString()
            });
            this.applyDashboardStats(base, stats);
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
