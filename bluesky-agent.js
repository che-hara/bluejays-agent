import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import http from "http";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLUESKY_USERNAME = process.env.BLUESKY_USERNAME;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "jayswin";
const PORT = parseInt(process.env.PORT || "3000");

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MAX_POSTS = 7;
const POLL_INTERVALS = {
  waiting: 5 * 60 * 1000,
  preview: 60 * 1000,
  live: 30 * 1000,
  final: 5 * 60 * 1000,
};

// ============================================================================
// SHARED STATE
// ============================================================================

const state = {
  phase: "waiting",       // waiting | preview | live | final | no-game
  game: null,
  gameState: null,
  pendingPost: null,      // { text, generatedAt }
  recentPosts: [],        // last 5 approved posts
  vibe: "",
  fanSentiment: [],
  postCount: 0,
  lastUpdated: null,
  error: null,
};

// ============================================================================
// BLUESKY API
// ============================================================================

let blueskySession = null;

async function blueskyLogin() {
  const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: BLUESKY_USERNAME, password: BLUESKY_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Bluesky login failed: ${res.statusText}`);
  blueskySession = await res.json();
  console.log("Logged into Bluesky as", BLUESKY_USERNAME);
}

function detectHashtagsAndCreateFacets(text) {
  const facets = [];
  const encoder = new TextEncoder();
  const regex = /#[a-zA-Z][a-zA-Z0-9_]*/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const tag = match[0].slice(1);
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return facets;
}

async function postToBluesky(text) {
  if (!blueskySession) await blueskyLogin();

  if (text.length > 300) text = text.slice(0, 297) + "...";

  const facets = detectHashtagsAndCreateFacets(text);
  const record = {
    text,
    createdAt: new Date().toISOString(),
    ...(facets.length > 0 ? { facets } : {}),
  };

  const res = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${blueskySession.accessJwt}`,
    },
    body: JSON.stringify({ repo: blueskySession.did, collection: "app.bsky.feed.post", record }),
  });

  if (res.status === 401) {
    await blueskyLogin();
    return postToBluesky(text);
  }

  if (!res.ok) throw new Error(`Failed to post: ${await res.text()}`);
  return await res.json();
}

async function fetchFanSentiment() {
  try {
    const res = await fetch(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=%23BlueJays&limit=8"
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.posts || [])
      .map((p) => p.record?.text || "")
      .filter((t) => t.length > 0 && t.length < 200)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ============================================================================
// MLB STATS API
// ============================================================================

async function findBlueJaysGameToday() {
  const today = new Date().toISOString().split("T")[0];
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=team`
  );
  const data = await res.json();
  const games = data.dates?.[0]?.games || [];
  return (
    games.find(
      (g) =>
        g.teams.away.team.name === "Toronto Blue Jays" ||
        g.teams.home.team.name === "Toronto Blue Jays"
    ) || null
  );
}

async function getGameLiveData(gameId) {
  const res = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`);
  const data = await res.json();
  return data.gameData && data.liveData ? data : null;
}

function extractPlays(gameData) {
  return gameData.liveData?.plays?.allPlays || [];
}

// ============================================================================
// GAME STATE PARSING
// ============================================================================

function parseGameState(gameData, plays) {
  const liveData = gameData.liveData;
  const away = gameData.gameData.teams.away;
  const home = gameData.gameData.teams.home;
  const isAway = away.name === "Toronto Blue Jays";

  const blueJaysScore = isAway
    ? liveData.linescore.teams.away.runs
    : liveData.linescore.teams.home.runs;
  const opponentScore = isAway
    ? liveData.linescore.teams.home.runs
    : liveData.linescore.teams.away.runs;

  const inning = liveData.linescore.currentInning || 0;
  const inningState = liveData.linescore.inningState || "";
  const outs = liveData.linescore.outs || 0;
  const abstractState = gameData.gameData.status.abstractGameState;

  const recentPlays = plays
    .slice(-5)
    .reverse()
    .map((p) => {
      const player = p.matchup?.batter?.fullName || "Unknown";
      const desc = p.result?.description || "";
      return `${player}: ${desc}`;
    });

  return {
    abstractState,
    blueJaysScore,
    opponentScore,
    opponent: isAway ? home.name : away.name,
    inning,
    inningState,
    outs,
    recentPlays,
  };
}

// ============================================================================
// MOMENTUM ANALYSIS
// ============================================================================

let previousBlueJaysScore = null;
let previousOpponentScore = null;
let firstLivePoll = true;

function analyzeMomentum(gameState) {
  let momentum = "";

  if (previousBlueJaysScore !== null) {
    const jaysDelta = gameState.blueJaysScore - previousBlueJaysScore;
    const oppDelta = gameState.opponentScore - previousOpponentScore;

    if (jaysDelta > 0)
      momentum = jaysDelta === 1 ? "Toronto scores!" : `Toronto scores ${jaysDelta} runs!`;
    else if (oppDelta > 0)
      momentum = "Opponent scores...";
  }

  previousBlueJaysScore = gameState.blueJaysScore;
  previousOpponentScore = gameState.opponentScore;

  return {
    momentum,
    differential: gameState.blueJaysScore - gameState.opponentScore,
  };
}

// ============================================================================
// CLAUDE AI POST GENERATION
// ============================================================================

async function generateFanReactionPost(gameState, momentum, fanSentiment) {
  const diff = momentum.differential;
  const situation =
    diff > 0 ? `up by ${diff}` : diff < 0 ? `down by ${Math.abs(diff)}` : "tied";
  const isCheckIn = !momentum.momentum;

  const prompt = `You are a witty, sarcastic female Blue Jays fan from Toronto posting live game updates to Bluesky. Authentic, Canadian, family-friendly.

GAME: Toronto vs ${gameState.opponent}
SCORE: Toronto ${gameState.blueJaysScore} - ${gameState.opponent} ${gameState.opponentScore} (${situation})
INNING: ${gameState.inningState} ${gameState.inning} | ${gameState.outs} out(s)
${momentum.momentum ? `JUST HAPPENED: ${momentum.momentum}` : "CONTEXT: Just tuned in mid-game — write a check-in post about the current situation"}
RECENT PLAYS:
${gameState.recentPlays
  .slice(0, 3)
  .map((p) => `- ${p}`)
  .join("\n")}
${
  fanSentiment.length > 0
    ? `\nFAN VIBES:\n${fanSentiment
        .slice(0, 2)
        .map((s) => `- ${s}`)
        .join("\n")}`
    : ""
}

Write a single Bluesky post. 1-2 sentences, under 150 characters. Use city names not team nicknames. Occasional emoji okay. No hashtags.${isCheckIn ? " Sound like you just opened the game and are catching up." : ""}

Reply with ONLY the post text.`;

  const msg = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
}

// ============================================================================
// VIBE ANALYSIS
// ============================================================================

function updateVibe(gameState, plays) {
  const playTexts = plays
    .slice(-20)
    .map((p) => p.result?.description || "")
    .join(" ")
    .toLowerCase();

  const vibes = [];
  if (playTexts.includes("home run")) vibes.push("Home run energy in the air");
  if (playTexts.includes("double play")) vibes.push("Defense is locking it down");
  if ((playTexts.match(/strikes out/g) || []).length > 2) vibes.push("Pitching is dominant today");
  if ((playTexts.match(/\bwalk\b/g) || []).length > 2) vibes.push("Batters are working the count");
  if (playTexts.includes("error")) vibes.push("Some defensive struggles");

  const diff = gameState.blueJaysScore - gameState.opponentScore;
  if (diff >= 3) vibes.push("Toronto pulling away");
  else if (diff <= -3) vibes.push("Toronto in comeback mode");
  else vibes.push("Tight game, anything can happen");

  state.vibe = vibes.slice(0, 2).join(". ");
}

// ============================================================================
// DASHBOARD HTML
// ============================================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDashboard() {
  const gs = state.gameState;

  // Status pill uses CSS dot + ASCII text — no Unicode emoji
  const phaseLabel = {
    waiting: "WAITING",
    preview: "PREVIEW",
    live: "LIVE",
    final: "FINAL",
    "no-game": "NO GAME",
  }[state.phase] || state.phase.toUpperCase();

  const phaseClass = `phase-${state.phase.replace("-", "")}`;

  const scoreHtml = gs
    ? `<div class="score-board">
        <div class="team">
          <div class="team-name">Toronto</div>
          <div class="score">${gs.blueJaysScore}</div>
        </div>
        <div class="vs">vs</div>
        <div class="team">
          <div class="team-name">${escapeHtml(gs.opponent)}</div>
          <div class="score">${gs.opponentScore}</div>
        </div>
      </div>
      <div class="inning">${escapeHtml(gs.inningState)} ${gs.inning} | ${gs.outs} out(s)</div>`
    : `<div class="empty-msg">${state.phase === "no-game" ? "No game today" : "Waiting for game data..."}</div>`;

  const pendingHtml = state.pendingPost
    ? `<div class="pending-post">
        <div class="pending-label">PENDING POST</div>
        <textarea id="post-edit" class="post-edit" maxlength="300" oninput="updateCharCount(this)">${escapeHtml(state.pendingPost.text)}</textarea>
        <div class="char-count"><span id="char-count">${state.pendingPost.text.length}</span> / 300</div>
        <div class="post-actions">
          <button class="btn-approve" onclick="approvePost()">Approve + Post</button>
          <button class="btn-reject" onclick="rejectPost()">Reject</button>
        </div>
      </div>`
    : `<div class="empty-msg">No pending posts</div>`;

  const recentHtml =
    state.recentPosts.length > 0
      ? state.recentPosts
          .map(
            (p) =>
              `<div class="recent-post">
                <span class="recent-text">${escapeHtml(p.text)}</span>
                <span class="post-time">${new Date(p.postedAt).toLocaleTimeString()}</span>
              </div>`
          )
          .join("")
      : `<div class="empty-msg">No posts yet this game</div>`;

  const sentimentHtml =
    state.fanSentiment.length > 0
      ? state.fanSentiment
          .map((t) => `<div class="sentiment-item">${escapeHtml(t)}</div>`)
          .join("")
      : `<div class="empty-msg">No fan posts found</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blue Jays Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0e1a; color: #e0e6f0; font-family: 'Inter', sans-serif; min-height: 100vh; }

    header {
      background: #134074;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      border-bottom: 1px solid #1e4a8a;
    }
    header h1 { font-family: 'Bebas Neue', sans-serif; font-size: 26px; letter-spacing: 2px; color: #fff; }

    /* Status pill — CSS dot + ASCII text, no emoji */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .phase-live       { background: #3a0a0a; color: #ff7070; border: 1px solid #cc3333; }
    .phase-live .dot  { background: #ff4444; animation: blink 1.2s ease-in-out infinite; }
    .phase-preview       { background: #2a1e00; color: #f0c040; border: 1px solid #c08800; }
    .phase-preview .dot  { background: #f0a500; }
    .phase-waiting       { background: #141428; color: #8899bb; border: 1px solid #334466; }
    .phase-waiting .dot  { background: #556688; }
    .phase-final       { background: #0a1830; color: #88aaff; border: 1px solid #3366cc; }
    .phase-final .dot  { background: #4488ff; }
    .phase-nogame       { background: #111; color: #666; border: 1px solid #333; }
    .phase-nogame .dot  { background: #444; }

    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

    .last-updated { margin-left: auto; font-size: 11px; color: #446; }

    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .full-width { grid-column: 1 / -1; }

    .card {
      background: #111827;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #1a2640;
    }
    .card-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 17px;
      letter-spacing: 1.5px;
      color: #5588bb;
      margin-bottom: 14px;
    }

    /* Score */
    .score-board { display: flex; align-items: center; justify-content: center; gap: 24px; margin-bottom: 10px; }
    .team { text-align: center; }
    .team-name { font-size: 12px; color: #7799aa; margin-bottom: 2px; }
    .score { font-family: 'Bebas Neue', sans-serif; font-size: 56px; color: #fff; line-height: 1; }
    .vs { font-size: 16px; color: #445; }
    .inning { text-align: center; font-size: 12px; color: #7799aa; margin-top: 2px; }
    .empty-msg { color: #445; font-size: 13px; padding: 12px 0; text-align: center; }

    /* Pending post */
    .pending-post { background: #0c1d33; border-radius: 8px; padding: 16px; border: 1px solid #1a3a5c; }
    .pending-label { font-size: 10px; color: #5588bb; letter-spacing: 1.5px; margin-bottom: 10px; }
    .post-text { font-size: 15px; line-height: 1.6; color: #ddeeff; margin-bottom: 14px; }
    .post-actions { display: flex; gap: 10px; }
    .post-edit {
      width: 100%; background: #071220; color: #ddeeff; border: 1px solid #2a4a6a;
      border-radius: 6px; padding: 12px; font-size: 15px; font-family: 'Inter', sans-serif;
      line-height: 1.6; resize: vertical; min-height: 80px; margin-bottom: 6px;
      outline: none;
    }
    .post-edit:focus { border-color: #4488bb; }
    .char-count { font-size: 11px; color: #445; text-align: right; margin-bottom: 10px; }
    .char-count.over { color: #dd5555; }

    .btn-approve {
      background: #14401e; color: #66dd88; border: 1px solid #226633;
      padding: 8px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;
    }
    .btn-approve:hover { background: #1a5228; }
    .btn-reject {
      background: #3a1010; color: #dd7070; border: 1px solid #882222;
      padding: 8px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;
    }
    .btn-reject:hover { background: #4a1818; }
    .posts-counter { font-size: 11px; color: #334; text-align: right; margin-top: 10px; }

    /* Recent posts */
    .recent-post {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 10px; padding: 9px 0; border-bottom: 1px solid #1a2640; font-size: 13px;
    }
    .recent-post:last-child { border-bottom: none; }
    .recent-text { color: #c8d8e8; line-height: 1.4; }
    .post-time { font-size: 11px; color: #445; white-space: nowrap; flex-shrink: 0; padding-top: 2px; }

    /* Vibe */
    .vibe-text { font-size: 14px; line-height: 1.7; color: #b0c4d8; }

    /* Fan sentiment */
    .sentiment-item {
      font-size: 13px; color: #8899aa; line-height: 1.5;
      padding: 7px 0; border-bottom: 1px solid #1a2640;
    }
    .sentiment-item:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <header>
    <h1>Blue Jays Agent</h1>
    <span class="status-pill ${phaseClass}"><span class="dot"></span>${phaseLabel}</span>
    <span class="last-updated" id="ts">${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString() : "--"}</span>
  </header>
  <main>
    <div class="card">
      <div class="card-title">Score</div>
      ${scoreHtml}
    </div>
    <div class="card">
      <div class="card-title">Game Vibe</div>
      ${state.vibe ? `<div class="vibe-text">${escapeHtml(state.vibe)}</div>` : `<div class="empty-msg">Analyzing...</div>`}
    </div>
    <div class="card full-width">
      <div class="card-title">Pending Post</div>
      ${pendingHtml}
      <div class="posts-counter">${state.postCount} / ${MAX_POSTS} posts used this game</div>
    </div>
    <div class="card">
      <div class="card-title">Recent Posts</div>
      ${recentHtml}
    </div>
    <div class="card">
      <div class="card-title">What Fans Are Saying</div>
      ${sentimentHtml}
    </div>
  </main>

  <script>
    const pw = sessionStorage.getItem("pw") || "";

    async function apiFetch(path, opts = {}) {
      return fetch(path, {
        ...opts,
        headers: { ...(opts.headers || {}), "X-Dashboard-Password": pw },
      });
    }

    async function checkAuth() {
      const r = await apiFetch("/api/state");
      if (r.status === 401) {
        const entered = prompt("Dashboard password:");
        if (entered) { sessionStorage.setItem("pw", entered); location.reload(); }
      }
    }

    function updateCharCount(el) {
      const counter = document.getElementById("char-count");
      if (!counter) return;
      counter.textContent = el.value.length;
      counter.parentElement.classList.toggle("over", el.value.length > 300);
    }

    async function approvePost() {
      const textarea = document.getElementById("post-edit");
      const text = textarea ? textarea.value.trim() : null;
      if (text !== null && text.length === 0) return;
      await apiFetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      location.reload();
    }

    async function rejectPost() {
      await apiFetch("/api/reject", { method: "POST" });
      location.reload();
    }

    async function refreshTimestamp() {
      const r = await apiFetch("/api/state");
      if (!r.ok) return;
      const data = await r.json();
      if (data.lastUpdated) {
        document.getElementById("ts").textContent = new Date(data.lastUpdated).toLocaleTimeString();
      }
      // Reload only if a pending post appeared or was cleared
      const hasPending = !!data.pendingPost;
      const showingPending = document.querySelector(".pending-post") !== null;
      if (hasPending !== showingPending) location.reload();
    }

    setInterval(refreshTimestamp, 5000);
    checkAuth();
  </script>
</body>
</html>`;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

function checkDashboardAuth(req) {
  return (req.headers["x-dashboard-password"] || "") === DASHBOARD_PASSWORD;
}

function serveDashboard() {
  const server = http.createServer((req, res) => {
    const { pathname, method } = new URL(req.url, `http://localhost:${PORT}`);

    if (pathname === "/" || pathname === "") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard());
      return;
    }

    if (!checkDashboardAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (pathname === "/api/state" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (pathname === "/api/approve" && method === "POST") {
      if (!state.pendingPost) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No pending post" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const post = state.pendingPost;
        state.pendingPost = null;

        let text = post.text;
        try {
          const parsed = JSON.parse(body);
          if (parsed.text && typeof parsed.text === "string") text = parsed.text.trim();
        } catch {}

        postToBluesky(text)
          .then(() => {
            state.recentPosts.unshift({ text, postedAt: new Date().toISOString() });
            if (state.recentPosts.length > 5) state.recentPosts.pop();
            state.postCount++;
            console.log(`Posted (${state.postCount}/${MAX_POSTS}): "${text}"`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch((err) => {
            console.error("Post failed:", err.message);
            state.pendingPost = post;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      });
      return;
    }

    if (pathname === "/api/reject" && method === "POST") {
      state.pendingPost = null;
      console.log("Post rejected");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
}

// ============================================================================
// MAIN POLL LOOP
// ============================================================================

async function poll() {
  try {
    state.lastUpdated = new Date().toISOString();

    if (!state.game) {
      state.game = await findBlueJaysGameToday();
      if (!state.game) {
        console.log("No Blue Jays game today");
        state.phase = "no-game";
        return;
      }
      const away = state.game.teams.away.team.name;
      const home = state.game.teams.home.team.name;
      console.log(`Found game: ${away} @ ${home}`);
    }

    const gameId = state.game.gamePk || state.game.id;
    const gameData = await getGameLiveData(gameId);

    if (!gameData) {
      state.phase = "preview";
      return;
    }

    const abstractState = gameData.gameData.status.abstractGameState;

    if (abstractState === "Preview" || abstractState === "Pre-Game") {
      state.phase = "preview";
      return;
    }

    const plays = extractPlays(gameData);
    const gs = parseGameState(gameData, plays);
    state.gameState = gs;

    if (abstractState === "Final" || abstractState === "Completed Early") {
      state.phase = "final";
      if (!state.pendingPost && state.postCount < MAX_POSTS) {
        const result =
          gs.blueJaysScore > gs.opponentScore
            ? "Win!"
            : gs.blueJaysScore < gs.opponentScore
            ? "Tough loss."
            : "A tie.";
        state.pendingPost = {
          text: `Final: Toronto ${gs.blueJaysScore}, ${gs.opponent} ${gs.opponentScore}. ${result}`,
          generatedAt: new Date().toISOString(),
        };
      }
      return;
    }

    state.phase = "live";
    updateVibe(gs, plays);

    const joiningMidGame = firstLivePoll && (gs.blueJaysScore + gs.opponentScore > 0);
    if (firstLivePoll) {
      firstLivePoll = false;
      state.fanSentiment = await fetchFanSentiment();
    } else if (Math.random() < 0.3) {
      state.fanSentiment = await fetchFanSentiment();
    }

    const momentum = analyzeMomentum(gs);
    const shouldQueue =
      (momentum.momentum !== "" || joiningMidGame) &&
      !state.pendingPost &&
      state.postCount < MAX_POSTS;

    if (shouldQueue) {
      const reason = joiningMidGame ? "Joining mid-game" : momentum.momentum;
      console.log(`${reason} — generating post...`);
      const text = await generateFanReactionPost(gs, momentum, state.fanSentiment);
      if (text) {
        state.pendingPost = { text, generatedAt: new Date().toISOString() };
        console.log(`Queued for approval: "${text}"`);
      }
    }
  } catch (err) {
    state.error = err.message;
    console.error("Poll error:", err.message);
  }
}

async function runPollLoop() {
  await poll();
  if (state.phase === "final") return;
  const interval = POLL_INTERVALS[state.phase] || POLL_INTERVALS.waiting;
  setTimeout(runPollLoop, interval);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  console.log("Toronto Blue Jays Bluesky Agent v3.0");
  serveDashboard();
  await runPollLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
