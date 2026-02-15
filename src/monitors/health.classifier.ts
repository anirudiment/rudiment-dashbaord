export type ClientStatus = 'active' | 'paused' | 'stopped';
export type HealthStatus = 'good' | 'review' | 'at_risk' | 'n_a';

/**
 * Client-level status derived from campaign statuses.
 */
export function computeClientStatus(campaignStatuses: Array<string | null | undefined>): ClientStatus {
  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
  const statuses = campaignStatuses.map(norm).filter(Boolean);

  const isActive = (s: string) =>
    s === 'active' ||
    s === 'in_progress' ||
    s === 'in progress' ||
    s === 'running' ||
    s === 'queued' ||
    s === '1' || // Instantly numeric active
    s === 'in_progress';

  const isPaused = (s: string) =>
    s === 'paused' ||
    s === 'stop' ||
    s === 'stopped' ||
    s === '2'; // Instantly numeric paused

  const hasActive = statuses.some(isActive);
  if (hasActive) return 'active';

  const hasPaused = statuses.some(isPaused);
  if (hasPaused) return 'paused';

  return 'stopped';
}

/**
 * Campaign health based on leads remaining.
 *
 * Spec:
 * - Good: > 100
 * - Review: 1..100
 * - At Risk: 0
 */
export function computeCampaignHealth(leadsRemaining: number | null | undefined): HealthStatus {
  const n = Number(leadsRemaining ?? 0);
  if (!Number.isFinite(n)) return 'n_a';
  if (n <= 0) return 'at_risk';
  if (n <= 100) return 'review';
  return 'good';
}

/**
 * Account health based on reply rate and bounce rate (percent values, 0..100).
 *
 * Spec:
 * - Good: reply >= 2% AND bounce < 2%
 * - Review: reply 1%..1.9% (and bounce still < 2%)
 * - At Risk: reply < 1% OR bounce >= 2%
 */
export function computeAccountHealth(params: {
  replyRate: number | null | undefined;
  bounceRate: number | null | undefined;
}): HealthStatus {
  const reply = Number(params.replyRate);
  const bounce = Number(params.bounceRate);
  if (!Number.isFinite(reply) || !Number.isFinite(bounce)) return 'n_a';

  if (reply < 1 || bounce >= 2) return 'at_risk';
  if (reply < 2) return 'review';
  // reply >= 2
  if (bounce < 2) return 'good';
  return 'at_risk';
}
