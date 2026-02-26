/**
 * MCP Client Context Configuration
 *
 * Extends the base clients.config.ts with per-client settings needed for
 * context gathering: ICP profiles, Slack channels, Asana projects,
 * AskElephant filters, and website URLs.
 *
 * How to fill this in:
 * 1. Set slackChannelId  → copy from Slack: right-click channel → View channel details → Channel ID at bottom
 * 2. Set asanaProjectGid → Asana URL: app.asana.com/0/<PROJECT_GID>/...
 * 3. Set website         → client's main website (used for web check)
 * 4. Set icpFile         → filename inside src/data/icp/ (create one per client)
 * 5. Set askelephantTag  → tag or keyword AskElephant uses to identify this client's calls
 */

export interface McpClientConfig {
  /** Display name — must match the name in clients.config.ts */
  name: string;
  /** Client's main website URL for web check */
  website?: string;
  /** ICP markdown filename inside src/data/icp/ (e.g. "rundiffusion.md") */
  icpFile?: string;
  /** Slack channel ID for reading messages (C0XXXXXXXX format) */
  slackChannelId?: string;
  /** Per-client Asana project GID (overrides ASANA_PROJECT_GID_GTM_ENGINEER) */
  asanaProjectGid?: string;
  /** Assignee GID to use when creating Asana tasks for this client (optional) */
  asanaDefaultAssigneeGid?: string;
  /**
   * AskElephant filter: tag, keyword, or attendee email pattern
   * used to identify calls/syncs belonging to this client
   */
  askelephantTag?: string;
  /** Internal Slack webhook env key for this client (from .env) */
  slackInternalWebhookEnvKey?: string;
  /** External/shared Slack webhook env key for this client (from .env) */
  slackExternalWebhookEnvKey?: string;
}

/**
 * Per-client MCP context configuration.
 * Keys should match the client IDs in clients.config.ts (client1, client2, …)
 */
export const mcpClients: Record<string, McpClientConfig> = {
  client1: {
    name: 'RunDiffusion',
    website: 'https://rundiffusion.com',
    icpFile: 'rundiffusion.md',
    slackChannelId: process.env.CLIENT1_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT1_ASANA_PROJECT_GID,
    askelephantTag: 'RunDiffusion',
    slackInternalWebhookEnvKey: 'CLIENT1_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT1_SLACK_WEBHOOK_EXTERNAL',
  },
  client2: {
    name: 'Business Bricks',
    website: 'https://businessbricks.com',
    icpFile: 'business-bricks.md',
    slackChannelId: process.env.CLIENT2_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT2_ASANA_PROJECT_GID,
    askelephantTag: 'Business Bricks',
    slackInternalWebhookEnvKey: 'CLIENT2_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT2_SLACK_WEBHOOK_EXTERNAL',
  },
  client3: {
    name: 'Confetti',
    website: 'https://confetti.events',
    icpFile: 'confetti.md',
    slackChannelId: process.env.CLIENT3_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT3_ASANA_PROJECT_GID,
    askelephantTag: 'Confetti',
    slackInternalWebhookEnvKey: 'CLIENT3_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT3_SLACK_WEBHOOK_EXTERNAL',
  },
  client4: {
    name: 'Workstream',
    website: 'https://workstream.us',
    icpFile: 'workstream.md',
    slackChannelId: process.env.CLIENT4_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT4_ASANA_PROJECT_GID,
    askelephantTag: 'Workstream',
    slackInternalWebhookEnvKey: 'CLIENT4_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT4_SLACK_WEBHOOK_EXTERNAL',
  },
  client5: {
    name: 'Hotman Group',
    website: 'https://hotmangroup.com',
    icpFile: 'hotman-group.md',
    slackChannelId: process.env.CLIENT5_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT5_ASANA_PROJECT_GID,
    askelephantTag: 'Hotman Group',
    slackInternalWebhookEnvKey: 'CLIENT5_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT5_SLACK_WEBHOOK_EXTERNAL',
  },
  client6: {
    name: 'Labl',
    website: 'https://labl.com',
    icpFile: 'labl.md',
    slackChannelId: process.env.CLIENT6_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT6_ASANA_PROJECT_GID,
    askelephantTag: 'Labl',
    slackInternalWebhookEnvKey: 'CLIENT6_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT6_SLACK_WEBHOOK_EXTERNAL',
  },
  client7: {
    name: 'Spark Inventory',
    website: 'https://sparkinventory.com',
    icpFile: 'spark-inventory.md',
    slackChannelId: process.env.CLIENT7_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT7_ASANA_PROJECT_GID,
    askelephantTag: 'Spark Inventory',
    slackInternalWebhookEnvKey: 'CLIENT7_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT7_SLACK_WEBHOOK_EXTERNAL',
  },
  client8: {
    name: 'RestorixHealth',
    website: 'https://restorixhealth.com',
    icpFile: 'restorixhealth.md',
    slackChannelId: process.env.CLIENT8_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT8_ASANA_PROJECT_GID,
    askelephantTag: 'RestorixHealth',
    slackInternalWebhookEnvKey: 'CLIENT8_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT8_SLACK_WEBHOOK_EXTERNAL',
  },
  client9: {
    name: 'Workskiff',
    website: 'https://workskiff.com',
    icpFile: 'workskiff.md',
    slackChannelId: process.env.CLIENT9_SLACK_CHANNEL_ID,
    asanaProjectGid: process.env.CLIENT9_ASANA_PROJECT_GID,
    askelephantTag: 'Workskiff',
    slackInternalWebhookEnvKey: 'CLIENT9_SLACK_WEBHOOK_INTERNAL',
    slackExternalWebhookEnvKey: 'CLIENT9_SLACK_WEBHOOK_EXTERNAL',
  },
};

/** Look up a client by name (case-insensitive) or by client ID (client1, client2, …) */
export function findMcpClient(nameOrId: string): { id: string; config: McpClientConfig } | null {
  const lower = nameOrId.toLowerCase().trim();

  // Try direct ID match first
  if (mcpClients[lower]) {
    return { id: lower, config: mcpClients[lower] };
  }

  // Try name match
  for (const [id, config] of Object.entries(mcpClients)) {
    if (config.name.toLowerCase() === lower) {
      return { id, config };
    }
  }

  // Partial name match
  for (const [id, config] of Object.entries(mcpClients)) {
    if (config.name.toLowerCase().includes(lower) || lower.includes(config.name.toLowerCase())) {
      return { id, config };
    }
  }

  return null;
}

/** List all MCP clients */
export function listMcpClients(): Array<{ id: string; config: McpClientConfig }> {
  return Object.entries(mcpClients).map(([id, config]) => ({ id, config }));
}
