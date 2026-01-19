#!/usr/bin/env node
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { SlackService } from './services/slack.service';

dotenv.config();

function getArg(args: string[], key: string) {
  const eq = args.find(a => a.startsWith(`${key}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = args.findIndex(a => a === key);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

type ParsedReport = {
  title: string;
  summary: Record<string, string>;
  campaigns: Array<{ platform: string; campaign: string; leads: string; sent: string; replies: string; bounceRate: string; replyRate: string; interestedRate?: string; interested?: string }>;
};

function parseReportMarkdown(md: string): ParsedReport {
  const lines = md.split(/\r?\n/);
  const title = (lines.find(l => l.startsWith('# ')) ?? '# Campaign Overview').replace(/^#\s+/, '').trim();

  const summary: Record<string, string> = {};
  const summaryStart = lines.findIndex(l => l.trim() === '## Summary');
  if (summaryStart >= 0) {
    for (let i = summaryStart + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('## ')) break;
      const m = line.match(/^-\s+(.+?):\s+\*\*(.+)\*\*/);
      if (m) summary[m[1]] = m[2];
    }
  }

  const campaigns: ParsedReport['campaigns'] = [];
  const campaignsStart = lines.findIndex(l => l.trim() === '## Campaigns');
  if (campaignsStart >= 0) {
    // Find the table header separator and then parse rows
    let i = campaignsStart + 1;
    while (i < lines.length && !lines[i].startsWith('| Platform')) i++;
    // skip header + separator
    i += 2;
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('|')) break;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // New table has 10 cells (Interested rate). Old had 9.
      if (cells.length < 9) continue;
      const hasInterestedRate = cells.length >= 10;
      campaigns.push({
        platform: cells[0],
        campaign: cells[1],
        leads: cells[2],
        sent: cells[3],
        replies: cells[4],
        interested: hasInterestedRate ? cells[5] : undefined,
        interestedRate: hasInterestedRate ? cells[6] : undefined,
        replyRate: hasInterestedRate ? cells[8] : cells[7],
        bounceRate: hasInterestedRate ? cells[9] : cells[8]
      });
    }
  }

  return { title, summary, campaigns };
}

async function main() {
  const args = process.argv.slice(2);
  const clientId = getArg(args, '--client');
  const mention = getArg(args, '--mention') ?? '@ani shakhbazyan';

  if (!clientId) {
    console.error('Missing --client. Example: tsx src/report-to-slack.ts --client=client2');
    process.exit(1);
  }

  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) {
    console.error('Missing SLACK_WEBHOOK_URL in env');
    process.exit(2);
  }

  const reportPath = path.resolve(process.cwd(), 'reports', `${clientId}-overview.md`);
  if (!fs.existsSync(reportPath)) {
    console.error(`Report not found: ${reportPath}`);
    console.error('Generate it first with: npm run report:client -- --client=' + clientId);
    process.exit(3);
  }

  const md = fs.readFileSync(reportPath, 'utf-8');
  const parsed = parseReportMarkdown(md);
  const svc = new SlackService(webhook);

  const fields = [
    parsed.summary['Campaigns monitored'] ? { type: 'mrkdwn', text: `*Campaigns*\n${parsed.summary['Campaigns monitored']}` } : null,
    parsed.summary['Leads remaining (sum)'] ? { type: 'mrkdwn', text: `*Leads remaining*\n${parsed.summary['Leads remaining (sum)']}` } : null,
    parsed.summary['Sent (sum)'] ? { type: 'mrkdwn', text: `*Sent*\n${parsed.summary['Sent (sum)']}` } : null,
    parsed.summary['Replies (sum)'] ? { type: 'mrkdwn', text: `*Replies*\n${parsed.summary['Replies (sum)']}` } : null,
    parsed.summary['Reply rate (overall)'] ? { type: 'mrkdwn', text: `*Reply rate*\n${parsed.summary['Reply rate (overall)']}` } : null,
    parsed.summary['Bounce rate (overall)'] ? { type: 'mrkdwn', text: `*Bounce rate*\n${parsed.summary['Bounce rate (overall)']}` } : null
  ].filter(Boolean) as any[];

  const top = parsed.campaigns.slice(0, 6);
  const topLines = top
    .map(c => {
      const ir = c.interestedRate ? ` | Interested ${c.interestedRate}` : '';
      return `• *${c.platform}* — ${c.campaign} | Leads ${c.leads} | Reply ${c.replyRate}${ir} | Bounce ${c.bounceRate}`;
    })
    .join('\n');

  // Post as native Block Kit for better readability (instead of dumping markdown).
  await svc.sendMarkdown(mention);
  await svc.sendMessage({
    text: `${parsed.title} (${clientId})`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📌 ${parsed.title}`
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Client: *${clientId}*` }]
      },
      {
        type: 'section',
        fields
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Top campaigns (lowest leads remaining first)*\n${topLines || 'No campaigns found.'}`
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Full report saved in repo: \`reports/${clientId}-overview.md\`` }]
      }
    ]
  });

  console.log('✅ Report posted to Slack');
}

main().catch(err => {
  console.error('Failed to post report to Slack:', err);
  process.exit(1);
});
