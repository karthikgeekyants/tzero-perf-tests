import {
  SIGN_UP_PASSWORD,
  TEST_USER_POOL_SIZE,
  TEST_USER_POOL_EMAIL_PATTERN,
  TEST_USER_POOL_PASSWORD,
  ONBOARDING_FIRST_NAME_PREFIX,
  ONBOARDING_LAST_NAME_PREFIX,
  ONBOARDING_DATE_OF_BIRTH,
  ONBOARDING_CITIZENSHIP_COUNTRY,
  ONBOARDING_ADDRESS_LINE1,
  ONBOARDING_CITY,
  ONBOARDING_STATE,
  ONBOARDING_ZIP,
  ONBOARDING_COUNTRY,
} from '../config/environment.js';

export function generatePhone() {
  const digits = `${__VU}${__ITER}${Date.now()}`.slice(-7).padStart(7, '0');
  return `+1555${digits}`;
}

export function generateTestUser(prefix = 'perf.test') {
  const unique = `${Date.now()}_${__VU}_${__ITER}`;
  return {
    email: `${prefix}.${unique}@tzero-perf-test.com`,
    password: SIGN_UP_PASSWORD,
    confirmPassword: SIGN_UP_PASSWORD,
    phone: generatePhone(),
  };
}

// For returning-user flows (sign in, onboarding continuation, etc.) that need
// an already-registered account rather than a brand-new one. Distributes VUs
// across a pre-seeded pool instead of hammering a single shared account.
export function pickPooledUser() {
  const index = (__VU % TEST_USER_POOL_SIZE) + 1;
  return {
    email: TEST_USER_POOL_EMAIL_PATTERN.replace('{n}', index),
    password: TEST_USER_POOL_PASSWORD,
  };
}

function generateSSN() {
  // 900-999 area numbers are reserved by the SSA and never issued to a real
  // person, so these can't collide with a real SSN.
  const area = 900 + (__VU % 99);
  const group = 10 + (__ITER % 89);
  const serial = 1000 + (Date.now() % 8999);
  return `${area}-${group}-${serial}`;
}

// For onboarding (Individual) — the "Personal information" step of Open
// Account. Field names are our best guess at the API contract; confirm
// against the real /uap/v1/accounts payload.
export function generatePersonalInfo() {
  return {
    firstName: `${ONBOARDING_FIRST_NAME_PREFIX}${__VU}`,
    lastName: `${ONBOARDING_LAST_NAME_PREFIX}${__ITER}`,
    dateOfBirth: ONBOARDING_DATE_OF_BIRTH,
    ssn: generateSSN(),
    citizenshipCountry: ONBOARDING_CITIZENSHIP_COUNTRY,
    addressLine1: ONBOARDING_ADDRESS_LINE1,
    city: ONBOARDING_CITY,
    state: ONBOARDING_STATE,
    zip: ONBOARDING_ZIP,
    country: ONBOARDING_COUNTRY,
  };
}
