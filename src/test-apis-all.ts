#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { getActiveClients } from './config/clients.config';
import { InstantlyService } from './services/instantly.service';
import { EmailBisonService } from './services/emailbison.service';
import { HeyReachService } from './services/heyreach.service';

dotenv.config();

type TestResult = {
  clientId: string;
  clientName: string;
  platform: 'instantly' | 'emailbison' | 'heyreach';
  ok: boolean;
  details: string;
};

function summarizeError(err: any): string {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = err?.message ?? String(err);

  let extra = '';
  if (status) extra += ` status=${status}`;
  if (data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    extra += ` data=${text.slice(0, 400)}`;
  }
  return `${msg}${extra}`;
}

async function main() {
  console.log('\n🧪 Testing API Connections (ALL ACTIVE CLIENTS)\n');
  console.log('='.repeat(72));

  const activeClients = getActiveClients();
  if (activeClients.length === 0) {
    console.log('⚠️  No active clients found. Add keys to .env first.');
    process.exit(1);
  }

  const results: TestResult[] = [];

  for (const { id: clientId, config } of activeClients) {
    console.log(`\n📌 Client: ${config.name} (${clientId})`);
    console.log('-'.repeat(72));

    // EmailBison / Rudiment Send
    if (config.platforms.emailbison?.enabled) {
      try {
        const svc = new EmailBisonService(config.platforms.emailbison.apiKey);
        const campaigns = await svc.getCampaigns();
        results.push({
          clientId,
          clientName: config.name,
          platform: 'emailbison',
          ok: true,
          details: `campaigns=${campaigns.length}`
        });
        console.log(`✅ EmailBison/SEND OK (campaigns=${campaigns.length})`);
      } catch (e) {
        results.push({
          clientId,
          clientName: config.name,
          platform: 'emailbison',
          ok: false,
          details: summarizeError(e)
        });
        console.log(`❌ EmailBison/SEND FAILED: ${summarizeError(e)}`);
      }
    } else {
      console.log('⏭️  EmailBison/SEND skipped (no key)');
    }

    // HeyReach
    if (config.platforms.heyreach?.enabled) {
      try {
        const svc = new HeyReachService(config.platforms.heyreach.apiKey);
        const campaigns = await svc.getCampaigns();
        results.push({
          clientId,
          clientName: config.name,
          platform: 'heyreach',
          ok: true,
          details: `campaigns=${campaigns.length}`
        });
        console.log(`✅ HeyReach OK (campaigns=${campaigns.length})`);
      } catch (e) {
        results.push({
          clientId,
          clientName: config.name,
          platform: 'heyreach',
          ok: false,
          details: summarizeError(e)
        });
        console.log(`❌ HeyReach FAILED: ${summarizeError(e)}`);
      }
    } else {
      console.log('⏭️  HeyReach skipped (no key)');
    }

    // Instantly
    if (config.platforms.instantly?.enabled) {
      try {
        const svc = new InstantlyService(config.platforms.instantly.apiKey);
        const campaigns = await svc.getCampaigns();
        results.push({
          clientId,
          clientName: config.name,
          platform: 'instantly',
          ok: true,
          details: `campaigns=${campaigns.length}`
        });
        console.log(`✅ Instantly OK (campaigns=${campaigns.length})`);
      } catch (e) {
        results.push({
          clientId,
          clientName: config.name,
          platform: 'instantly',
          ok: false,
          details: summarizeError(e)
        });
        console.log(`❌ Instantly FAILED: ${summarizeError(e)}`);
      }
    } else {
      console.log('⏭️  Instantly skipped (no key)');
    }
  }

  // Summary
  console.log('\n' + '='.repeat(72));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(72));

  const total = results.length;
  const failed = results.filter(r => !r.ok);
  const passed = results.filter(r => r.ok);

  console.log(`Total platform checks: ${total}`);
  console.log(`✅ Passed: ${passed.length}`);
  console.log(`❌ Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) {
      console.log(`- ${f.clientName} (${f.clientId}) / ${f.platform}: ${f.details}`);
    }
    process.exit(2);
  }

  console.log('\n🎉 All enabled client/platform API checks passed!');
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});

