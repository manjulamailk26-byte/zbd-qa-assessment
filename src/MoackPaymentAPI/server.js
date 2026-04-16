/**
 * Mock Payment API — ZBD Rewards SDK Simulator
 *
 * Simulates a Bitcoin/Lightning rewards payout API for QA testing.
 * Covers: payout flow, rate limiting, anti-fraud, webhooks, testnet mode.
 *
 * All values are in satoshis (sats). No real money is ever used.
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// In-memory "database" — resets per process run
// ─────────────────────────────────────────────
const db = {
  developers: {
    "dev-001": {
      id: "dev-001",
      name: "Acme Games",
      poolBalance: 500000, // sats
      testnet: false,
      apiKey: "test-api-key-001",
    },
    "dev-002": {
      id: "dev-002",
      name: "Indie Dev",
      poolBalance: 50000, // sats — intentionally low for tests
      testnet: false,
      apiKey: "test-api-key-002",
    },
    "dev-testnet": {
      id: "dev-testnet",
      name: "Testnet Dev",
      poolBalance: 9999999,
      testnet: true,
      apiKey: "test-api-key-testnet",
    },
  },

  users: {
    "user-active": { id: "user-active", status: "active", wallet: "user-active@zbd.gg" },
    "user-suspended": { id: "user-suspended", status: "suspended", wallet: null },
  },

  rewards: {},       // payoutId → reward record
  fraudLog: {},      // userId → [{ timestamp, devId }]
  rateLimitLog: {},  // `${userId}:${devId}` → [timestamps]
  webhooks: {},      // devId → url
};

const SERVICE_FEE_RATE = 0.02;       // 2%
const RATE_LIMIT_MAX = 10;           // rewards per user per hour
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FRAUD_MAX_FAILURES = 3;
const FRAUD_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const PAYOUT_TIMEOUT_MS = 60000;     // 60s SLA

// ─────────────────────────────────────────────
// Middleware — API key auth
// ─────────────────────────────────────────────
function authenticate(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const dev = Object.values(db.developers).find((d) => d.apiKey === apiKey);
  if (!dev) {
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or missing API key" });
  }
  req.developer = dev;
  next();
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Check whether a user has exceeded 10 rewards/hour for this developer.
 * Returns { limited: true, resetAt } if limited, else { limited: false }.
 */
function checkRateLimit(userId, devId) {
  const key = `${userId}:${devId}`;
  const now = Date.now();
  db.rateLimitLog[key] = (db.rateLimitLog[key] || []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (db.rateLimitLog[key].length >= RATE_LIMIT_MAX) {
    const oldest = Math.min(...db.rateLimitLog[key]);
    return { limited: true, resetAt: new Date(oldest + RATE_LIMIT_WINDOW_MS).toISOString() };
  }
  return { limited: false };
}

function recordRateLimit(userId, devId) {
  const key = `${userId}:${devId}`;
  db.rateLimitLog[key] = db.rateLimitLog[key] || [];
  db.rateLimitLog[key].push(Date.now());
}

/**
 * Check anti-fraud: if a user has 3+ failed attempts in the last 10 minutes, block them.
 */
function isFraudBlocked(userId, devId) {
  const key = `${userId}:${devId}`;
  const now = Date.now();
  const log = (db.fraudLog[key] || []).filter((ts) => now - ts < FRAUD_WINDOW_MS);
  db.fraudLog[key] = log;
  return log.length >= FRAUD_MAX_FAILURES;
}

function recordFraudAttempt(userId, devId) {
  const key = `${userId}:${devId}`;
  db.fraudLog[key] = db.fraudLog[key] || [];
  db.fraudLog[key].push(Date.now());
}

/**
 * Simulate Lightning payout. In testnet mode, always succeeds instantly.
 * In mainnet mode, 95% success, 5% simulated timeout (to mimic real Lightning).
 * Accepts optional `simulateTimeout` query param for explicit fault injection tests.
 */
function simulateLightningPayout(amountSats, testnet, simulateTimeout) {
  return new Promise((resolve, reject) => {
    if (simulateTimeout) {
      return setTimeout(() => reject(new Error("LIGHTNING_TIMEOUT")), 100);
    }
    if (testnet) {
      return setTimeout(() => resolve({ txId: `testnet-tx-${uuidv4()}` }), 50);
    }
    const willTimeout = Math.random() < 0.01; // 1% simulated failure in "mainnet" mock
    const latency = Math.floor(Math.random() * 800) + 100; // 100–900ms
    setTimeout(() => {
      if (willTimeout) {
        reject(new Error("LIGHTNING_TIMEOUT"));
      } else {
        resolve({ txId: `lightning-tx-${uuidv4()}` });
      }
    }, latency);
  });
}

/**
 * Fire webhook to developer's registered endpoint (best-effort, no real HTTP in mock).
 * In a real system this would POST to the registered URL with retry logic.
 */
function fireWebhook(devId, payload) {
  const url = db.webhooks[devId];
  if (!url) return;
  // In the mock we just log it — real implementation would use axios with retry
  console.log(`[WEBHOOK] → ${url}`, JSON.stringify(payload));
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * POST /api/rewards
 *
 * Trigger a Bitcoin payout for a user who completed an achievement.
 *
 * Body:
 *   userId        - ZBD user identifier
 *   achievementId - unique achievement event ID (used as idempotency key)
 *   amountSats    - reward amount in satoshis (1–100,000)
 *
 * Query:
 *   simulateTimeout=true  - force Lightning timeout (fault injection)
 */
app.post("/api/rewards", authenticate, async (req, res) => {
  const dev = req.developer;
  const { userId, achievementId, amountSats } = req.body;
  const simulateTimeout = req.query.simulateTimeout === "true";

  // ── Input validation ──
  if (!userId || !achievementId || amountSats == null) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "userId, achievementId, and amountSats are required",
    });
  }
  if (!Number.isInteger(amountSats) || amountSats < 1 || amountSats > 100000) {
    return res.status(400).json({
      error: "INVALID_AMOUNT",
      message: "amountSats must be an integer between 1 and 100,000",
    });
  }

  // ── Idempotency check ──
  const idempotencyKey = `${dev.id}:${achievementId}`;
  const existing = Object.values(db.rewards).find((r) => r.idempotencyKey === idempotencyKey);
  if (existing) {
    return res.status(409).json({
      error: "DUPLICATE_CLAIM",
      message: "This achievement has already been rewarded",
      rewardId: existing.id,
      status: existing.status,
    });
  }

  // ── User lookup ──
  const user = db.users[userId];
  if (!user) {
    recordFraudAttempt(userId, dev.id);
    return res.status(404).json({ error: "USER_NOT_FOUND", message: "User does not exist" });
  }
  if (user.status === "suspended") {
    return res.status(403).json({ error: "USER_SUSPENDED", message: "User account is suspended" });
  }

  // ── Anti-fraud check ──
  if (isFraudBlocked(userId, dev.id)) {
    return res.status(403).json({
      error: "FRAUD_BLOCKED",
      message: "User temporarily blocked due to repeated failed attempts",
    });
  }

  // ── Rate limit check ──
  const rateCheck = checkRateLimit(userId, dev.id);
  if (rateCheck.limited) {
    return res.status(429).json({
      error: "RATE_LIMIT_EXCEEDED",
      message: "User has reached the maximum of 10 rewards per hour",
      resetAt: rateCheck.resetAt,
    });
  }

  // ── Balance check (before debit — atomic in a real DB) ──
  const fee = Math.ceil(amountSats * SERVICE_FEE_RATE);
  const totalDebit = amountSats; // pool is debited for full amount; fee is withheld from user payout
  const userReceives = amountSats - fee;

  if (dev.poolBalance < totalDebit) {
    return res.status(402).json({
      error: "INSUFFICIENT_BALANCE",
      message: "Developer reward pool has insufficient funds",
      poolBalance: dev.poolBalance,
      required: totalDebit,
    });
  }

  // ── Create reward record (status: PENDING) ──
  const rewardId = uuidv4();
  const reward = {
    id: rewardId,
    idempotencyKey,
    developerId: dev.id,
    userId,
    achievementId,
    amountSats,
    fee,
    userReceives,
    testnet: dev.testnet,
    status: "PENDING",
    createdAt: new Date().toISOString(),
    completedAt: null,
    lightningTxId: null,
    error: null,
  };
  db.rewards[rewardId] = reward;

  // ── Debit pool (in a real system this is atomic with the PENDING insert) ──
  dev.poolBalance -= totalDebit;

  // ── Attempt Lightning payout ──
  try {
    const { txId } = await Promise.race([
      simulateLightningPayout(userReceives, dev.testnet, simulateTimeout),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("LIGHTNING_TIMEOUT")), PAYOUT_TIMEOUT_MS)
      ),
    ]);

    reward.status = "COMPLETED";
    reward.completedAt = new Date().toISOString();
    reward.lightningTxId = txId;

    recordRateLimit(userId, dev.id);

    fireWebhook(dev.id, {
      event: "reward.completed",
      rewardId,
      userId,
      amountSats: userReceives,
      txId,
      testnet: dev.testnet,
    });

    return res.status(200).json({
      rewardId,
      status: "COMPLETED",
      userId,
      amountSats: userReceives,
      fee,
      testnet: dev.testnet,
      lightningTxId: txId,
      completedAt: reward.completedAt,
    });
  } catch (err) {
    // ── Payout failed — reverse the pool debit ──
    dev.poolBalance += totalDebit;
    reward.status = "FAILED";
    reward.error = err.message;

    recordFraudAttempt(userId, dev.id);

    fireWebhook(dev.id, {
      event: "reward.failed",
      rewardId,
      userId,
      error: err.message,
      testnet: dev.testnet,
    });

    return res.status(502).json({
      rewardId,
      status: "FAILED",
      error: "PAYOUT_FAILED",
      message: "Lightning payout failed. Pool balance has been restored. Safe to retry.",
      details: err.message,
    });
  }
});

/**
 * GET /api/rewards/:rewardId
 * Fetch the status of a specific reward by ID.
 */
app.get("/api/rewards/:rewardId", authenticate, (req, res) => {
  const reward = db.rewards[req.params.rewardId];
  if (!reward || reward.developerId !== req.developer.id) {
    return res.status(404).json({ error: "NOT_FOUND", message: "Reward not found" });
  }
  return res.json(reward);
});

/**
 * GET /api/balance
 * Check the developer's current reward pool balance.
 */
app.get("/api/balance", authenticate, (req, res) => {
  return res.json({
    developerId: req.developer.id,
    poolBalance: req.developer.poolBalance,
    testnet: req.developer.testnet,
  });
});

/**
 * POST /api/webhooks
 * Register a webhook URL to receive payout events.
 * Body: { url: "https://example.com/webhook" }
 */
app.post("/api/webhooks", authenticate, (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "BAD_REQUEST", message: "url is required" });
  }
  db.webhooks[req.developer.id] = url;
  return res.status(201).json({ message: "Webhook registered", url });
});

/**
 * GET /api/dashboard
 * Summary stats for the developer's reward pool.
 */
app.get("/api/dashboard", authenticate, (req, res) => {
  const devRewards = Object.values(db.rewards).filter(
    (r) => r.developerId === req.developer.id
  );
  const completed = devRewards.filter((r) => r.status === "COMPLETED");
  const failed = devRewards.filter((r) => r.status === "FAILED");
  const uniqueUsers = new Set(completed.map((r) => r.userId)).size;
  const totalDistributed = completed.reduce((sum, r) => sum + r.userReceives, 0);
  const totalFees = completed.reduce((sum, r) => sum + r.fee, 0);

  return res.json({
    totalDistributedSats: totalDistributed,
    totalFeesSats: totalFees,
    uniqueUsers,
    successfulPayouts: completed.length,
    failedAttempts: failed.length,
    currentPoolBalance: req.developer.poolBalance,
    testnet: req.developer.testnet,
  });
});

// ─────────────────────────────────────────────
// Admin helpers (test setup endpoints)
// ─────────────────────────────────────────────

/**
 * POST /admin/users — create a test user (no auth required, test setup only)
 */
app.post("/admin/users", (req, res) => {
  const { id, status } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  db.users[id] = { id, status: status || "active", wallet: `${id}@zbd.gg` };
  return res.status(201).json(db.users[id]);
});

/**
 * POST /admin/reset — reset fraud/rate-limit logs (between test runs)
 */
app.post("/admin/reset", (req, res) => {
  db.fraudLog = {};
  db.rateLimitLog = {};
  return res.json({ message: "Logs reset" });
});

/**
 * POST /admin/developers/:id/balance — set developer balance (test seeding)
 */
app.post("/admin/developers/:id/balance", (req, res) => {
  const dev = db.developers[req.params.id];
  if (!dev) return res.status(404).json({ error: "Developer not found" });
  const { balance } = req.body;
  if (balance == null || balance < 0) return res.status(400).json({ error: "Invalid balance" });
  dev.poolBalance = balance;
  return res.json({ developerId: dev.id, poolBalance: dev.poolBalance });
});

// ─────────────────────────────────────────────
// Export for testing; start only when run directly
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`MockPaymentAPI running on port ${PORT}`);
    console.log(`Testnet mode available via developer "dev-testnet"`);
  });
}

module.exports = { app, db };
