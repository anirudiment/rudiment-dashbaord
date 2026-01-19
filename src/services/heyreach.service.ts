import axios, { AxiosInstance } from 'axios';
import { CampaignMetrics, HeyReachResponse } from '../types';

export class HeyReachService {
  private client: AxiosInstance;

  constructor(private apiKey: string) {
    // HeyReach Postman docs: auth header is X-API-KEY and base path includes /api/public
    this.client = axios.create({
      baseURL: 'https://api.heyreach.io/api/public',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey
      }
    });
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

      // Adapt HeyReach's response shape to our legacy consumer expectations used in src/test-apis.ts
      // so the rest of the codebase doesn't have to change.
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
            remaining: (progress.totalUsersPending ?? 0)
          },
          engagement: c.engagement ?? {
            messages_sent: 0,
            connections: 0,
            replies: 0
          }
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
    const messagesSent = anyCampaign.engagement?.messages_sent || 0;
    const replies = anyCampaign.engagement?.replies || 0;
    const connections = anyCampaign.engagement?.connections || 0;

    return {
      campaignId: String(anyCampaign.id ?? (campaign as any).campaign_id ?? ''),
      platform: 'heyreach',
      campaignName: anyCampaign.name ?? (campaign as any).campaign_name ?? undefined,
      leadsRemaining: anyCampaign.leads?.remaining ?? 0,
      leadsTotal: anyCampaign.leads?.total ?? progress.totalUsers ?? 0,
      leadsContacted: anyCampaign.leads?.contacted ?? undefined,
      emailsSent: messagesSent, // Messages sent on LinkedIn
      sentCount: messagesSent,
      repliedCount: replies,
      bounceRate: 0, // LinkedIn doesn't have bounces like email
      replyRate: messagesSent > 0 ? (replies / messagesSent) * 100 : 0,
      openRate: messagesSent > 0 ? (connections / messagesSent) * 100 : 0, // Using connections as proxy for "opens"
      sequenceDaysRemaining: 0,
      campaignDuration: 0,
      dailySendVolume: messagesSent,
      timestamp: new Date()
    };
  }

  /**
   * Fetch and transform all campaign metrics
   */
  async getAllCampaignMetrics(clientName: string, opts?: { status?: string }): Promise<CampaignMetrics[]> {
    try {
      const campaigns = await this.getCampaigns();

      const statusFilter = String(opts?.status || 'active').toLowerCase();
      const norm = (s: unknown) => String(s ?? '').toUpperCase();
      const isActive = (s: string) => s === 'IN_PROGRESS';
      const isCompleted = (s: string) => s === 'FINISHED' || s === 'COMPLETED';
      const isPaused = (s: string) => s === 'PAUSED' || s === 'STOPPED';

      return campaigns
        .filter((c: any) => {
          const s = norm(c?.status);
          if (statusFilter === 'all') return true;
          if (statusFilter === 'active') return isActive(s);
          if (statusFilter === 'completed') return isCompleted(s);
          if (statusFilter === 'paused') return isPaused(s);
          return isActive(s);
        })
        .map(campaign => this.transformToMetrics(campaign as any, clientName));
    } catch (error) {
      console.error('Error fetching all HeyReach campaign metrics:', error);
      return [];
    }
  }
}
