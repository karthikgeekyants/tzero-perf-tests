import {
  SIGN_UP_PASSWORD,
  TEST_USER_EMAIL_DOMAIN,
  SIGNUP_CLIENT_ID,
  SIGNUP_CLIENT_NAME,
  SIGNUP_PLATFORM,
  TEST_USER_POOL_EMAIL_PATTERN,
  TEST_USER_POOL_PASSWORD,
  ONBOARDED_POOL_EMAIL_PATTERN,
  ONBOARDED_POOL_PASSWORD,
  ONBOARDED_ENTITY_POOL_EMAIL_PATTERN,
  ONBOARDED_ENTITY_POOL_PASSWORD,
  ONBOARDING_FIRST_NAME_PREFIX,
  ONBOARDING_LAST_NAME_PREFIX,
  ONBOARDING_DATE_OF_BIRTH,
  ONBOARDING_CITIZENSHIP_COUNTRY,
  ONBOARDING_ADDRESS_LINE1,
  ONBOARDING_CITY,
  ONBOARDING_STATE,
  ONBOARDING_ZIP,
  ONBOARDING_COUNTRY,
  ONBOARDING_EMPLOYMENT_STATUS,
  ONBOARDING_EMPLOYER_NAME,
  ONBOARDING_OCCUPATION,
  ONBOARDING_INVESTMENT_OBJECTIVE,
  ONBOARDING_ENTITY_NAME,
  ONBOARDING_ENTITY_DATE_OF_FORMATION,
  ONBOARDING_ENTITY_COUNTRY_OF_FORMATION,
  ONBOARDING_ENTITY_REGION_OF_FORMATION,
  ONBOARDING_ENTITY_COUNTRY_OF_TAXATION,
  ONBOARDING_ENTITY_PHONE,
  ONBOARDING_ENTITY_EIN_PREFIX,
  ONBOARDING_CONTROL_PERSON_TITLE,
} from '../config/environment.js';

export function generatePhone() {
  // A raw 555 area code or toll-free number fails E.164 validation -- use a
  // real area code + the NANP-reserved fictional exchange 555-01XX instead.
  // areaCode cycles every 9 codes and suffix every 100, and gcd(9,100)=1, so
  // the pair only repeats every 900 VUs (at a fixed __ITER) -- comfortably
  // past the suite's default MAX_VUS=500. The previous 8-code list collided
  // every 200 VUs (e.g. VU 1 and VU 201 shared a phone number).
  const realAreaCodes = ['415', '212', '305', '312', '617', '404', '702', '213', '646'];
  const areaCode = realAreaCodes[__VU % realAreaCodes.length];
  const suffix = String((__VU * 31 + __ITER) % 100).padStart(2, '0');
  return `+1${areaCode}55501${suffix}`;
}

// Name fields only accept letters/spaces/hyphens/apostrophes/periods (see
// generatePersonalInfo() below) -- a numeric __VU suffix fails that format
// check, so this encodes (__VU, __ITER) as letters instead, keeping every
// generated name unique without violating the rule.
function uniqueNameSuffix() {
  let n = __VU * 1000 + (__ITER % 1000);
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  } while (n > 0);
  return suffix;
}

// TOTP secrets for the pool are captured once at seed time (scenarios/00-seed-user-pool.js
// + scripts/build-pool-secrets.js) since k6 can't share JS state across VUs.
// open() only works at init time, so this loads once and is shared read-only.
let poolSecrets = {};
try {
  poolSecrets = JSON.parse(open('../config/pool-secrets.json'));
} catch (e) {
  // Not seeded yet -- pickPooledUser() surfaces this via a missing totpSecret.
}
// A handful of pool indices routinely fail during seeding (transient
// signup/TOTP errors) and never get backfilled -- the email ends up
// registered but the secret is never captured, so the slot is permanently
// unusable. Selecting only from indices that actually HAVE a secret (rather
// than assuming a dense 1..TEST_USER_POOL_SIZE range) means those gaps
// can't corrupt a shared-iterations run: without this, a VU landing on a
// gap fails instantly (no HTTP call) and can repeatedly re-grab iterations
// from the shared pool faster than VUs doing real work, silently consuming
// a large fraction of the total run.
const validPoolIndices = Object.keys(poolSecrets)
  .map(Number)
  .sort((a, b) => a - b);

export function generateTestUser(prefix = 'perf.test') {
  // Real signup rejects emails over 50 characters, so keep the unique
  // suffix short (base36 VU/iteration/timestamp) and cap the prefix too.
  const unique = `${Date.now().toString(36).slice(-6)}${__VU.toString(36)}${__ITER.toString(36)}`;
  const safePrefix = prefix.length > 13 ? prefix.slice(0, 13) : prefix;
  return {
    email: `${safePrefix}.${unique}@${TEST_USER_EMAIL_DOMAIN}`,
    password: SIGN_UP_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    clientName: SIGNUP_CLIENT_NAME,
    platform: SIGNUP_PLATFORM,
  };
}

// For returning-user flows (sign in, onboarding continuation, etc.) -- picks
// an already-registered account from the pool instead of a fresh one, so 500
// VUs don't hammer a single shared account.
export function pickPooledUser() {
  if (validPoolIndices.length === 0) {
    return { email: '', password: TEST_USER_POOL_PASSWORD, clientId: SIGNUP_CLIENT_ID, totpSecret: undefined };
  }
  const index = validPoolIndices[__VU % validPoolIndices.length];
  return {
    email: TEST_USER_POOL_EMAIL_PATTERN.replace('{n}', index),
    password: TEST_USER_POOL_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    totpSecret: poolSecrets[index],
  };
}

// Pool secret entries were originally a bare totpSecret string; newer seed
// runs write { totpSecret, legalName } instead (see 00b/00c and their build
// scripts). Reading both shapes here means the 500 already-approved accounts
// seeded before this change keep working unchanged -- they just come back
// with legalName: undefined, same as today.
function readPoolSecretEntry(entry) {
  if (typeof entry === 'string') return { totpSecret: entry, legalName: undefined };
  return { totpSecret: entry?.totpSecret, legalName: entry?.legalName };
}

// For Invest via Wire / Trade via Wallet -- picks an already-onboarded
// account (see scenarios/00b-seed-onboarded-pool.js) instead of the
// general sign-up-only pool, since those flows need a resolvable PIAS
// account id. Same gap-immunity approach as pickPooledUser() above.
let onboardedPoolSecrets = {};
try {
  onboardedPoolSecrets = JSON.parse(open('../config/onboarded-pool-secrets.json'));
} catch (e) {
  // Not seeded yet -- pickOnboardedPooledUser() surfaces this via a missing totpSecret.
}
const validOnboardedPoolIndices = Object.keys(onboardedPoolSecrets)
  .map(Number)
  .sort((a, b) => a - b);

export function pickOnboardedPooledUser() {
  if (validOnboardedPoolIndices.length === 0) {
    return { email: '', password: ONBOARDED_POOL_PASSWORD, clientId: SIGNUP_CLIENT_ID, totpSecret: undefined, legalName: undefined };
  }
  const index = validOnboardedPoolIndices[__VU % validOnboardedPoolIndices.length];
  const { totpSecret, legalName } = readPoolSecretEntry(onboardedPoolSecrets[index]);
  return {
    email: ONBOARDED_POOL_EMAIL_PATTERN.replace('{n}', index),
    password: ONBOARDED_POOL_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    totpSecret,
    legalName,
  };
}

// Same as pickOnboardedPooledUser() above, but for the Entity-onboarded pool
// (see scenarios/00c-seed-onboarded-entity-pool.js) -- lets Invest via Wire /
// Trade via Wallet exercise entity accounts too, not just individual.
let onboardedEntityPoolSecrets = {};
try {
  onboardedEntityPoolSecrets = JSON.parse(open('../config/onboarded-entity-pool-secrets.json'));
} catch (e) {
  // Not seeded yet -- pickOnboardedEntityPooledUser() surfaces this via a missing totpSecret.
}
const validOnboardedEntityPoolIndices = Object.keys(onboardedEntityPoolSecrets)
  .map(Number)
  .sort((a, b) => a - b);

export function pickOnboardedEntityPooledUser() {
  if (validOnboardedEntityPoolIndices.length === 0) {
    return { email: '', password: ONBOARDED_ENTITY_POOL_PASSWORD, clientId: SIGNUP_CLIENT_ID, totpSecret: undefined, legalName: undefined };
  }
  const index = validOnboardedEntityPoolIndices[__VU % validOnboardedEntityPoolIndices.length];
  const { totpSecret, legalName } = readPoolSecretEntry(onboardedEntityPoolSecrets[index]);
  return {
    email: ONBOARDED_ENTITY_POOL_EMAIL_PATTERN.replace('{n}', index),
    password: ONBOARDED_ENTITY_POOL_PASSWORD,
    clientId: SIGNUP_CLIENT_ID,
    totpSecret,
    legalName,
  };
}

// Picks from a pool CAPTURED from a real scenarios/01-signup.js run's own
// output (see scripts/build-signup-run-pool.js), rather than a deterministic
// pre-seeded pool -- lets Sign In reuse whichever real accounts a Sign Up
// load-test run actually created, instead of needing a separate seed step.
// Unlike the pools above, entries here carry the real (random) email
// directly, since Sign Up's emails don't follow a reconstructable pattern.
let capturedSignupPool = [];
try {
  capturedSignupPool = JSON.parse(open('../config/signup-run-pool.json'));
} catch (e) {
  // Not built yet -- pickCapturedSignupPoolUser() surfaces this via a missing totpSecret.
}

export function pickCapturedSignupPoolUser() {
  if (capturedSignupPool.length === 0) {
    return { email: '', password: SIGN_UP_PASSWORD, clientId: SIGNUP_CLIENT_ID, totpSecret: undefined };
  }
  const entry = capturedSignupPool[__VU % capturedSignupPool.length];
  return {
    email: entry.email,
    password: entry.password,
    clientId: SIGNUP_CLIENT_ID,
    totpSecret: entry.totpSecret,
  };
}

function generateSSN() {
  // 900-999 is SSA-reserved (ITINs, not SSNs) and rejected by the API; no
  // dashes -- plain 9-digit string.
  let area = 100 + (__VU % 799); // 100-898, avoiding 900-999
  if (area === 666) area += 1; // also SSA-invalid
  const group = 10 + (__ITER % 89);
  const serial = 1000 + (Date.now() % 8999);
  return `${area}${group}${serial}`;
}

// The "Personal information" step. dob must be ISO 8601 (e.g. "1990-01-01").
// Name fields only accept letters/spaces/hyphens/apostrophes/periods -- a
// hyphenated letter suffix (see uniqueNameSuffix()) keeps every account's
// name unique without violating that rule; every account sharing the exact
// same name is a realistic trigger for backend duplicate-person/fraud checks
// under concurrent load.
// phoneNumber is required: the backend splits it into
// phoneCountryCode/phoneAreaCode/phoneNumber internally at sign time.
export function generatePersonalInfo() {
  return {
    firstName: ONBOARDING_FIRST_NAME_PREFIX,
    lastName: `${ONBOARDING_LAST_NAME_PREFIX}-${uniqueNameSuffix()}`,
    dob: ONBOARDING_DATE_OF_BIRTH,
    citizenshipCountry: ONBOARDING_CITIZENSHIP_COUNTRY,
    phoneNumber: generatePhone(),
    addressLine1: ONBOARDING_ADDRESS_LINE1,
    city: ONBOARDING_CITY,
    state: ONBOARDING_STATE,
    zip: ONBOARDING_ZIP,
    country: ONBOARDING_COUNTRY,
  };
}

// The "Tax information" step. taxInfo is an array, not a plain object --
// type "TIN" is the SSN case.
export function generateTaxInfo() {
  return [{ type: 'TIN', identifier: generateSSN() }];
}

// The "Employment" step.
export function generateEmploymentInfo() {
  return {
    status: ONBOARDING_EMPLOYMENT_STATUS,
    employerName: ONBOARDING_EMPLOYER_NAME,
    occupation: ONBOARDING_OCCUPATION,
  };
}

// The "Investor Info" screen's Risk Profile section.
export function generateInvestmentProfile() {
  return {
    objective: ONBOARDING_INVESTMENT_OBJECTIVE,
    tradeIlliquidSecurities: true,
  };
}

// The "Investor Association" checkboxes -- both false (not a company
// insider or FINRA/exchange-affiliated).
export function generateDisclosures() {
  return { hasPublicDisclosure: false, hasStockDisclosure: false };
}

// The "Trusted Contact" screen. Opting out is the simplest valid case.
export function generateTrustedContact() {
  return { optOut: true };
}

// EIN must be a valid IRS campus prefix, not just format-valid -- see
// ONBOARDING_ENTITY_EIN_PREFIX. No fully collision-proof range exists (same
// situation as generateSSN() above), so this is a plausible-not-guaranteed
// unique value, same tradeoff.
function generateEIN() {
  const serial = 1000000 + ((__VU * 7919 + __ITER * 104729 + Date.now()) % 8999999);
  return `${ONBOARDING_ENTITY_EIN_PREFIX}-${serial}`;
}

// For business entities (LLC/CORPORATION/PARTNERSHIP/TRUST) — the
// "entityInfo" slice. Field names use a "nameOf/countryOf" style, distinct
// from personalInfo's plain camelCase. Needs both entityPhysicalAddress and
// entityMailingAddress.
export function generateEntityInfo() {
  const entityAddress = {
    street: ONBOARDING_ADDRESS_LINE1,
    city: ONBOARDING_CITY,
    state: ONBOARDING_STATE,
    postalCode: ONBOARDING_ZIP,
    country: ONBOARDING_COUNTRY,
  };
  return {
    nameOfBusiness: ONBOARDING_ENTITY_NAME,
    dateOfFormation: ONBOARDING_ENTITY_DATE_OF_FORMATION,
    countryOfFormation: ONBOARDING_ENTITY_COUNTRY_OF_FORMATION,
    regionOfFormation: ONBOARDING_ENTITY_REGION_OF_FORMATION,
    countryOfTaxation: ONBOARDING_ENTITY_COUNTRY_OF_TAXATION,
    ein: generateEIN(),
    entityPhone: ONBOARDING_ENTITY_PHONE,
    entityMailingAddress: entityAddress,
    entityPhysicalAddress: entityAddress,
  };
}

// For onboarding (business entities) — the "associatedPeople" slice (the
// entity's beneficial owner(s)/control person(s)). Confirmed 2026-08-20 via
// direct API probing: an array of { roles, ownershipPercentage, isPrimary,
// person }, where `person` (not `personalInfo`) nests the individual's own
// details -- same field names as generatePersonalInfo() (firstName/
// lastName/dob/citizenshipCountry), plus email/phoneNumber/address/taxId
// (same array shape as the top-level taxInfo, [{ type, identifier }]).
// isPrimary:true is NOT optional despite reading as one in the account
// status readback (shows null until set) -- without it, this slice silently
// accepts the PUT (200, no validation errors) but never leaves "PENDING",
// which then blocks submit with "the associated-people step must be
// completed" -- a gate with no error message pointing at the actual cause.
//
// Confirmed 2026-08-20 via real UI: same name-format rule as
// generatePersonalInfo() above (letters/spaces/hyphens/apostrophes/periods
// only) -- lastName's old `${prefix}${__VU}` digit suffix is dropped for the
// same reason.
//
// roles/ownershipPercentage: a real successfully-provisioned LLC account has
// this person as CONTROL_PERSON only (the UI's "25% Owner" checkbox left
// unchecked), with ownershipPercentage null, not both BENEFICIAL_OWNER +
// CONTROL_PERSON at 100%.
//
// primaryEmail is REQUIRED and must be the account's own signup email, not a
// separately generated one. Confirmed root cause of the entity `submit` 503
// (PROVISIONING_ERROR): the primary person represents the same human who
// signed up, so their email here must match the identity's email at
// creation. A different email here makes the backend's identity patch look
// like an email-change request, which requires a verification `changeToken`
// this flow never supplies -- failing with "Please provide valid token
// value" deep inside the provisioning saga. Not a backend bug.
export function generateAssociatedPeople(primaryEmail) {
  return [
    {
      roles: ['CONTROL_PERSON'],
      ownershipPercentage: null,
      isPrimary: true,
      title: ONBOARDING_CONTROL_PERSON_TITLE,
      person: {
        firstName: `${ONBOARDING_FIRST_NAME_PREFIX} Owner`,
        lastName: `${ONBOARDING_LAST_NAME_PREFIX}-${uniqueNameSuffix()}`,
        dob: ONBOARDING_DATE_OF_BIRTH,
        email: primaryEmail,
        phoneNumber: generatePhone(),
        citizenshipCountry: ONBOARDING_CITIZENSHIP_COUNTRY,
        taxId: generateTaxInfo(),
        address: {
          street: ONBOARDING_ADDRESS_LINE1,
          city: ONBOARDING_CITY,
          state: ONBOARDING_STATE,
          postalCode: ONBOARDING_ZIP,
          country: ONBOARDING_COUNTRY,
        },
      },
    },
  ];
}
