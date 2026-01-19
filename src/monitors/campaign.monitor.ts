import * as dotenv from 'dotenv';
import { getActiveClients } from '../config/clients.config';
import { InstantlyService } from '../services/instantly.service';
import { EmailBisonService } from '../services/emailbison.service';
import { HeyReachService } from '../services/heyreach.service';
import { SlackService } from '../services/slack.service';
import { KPIAnalyzer } from './kpi.analyzer';
import { CampaignMetrics } from '../types';
import { buildClientDailyDigestSlackMessage } from '../reports/slack-digest';

dotenv.config();

export class CampaignMonitor {
  private slackService: SlackService;
  private kpiAnalyzer: KPIAnalyzer;
  private slackMode: 'immediate' | 'digest';

  constructor() {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new Error('SLACK_WEBHOOK_URL is not set in environment variables');
    }
    
    this.slackService = new SlackService(webhookUrl);
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

    const allMetrics: Array<{
      metrics: CampaignMetrics;
      clientName: string;
      clientId: string;
      campaignName: string;
    }> = [];

    // Fetch metrics from all clients and platforms
    for (const { id: clientId, config } of activeClients) {
      console.log(`\n📌 Processing client: ${config.name} (${clientId})`);

      // Instantly
      if (config.platforms.instantly?.enabled) {
        try {
          console.log('  📧 Fetching Instantly campaigns...');
          const instantlyService = new InstantlyService(config.platforms.instantly.apiKey);
          // Filter to active-ish campaigns (Active / Running / Queued)
          const campaigns = await instantlyService.getCampaigns();
          const isActiveish = (c: any) => {
            const s = String((c as any)?.status ?? '').toLowerCase();
            const n = Number((c as any)?.status);
            // Observed: numeric 1=Active. Also accept common string statuses.
            if (Number.isFinite(n) && n === 1) return true;
            return ['active', 'running', 'queued', 'in_progress', 'in progress'].some(x => s.includes(x));
          };
          const activeCampaignIds = campaigns.filter(isActiveish).map((c: any) => String((c as any)?.id ?? c?.campaign_id ?? '')).filter(Boolean);
          const metrics = await instantlyService.getAllCampaignMetrics(config.name, { activeCampaignIds });
          
          for (const metric of metrics) {
            allMetrics.push({
              metrics: metric,
              clientName: config.name,
              clientId,
              campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
            });
          }
          console.log(`  ✅ Found ${metrics.length} active Instantly campaign(s)`);
        } catch (error) {
          console.error(`  ❌ Error fetching Instantly campaigns for ${config.name}:`, error);
        }
      }

      // EmailBison
      if (config.platforms.emailbison?.enabled) {
        try {
          console.log('  📧 Fetching EmailBison campaigns...');
          const emailBisonService = new EmailBisonService(config.platforms.emailbison.apiKey);
          const metrics = await emailBisonService.getAllCampaignMetrics(config.name);

          // Digest mode is typically run once/day, so we can afford enrichment calls.
          // But if EmailBison already returned interestedRate, don't override it.
          if (this.slackMode === 'digest') {
            for (const m of metrics) {
              // Only skip enrichment when the API provided a real/non-zero interestedRate.
              // In most cases, EmailBison campaign totals do not include Interested, so we enrich.
              if (typeof m.interestedRate === 'number' && Number.isFinite(m.interestedRate) && m.interestedRate > 0) continue;
              const id = Number(m.campaignId);
              if (!Number.isFinite(id)) continue;
              try {
                const totals = await emailBisonService.getLifetimeEventTotals(id);
                const interested = Number(totals['Interested'] ?? 0);
                const replied = Number(totals['Replied'] ?? m.repliedCount ?? 0);
                m.interestedCount = interested;
                m.interestedRate = replied > 0 ? (interested / replied) * 100 : 0;
              } catch {
                // ignore enrichment failures
              }
            }
          }
          
          for (const metric of metrics) {
            allMetrics.push({
              metrics: metric,
              clientName: config.name,
              clientId,
              campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
            });
          }
          console.log(`  ✅ Found ${metrics.length} active EmailBison campaign(s)`);
        } catch (error) {
          console.error(`  ❌ Error fetching EmailBison campaigns for ${config.name}:`, error);
        }
      }

      // HeyReach
      if (config.platforms.heyreach?.enabled) {
        try {
          console.log('  💼 Fetching HeyReach campaigns...');
          const heyReachService = new HeyReachService(config.platforms.heyreach.apiKey);
          const metrics = await heyReachService.getAllCampaignMetrics(config.name);
          
          for (const metric of metrics) {
            allMetrics.push({
              metrics: metric,
              clientName: config.name,
              clientId,
              campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
            });
          }
          console.log(`  ✅ Found ${metrics.length} active HeyReach campaign(s)`);
        } catch (error) {
          console.error(`  ❌ Error fetching HeyReach campaigns for ${config.name}:`, error);
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

        const payload = buildClientDailyDigestSlackMessage({
          clientId: entry.clientId,
          clientName: entry.clientName,
          metrics: entry.items.map(i => i.metrics),
          alerts,
          generatedAt: new Date()
        });

        try {
          await this.slackService.sendMessage(payload);
          console.log(`✅ Digest posted to Slack for ${entry.clientName}`);
        } catch (error) {
          console.error(`❌ Error sending digest to Slack for ${entry.clientName}:`, error);
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

    // Instantly
    if (config.platforms.instantly?.enabled) {
      try {
        console.log('  📧 Fetching Instantly campaigns...');
        const instantlyService = new InstantlyService(config.platforms.instantly.apiKey);
          const campaigns = await instantlyService.getCampaigns();
          const isActiveish = (c: any) => {
            const s = String((c as any)?.status ?? '').toLowerCase();
            const n = Number((c as any)?.status);
            if (Number.isFinite(n) && n === 1) return true;
            return ['active', 'running', 'queued', 'in_progress', 'in progress'].some(x => s.includes(x));
          };
          const activeCampaignIds = campaigns.filter(isActiveish).map((c: any) => String((c as any)?.id ?? c?.campaign_id ?? '')).filter(Boolean);
          const metrics = await instantlyService.getAllCampaignMetrics(config.name, { activeCampaignIds });

        for (const metric of metrics) {
          allMetrics.push({
            metrics: metric,
            clientName: config.name,
            clientId,
            campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
          });
        }
        console.log(`  ✅ Found ${metrics.length} active Instantly campaign(s)`);
      } catch (error) {
        console.error(`  ❌ Error fetching Instantly campaigns for ${config.name}:`, error);
      }
    }

    // EmailBison
    if (config.platforms.emailbison?.enabled) {
      try {
        console.log('  📧 Fetching EmailBison campaigns...');
        const emailBisonService = new EmailBisonService(config.platforms.emailbison.apiKey);
          const metrics = await emailBisonService.getAllCampaignMetrics(config.name);

          if (this.slackMode === 'digest') {
            for (const m of metrics) {
              if (typeof m.interestedRate === 'number' && Number.isFinite(m.interestedRate) && m.interestedRate > 0) continue;
              const id = Number(m.campaignId);
              if (!Number.isFinite(id)) continue;
              try {
                const totals = await emailBisonService.getLifetimeEventTotals(id);
                const interested = Number(totals['Interested'] ?? 0);
                const replied = Number(totals['Replied'] ?? m.repliedCount ?? 0);
                m.interestedCount = interested;
                m.interestedRate = replied > 0 ? (interested / replied) * 100 : 0;
              } catch {
                // ignore enrichment failures
              }
            }
          }

        for (const metric of metrics) {
          allMetrics.push({
            metrics: metric,
            clientName: config.name,
            clientId,
            campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
          });
        }
        console.log(`  ✅ Found ${metrics.length} active EmailBison campaign(s)`);
      } catch (error) {
        console.error(`  ❌ Error fetching EmailBison campaigns for ${config.name}:`, error);
      }
    }

    // HeyReach
    if (config.platforms.heyreach?.enabled) {
      try {
        console.log('  💼 Fetching HeyReach campaigns...');
        const heyReachService = new HeyReachService(config.platforms.heyreach.apiKey);
        const metrics = await heyReachService.getAllCampaignMetrics(config.name);

        for (const metric of metrics) {
          allMetrics.push({
            metrics: metric,
            clientName: config.name,
            clientId,
            campaignName: metric.campaignName ?? `Campaign ${metric.campaignId}`
          });
        }
        console.log(`  ✅ Found ${metrics.length} active HeyReach campaign(s)`);
      } catch (error) {
        console.error(`  ❌ Error fetching HeyReach campaigns for ${config.name}:`, error);
      }
    }

    console.log(`\n📊 Total campaigns monitored (client=${clientId}): ${allMetrics.length}\n`);

    console.log('🔎 Analyzing campaign metrics...\n');

    const alerts = this.kpiAnalyzer.analyzeMultipleCampaigns(allMetrics);

    if (this.slackMode === 'digest') {
      const payload = buildClientDailyDigestSlackMessage({
        clientId,
        clientName: config.name,
        metrics: allMetrics.map(i => i.metrics),
        alerts,
        generatedAt: new Date()
      });

      console.log('📤 Sending digest to Slack...\n');
      try {
        await this.slackService.sendMessage(payload);
        console.log('✅ Digest sent successfully!\n');
      } catch (error) {
        console.error('❌ Error sending digest to Slack:', error);
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
