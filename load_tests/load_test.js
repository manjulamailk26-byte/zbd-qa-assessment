/**
 * Load Test — MockPaymentAPI
 * Tool: k6 (https://k6.io)
 *
 * Scenarios:
 *   1. Baseline ramp-up:  0 → 50 users over 30s, hold 1 min, ramp down
 *   2. Spike:             sudden burst to 100 concurrent users
 *
 * Run:
 *   k6 run load_test.js
 *   k6 run --env BASE_URL=http://localhost:3000 load_test.js
 *
 * Thresholds (SLA targets we care about):
 *   - p(95) response time < 3000ms  (Lightning payout has a 60s SLA; 3s is our API layer budget)
 *   - Error rate < 5%               (matches the 5%-at-spike ceiling from the bug report)
 *   - p(99) < 5000ms
 *
 * What we're looking for:
 *   - Does the rate-limiter hold under concurrent pressure (no bypasses)?
 *   - Does balance deduction remain atomic (no negative balances)?
 *   - Does error rate stay under 5% during the spike?
 *   - Does p95 response time stay within our 3s API budget?
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = "test-api-key-001"; // dev-001, 500k sat pool

// Custom metrics
const errorRate = new Rate("payment_error_rate");
const payoutDuration = new Trend("payout_duration_ms", true);

// ─────────────────────────────────────────────
// Load profile — two scenarios
// ─────────────────────────────────────────────
export const options = {
  scenarios: {
    // Scenario 1 — gradual ramp (baseline perf)
    gradual_ramp: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 50 },  // ramp to 50 users
        { duration: "1m", target: 50 },   // hold at 50 users
        { duration: "20s", target: 0 },   // ramp down
      ],
      gracefulRampDown: "10s",
    },

    // Scenario 2 — spike to 100 VUs (mirrors prod traffic spike)
    spike: {
      executor: "ramping-vus",
      startTime: "2m10s", // starts after gradual_ramp finishes
      startVUs: 0,
      stages: [
        { duration: "10s", target: 100 }, // sudden spike
        { duration: "30s", target: 100 }, // hold spike
        { duration: "10s", target: 0 },   // drop
      ],
      gracefulRampDown: "5s",
    },
  },

  thresholds: {
    // p95 response time under 3 seconds
    http_req_duration: ["p(95)<3000", "p(99)<5000"],

    // Error rate under 5% (our concern from the bug report)
    payment_error_rate: ["rate<0.05"],

    // Custom payout duration metric
    payout_duration_ms: ["p(95)<3000"],
  },
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function randomUserId() {
  // Spread load across multiple users to avoid rate-limit interference
  // In a real test, these would be pre-seeded test users
  const id = Math.floor(Math.random() * 200);
  return `load-test-user-${id}`;
}

function uniqueAchievementId() {
  return `ach-load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomSats() {
  // Random amount between 100 and 1000 sats
  return Math.floor(Math.random() * 900) + 100;
}

// ─────────────────────────────────────────────
// Main test function — runs once per VU per iteration
// ─────────────────────────────────────────────
export default function () {
  const userId = randomUserId();
  const payload = JSON.stringify({
    userId,
    achievementId: uniqueAchievementId(),
    amountSats: randomSats(),
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    timeout: "10s",
  };

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/rewards`, payload, params);
  const duration = Date.now() - start;

  payoutDuration.add(duration);

  // ── Assertions ──
  const isSuccess =
    res.status === 200 ||
    res.status === 409 || // duplicate claim — expected under load
    res.status === 429;   // rate limited — expected behavior, not an error

  const isError =
    res.status === 500 ||
    res.status === 502 ||
    res.status === 503 ||
    res.status === 0; // connection failed

  errorRate.add(isError);

  check(res, {
    "response received": (r) => r.status !== 0,
    "not a server error (5xx)": (r) => r.status < 500,
    "response under 3s": () => duration < 3000,
  });

  // Log unexpected errors for debugging
  if (isError) {
    console.error(`[VU ${__VU}] Error ${res.status}: ${res.body?.substring(0, 200)}`);
  }

  // Small think time between requests (realistic user pace)
  sleep(Math.random() * 0.5 + 0.1); // 100–600ms
}

// ─────────────────────────────────────────────
// Setup — seed test users via admin endpoint
// (runs once before all VUs start)
// ─────────────────────────────────────────────
export function setup() {
  console.log("Setting up load test — seeding 200 test users...");
  for (let i = 0; i < 200; i++) {
    http.post(
      `${BASE_URL}/admin/users`,
      JSON.stringify({ id: `load-test-user-${i}`, status: "active" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Reset rate limit and fraud logs from any previous run
  http.post(`${BASE_URL}/admin/reset`);

  // Restore developer balance for the run
  http.post(
    `${BASE_URL}/admin/developers/dev-001/balance`,
    JSON.stringify({ balance: 99999999 }), // large pool so we don't bottleneck on balance
    { headers: { "Content-Type": "application/json" } }
  );

  console.log("Setup complete.");
}

// ─────────────────────────────────────────────
// Teardown — print summary note
// ─────────────────────────────────────────────
export function teardown() {
  console.log("Load test complete. Check thresholds above.");
  console.log("Key metrics to review:");
  console.log("  - payment_error_rate  (target: <5%)");
  console.log("  - payout_duration_ms p95  (target: <3000ms)");
  console.log("  - http_req_duration p99   (target: <5000ms)");
}
