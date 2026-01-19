import { Thresholds } from '../types';

// Configurable KPI Thresholds
// Adjust these values based on your campaign standards and industry benchmarks
export const thresholds: Thresholds = {
  // Alert when leads remaining fall below this number (typical 3-5 day buffer)
  lowLeadsThreshold: 100,

  // Alert when bounce rate exceeds this percentage (industry standard ~5%)
  highBounceRate: 5,

  // Celebrate when reply rate exceeds this percentage (excellent performance)
  excellentReplyRate: 10,

  // Celebrate when Interested rate (Interested / Replied) exceeds this percentage
  // Note: requires platforms that expose Interested counts (EmailBison/SEND)
  excellentInterestedRate: 20,

  // Alert when reply rate falls below this percentage after 100+ emails sent
  poorReplyRate: 1,

  // Alert when sequence ends within this many days
  daysBeforeSequenceEnd: 3,

  // Alert when campaign has been running longer than this (needs review)
  longRunningCampaignDays: 30,

  // Alert when daily send volume drops by this percentage
  volumeDropPercentage: 50
};

// Client-specific thresholds (optional overrides)
export const clientThresholds: Record<string, Partial<Thresholds>> = {
  // Example:
  // 'ClientName': {
  //   lowLeadsThreshold: 200, // Higher buffer for high-volume client
  //   excellentReplyRate: 15  // Higher expectations
  // }
};

export function getThresholdsForClient(clientName: string): Thresholds {
  const overrides = clientThresholds[clientName] || {};
  return { ...thresholds, ...overrides };
}
