import { IncomingWebhook } from '@slack/webhook';
import { Alert, AlertType, CampaignMetrics } from '../types';

export class SlackService {
  private webhook: IncomingWebhook;

  constructor(webhookUrl: string) {
    this.webhook = new IncomingWebhook(webhookUrl);
  }

  private isWebhookConfigured(): boolean {
    // Prevent accidental usage of placeholder webhook from .env.example.
    // Slack often responds 404/no_team for invalid/placeholder URLs.
    // We treat that as “not configured” to keep monitor output clean.
    const url = (this.webhook as any)?.url as string | undefined;
    return !!url && !url.includes('hooks.slack.com/services/YOUR/WEBHOOK/URL');
  }

  /**
   * Send an alert to Slack with formatted message
   */
  async sendAlert(alert: Alert): Promise<void> {
    try {
      if (!this.isWebhookConfigured()) {
        console.log('ℹ️  Slack webhook not configured (placeholder). Skipping Slack send.');
        return;
      }
      const message = this.formatAlertMessage(alert);
      await this.webhook.send(message);
      console.log(`✅ Slack alert sent: ${alert.type} for ${alert.clientName}`);
    } catch (error) {
      console.error('❌ Error sending Slack alert:', error);
      throw error;
    }
  }

  /**
   * Send multiple alerts as a batch
   */
  async sendBatchAlerts(alerts: Alert[]): Promise<void> {
    for (const alert of alerts) {
      await this.sendAlert(alert);
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  /**
   * Send a test message to verify Slack integration
   */
  async sendTestMessage(): Promise<void> {
    try {
      await this.webhook.send({
        text: '🚀 Rudiment Campaign Monitor is online!',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '🚀 Monitor Active',
              emoji: true
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Rudiment Campaign Monitor* is now monitoring your campaigns!\n\nYou will receive alerts for:'
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: '⚠️ *Low leads*\n< 100 remaining'
              },
              {
                type: 'mrkdwn',
                text: '🚨 *High bounce rate*\n> 5%'
              },
              {
                type: 'mrkdwn',
                text: '✅ *High reply rate*\n> 10% (good!)'
              },
              {
                type: 'mrkdwn',
                text: '📉 *Low reply rate*\n< 1%'
              },
              {
                type: 'mrkdwn',
                text: '⏰ *Sequence ending*\n< 3 days left'
              },
              {
                type: 'mrkdwn',
                text: '⏳ *Long running*\n> 30 days'
              }
            ]
          }
        ]
      });
      console.log('✅ Test message sent successfully!');
    } catch (error) {
      console.error('❌ Error sending test message:', error);
      throw error;
    }
  }

  /**
   * Send a generic markdown message via webhook.
   * Useful for posting reports/summaries.
   */
  async sendMarkdown(text: string): Promise<void> {
    if (!this.isWebhookConfigured()) {
      console.log('ℹ️  Slack webhook not configured (placeholder). Skipping Slack send.');
      return;
    }
    await this.webhook.send({ text });
  }

  /**
   * Send an arbitrary Slack webhook payload (e.g. Block Kit messages).
   */
  async sendMessage(payload: any): Promise<void> {
    if (!this.isWebhookConfigured()) {
      console.log('ℹ️  Slack webhook not configured (placeholder). Skipping Slack send.');
      return;
    }
    await this.webhook.send(payload);
  }

  /**
   * Format alert as Slack message with color coding and rich formatting
   */
  private formatAlertMessage(alert: Alert): any {
    const color = this.getAlertColor(alert.severity);
    const emoji = this.getAlertEmoji(alert.type);
    const metrics = alert.metrics;

    return {
      text: `${emoji} ${alert.message}`,
      attachments: [
        {
          color: color,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `${emoji} ${alert.type.toUpperCase().replace('_', ' ')}`,
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Client:*\n${alert.clientName}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Campaign:*\n${alert.campaignName}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Platform:*\n${metrics?.platform || 'N/A'}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Severity:*\n${this.getSeverityLabel(alert.severity)}`
                }
              ]
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Alert:* ${alert.message}`
              }
            },
            ...(metrics ? [this.buildMetricsBlock(metrics, alert.type)] : []),
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `⏰ ${new Date(alert.timestamp).toLocaleString()}`
                }
              ]
            }
          ]
        }
      ]
    };
  }

  /**
   * Build metrics display block based on alert type
   */
  private buildMetricsBlock(metrics: Partial<CampaignMetrics>, alertType: AlertType): any {
    const fields: any[] = [];

    // Show relevant metrics based on alert type
    if (alertType === AlertType.LOW_LEADS) {
      fields.push(
        {
          type: 'mrkdwn',
          text: `*Leads Remaining:*\n${metrics.leadsRemaining}/${metrics.leadsTotal}`
        },
        {
          type: 'mrkdwn',
          text: `*Emails Sent:*\n${metrics.emailsSent}`
        }
      );
    }

    if (alertType === AlertType.HIGH_BOUNCE || alertType === AlertType.LOW_REPLY || alertType === AlertType.HIGH_REPLY) {
      fields.push(
        {
          type: 'mrkdwn',
          text: `*Bounce Rate:*\n${metrics.bounceRate?.toFixed(2)}%`
        },
        {
          type: 'mrkdwn',
          text: `*Reply Rate:*\n${metrics.replyRate?.toFixed(2)}%`
        },
        {
          type: 'mrkdwn',
          text: `*Open Rate:*\n${metrics.openRate?.toFixed(2)}%`
        },
        {
          type: 'mrkdwn',
          text: `*Emails Sent:*\n${metrics.emailsSent}`
        }
      );
    }

    return {
      type: 'section',
      fields: fields
    };
  }

  /**
   * Get color based on severity
   */
  private getAlertColor(severity: 'critical' | 'warning' | 'success'): string {
    switch (severity) {
      case 'critical':
        return '#FF0000'; // Red
      case 'warning':
        return '#FFA500'; // Orange
      case 'success':
        return '#00FF00'; // Green
      default:
        return '#808080'; // Gray
    }
  }

  /**
   * Get emoji based on alert type
   */
  private getAlertEmoji(type: AlertType): string {
    switch (type) {
      case AlertType.LOW_LEADS:
        return '⚠️';
      case AlertType.HIGH_BOUNCE:
        return '🚨';
      case AlertType.HIGH_REPLY:
        return '✅';
      case AlertType.LOW_REPLY:
        return '📉';
      case AlertType.SEQUENCE_ENDING:
        return '⏰';
      case AlertType.LONG_RUNNING:
        return '⏳';
      case AlertType.VOLUME_DROP:
        return '📊';
      default:
        return '🔔';
    }
  }

  /**
   * Get severity label
   */
  private getSeverityLabel(severity: 'critical' | 'warning' | 'success'): string {
    switch (severity) {
      case 'critical':
        return '🔴 Critical';
      case 'warning':
        return '🟡 Warning';
      case 'success':
        return '🟢 Success';
      default:
        return '⚪ Info';
    }
  }
}
