#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { EmailBisonService } from './services/emailbison.service';

dotenv.config();

async function main() {
  console.log('\n🧪 Testing EmailBison (Rudiment Send) API...\n');
  console.log('='.repeat(60));

  const token = process.env.CLIENT1_EMAILBISON_KEY;
  if (!token) {
    console.error('❌ CLIENT1_EMAILBISON_KEY is not set in .env');
    process.exit(1);
  }

  const svc = new EmailBisonService(token);

  console.log('   Fetching campaigns via GET /api/campaigns ...');
  const campaigns = await svc.getCampaigns();

  console.log(`   ✅ SUCCESS! Found ${campaigns.length} campaign(s)`);

  // Fetch KPI inputs (per campaign, last 7 days)
  console.log('\n   Fetching per-campaign KPIs (last 7 days) via GET /api/campaign-events/stats ...');
  const perCampaignMetrics = await svc.getAllCampaignMetrics('Client1');

  if (perCampaignMetrics.length > 0) {
    console.log('   KPIs per campaign (last 7 days):');
    perCampaignMetrics.forEach((m: any) => {
      console.log(`\n   Campaign ID: ${m.campaignId}`);
      console.log(`     Sent: ${m.emailsSent}`);
      console.log(`     Reply Rate: ${m.replyRate.toFixed(2)}%`);
      console.log(`     Bounce Rate: ${m.bounceRate.toFixed(2)}%`);
      console.log(`     Open Rate: ${m.openRate.toFixed(2)}%`);
      console.log(`     Leads Remaining: ${m.leadsRemaining}`);
    });
  } else {
    console.log('   ℹ️  No metrics returned (no active campaigns or stats calls failed).');
  }

  if (campaigns.length > 0) {
    console.log('\n   📊 Campaign Details (first 5):');
    campaigns.slice(0, 5).forEach((c: any, idx: number) => {
      console.log(`\n   Campaign ${idx + 1}:`);
      console.log(`     ID: ${c.id ?? c.campaign_id ?? 'N/A'}`);
      console.log(`     UUID: ${c.uuid ?? 'N/A'}`);
      console.log(`     Name: ${c.name ?? 'N/A'}`);
      console.log(`     Status: ${c.status ?? 'N/A'}`);
      console.log(`     Type: ${c.type ?? 'N/A'}`);

      // Some send APIs include metrics-like fields; print only if present.
      const metrics = c.metrics ?? undefined;
      if (metrics) {
        console.log(`     Total Leads: ${metrics.total_leads ?? 'N/A'}`);
        console.log(`     Sent: ${metrics.sent ?? 'N/A'}`);
        console.log(`     Bounces: ${metrics.bounces ?? 'N/A'}`);
        console.log(`     Replies: ${metrics.replies ?? 'N/A'}`);
        console.log(`     Opens: ${metrics.opens ?? 'N/A'}`);
      }
    });
  }

  console.log('\n✅ EmailBison/SEND connectivity looks good.');
  console.log('Next: wire KPI metrics (sent/replies/bounces) using /api/campaign-events/stats if needed.\n');
}

main().catch((err: any) => {
  console.error('\n❌ EmailBison test failed:', err?.message ?? err);
  if (err?.response) {
    console.error('Status:', err.response.status);
    console.error('Data:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
