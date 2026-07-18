// server.js — MATCHDAY backend (AI Pundit Bot)
// Deploy: Railway. Reuses generateWallet.js / subscribeAndActivate.js from GoalLine — same TxLINE program.

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

// ---------- Firebase ----------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

// ---------- TxLINE config ----------
const NETWORK = process.env.TXLINE_NETWORK || "devnet"; // switch to "mainnet" for the real World Cup free tier
const API_ORIGIN =
  NETWORK === "mainnet" ? "https://txline.txodds.com" : "https://txline-dev.txodds.com";

let jwt = null;
let apiToken = null;

async function loadApiToken() {
  const doc = await db.collection("config").doc("txline").get();
  if (!doc.exists) {
    throw new Error("Run subscribeAndActivate.js first, save { apiToken } to Firestore config/txline");
  }
  apiToken = doc.data().apiToken;
}

async function refreshJwt() {
  const res = await axios.post(`${API_ORIGIN}/auth/guest/start`);
  jwt = res.data.token;
}

function txlineClient() {
  return axios.create({
    baseURL: API_ORIGIN,
    timeout: 15000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
}

async function txlineGet(path, params = {}) {
  try {
    const res = await txlineClient().get(path, { params });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshJwt();
      const res = await txlineClient().get(path, { params });
      return res.data;
    }
    throw err;
  }
}

// ---------- Lightweight cache ----------
const CACHE_TTL_MS = 15_000;
const memCache = new Map();
async function cached(key, fetchFn) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;
  const data = await fetchFn();
  memCache.set(key, { data, time: Date.now() });
  return data;
}

// ---------- Telegram ----------
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendToAllSubscribers(text) {
  const subs = await db.collection("telegram_subscribers").get();
  await Promise.all(
    subs.docs.map((doc) =>
      axios
        .post(`${TELEGRAM_API}/sendMessage`, { chat_id: doc.id, text, parse_mode: "Markdown" })
        .catch((e) => console.error("Telegram send failed:", doc.id, e.message))
    )
  );
}

// Basic Telegram webhook — handles /start so people can subscribe by chatting the bot.
// Set this URL as your webhook: https://api.telegram.org/bot<token>/setWebhook?url=<railway-url>/telegram/webhook
const app = express();
app.use(express.json());

app.post("/telegram/webhook", async (req, res) => {
  const msg = req.body.message;
  if (msg?.text === "/start") {
    await db.collection("telegram_subscribers").doc(String(msg.chat.id)).set({
      subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: msg.chat.id,
      text: "⚽ You're in. MATCHDAY will ping you on goals, red cards, and big odds shifts.",
    });
  }
  res.sendStatus(200);
});

// ---------- Frontend routes (optional, if index.html wants a live feed too) ----------
app.get("/api/fixtures", async (req, res) => {
  try {
    res.json(await cached("fixtures", () => txlineGet("/api/fixtures/snapshot")));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Core watcher: scores + odds, per live fixture ----------
const lastScore = new Map(); // fixtureId -> last scores payload (stringified)
const lastOdds = new Map(); // fixtureId -> last odds snapshot (stringified)

const ODDS_SHIFT_THRESHOLD = 0.15; // 15% relative move counts as "significant" — tune after first live test

async function pollLiveFixtures() {
  try {
    const fixtures = await cached("fixtures", () => txlineGet("/api/fixtures/snapshot"));
    // GameState 1 = scheduled, 6 = cancelled per docs. Anything else we treat as in-progress/live —
    // confirm the live code once you see it in a real fixture and tighten this filter.
    const live = fixtures.filter((f) => f.GameState !== 1 && f.GameState !== 6);

    for (const fixture of live) {
      await Promise.all([checkScores(fixture), checkOdds(fixture)]);
    }
  } catch (e) {
    console.error("pollLiveFixtures error:", e.message);
  }
}

async function checkScores(fixture) {
  const updates = await txlineGet(`/api/scores/updates/${fixture.FixtureId}`);
  const latest = updates[updates.length - 1];
  if (!latest) return;

  const key = JSON.stringify(latest);
  const previous = lastScore.get(fixture.FixtureId);
  lastScore.set(fixture.FixtureId, key);
  if (!previous || previous === key) return;

  // Compare score totals to detect a goal without depending on an exact event-type field name —
  // works regardless of how TxLINE labels the event, since the number itself is what matters.
  const prev = JSON.parse(previous);
  const scoreChanged =
    latest.Participant1Score !== prev.Participant1Score ||
    latest.Participant2Score !== prev.Participant2Score;

  if (scoreChanged) {
    const marketNote = await marketSummary(fixture.FixtureId);
    await sendToAllSubscribers(
      `⚽ *GOAL* — ${fixture.Participant1} ${latest.Participant1Score}-${latest.Participant2Score} ${fixture.Participant2}\n${marketNote}`
    );
  }
}

async function checkOdds(fixture) {
  const snapshot = await txlineGet(`/api/odds/snapshot/${fixture.FixtureId}`);
  if (!snapshot?.length) return;

  const key = JSON.stringify(snapshot);
  const previousRaw = lastOdds.get(fixture.FixtureId);
  lastOdds.set(fixture.FixtureId, key);
  if (!previousRaw) return;

  const previous = JSON.parse(previousRaw);
  // Compare matching markets by index — good enough for a hackathon demo.
  // Tighten by matching on a market/selection ID once you've inspected a real payload.
  for (let i = 0; i < Math.min(snapshot.length, previous.length); i++) {
    const before = Number(previous[i]?.Price ?? previous[i]?.price);
    const after = Number(snapshot[i]?.Price ?? snapshot[i]?.price);
    if (!before || !after) continue;

    const relativeMove = Math.abs(after - before) / before;
    if (relativeMove >= ODDS_SHIFT_THRESHOLD) {
      await sendToAllSubscribers(
        `📈 *Odds shift* — ${fixture.Participant1} vs ${fixture.Participant2}\n${before.toFixed(2)} → ${after.toFixed(2)} (${(relativeMove * 100).toFixed(0)}% move)`
      );
    }
  }
}

async function marketSummary(fixtureId) {
  try {
    const snapshot = await txlineGet(`/api/odds/snapshot/${fixtureId}`);
    const top = snapshot?.[0];
    if (!top) return "Market data not available yet.";
    return `Market now: ${top.Selection ?? "leader"} @ ${top.Price ?? top.price}`;
  } catch {
    return "Market data not available yet.";
  }
}

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
(async () => {
  await loadApiToken();
  await refreshJwt();
  app.listen(PORT, () => console.log(`MATCHDAY backend live on ${PORT}`));
  setInterval(pollLiveFixtures, 20_000);
  setInterval(refreshJwt, 10 * 60_000); // renew proactively every 10 min
})();

/*
Railway env vars:
  FIREBASE_SERVICE_ACCOUNT  — full JSON string of your Firebase service account
  TELEGRAM_BOT_TOKEN        — @Matchdayrobot's BotFather token
  TXLINE_NETWORK            — "devnet" while testing, "mainnet" for the real submission

Firestore setup:
  config/txline = { apiToken: "<from subscribeAndActivate.js>" }

After deploy, set the Telegram webhook once:
  https://api.telegram.org/bot<TOKEN>/setWebhook?url=<your-railway-url>/telegram/webhook
*/

