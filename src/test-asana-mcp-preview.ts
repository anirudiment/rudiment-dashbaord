import * as dotenv from 'dotenv';
import { SlackService } from './services/slack.service';

dotenv.config();

type Task = {
  name: string;
  account?: string | null;
  assignee?: string | null;
  completedAt?: string | null;
  dueOn?: string | null;
};

// NOTE: This file is only for “previewing the look” of the Asana digest section.
// It is intentionally hard-coded using the Asana MCP output you approved in Cline.
// The production implementation uses Asana REST API + ASANA_TOKEN.

const COMPLETED_LAST_7_DAYS: Task[] = [
  {
    name: 'RunDifussion: Enterprise enrich contact data and push to Hubspot',
    account: 'RunDiffusion',
    assignee: 'Milan Horňák',
    completedAt: '2026-01-19T14:16:00.321Z'
  },
  {
    name: 'RunDifussion: pull backwards PLG list and enrich and create associations',
    account: 'RunDiffusion',
    assignee: 'Ani Shakhbazyan',
    completedAt: '2026-01-15T11:39:31.522Z'
  },

  {
    name: 'Business Bricks Report - Outbound Report',
    account: 'Business Bricks',
    assignee: 'Ani Shakhbazyan',
    completedAt: '2026-01-16T08:02:08.705Z'
  },
  {
    name: 'Business Bricks – Build & Launch Wholesale Outbound',
    account: 'Business Bricks',
    assignee: 'Ani Shakhbazyan',
    completedAt: '2026-01-14T20:28:16.983Z'
  },
  {
    name: "Business Bricks – Nooks Dialing Direct List Cleanup",
    account: 'Business Bricks',
    assignee: 'Ani Shakhbazyan',
    completedAt: '2026-01-14T14:06:26.162Z'
  },
  {
    name: "Business Bricks: Bulk update all Preston's contacts and Leads to Isaac",
    account: 'Business Bricks',
    assignee: 'Ani Shakhbazyan',
    completedAt: '2026-01-14T08:19:24.826Z'
  },
  {
    name: 'Business Bricks – Closed/Lost Re-Entry Campaign',
    account: 'Business Bricks',
    assignee: 'Milan Horňák',
    completedAt: '2026-01-13T16:40:25.874Z'
  }
];

const PLANNED_THIS_WEEK: Task[] = [
  {
    name: 'Workstream - push volume into closed/lost and Churned',
    account: 'Workstream',
    assignee: 'Milan Horňák',
    dueOn: '2026-01-19'
  },
  {
    name: 'Workstream: Provide descriptions of OS properties',
    account: 'Workstream',
    assignee: 'Ani Shakhbazyan',
    dueOn: '2026-01-20'
  },
  {
    name: 'Confetti - Add More sales roles into the signal campaign',
    account: 'Confetti',
    assignee: 'Milan Horňák',
    dueOn: '2026-01-20'
  },
  {
    name: 'Business Bricks Survey Lead workflow',
    account: 'Business Bricks',
    assignee: 'Ani Shakhbazyan',
    dueOn: '2026-01-23'
  }
];

const CLIENTS_TO_PREVIEW = ['RunDiffusion', 'Business Bricks', 'Confetti', 'Workstream'];

function byAccount(tasks: Task[]) {
  const map: Record<string, Task[]> = {};
  for (const t of tasks) {
    const k = String(t.account ?? '').trim();
    if (!k) continue;
    (map[k] = map[k] ?? []).push(t);
  }
  return map;
}

function fmtInt(n: number) {
  return new Intl.NumberFormat().format(n);
}

async function main() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error('Missing SLACK_WEBHOOK_URL');
  const slack = new SlackService(webhookUrl);

  const completedBy = byAccount(COMPLETED_LAST_7_DAYS);
  const plannedBy = byAccount(PLANNED_THIS_WEEK);

  for (const client of CLIENTS_TO_PREVIEW) {
    const completed = completedBy[client] ?? [];
    const planned = plannedBy[client] ?? [];

    const completedLines = completed.slice(0, 8).map(t => `• ${t.name}${t.assignee ? ` _(by ${t.assignee})_` : ''}`);
    const plannedLines = planned
      .slice(0, 8)
      .map(t => `• ${t.name}${t.dueOn ? ` (due ${t.dueOn})` : ''}${t.assignee ? ` _(by ${t.assignee})_` : ''}`);

    const payload = {
      text: `Asana Delivery Preview — ${client}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🧩 Delivery (Asana) — Preview — ${client}` }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `This is a preview built from the Asana MCP output (not the production Asana API yet).` }]
        },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Completed (last 7 days)*\n${fmtInt(completed.length)}` },
            { type: 'mrkdwn', text: `*Planned (this week)*\n${fmtInt(planned.length)}` }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Completed:*\n${completedLines.length ? completedLines.join('\n') : '—'}\n\n` +
              `*Planned:*\n${plannedLines.length ? plannedLines.join('\n') : '—'}`
          }
        }
      ]
    };

    await slack.sendMessage(payload);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

