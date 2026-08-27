import http from 'k6/http';
import { check, sleep } from 'k6';
import encoding from 'k6/encoding';
import { url, jsonHeaders } from './http.js';
import { provisionAuthenticatedUser, maybeRefreshSession, refreshSession, resolveAccountIds } from './auth.js';
import {
  generatePersonalInfo,
  generateTaxInfo,
  generateEmploymentInfo,
  generateInvestmentProfile,
  generateDisclosures,
  generateTrustedContact,
  generateEntityInfo,
  generateAssociatedPeople,
} from './users.js';
import {
  SLEEP_SECONDS,
  DEFAULT_ASSET_TYPE,
  ONBOARDING_SIGN_MAX_ATTEMPTS,
  ONBOARDING_SIGN_RETRY_DELAY_SECONDS,
  ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS,
  ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS,
} from '../config/environment.js';

// The 4 required LLC supporting documents, keyed by their confirmed real
// docKey values. certificateOfBeneficialOwnership routes to the modern PIAS
// service and uploads reliably; the other 3 route through the legacy
// user-service backend. Root cause (confirmed with the backend team): the
// upload handler resolves the account via the JWT's accountId claim, which
// can still be the pre-creation value when the token was issued before this
// entity account existed -- refreshSession() right after submit (below)
// fetches a token carrying the correct claim. Backend is also fixing the
// handler to not crash on that lookup coming back empty.
const LLC_REQUIRED_DOCUMENT_KEYS = [
  'signedLLCDocument',
  'llcFormationDocument',
  'certificateOfBeneficialOwnership',
  'authorizedUserDocumentation',
];

// Real, structurally valid PDF, matching what the actual UI sends (confirmed
// via manual testing). open() must run at init time, not inside the
// exported flow function.
const SAMPLE_DOCUMENT_BASE64 = encoding.b64encode(open('../fixtures/sample-document.pdf', 'b'));

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

// Onboarding journey for business-entity accounts (LLC, CORPORATION,
// PARTNERSHIP, TRUST).
export function runEntityOnboardingFlow(accountType, userPrefix) {
  const session = provisionAuthenticatedUser(userPrefix);
  if (!session) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);
  const authState = { lastAuthAt: Date.now() };

  // 1. Registration options (reference data — country codes, document types)
  let res = http.get(url('/registration-options'), { tags: { name: 'RegistrationOptions' } });
  check(res, { 'registration options ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 2. Create the account (minimal — identity data goes in via PUT below).
  res = http.post(url('/uap/v1/accounts'), JSON.stringify({ accountType }), {
    headers: jsonHeaders(),
    tags: { name: 'CreateOnboardingAccount' },
  });
  const createOk = check(res, { 'create onboarding account ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);
  if (!createOk) return;

  const accountId = res.json('id') || res.json('accountId');
  if (!accountId) return;

  // 3. Hydrate / resume — the app calls this on every re-entry
  res = http.get(url(`/uap/v1/accounts/${accountId}`), {
    headers: jsonHeaders(),
    tags: { name: 'GetOnboardingAccountStatus' },
  });
  check(res, { 'get onboarding account status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 4. PUT every step slice, including entityInfo/associatedPeople.
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
    { associatedPeople: generateAssociatedPeople(session.user.email) },
  ];
  for (const slice of slices) {
    res = http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify(slice), {
      headers: jsonHeaders(),
      tags: { name: 'UpdateOnboardingAccount' },
    });
    check(res, { 'update onboarding account slice ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  maybeRefreshSession(authState); // long flow — keep the ~180s session alive for what's left

  // 5. Submit — must run before documents/sign; the backend requires the
  // account already provisioned for both. Success is 201, not 200.
  // Requires associatedPeople's primary person email to match the account's
  // own signup email (see generateAssociatedPeople) or this 503s. That
  // precondition is already satisfied above, so a 503/500 here is the same
  // kind of transient backend flakiness the document upload step below
  // retries through -- retry it the same way rather than failing outright.
  for (let attempt = 1; attempt <= ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS; attempt++) {
    res = http.post(url(`/uap/v1/accounts/${accountId}/submit`), JSON.stringify({}), {
      headers: jsonHeaders(),
      tags: { name: 'SubmitOnboardingAccount' },
    });
    if ((res.status !== 503 && res.status !== 500) || attempt === ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS) break;
    sleep(ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS);
  }
  check(res, { 'submit onboarding account ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);

  // Force a fresh token before any document upload -- per the backend team,
  // the upload handler resolves the account from the JWT's accountId claim,
  // which the token issued earlier in this flow may predate (see
  // LLC_REQUIRED_DOCUMENT_KEYS above). An unconditional refresh here (not
  // the periodic maybeRefreshSession) guarantees the claim is current.
  refreshSession();
  sleep(SLEEP_SECONDS);

  // 6. Upload the 4 required LLC supporting documents (see
  // LLC_REQUIRED_DOCUMENT_KEYS for the confirmed root cause); retry through
  // any remaining flakiness rather than treat it as a hard failure,
  // refreshing the session periodically since this loop can run long.
  for (const docKey of LLC_REQUIRED_DOCUMENT_KEYS) {
    for (let attempt = 1; attempt <= ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS; attempt++) {
      maybeRefreshSession(authState);
      res = http.post(
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
      if ((res.status !== 503 && res.status !== 500) || attempt === ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS) break;
      sleep(ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS);
    }
    check(res, { 'upload document ok': (r) => r.status === 200 || r.status === 201 });
    sleep(SLEEP_SECONDS);
  }

  // 7. Sign agreements — fires KYC downstream.
  const signBody = JSON.stringify({ customerAgreements: generateCustomerAgreements() });
  for (let attempt = 1; attempt <= ONBOARDING_SIGN_MAX_ATTEMPTS; attempt++) {
    maybeRefreshSession(authState);
    res = http.post(url(`/uap/v1/accounts/${accountId}/sign`), signBody, {
      headers: jsonHeaders(),
      tags: { name: 'SignOnboardingAgreements' },
    });
    if ((res.status !== 422 && res.status !== 408) || attempt === ONBOARDING_SIGN_MAX_ATTEMPTS) break;
    sleep(ONBOARDING_SIGN_RETRY_DELAY_SECONDS);
  }
  const signOk = check(res, { 'sign onboarding agreements ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);

  if (signOk) {
    // session.accountId is stale (null -- captured at signup, before
    // onboarding) -- the legacy user-service account only links up once
    // sign succeeds, so re-resolve it now. One extra call, only on success.
    const ids = resolveAccountIds();
    // Parsed out of the run's captured output by
    // scripts/build-onboarding-run-pool.js -- keep this prefix and
    // single-line JSON shape in sync with that script.
    console.log(
      `ONBOARDING_ENTITY_ACCOUNT_CREDENTIAL:${JSON.stringify({
        email: session.user.email,
        password: session.user.password,
        accountId: ids && ids.userServiceAccountId,
        uapAccountId: accountId,
        totpSecret: session.totpSecret,
      })}`
    );
  }

  // 8. KYC verdict — polled after sign (sign is what triggers it).
  res = http.get(url(`/uap/v1/accounts/${accountId}/kyc`), {
    headers: jsonHeaders(),
    tags: { name: 'GetOnboardingKyc' },
  });
  check(res, { 'get onboarding kyc ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 9. Trading-status gating verdict (heaviest read in the platform).
  res = http.get(
    url(`/uap/v1/accounts/${accountId}/trading-status?platform=primary&assetType=${DEFAULT_ASSET_TYPE}`),
    { headers: jsonHeaders(), tags: { name: 'GetOnboardingTradingStatus' } }
  );
  check(res, { 'get onboarding trading status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
