import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from './http.js';
import { provisionAuthenticatedUser, maybeRefreshSession, resolveAccountIds } from './auth.js';
import {
  generatePersonalInfo,
  generateTaxInfo,
  generateEmploymentInfo,
  generateInvestmentProfile,
  generateDisclosures,
  generateTrustedContact,
} from './users.js';
import {
  SLEEP_SECONDS,
  DEFAULT_ASSET_TYPE,
  ONBOARDING_SIGN_MAX_ATTEMPTS,
  ONBOARDING_SIGN_RETRY_DELAY_SECONDS,
} from '../config/environment.js';

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

// Onboarding journey for INDIVIDUAL accounts.
export function runIndividualOnboardingFlow(userPrefix) {
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

  // 2. Create the account. personalInfo/address/taxInfo go in this same
  // call (matching the real UI's contract) — the backend only provisions
  // the account's legacy mirrors when personalInfo is present at create
  // time, so an empty `{accountType}` create silently skips that step.
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

  res = http.post(
    url('/uap/v1/accounts'),
    JSON.stringify({ accountType: 'INDIVIDUAL', personalInfo: personalInfoBody, address: addressBody, taxInfo: taxInfoBody }),
    { headers: jsonHeaders(), tags: { name: 'CreateOnboardingAccount' } }
  );
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

  // 4. PUT the remaining step slices.
  const employmentBody = generateEmploymentInfo();
  const investmentProfileBody = generateInvestmentProfile();
  const disclosuresBody = generateDisclosures();

  const remainingSlices = [
    { employment: employmentBody },
    { investmentProfile: investmentProfileBody, disclosures: disclosuresBody },
    { trustedContact: generateTrustedContact() },
  ];
  for (const slice of remainingSlices) {
    res = http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify(slice), {
      headers: jsonHeaders(),
      tags: { name: 'UpdateOnboardingAccount' },
    });
    check(res, { 'update onboarding account slice ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  maybeRefreshSession(authState); // long flow — keep the ~180s session alive for what's left

  // 5. Re-send employment + investmentProfile immediately before sign.
  // Without this, sign intermittently 422s on "investorPurpose"/
  // "illiquidAssets cannot be null or empty" even though both were already
  // PUT above — a known backend-side sync-timing issue; resending right
  // before sign reliably clears it.
  res = http.put(url(`/uap/v1/accounts/${accountId}`), JSON.stringify({ employment: employmentBody }), {
    headers: jsonHeaders(),
    tags: { name: 'ResendEmploymentBeforeSign' },
  });
  sleep(SLEEP_SECONDS);
  res = http.put(
    url(`/uap/v1/accounts/${accountId}`),
    JSON.stringify({ investmentProfile: investmentProfileBody, disclosures: disclosuresBody }),
    { headers: jsonHeaders(), tags: { name: 'ResendInvestmentProfileBeforeSign' } }
  );
  sleep(SLEEP_SECONDS);

  // 6. Sign agreements — fires KYC downstream. Success is 201. Retries on
  // 422 ("secondary account not yet provisioned" — async provisioning still
  // in flight) and 408 (occasional transient timeout); either usually
  // clears within a couple of attempts.
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
    // single-line JSON shape in sync with that script. password is
    // deliberately NOT logged -- every generated user shares the same
    // SIGN_UP_PASSWORD, so there's nothing account-specific to capture, and
    // it keeps a real secret out of stdout. build-onboarding-run-pool.js
    // fills the password back in from that same config value.
    console.log(
      `ONBOARDING_INDIVIDUAL_ACCOUNT_CREDENTIAL:${JSON.stringify({
        email: session.user.email,
        accountId: ids && ids.userServiceAccountId,
        uapAccountId: accountId,
        totpSecret: session.totpSecret,
      })}`
    );
  }

  // 7. KYC verdict — polled after sign (sign is what triggers it).
  res = http.get(url(`/uap/v1/accounts/${accountId}/kyc`), {
    headers: jsonHeaders(),
    tags: { name: 'GetOnboardingKyc' },
  });
  check(res, { 'get onboarding kyc ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 8. Trading-status gating verdict (heaviest read in the platform).
  res = http.get(
    url(`/uap/v1/accounts/${accountId}/trading-status?platform=primary&assetType=${DEFAULT_ASSET_TYPE}`),
    { headers: jsonHeaders(), tags: { name: 'GetOnboardingTradingStatus' } }
  );
  check(res, { 'get onboarding trading status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
