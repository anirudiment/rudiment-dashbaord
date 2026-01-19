#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { CampaignMonitor } from './monitors/campaign.monitor';
import { validateConfig } from './config/clients.config';

dotenv.config();

async function testSlackIntegration() {
  console.log('🧪 Testing Slack Integration\n');
  console.log('='.repeat(50));
  
  // Validate configuration
  const validation = validateConfig();
  if (!validation.valid) {
    console.error('\n❌ Configuration Error:\n');
    validation.errors.forEach(error => console.error(`  - ${error}`));
    console.error('\nPlease ensure SLACK_WEBHOOK_URL is set in your .env file.\n');
    process.exit(1);
  }
  
  try {
    const monitor = new CampaignMonitor();
    console.log('📤 Sending test message to Slack...\n');
    await monitor.sendTestAlert();
    console.log('✅ Success! Check your Slack channel for the test message.\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    console.error('\nPlease check:');
    console.error('1. SLACK_WEBHOOK_URL is correct in .env file');
    console.error('2. Webhook URL has proper permissions');
    console.error('3. You have internet connection\n');
    process.exit(1);
  }
}

testSlackIntegration();
