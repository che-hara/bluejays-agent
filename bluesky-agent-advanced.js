import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLUESKY_USERNAME = process.env.BLUESKY_USERNAME;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;

const client = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// Game state tracking across polling cycles
const gameContext = {
  previousScore: null,
  scoringPlays: [],
  momentumShifts: [],
  notablePlays: [],
  keyPlayers: new Map(),
};

// ============================================================================
// BLUESKY API HELPERS
// ============================================================================

let blueskySession = null;

async function blueskyLogin() {
  const response = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: BLUESKY_USERNAME,
      password: BLUESKY_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Bluesky login failed: ${response.statusText}`);
  }

  blueskySession = await response.json();
  console.log("✓ Logged into Bluesky");
  return blueskySession;
}

async function postToBluesky(text) {
  if (!blueskySession) {
    await blueskyLogin();
  }

  // Validate text length (Bluesky limit is 300 chars)
  if (text.length > 300) {
    text = text.substring(0, 297) + "...";
  }

  const response = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${blueskySession.accessJwt}`,
    },
    body: JSON.stringify({
      repo: blueskySession.did,
      collection: "app.bsky.feed.post",
      record: {
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to post to Bluesky: ${error}`);
  }

  const result = await response.json();
  console.log(`✓ Posted to Bluesky: "${text}"`);
  return result;
}

// ============================================================================
// MLB DATA FETCHING
// ============================================================================

async function findBlueJaysGameToday() {
  const today = new Date().toISOString().split("T")[0];
  const response = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}`
  );
  const data = await response.json();

  if (!data.dates || !data.dates[0]) return null;

  const bjGames = data.dates[0].games || [];
  const blueJaysGame = bjGames.find(
    (game) =>
      game.teams.away.team.name === "Toronto Blue Jays" ||
      game.teams.home.team.name === "Toronto Blue Jays"
  );

  return blueJaysGame;
}

async function getGamePlayByPlay(gameId) {
  const response = await fetch(
    `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
  );
  const data = await response.json();
  return data.allPlays || [];
}

async function getGameLiveData(gameId) {
  const response = await fetch(`https://statsapi.mlb.com/api/v1/game/${gameId}`);
  const data = await response.json();
  return data.gameData && data.liveData ? data : null;
}

// ============================================================================
// ADVANCED SENTIMENT ANALYSIS
// ============================================================================

async function analyzeSentimentFromPlays(plays) {
  // Analyze plays to determine momentum and sentiment
  const playTypes = {
    homeRuns: 0,
    hits: 0,
    strikeouts: 0,
    walks: 0,
    errors: 0,
    doublePlay: 0,
  };

  for (const play of plays.slice(-20)) {
    const desc = (play.result?.description || "").toLowerCase();

    if (desc.includes("home run")) playTypes.homeRuns++;
    if (desc.includes("single") || desc.includes("double") || desc.includes("triple"))
      playTypes.hits++;
    if (desc.includes("strikes out")) playTypes.strikeouts++;
    if (desc.includes("walks")) playTypes.walks++;
    if (desc.includes("error")) playTypes.errors++;
    if (desc.includes("double play")) playTypes.doublePlay++;
  }

  const sentiment = [];
  if (playTypes.homeRuns > 0) sentiment.push("⚡ Home run energy in the air!");
  if (playTypes.doublePlay > 0) sentiment.push("🔥 Defense showing up!");
  if (playTypes.strikeouts > 2)
    sentiment.push("💨 Pitching is SHARP today");
  if (playTypes.walks > 2) sentiment.push("👀 Hitters are patient");
  if (playTypes.errors > 1) sentiment.push("⚠️ Defensive struggles");

  return sentiment.length > 0 ? sentiment : ["Game in progress..."];
}

// ============================================================================
// GAME ANALYSIS
// ============================================================================

function analyzeGameMomentum(gameData, playByPlay) {
  const liveData = gameData.liveData;
  const awayTeam = gameData.gameData.teams.away;
  const homeTeam = gameData.gameData.teams.home;

  const isAwayBlueJays = awayTeam.name === "Toronto Blue Jays";
  const blueJaysScore = isAwayBlueJays
    ? liveData.linescore.teams.away.runs
    : liveData.linescore.teams.home.runs;
  const opponentScore = isAwayBlueJays
    ? liveData.linescore.teams.home.runs
    : liveData.linescore.teams.away.runs;

  let momentum = "";

  if (gameContext.previousScore !== null) {
    const scoreDiff = blueJaysScore - gameContext.previousScore;
    if (scoreDiff > 0) {
      momentum = "🚀 JAYS SCORE!";
    } else if (scoreDiff < 0) {
      momentum = "📉 Jays fell behind...";
    }
  }

  gameContext.previousScore = blueJaysScore;

  return {
    momentum,
    differential: blueJaysScore - opponentScore,
    blueJaysScore,
    opponentScore,
  };
}

// ============================================================================
// CLAUDE AI AGENT - ADVANCED POST GENERATION
// ============================================================================

async function generateBlueskyPost(gameState, recentPlays, sentimentData, momentum) {
  const systemPrompt = `You are a knowledgeable, enthusiastic Toronto Blue Jays fan posting live game updates to Bluesky.

Your personality:
- Witty and engaging
- Knows baseball (explains plays naturally)
- Enthusiastic but authentic
- Uses emojis sparingly but effectively (🔵⚾💙 for Jays, 🚀 for excitement, etc.)
- Short, punchy sentences (Bluesky is for quick takes)
- Canadian perspective when relevant

Current Context:
${momentum ? `Momentum: ${momentum.momentum} (${momentum.differential > 0 ? "+" : ""}${momentum.differential})` : ""}
Inning: ${gameState.inning}
Score: Jays ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore}

Game Sentiment:
${sentimentData.map((s) => `• ${s}`).join("\n")}

Recent Action:
${recentPlays.map((p) => `• ${p}`).join("\n")}

Generate a SHORT Bluesky post (under 280 chars ideally, max 300) about the current game state. 
Focus on:
1. What just happened (the recent play)
2. Current momentum or emotion
3. One relevant detail from context

Output ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: systemPrompt,
      },
    ],
  });

  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

// ============================================================================
// GAME STATE PARSER
// ============================================================================

function parseGameState(gameData, playByPlayData) {
  const liveData = gameData.liveData;
  const gameStatus = gameData.gameData.status.abstractGameState;

  const awayTeam = gameData.gameData.teams.away;
  const homeTeam = gameData.gameData.teams.home;

  const isAwayBlueJays = awayTeam.name === "Toronto Blue Jays";
  const blueJaysTeam = isAwayBlueJays ? awayTeam : homeTeam;
  const opponentTeam = isAwayBlueJays ? homeTeam : awayTeam;

  const blueJaysScore = isAwayBlueJays
    ? liveData.linescore.teams.away.runs
    : liveData.linescore.teams.home.runs;

  const opponentScore = isAwayBlueJays
    ? liveData.linescore.teams.home.runs
    : liveData.linescore.teams.away.runs;

  const inning = liveData.linescore.currentInning || 0;
  const isTopInning = liveData.linescore.inningState === "Top";
  const outs = liveData.linescore.outs || 0;

  // Extract recent plays (last 3)
  const recentPlays = playByPlayData
    .slice(-3)
    .reverse() // Most recent first
    .map((play) => {
      const description = play.result?.description || "";
      const player = play.matchup?.batter?.fullName || play.player?.person?.fullName || "Unknown";
      return `${player}: ${description}`;
    });

  return {
    status: gameStatus,
    blueJaysScore,
    opponentScore,
    opponent: opponentTeam.name,
    inning: `${inning}${isTopInning ? "T" : "B"} (${outs} out${outs !== 1 ? "s" : ""})`,
    recentPlays,
  };
}

// ============================================================================
// MAIN AGENT LOOP
// ============================================================================

async function runBlueJaysAgent() {
  console.log("🤖 Toronto Blue Jays Bluesky AI Agent v2.0 Started");
  console.log("🔵 Ready to post live game updates! ⚾\n");

  try {
    // Find today's Blue Jays game
    console.log("🔍 Looking for Blue Jays game today...");
    const game = await findBlueJaysGameToday();

    if (!game) {
      console.log("❌ No Blue Jays game found today");
      return;
    }

    const gameId = game.gamePk || game.id;
    console.log(
      `✓ Found game: ${game.teams.away.team.name} @ ${game.teams.home.team.name}`
    );
    console.log(`Game ID: ${gameId}\n`);

    // Poll game data periodically
    let lastPlayCount = 0;
    let postCount = 0;
    const maxPosts = 7; // Increased for more engagement
    let gameStarted = false;

    const pollInterval = setInterval(async () => {
      try {
        // Fetch current game state
        const gameData = await getGameLiveData(gameId);
        if (!gameData) {
          if (!gameStarted) {
            console.log("⏳ Waiting for game to start...");
          }
          return;
        }

        const status = gameData.gameData.status.abstractGameState;

        // Game finished
        if (status === "Final" || status === "Completed Early") {
          console.log("\n🏁 Game finished! Final summary:");
          const pbp = await getGamePlayByPlay(gameId);
          const finalState = parseGameState(gameData, pbp);
          const finalPost = `Final: Jays ${finalState.blueJaysScore} - ${finalState.opponent} ${finalState.opponentScore}. Great game! 🔵⚾`;
          if (postCount < maxPosts) {
            await postToBluesky(finalPost);
          }
          clearInterval(pollInterval);
          return;
        }

        // Get play-by-play data
        const playByPlay = await getGamePlayByPlay(gameId);
        const currentPlayCount = playByPlay.length;

        if (!gameStarted) {
          gameStarted = true;
          console.log("▶️ Game started! Beginning live updates...\n");
        }

        // Only post if there are new plays
        if (currentPlayCount > lastPlayCount && postCount < maxPosts) {
          console.log(
            `\n📊 New play detected (${currentPlayCount} total plays this game)`
          );

          // Parse game state
          const gameState = parseGameState(gameData, playByPlay);
          console.log(
            `Score: Jays ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore} | ${gameState.inning}`
          );

          // Analyze momentum
          const momentum = analyzeGameMomentum(gameData, playByPlay);

          // Fetch enhanced sentiment
          const sentiment = await analyzeSentimentFromPlays(playByPlay);

          // Generate and post
          const post = await generateBlueskyPost(
            gameState,
            gameState.recentPlays,
            sentiment,
            momentum
          );

          if (post) {
            console.log(`Generated post: "${post}"`);
            await postToBluesky(post);
            postCount++;
            lastPlayCount = currentPlayCount;
          }
        }
      } catch (error) {
        console.error("⚠️ Error in poll cycle:", error.message);
      }
    }, 300000); // Poll every 5 minutes
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

runBlueJaysAgent().catch(console.error);
