import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from './http.js';
import { provisionAuthenticatedUser } from './auth.js';
import { SLEEP_SECONDS } from '../config/environment.js';

const EMAIL_VERIFICATION_CODE = __ENV.EMAIL_VERIFICATION_CODE || '000000';
// TODO: real verification emails can't be scripted — confirm a fixed test/bypass
// email verification code for preprod with the backend team.

// Shared by scenarios/02-onboarding-individual.js and
// scenarios/02-onboarding-entity.js so the 8-step onboarding journey (9.2)
// isn't duplicated between the two account types — only the account payload differs.
export function runOnboardingFlow(accountType, userPrefix) {
  const session = provisionAuthenticatedUser(userPrefix);
  if (!session) {
    sleep(SLEEP_SECONDS);
    return;
  }
  const { token, user } = session;
  sleep(SLEEP_SECONDS);

  // 1. Registration options
  let res = http.get(url('/registration-options'), { tags: { name: 'RegistrationOptions' } });
  check(res, { 'registration options ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 2. Send email verification code
  res = http.post(
    url('/auth/sendEmailVerificationCode'),
    JSON.stringify({ email: user.email }),
    { headers: jsonHeaders(token), tags: { name: 'SendEmailVerificationCode' } }
  );
  check(res, { 'send email verification code ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 3. Verify email code
  res = http.post(
    url('/auth/verifyEmailCode'),
    JSON.stringify({ email: user.email, code: EMAIL_VERIFICATION_CODE }),
    { headers: jsonHeaders(token), tags: { name: 'VerifyEmailCode' } }
  );
  check(res, { 'verify email code ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 4. Create/update onboarding account
  res = http.post(
    url('/uap/v1/accounts'),
    JSON.stringify({ accountType }),
    // TODO: confirm the exact accountType enum value expected by the API, plus
    // the rest of the required payload for this account type (personal details
    // for an individual; entity name/EIN/authorized signer for an entity, etc.)
    // once the /uap/v1/accounts contract is confirmed.
    { headers: jsonHeaders(token), tags: { name: 'CreateOnboardingAccount' } }
  );
  const createOk = check(res, { 'create onboarding account ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);
  if (!createOk) return;

  const accountId = res.json('id') || res.json('accountId');
  // TODO: confirm the actual account id field name returned by POST /uap/v1/accounts.
  if (!accountId) return;

  // 5. Get onboarding account status
  res = http.get(url(`/uap/v1/accounts/${accountId}`), {
    headers: jsonHeaders(token),
    tags: { name: 'GetOnboardingAccountStatus' },
  });
  check(res, { 'get onboarding account status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 6. Sign onboarding agreements
  res = http.post(
    url(`/uap/v1/accounts/${accountId}/sign`),
    JSON.stringify({}), // TODO: confirm the required agreement/signature payload.
    { headers: jsonHeaders(token), tags: { name: 'SignOnboardingAgreements' } }
  );
  check(res, { 'sign onboarding agreements ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 7. Get UAP user/account summary
  res = http.get(url('/uap/v1/me'), { headers: jsonHeaders(token), tags: { name: 'GetUapSummary' } });
  check(res, { 'get uap summary ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 8. Run onboarding KYC
  res = http.post(
    url(`/uap/v1/accounts/${accountId}/kyc`),
    JSON.stringify({}), // TODO: confirm the required KYC payload.
    { headers: jsonHeaders(token), tags: { name: 'RunOnboardingKYC' } }
  );
  check(res, { 'run onboarding kyc ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
