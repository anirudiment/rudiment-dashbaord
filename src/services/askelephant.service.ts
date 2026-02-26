import axios, { AxiosInstance } from 'axios';

/**
 * AskElephant Service
 *
 * Fetches meeting notes, weekly syncs, and action items from AskElephant.
 *
 * NOTE: AskElephant API endpoints below are based on common patterns for
 * meeting intelligence tools. Verify the exact paths in your AskElephant
 * account's API settings or contact AskElephant support for API docs.
 *
 * Required env vars:
 *   ASKELEPHANT_API_KEY  — your AskElephant API key
 *   ASKELEPHANT_BASE_URL — (optional) defaults to https://api.askelephant.com
 */

export interface AskElephantMeeting {
  id: string;
  title: string;
  date: string;           // ISO date string
  duration_minutes?: number;
  participants: string[]; // email or name list
  summary?: string;
  transcript?: string;
  action_items: AskElephantActionItem[];
  tags?: string[];
  recording_url?: string;
}

export interface AskElephantActionItem {
  id: string;
  text: string;
  owner?: string;       // who owns this action item
  owner_type?: 'internal' | 'client' | 'unknown';
  due_date?: string;
  completed?: boolean;
}

export interface AskElephantSyncNote {
  meetingId: string;
  title: string;
  date: string;
  summary: string;
  rudimentActionItems: AskElephantActionItem[];
  clientActionItems: AskElephantActionItem[];
  participants: string[];
  recordingUrl?: string;
}

export class AskElephantService {
  private client: AxiosInstance;

  constructor(
    private apiKey: string,
    baseUrl = 'https://api.askelephant.com'
  ) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 15000,
    });
  }

  static fromEnv(): AskElephantService | null {
    const apiKey = process.env.ASKELEPHANT_API_KEY?.trim();
    if (!apiKey) return null;
    const baseUrl = process.env.ASKELEPHANT_BASE_URL?.trim() || 'https://api.askelephant.com';
    return new AskElephantService(apiKey, baseUrl);
  }

  /**
   * Fetch recent meetings/syncs, optionally filtered by a client tag or keyword.
   * Returns meetings within the last `weeksBack` weeks.
   */
  async getMeetings(params: {
    tag?: string;           // Filter by client tag or keyword
    weeksBack?: number;     // How many weeks to look back (default 2)
    limit?: number;
  }): Promise<AskElephantMeeting[]> {
    const weeksBack = params.weeksBack ?? 2;
    const since = new Date();
    since.setDate(since.getDate() - weeksBack * 7);

    try {
      // NOTE: Adjust the endpoint path to match the actual AskElephant API
      const res = await this.client.get('/v1/meetings', {
        params: {
          since: since.toISOString(),
          limit: params.limit ?? 20,
          ...(params.tag ? { tag: params.tag } : {}),
        },
      });

      const data = res.data?.meetings ?? res.data?.data ?? res.data;
      if (!Array.isArray(data)) return [];
      return data as AskElephantMeeting[];
    } catch (err: any) {
      if (err?.response?.status === 404) {
        // Try alternate endpoint path
        const res = await this.client.get('/meetings', {
          params: {
            since: since.toISOString(),
            limit: params.limit ?? 20,
            ...(params.tag ? { q: params.tag } : {}),
          },
        });
        const data = res.data?.meetings ?? res.data?.data ?? res.data;
        if (!Array.isArray(data)) return [];
        return data as AskElephantMeeting[];
      }
      throw err;
    }
  }

  /**
   * Fetch a single meeting by ID with full transcript and action items.
   */
  async getMeeting(meetingId: string): Promise<AskElephantMeeting | null> {
    try {
      const res = await this.client.get(`/v1/meetings/${meetingId}`);
      return (res.data?.meeting ?? res.data) as AskElephantMeeting;
    } catch {
      return null;
    }
  }

  /**
   * Get structured weekly sync notes for a specific client.
   * Sorts action items into rudiment-owned vs client-owned based on participants.
   *
   * @param clientTag  - keyword/tag to find this client's meetings
   * @param internalDomain - your email domain (e.g. "rudiment.com") to classify owners
   * @param weeksBack  - how many weeks to look back
   */
  async getWeeklySyncNotes(params: {
    clientTag: string;
    internalDomain?: string;
    weeksBack?: number;
  }): Promise<AskElephantSyncNote[]> {
    const internalDomain = params.internalDomain
      ?? process.env.RUDIMENT_EMAIL_DOMAIN
      ?? 'rudiment.com';

    const meetings = await this.getMeetings({
      tag: params.clientTag,
      weeksBack: params.weeksBack ?? 2,
    });

    return meetings.map((m) => {
      const rudimentItems: AskElephantActionItem[] = [];
      const clientItems: AskElephantActionItem[] = [];

      for (const item of m.action_items ?? []) {
        // Classify by owner email domain or explicit owner_type
        if (item.owner_type === 'internal' || item.owner?.includes(internalDomain)) {
          rudimentItems.push({ ...item, owner_type: 'internal' });
        } else if (item.owner_type === 'client' || (item.owner && !item.owner.includes(internalDomain))) {
          clientItems.push({ ...item, owner_type: 'client' });
        } else {
          // Unclassified — put in client items so nothing is dropped
          clientItems.push({ ...item, owner_type: 'unknown' });
        }
      }

      return {
        meetingId: m.id,
        title: m.title,
        date: m.date,
        summary: m.summary ?? '(No summary available)',
        rudimentActionItems: rudimentItems,
        clientActionItems: clientItems,
        participants: m.participants,
        recordingUrl: m.recording_url,
      };
    });
  }

  /**
   * Format sync notes as a readable text block (for including in context).
   */
  formatSyncNotesAsText(notes: AskElephantSyncNote[]): string {
    if (notes.length === 0) return 'No recent sync notes found.';

    return notes.map((note) => {
      const date = new Date(note.date).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });

      const rudimentTasks = note.rudimentActionItems.length > 0
        ? note.rudimentActionItems.map((i) => `  - [Rudiment] ${i.text}${i.due_date ? ` (due ${i.due_date})` : ''}`).join('\n')
        : '  (none)';

      const clientTasks = note.clientActionItems.length > 0
        ? note.clientActionItems.map((i) => `  - [Client] ${i.text}${i.due_date ? ` (due ${i.due_date})` : ''}`).join('\n')
        : '  (none)';

      return [
        `## ${note.title} — ${date}`,
        `Participants: ${note.participants.join(', ')}`,
        '',
        '### Summary',
        note.summary,
        '',
        '### Rudiment Action Items',
        rudimentTasks,
        '',
        '### Client Action Items',
        clientTasks,
        note.recordingUrl ? `\nRecording: ${note.recordingUrl}` : '',
      ].join('\n');
    }).join('\n\n---\n\n');
  }
}
