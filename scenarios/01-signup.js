// Scenario 9.1 — Sign Up
//
// Models the actual Sign Up screen flow:
//   1. Enter email -> check availability
//   2. Enter password + confirm password -> submit registration
//   3. Sign in to establish a session (self-register doesn't return a token directly)
//   4. Enter phone number, tap "Send code" -> request SMS 2FA code
//   5. Enter received code -> verify 2FA code
//   6. Navigate to portfolio screen — out of scope here, see scenarios/03-invest-wire.js
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/01-signup.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/01-signup.js
//
// Each iteration registers a brand-new user (email + phone must be unique), so
// this scenario creates real accounts in staging on every run — coordinate
// with whoever owns test-data cleanup before running at full 500-VU scale.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signUp, signIn, verifyPhoneOtp } from '../lib/auth.js';
import { generateTestUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { SLEEP_SECONDS } from '../config/environment.js';

export const options = buildOptions({
  'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
});

export function handleSummary(data) {
  return buildSummary('signup', data);
}

export default function () {
  const user = generateTestUser('perf.signup');

  // 1. Check email availability (as the user types their email)
  let res = http.get(url(`/auth/emails?email=${encodeURIComponent(user.email)}`), {
    tags: { name: 'CheckEmailAvailability' },
  });
  check(res, { 'email availability check ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 2. Enter password + confirm password, submit registration
  const signUpOk = signUp(user);
  sleep(SLEEP_SECONDS);
  if (!signUpOk) return;

  // 3. Sign in to establish a session
  const token = signIn(user);
  sleep(SLEEP_SECONDS);
  if (!token) return;

  // 4-5. Enter phone number, tap "Send code", then enter the received code and verify
  verifyPhoneOtp(token, user.phone);
  sleep(SLEEP_SECONDS);

  // 6. Navigate to portfolio screen — out of scope here.
}
