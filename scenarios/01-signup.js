// Scenario 9.1 — Sign Up
//
// Each iteration registers a brand-new user, so this creates real accounts on
// every run — coordinate with whoever owns test-data cleanup before running
// at full 500-VU scale.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/01-signup.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/01-signup.js

import { sleep } from 'k6';
import { buildOptions, thresholdMs } from '../lib/options.js';
import {
  checkEmailAvailability,
  signUp,
  getCurrentUser,
  sendEmailVerificationCode,
  enrollTotp,
  verifyTotp,
} from '../lib/auth.js';
import { generateTestUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { SLEEP_SECONDS } from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only SignUp would
  // show its own numbers even though all 6 calls in this flow are tagged.
  'http_req_duration{name:CheckEmailAvailability}': [thresholdMs('CHECK_EMAIL_AVAILABILITY_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:GetCurrentUser}': [thresholdMs('GET_CURRENT_USER_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:SendEmailVerificationCode}': [thresholdMs('SEND_EMAIL_VERIFICATION_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:EnrollTotp}': [thresholdMs('ENROLL_TOTP_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
});

const API_LIST = [
  { step: '1. Check email availability', method: 'GET', endpoint: '/auth/emails', description: 'Confirms the email is free before registering' },
  { step: '2. Create account', method: 'POST', endpoint: '/identities', description: 'Registers the new user' },
  { step: '3. Get current user', method: 'GET', endpoint: '/auth/user', description: 'Confirms the new session is active' },
  { step: '4. Send email verification code', method: 'POST', endpoint: '/auth/sendEmailVerificationCode', description: 'Triggers the verification email' },
  { step: '5. Enroll two-factor (TOTP)', method: 'POST', endpoint: '/auth/2fa/totp/secrets', description: 'Sets up 2FA for the account' },
  { step: '6. Verify two-factor code', method: 'POST', endpoint: '/auth/2fa/verify/{code}', description: 'Confirms 2FA enrollment' },
];

export function handleSummary(data) {
  return buildSummary('signup', data, API_LIST);
}

export default function () {
  const user = generateTestUser('perf.signup');

  checkEmailAvailability(user.email);
  sleep(SLEEP_SECONDS);

  if (!signUp(user)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  if (!getCurrentUser()) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  sendEmailVerificationCode(user.email);
  sleep(SLEEP_SECONDS);

  const totpSecret = enrollTotp();
  sleep(SLEEP_SECONDS);
  if (!totpSecret) return;

  if (!verifyTotp(totpSecret)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  // Parsed out of the run's captured output by
  // scripts/build-signup-run-pool.js -- keep this prefix and single-line
  // JSON shape in sync with that script. No extra request needed -- email/
  // password come from generateTestUser(), totpSecret is already fetched as
  // part of the flow above. This account isn't onboarded, so it has no
  // legacy accountId yet -- Sign In only needs email/password/totpSecret to
  // reuse it, which is this pool's whole purpose.
  console.log(
    `SIGNUP_ACCOUNT_CREDENTIAL:${JSON.stringify({ email: user.email, password: user.password, totpSecret })}`
  );
}
