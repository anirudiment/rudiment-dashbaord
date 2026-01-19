#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { HeyReachService } from './services/heyreach.service';

dotenv.config();

async function main() {
  console.log('\n🧪 Dumping HeyReach campaigns (full payload)\n');
  console.log('='.repeat(60));

  const apiKey = process.env.CLIENT1_HEYREACH_KEY;
  if (!apiKey) {
    console.error('❌ CLIENT1_HEYREACH_KEY is not set in .env');
    process.exit(1);
  }

  const svc = new HeyReachService(apiKey);
  const campaigns = await svc.getCampaigns();

  const outPath = 'heyreach-campaigns.json';
  writeFileSync(outPath, JSON.stringify(campaigns, null, 2), 'utf8');

  console.log(`✅ Wrote ${campaigns.length} campaign(s) to: ${outPath}`);

  console.log('\nSummary (first 10):');
  campaigns.slice(0, 10).forEach((c: any, idx: number) => {
    console.log(
      `${idx + 1}. ${c.campaign_id ?? c.id ?? 'N/A'} | ${c.campaign_name ?? c.name ?? 'N/A'} | status=${c.status ?? 'N/A'} | active=${c.active ?? 'N/A'}`
    );
  });

  if (campaigns.length > 10) {
    console.log(`... and ${campaigns.length - 10} more`);
  }
  console.log('');
}

main().catch((err: any) => {
  console.error('\n❌ HeyReach full dump failed:', err?.message ?? err);
  if (err?.response) {
    console.error('Status:', err.response.status);
    console.error('Data:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});

