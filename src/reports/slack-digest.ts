import { Alert, AlertType, AsanaClientDeliverySummary, CampaignMetrics } from '../types';

export type ClientDigestInput = {
  clientName: string;
  clientId?: string;
  metrics: CampaignMetrics[];
  alerts: Alert[];
  generatedAt?: Date;
  /** Optional Asana delivery summary for this client (grouped by Asana Account). */
  asana?: AsanaClientDeliverySummary;
};

export type DigestView = 'internal_ops' | 'external_client';

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

function num(v: unknown) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(v: unknown) {
  return new Intl.NumberFormat().format(Math.round(num(v)));
}

function fmtPct(v: unknown) {
  const n = num(v);
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

function computeRollup(metrics: CampaignMetrics[]) {
  const totals = metrics.reduce(
    (acc, m) => {
      acc.sent += num(m.sentCount ?? m.emailsSent);
      acc.replied += num(m.repliedCount);
      acc.interested += num(m.interestedCount);
      acc.bounced += num(m.bouncedCount);
      acc.leadsTotal += num(m.leadsTotal);
      acc.leadsRemaining += num(m.leadsRemaining);
      return acc;
    },
    { sent: 0, replied: 0, interested: 0, bounced: 0, leadsTotal: 0, leadsRemaining: 0 }
  );

  return {
    totals,
    rates: {
      replyRate: totals.sent > 0 ? (totals.replied / totals.sent) * 100 : 0,
      bounceRate: totals.sent > 0 ? (totals.bounced / totals.sent) * 100 : 0
    }
  };
}

function makeCampaignBreakdownLines(metrics: CampaignMetrics[], view: DigestView) {
  // For “all”, list in a stable order: highest sent first.
  const sorted = [...metrics].sort((a, b) => num(b.sentCount ?? b.emailsSent) - num(a.sentCount ?? a.emailsSent));
  const lines = sorted.map(m => {
    const sent = num(m.sentCount ?? m.emailsSent);
    const opps = num(m.interestedCount);
    const name = m.campaignName ?? m.campaignId;
    const platform = m.platform ? `*${m.platform}* — ` : '';

    if (view === 'external_client') {
      return `• ${platform}${name} — Sent ${fmtInt(sent)} | Reply ${fmtPct(m.replyRate)} | Opps ${fmtInt(opps)}`;
    }

    return `• ${platform}${name} — Leads ${fmtInt(m.leadsTotal)} | Sent ${fmtInt(sent)} | Reply ${fmtPct(m.replyRate)} | Opps ${fmtInt(opps)}`;
  });
  return { sorted, lines };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildAsanaDeliveryBlocks(asana?: AsanaClientDeliverySummary): any[] {
  if (!asana) return [];

  const blocks: any[] = [];

  const completed = asana.completedLast7Days ?? [];
  const planned = asana.plannedThisWeek ?? [];

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*🧩 Delivery (Asana — ${asana.accountName})*` }
  });

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Completed (last 7 days)*\n${fmtInt(completed.length)}` },
      { type: 'mrkdwn', text: `*Planned (this week)*\n${fmtInt(planned.length)}` }
    ]
  });

  const completedLines = completed.slice(0, 8).map(t => `• ${t.name}${t.assigneeName ? ` _(by ${t.assigneeName})_` : ''}`);
  const plannedLines = planned.slice(0, 8).map(t => {
    const due = t.dueOn ? ` (due ${t.dueOn})` : '';
    const who = t.assigneeName ? ` _(by ${t.assigneeName})_` : '';
    return `• ${t.name}${due}${who}`;
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Completed:*\n${completedLines.length ? completedLines.join('\n') : '—'}\n\n` +
        `*Planned:*\n${plannedLines.length ? plannedLines.join('\n') : '—'}`
    }
  });

  return blocks;
}

/**
 * Internal (ops) digest: prioritizes action, then highlights wins, then provides a full breakdown.
 */
export function buildInternalOpsDigestSlackMessage(input: ClientDigestInput): any {
  const generatedAt = input.generatedAt ?? new Date();
  const clientTitle = input.clientName + (input.clientId ? ` (${input.clientId})` : '');

  const rollup = computeRollup(input.metrics);
  const activeCampaigns = input.metrics.length;

  const totalAlerts = input.alerts.length;
  const critical = input.alerts.filter(a => a.severity === 'critical').length;
  const warning = input.alerts.filter(a => a.severity === 'warning').length;
  const successAlerts = input.alerts.filter(a => a.severity === 'success');
  const successCampaigns = new Set(successAlerts.map(a => `${a.campaignId}`)).size;

  const blocks: any[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `🛠️ Ops KPI Digest — ${clientTitle}` }
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated: *${generatedAt.toLocaleString()}*` }]
  });

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Active campaigns*\n${activeCampaigns}` },
      { type: 'mrkdwn', text: `*Reply rate (weighted)*\n${fmtPct(rollup.rates.replyRate)}` },
      { type: 'mrkdwn', text: `*Leads (replies)*\n${fmtInt(rollup.totals.replied)}` },
      { type: 'mrkdwn', text: `*Opps (interested)*\n${fmtInt(rollup.totals.interested)}` },
      { type: 'mrkdwn', text: `*Alerts*\n${fmtInt(totalAlerts)} (C:${fmtInt(critical)} W:${fmtInt(warning)})` },
      { type: 'mrkdwn', text: `*Wins (campaigns)*\n${fmtInt(successCampaigns)}` }
    ]
  });

  // Optional Asana delivery section
  blocks.push(...buildAsanaDeliveryBlocks(input.asana));

  // 1) ACTION REQUIRED
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🚨 Action required / at-risk signals*` } });

  const actionAlerts = input.alerts
    .filter(a => a.severity !== 'success')
    .sort((a, b) => {
      const sev = (s: Alert['severity']) => (s === 'critical' ? 0 : 1);
      const tOrder: Record<string, number> = {
        [AlertType.LOW_LEADS]: 0,
        [AlertType.HIGH_BOUNCE]: 1,
        [AlertType.LOW_REPLY]: 2,
        [AlertType.SEQUENCE_ENDING]: 3,
        [AlertType.LONG_RUNNING]: 4,
        [AlertType.VOLUME_DROP]: 5
      };
      return sev(a.severity) - sev(b.severity) || (tOrder[a.type] ?? 99) - (tOrder[b.type] ?? 99);
    });

  if (actionAlerts.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '✅ No at-risk signals.' } });
  } else {
    const byType = groupByType(actionAlerts);
    const typeOrder: AlertType[] = [
      AlertType.LOW_LEADS,
      AlertType.HIGH_BOUNCE,
      AlertType.LOW_REPLY,
      AlertType.SEQUENCE_ENDING,
      AlertType.LONG_RUNNING,
      AlertType.VOLUME_DROP
    ];

    for (const t of typeOrder) {
      const items = byType[t] ?? [];
      if (!items.length) continue;

      const shown = items.slice(0, 10);
      const hidden = items.length - shown.length;
      const lines = shown
        .map(a => {
          const platform = a.metrics?.platform ? `*${a.metrics.platform}* — ` : '';
          if (t === AlertType.LOW_LEADS) return `• ${platform}${a.campaignName} — Leads ${leadsStr(a.metrics)}`;
          if (t === AlertType.HIGH_BOUNCE) return `• ${platform}${a.campaignName} — Bounce ${fmtPct(a.metrics?.bounceRate)} | Sent ${fmtInt(a.metrics?.emailsSent)}`;
          if (t === AlertType.LOW_REPLY) return `• ${platform}${a.campaignName} — Reply ${fmtPct(a.metrics?.replyRate)} | Sent ${fmtInt(a.metrics?.emailsSent)}`;
          if (t === AlertType.SEQUENCE_ENDING) {
            const d = a.metrics?.sequenceDaysRemaining;
            return `• ${platform}${a.campaignName} — ${typeof d === 'number' ? `${clamp(d, 0, 9999)} day(s) remaining` : 'Days remaining N/A'}`;
          }
          if (t === AlertType.LONG_RUNNING) {
            const d = a.metrics?.campaignDuration;
            return `• ${platform}${a.campaignName} — ${typeof d === 'number' ? `${clamp(d, 0, 9999)} day(s) running` : 'Duration N/A'}`;
          }
          return `• ${platform}${a.campaignName} — ${a.message}`;
        })
        .join('\n');

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${ALERT_TYPE_EMOJI[t]} ${ALERT_TYPE_LABEL[t]}* (${items.length})\n${lines}` }
      });
      if (hidden > 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and *${hidden}* more` }] });
    }
  }

  // 2) WORKING → SCALE
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*✅ Working → scale (successful campaigns)*` } });

  if (successAlerts.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No wins flagged yet (no HIGH_REPLY / HIGH_INTERESTED alerts).' }
    });
  } else {
    const byType = groupByType(successAlerts);
    const successOrder: AlertType[] = [AlertType.HIGH_REPLY, AlertType.HIGH_INTERESTED];
    for (const t of successOrder) {
      const items = byType[t] ?? [];
      if (!items.length) continue;

      const shown = items.slice(0, 10);
      const hidden = items.length - shown.length;
      const lines = shown
        .map(a => {
          const platform = a.metrics?.platform ? `*${a.metrics.platform}* — ` : '';
          if (t === AlertType.HIGH_REPLY) return `• ${platform}${a.campaignName} — Reply ${fmtPct(a.metrics?.replyRate)} | Sent ${fmtInt(a.metrics?.emailsSent)}`;
          if (t === AlertType.HIGH_INTERESTED)
            return `• ${platform}${a.campaignName} — Interested ${fmtPct(a.metrics?.interestedRate)} | Opps ${fmtInt(a.metrics?.interestedCount)}`;
          return `• ${platform}${a.campaignName}`;
        })
        .join('\n');

      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${ALERT_TYPE_EMOJI[t]} ${ALERT_TYPE_LABEL[t]}* (${items.length})\n${lines}` } });
      if (hidden > 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and *${hidden}* more` }] });
    }
  }

  // 3) CAMPAIGN BREAKDOWN
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📋 Campaign breakdown* (sorted by volume)` } });

  const { lines } = makeCampaignBreakdownLines(input.metrics, 'internal_ops');
  if (!lines.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No campaigns found for this client.' } });
  } else {
    const chunks = chunk(lines, 15);
    const maxChunks = 20; // keep below Slack 50 blocks overall
    const shownChunks = chunks.slice(0, maxChunks);
    for (const c of shownChunks) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c.join('\n') } });
    }
    const shownCount = shownChunks.reduce((acc, c) => acc + c.length, 0);
    const hiddenLines = lines.length - shownCount;
    if (hiddenLines > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `…and *${hiddenLines}* more campaigns (truncated for Slack limits)` }]
      });
    }
  }

  return { text: `Ops KPI Digest — ${clientTitle}`, blocks };
}

/**
 * External (client) digest: concise snapshot.
 */
export function buildExternalClientDigestSlackMessage(input: ClientDigestInput): any {
  const generatedAt = input.generatedAt ?? new Date();
  const clientTitle = input.clientName;

  const rollup = computeRollup(input.metrics);
  const activeCampaigns = input.metrics.length;

  const blocks: any[] = [];
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📈 Client KPI Snapshot — ${clientTitle}` }
  });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Generated: *${generatedAt.toLocaleString()}*` }] });
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Active campaigns*\n${activeCampaigns}` },
      { type: 'mrkdwn', text: `*Avg reply rate (weighted)*\n${fmtPct(rollup.rates.replyRate)}` },
      { type: 'mrkdwn', text: `*Leads (replies)*\n${fmtInt(rollup.totals.replied)}` },
      { type: 'mrkdwn', text: `*Opportunities (interested)*\n${fmtInt(rollup.totals.interested)}` }
    ]
  });

  // Optional Asana delivery section (per your request)
  blocks.push(...buildAsanaDeliveryBlocks(input.asana));

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Campaign breakdown*` } });

  const { lines } = makeCampaignBreakdownLines(input.metrics, 'external_client');
  if (!lines.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No active campaigns.' } });
  } else {
    const chunks = chunk(lines, 15);
    const maxChunks = 20;
    const shownChunks = chunks.slice(0, maxChunks);
    for (const c of shownChunks) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c.join('\n') } });
    }
    const shownCount = shownChunks.reduce((acc, c) => acc + c.length, 0);
    const hiddenLines = lines.length - shownCount;
    if (hiddenLines > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and *${hiddenLines}* more campaigns (truncated for Slack limits)` }] });
    }
  }

  return { text: `Client KPI Snapshot — ${clientTitle}`, blocks };
}

/**
 * Backwards-compatible export: the old “daily digest” now maps to Internal Ops digest.
 */
export function buildClientDailyDigestSlackMessage(input: ClientDigestInput): any {
  return buildInternalOpsDigestSlackMessage(input);
}
