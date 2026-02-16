export type ClientStatus = 'active' | 'paused' | 'stopped';
export type HealthStatus = 'good' | 'review' | 'at_risk' | 'n_a';

export type Channel = 'email' | 'linkedin';

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
 * EMAIL: Campaign health based on leads remaining.
 *
 * Spec (Robert):
 * - Review: leads < 100
 * - Good: leads >= 100
 * - No At Risk
 */
export function computeCampaignHealthEmail(leadsRemaining: number | null | undefined): HealthStatus {
  const n = Number(leadsRemaining);
  if (!Number.isFinite(n)) return 'n_a';
  if (n < 100) return 'review';
  return 'good';
}

/**
 * Backwards compatibility: the old name was used in /api/monitor.
 * Default it to the new Email logic.
 */
export const computeCampaignHealth = computeCampaignHealthEmail;

/**
 * EMAIL: Account health based on reply rate (percent values, 0..100).
 *
 * Spec (Robert):
 * - Good: reply >= 2%
 * - Review: 1% .. 1.9%
 * - At Risk: reply < 1%
 */
export function computeAccountHealthEmail(params: {
  replyRate: number | null | undefined;
}): HealthStatus {
  const reply = Number(params.replyRate);
  if (!Number.isFinite(reply)) return 'n_a';
  if (reply < 1) return 'at_risk';
  if (reply < 2) return 'review';
  return 'good';
}

/**
 * EMAIL: Email health based on bounce rate (percent values, 0..100).
 *
 * Spec (Robert):
 * - Good: 0% .. 1%
 * - Review: 1.1% .. 2%
 * - At Risk: >= 2.1%
 */
export function computeEmailHealth(params: {
  bounceRate: number | null | undefined;
}): HealthStatus {
  const bounce = Number(params.bounceRate);
  if (!Number.isFinite(bounce)) return 'n_a';
  if (bounce <= 1) return 'good';
  if (bounce <= 2) return 'review';
  return 'at_risk';
}

/**
 * Backwards compatibility: old API passed both replyRate and bounceRate.
 * New behavior: account health is reply-rate only.
 */
export function computeAccountHealth(params: {
  replyRate: number | null | undefined;
  bounceRate?: number | null | undefined;
}): HealthStatus {
  return computeAccountHealthEmail({ replyRate: params.replyRate });
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  const order = (s: HealthStatus) => (s === 'at_risk' ? 0 : s === 'review' ? 1 : s === 'good' ? 2 : 3);
  return order(a) <= order(b) ? a : b;
}

/**
 * LINKEDIN: Campaign health considers acceptance rate and reply rate.
 *
 * Spec (Robert):
 * - Good: acceptance >= 30% OR reply >= 20%
 * - Review: acceptance 20..29% OR reply 10..19%
 * - At Risk: acceptance < 20% OR reply < 10%
 *
 * Combine rule (per user guidance): if the two factors disagree, return Review ("average").
 */
export function computeCampaignHealthLinkedIn(params: {
  acceptanceRate: number | null | undefined;
  replyRate: number | null | undefined;
}): HealthStatus {
  const acc = Number(params.acceptanceRate);
  const rep = Number(params.replyRate);
  if (!Number.isFinite(acc) || !Number.isFinite(rep)) return 'n_a';

  const forAcceptance: HealthStatus = acc >= 30 ? 'good' : acc >= 20 ? 'review' : 'at_risk';
  const forReply: HealthStatus = rep >= 20 ? 'good' : rep >= 10 ? 'review' : 'at_risk';

  if (forAcceptance === forReply) return forAcceptance;
  // disagree => average to review
  return 'review';
}

/**
 * LINKEDIN: Account health based on connections sent per week.
 *
 * Spec (Robert):
 * - Good: >= 125
 * - Review: 75..124
 * - At Risk: < 75
 */
export function computeAccountHealthLinkedIn(params: {
  connectionsSentPerWeek: number | null | undefined;
}): HealthStatus {
  const n = Number(params.connectionsSentPerWeek);
  if (!Number.isFinite(n)) return 'n_a';
  if (n < 75) return 'at_risk';
  if (n < 125) return 'review';
  return 'good';
}
