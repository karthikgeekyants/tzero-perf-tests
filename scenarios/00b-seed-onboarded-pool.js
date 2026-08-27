// Seeds a pool of accounts that have actually been through Individual
// onboarding (through sign — not waiting on the async KYC verdict), for
// Invest via Wire / Trade via Wallet. Those scenarios need a resolvable
// PIAS account id (only exists once onboarding agreements are signed);
// the general TEST_USER_POOL_* accounts (scenarios/00-seed-user-pool.js)
// are signed-up-only and 404 on account resolution.
//
// This is a one-time SETUP script, not a load/stress test — it runs exactly
// ONBOARDED_POOL_SIZE iterations (not per-VU), each: signing up one pooled
// account (email matching ONBOARDED_POOL_EMAIL_PATTERN), enrolling +
// verifying TOTP, then running it through onboarding up to (and including)
// signing agreements. KYC verdict/trading-status are NOT polled or waited
// on here — per instruction, this pool doesn't need KYC-approved accounts,
// just accounts far enough along to have a PIAS account id.
//
// Same secret-capture mechanic as scenarios/00-seed-user-pool.js: each
// successfully-signed account logs a POOL_SECRET line; capture the run's
// output and turn it into config/onboarded-pool-secrets.json with
// scripts/build-onboarded-pool-secrets.js.
//
// Run once before running Invest via Wire / Trade via Wallet at scale:
//   k6 run scenarios/00b-seed-onboarded-pool.js > reports/seed-onboarded-output.log 2>&1
//   node scripts/build-onboarded-pool-secrets.js reports/seed-onboarded-output.log
//
// Re-running is safe but wasteful for accounts already seeded — "sign up"
// will just fail with "email already registered" for those (and won't emit
// a POOL_SECRET line for them).

import exec from 'k6/execution';
import http from 'k6/http';
import { sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { completeSignUp, maybeRefreshSession } from '../lib/auth.js';
import {
  generatePersonalInfo,
  generateTaxInfo,
  generateEmploymentInfo,
  generateInvestmentProfile,
  generateDisclosures,
  generateTrustedContact,
} from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import {
  ONBOARDED_POOL_SIZE,
  ONBOARDED_POOL_EMAIL_PATTERN,
  ONBOARDED_POOL_PASSWORD,
  SIGNUP_CLIENT_ID,
  SIGNUP_CLIENT_NAME,
  SIGNUP_PLATFORM,
  SLEEP_SECONDS,
  SEED_VUS,
  ONBOARDING_SIGN_MAX_ATTEMPTS,
  ONBOARDING_SIGN_RETRY_DELAY_SECONDS,
} from '../config/environment.js';

export const options = {
  scenarios: {
    seed_onboarded_pool: {
      executor: 'shared-iterations',
      vus: SEED_VUS,
      iterations: ONBOARDED_POOL_SIZE,
      maxDuration: __ENV.SEED_MAX_DURATION || '60m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.2'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function handleSummary(data) {
  return buildSummary('seed-onboarded-pool', data);
}

function generateCustomerAgreements() {
  return {
    webTermsConditions: true,
    disclosureStatement: true,
    feeSchedule: true,
    cryptoAgreement: true,
    ecbsvAgreement: true,
    ptCryptoCustodialAgreement: true,
  };
}

export default function () {
  // Globally unique across all VUs/iterations, unlike __VU/__ITER, so every
  // pooled account gets exactly one deterministic slot (1..ONBOARDED_POOL_SIZE).
  const poolIndex = exec.scenario.iterationInTest + 1;

  const user = {
    email: ONBOARDED_POOL_EMAIL_PATTERN.replace('{n}', poolIndex),
    password: ONBOARDED_POOL_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    clientName: SIGNUP_CLIENT_NAME,
    platform: SIGNUP_PLATFORM,
  };

  const session = completeSignUp(user);
  if (!session) return;
  sleep(SLEEP_SECONDS);
  const authState = { lastAuthAt: Date.now() };

  // Create the account (same shape as lib/onboarding-individual.js).
  const personalInfo = generatePersonalInfo();
  const addressShape = {
    street: personalInfo.addressLine1,
    city: personalInfo.city,
    state: personalInfo.state,
    postalCode: personalInfo.zip,
    country: personalInfo.country,
  };
  const personalInfoBody = {
    firstName: personalInfo.firstName,
    lastName: personalInfo.lastName,
    dob: personalInfo.dob,
    citizenshipCountry: personalInfo.citizenshipCountry,
    phoneNumber: personalInfo.phoneNumber,
  };
  const addressBody = { physicalAddress: addressShape, mailingAddress: addressShape };
  const taxInfoBody = generateTaxInfo();

  let res = http.post(
    url('/uap/v1/accounts'),
    JSON.stringify({ accountType: 'INDIVIDUAL', personalInfo: personalInfoBody, address: addressBody, taxInfo: taxInfoBody }),
    { headers: jsonHeaders(), tags: { name: 'CreateOnboardingAccount' } }
  );
  if (res.status !== 200 && res.status !== 201) return;
  const accountId = res.json('id') || res.json('accountId');
  if (!accountId) return;
  sleep(SLEEP_SECONDS);

  const employmentBody = generateEmploymentInfo();
  const investmentProfileBody = generateInvestmentProfile();
  const disclosuresBody = generateDisclosures();

  const remainingSlices = [
    { employment: employmentBody },
    { investmentProfile: investmentProfileBody, disclosures: disclosuresBody },
    { trustedContact: generateTrustedContact() },
  ];
  for (const slice of remainingSlices) {
    http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify(slice), {
      headers: jsonHeaders(),
      tags: { name: 'UpdateOnboardingAccount' },
    });
    sleep(SLEEP_SECONDS);
  }

  maybeRefreshSession(authState);

  // Same known-issue resend as lib/onboarding-individual.js — clears the
  // intermittent 422 on investorPurpose/illiquidAssets before signing.
  http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify({ employment: employmentBody }), {
    headers: jsonHeaders(),
    tags: { name: 'ResendEmploymentBeforeSign' },
  });
  sleep(SLEEP_SECONDS);
  http.put(
    url(`/uap/v1/accounts/${accountId}`),
    JSON.stringify({ investmentProfile: investmentProfileBody, disclosures: disclosuresBody }),
    { headers: jsonHeaders(), tags: { name: 'ResendInvestmentProfileBeforeSign' } }
  );
  sleep(SLEEP_SECONDS);

  // Same retry as lib/onboarding-individual.js's sign step -- this call
  // intermittently 422s (secondary account not yet provisioned) or 408s
  // (transient timeout); without retrying here, that known flakiness
  // silently drops accounts from the pool below ONBOARDED_POOL_SIZE.
  const signBody = JSON.stringify({ customerAgreements: generateCustomerAgreements() });
  for (let attempt = 1; attempt <= ONBOARDING_SIGN_MAX_ATTEMPTS; attempt++) {
    res = http.post(url(`/uap/v1/accounts/${accountId}/sign`), signBody, {
      headers: jsonHeaders(),
      tags: { name: 'SignOnboardingAgreements' },
    });
    if ((res.status !== 422 && res.status !== 408) || attempt === ONBOARDING_SIGN_MAX_ATTEMPTS) break;
    sleep(ONBOARDING_SIGN_RETRY_DELAY_SECONDS);
  }
  if (res.status !== 200 && res.status !== 201) return;

  // Parsed out of the run's captured output by
  // scripts/build-onboarded-pool-secrets.js -- keep this prefix and
  // single-line JSON shape in sync with that script.
  // legalName is captured here (not re-derived later) so downstream flows
  // that need to match a signature against the account's real name --
  // e.g. Invest via Wire's MSA signature -- use the actual generated name
  // instead of a generic config default.
  console.log(
    `ONBOARDED_POOL_SECRET:${JSON.stringify({
      index: poolIndex,
      totpSecret: session.totpSecret,
      legalName: `${personalInfo.firstName} ${personalInfo.lastName}`,
    })}`
  );
}
