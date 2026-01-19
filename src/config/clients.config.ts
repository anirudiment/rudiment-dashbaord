import * as dotenv from 'dotenv';

dotenv.config();

// Client configuration interface
export interface ClientConfig {
  name: string;
  platforms: {
    instantly?: {
      apiKey: string;
      enabled: boolean;
    };
    emailbison?: {
      apiKey: string;
      enabled: boolean;
    };
    heyreach?: {
      apiKey: string;
      enabled: boolean;
    };
    clay?: {
      apiKey: string;
      enabled: boolean;
    };
  };
}

// Multi-client configuration
// Start with one client for MVP, then add all 13
export const clients: Record<string, ClientConfig> = {
  // CLIENT 1 - MVP Test Client
  'client1': {
    name: 'RunDiffusion',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT1_INSTANTLY_KEY || '',
        enabled: !!process.env.CLIENT1_INSTANTLY_KEY
      },
      heyreach: {
        apiKey: process.env.CLIENT1_HEYREACH_KEY || '',
        enabled: !!process.env.CLIENT1_HEYREACH_KEY
      },
      emailbison: {
        apiKey: process.env.CLIENT1_EMAILBISON_KEY || '',
        enabled: !!process.env.CLIENT1_EMAILBISON_KEY
      },
      clay: {
        apiKey: process.env.CLIENT1_CLAY_KEY || '',
        enabled: !!process.env.CLIENT1_CLAY_KEY
      }
    }
  },

  // CLIENT 2
  'client2': {
    name: 'Business Bricks',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT2_INSTANTLY_KEY || '',
        enabled: !!process.env.CLIENT2_INSTANTLY_KEY
      },
      heyreach: {
        apiKey: process.env.CLIENT2_HEYREACH_KEY || '',
        enabled: !!process.env.CLIENT2_HEYREACH_KEY
      },
      emailbison: {
        apiKey: process.env.CLIENT2_EMAILBISON_KEY || '',
        enabled: !!process.env.CLIENT2_EMAILBISON_KEY
      },
      clay: {
        apiKey: process.env.CLIENT2_CLAY_KEY || '',
        enabled: !!process.env.CLIENT2_CLAY_KEY
      }
    }
  },

  // CLIENT 3
  'client3': {
    name: 'Confetti',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT3_INSTANTLY_KEY || '',
        enabled: !!process.env.CLIENT3_INSTANTLY_KEY
      },
      heyreach: {
        apiKey: process.env.CLIENT3_HEYREACH_KEY || '',
        enabled: !!process.env.CLIENT3_HEYREACH_KEY
      },
      emailbison: {
        apiKey: process.env.CLIENT3_EMAILBISON_KEY || '',
        enabled: !!process.env.CLIENT3_EMAILBISON_KEY
      },
      clay: {
        apiKey: process.env.CLIENT3_CLAY_KEY || '',
        enabled: !!process.env.CLIENT3_CLAY_KEY
      }
    }
  },

  // CLIENT 4
  'client4': {
    name: 'Workstream',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT4_INSTANTLY_KEY || '',
        enabled: !!process.env.CLIENT4_INSTANTLY_KEY
      },
      heyreach: {
        apiKey: process.env.CLIENT4_HEYREACH_KEY || '',
        enabled: !!process.env.CLIENT4_HEYREACH_KEY
      },
      emailbison: {
        apiKey: process.env.CLIENT4_EMAILBISON_KEY || '',
        enabled: !!process.env.CLIENT4_EMAILBISON_KEY
      },
      clay: {
        apiKey: process.env.CLIENT4_CLAY_KEY || '',
        enabled: !!process.env.CLIENT4_CLAY_KEY
      }
    }
  }
};

// Get all active clients (those with at least one enabled platform)
export function getActiveClients(): Array<{ id: string; config: ClientConfig }> {
  return Object.entries(clients)
    .filter(([_, config]) => 
      Object.values(config.platforms).some(platform => platform?.enabled)
    )
    .map(([id, config]) => ({ id, config }));
}

// Get client by ID
export function getClient(clientId: string): ClientConfig | undefined {
  return clients[clientId];
}

// Validate configuration
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!process.env.SLACK_WEBHOOK_URL) {
    errors.push('SLACK_WEBHOOK_URL is not set');
  }
  
  const activeClients = getActiveClients();
  if (activeClients.length === 0) {
    errors.push('No active clients configured. Add at least one client with API keys.');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
