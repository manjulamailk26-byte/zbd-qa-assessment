# Test Plan: Rewards SDK — Achievement-Based Bitcoin Payouts

**Author:** Senior QA Engineer  
**Date:** April 2026  
**Version:** 1.0

---

## 1. Test Scope

### What I'd Prioritize (Must Test Now)

| Area | Reason |
|------|--------|
| Payout correctness (sat amounts, fees) | Real money — wrong amounts = direct financial loss |
| Rate limiting enforcement | Core fraud vector if broken |
| Anti-fraud detection (3-strike rule) | Abuse can drain developer reward pool fast |
| Insufficient balance handling | Charging users when payout can't complete = legal/trust issue |
| Webhook reliability | Silent failures mean developers can't reconcile payouts |
| Testnet vs. Mainnet isolation | Accidental real-money payouts in dev = serious incident |

### What I'd Defer (Later Sprints)

| Area | Reason to Defer |
|------|----------------|
| Dashboard UI/UX tests | Business-critical payout flow comes first |
| All supported device/browser combos | Not blocking for API-layer correctness |
| Extensive load testing beyond baseline | Nice to have at launch; scale testing can follow first release |
| Full i18n/localization | No mention of multi-locale in PRD |

---

## 2. Critical Test Scenarios

| Test ID | Scenario | Steps / Conditions | Expected Result | Priority |
|---------|----------|--------------------|-----------------|----------|
| TC-01 | **Happy Path — Successful Payout** | Valid user, valid event, funded pool (>100k sats), 2% fee applied | Payout of correct sat amount lands in ZBD wallet ≤60s; webhook fires `success` | P0 |
| TC-02 | **2% Service Fee Accuracy** | Reward defined as 1,000 sats | User receives 980 sats; developer pool debited 1,000 sats; fee logged | P0 |
| TC-03 | **Rate Limit — 10 Rewards/User/Hour** | Send 11 reward events for the same user within 60 min | 10th request succeeds; 11th returns HTTP 429 with reset-time header | P0 |
| TC-04 | **Insufficient Developer Balance** | Trigger reward when pool balance < payout amount | Payout rejected with clear error; user NOT charged; webhook fires `failed` | P0 |
| TC-05 | **Duplicate Reward Claim** | Re-submit the exact same achievement event ID twice | Second call returns idempotency error (e.g., 409 Conflict); no double payout | P0 |
| TC-06 | **Anti-Fraud — 3 Failed Attempts in 10 Min** | Force 3 failed payout attempts within 10-min window for one user | User blocked on 3rd failure; subsequent attempts return 403 for remainder of window | P0 |
| TC-07 | **User Account Suspended** | Trigger payout for a suspended ZBD user | API rejects with 403 status; no funds move; webhook fires `user_suspended` | P1 |
| TC-08 | **Webhook Endpoint Down** | Register a dead webhook URL; trigger payout | System retries webhook (at least 3x with backoff); payout still completes; retry log recorded | P1 |
| TC-09 | **Testnet Mode — No Real Sats** | Configure SDK in `testnet: true`; trigger reward | Fake sats issued; mainnet Lightning node never called; clear testnet indicator in response | P0 |
| TC-10 | **Poor Network — Timeout During Payout** | Simulate Lightning node latency >60s using fault injection | API returns timeout error; user NOT double-charged on retry; idempotency key prevents duplicate send | P0 |

---

## 3. Test Environment Strategy

### The Core Rule: Never Risk Real Sats in Dev/Staging

```
[Local Dev]  →  SDK testnet=true  →  Mock Lightning node (no real wallet)
[Staging]    →  ZBD Sandbox env  →  Real testnet BTC (worthless)
[Production] →  Mainnet          →  Real BTC — canary releases only
```

**Testnet setup:**
- Use ZBD's Sandbox API (or similar Lightning testnet) — all sat amounts are valueless
- Maintain a dedicated staging developer account pre-funded with testnet sats only
- Separate API keys per environment; CI/CD pipeline uses only testnet credentials stored as secrets
- Canary deploys to prod with a small synthetic monitor (1 sat payout to internal ZBD wallet) to confirm mainnet still works — not a full regression suite

**Fault injection:**
- Use a local proxy (e.g., Toxiproxy) to simulate timeouts, packet loss, and connection resets against the Lightning node endpoint — allows TC-10 without touching prod infrastructure

**Data isolation:**
- Each test run creates its own developer account + reward pool (via API setup calls)
- Teardown deletes or resets pool after each suite — no cross-test contamination

---

## 4. Key Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| R1 | **Timeout causes double-payout** — user gets BTC twice if client retries on error | Medium | High (financial loss) | Enforce idempotency keys on every payout call; test TC-10 explicitly in CI |
| R2 | **Testnet/Mainnet credential leak** — CI/CD accidentally uses mainnet key | Low | Critical | Separate secret namespaces; environment guard check in SDK startup that asserts `NODE_ENV` before allowing mainnet key |
| R3 | **Anti-fraud window resets incorrectly** — sliding vs fixed window bug lets attackers bypass 3-strike rule | Medium | High (fraud drain) | Test boundary conditions: 2 failures at t=0, 1 failure at t=9:59 (still blocked), 1 failure at t=10:01 (window reset) |
| R4 | **Webhook delivery silently drops** — developer never reconciles failed payouts | Medium | Medium (trust/ops) | Monitor retry queue depth; test TC-08 in staging; alert on undelivered webhooks >5 min old |
| R5 | **Pool depletion race condition** — two concurrent payouts against near-empty balance both succeed | Low | High (negative balance) | Test concurrent requests against pool balance of exactly 1 sat above payout amount; verify atomic debit |

---

## 5. Assumptions

- ZBD provides a sandbox/testnet environment with equivalent API behavior to production
- "Within 60 seconds" is a P99 SLA, not an average — tested under realistic load
- Idempotency key is caller-supplied (per industry standard) or SDK-auto-generated from event ID
- "Failed attempt" for anti-fraud means a payout attempt that errors, not a network blip before the request reaches the server
