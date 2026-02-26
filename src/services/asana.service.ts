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
   * Get open tasks for a specific client by project GID.
   * Returns incomplete tasks + optionally tasks completed in the last N days.
   */
  async getTasksByProject(params: {
    projectGid: string;
    includeCompleted?: boolean;
    completedDaysBack?: number;
  }): Promise<{ open: AsanaTask[]; recentlyCompleted: AsanaTask[] }> {
    const open = await this.searchTasks({
      'projects.any': params.projectGid,
      completed: false,
    });

    let recentlyCompleted: AsanaTask[] = [];
    if (params.includeCompleted !== false) {
      const daysBack = params.completedDaysBack ?? 7;
      const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      recentlyCompleted = await this.searchTasks({
        'projects.any': params.projectGid,
        completed: true,
        'completed_at.after': since.toISOString(),
      });
    }

    return { open, recentlyCompleted };
  }

  /**
   * Create a new task in Asana.
   *
   * @returns The created task GID and URL.
   */
  async createTask(params: {
    name: string;
    projectGid: string;
    notes?: string;
    dueOn?: string;           // YYYY-MM-DD
    assigneeGid?: string;     // Asana user GID
    assigneeEmail?: string;   // Alternative to GID — Asana resolves by email
    customFields?: Record<string, string>; // GID → value
  }): Promise<{ gid: string; url: string; name: string }> {
    const workspace = process.env.ASANA_WORKSPACE_GID?.trim();
    if (!workspace) throw new Error('ASANA_WORKSPACE_GID is required');

    const body: Record<string, any> = {
      data: {
        name: params.name,
        projects: [params.projectGid],
        workspace,
        ...(params.notes ? { notes: params.notes } : {}),
        ...(params.dueOn ? { due_on: params.dueOn } : {}),
        ...(params.assigneeGid ? { assignee: params.assigneeGid } : {}),
        ...(params.assigneeEmail ? { assignee: params.assigneeEmail } : {}),
        ...(params.customFields ? { custom_fields: params.customFields } : {}),
      },
    };

    const res = await this.client.post('/tasks', body);
    const task = res.data?.data;

    return {
      gid: task.gid,
      name: task.name,
      url: `https://app.asana.com/0/${params.projectGid}/${task.gid}`,
    };
  }

  /**
   * Format tasks as a readable text block for including in context.
   */
  static formatTasksAsText(open: AsanaTask[], recentlyCompleted: AsanaTask[]): string {
    const fmt = (t: AsanaTask) => {
      const parts = [`- ${t.name}`];
      if (t.due_on) parts.push(`(due ${t.due_on})`);
      if (t.assignee?.name) parts.push(`→ ${t.assignee.name}`);
      return parts.join(' ');
    };

    const lines: string[] = [];

    if (open.length > 0) {
      lines.push('### Open Tasks');
      lines.push(...open.map(fmt));
    } else {
      lines.push('### Open Tasks\n(none)');
    }

    if (recentlyCompleted.length > 0) {
      lines.push('\n### Recently Completed');
      lines.push(...recentlyCompleted.map(fmt));
    }

    return lines.join('\n') || 'No tasks found.';
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
