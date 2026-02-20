import * as dotenv from 'dotenv';
import { getActiveClients } from '../config/clients.config';
import { InstantlyService } from '../services/instantly.service';
import { EmailBisonService } from '../services/emailbison.service';
import { HeyReachService } from '../services/heyreach.service';
import { AsanaService } from '../services/asana.service';
import { SlackService } from '../services/slack.service';
import { KPIAnalyzer } from './kpi.analyzer';
import { AsanaClientDeliverySummary, CampaignMetrics } from '../types';
import {
  buildExternalClientDigestSlackMessage,
  buildInternalOpsDigestSlackMessage
} from '../reports/slack-digest';

dotenv.config();

export class CampaignMonitor {
  private slackService: SlackService;
  private slackInternal?: SlackService;
  private slackExternal?: SlackService;
  private kpiAnalyzer: KPIAnalyzer;
  private slackMode: 'immediate' | 'digest';

  constructor() {
    // Backwards compatible: if only SLACK_WEBHOOK_URL is set, we send everything there.
    // If SLACK_WEBHOOK_URL_INTERNAL / SLACK_WEBHOOK_URL_EXTERNAL are set, digest mode will
    // post different views to different destinations.
    const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new Error('SLACK_WEBHOOK_URL is not set in environment variables');
    }

    this.slackService = new SlackService(webhookUrl);
    this.slackInternal = SlackService.fromEnv('SLACK_WEBHOOK_URL_INTERNAL') ?? undefined;
    this.slackExternal = SlackService.fromEnv('SLACK_WEBHOOK_URL_EXTERNAL') ?? undefined;
    this.kpiAnalyzer = new KPIAnalyzer();
    this.slackMode = (process.env.SLACK_NOTIFICATIONS_MODE?.trim() as any) || 'immediate';
  }

  /**
   * Run monitoring check for all active clients and campaigns
   */
  async runMonitoringCheck(): Promise<void> {
    console.log('\n🔍 Starting campaign monitoring check...\n');
    
    const activeClients = getActiveClients();
    
    if (activeClients.length === 0) {
      console.log('⚠️  No active clients configured. Please add API keys to .env file.');
      return;
    }

    console.log(`📊 Monitoring ${activeClients.length} client(s)...\n`);

    // Fetch Asana delivery summary once (optional) and join into per-client digests.
    // NOTE: requires env vars:
    //  - ASANA_TOKEN
    //  - ASANA_WORKSPACE_GID
    //  - ASANA_PROJECT_GID_GTM_ENGINEER
    //  - ASANA_ACCOUNT_CUSTOM_FIELD_GID
    let asanaByAccount: Record<string, AsanaClientDeliverySummary> = {};
    try {
      const asana = AsanaService.fromEnv();
      const projectGid = process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim();
      const accountFieldGid = process.env.ASANA_ACCOUNT_CUSTOM_FIELD_GID?.trim();
      if (asana && projectGid && accountFieldGid) {
        asanaByAccount = await asana.getClientDeliverySummary({
          projectGid,
          accountCustomFieldGid: accountFieldGid,
          now: new Date()
        });
        console.log(`🗂️  Asana: loaded delivery summary for ${Object.keys(asanaByAccount).length} account(s)`);
      } else {
        const missing: string[] = [];
        if (!process.env.ASANA_TOKEN?.trim()) missing.push('ASANA_TOKEN');
        if (!process.env.ASANA_WORKSPACE_GID?.trim()) missing.push('ASANA_WORKSPACE_GID');
        if (!process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim()) missing.push('ASANA_PROJECT_GID_GTM_ENGINEER');
        if (!process.env.ASANA_ACCOUNT_CUSTOM_FIELD_GID?.trim()) missing.push('ASANA_ACCOUNT_CUSTOM_FIELD_GID');
        console.log(`ℹ️  Asana: not configured (${missing.join(', ') || 'unknown missing'}). Skipping Asana section.`);
      }
    } catch (e: any) {
      console.error('⚠️  Asana fetch failed (continuing without Asana section):', e?.message ?? e);
      asanaByAccount = {};
    }

    const allMetrics: Array<{
      metrics: CampaignMetrics;
      clientName: string;
      clientId: string;
      campaignName: string;
    }> = [];

    // Fetch metrics from all clients and platforms.
    // Each client's platform fetches run in parallel (Promise.all) to cut wall-clock time
    // from (N_platforms × latency) down to max(latency per platform).
    for (const { id: clientId, config } of activeClients) {
      console.log(`\n📌 Processing client: ${config.name} (${clientId})`);

      const platformFetches: Array<Promise<CampaignMetrics[]>> = [];

      // --- Instantly ---
      if (config.platforms.instantly?.enabled) {
        const instantlyApiKey = config.platforms.instantly.apiKey; // capture before async closure
        platformFetches.push((async () => {
          try {
            console.log('  📧 Fetching Instantly campaigns...');
            const instantlyService = new InstantlyService(instantlyApiKey);
            const campaigns = await instantlyService.getCampaigns();
            const isActiveish = (c: any) => {
              const s = String((c as any)?.status ?? '').toLowerCase();
              const n = Number((c as any)?.status);
              if (Number.isFinite(n) && n === 1) return true;
              return ['active', 'running', 'queued', 'in_progress', 'in progress'].some(x => s.includes(x));
            };
            const activeCampaignIds = campaigns.filter(isActiveish).map((c: any) => String((c as any)?.id ?? c?.campaign_id ?? '')).filter(Boolean);
            const metrics = await instantlyService.getAllCampaignMetrics(config.name, { activeCampaignIds });
            console.log(`  ✅ Found ${metrics.length} active Instantly campaign(s)`);
            return metrics;
          } catch (error) {
            console.error(`  ❌ Error fetching Instantly campaigns for ${config.name}:`, error);
            return [];
          }
        })());
      }

      // --- EmailBison ---
      if (config.platforms.emailbison?.enabled) {
        const emailbisonApiKey = config.platforms.emailbison.apiKey; // capture before async closure
        platformFetches.push((async () => {
          try {
            console.log('  📧 Fetching EmailBison campaigns...');
            const emailBisonService = new EmailBisonService(emailbisonApiKey);
            const metrics = await emailBisonService.getAllCampaignMetrics(config.name);

            // Digest mode: enrich interestedRate in parallel (F3).
            // Each getLifetimeEventTotals call is independent — run all at once.
            if (this.slackMode === 'digest') {
              const toEnrich = metrics.filter(m => {
                if (typeof m.interestedRate === 'number' && Number.isFinite(m.interestedRate) && m.interestedRate > 0) return false;
                return Number.isFinite(Number(m.campaignId));
              });
              await Promise.all(
                toEnrich.map(async m => {
                  const id = Number(m.campaignId);
                  try {
                    const totals = await emailBisonService.getLifetimeEventTotals(id);
                    const interested = Number(totals['Interested'] ?? 0);
                    const replied = Number(totals['Replied'] ?? m.repliedCount ?? 0);
                    m.interestedCount = interested;
                    m.interestedRate = replied > 0 ? (interested / replied) * 100 : 0;
                  } catch {
                    // ignore enrichment failures
                  }
                })
              );
            }

            console.log(`  ✅ Found ${metrics.length} active EmailBison campaign(s)`);
            return metrics;
          } catch (error) {
            console.error(`  ❌ Error fetching EmailBison campaigns for ${config.name}:`, error);
            return [];
          }
        })());
      }

      // --- HeyReach ---
      if (config.platforms.heyreach?.enabled) {
        const heyreachApiKey = config.platforms.heyreach.apiKey; // capture before async closure
        platformFetches.push((async () => {
          try {
            console.log('  💼 Fetching HeyReach campaigns...');
            const heyReachService = new HeyReachService(heyreachApiKey);
            const metrics = await heyReachService.getAllCampaignMetrics(config.name);
            console.log(`  ✅ Found ${metrics.length} active HeyReach campaign(s)`);
            return metrics;
          } catch (error) {
            console.error(`  ❌ Error fetching HeyReach campaigns for ${config.name}:`, error);
            return [];
          }
        })());
      }

      // Wait for all platforms in parallel, then collect results.
      const platformResults = await Promise.all(platformFetches);
      for (const platformMetrics of platformResults) {
        for (const metric of platformMetrics) {
          allMetrics.push({
            metrics: metric,
            clientName: config.name,
            clientId,
            campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
          });
        }
      }
    }

    console.log(`\n📊 Total campaigns monitored: ${allMetrics.length}\n`);

    console.log('🔎 Analyzing campaign metrics...\n');

    if (this.slackMode === 'digest') {
      // One Slack message per client
      const byClient: Record<string, { clientId: string; clientName: string; items: typeof allMetrics }> = {};
      for (const row of allMetrics) {
        const k = row.clientId;
        byClient[k] = byClient[k] ?? { clientId: row.clientId, clientName: row.clientName, items: [] as any };
        byClient[k].items.push(row);
      }

      console.log(`🧾 Digest mode enabled. Will post ${Object.keys(byClient).length} digest message(s) (one per client).\n`);

      for (const entry of Object.values(byClient)) {
        const alerts = this.kpiAnalyzer.analyzeMultipleCampaigns(entry.items);
        const summary = this.kpiAnalyzer.getAlertSummary(alerts);
        console.log(`⚡ ${entry.clientName}: ${summary.total} alert(s) (C:${summary.critical} W:${summary.warning} S:${summary.success})`);

        const digestInput = {
          clientId: entry.clientId,
          clientName: entry.clientName,
          metrics: entry.items.map(i => i.metrics),
          alerts,
          generatedAt: new Date(),
          // Asana Account values match client names (sometimes with trailing spaces).
          // We key by the trimmed accountName.
          asana: asanaByAccount[String(entry.clientName ?? '').trim()] ?? undefined
        };

        // Always send internal digest (ops). If an internal webhook is set, use it.
        // Otherwise fall back to the default SLACK_WEBHOOK_URL.
        try {
          const internalPayload = buildInternalOpsDigestSlackMessage(digestInput);
          await (this.slackInternal ?? this.slackService).sendMessage(internalPayload);
          console.log(`✅ Internal ops digest posted to Slack for ${entry.clientName}`);
        } catch (error) {
          console.error(`❌ Error sending internal digest to Slack for ${entry.clientName}:`, error);
        }

        // External snapshot: send if external webhook is configured, otherwise also post to default
        // (so you still see it during rollout).
        try {
          const externalPayload = buildExternalClientDigestSlackMessage(digestInput);
          await (this.slackExternal ?? this.slackService).sendMessage(externalPayload);
          console.log(`✅ External client snapshot posted to Slack for ${entry.clientName}`);
        } catch (error) {
          console.error(`❌ Error sending external snapshot to Slack for ${entry.clientName}:`, error);
        }
      }

      console.log('\n✨ Monitoring check complete!\n');
      return;
    }

    // Default: immediate alerts (existing behavior)
    const alerts = this.kpiAnalyzer.analyzeMultipleCampaigns(allMetrics);

    if (alerts.length === 0) {
      console.log('✅ No alerts generated. All campaigns are performing within thresholds.\n');
      return;
    }

    const summary = this.kpiAnalyzer.getAlertSummary(alerts);
    console.log(`⚡ Generated ${summary.total} alert(s):`);
    console.log(`   🔴 Critical: ${summary.critical}`);
    console.log(`   🟡 Warning: ${summary.warning}`);
    console.log(`   🟢 Success: ${summary.success}\n`);

    console.log('📤 Sending alerts to Slack...\n');
    try {
      await this.slackService.sendBatchAlerts(alerts);
      console.log('✅ All alerts sent successfully!\n');
    } catch (error) {
      console.error('❌ Error sending alerts to Slack:', error);
    }

    console.log('✨ Monitoring check complete!\n');
  }

  /**
   * Send a test alert to verify Slack integration
   */
  async sendTestAlert(): Promise<void> {
    console.log('🧪 Sending test message to Slack...\n');
    try {
      await this.slackService.sendTestMessage();
      console.log('✅ Test message sent successfully!\n');
    } catch (error) {
      console.error('❌ Error sending test message:', error);
      throw error;
    }
  }

  /**
   * Monitor a specific client only
   */
  async monitorClient(clientId: string): Promise<void> {
    console.log(`\n🔍 Monitoring specific client: ${clientId}\n`);

    const activeClients = getActiveClients();
    const target = activeClients.find(c => c.id === clientId);
    if (!target) {
      console.log(`⚠️  Unknown or inactive clientId: ${clientId}`);
      console.log(`Active clients: ${activeClients.map(c => c.id).join(', ') || '(none)'}`);
      return;
    }

    const { config } = target;

    const allMetrics: Array<{
      metrics: CampaignMetrics;
      clientName: string;
      clientId: string;
      campaignName: string;
    }> = [];

    console.log(`📌 Processing client: ${config.name} (${clientId})`);

    // Fetch all platforms in parallel (same pattern as runMonitoringCheck).
    const platformFetches: Array<Promise<CampaignMetrics[]>> = [];

    if (config.platforms.instantly?.enabled) {
      const instantlyApiKey = config.platforms.instantly.apiKey; // capture before async closure
      platformFetches.push((async () => {
        try {
          console.log('  📧 Fetching Instantly campaigns...');
          const instantlyService = new InstantlyService(instantlyApiKey);
          const campaigns = await instantlyService.getCampaigns();
          const isActiveish = (c: any) => {
            const s = String((c as any)?.status ?? '').toLowerCase();
            const n = Number((c as any)?.status);
            if (Number.isFinite(n) && n === 1) return true;
            return ['active', 'running', 'queued', 'in_progress', 'in progress'].some(x => s.includes(x));
          };
          const activeCampaignIds = campaigns.filter(isActiveish).map((c: any) => String((c as any)?.id ?? c?.campaign_id ?? '')).filter(Boolean);
          const metrics = await instantlyService.getAllCampaignMetrics(config.name, { activeCampaignIds });
          console.log(`  ✅ Found ${metrics.length} active Instantly campaign(s)`);
          return metrics;
        } catch (error) {
          console.error(`  ❌ Error fetching Instantly campaigns for ${config.name}:`, error);
          return [];
        }
      })());
    }

    if (config.platforms.emailbison?.enabled) {
      const emailbisonApiKey = config.platforms.emailbison.apiKey; // capture before async closure
      platformFetches.push((async () => {
        try {
          console.log('  📧 Fetching EmailBison campaigns...');
          const emailBisonService = new EmailBisonService(emailbisonApiKey);
          const metrics = await emailBisonService.getAllCampaignMetrics(config.name);

          if (this.slackMode === 'digest') {
            const toEnrich = metrics.filter(m => {
              if (typeof m.interestedRate === 'number' && Number.isFinite(m.interestedRate) && m.interestedRate > 0) return false;
              return Number.isFinite(Number(m.campaignId));
            });
            await Promise.all(
              toEnrich.map(async m => {
                const id = Number(m.campaignId);
                try {
                  const totals = await emailBisonService.getLifetimeEventTotals(id);
                  const interested = Number(totals['Interested'] ?? 0);
                  const replied = Number(totals['Replied'] ?? m.repliedCount ?? 0);
                  m.interestedCount = interested;
                  m.interestedRate = replied > 0 ? (interested / replied) * 100 : 0;
                } catch {
                  // ignore enrichment failures
                }
              })
            );
          }

          console.log(`  ✅ Found ${metrics.length} active EmailBison campaign(s)`);
          return metrics;
        } catch (error) {
          console.error(`  ❌ Error fetching EmailBison campaigns for ${config.name}:`, error);
          return [];
        }
      })());
    }

    if (config.platforms.heyreach?.enabled) {
      const heyreachApiKey = config.platforms.heyreach.apiKey; // capture before async closure
      platformFetches.push((async () => {
        try {
          console.log('  💼 Fetching HeyReach campaigns...');
          const heyReachService = new HeyReachService(heyreachApiKey);
          const metrics = await heyReachService.getAllCampaignMetrics(config.name);
          console.log(`  ✅ Found ${metrics.length} active HeyReach campaign(s)`);
          return metrics;
        } catch (error) {
          console.error(`  ❌ Error fetching HeyReach campaigns for ${config.name}:`, error);
          return [];
        }
      })());
    }

    const platformResults = await Promise.all(platformFetches);
    for (const platformMetrics of platformResults) {
      for (const metric of platformMetrics) {
        allMetrics.push({
          metrics: metric,
          clientName: config.name,
          clientId,
          campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
        });
      }
    }

    console.log(`\n📊 Total campaigns monitored (client=${clientId}): ${allMetrics.length}\n`);

    console.log('🔎 Analyzing campaign metrics...\n');

    const alerts = this.kpiAnalyzer.analyzeMultipleCampaigns(allMetrics);

    if (this.slackMode === 'digest') {
      // Pull Asana summary for this client only (optional)
      let asanaSummary: AsanaClientDeliverySummary | undefined;
      try {
        const asana = AsanaService.fromEnv();
        const projectGid = process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim();
        const accountFieldGid = process.env.ASANA_ACCOUNT_CUSTOM_FIELD_GID?.trim();
        if (asana && projectGid && accountFieldGid) {
          const by = await asana.getClientDeliverySummary({ projectGid, accountCustomFieldGid: accountFieldGid, now: new Date() });
          asanaSummary = by[String(config.name ?? '').trim()];
        }
      } catch {
        // ignore
      }

      const digestInput = {
        clientId,
        clientName: config.name,
        metrics: allMetrics.map(i => i.metrics),
        alerts,
        generatedAt: new Date(),
        asana: asanaSummary
      };

      console.log('📤 Sending digests to Slack...\n');
      try {
        const internalPayload = buildInternalOpsDigestSlackMessage(digestInput);
        await (this.slackInternal ?? this.slackService).sendMessage(internalPayload);
        console.log('✅ Internal ops digest sent successfully!');
      } catch (error) {
        console.error('❌ Error sending internal digest to Slack:', error);
      }

      try {
        const externalPayload = buildExternalClientDigestSlackMessage(digestInput);
        await (this.slackExternal ?? this.slackService).sendMessage(externalPayload);
        console.log('✅ External client snapshot sent successfully!\n');
      } catch (error) {
        console.error('❌ Error sending external snapshot to Slack:', error);
      }
      console.log('✨ Monitoring check complete!\n');
      return;
    }

    if (alerts.length === 0) {
      console.log('✅ No alerts generated. All campaigns are performing within thresholds.\n');
      return;
    }

    const summary = this.kpiAnalyzer.getAlertSummary(alerts);
    console.log(`⚡ Generated ${summary.total} alert(s):`);
    console.log(`   🔴 Critical: ${summary.critical}`);
    console.log(`   🟡 Warning: ${summary.warning}`);
    console.log(`   🟢 Success: ${summary.success}\n`);

    console.log('📤 Sending alerts to Slack...\n');
    try {
      await this.slackService.sendBatchAlerts(alerts);
      console.log('✅ All alerts sent successfully!\n');
    } catch (error) {
      console.error('❌ Error sending alerts to Slack:', error);
    }

    console.log('✨ Monitoring check complete!\n');
  }
}
