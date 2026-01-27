# 🚀 Rudiment Campaign Monitor

**Automated campaign performance monitoring system with Slack alerts for GTM engineering agencies.**

Monitor campaigns across **Instantly**, **EmailBison**, **HeyReach**, and **Clay** with intelligent KPI tracking and real-time Slack notifications.

---

## 🎯 Features

✅ **Multi-Client Support** - Monitor up to 13+ clients simultaneously  
✅ **Multi-Platform Integration** - Instantly, EmailBison, HeyReach, Clay  
✅ **7 Smart KPI Alerts**:
- ⚠️ Low leads (< 100 remaining)
- 🚨 High bounce rate (> 5%)
- ✅ High reply rate (> 10% - positive alert!)
- 📉 Low reply rate (< 1%)
- ⏰ Sequence ending soon (< 3 days)
- ⏳ Long-running campaigns (> 30 days)
- 📊 Volume drops (50% reduction)

✅ **Slack Notifications** - Color-coded rich alerts  
✅ **Configurable Thresholds** - Per-client customization  
✅ **Sequential Monitoring** - Built for MVP-first approach

---

## 📋 Prerequisites

- **Node.js** 18+ installed
- **API Keys** for platforms you use (Instantly/EmailBison, HeyReach, Clay)
- **Slack Webhook URL** ([Get one here](https://api.slack.com/messaging/webhooks))

### Where to get the platform keys

You only need keys for platforms each client actually uses.

- **Instantly**: Instantly app → Settings / API (get an API key)
  - Put into: `CLIENT{N}_INSTANTLY_KEY`
- **EmailBison**: EmailBison app → Settings / API key
  - Put into: `CLIENT{N}_EMAILBISON_KEY`
- **HeyReach**:
  - **Required (evergreen)**: HeyReach **Public API key**
    - Put into: `CLIENT{N}_HEYREACH_KEY`
  - **Optional (not evergreen)**: HeyReach webapp bearer token (JWT)
    - Put into: `CLIENT{N}_HEYREACH_BEARER`
    - Used only for faster single-call stats when valid; if it expires we fall back automatically.
  - **Optional**: org unit ids for webapp endpoints
    - Put into: `CLIENT{N}_HEYREACH_ORG_UNITS`
- **Clay**: Clay app → API key
  - Put into: `CLIENT{N}_CLAY_KEY`

---

## 🚀 Quick Start

### 1. **Install Dependencies**

```bash
cd rudiment-monitor
npm install
```

### 2. **Configure Environment**

```bash
# Copy example file
cp .env.example .env

# Edit .env with your API keys
nano .env  # or use your preferred editor
```

**Add your credentials to `.env`:**

```env
# Slack (Required)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Slack notification mode
# - immediate: one Slack message per alert (default)
# - digest: one Slack message per client (daily digest)
SLACK_NOTIFICATIONS_MODE=immediate

# Client 1 API Keys (Start with ONE client for MVP)
CLIENT1_INSTANTLY_KEY=your_instantly_api_key_here
CLIENT1_HEYREACH_KEY=your_heyreach_api_key_here

# Add more clients as you scale...
```

#### Client ID → Name mapping (current)

- `client1`: RunDiffusion
- `client2`: Business Bricks
- `client3`: Confetti
- `client4`: Workstream
- `client5`: Hotman Group
- `client6`: Labl
- `client7`: Spark Inventory
- `client8`: RestorixHealth
- `client9`: Workskiff

### 3. **Test Slack Integration**

```bash
npm run test
```

This sends a test message to your Slack channel. If successful, you're ready to monitor campaigns!

### 4. **Run Campaign Monitor**

```bash
npm run monitor
```

This will:
1. ✅ Fetch campaigns from all configured platforms
2. 🔎 Analyze metrics against KPI thresholds
3. 📤 Send alerts to Slack
4. ✨ Display summary in console

---

## ☁️ Deploy (Slack-only) on AWS — Daily 09:00 Yerevan

If you only need Slack alerts (no dashboard) and want a cheap “always online” setup, the simplest AWS approach is:

**EventBridge Scheduler ➜ AWS Lambda ➜ runs the monitor once and exits**

This is typically **free-tier friendly** because it runs only once per day.

### 1) Prepare environment variables

In AWS Lambda you will set:

- `SLACK_WEBHOOK_URL`
- `SLACK_NOTIFICATIONS_MODE` (set to `digest` for daily report-style messages)
- `CLIENT1_EMAILBISON_KEY`, `CLIENT1_HEYREACH_KEY`, `CLIENT1_INSTANTLY_KEY` (optional)
- `CLIENT2_...`, `CLIENT3_...`, `CLIENT4_...`

### 2) Configure clients (names)

Client names are configured in:

- `src/config/clients.config.ts`

This repo is currently set up for 4 clients:

1. RunDiffusion (client1)
2. Business Bricks (client2)
3. Workstream (client3)
4. Confetti (client4)

### 3) Build a Lambda zip

```bash
npm run lambda:zip
```

This creates `lambda.zip` in the project root.

### 4) Create the Lambda function (Console)

AWS Console steps (high level):

1. Go to **Lambda → Create function → Author from scratch**
2. Runtime: **Node.js 18.x**
3. After creation, go to **Code → Upload from → .zip file** and upload `lambda.zip`
4. Set the handler to:

```
dist/lambda.handler
```

5. Go to **Configuration → Environment variables** and add your keys.
6. Go to **Configuration → General configuration** and set timeout to **2–5 minutes** (depending on clients).

### 5) Schedule it daily at 09:00 Yerevan

Yerevan is UTC+4, so **09:00 Asia/Yerevan = 05:00 UTC**.

Create a schedule rule in **Amazon EventBridge** that triggers your Lambda:

- Schedule type: Cron
- Cron expression (UTC):

```
cron(0 5 * * ? *)
```

### 6) Validate

1. Run locally first:

```bash
npm run test
npm run test-apis-all
npm run monitor
```

2. In AWS, use **Test** on the Lambda function.
3. Check **CloudWatch Logs** for output.

---

## 📁 Project Structure

```
rudiment-monitor/
├── src/
│   ├── services/           # API integrations
│   │   ├── instantly.service.ts
│   │   ├── emailbison.service.ts
│   │   ├── heyreach.service.ts
│   │   └── slack.service.ts
│   ├── monitors/           # Monitoring logic
│   │   ├── campaign.monitor.ts
│   │   └── kpi.analyzer.ts
│   ├── config/             # Configuration
│   │   ├── clients.config.ts
│   │   └── thresholds.config.ts
│   ├── types/              # TypeScript types
│   │   └── index.ts
│   ├── index.ts            # Main entry point
│   └── test-slack.ts       # Slack test script
├── .env                    # Your API keys (NOT in git)
├── .env.example            # Template
├── package.json
└── README.md
```

---

## 🔧 Configuration

### **Adding Clients**

Edit `src/config/clients.config.ts`:

```typescript
export const clients: Record<string, ClientConfig> = {
  'client1': {
    name: 'Client Name',
    platforms: {
      instantly: {
        apiKey: process.env.CLIENT1_INSTANTLY_KEY || '',
        enabled: !!process.env.CLIENT1_INSTANTLY_KEY
      },
      heyreach: {
        apiKey: process.env.CLIENT1_HEYREACH_KEY || '',
        enabled: !!process.env.CLIENT1_HEYREACH_KEY
      }
    }
  },
  // Add more clients...
};
```

### **Customizing Thresholds**

Edit `src/config/thresholds.config.ts`:

```typescript
export const thresholds: Thresholds = {
  lowLeadsThreshold: 100,          // Adjust as needed
  highBounceRate: 5,                // Industry standard
  excellentReplyRate: 10,           // Celebrate success!
  poorReplyRate: 1,                 // Flag underperforming
  daysBeforeSequenceEnd: 3,         // Early warning
  longRunningCampaignDays: 30,      // Review needed
  volumeDropPercentage: 50          // Significant drops
};
```

### **Per-Client Overrides**

```typescript
export const clientThresholds: Record<string, Partial<Thresholds>> = {
  'high-volume-client': {
    lowLeadsThreshold: 200,         // Higher buffer
    excellentReplyRate: 15          // Higher expectations
  }
};
```

---

## 📊 Usage Examples

### **Monitor All Clients**

```bash
npm run monitor
```

#### Daily digest mode (one message per client)

```bash
SLACK_NOTIFICATIONS_MODE=digest npm run monitor
```

### **Monitor a Single Client**

Use the client id from `src/config/clients.config.ts` (e.g. `client1`, `client2`, ...):

```bash
npm run monitor -- --client=client2
```

### **Test Slack Integration**

```bash
npm run test
```

### **Run in Development Mode**

```bash
npm run dev
```

### **Build for Production**

```bash
npm run build
npm start
```

---

## ☁️ Deploy Dashboard on AWS App Runner (recommended AWS)

This repo’s dashboard is a Node server (`src/dashboard-server.ts`) that serves the UI from `dashboard/public` and exposes API routes under `/api/*`.

### 0) Prereqs
- You need AWS permissions for: **ECR** + **App Runner**.
- Your dashboard needs the same environment variables as local `.env` (client API keys).

### 1) Build and test locally
```bash
npm install
npm run build
npm run dashboard
```
Open: http://localhost:8787

### 2) Build the Docker image
This repo includes a `Dockerfile` that runs the dashboard in production.

```bash
docker build -t rudiment-dashboard:latest .
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e CLIENT1_EMAILBISON_KEY=... \
  rudiment-dashboard:latest
```

### 3) Push to ECR (container registry)
High level:
1. AWS Console → **ECR** → Create repository (e.g. `rudiment-dashboard`)
2. Follow the “View push commands” instructions to:
   - `docker tag ...`
   - `docker push ...`

### 4) Create App Runner service
1. AWS Console → **App Runner** → Create service
2. Source: **ECR** image
3. Port: App Runner sets `PORT`; our server listens on `PORT` automatically.
4. Add environment variables (same as `.env`):
   - `CLIENT1_*`, `CLIENT2_*`, ...
5. Deploy

App Runner will give you a public URL like:
`https://xxxxx.awsapprunner.com`

### Notes
- App Runner does **not** require an RDS database for this dashboard (it uses live API calls).
- If you later want history, consider DynamoDB (serverless) to avoid always-on RDS cost.

---

## 🔄 Automation (Coming Soon)

### **Option 1: Cron Job (Linux/Mac)**

```bash
# Edit crontab
crontab -e

# Run every 4 hours
0 */4 * * * cd /path/to/rudiment-monitor && npm run monitor
```

### **Option 2: Deploy to Cloud**

**Railway / Render / Vercel:**
- Deploy as scheduled job
- Set environment variables
- Configure cron expression
- Auto-scaling included

**Estimated Cost:** $5-20/month

---

## 🎨 Slack Alert Examples

### **⚠️ Low Leads Alert (Warning)**

```
⚠️ LOW LEADS

Client: Client Name
Campaign: Campaign XYZ  
Platform: instantly
Severity: 🟡 Warning

Alert: Low leads alert! Only 85 leads remaining (threshold: 100)

Leads Remaining: 85/500
Emails Sent: 415
```

### **✅ High Reply Rate (Success)**

```
✅ HIGH REPLY

Client: Client Name
Campaign: Campaign ABC
Platform: instantly
Severity: 🟢 Success

Alert: Excellent performance! Reply rate: 12.5% (target: 10%)

Bounce Rate: 2.3%
Reply Rate: 12.5%
Open Rate: 45.2%
Emails Sent: 320
```

---

## 🐛 Troubleshooting

### **No alerts generated**

✅ This is good! All campaigns are within thresholds.

### **Slack webhook error**

Check:
1. SLACK_WEBHOOK_URL is correct in `.env`
2. Webhook has proper permissions
3. Internet connection is active

### **API connection errors**

Check:
1. API keys are valid and not expired
2. Keys have proper permissions
3. API rate limits not exceeded

### **No campaigns found**

Check:
1. At least one platform is enabled in client config
2. API keys are set in `.env`
3. Campaigns are marked as "active" in platforms

---

## 🛣️ Roadmap

### **Phase 1: MVP** ✅ (Current)
- [x] Multi-client configuration
- [x] Instantly, EmailBison, HeyReach integration
- [x] Slack notifications
- [x] 7 KPI alerts
- [x] Configurable thresholds

### **Phase 2: Enhancement** (Next)
- [ ] SQLite database for historical tracking
- [ ] Volume drop detection (requires history)
- [ ] Cron scheduling built-in
- [ ] Simple web dashboard
- [ ] REST API endpoints

### **Phase 3: Advanced** (Future)
- [ ] AI-powered performance predictions
- [ ] Automated lead replenishment suggestions
- [ ] Cross-campaign performance comparison
- [ ] Client-facing dashboard portals
- [ ] Integration with billing systems

---

## 🤝 Support

**Built for Rudiment GTM Engineering**

For issues or questions:
1. Check this README
2. Review configuration files
3. Test with single client first
4. Scale to all 13 clients once validated

---

## 📝 Notes

### **MVP Approach**

This system is designed to start with **ONE client** and scale to all 13:

1. ✅ Configure ONE client in `clients.config.ts`
2. ✅ Add their API keys to `.env`
3. ✅ Test Slack integration
4. ✅ Run monitor and verify alerts
5. ✅ Once working, add remaining 12 clients

### **Best Practices**

- Start with production-ready client first
- Test thresholds with real data
- Adjust thresholds based on client expectations
- Monitor Slack channel regularly
- Review and refine alert logic

### **Security**

- ✅ `.env` is in `.gitignore` (never committed)
- ✅ All API keys stored locally
- ✅ No keys in code or commits
- ✅ Webhook URL protected

---

## 🔎 Exa Web Search (Cline MCP Tool)

This repo does **not** call Exa at runtime. Instead, Exa is configured as a **Cline MCP tool** so I (Cline) can run web searches to help you debug integrations, find docs, etc.

### Where the Exa API key lives

On macOS (VS Code + Cline), MCP servers are configured here:

```text
~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

Ensure you have an `exa` MCP server entry like:

```json
{
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server", "--tools=linkedin_search,web_search_exa"],
      "env": {
        "EXA_API_KEY": "<YOUR_EXA_KEY>"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

After editing the file, **reload the VS Code window** so the MCP server restarts.

### How to use it

Ask me things like:
- “Use Exa to search for Instantly API docs”
- “Search the web for HeyReach API base URL”


---

## 📦 Dependencies

- `axios` - HTTP client for API calls
- `@slack/webhook` - Slack integration
- `dotenv` - Environment variable management
- `uuid` - Unique alert IDs
- `typescript` - Type safety
- `tsx` - TypeScript execution

---

## 🎉 Ready to Monitor!

Your campaign monitoring system is ready. Follow the Quick Start guide to begin monitoring your first client!

**Questions?** Review the configuration files and examples above.

**Let's go! 🚀**
