import {
  SIGN_UP_PASSWORD,
  TEST_USER_POOL_SIZE,
  TEST_USER_POOL_EMAIL_PATTERN,
  TEST_USER_POOL_PASSWORD,
} from '../config/environment.js';

function generatePhone() {
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
