// Seeds the pool of pre-registered accounts that Sign In, Invest, Trade, and
// Order History scenarios sign in as (see TEST_USER_POOL_* in
// config/environment.js) — those scenarios can't realistically share one
// login across hundreds of VUs, so this creates TEST_USER_POOL_SIZE real
// accounts in staging ahead of time.
//
// This is a one-time SETUP script, not a load/stress test — it runs exactly
// TEST_USER_POOL_SIZE iterations (not per-VU), each registering one pooled
// account (email matching TEST_USER_POOL_EMAIL_PATTERN) and verifying its
// phone/OTP so it's immediately usable for Sign In.
//
// It does NOT run onboarding/KYC — those pooled accounts are ready for Sign
// In but not yet "investment-eligible" for Invest via Wire / Trade via
// Wallet. That's a separate follow-up once KYC approval turnaround is
// confirmed with backend (KYC review may be async, so onboarding all 500
// accounts here wouldn't guarantee they're approved by the time this finishes).
//
// Run once before running Sign In / Invest / Trade / Order History at scale:
//   k6 run -e BASE_URL=https://... scenarios/00-seed-user-pool.js
//
// Re-running is safe but wasteful — it'll just fail each "sign up" step with
// "email already registered" once the pool already exists.

import exec from 'k6/execution';
import { signUpAndSignIn, verifyPhoneOtp } from '../lib/auth.js';
import { generatePhone } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { TEST_USER_POOL_SIZE, TEST_USER_POOL_EMAIL_PATTERN, TEST_USER_POOL_PASSWORD, SEED_VUS } from '../config/environment.js';

export const options = {
  scenarios: {
    seed_user_pool: {
      executor: 'shared-iterations',
      vus: SEED_VUS,
      iterations: TEST_USER_POOL_SIZE,
      maxDuration: __ENV.SEED_MAX_DURATION || '30m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

export function handleSummary(data) {
  return buildSummary('seed-user-pool', data);
}

export default function () {
  // Globally unique across all VUs/iterations, unlike __VU/__ITER, so every
  // pooled account gets exactly one deterministic slot (1..TEST_USER_POOL_SIZE).
  const poolIndex = exec.scenario.iterationInTest + 1;

  const user = {
    email: TEST_USER_POOL_EMAIL_PATTERN.replace('{n}', poolIndex),
    password: TEST_USER_POOL_PASSWORD,
    confirmPassword: TEST_USER_POOL_PASSWORD,
    phone: generatePhone(),
  };

  const session = signUpAndSignIn(user);
  if (!session) return;

  verifyPhoneOtp(session.token, user.phone);
}
