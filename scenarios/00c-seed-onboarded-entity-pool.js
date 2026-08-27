// Seeds a pool of accounts that have actually been through Entity
// onboarding (through sign — not waiting on the async KYC verdict), for
// Invest via Wire / Trade via Wallet when testing with entity accounts.
// Same rationale as scenarios/00b-seed-onboarded-pool.js (the general
// TEST_USER_POOL_* / individual-onboarded pools 404 on account resolution
// for this purpose) — this is the Entity-flavored counterpart, since entity
// onboarding needs its own slices (entityInfo/associatedPeople), document
// upload, and a submit step the individual pool script doesn't do.
//
// This is a one-time SETUP script, not a load/stress test — it runs exactly
// ONBOARDED_ENTITY_POOL_SIZE iterations (not per-VU), each: signing up one
// pooled account (email matching ONBOARDED_ENTITY_POOL_EMAIL_PATTERN),
// enrolling + verifying TOTP, then running it through entity onboarding up
// to (and including) signing agreements. KYC verdict/trading-status are NOT
// polled or waited on here, same as the individual pool script.
//
// Same secret-capture mechanic as the other seed scripts: each
// successfully-signed account logs an ONBOARDED_ENTITY_POOL_SECRET line;
// capture the run's output and turn it into
// config/onboarded-entity-pool-secrets.json with
// scripts/build-onboarded-entity-pool-secrets.js.
//
// Run once before running Invest via Wire / Trade via Wallet with entity accounts:
//   k6 run scenarios/00c-seed-onboarded-entity-pool.js > reports/seed-onboarded-entity-output.log 2>&1
//   node scripts/build-onboarded-entity-pool-secrets.js reports/seed-onboarded-entity-output.log
//
// Re-running is safe but wasteful for accounts already seeded — "sign up"
// will just fail with "email already registered" for those (and won't emit
// a secret line for them).

import exec from 'k6/execution';
import http from 'k6/http';
import encoding from 'k6/encoding';
import { sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { completeSignUp, maybeRefreshSession, refreshSession } from '../lib/auth.js';
import {
  generatePersonalInfo,
  generateTaxInfo,
  generateEmploymentInfo,
  generateInvestmentProfile,
  generateDisclosures,
  generateTrustedContact,
  generateEntityInfo,
  generateAssociatedPeople,
} from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import {
  ONBOARDED_ENTITY_POOL_SIZE,
  ONBOARDED_ENTITY_POOL_EMAIL_PATTERN,
  ONBOARDED_ENTITY_POOL_PASSWORD,
  ONBOARDING_ENTITY_ACCOUNT_TYPE,
  ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS,
  ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS,
  ONBOARDING_SIGN_MAX_ATTEMPTS,
  ONBOARDING_SIGN_RETRY_DELAY_SECONDS,
  SIGNUP_CLIENT_ID,
  SIGNUP_CLIENT_NAME,
  SIGNUP_PLATFORM,
  SLEEP_SECONDS,
  SEED_VUS,
} from '../config/environment.js';

// Same 4 required LLC documents as lib/onboarding-entity.js.
const LLC_REQUIRED_DOCUMENT_KEYS = [
  'signedLLCDocument',
  'llcFormationDocument',
  'certificateOfBeneficialOwnership',
  'authorizedUserDocumentation',
];

const SAMPLE_DOCUMENT_BASE64 = encoding.b64encode(open('../fixtures/sample-document.pdf', 'b'));

export const options = {
  scenarios: {
    seed_onboarded_entity_pool: {
      executor: 'shared-iterations',
      vus: SEED_VUS,
      iterations: ONBOARDED_ENTITY_POOL_SIZE,
      maxDuration: __ENV.SEED_MAX_DURATION || '60m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.2'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function handleSummary(data) {
  return buildSummary('seed-onboarded-entity-pool', data);
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
  // pooled account gets exactly one deterministic slot (1..ONBOARDED_ENTITY_POOL_SIZE).
  const poolIndex = exec.scenario.iterationInTest + 1;

  const user = {
    email: ONBOARDED_ENTITY_POOL_EMAIL_PATTERN.replace('{n}', poolIndex),
    password: ONBOARDED_ENTITY_POOL_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    clientName: SIGNUP_CLIENT_NAME,
    platform: SIGNUP_PLATFORM,
  };

  const session = completeSignUp(user);
  if (!session) return;
  sleep(SLEEP_SECONDS);
  const authState = { lastAuthAt: Date.now() };

  // Create the account (minimal — identity data goes in via PUT below, same as lib/onboarding-entity.js).
  let res = http.post(url('/uap/v1/accounts'), JSON.stringify({ accountType: ONBOARDING_ENTITY_ACCOUNT_TYPE }), {
    headers: jsonHeaders(),
    tags: { name: 'CreateOnboardingAccount' },
  });
  if (res.status !== 200 && res.status !== 201) return;
  const accountId = res.json('id') || res.json('accountId');
  if (!accountId) return;
  sleep(SLEEP_SECONDS);

  const personalInfo = generatePersonalInfo();
  const addressShape = {
    street: personalInfo.addressLine1,
    city: personalInfo.city,
    state: personalInfo.state,
    postalCode: personalInfo.zip,
    country: personalInfo.country,
  };
  const slices = [
    {
      personalInfo: {
        firstName: personalInfo.firstName,
        lastName: personalInfo.lastName,
        dob: personalInfo.dob,
        citizenshipCountry: personalInfo.citizenshipCountry,
        phoneNumber: personalInfo.phoneNumber,
      },
    },
    { address: { physicalAddress: addressShape, mailingAddress: addressShape } },
    { taxInfo: generateTaxInfo() },
    { employment: generateEmploymentInfo() },
    { investmentProfile: generateInvestmentProfile(), disclosures: generateDisclosures() },
    { trustedContact: generateTrustedContact() },
    { entityInfo: generateEntityInfo() },
    { associatedPeople: generateAssociatedPeople(user.email) },
  ];
  for (const slice of slices) {
    http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify(slice), {
      headers: jsonHeaders(),
      tags: { name: 'UpdateOnboardingAccount' },
    });
    sleep(SLEEP_SECONDS);
  }

  maybeRefreshSession(authState);

  // Submit — must run before documents/sign, same as lib/onboarding-entity.js.
  res = http.post(url(`/uap/v1/accounts/${accountId}/submit`), JSON.stringify({}), {
    headers: jsonHeaders(),
    tags: { name: 'SubmitOnboardingAccount' },
  });
  if (res.status !== 200 && res.status !== 201) return;
  sleep(SLEEP_SECONDS);

  // Force a fresh token before document upload -- same reason as lib/onboarding-entity.js.
  refreshSession();
  sleep(SLEEP_SECONDS);

  for (const docKey of LLC_REQUIRED_DOCUMENT_KEYS) {
    let uploadRes;
    for (let attempt = 1; attempt <= ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS; attempt++) {
      maybeRefreshSession(authState);
      uploadRes = http.post(
        url(`/uap/v1/accounts/${accountId}/documents`),
        JSON.stringify({
          filename: `${docKey}.pdf`,
          contentType: 'application/pdf',
          contentBase64: SAMPLE_DOCUMENT_BASE64,
          docKey,
          subject: 'ENTITY',
        }),
        { headers: jsonHeaders(), tags: { name: 'UploadDocument' } }
      );
      if ((uploadRes.status !== 503 && uploadRes.status !== 500) || attempt === ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS) break;
      sleep(ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS);
    }
    if (uploadRes.status !== 200 && uploadRes.status !== 201) return;
    sleep(SLEEP_SECONDS);
  }

  // Same retry as lib/onboarding-entity.js's sign step -- this call
  // intermittently 422s (secondary account not yet provisioned) or 408s
  // (transient timeout); without retrying here, that known flakiness
  // silently drops accounts from the pool below ONBOARDED_ENTITY_POOL_SIZE
  // (this is what caused indices 60/150/188/189 to come up short earlier).
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
  // scripts/build-onboarded-entity-pool-secrets.js -- keep this prefix and
  // single-line JSON shape in sync with that script.
  console.log(`ONBOARDED_ENTITY_POOL_SECRET:${JSON.stringify({ index: poolIndex, totpSecret: session.totpSecret })}`);
}
