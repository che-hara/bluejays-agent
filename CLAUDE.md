# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies (first time setup)
npm start            # Run the agent (uses bluesky-agent-espn.js)
npm run dev          # Run in development mode (NODE_ENV=development)
node bluesky-agent.js          # Run the original MLB Stats API version
node bluesky-agent-advanced.js # Run the advanced version with momentum tracking
```

Environment variables must be set before running:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export BLUESKY_USERNAME=your.bluesky.handle
export BLUESKY_PASSWORD=your-app-password
```

## Architecture

Three agent variants exist, sharing the same core structure but differing in their data source and feature depth:

- **[bluesky-agent-espn.js](bluesky-agent-espn.js)** — Active default (`npm start`). Uses ESPN's unofficial API (`site.api.espn.com`). Polls every 30 seconds, posts on score changes (total runs increasing). Blue Jays team ID is hardcoded as `"25"`.
- **[bluesky-agent.js](bluesky-agent.js)** — Original version. Uses the official MLB Stats API (`statsapi.mlb.com`). Polls every 5 minutes, posts on new play-by-play events.
- **[bluesky-agent-advanced.js](bluesky-agent-advanced.js)** — Extended MLB Stats API version. Adds cross-poll `gameContext` state tracking (scoring plays, momentum shifts, notable plays, key players), play-based sentiment analysis, and momentum detection between poll cycles. Max posts raised to 7.

All three variants share the same Bluesky posting logic (AT Protocol via `bsky.social/xrpc`): lazy session init on first post, `accessJwt` bearer auth, 300-char truncation.

### Data Flow

```
Poll loop (setInterval)
  → fetch game data (ESPN or MLB Stats API)
  → parseGameState() — normalize into {blueJaysScore, opponentScore, opponent, inning, ...}
  → detect trigger (score change or new play count)
  → generateBlueskyPost() — Claude API call (claude-opus-4-6, max_tokens: 150)
  → postToBluesky() — AT Protocol post
```

### Key Constraints

- **Post cap**: 5 per game (ESPN/original), 7 (advanced). The cap is a `postCount < maxPosts` guard in the poll callback — not rate limiting.
- **Bluesky session**: Module-level `blueskySession` variable, lazily initialized. Sessions are not refreshed if they expire mid-run.
- **No tests**: The `test` script is a placeholder that exits 1.
- **ESM only**: `"type": "module"` in package.json — use `import`, not `require`.

## Dependencies

- `@anthropic-ai/sdk` — Claude API client
- `node-fetch` — HTTP requests (Node 18+ has native fetch, but this project uses the npm package)
- Node.js ≥ 18 required
