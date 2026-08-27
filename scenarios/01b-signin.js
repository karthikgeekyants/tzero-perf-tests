// Scenario 9.1 — Sign In
//
// Requires the pool seeded first — see README's "Test user pool" section
// (scenarios/00-seed-user-pool.js, then scripts/build-pool-secrets.js to
// capture each pooled account's TOTP secret into config/pool-secrets.json).
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/01b-signin.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/01b-signin.js

import { sleep } from 'k6';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn, verifyTotp, getCurrentUser, resolveAccountIds, logout } from '../lib/auth.js';
import { pickPooledUser, pickCapturedSignupPoolUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { SLEEP_SECONDS, SIGNIN_SOURCE } from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only SignIn would
  // show its own numbers even though all 5 calls in this flow are tagged.
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:GetCurrentUser}': [thresholdMs('GET_CURRENT_USER_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:Logout}': [thresholdMs('LOGOUT_P95_THRESHOLD_MS', 500)],
});

const API_LIST = [
  { step: '1. Sign in', method: 'POST', endpoint: '/auth/login', description: 'Authenticates the returning user' },
  { step: '2. Verify two-factor code', method: 'POST', endpoint: '/auth/2fa/verify/{code}', description: 'Confirms 2FA for this session' },
  { step: '3. Get current user', method: 'GET', endpoint: '/auth/user', description: 'Confirms the session is active' },
  { step: '4. Resolve account IDs', method: 'GET', endpoint: '/uap/v1/me', description: 'Looks up the account (404 expected — pooled accounts aren’t onboarded)' },
  { step: '5. Logout', method: 'POST', endpoint: '/auth/logout', description: 'Ends the session' },
];

export function handleSummary(data) {
  return buildSummary('signin', data, API_LIST);
}

export default function () {
  const user = SIGNIN_SOURCE === 'CAPTURED' ? pickCapturedSignupPoolUser() : pickPooledUser();
  if (!user.totpSecret) {
    console.error(
      SIGNIN_SOURCE === 'CAPTURED'
        ? `No TOTP secret for ${user.email} — run scenarios/01-signup.js and scripts/build-signup-run-pool.js first (SIGNIN_SOURCE=CAPTURED).`
        : `No TOTP secret for ${user.email} — seed the pool first (README's "Test user pool" section).`
    );
    return;
  }

  if (!signIn(user)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  if (!verifyTotp(user.totpSecret)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  getCurrentUser();
  sleep(SLEEP_SECONDS);

  resolveAccountIds(); // 404 expected — pooled accounts aren't onboarded
  sleep(SLEEP_SECONDS);

  logout();
  sleep(SLEEP_SECONDS);
}
