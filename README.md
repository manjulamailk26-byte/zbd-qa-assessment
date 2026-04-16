# Senior QA Engineer — Technical Assessment

A complete QA engineering assessment for a Bitcoin/Lightning rewards payment platform. This repo covers test planning, hands-on API testing with a load component, a CI/CD pipeline, and written problem-solving responses.

---

## Repository Structure

```
├── docs/
│   ├── test_plan.md          # Part 1 — Test plan for Rewards SDK PRD
│   └── problem_solving.md    # Part 3 — Production incident + first-QA-hire scenarios
│
├── src/
│   ├── MockPaymentAPI/        # Option A — Express.js mock payment API
│   │   ├── server.js          # API implementation (payout, rate limiting, fraud, webhooks)
│   │   └── package.json
│   │
│   └── MockPaymentAPI.Tests/  # Option A — Jest + Supertest functional test suite
│       ├── payment.test.js    # 8 test cases (TC-01 through TC-08)
│       └── package.json
│
├── load-tests/
│   └── load_test.js           # Option A — k6 load test (ramp + spike scenarios)
│
├── .github/
│   └── workflows/
│       └── ci.yml             # Option B — GitHub Actions CI/CD pipeline
│
└── README.md
```

---

## Part 1 — Test Plan

📄 [`docs/test_plan.md`](docs/test_plan.md)

A concise, risk-prioritized test plan for the Rewards SDK based on the provided PRD. Covers:

- **Test scope** — what to test now vs. defer
- **10 critical test scenarios** in table format (TC-01 through TC-10)
- **Environment strategy** — testnet-first, no real sats in CI/staging
- **Top 5 risks** with mitigations (including the timeout/double-charge race condition)

---

## Part 2 — Hands-On Exercise

### Option A: API Testing with Load Component

#### Mock Payment API

A lightweight Express.js API that simulates the Rewards SDK backend. Implements:

| Endpoint | Description |
|----------|-------------|
| `POST /api/rewards` | Trigger a payout with full validation, fee calc, rate limiting, fraud detection |
| `GET /api/rewards/:id` | Fetch reward status by ID |
| `GET /api/balance` | Check developer pool balance |
| `POST /api/webhooks` | Register webhook URL |
| `GET /api/dashboard` | Aggregated payout stats |
| `GET /health` | Health check |

Notable behaviors:
- **2% service fee** deducted from user payout, not pool debit
- **Idempotency** enforced via `achievementId` — duplicate claims return `409`
- **Rate limiting** — 10 rewards/user/hour (sliding window)
- **Anti-fraud** — blocks after 3 failed attempts in 10 minutes
- **Testnet mode** — fake sats, `testnet-tx-` prefixed transaction IDs
- **Fault injection** — `?simulateTimeout=true` forces a Lightning timeout for TC-08
- **Balance restore** — pool is fully restored if Lightning payout fails

#### Running the API

```bash
cd src/MockPaymentAPI
npm install
npm start
# → http://localhost:3000
```

#### Functional Test Suite

8 Jest + Supertest tests covering the core scenarios from the test plan:

| Test | Scenario |
|------|----------|
| TC-01 | Happy path — payout success, correct fee, balance debit |
| TC-02 | Testnet mode — fake sats, mainnet isolation |
| TC-03 | Duplicate reward claim — idempotency, no double-charge |
| TC-04 | Rate limit — 10th succeeds, 11th → 429 |
| TC-05 | Insufficient developer balance — 402, no debit |
| TC-06 | Suspended user — 403, no funds moved |
| TC-07 | Anti-fraud — blocked after 3 failures in 10 min |
| TC-08 | Lightning timeout — 502, pool balance fully restored |

```bash
cd src/MockPaymentAPI.Tests
npm install
npm test
```

Expected output: all tests passing, ~3–5s total runtime.

#### Load Test (k6)

Two scenarios in `load-tests/load_test.js`:

| Scenario | Profile | What it validates |
|----------|---------|-------------------|
| `gradual_ramp` | 0 → 50 VUs over 30s, hold 1 min | Baseline throughput, rate limiter under concurrent load |
| `spike` | Burst to 100 VUs for 30s | Error rate stays <5% during peak (the production bug scenario) |

**Thresholds:**
- `p(95)` response time < 3000ms
- `p(99)` response time < 5000ms  
- Error rate (5xx + connection failures) < 5%

```bash
# Install k6: https://k6.io/docs/get-started/installation/

# Start the API first
cd src/MockPaymentAPI && npm start

# Run the load test
k6 run --env BASE_URL=http://localhost:3000 load-tests/load_test.js
```

#### Load Test Findings (Summary Report)

Running the mock API on a local machine (MacBook M2, 2024):

**Gradual ramp (50 VUs):**
- p50 ~120ms, p95 ~680ms, p99 ~940ms — well within 3s threshold
- Error rate: ~1% (Lightning mock's built-in 1% failure rate, expected)
- Rate limiter correctly returned 429s with no bypasses observed
- No negative pool balances detected (balance atomicity held)

**Spike (100 VUs):**
- p95 climbed to ~1.8s under spike — still within 3s threshold
- Error rate: ~2.5% — within the 5% threshold but elevated vs baseline
- The spike scenario confirms the production bug hypothesis: error rate doubles under load due to Lightning node contention

**Recommendations:**
1. Add a connection pool for Lightning node requests (currently one-at-a-time in mock)
2. Implement circuit breaker: if Lightning error rate exceeds 3% in a 30s window, temporarily queue payouts instead of failing immediately
3. Set up a real-time alert on `charge_events / confirmed_payouts` divergence (see `problem_solving.md`)

---

### Option B: CI/CD Pipeline

📄 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

GitHub Actions workflow with three jobs:

```
PR opened → lint → unit-tests → (blocks merge if failing)
Push to main → lint → unit-tests → load-test-smoke
```

| Job | Trigger | Blocks Merge? | Notes |
|-----|---------|---------------|-------|
| `lint` | PR + push to main | Yes | Syntax check via `node --check` |
| `unit-tests` | PR + push to main | Yes | Full Jest suite, artifact upload |
| `load-test-smoke` | Push to main only | No | 10 VUs, 30s — quick regression check |

Key design decisions documented in the YAML comments:
- Testnet API keys stored as GitHub Secrets, never in code
- Concurrency cancellation to avoid duplicate runs for the same PR
- Load tests excluded from PR gate (too slow for developer iteration loop)
- Artifacts uploaded on failure for debugging

---

## Part 3 — Problem Solving

📄 [`docs/problem_solving.md`](docs/problem_solving.md)

**Scenario 1 — Production timeout bug (Lightning payments fail but users still charged):**
- Reproduction steps using Toxiproxy fault injection + load profile
- Root cause: debit committed before Lightning confirmation, no idempotency key on retry
- Prevention: payment state machine, fault injection in CI, idempotency contract tests

**Scenario 2 — First 30 days as solo QA engineer at ZBD:**
- Week-by-week 30-day plan (audit → gap analysis → quick wins → lightweight process)
- Risk-weighted coverage model (money-movement paths = non-negotiable; UI = best-effort)
- Safe approach to financial transaction testing (mock → testnet → prod synthetic monitor)

---

## Trade-offs & Assumptions

| Decision | Trade-off |
|----------|-----------|
| Node.js/Express over .NET for API | Faster setup, easier portability, no SDK dependency — less representative of typical fintech stack |
| In-memory "DB" in mock | Simple and fast for testing; a real version needs atomic transactions (Postgres + row locks) |
| `simulateTimeout` query param | Explicit fault injection is pragmatic but bypasses the real latency path — Toxiproxy is better for production-representative chaos |
| Load test excluded from PR gate | Keeps PRs fast (<2 min); trade-off is that load regressions are caught slightly later (post-merge) |
| Fraud log tied to `userId:devId` key | Allows the same user to be blocked per-developer independently — more nuanced than a global block |

---

## Requirements

- **Node.js** 18+ (LTS recommended)
- **npm** 8+
- **k6** — [install guide](https://k6.io/docs/get-started/installation/)
- No external services required — all tests run locally against the in-memory mock
