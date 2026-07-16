// Scenario 9.1 — Sign In
//
// Models the actual Sign In screen flow:
//   1. Enter email + password -> submit
//   2. Enter mobile OTP, tap verify button -> verify 2FA code
//   3. Navigate to portfolio screen — out of scope here, see scenarios/03-invest-wire.js
//
// Distinct from scenarios/01-signup.js (new registration) since it's a
// different journey and, in real traffic, a far higher-volume one.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/01b-signin.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/01b-signin.js
//
// Requires a pool of already-registered accounts in staging (see
// TEST_USER_POOL_* in config/environment.js) — 500 VUs signing into one
// shared account isn't realistic and will collide on sessions/rate limits.
// Seed the pool first, e.g. by running scenarios/01-signup.js with a matching
// email pattern/password ahead of time.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn } from '../lib/auth.js';
import { pickPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { TEST_2FA_CODE, SLEEP_SECONDS } from '../config/environment.js';

export const options = buildOptions({
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
});

export function handleSummary(data) {
  return buildSummary('signin', data);
}

export default function () {
  const user = pickPooledUser();

  // 1. Enter email + password, submit
  const token = signIn(user);
  sleep(SLEEP_SECONDS);
  if (!token) return;

  // 2. Enter mobile OTP, tap verify button
  const res = http.post(
    url(`/auth/2fa/verify/${TEST_2FA_CODE}`),
    null,
    // TODO: real SMS codes can't be scripted — confirm a fixed test/bypass OTP for staging.
    { headers: jsonHeaders(token), tags: { name: 'Verify2FACode' } }
  );
  check(res, { 'verify 2fa ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 3. Navigate to portfolio screen — out of scope here.
}
