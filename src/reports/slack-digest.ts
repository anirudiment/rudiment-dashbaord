import { Alert, AlertType, CampaignMetrics } from '../types';

export type ClientDigestInput = {
  clientName: string;
  clientId?: string;
  metrics: CampaignMetrics[];
  alerts: Alert[];
  generatedAt?: Date;
};

const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  [AlertType.LOW_LEADS]: 'Low leads',
  [AlertType.HIGH_BOUNCE]: 'High bounce',
  [AlertType.HIGH_REPLY]: 'High reply',
  [AlertType.HIGH_INTERESTED]: 'High interested',
  [AlertType.LOW_REPLY]: 'Low reply',
  [AlertType.SEQUENCE_ENDING]: 'Sequence ending',
  [AlertType.LONG_RUNNING]: 'Long running',
  [AlertType.VOLUME_DROP]: 'Volume drop'
};

const ALERT_TYPE_EMOJI: Record<AlertType, string> = {
  [AlertType.LOW_LEADS]: '⚠️',
  [AlertType.HIGH_BOUNCE]: '🚨',
  [AlertType.HIGH_REPLY]: '✅',
  [AlertType.HIGH_INTERESTED]: '✨',
  [AlertType.LOW_REPLY]: '📉',
  [AlertType.SEQUENCE_ENDING]: '⏰',
  [AlertType.LONG_RUNNING]: '⏳',
  [AlertType.VOLUME_DROP]: '📊'
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function pct(n?: number) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return `${n.toFixed(2)}%`;
}

function leadsStr(metrics?: Partial<CampaignMetrics>) {
  if (!metrics) return 'N/A';
  const r = metrics.leadsRemaining;
  const t = metrics.leadsTotal;
  if (typeof r !== 'number' || typeof t !== 'number') return 'N/A';
  return `${r}/${t}`;
}

function groupByType(alerts: Alert[]): Record<AlertType, Alert[]> {
  const by = {} as Record<AlertType, Alert[]>;
  for (const a of alerts) {
    (by[a.type] = by[a.type] ?? []).push(a);
  }
  return by;
}

/**
 * Build a per-client “daily digest” Slack Block Kit payload.
 * One message per client.
 */
export function buildClientDailyDigestSlackMessage(input: ClientDigestInput): any {
  const generatedAt = input.generatedAt ?? new Date();
  const clientTitle = input.clientName + (input.clientId ? ` (${input.clientId})` : '');

  const activeCampaigns = input.metrics.length;
  const total = input.alerts.length;
  const critical = input.alerts.filter(a => a.severity === 'critical').length;
  const warning = input.alerts.filter(a => a.severity === 'warning').length;
  const successAlerts = input.alerts.filter(a => a.severity === 'success');
  const successCampaigns = new Set(successAlerts.map(a => `${a.campaignId}`)).size;

  const blocks: any[] = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `📊 Daily KPI Digest — ${clientTitle}`
    }
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Generated: *${generatedAt.toLocaleString()}*`
      }
    ]
  });

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Active campaigns*\n${activeCampaigns}` },
      { type: 'mrkdwn', text: `*Alerts total*\n${total}` },
      { type: 'mrkdwn', text: `*Critical*\n${critical}` },
      { type: 'mrkdwn', text: `*Warnings*\n${warning}` },
      { type: 'mrkdwn', text: `*Success campaigns*\n${successCampaigns}` }
    ]
  });

  if (total === 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ No alerts generated. All campaigns are within thresholds.' }
    });
    return { text: `Daily KPI Digest — ${clientTitle}`, blocks };
  }

  const byType = groupByType(input.alerts);

  const typeOrder: AlertType[] = [
    AlertType.LOW_LEADS,
    AlertType.HIGH_BOUNCE,
    AlertType.LOW_REPLY,
    AlertType.HIGH_REPLY,
    AlertType.HIGH_INTERESTED,
    AlertType.SEQUENCE_ENDING,
    AlertType.LONG_RUNNING,
    AlertType.VOLUME_DROP
  ];

  const maxItemsPerType = 10;

  for (const t of typeOrder) {
    const items = byType[t] ?? [];
    if (!items.length) continue;

    // Heuristic sorting per type for readability
    const sorted = [...items].sort((a, b) => {
      const ar = a.metrics?.leadsRemaining ?? Number.POSITIVE_INFINITY;
      const br = b.metrics?.leadsRemaining ?? Number.POSITIVE_INFINITY;

      if (t === AlertType.LOW_LEADS) return ar - br; // lowest leads first
      if (t === AlertType.HIGH_BOUNCE) return (b.metrics?.bounceRate ?? 0) - (a.metrics?.bounceRate ?? 0);
      if (t === AlertType.LOW_REPLY) return (a.metrics?.replyRate ?? 0) - (b.metrics?.replyRate ?? 0);
      if (t === AlertType.HIGH_REPLY) return (b.metrics?.replyRate ?? 0) - (a.metrics?.replyRate ?? 0);
      if (t === AlertType.HIGH_INTERESTED) return (b.metrics?.interestedRate ?? 0) - (a.metrics?.interestedRate ?? 0);
      if (t === AlertType.SEQUENCE_ENDING) return (a.metrics?.sequenceDaysRemaining ?? 9999) - (b.metrics?.sequenceDaysRemaining ?? 9999);
      if (t === AlertType.LONG_RUNNING) return (b.metrics?.campaignDuration ?? 0) - (a.metrics?.campaignDuration ?? 0);
      return 0;
    });

    const shown = sorted.slice(0, maxItemsPerType);
    const hidden = sorted.length - shown.length;

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${ALERT_TYPE_EMOJI[t]} ${ALERT_TYPE_LABEL[t]}* (${sorted.length})`
      }
    });

    const lines = shown
      .map(a => {
        const name = a.campaignName;
        const platform = a.metrics?.platform ? `*${a.metrics.platform}* — ` : '';

        if (t === AlertType.LOW_LEADS) {
          return `• ${platform}${name} — Leads ${leadsStr(a.metrics)}`;
        }
        if (t === AlertType.HIGH_BOUNCE) {
          return `• ${platform}${name} — Bounce ${pct(a.metrics?.bounceRate)} (sent ${a.metrics?.emailsSent ?? 'N/A'})`;
        }
        if (t === AlertType.LOW_REPLY || t === AlertType.HIGH_REPLY) {
          return `• ${platform}${name} — Reply ${pct(a.metrics?.replyRate)} | Bounce ${pct(a.metrics?.bounceRate)} | Sent ${a.metrics?.emailsSent ?? 'N/A'}`;
        }
        if (t === AlertType.HIGH_INTERESTED) {
          return `• ${platform}${name} — Interested ${pct(a.metrics?.interestedRate)} | Replies ${a.metrics?.repliedCount ?? 'N/A'} | Interested ${a.metrics?.interestedCount ?? 'N/A'}`;
        }
        if (t === AlertType.SEQUENCE_ENDING) {
          const d = a.metrics?.sequenceDaysRemaining;
          return `• ${platform}${name} — ${typeof d === 'number' ? `${clamp(d, 0, 9999)} day(s) remaining` : 'Days remaining N/A'}`;
        }
        if (t === AlertType.LONG_RUNNING) {
          const d = a.metrics?.campaignDuration;
          return `• ${platform}${name} — ${typeof d === 'number' ? `${clamp(d, 0, 9999)} day(s) running` : 'Duration N/A'}`;
        }
        return `• ${platform}${name} — ${a.message}`;
      })
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: lines
      }
    });

    if (hidden > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `…and *${hidden}* more` }]
      });
    }
  }

  return {
    text: `Daily KPI Digest — ${clientTitle}`,
    blocks
  };
}
