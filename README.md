# Toronto Blue Jays Bluesky AI Agent

A Node.js agent that monitors live MLB play-by-play data and posts witty updates to Bluesky during Blue Jays games, using Claude AI to generate contextual, enthusiastic commentary.

## Features

✅ **Automated Game Monitoring** - Detects Blue Jays games and watches play-by-play updates  
✅ **AI-Generated Posts** - Uses Claude API to create smart, contextual commentary  
✅ **Live Sentiment** - Incorporates game sentiment from sports news  
✅ **Rate Limiting** - Posts max 5 times per game to avoid spam  
✅ **Error Handling** - Gracefully handles API failures  

## Prerequisites

### 1. Node.js Setup

```bash
node --version  # Ensure you have Node.js 18+
npm init -y
npm install @anthropic-ai/sdk node-fetch
```

### 2. API Keys & Credentials

You'll need:

#### Anthropic API Key
- Get it from: https://console.anthropic.com/account/keys
- Set as environment variable: `ANTHROPIC_API_KEY`

#### Bluesky Credentials
- Create an account at: https://bsky.app
- Generate an app password (Settings → Advanced → App passwords)
- Set as environment variables: `BLUESKY_USERNAME` and `BLUESKY_PASSWORD`

#### MLB Stats API
- FREE - No key required! Uses official MLB Stats API

#### Optional: Twitter/Sentiment API
- For real sentiment analysis, use Twitter API v2 or a sentiment service
- For demo purposes, the agent uses sports news headlines

### 3. Environment Variables

Create a `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-...
BLUESKY_USERNAME=your.bluesky.handle
BLUESKY_PASSWORD=your-app-password-not-main-password
```

Then load them before running:

```bash
export $(cat .env | xargs)
node bluesky-agent.js
```

## How It Works

### 1. **Game Detection**
```
Monday 2 PM → Agent checks MLB schedule
↓
Finds Blue Jays game (home or away)
↓
Retrieves game ID from MLB Stats API
```

### 2. **Real-Time Monitoring**
```
Polls play-by-play API every 5 minutes
↓
Detects new plays (hits, strikeouts, homers, etc.)
↓
Extracts last 3 plays for context
```

### 3. **Context Enrichment**
```
Current Score: 3-2
Inning: Top of 7th
Recent Plays: ["Guerrero Jr: Single", "Kirk: Strikeout", ...]
Live Sentiment: ["Blue Jays momentum building", ...]
```

### 4. **AI Post Generation**
```
Claude receives:
- Game state (score, inning, context)
- Recent plays (what just happened)
- Sentiment data (what people are saying)
↓
Generates witty, contextual Bluesky post (max 300 chars)
Example: "Guerrero Jr with a HUGE hit! 🔵 Jays down 1 but that momentum shift is REAL"
```

### 5. **Posting**
```
Authenticates with Bluesky API
↓
Posts the generated text
↓
Logs success
↓
Waits for next play (rate-limited to 5 posts/game)
```

## Usage

### Run During a Game

```bash
node bluesky-agent.js
```

Output:
```
🤖 Toronto Blue Jays Bluesky Agent Started
🔍 Looking for Blue Jays game today...
✓ Found game: Toronto Blue Jays @ Boston Red Sox

📊 New play detected (15 total plays)
✓ Posted to Bluesky: "And there's the first hit of the day! 🔵 Let's GO Jays!"

[waits 5 minutes, polls again...]
```

### Schedule with Cron (Linux/Mac)

Edit crontab:
```bash
crontab -e
```

Add (runs daily at 1 PM, covering afternoon games):
```
0 13 * * * cd /path/to/project && /usr/bin/node bluesky-agent.js >> logs/agent.log 2>&1
```

### Schedule with Task Scheduler (Windows)

See [Windows Task Scheduler Guide](https://docs.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY bluesky-agent.js .
ENV NODE_ENV=production
CMD ["node", "bluesky-agent.js"]
```

Build & run:
```bash
docker build -t bluesky-agent .
docker run -e ANTHROPIC_API_KEY=sk-ant-... \
           -e BLUESKY_USERNAME=your.handle \
           -e BLUESKY_PASSWORD=app-password \
           bluesky-agent
```

## Advanced Customization

### Modify Polling Frequency

Change line in `bluesky-agent.js`:
```javascript
}, 300000); // Change to 180000 for 3 minutes, etc.
```

### Increase Max Posts Per Game

```javascript
const maxPosts = 5; // Change to 10, 20, etc.
```

### Add Custom Sentiment Sources

Replace the `fetchLiveSentiment()` function with:

```javascript
async function fetchLiveSentiment() {
  // Add your Twitter API v2 stream
  // Add ESPN sentiment
  // Add Reddit/GameThread sentiment
  return sentimentData;
}
```

### Filter by Score Difference

Add logic to only post on close games:

```javascript
if (Math.abs(gameState.blueJaysScore - gameState.opponentScore) <= 2) {
  // Post about close game
}
```

## Troubleshooting

### "Bluesky login failed"
- ✓ Check `BLUESKY_USERNAME` and `BLUESKY_PASSWORD` are correct
- ✓ Make sure you're using an **app password**, not your main password
- ✓ Verify account exists at https://bsky.app

### "No Blue Jays game found today"
- ✓ Check if it's a game day (schedule at https://www.mlb.com/bluejays/schedule)
- ✓ Verify the date in your system is correct
- ✓ Try manually testing: `curl https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2024-04-15`

### "Claude API error"
- ✓ Verify `ANTHROPIC_API_KEY` is set correctly
- ✓ Check rate limits at https://console.anthropic.com/account/limits
- ✓ Ensure API key has sufficient credits

### Posts look generic
- ✓ Customize the prompt in `generateBlueskyPost()` function
- ✓ Add more context variables (player stats, historical records, etc.)
- ✓ Experiment with different Claude models (claude-opus-4-6 vs claude-sonnet-4-6)

## API Rate Limits

- **MLB Stats API**: Unlimited (no auth required)
- **Bluesky API**: ~50 posts/hour recommended
- **Claude API**: Check your tier at https://console.anthropic.com
- **Agent limit**: Max 5 posts per game by default (configurable)

## Next Steps

1. **Add More Context**: Pull pitcher stats, weather, home run records
2. **Sentiment Integration**: Connect Twitter API v2 or a sentiment service
3. **Multi-Team Support**: Monitor other teams (Red Sox, Yankees, etc.)
4. **Interactive Posts**: Reply to mentions or create threads
5. **Analytics**: Track engagement, successful posts, favorite styles
6. **Personalization**: Learn which post styles get most engagement

## File Structure

```
project/
├── bluesky-agent.js        # Main agent
├── .env                     # Environment variables (git ignored)
├── package.json
├── logs/
│   └── agent.log           # Log output (optional)
└── README.md               # This file
```

## License

Free to use and modify. Happy Jays posting! 🔵⚾

---

**Questions?** Check the [Anthropic Docs](https://docs.claude.com) or [Bluesky API Docs](https://docs.bsky.app)
