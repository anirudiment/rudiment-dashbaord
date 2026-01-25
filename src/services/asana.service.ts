import axios, { AxiosInstance } from 'axios';
import { AsanaClientDeliverySummary } from '../types';

type AsanaTask = {
  gid: string;
  name: string;
  completed?: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  assignee?: { name?: string | null } | null;
  custom_fields?: Array<{ gid: string; name: string; display_value?: string | null }>;
};

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date) {
  // Monday-start week
  const date = new Date(d);
  const day = date.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1 - day);
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfWeek(d: Date) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

function normalizeAccountName(v: unknown) {
  return String(v ?? '').trim();
}

export class AsanaService {
  private client: AxiosInstance;

  constructor(private token: string) {
    this.client = axios.create({
      baseURL: 'https://app.asana.com/api/1.0',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }

  static fromEnv(): AsanaService | null {
    const token = process.env.ASANA_TOKEN?.trim();
    if (!token) return null;
    return new AsanaService(token);
  }

  private async searchTasks(params: Record<string, any>): Promise<AsanaTask[]> {
    const workspace = process.env.ASANA_WORKSPACE_GID?.trim();
    if (!workspace) throw new Error('ASANA_WORKSPACE_GID is required');

    const res = await this.client.get(`/workspaces/${workspace}/tasks/search`, {
      params: {
        limit: 100,
        opt_fields: [
          'gid',
          'name',
          'completed',
          'completed_at',
          'due_on',
          'assignee.name',
          'custom_fields.gid',
          'custom_fields.name',
          'custom_fields.display_value'
        ].join(','),
        ...params
      }
    });

    const data = res.data?.data;
    if (!Array.isArray(data)) return [];
    return data as AsanaTask[];
  }

  /**
   * Returns per-account summaries for:
   * - completed tasks in last 7 days
   * - planned tasks this week (due_on within the current week)
   */
  async getClientDeliverySummary(params: {
    projectGid: string;
    accountCustomFieldGid: string;
    now?: Date;
  }): Promise<Record<string, AsanaClientDeliverySummary>> {
    const now = params.now ?? new Date();

    const completedAfter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = startOfWeek(now);
    const weekEnd = endOfWeek(now);

    // Completed last 7 days
    const completed = await this.searchTasks({
      'projects.any': params.projectGid,
      completed: true,
      'completed_at.after': completedAfter.toISOString()
    });

    // Incomplete tasks that are due this week
    const planned = await this.searchTasks({
      'projects.any': params.projectGid,
      completed: false,
      'due_on.after': fmtDate(weekStart),
      'due_on.before': fmtDate(weekEnd)
    });

    const out: Record<string, AsanaClientDeliverySummary> = {};

    const getAccount = (t: AsanaTask) => {
      const cf = (t.custom_fields ?? []).find(f => String(f.gid) === String(params.accountCustomFieldGid));
      return normalizeAccountName(cf?.display_value ?? cf?.name);
    };

    for (const t of completed) {
      const account = getAccount(t);
      if (!account) continue;
      out[account] = out[account] ?? { accountName: account, completedLast7Days: [], plannedThisWeek: [] };
      out[account].completedLast7Days.push({
        gid: t.gid,
        name: t.name,
        completedAt: t.completed_at ?? undefined,
        assigneeName: t.assignee?.name ?? undefined
      });
    }

    for (const t of planned) {
      const account = getAccount(t);
      if (!account) continue;
      out[account] = out[account] ?? { accountName: account, completedLast7Days: [], plannedThisWeek: [] };
      out[account].plannedThisWeek.push({
        gid: t.gid,
        name: t.name,
        dueOn: t.due_on ?? undefined,
        assigneeName: t.assignee?.name ?? undefined
      });
    }

    // Sort for readability
    for (const s of Object.values(out)) {
      s.completedLast7Days.sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')));
      s.plannedThisWeek.sort((a, b) => String(a.dueOn ?? '').localeCompare(String(b.dueOn ?? '')));
    }

    return out;
  }
}
