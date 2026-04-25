# Blue Jays Bluesky Agent - Deployment Guide

Deploy your agent on Railway, GitHub Actions, or your own server.

## Quick Start (5 minutes)

### Local Testing

```bash
# 1. Install dependencies
npm install

# 2. Create .env file with your credentials
cat > .env << EOF
ANTHROPIC_API_KEY=sk-ant-...
BLUESKY_USERNAME=your.bluesky.handle
BLUESKY_PASSWORD=your-app-password
EOF

# 3. Run the agent
npm start

# Output should show:
# 🤖 Toronto Blue Jays Bluesky AI Agent v2.0 Started
# 🔍 Looking for Blue Jays game today...
# ✓ Found game: Toronto Blue Jays @ Boston Red Sox
```

---

## Deployment Option 1: Railway (Easiest)

Railway is a platform-as-a-service that runs Node apps easily.

### Setup

1. **Create Railway Account**
   - Go to https://railway.app
   - Sign up with GitHub

2. **Push Code to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial Blue Jays Bluesky agent"
   git remote add origin https://github.com/YOUR_USERNAME/bluesky-bluejays-agent.git
   git push -u origin main
   ```

3. **Deploy on Railway**
   - In Railway dashboard: "New → GitHub Repo"
   - Select your repository
   - Railway auto-detects Node.js project

4. **Configure Variables**
   - Go to project Settings → Variables
   - Add these variables:
     ```
     ANTHROPIC_API_KEY=sk-ant-...
     BLUESKY_USERNAME=your.bluesky.handle
     BLUESKY_PASSWORD=your-app-password
     NODE_ENV=production
     ```

5. **Deploy Service**
   - Railway will auto-deploy when you push
   - View logs in Railway dashboard
   - Agent runs continuously (perfect for daily games!)

### Cost
- FREE tier includes 500 hours/month (covers running agent during game season)
- If you want 24/7 running, paid tier is ~$5-10/month

---

## Deployment Option 2: GitHub Actions (Free & Scheduled)

Run the agent on a schedule using GitHub Actions.

### Setup

1. **Create workflow file**
   ```bash
   mkdir -p .github/workflows
   touch .github/workflows/bluejays-game.yml
   ```

2. **Add workflow content**
   ```yaml
   name: Blue Jays Bluesky Agent
   
   on:
     schedule:
       # Run at 1 PM ET every day during season (March-October)
       - cron: '17 17 * 3,4,5,6,7,8,9,10 *'
   
     # Manual trigger
     workflow_dispatch:
   
   jobs:
     run-agent:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         
         - name: Setup Node.js
           uses: actions/setup-node@v3
           with:
             node-version: '18'
             cache: 'npm'
         
         - name: Install dependencies
           run: npm install
         
         - name: Run Blue Jays Agent
           env:
             ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
             BLUESKY_USERNAME: ${{ secrets.BLUESKY_USERNAME }}
             BLUESKY_PASSWORD: ${{ secrets.BLUESKY_PASSWORD }}
           run: timeout 3600 npm start || true
   ```

3. **Add Secrets**
   - Go to GitHub repo → Settings → Secrets and variables → Actions
   - Add three secrets:
     - `ANTHROPIC_API_KEY`
     - `BLUESKY_USERNAME`
     - `BLUESKY_PASSWORD`

4. **Trigger**
   - Runs automatically daily at game time
   - Or manually trigger via "Actions" tab → "Run workflow"

### Advantages
- ✅ Completely FREE
- ✅ No server to manage
- ✅ Automatic scheduling
- ✅ Built-in logging

### Limitations
- ⚠️ Stops after 6 hours (workflow limit)
- ⚠️ Can't run at exact game start (schedule-based)
- ✅ Fine for 3-4 hour games though!

---

## Deployment Option 3: Self-Hosted Server

Run on your own machine, VPS, or home server.

### Option 3a: Systemd Service (Linux/Mac)

1. **Create service file**
   ```bash
   sudo nano /etc/systemd/system/bluejays-agent.service
   ```

2. **Add content**
   ```ini
   [Unit]
   Description=Blue Jays Bluesky AI Agent
   After=network.target
   
   [Service]
   Type=simple
   User=youruser
   WorkingDirectory=/home/youruser/bluesky-agent
   EnvironmentFile=/home/youruser/bluesky-agent/.env
   ExecStart=/usr/bin/node bluesky-agent.js
   Restart=always
   RestartSec=30
   StandardOutput=append:/var/log/bluejays-agent.log
   StandardError=append:/var/log/bluejays-agent.log
   
   [Install]
   WantedBy=multi-user.target
   ```

3. **Enable service**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable bluejays-agent
   sudo systemctl start bluejays-agent
   
   # Check status
   sudo systemctl status bluejays-agent
   
   # View logs
   tail -f /var/log/bluejays-agent.log
   ```

### Option 3b: PM2 (Process Manager)

1. **Install PM2**
   ```bash
   npm install -g pm2
   ```

2. **Start with PM2**
   ```bash
   pm2 start bluesky-agent.js --name "bluejays-agent"
   pm2 save
   pm2 startup
   ```

3. **Monitor**
   ```bash
   pm2 logs bluejays-agent
   pm2 monit
   ```

### Option 3c: Docker Container

1. **Build image**
   ```bash
   docker build -t bluejays-agent .
   ```

2. **Run container**
   ```bash
   docker run -d \
     -e ANTHROPIC_API_KEY=sk-ant-... \
     -e BLUESKY_USERNAME=your.handle \
     -e BLUESKY_PASSWORD=app-password \
     --restart always \
     --name bluejays-agent \
     bluejays-agent
   ```

3. **View logs**
   ```bash
   docker logs -f bluejays-agent
   ```

---

## Monitoring & Logging

### Add Enhanced Logging

Modify `bluesky-agent.js`:

```javascript
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, "logs");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logFile = path.join(logDir, `agent-${new Date().toISOString().split('T')[0]}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(logFile, logMessage + "\n");
}

// Replace all console.log with log()
```

### Monitor via Webhook (Optional)

Send notifications when posts are made:

```javascript
async function notifyWebhook(postText) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `🔵 Jays post: ${postText}`,
      timestamp: new Date().toISOString(),
    }),
  });
}
```

Then add to `.env`:
```
WEBHOOK_URL=https://your-discord-webhook.com/...
```

---

## Customization Examples

### 1. Post Only on Key Moments

```javascript
const shouldPost = (gameState) => {
  // Only post on close games
  return Math.abs(gameState.blueJaysScore - gameState.opponentScore) <= 2;
};
```

### 2. Add Player Tracking

```javascript
async function getPlayerStats(playerName) {
  const response = await fetch(
    `https://statsapi.mlb.com/api/v1/people/lookup?lookupType=name&value=${playerName}`
  );
  const data = await response.json();
  return data[0];
}
```

### 3. Include Weather Data

```javascript
async function getGameWeather(gameData) {
  const venue = gameData.gameData.venue;
  // Use OpenWeatherMap or similar
  return {
    temperature: 72,
    conditions: "Partly cloudy",
    windMph: 8,
  };
}
```

### 4. Multi-Team Support

```javascript
const TEAMS_TO_MONITOR = ["Toronto Blue Jays", "New York Yankees"];

async function findGameToMonitor() {
  const today = new Date().toISOString().split("T")[0];
  const response = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}`
  );
  const data = await response.json();
  const allGames = data.dates[0]?.games || [];

  return allGames.filter(
    (game) =>
      TEAMS_TO_MONITOR.includes(game.teams.away.team.name) ||
      TEAMS_TO_MONITOR.includes(game.teams.home.team.name)
  );
}
```

---

## Troubleshooting

### Agent not finding games

```bash
# Test API directly
curl "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2024-04-15"

# Check game ID in response
# Then test game data
curl "https://statsapi.mlb.com/api/v1/game/GAME_ID"
```

### Bluesky authentication fails

```bash
# Test credentials directly
curl -X POST https://bsky.social/xrpc/com.atproto.server.createSession \
  -H "Content-Type: application/json" \
  -d '{"identifier":"your.handle","password":"app-password"}'

# Should return session with accessJwt and did
```

### Claude API timeouts

- Check rate limits: https://console.anthropic.com/account/limits
- Reduce `max_tokens` in API calls
- Add retry logic with exponential backoff

### Posts not appearing

- Verify session is still valid (sessions expire)
- Check character count (max 300)
- Review Bluesky logs for blocked content

---

## Next Steps

1. **Analytics**: Track which post types get engagement
2. **Learning**: Use post engagement to improve prompts
3. **Integration**: Connect to Discord/Slack for notifications
4. **Expansion**: Monitor multiple teams or sports
5. **Interaction**: Reply to fan comments or create threads

---

## Support & Resources

- **Claude API Docs**: https://docs.claude.com
- **Bluesky API**: https://docs.bsky.app
- **MLB Stats API**: https://statsapi.mlb.com
- **Railway Docs**: https://docs.railway.app
- **GitHub Actions**: https://docs.github.com/en/actions

---

Happy posting! Let's Go Jays! 🔵⚾💙
