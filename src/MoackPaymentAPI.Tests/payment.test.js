/**
 * MockPaymentAPI — Functional Test Suite
 *
 * 8 test cases covering:
 *   TC-01  Happy path — successful payout + fee calculation
 *   TC-02  Testnet mode — fake sats, never touches mainnet
 *   TC-03  Duplicate reward claim — idempotency enforcement
 *   TC-04  Rate limit — 10 rewards/user/hour ceiling
 *   TC-05  Insufficient developer balance
 *   TC-06  Suspended user
 *   TC-07  Anti-fraud — blocked after 3 failed attempts in 10 min
 *   TC-08  Simulated Lightning timeout — pool balance restored, no double-charge
 *
 * Framework: Jest + Supertest
 * Run: npm test (from MockPaymentAPI.Tests directory)
 */

const request = require("supertest");
const path = require("path");

// Import the app WITHOUT starting the server (module.exports pattern)
const { app, db } = require(path.join(__dirname, "../MockPaymentAPI/server"));

// ─────────────────────────────────────────────
// Shared test constants
// ─────────────────────────────────────────────
const MAINNET_KEY = "test-api-key-001";   // dev-001: 500,000 sat pool
const LOW_BAL_KEY = "test-api-key-002";   // dev-002: 50,000 sat pool
const TESTNET_KEY = "test-api-key-testnet";

const headers = (key) => ({ "x-api-key": key });

// ─────────────────────────────────────────────
// Setup — ensure clean state before each test
// ─────────────────────────────────────────────
beforeEach(async () => {
  // Reset fraud & rate-limit logs
  await request(app).post("/admin/reset");

  // Restore developer balances to known values
  await request(app).post("/admin/developers/dev-001/balance").send({ balance: 500000 });
  await request(app).post("/admin/developers/dev-002/balance").send({ balance: 50000 });

  // Clear reward history (in-memory reset)
  Object.keys(db.rewards).forEach((k) => delete db.rewards[k]);

  // Ensure standard test users exist
  await request(app).post("/admin/users").send({ id: "user-active", status: "active" });
  await request(app).post("/admin/users").send({ id: "user-suspended", status: "suspended" });
});

// ─────────────────────────────────────────────
// TC-01: Happy path — successful payout
// ─────────────────────────────────────────────
describe("TC-01: Happy Path — Successful Payout", () => {
  it("returns 200, correct net amount after 2% fee, and COMPLETED status", async () => {
    const amountSats = 1000;
    const expectedFee = Math.ceil(amountSats * 0.02); // 20 sats
    const expectedUserReceives = amountSats - expectedFee; // 980 sats

    const res = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-tc01-${Date.now()}`,
        amountSats,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.amountSats).toBe(expectedUserReceives);
    expect(res.body.fee).toBe(expectedFee);
    expect(res.body.lightningTxId).toBeDefined();
    expect(res.body.testnet).toBe(false);
  });

  it("debits the developer pool by the full reward amount", async () => {
    const balanceBefore = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    const amountSats = 5000;
    await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-debit-${Date.now()}`,
        amountSats,
      });

    const balanceAfter = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    expect(balanceBefore - balanceAfter).toBe(amountSats);
  });

  it("returns a retrievable reward record via GET /api/rewards/:id", async () => {
    const res = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-get-${Date.now()}`,
        amountSats: 500,
      });

    const { rewardId } = res.body;
    const getRes = await request(app)
      .get(`/api/rewards/${rewardId}`)
      .set(headers(MAINNET_KEY));

    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(rewardId);
    expect(getRes.body.status).toBe("COMPLETED");
  });
});

// ─────────────────────────────────────────────
// TC-02: Testnet mode
// ─────────────────────────────────────────────
describe("TC-02: Testnet Mode — No Real Sats", () => {
  it("marks response testnet:true and returns a testnet-prefixed transaction ID", async () => {
    const res = await request(app)
      .post("/api/rewards")
      .set(headers(TESTNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-testnet-${Date.now()}`,
        amountSats: 10000,
      });

    expect(res.status).toBe(200);
    expect(res.body.testnet).toBe(true);
    expect(res.body.lightningTxId).toMatch(/^testnet-tx-/);
  });

  it("does NOT expose testnet rewards to a mainnet developer's GET", async () => {
    // Testnet developer posts a reward
    const testnetRes = await request(app)
      .post("/api/rewards")
      .set(headers(TESTNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-isolation-${Date.now()}`,
        amountSats: 100,
      });

    const rewardId = testnetRes.body.rewardId;

    // Mainnet developer tries to read it — should 404
    const mainnetGet = await request(app)
      .get(`/api/rewards/${rewardId}`)
      .set(headers(MAINNET_KEY));

    expect(mainnetGet.status).toBe(404);
  });
});

// ─────────────────────────────────────────────
// TC-03: Duplicate reward claim — idempotency
// ─────────────────────────────────────────────
describe("TC-03: Duplicate Reward Claim", () => {
  it("returns 409 DUPLICATE_CLAIM on second call with same achievementId", async () => {
    const payload = {
      userId: "user-active",
      achievementId: `ach-idem-${Date.now()}`,
      amountSats: 200,
    };

    const first = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send(payload);

    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send(payload);

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("DUPLICATE_CLAIM");
    expect(second.body.rewardId).toBe(first.body.rewardId);
  });

  it("does NOT double-charge the developer pool on duplicate request", async () => {
    const balanceBefore = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    const payload = {
      userId: "user-active",
      achievementId: `ach-idem2-${Date.now()}`,
      amountSats: 1000,
    };

    await request(app).post("/api/rewards").set(headers(MAINNET_KEY)).send(payload);
    await request(app).post("/api/rewards").set(headers(MAINNET_KEY)).send(payload);

    const balanceAfter = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    // Pool should only be debited once
    expect(balanceBefore - balanceAfter).toBe(1000);
  });
});

// ─────────────────────────────────────────────
// TC-04: Rate limiting — 10 rewards/user/hour
// ─────────────────────────────────────────────
describe("TC-04: Rate Limiting", () => {
  it("allows exactly 10 rewards then returns 429 on the 11th", async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post("/api/rewards")
        .set(headers(MAINNET_KEY))
        .send({
          userId: "user-active",
          achievementId: `ach-rate-${i}-${Date.now()}`,
          amountSats: 100,
        })
    );

    const results = await Promise.all(requests);
    results.forEach((r) => expect(r.status).toBe(200));

    const eleventh = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-rate-11-${Date.now()}`,
        amountSats: 100,
      });

    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(eleventh.body.resetAt).toBeDefined();
  }, 20000);
});

// ─────────────────────────────────────────────
// TC-05: Insufficient developer balance
// ─────────────────────────────────────────────
describe("TC-05: Insufficient Developer Balance", () => {
  it("returns 402 when pool balance is less than the reward amount", async () => {
    // Set balance to 500 sats, try to pay out 600
    await request(app)
      .post("/admin/developers/dev-002/balance")
      .send({ balance: 500 });

    const res = await request(app)
      .post("/api/rewards")
      .set(headers(LOW_BAL_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-balance-${Date.now()}`,
        amountSats: 600,
      });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("INSUFFICIENT_BALANCE");
    expect(res.body.poolBalance).toBe(500);
    expect(res.body.required).toBe(600);
  });

  it("does NOT debit the pool on a failed balance check", async () => {
    await request(app)
      .post("/admin/developers/dev-002/balance")
      .send({ balance: 500 });

    await request(app)
      .post("/api/rewards")
      .set(headers(LOW_BAL_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-nodebit-${Date.now()}`,
        amountSats: 600,
      });

    const balRes = await request(app).get("/api/balance").set(headers(LOW_BAL_KEY));
    expect(balRes.body.poolBalance).toBe(500); // unchanged
  });
});

// ─────────────────────────────────────────────
// TC-06: Suspended user
// ─────────────────────────────────────────────
describe("TC-06: Suspended User Account", () => {
  it("returns 403 USER_SUSPENDED and moves no funds", async () => {
    const balanceBefore = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    const res = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-suspended",
        achievementId: `ach-suspended-${Date.now()}`,
        amountSats: 1000,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("USER_SUSPENDED");

    const balanceAfter = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    expect(balanceAfter).toBe(balanceBefore);
  });
});

// ─────────────────────────────────────────────
// TC-07: Anti-fraud — blocked after 3 failures in 10 min
// ─────────────────────────────────────────────
describe("TC-07: Anti-Fraud Block", () => {
  it("blocks user after 3 failed payout attempts within 10 minutes", async () => {
    // We'll trigger failures by using a non-existent user (generates fraud log entries)
    const ghostUser = `ghost-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/rewards")
        .set(headers(MAINNET_KEY))
        .send({
          userId: ghostUser,
          achievementId: `ach-fraud-${i}-${Date.now()}`,
          amountSats: 100,
        });
    }

    // Now ensure the user is registered but still blocked by fraud log
    await request(app).post("/admin/users").send({ id: ghostUser, status: "active" });

    const blocked = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: ghostUser,
        achievementId: `ach-fraud-4-${Date.now()}`,
        amountSats: 100,
      });

    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("FRAUD_BLOCKED");
  });
});

// ─────────────────────────────────────────────
// TC-08: Lightning timeout — pool restored, no double-charge
// ─────────────────────────────────────────────
describe("TC-08: Lightning Timeout — Idempotency & Balance Restore", () => {
  it("returns 502 on simulated timeout and restores pool balance fully", async () => {
    const amountSats = 2000;
    const balanceBefore = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    const res = await request(app)
      .post("/api/rewards?simulateTimeout=true")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-timeout-${Date.now()}`,
        amountSats,
      });

    expect(res.status).toBe(502);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.error).toBe("PAYOUT_FAILED");

    const balanceAfter = (
      await request(app).get("/api/balance").set(headers(MAINNET_KEY))
    ).body.poolBalance;

    // Balance must be fully restored — no sats lost on timeout
    expect(balanceAfter).toBe(balanceBefore);
  });

  it("allows a retry after a timeout (no idempotency key collision on new achievementId)", async () => {
    // First attempt — timeout
    await request(app)
      .post("/api/rewards?simulateTimeout=true")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-retry-fail-${Date.now()}`,
        amountSats: 500,
      });

    // Second attempt — different achievementId (represents a legitimate retry)
    const retry = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({
        userId: "user-active",
        achievementId: `ach-retry-success-${Date.now()}`,
        amountSats: 500,
      });

    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("COMPLETED");
  });

  it("rejects requests with no API key with 401", async () => {
    const res = await request(app)
      .post("/api/rewards")
      .send({ userId: "user-active", achievementId: "x", amountSats: 100 });
    expect(res.status).toBe(401);
  });

  it("rejects amountSats outside 1–100,000 range", async () => {
    const tooLow = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({ userId: "user-active", achievementId: "x1", amountSats: 0 });
    expect(tooLow.status).toBe(400);

    const tooHigh = await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({ userId: "user-active", achievementId: "x2", amountSats: 100001 });
    expect(tooHigh.status).toBe(400);
  });
});

// ─────────────────────────────────────────────
// Dashboard smoke test
// ─────────────────────────────────────────────
describe("Dashboard Stats", () => {
  it("accurately reports successful payouts and total sats distributed", async () => {
    const amountSats = 1000;
    const fee = Math.ceil(amountSats * 0.02);
    const userReceives = amountSats - fee;

    await request(app)
      .post("/api/rewards")
      .set(headers(MAINNET_KEY))
      .send({ userId: "user-active", achievementId: `ach-dash-${Date.now()}`, amountSats });

    const dash = await request(app).get("/api/dashboard").set(headers(MAINNET_KEY));
    expect(dash.status).toBe(200);
    expect(dash.body.successfulPayouts).toBeGreaterThanOrEqual(1);
    expect(dash.body.totalDistributedSats).toBeGreaterThanOrEqual(userReceives);
    expect(dash.body.uniqueUsers).toBeGreaterThanOrEqual(1);
  });
});
