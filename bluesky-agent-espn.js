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
// ESPN DATA FETCHING (FASTER & MORE RELIABLE)
// ============================================================================

async function findBlueJaysGameToday() {
  try {
    const response = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/25"
    );
    const data = await response.json();
    
    // Get today's events
    const events = data.team?.events || [];
    const todayEvent = events.find(event => {
      const eventDate = new Date(event.date);
      const today = new Date();
      return eventDate.toDateString() === today.toDateString();
    });

    if (todayEvent) {
      return {
        id: todayEvent.id,
        name: todayEvent.name,
        date: todayEvent.date,
        link: todayEvent.links?.[0]?.href
      };
    }
    return null;
  } catch (error) {
    console.error("Error finding game:", error.message);
    return null;
  }
}

async function getGameBoxScore(gameId) {
  try {
    const response = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${gameId}`
    );
    const data = await response.json();
    
    if (data.events && data.events[0]) {
      return data.events[0];
    }
    return null;
  } catch (error) {
    console.error("Error getting box score:", error.message);
    return null;
  }
}

async function getGameArticles(gameId) {
  try {
    const response = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${gameId}`
    );
    const data = await response.json();
    
    if (data.events && data.events[0] && data.events[0].articles) {
      return data.events[0].articles.slice(0, 3).map(a => a.headline);
    }
    return [];
  } catch (error) {
    console.error("Error getting articles:", error.message);
    return [];
  }
}

// ============================================================================
// CLAUDE AI AGENT - GENERATES SMART POSTS
// ============================================================================

async function generateBlueskyPost(gameState, recentAction, articles) {
  const prompt = `You are a witty, knowledgeable Toronto Blue Jays fan posting live game updates to Bluesky.

GAME STATE:
- Status: ${gameState.status}
- Blue Jays Score: ${gameState.blueJaysScore}
- Opponent Score: ${gameState.opponentScore}
- Opponent: ${gameState.opponent}
- Inning: ${gameState.inning}

RECENT ACTION:
${recentAction}

CONTEXT:
${articles.length > 0 ? "Latest news: " + articles[0] : "Game in progress"}

Generate a SHORT, ENGAGING Bluesky post (max 300 characters) about the current game state. 
Be enthusiastic, use baseball emojis sparingly (🔵⚾💙), and keep it conversational.
NO HASHTAGS.

Respond with ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

// ============================================================================
// GAME STATE PARSER
// ============================================================================

function parseGameState(eventData) {
  if (!eventData || !eventData.competitions) {
    return null;
  }

  const competition = eventData.competitions[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const blueJaysTeam = competitors.find(c => c.team.id === "25"); // Blue Jays team ID
  const opponentTeam = competitors.find(c => c.team.id !== "25");

  if (!blueJaysTeam || !opponentTeam) return null;

  const status = eventData.status?.type?.description || "In Progress";
  const blueJaysScore = parseInt(blueJaysTeam.score) || 0;
  const opponentScore = parseInt(opponentTeam.score) || 0;
  
  // Get current inning from status
  const inningMatch = status.match(/(\d+)(st|nd|rd|th)/i);
  const inning = inningMatch ? inningMatch[0] : "Live";

  return {
    status,
    blueJaysScore,
    opponentScore,
    opponent: opponentTeam.team.name,
    inning,
    isLive: status.toLowerCase().includes("in progress") || status.toLowerCase().includes("live"),
  };
}

// ============================================================================
// MAIN AGENT LOOP
// ============================================================================

async function runBlueJaysAgent() {
  console.log("🤖 Toronto Blue Jays Bluesky Agent Started (ESPN Version)");
  console.log("🔵 Using ESPN API for faster updates! ⚾\n");

  try {
    // Find today's Blue Jays game
    console.log("🔍 Looking for Blue Jays game today...");
    const game = await findBlueJaysGameToday();

    if (!game) {
      console.log("❌ No Blue Jays game found today");
      return;
    }

    const gameId = game.id;
    console.log(`✓ Found game: ${game.name}`);
    console.log(`Game ID: ${gameId}\n`);

    // Poll game data periodically
    let lastScore = null;
    let postCount = 0;
    const maxPosts = 5;
    let gameStarted = false;

    const pollInterval = setInterval(async () => {
      try {
        // Fetch current game state
        const eventData = await getGameBoxScore(gameId);
        
        if (!eventData) {
          if (!gameStarted) {
            console.log("⏳ Waiting for game data...");
          }
          return;
        }

        const gameState = parseGameState(eventData);
        if (!gameState) return;

        // Check if game is over
        if (!gameState.isLive && gameStarted) {
          console.log("\n🏁 Game finished!");
          const finalPost = `Final: Jays ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore}. Great game! 🔵⚾`;
          if (postCount < maxPosts) {
            await postToBluesky(finalPost);
          }
          clearInterval(pollInterval);
          return;
        }

        // Game started
        if (!gameStarted && gameState.isLive) {
          gameStarted = true;
          console.log("▶️ Game started! Beginning live updates...\n");
        }

        // Post on score changes
        const currentScore = gameState.blueJaysScore + gameState.opponentScore;
        if (lastScore !== null && currentScore > lastScore && postCount < maxPosts) {
          console.log(`\n📊 Score update detected!`);
          console.log(
            `Score: Jays ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore} | ${gameState.inning}`
          );

          // Get context
          const articles = await getGameArticles(gameId);
          const recentAction = `Someone just scored! Current score is now Jays ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore}.`;

          // Generate and post
          const post = await generateBlueskyPost(gameState, recentAction, articles);

          if (post) {
            console.log(`Generated post: "${post}"`);
            await postToBluesky(post);
            postCount++;
          }
        }

        lastScore = currentScore;
      } catch (error) {
        console.error("⚠️ Error in poll cycle:", error.message);
      }
    }, 30000); // Poll every 30 seconds (ESPN updates faster!)
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

runBlueJaysAgent().catch(console.error);
