/**
 * Rudiment Client Context MCP Server
 *
 * Implements the Model Context Protocol (MCP) over stdio using JSON-RPC 2.0.
 * Exposes tools for gathering client context from:
 *   - ICP profile files (src/data/icp/)
 *   - Client website (web check)
 *   - Slack channel messages (last 7 days)
 *   - AskElephant weekly sync notes
 *   - Asana tasks (open + recently completed)
 *
 * And action tools:
 *   - Create Asana tasks
 *   - Post to Slack (internal or external channel)
 *
 * Usage (stdio transport):
 *   npx tsx src/mcp-server.ts
 *
 * VS Code / Claude Code config (~/.claude/claude_desktop_config.json or .mcp.json):
 *   {
 *     "mcpServers": {
 *       "rudiment-context": {
 *         "command": "npx",
 *         "args": ["tsx", "/absolute/path/to/src/mcp-server.ts"],
 *         "env": { "NODE_ENV": "production" }
 *       }
 *     }
 *   }
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { findMcpClient, listMcpClients } from './config/mcp-clients.config';
import { AskElephantService } from './services/askelephant.service';
import { AsanaService } from './services/asana.service';
import { IcpService } from './services/icp.service';
import { SlackReaderService } from './services/slack-reader.service';
import { IncomingWebhook } from '@slack/webhook';

// ─── MCP Protocol Helpers ────────────────────────────────────────────────────

function sendResponse(id: string | number | null, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendError(id: string | number | null, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function textContent(text: string) {
  return { content: [{ type: 'text', text }] };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_clients',
    description: 'List all configured Rudiment clients with their IDs, names, and whether an ICP profile exists.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_icp_profile',
    description:
      'Read the ICP (Ideal Customer Profile) markdown file for a client. ' +
      'Contains company overview, target ICP, key contacts, goals, and history.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID (e.g. "RunDiffusion" or "client1")' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'check_client_website',
    description:
      'Fetch the client\'s website and return a text snapshot of the homepage content. ' +
      'Useful for getting current messaging, product positioning, or recent updates.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        url: { type: 'string', description: 'Optional: override website URL' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_slack_messages',
    description:
      'Fetch the last N days of messages from the client\'s internal Slack channel. ' +
      'Returns messages with timestamps and sender names.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        days: { type: 'number', description: 'Number of days to look back (default 7)' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_askelephant_notes',
    description:
      'Fetch recent weekly sync notes from AskElephant for a client. ' +
      'Returns meeting summaries with action items split into Rudiment-owned and client-owned.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        weeks_back: { type: 'number', description: 'How many weeks to look back (default 2)' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_asana_tasks',
    description:
      'Get Asana tasks for a client project: open tasks and recently completed tasks. ' +
      'Useful for understanding current workload and recent deliverables.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        include_completed: { type: 'boolean', description: 'Include recently completed tasks (default true)' },
        completed_days_back: { type: 'number', description: 'How far back to look for completed tasks (default 7)' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'create_asana_task',
    description:
      'Create a new task in the client\'s Asana project. ' +
      'Use this for Rudiment action items identified from calls or client requests.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        task_name: { type: 'string', description: 'Task title/name' },
        notes: { type: 'string', description: 'Optional task description or notes' },
        due_on: { type: 'string', description: 'Optional due date in YYYY-MM-DD format' },
        assignee_email: { type: 'string', description: 'Optional assignee email address' },
      },
      required: ['client_name', 'task_name'],
    },
  },
  {
    name: 'post_to_slack',
    description:
      'Post a message to a client\'s Slack channel. ' +
      'Use "internal" for the team-only channel, "external" for the shared client channel.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        message: { type: 'string', description: 'Message text to post (supports Slack markdown)' },
        channel: {
          type: 'string',
          enum: ['internal', 'external'],
          description: 'Which Slack channel to post to (default: internal)',
        },
      },
      required: ['client_name', 'message'],
    },
  },
  {
    name: 'get_client_context',
    description:
      'Aggregate ALL context for a client into a single report: ' +
      'ICP profile, Slack messages (7 days), AskElephant sync notes (2 weeks), and Asana tasks. ' +
      'Use this as the starting point before any client call or to brief the team.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client name or ID' },
        skip_website: { type: 'boolean', description: 'Skip website check (faster, default false)' },
      },
      required: ['client_name'],
    },
  },
];

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case 'list_clients': {
      const clients = listMcpClients();
      const rows = clients.map(({ id, config }) => {
        const icpFiles = IcpService.listIcpFiles();
        const hasIcp = config.icpFile ? icpFiles.includes(config.icpFile) : false;
        const hasSlack = !!config.slackChannelId;
        const hasAsana = !!(config.asanaProjectGid || process.env.ASANA_PROJECT_GID_GTM_ENGINEER);
        return `- **${config.name}** (${id}) | ICP: ${hasIcp ? '✓' : '✗'} | Slack: ${hasSlack ? '✓' : '✗'} | Asana: ${hasAsana ? '✓' : '✗'} | Website: ${config.website ?? '(not set)'}`;
      });
      return `## Configured Clients\n\n${rows.join('\n')}`;
    }

    case 'get_icp_profile': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}". Use list_clients to see available clients.`;

      const { config } = match;
      if (!config.icpFile) return `No ICP file configured for ${config.name}. Add an icpFile to mcp-clients.config.ts.`;

      const profile = IcpService.readIcpProfile(config.icpFile, config.name);
      if (!profile) {
        return (
          `ICP file "${config.icpFile}" not found at src/data/icp/.\n` +
          `Copy src/data/icp/_template.md → src/data/icp/${config.icpFile} and fill it in.`
        );
      }

      const age = Math.round((Date.now() - profile.lastModified.getTime()) / (1000 * 60 * 60 * 24));
      return `# ICP: ${profile.clientName}\n_Last updated ${age} day(s) ago_\n\n${profile.content}`;
    }

    case 'check_client_website': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const url = args.url ?? match.config.website;
      if (!url) return `No website configured for ${match.config.name}. Pass a url argument or set it in mcp-clients.config.ts.`;

      try {
        const result = await IcpService.checkWebsite(url);
        return (
          `# Website Snapshot: ${result.url}\n` +
          `_Fetched at ${new Date(result.fetchedAt).toLocaleString()}_\n\n` +
          (result.title ? `**Title:** ${result.title}\n` : '') +
          (result.description ? `**Description:** ${result.description}\n\n` : '') +
          result.text
        );
      } catch (err: any) {
        return `Failed to fetch website: ${err.message}`;
      }
    }

    case 'get_slack_messages': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const slackReader = SlackReaderService.fromEnv();
      if (!slackReader) return 'SLACK_BOT_TOKEN is not configured. Add it to .env (xoxb-... token with channels:history scope).';

      const channelId = match.config.slackChannelId;
      if (!channelId) return `No Slack channel ID configured for ${match.config.name}. Set CLIENT${match.id.replace('client', '')}_SLACK_CHANNEL_ID in .env.`;

      const days = typeof args.days === 'number' ? args.days : 7;

      try {
        const messages = await slackReader.getChannelMessagesWithNames({ channelId, days });
        const text = slackReader.formatMessagesAsText(messages, days);
        return `# Slack Messages: ${match.config.name} (last ${days} days)\n\n${text}`;
      } catch (err: any) {
        return `Failed to fetch Slack messages: ${err.message}`;
      }
    }

    case 'get_askelephant_notes': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const ae = AskElephantService.fromEnv();
      if (!ae) return 'ASKELEPHANT_API_KEY is not configured. Add it to .env.';

      const tag = match.config.askelephantTag ?? match.config.name;
      const weeksBack = typeof args.weeks_back === 'number' ? args.weeks_back : 2;

      try {
        const notes = await ae.getWeeklySyncNotes({ clientTag: tag, weeksBack });
        return `# AskElephant Sync Notes: ${match.config.name} (last ${weeksBack} weeks)\n\n${ae.formatSyncNotesAsText(notes)}`;
      } catch (err: any) {
        return `Failed to fetch AskElephant notes: ${err.message}`;
      }
    }

    case 'get_asana_tasks': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const asana = AsanaService.fromEnv();
      if (!asana) return 'ASANA_TOKEN is not configured. Add it to .env.';

      const projectGid = match.config.asanaProjectGid ?? process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim();
      if (!projectGid) return `No Asana project GID for ${match.config.name}. Set CLIENT${match.id.replace('client', '')}_ASANA_PROJECT_GID in .env.`;

      const includeCompleted = args.include_completed !== false;
      const completedDaysBack = typeof args.completed_days_back === 'number' ? args.completed_days_back : 7;

      try {
        const { open, recentlyCompleted } = await asana.getTasksByProject({ projectGid, includeCompleted, completedDaysBack });
        const text = AsanaService.formatTasksAsText(open, recentlyCompleted);
        return `# Asana Tasks: ${match.config.name}\n\n${text}`;
      } catch (err: any) {
        return `Failed to fetch Asana tasks: ${err.message}`;
      }
    }

    case 'create_asana_task': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const asana = AsanaService.fromEnv();
      if (!asana) return 'ASANA_TOKEN is not configured. Add it to .env.';

      const projectGid = match.config.asanaProjectGid ?? process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim();
      if (!projectGid) return `No Asana project GID for ${match.config.name}. Set CLIENT${match.id.replace('client', '')}_ASANA_PROJECT_GID in .env.`;

      if (!args.task_name) return 'task_name is required.';

      try {
        const task = await asana.createTask({
          name: args.task_name,
          projectGid,
          notes: args.notes,
          dueOn: args.due_on,
          assigneeGid: match.config.asanaDefaultAssigneeGid,
          assigneeEmail: args.assignee_email,
        });
        return `✅ Task created in Asana\n\n**Name:** ${task.name}\n**GID:** ${task.gid}\n**URL:** ${task.url}`;
      } catch (err: any) {
        return `Failed to create Asana task: ${err.message}`;
      }
    }

    case 'post_to_slack': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}"`;

      const channel: 'internal' | 'external' = args.channel ?? 'internal';
      const envKey = channel === 'external'
        ? match.config.slackExternalWebhookEnvKey
        : match.config.slackInternalWebhookEnvKey;

      // Fall back to global webhook
      const webhookUrl = (envKey ? process.env[envKey] : undefined)
        ?? process.env.SLACK_WEBHOOK_URL;

      if (!webhookUrl) {
        return `No Slack webhook configured for ${match.config.name} (${channel}). Set ${envKey ?? 'SLACK_WEBHOOK_URL'} in .env.`;
      }

      try {
        const webhook = new IncomingWebhook(webhookUrl);
        await webhook.send({ text: args.message });
        return `✅ Message posted to ${match.config.name} ${channel} Slack channel.`;
      } catch (err: any) {
        return `Failed to post to Slack: ${err.message}`;
      }
    }

    case 'get_client_context': {
      const match = findMcpClient(args.client_name);
      if (!match) return `Client not found: "${args.client_name}". Use list_clients to see available clients.`;

      const { config, id } = match;
      const parts: string[] = [`# Client Context: ${config.name}`, `_Generated at ${new Date().toLocaleString()}_`, ''];

      // ── ICP Profile ──
      if (config.icpFile) {
        const icp = IcpService.readIcpProfile(config.icpFile, config.name);
        if (icp) {
          const age = Math.round((Date.now() - icp.lastModified.getTime()) / (1000 * 60 * 60 * 24));
          parts.push(`## ICP Profile _(updated ${age}d ago)_`);
          parts.push(icp.content);
          parts.push('');
        } else {
          parts.push(`## ICP Profile\n_(file not found: ${config.icpFile})_\n`);
        }
      }

      // ── Website ──
      if (!args.skip_website && config.website) {
        try {
          const web = await IcpService.checkWebsite(config.website);
          parts.push(
            `## Website Snapshot`,
            `_${web.url} — ${new Date(web.fetchedAt).toLocaleString()}_`,
            web.title ? `**${web.title}**` : '',
            web.description ?? '',
            '',
            web.text.slice(0, 1500),
            '',
          );
        } catch {
          parts.push(`## Website\n_(fetch failed for ${config.website})_\n`);
        }
      }

      // ── Slack Messages ──
      const slackReader = SlackReaderService.fromEnv();
      if (slackReader && config.slackChannelId) {
        try {
          const messages = await slackReader.getChannelMessagesWithNames({
            channelId: config.slackChannelId,
            days: 7,
          });
          parts.push(`## Slack Messages (last 7 days)`);
          parts.push(slackReader.formatMessagesAsText(messages, 7));
          parts.push('');
        } catch (err: any) {
          parts.push(`## Slack Messages\n_(failed: ${err.message})_\n`);
        }
      } else if (!slackReader) {
        parts.push(`## Slack Messages\n_(SLACK_BOT_TOKEN not configured)_\n`);
      } else {
        parts.push(`## Slack Messages\n_(no channel ID configured for ${config.name})_\n`);
      }

      // ── AskElephant Notes ──
      const ae = AskElephantService.fromEnv();
      if (ae) {
        try {
          const tag = config.askelephantTag ?? config.name;
          const notes = await ae.getWeeklySyncNotes({ clientTag: tag, weeksBack: 2 });
          parts.push(`## AskElephant Sync Notes (last 2 weeks)`);
          parts.push(ae.formatSyncNotesAsText(notes));
          parts.push('');
        } catch (err: any) {
          parts.push(`## AskElephant Notes\n_(failed: ${err.message})_\n`);
        }
      } else {
        parts.push(`## AskElephant Notes\n_(ASKELEPHANT_API_KEY not configured)_\n`);
      }

      // ── Asana Tasks ──
      const asana = AsanaService.fromEnv();
      const projectGid = config.asanaProjectGid ?? process.env.ASANA_PROJECT_GID_GTM_ENGINEER?.trim();
      if (asana && projectGid) {
        try {
          const { open, recentlyCompleted } = await asana.getTasksByProject({
            projectGid,
            includeCompleted: true,
            completedDaysBack: 7,
          });
          parts.push(`## Asana Tasks`);
          parts.push(AsanaService.formatTasksAsText(open, recentlyCompleted));
          parts.push('');
        } catch (err: any) {
          parts.push(`## Asana Tasks\n_(failed: ${err.message})_\n`);
        }
      } else if (!asana) {
        parts.push(`## Asana Tasks\n_(ASANA_TOKEN not configured)_\n`);
      } else {
        parts.push(`## Asana Tasks\n_(no project GID configured for ${config.name})_\n`);
      }

      return parts.join('\n');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Stdio Transport ──────────────────────────────────────────────────────────

let readBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  readBuffer += chunk;

  while (true) {
    // Look for Content-Length header
    const headerEnd = readBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerSection = readBuffer.slice(0, headerEnd);
    const lengthMatch = headerSection.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      // Malformed — try to discard up to next potential header
      readBuffer = readBuffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + 4;

    if (readBuffer.length < bodyStart + contentLength) break; // Need more data

    const body = readBuffer.slice(bodyStart, bodyStart + contentLength);
    readBuffer = readBuffer.slice(bodyStart + contentLength);

    let request: any;
    try {
      request = JSON.parse(body);
    } catch {
      sendError(null, -32700, 'Parse error');
      continue;
    }

    const { id, method, params } = request;

    try {
      if (method === 'initialize') {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'rudiment-context', version: '1.0.0' },
        });
      } else if (method === 'tools/list') {
        sendResponse(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const toolName: string = params?.name;
        const toolArgs: Record<string, any> = params?.arguments ?? {};
        const result = await handleTool(toolName, toolArgs);
        sendResponse(id, textContent(result));
      } else if (method === 'notifications/initialized') {
        // No response needed for notifications
      } else {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err: any) {
      sendError(id, -32603, err?.message ?? 'Internal error');
    }
  }
});

process.stdin.on('end', () => process.exit(0));

// Log to stderr (stdout is reserved for MCP protocol)
process.stderr.write('[rudiment-context MCP server started]\n');
