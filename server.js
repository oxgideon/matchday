// server.js — MATCHDAY
//
// Required Railway env vars:
//   TXLINE_WALLET_SECRET_KEY      - from generateWallet.js
//   FIREBASE_SERVICE_ACCOUNT_KEY  - full service account JSON, one line
//   PORT                          - Railway sets this automatically
//
// npm install first (see package.json).

const express = require("express");
const admin = require("firebase-admin");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const crypto = require("crypto");
const txline = require("./txline");

// ─── FIREBASE ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const STARTING_POINTS = 1000;
const SYNC_INTERVAL_MS = 65_000;

// Hardcoded from TxLINE's published World Cup schedule. Swap this out for a
// dynamic competitionId filter on /api/fixtures/snapshot if TxLINE exposes
// one for World Cup by the time you're building — check the fixtures
// response shape first (console.log it once) to confirm.
const WORLD_CUP_FIXTURE_IDS = [
  17588325, 17588326, 18167317, 18172489, 18175983, 18172260, 18175397,
  18175981, 18179759, 18179764, 18179550, 18172379, 18179551, 18179763,
  18179552, 18176123, 18175918, 18179549, 18185036, 18188721, 18187298,
  18192996, 18198205, 18193785, 18202701, 18202783, 18209181, 18218149,
  18213979, 18222446, 18237038, 18241006, 18257865, 18257739,
];

// ─── IN-MEMORY SESSIONS (fine for a hackathon demo) ─────────────────────
const sessions = new Map(); // sessionToken -> pubkey

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const pubkey = token && sessions.get(token);
  if (!pubkey) return res.status(401).json({ error: "Not authenticated" });
  req.pubkey = pubkey;
  next();
}

// ─── APP ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname + "/public"));

// Wallet login: client signs a fixed message with Phantom, we verify and
// hand back a session token plus current points balance.
app.post("/api/auth/login", async (req, res) => {
  try {
    const { pubkey, signature } = req.body;
    if (!pubkey || !signature) {
      return res.status(400).json({ error: "pubkey and signature required" });
    }
    const message = new TextEncoder().encode(`MATCHDAY login: ${pubkey}`);
    const sigBytes = bs58.decode(signature);
    const pubkeyBytes = bs58.decode(pubkey);
    const valid = nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
    if (!valid) return res.status(401).json({ error: "Invalid signature" });

    const userRef = db.collection("users").doc(pubkey);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      await userRef.set({
        pubkey,
        points: STARTING_POINTS,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    const sessionToken = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionToken, pubkey);

    const finalUser = (await userRef.get()).data();
    res.json({ sessionToken, points: finalUser.points });
  } catch (err) {
    console.error("Login failed:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const doc = await db.collection("users").doc(req.pubkey).get();
  res.json(doc.data());
});

app.get("/api/matches", async (req, res) => {
  const snap = await db.collection("markets").orderBy("kickoffAt").get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

app.get("/api/my-bets", requireAuth, async (req, res) => {
  const snap = await db
    .collection("bets")
    .where("pubkey", "==", req.pubkey)
    .orderBy("createdAt", "desc")
    .get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

app.post("/api/bets", requireAuth, async (req, res) => {
  try {
    const { fixtureId, pick, amount } = req.body;
    if (!fixtureId || !["home", "draw", "away"].includes(pick) || !(amount > 0)) {
      return res.status(400).json({ error: "fixtureId, valid pick, and positive amount required" });
    }

    const marketRef = db.collection("markets").doc(`wc_${fixtureId}`);
    const userRef = db.collection("users").doc(req.pubkey);

    const result = await db.runTransaction(async (tx) => {
      const marketDoc = await tx.get(marketRef);
      const userDoc = await tx.get(userRef);
      if (!marketDoc.exists) throw new Error("Match not found");
      const market = marketDoc.data();
      if (market.status !== "scheduled") throw new Error("Betting closed for this match");
      const user = userDoc.data();
      if (user.points < amount) throw new Error("Not enough points");

      const oddsKey = pick === "home" ? "oddsHome" : pick === "away" ? "oddsAway" : "oddsDraw";
      const odds = market[oddsKey];
      if (!odds) throw new Error("Odds not available yet for this pick");

      tx.update(userRef, { points: admin.firestore.FieldValue.increment(-amount) });
      const betRef = db.collection("bets").doc();
      tx.set(betRef, {
        pubkey: req.pubkey,
        fixtureId,
        fixtureDocId: marketRef.id,
        pick,
        amount,
        oddsAtBet: odds,
        potentialPayout: Math.round(amount * odds),
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { betId: betRef.id, potentialPayout: Math.round(amount * odds) };
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── TXLINE SYNC ─────────────────────────────────────────────────────────
function mapPhaseToStatus(phaseId) {
  if (phaseId === 1) return "scheduled";
  if ([5, 10, 13].includes(phaseId)) return "completed";
  if ([15, 16, 17, 18, 19].includes(phaseId)) return "cancelled";
  return "live";
}

async function syncMarkets() {
  const fixtures = await txline.getFixtures();
  const byId = new Map(fixtures.map((f) => [f.FixtureId, f]));

  for (const fixtureId of WORLD_CUP_FIXTURE_IDS) {
    const fixture = byId.get(fixtureId);
    if (!fixture) continue;
    try {
      const homeTeam = fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2;
      const awayTeam = fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1;

      let status = "scheduled";
      let score = "0-0";
      let winner = null;
      try {
        const scores = await txline.getScores(fixtureId);
        const finalRecord = scores.find((s) => s.action === "game_finalised");
        const latest = scores[scores.length - 1];
        if (finalRecord) {
          status = "completed";
        } else if (latest && latest.phaseId) {
          status = mapPhaseToStatus(latest.phaseId);
        }
        // Stat keys 1 and 2 are total goals for participant 1 / 2 (see soccer feed docs)
        const goalsRecord = [...scores].reverse().find((s) => s.Stats && (s.Stats["1"] !== undefined || s.Stats["2"] !== undefined));
        if (goalsRecord) {
          const p1Goals = goalsRecord.Stats["1"] || 0;
          const p2Goals = goalsRecord.Stats["2"] || 0;
          const homeGoals = fixture.Participant1IsHome ? p1Goals : p2Goals;
          const awayGoals = fixture.Participant1IsHome ? p2Goals : p1Goals;
          score = `${homeGoals}-${awayGoals}`;
          if (status === "completed") {
            winner = homeGoals > awayGoals ? "home" : awayGoals > homeGoals ? "away" : "draw";
          }
        }
      } catch (e) {
        // No scores yet for a scheduled fixture is expected — keep defaults
      }

      let odds = null;
      try {
        const oddsData = await txline.getOdds(fixtureId);
        const latestOdds = oddsData[oddsData.length - 1];
        if (latestOdds) {
          odds = {
            oddsHome: fixture.Participant1IsHome ? latestOdds.price1 : latestOdds.price2,
            oddsDraw: latestOdds.priceX,
            oddsAway: fixture.Participant1IsHome ? latestOdds.price2 : latestOdds.price1,
          };
        }
      } catch (e) {
        // odds not published yet
      }

      const marketDoc = {
        home: homeTeam,
        away: awayTeam,
        status,
        score,
        winner,
        kickoffAt: fixture.StartTime,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (odds) Object.assign(marketDoc, odds);

      await db.collection("markets").doc(`wc_${fixtureId}`).set(marketDoc, { merge: true });

      if (status === "completed" && winner) {
        await settleBets(fixtureId, winner);
      }
    } catch (err) {
      console.error(`Failed syncing fixture ${fixtureId}:`, err.message);
    }
  }
  console.log(`[${new Date().toISOString()}] Sync complete.`);
}

async function settleBets(fixtureId, winner) {
  const pendingSnap = await db
    .collection("bets")
    .where("fixtureId", "==", fixtureId)
    .where("status", "==", "pending")
    .get();
  if (pendingSnap.empty) return;

  const batch = db.batch();
  for (const doc of pendingSnap.docs) {
    const bet = doc.data();
    const won = bet.pick === winner;
    batch.update(doc.ref, { status: won ? "won" : "lost" });
    if (won) {
      const userRef = db.collection("users").doc(bet.pubkey);
      batch.update(userRef, { points: admin.firestore.FieldValue.increment(bet.potentialPayout) });
    }
  }
  await batch.commit();
  console.log(`Settled ${pendingSnap.size} bets for fixture ${fixtureId}`);
}

function syncLoop() {
  syncMarkets()
    .catch((err) => console.error("Sync cycle failed:", err.message))
    .finally(() => setTimeout(syncLoop, SYNC_INTERVAL_MS));
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(process.env.PORT || 3000, async () => {
  console.log(`MATCHDAY listening on port ${process.env.PORT || 3000}`);
  try {
    await txline.subscribeAndActivate();
    syncLoop();
  } catch (err) {
    console.error("TxLINE activation failed — server is up but matches won't sync:", err.message);
  }
});

