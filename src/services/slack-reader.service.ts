import axios, { AxiosInstance } from 'axios';

/**
 * SlackReaderService
 *
 * Reads messages from Slack channels using the Slack Web API.
 * This is separate from SlackService (which only posts via webhooks).
 *
 * Required env var:
 *   SLACK_BOT_TOKEN — OAuth bot token (xoxb-...) with these scopes:
 *     channels:history  (read public channel messages)
 *     groups:history    (read private channel messages)
 *     channels:read     (list channels)
 *
 * How to get a bot token:
 *   1. Go to https://api.slack.com/apps → Create New App → From scratch
 *   2. Under "OAuth & Permissions" add the scopes above
 *   3. Install to workspace → copy the "Bot User OAuth Token" (xoxb-...)
 *   4. Set SLACK_BOT_TOKEN=xoxb-... in your .env
 */

export interface SlackMessage {
  ts: string;          // Slack timestamp (used as message ID)
  text: string;
  user?: string;       // User ID
  username?: string;   // Display name (if bot or resolved)
  date: string;        // ISO date string (derived from ts)
  thread_ts?: string;  // If this is a thread reply
  subtype?: string;    // e.g. 'bot_message', 'channel_join'
}

export class SlackReaderService {
  private client: AxiosInstance;

  constructor(botToken: string) {
    this.client = axios.create({
      baseURL: 'https://slack.com/api',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  static fromEnv(): SlackReaderService | null {
    const token = process.env.SLACK_BOT_TOKEN?.trim();
    if (!token || token.startsWith('xoxb-YOUR')) return null;
    return new SlackReaderService(token);
  }

  /**
   * Fetch messages from a Slack channel for the past N days.
   * Returns messages sorted oldest → newest, skipping joins/leaves.
   */
  async getChannelMessages(params: {
    channelId: string;
    days?: number;
    limit?: number;
    includeThreadReplies?: boolean;
  }): Promise<SlackMessage[]> {
    const days = params.days ?? 7;
    const oldest = (Date.now() / 1000 - days * 86400).toString();

    const res = await this.client.get('/conversations.history', {
      params: {
        channel: params.channelId,
        oldest,
        limit: params.limit ?? 200,
        inclusive: true,
      },
    });

    if (!res.data.ok) {
      throw new Error(`Slack API error: ${res.data.error ?? 'unknown'}`);
    }

    const rawMessages: any[] = res.data.messages ?? [];

    // Filter out non-message subtypes (joins, leaves, etc.)
    const messages = rawMessages
      .filter((m) => !m.subtype || m.subtype === 'bot_message')
      .map((m): SlackMessage => ({
        ts: m.ts,
        text: m.text ?? '',
        user: m.user,
        username: m.username ?? m.bot_profile?.name,
        date: new Date(parseFloat(m.ts) * 1000).toISOString(),
        thread_ts: m.thread_ts !== m.ts ? m.thread_ts : undefined,
        subtype: m.subtype,
      }))
      .reverse(); // oldest first

    return messages;
  }

  /**
   * Resolve Slack user IDs to display names (batches a users.info call per unique user).
   * Returns a map of userId → displayName.
   */
  async resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const nameMap = new Map<string, string>();

    for (const uid of unique) {
      try {
        const res = await this.client.get('/users.info', { params: { user: uid } });
        if (res.data.ok) {
          const profile = res.data.user?.profile;
          const name = profile?.display_name || profile?.real_name || uid;
          nameMap.set(uid, name);
        }
      } catch {
        // Non-fatal: just use the raw user ID
        nameMap.set(uid, uid);
      }
    }

    return nameMap;
  }

  /**
   * Get messages with resolved user names.
   */
  async getChannelMessagesWithNames(params: {
    channelId: string;
    days?: number;
    limit?: number;
  }): Promise<Array<SlackMessage & { displayName: string }>> {
    const messages = await this.getChannelMessages(params);

    const userIds = messages.map((m) => m.user).filter(Boolean) as string[];
    const nameMap = await this.resolveUserNames(userIds);

    return messages.map((m) => ({
      ...m,
      displayName: m.username ?? (m.user ? nameMap.get(m.user) ?? m.user : 'Unknown'),
    }));
  }

  /**
   * Format messages as a readable text block for including in context.
   */
  formatMessagesAsText(
    messages: Array<SlackMessage & { displayName: string }>,
    days: number
  ): string {
    if (messages.length === 0) {
      return `No Slack messages found in the past ${days} days.`;
    }

    const lines = messages.map((m) => {
      const date = new Date(m.date).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const text = m.text.replace(/<@[A-Z0-9]+>/g, '@user').replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
      return `[${date}] ${m.displayName}: ${text}`;
    });

    return lines.join('\n');
  }
}
