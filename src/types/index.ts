// Campaign and Alert Types

export interface Campaign {
  id: string;
  clientName: string;
  platform: 'instantly' | 'emailbison' | 'heyreach';
  name: string;
  status: 'active' | 'paused' | 'completed';
  createdAt: Date;
  lastChecked?: Date;
}

export interface CampaignMetrics {
  campaignId: string;
  platform: 'instantly' | 'emailbison' | 'heyreach' | string;
  /** Human-readable campaign name (when available). */
  campaignName?: string;
  /**
   * If metrics are computed over a fixed time window (e.g. EmailBison last-7-days),
   * set the size of that window.
   */
  windowDays?: number;
  leadsRemaining: number;
  leadsTotal: number;
  /** Best-effort: how many leads have been contacted so far (platform-specific). */
  leadsContacted?: number;
  emailsSent: number;
  /** Raw counts used to compute rates and to power dashboard aggregates. */
  sentCount?: number;
  bouncedCount?: number;
  repliedCount?: number;
  openedCount?: number;
  /** “Interested replies / leads” where available (currently EmailBison). */
  interestedCount?: number;
  /** Derived success metric where available: Interested / Replied (0-100). */
  interestedRate?: number;
  bounceRate: number;
  replyRate: number;
  openRate: number;
  sequenceDaysRemaining: number;
  campaignDuration: number; // in days
  dailySendVolume: number;
  timestamp: Date;
}

export interface Alert {
  id: string;
  campaignId: string;
  clientName: string;
  campaignName: string;
  type: AlertType;
  severity: 'critical' | 'warning' | 'success';
  message: string;
  metrics?: Partial<CampaignMetrics>;
  timestamp: Date;
  sent: boolean;
}

export enum AlertType {
  LOW_LEADS = 'low_leads',
  HIGH_BOUNCE = 'high_bounce',
  HIGH_REPLY = 'high_reply',
  HIGH_INTERESTED = 'high_interested',
  LOW_REPLY = 'low_reply',
  SEQUENCE_ENDING = 'sequence_ending',
  LONG_RUNNING = 'long_running',
  VOLUME_DROP = 'volume_drop'
}

export interface Thresholds {
  lowLeadsThreshold: number;
  highBounceRate: number;
  excellentReplyRate: number;
  excellentInterestedRate: number;
  poorReplyRate: number;
  daysBeforeSequenceEnd: number;
  longRunningCampaignDays: number;
  volumeDropPercentage: number;
}

export interface InstantlyResponse {
  /** API V2 fields */
  id?: string;
  name?: string;
  /** V2 status is an enum number (1 = Active, 2 = Paused, etc). */
  status: string | number;

  /** API V1 legacy fields (still accepted by some integrations). */
  campaign_id?: string;
  campaign_name?: string;
  leads?: {
    total: number;
    completed: number;
    remaining: number;
  };
  stats?: {
    sent: number;
    bounced: number;
    replied: number;
    opened: number;
  };
}

export interface EmailBisonResponse {
  campaign_id: string;
  name: string;
  status: string;
  metrics: {
    total_leads: number;
    sent: number;
    bounces: number;
    replies: number;
    opens: number;
  };
}

export interface HeyReachResponse {
  campaign_id: string;
  campaign_name: string;
  active: boolean;
  leads: {
    total: number;
    contacted: number;
    remaining: number;
  };
  engagement: {
    connections: number;
    replies: number;
    messages_sent: number;
  };
}

export interface ClayResponse {
  table_id: string;
  table_name: string;
  rows: {
    total: number;
    enriched: number;
    pending: number;
  };
  credits_used: number;
}
