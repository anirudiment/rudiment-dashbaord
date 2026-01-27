import * as dotenv from 'dotenv';

dotenv.config();

function isRealKey(v?: string) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  // Guard against placeholder values from .env.example
  if (s.toLowerCase().startsWith('your_')) return false;
  if (s.toLowerCase().includes('your_client')) return false;
  if (s.toLowerCase().includes('comma_separated')) return false;
  return true;
}

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
      /** Bearer token used by HeyReach webapp endpoints like /api/Dashboard/GetOverallStatsByCampaign */
      bearerToken?: string;
      /** Comma-separated org unit ids required by HeyReach webapp endpoints (x-organization-units header). */
      organizationUnits?: string;
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
        enabled: isRealKey(process.env.CLIENT1_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT1_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT1_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT1_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT1_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT1_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT1_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT1_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT1_CLAY_KEY)
      }
    }
  },

  // CLIENT 2
  'client2': {
    name: 'Business Bricks',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT2_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT2_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT2_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT2_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT2_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT2_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT2_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT2_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT2_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT2_CLAY_KEY)
      }
    }
  },

  // CLIENT 3
  'client3': {
    name: 'Confetti',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT3_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT3_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT3_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT3_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT3_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT3_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT3_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT3_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT3_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT3_CLAY_KEY)
      }
    }
  },

  // CLIENT 4
  'client4': {
    name: 'Workstream',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT4_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT4_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT4_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT4_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT4_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT4_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT4_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT4_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT4_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT4_CLAY_KEY)
      }
    }
  },

  // CLIENT 5
  'client5': {
    name: 'Hotman Group',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT5_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT5_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT5_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT5_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT5_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT5_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT5_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT5_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT5_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT5_CLAY_KEY)
      }
    }
  },

  // CLIENT 6
  'client6': {
    name: 'Labl',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT6_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT6_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT6_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT6_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT6_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT6_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT6_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT6_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT6_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT6_CLAY_KEY)
      }
    }
  },

  // CLIENT 7
  'client7': {
    name: 'Spark Inventory',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT7_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT7_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT7_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT7_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT7_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT7_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT7_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT7_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT7_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT7_CLAY_KEY)
      }
    }
  },

  // CLIENT 8
  'client8': {
    name: 'RestorixHealth',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT8_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT8_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT8_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT8_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT8_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT8_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT8_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT8_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT8_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT8_CLAY_KEY)
      }
    }
  },

  // CLIENT 9
  'client9': {
    name: 'Workskiff',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT9_INSTANTLY_KEY || '',
        enabled: isRealKey(process.env.CLIENT9_INSTANTLY_KEY)
      },
      heyreach: {
        apiKey: process.env.CLIENT9_HEYREACH_KEY || '',
        bearerToken: process.env.CLIENT9_HEYREACH_BEARER || '',
        organizationUnits: process.env.CLIENT9_HEYREACH_ORG_UNITS || '',
        enabled: isRealKey(process.env.CLIENT9_HEYREACH_KEY)
      },
      emailbison: {
        apiKey: process.env.CLIENT9_EMAILBISON_KEY || '',
        enabled: isRealKey(process.env.CLIENT9_EMAILBISON_KEY)
      },
      clay: {
        apiKey: process.env.CLIENT9_CLAY_KEY || '',
        enabled: isRealKey(process.env.CLIENT9_CLAY_KEY)
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
