#!/usr/bin/env node
import { CampaignMonitor } from './monitors/campaign.monitor';
import { validateConfig } from './config/clients.config';

async function main() {
  console.log('🚀 Rudiment Campaign Monitor\n');
  console.log('='.repeat(50));

  // Optional CLI args:
  //   --client=client2   (run only one client)
  //   --client client2
  const args = process.argv.slice(2);
  const getArg = (key: string) => {
    const eq = args.find(a => a.startsWith(`${key}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    const idx = args.findIndex(a => a === key);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return undefined;
  };

  const onlyClientId = getArg('--client');
  
  // Validate configuration
  const validation = validateConfig();
  if (!validation.valid) {
    console.error('\n❌ Configuration Error:\n');
    validation.errors.forEach(error => console.error(`  - ${error}`));
    console.error('\nPlease check your .env file and ensure all required values are set.\n');
    process.exit(1);
  }
  
  console.log('✅ Configuration validated\n');
  console.log('='.repeat(50));
  
  try {
    const monitor = new CampaignMonitor();
    if (onlyClientId) {
      await monitor.monitorClient(onlyClientId);
    } else {
      await monitor.runMonitoringCheck();
    }
  } catch (error) {
    console.error('\n❌ Error running monitoring check:', error);
    process.exit(1);
  }
}

// Run the monitor
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
