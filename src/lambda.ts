import { CampaignMonitor } from './monitors/campaign.monitor';
import { validateConfig } from './config/clients.config';

/**
 * AWS Lambda entrypoint.
 *
 * Deploy as a scheduled Lambda (EventBridge). The monitor runs once and exits.
 */
export const handler = async () => {
  const validation = validateConfig();
  if (!validation.valid) {
    console.error('❌ Configuration Error:', validation.errors);
    // Fail the invocation so CloudWatch + alarms can catch it.
    throw new Error(validation.errors.join('; '));
  }

  const monitor = new CampaignMonitor();
  await monitor.runMonitoringCheck();

  return { ok: true, ranAt: new Date().toISOString() };
};

