#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { InstantlyService } from './services/instantly.service';
import { EmailBisonService } from './services/emailbison.service';
import { HeyReachService } from './services/heyreach.service';

dotenv.config();

async function testAPIs() {
  console.log('\n🧪 Testing API Connections\n');
  console.log('='.repeat(60));
  
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;

  // Test Instantly
  if (process.env.CLIENT1_INSTANTLY_KEY) {
    testsRun++;
    console.log('\n📧 Testing Instantly API...');
    console.log('-'.repeat(60));
    try {
      const instantlyService = new InstantlyService(process.env.CLIENT1_INSTANTLY_KEY);
      console.log('   Fetching campaigns...');
      
      const campaigns = await instantlyService.getCampaigns();
      
      console.log(`   ✅ SUCCESS! Found ${campaigns.length} campaign(s)`);
      
      if (campaigns.length > 0) {
        console.log('\n   📊 Campaign Details:');
        campaigns.slice(0, 3).forEach((campaign, index) => {
          console.log(`\n   Campaign ${index + 1}:`);
          console.log(`     ID: ${campaign.campaign_id}`);
          console.log(`     Name: ${campaign.campaign_name}`);
          console.log(`     Status: ${campaign.status}`);
          console.log(`     Total Leads: ${campaign.leads?.total || 0}`);
          console.log(`     Remaining: ${campaign.leads?.remaining || 0}`);
          console.log(`     Emails Sent: ${campaign.stats?.sent || 0}`);
          console.log(`     Bounced: ${campaign.stats?.bounced || 0}`);
          console.log(`     Replied: ${campaign.stats?.replied || 0}`);
          console.log(`     Opened: ${campaign.stats?.opened || 0}`);
        });
        
        if (campaigns.length > 3) {
          console.log(`\n   ... and ${campaigns.length - 3} more campaign(s)`);
        }
      } else {
        console.log('   ℹ️  No campaigns found (this might be normal if no campaigns are active)');
      }
      
      testsPassed++;
    } catch (error: any) {
      console.log('   ❌ FAILED!');
      console.error('   Error:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      testsFailed++;
    }
  } else {
    console.log('\n📧 Instantly: SKIPPED (no API key in .env)');
  }

  // Test EmailBison (Rudiment Send)
  if (process.env.CLIENT1_EMAILBISON_KEY) {
    testsRun++;
    console.log('\n\n📧 Testing EmailBison (Rudiment Send) API...');
    console.log('-'.repeat(60));
    try {
      const emailBisonService = new EmailBisonService(process.env.CLIENT1_EMAILBISON_KEY);
      console.log('   Fetching campaigns...');

      const campaigns = await emailBisonService.getCampaigns();

      console.log(`   ✅ SUCCESS! Found ${campaigns.length} campaign(s)`);

      // Fetch KPIs per active campaign (last 7 days window totals)
      const metrics = await emailBisonService.getAllCampaignMetrics('Client1');
      const metricsById = new Map(metrics.map(m => [String(m.campaignId), m]));

      if (campaigns.length > 0) {
        console.log('\n   📊 Campaign Details (with KPIs where available):');
        campaigns.slice(0, 5).forEach((campaign: any, index: number) => {
          const id = String(campaign.id ?? campaign.campaign_id ?? '');
          const m = metricsById.get(id);

          console.log(`\n   Campaign ${index + 1}:`);
          console.log(`     ID: ${id || 'N/A'}`);
          console.log(`     Name: ${campaign.name ?? 'N/A'}`);
          console.log(`     Status: ${campaign.status ?? 'N/A'}`);

          if (m) {
            console.log(`     Leads Remaining: ${m.leadsRemaining}/${m.leadsTotal}`);
            console.log(`     Emails Sent: ${m.emailsSent}`);
            console.log(`     Bounce Rate: ${m.bounceRate.toFixed(2)}%`);
            console.log(`     Reply Rate: ${m.replyRate.toFixed(2)}%`);
            console.log(`     Open Rate: ${m.openRate.toFixed(2)}%`);
          } else {
            console.log('     KPIs: (not available for this campaign - likely not active)');
          }
        });

        if (campaigns.length > 5) {
          console.log(`\n   ... and ${campaigns.length - 5} more campaign(s)`);
        }
      } else {
        console.log('   ℹ️  No campaigns found');
      }

      testsPassed++;
    } catch (error: any) {
      console.log('   ❌ FAILED!');
      console.error('   Error:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      testsFailed++;
    }
  } else {
    console.log('\n\n📧 EmailBison: SKIPPED (no API key in .env)');
  }

  // Test HeyReach
  if (process.env.CLIENT1_HEYREACH_KEY) {
    testsRun++;
    console.log('\n\n💼 Testing HeyReach API...');
    console.log('-'.repeat(60));
    try {
      const heyReachService = new HeyReachService(process.env.CLIENT1_HEYREACH_KEY);
      console.log('   Fetching campaigns...');
      
      const campaigns = await heyReachService.getCampaigns();
      
      console.log(`   ✅ SUCCESS! Found ${campaigns.length} campaign(s)`);
      
      if (campaigns.length > 0) {
        console.log('\n   📊 Campaign Details:');
        campaigns.slice(0, 3).forEach((campaign, index) => {
          console.log(`\n   Campaign ${index + 1}:`);
          console.log(`     ID: ${campaign.campaign_id}`);
          console.log(`     Name: ${campaign.campaign_name}`);
          console.log(`     Active: ${campaign.active}`);
          console.log(`     Total Leads: ${campaign.leads?.total || 0}`);
          console.log(`     Contacted: ${campaign.leads?.contacted || 0}`);
          console.log(`     Remaining: ${campaign.leads?.remaining || 0}`);
          console.log(`     Messages Sent: ${campaign.engagement?.messages_sent || 0}`);
          console.log(`     Connections: ${campaign.engagement?.connections || 0}`);
          console.log(`     Replies: ${campaign.engagement?.replies || 0}`);
        });
        
        if (campaigns.length > 3) {
          console.log(`\n   ... and ${campaigns.length - 3} more campaign(s)`);
        }
      } else {
        console.log('   ℹ️  No campaigns found');
      }
      
      testsPassed++;
    } catch (error: any) {
      console.log('   ❌ FAILED!');
      console.error('   Error:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      testsFailed++;
    }
  } else {
    console.log('\n\n💼 HeyReach: SKIPPED (no API key in .env)');
  }

  // Summary
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Tests Run: ${testsRun}`);
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`⏭️  Skipped: ${3 - testsRun}`);
  
  if (testsFailed === 0 && testsRun > 0) {
    console.log('\n🎉 All API connections are working!');
    console.log('✨ You can now proceed with full monitoring.\n');
  } else if (testsFailed > 0) {
    console.log('\n⚠️  Some API connections failed. Please check:');
    console.log('   1. API keys are correct in .env file');
    console.log('   2. API keys have proper permissions');
    console.log('   3. No rate limits are being hit\n');
  } else {
    console.log('\n⚠️  No tests run. Please add API keys to .env file.\n');
  }
}

testAPIs().catch(error => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
