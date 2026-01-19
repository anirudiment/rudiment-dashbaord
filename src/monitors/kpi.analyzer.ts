import { Alert, AlertType, CampaignMetrics } from '../types';
import { getThresholdsForClient } from '../config/thresholds.config';
import { randomUUID } from 'crypto';

export class KPIAnalyzer {
  private getMinSampleSize(metrics: CampaignMetrics): number {
    // For windowed metrics (e.g. last 7 days), lower the sample size.
    // Otherwise keep the original “lifetime-ish” thresholds.
    if (metrics.windowDays && metrics.windowDays > 0) {
      return 30;
    }
    return 100;
  }

  /**
   * Analyze campaign metrics and generate alerts
   */
  analyzeMetrics(
    metrics: CampaignMetrics,
    clientName: string,
    campaignName: string
  ): Alert[] {
    const alerts: Alert[] = [];
    const thresholds = getThresholdsForClient(clientName);

    const minSampleForReplyAlerts = this.getMinSampleSize(metrics);
    const minSampleForBounceAlert = metrics.windowDays && metrics.windowDays > 0 ? 30 : 50;

    // 1. Check for low leads
    if (metrics.leadsRemaining < thresholds.lowLeadsThreshold) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.LOW_LEADS,
        severity: metrics.leadsRemaining < 50 ? 'critical' : 'warning',
        message: `⚠️ Low leads alert! Only ${metrics.leadsRemaining} leads remaining (threshold: ${thresholds.lowLeadsThreshold})`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 2. Check for high bounce rate
    if (metrics.bounceRate > thresholds.highBounceRate && metrics.emailsSent >= minSampleForBounceAlert) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.HIGH_BOUNCE,
        severity: 'critical',
        message: `🚨 High bounce rate detected! ${metrics.bounceRate.toFixed(2)}% (threshold: ${thresholds.highBounceRate}%)`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 3. Check for excellent reply rate (positive alert!)
    if (metrics.replyRate > thresholds.excellentReplyRate && metrics.emailsSent >= minSampleForReplyAlerts) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.HIGH_REPLY,
        severity: 'success',
        message: `✅ Excellent performance! Reply rate: ${metrics.replyRate.toFixed(2)}% (target: ${thresholds.excellentReplyRate}%)`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 3b. Check for excellent Interested rate (Interested / Replied)
    // Requires platforms that provide Interested counts (EmailBison/SEND)
    if (
      typeof metrics.interestedRate === 'number' &&
      Number.isFinite(metrics.interestedRate) &&
      metrics.interestedRate > thresholds.excellentInterestedRate &&
      (metrics.repliedCount ?? 0) >= 5
    ) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.HIGH_INTERESTED,
        severity: 'success',
        message: `✅ Excellent Interested rate: ${metrics.interestedRate.toFixed(2)}% (target: ${thresholds.excellentInterestedRate}%)`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 4. Check for low reply rate
    if (metrics.replyRate < thresholds.poorReplyRate && metrics.emailsSent >= minSampleForReplyAlerts) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.LOW_REPLY,
        severity: 'warning',
        message: `📉 Low reply rate: ${metrics.replyRate.toFixed(2)}% (minimum: ${thresholds.poorReplyRate}%)`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 5. Check for sequence ending soon
    if (metrics.sequenceDaysRemaining > 0 && metrics.sequenceDaysRemaining <= thresholds.daysBeforeSequenceEnd) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.SEQUENCE_ENDING,
        severity: 'warning',
        message: `⏰ Sequence ending soon! Only ${metrics.sequenceDaysRemaining} days remaining`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    // 6. Check for long-running campaigns
    if (metrics.campaignDuration > thresholds.longRunningCampaignDays) {
      alerts.push({
        id: randomUUID(),
        campaignId: metrics.campaignId,
        clientName,
        campaignName,
        type: AlertType.LONG_RUNNING,
        severity: 'warning',
        message: `⏳ Long-running campaign: ${metrics.campaignDuration} days (review threshold: ${thresholds.longRunningCampaignDays} days)`,
        metrics,
        timestamp: new Date(),
        sent: false
      });
    }

    return alerts;
  }

  /**
   * Analyze multiple campaigns and return all alerts
   */
  analyzeMultipleCampaigns(
    campaignsMetrics: Array<{ metrics: CampaignMetrics; clientName: string; campaignName: string }>
  ): Alert[] {
    const allAlerts: Alert[] = [];

    for (const { metrics, clientName, campaignName } of campaignsMetrics) {
      const alerts = this.analyzeMetrics(metrics, clientName, campaignName);
      allAlerts.push(...alerts);
    }

    return allAlerts;
  }

  /**
   * Filter alerts by severity
   */
  filterBySeverity(alerts: Alert[], severity: 'critical' | 'warning' | 'success'): Alert[] {
    return alerts.filter(alert => alert.severity === severity);
  }

  /**
   * Get summary of alerts
   */
  getAlertSummary(alerts: Alert[]): {
    total: number;
    critical: number;
    warning: number;
    success: number;
    byType: Record<string, number>;
  } {
    const summary = {
      total: alerts.length,
      critical: 0,
      warning: 0,
      success: 0,
      byType: {} as Record<string, number>
    };

    for (const alert of alerts) {
      summary[alert.severity]++;
      summary.byType[alert.type] = (summary.byType[alert.type] || 0) + 1;
    }

    return summary;
  }
}
