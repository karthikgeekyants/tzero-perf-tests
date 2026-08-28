// Central place for env-driven config so every scenario script stays in sync.
// Override any value with `-e NAME=value` on the k6 run command.

export const BASE_URL = __ENV.BASE_URL || 'https://gateway-web-markets-staging.tzero.com';
// Web and Mobile share the same gateway, so these scripts exercise both
// clients' backend at once — no separate web/mobile base URL needed. Confirmed
// 2026-08-19 by capturing the real POST /auth/login request URL from
// unified-portal.staging.tzero.com's Network tab (Request URL field) — this
// is the actual staging gateway, not a guess. (The TEST host used earlier
// for sanity-checking the script was gateway-web-markets-test.tzero.com.)

// Required, no fallback -- this password grants access to real (if
// synthetic) accounts on staging, so it must not be committed to source.
// Every scenario needs it (directly, or via the pool passwords below that
// default to it), so set it once per shell session:
//   export SIGN_UP_PASSWORD='...'
export const SIGN_UP_PASSWORD = __ENV.SIGN_UP_PASSWORD;
if (!SIGN_UP_PASSWORD) {
  throw new Error(
    'SIGN_UP_PASSWORD is required -- set it with `export SIGN_UP_PASSWORD=...` or `-e SIGN_UP_PASSWORD=...` on the k6 run command. No default is provided on purpose (see README).'
  );
}

// Shared by every generated test-user email (signup, pool, onboarding
// associated people) so there's one place to change it -- e.g. to a real,
// mail-receivable domain for a one-off diagnostic run.
export const TEST_USER_EMAIL_DOMAIN = __ENV.TEST_USER_EMAIL_DOMAIN || 'tzero-perf-test.com';

// Real sign-up (POST /identities) and sign-in (POST /auth/login) bodies both
// carry these — see load-test-api-surface doc §01. Confirmed 2026-08-19 by
// capturing the real POST /identities payload from the web app's own
// Network tab (unified-portal.test.tzero.com/tzero/auth/register) — not a
// guess anymore.
export const SIGNUP_CLIENT_ID = __ENV.SIGNUP_CLIENT_ID || '67fbc53f-7132-439d-a811-d18f71feae8b';
export const SIGNUP_CLIENT_NAME = __ENV.SIGNUP_CLIENT_NAME || 'tzero';
export const SIGNUP_PLATFORM = __ENV.SIGNUP_PLATFORM || 'unified';
// Captured from the web client, which may register itself under the same
// "unified" platform value as mobile (they share the same gateway/APIs) —
// if a real run later shows this rejected, try 'MOBILE' or similar instead.

// 2FA is TOTP (RFC 6238), computed locally in lib/auth.js from the secret
// captured at enrolment — no vendor round-trip, no backend bypass flag
// needed. See load-test-api-surface doc §00/§06: "Ask for TOTP, not SMS."
export const SESSION_REFRESH_INTERVAL_MS = Number(__ENV.SESSION_REFRESH_INTERVAL_MS || 150000);
// The access token lives ~180s — refresh on this timer (lib/auth.js's
// maybeRefreshSession()) so a run doesn't collapse into a wall of 401s that
// measure the harness instead of the backend.

export const EMAIL_VERIFICATION_CODE = __ENV.EMAIL_VERIFICATION_CODE || '000000';
// Fallback only — used when POST /auth/sendEmailVerificationCode doesn't
// return the code directly (see lib/auth.js's sendEmailVerificationCode()).
// TODO: confirm a fixed test/bypass email verification code with the backend
// team if this environment never returns the code inline.

export const SLEEP_SECONDS = Number(__ENV.SLEEP_SECONDS || 1);

// Sign-in load/stress needs a pool of already-registered accounts (500 VUs
// logging into one shared account isn't realistic and will collide on
// sessions/rate limits). Defaults to matching MAX_VUS (lib/options.js) —
// run scenarios/00-seed-user-pool.js once to actually create this many
// accounts in staging before running Sign In/Invest/Trade/History at scale.
export const TEST_USER_POOL_SIZE = Number(__ENV.TEST_USER_POOL_SIZE || 500);
export const TEST_USER_POOL_EMAIL_PATTERN =
  __ENV.TEST_USER_POOL_EMAIL_PATTERN || `perf.pool.{n}@${TEST_USER_EMAIL_DOMAIN}`;
export const TEST_USER_POOL_PASSWORD = __ENV.TEST_USER_POOL_PASSWORD || SIGN_UP_PASSWORD;
export const SEED_VUS = Number(__ENV.SEED_VUS || 10);
// Concurrency for scenarios/00-seed-user-pool.js — this is a one-time setup
// script, not a load test, so it doesn't need to run at MAX_VUS.

// Invest via Wire / Trade via Wallet need accounts that have actually been
// through onboarding (a PIAS account only exists once agreements are
// signed) — the general TEST_USER_POOL_* accounts above are signed-up-only.
// scenarios/00b-seed-onboarded-pool.js seeds this separate pool by running
// full individual onboarding (through sign — not waiting on the async KYC
// verdict) for each account.
export const ONBOARDED_POOL_SIZE = Number(__ENV.ONBOARDED_POOL_SIZE || 500);
export const ONBOARDED_POOL_EMAIL_PATTERN =
  __ENV.ONBOARDED_POOL_EMAIL_PATTERN || `perf.onbpool.{n}@${TEST_USER_EMAIL_DOMAIN}`;
export const ONBOARDED_POOL_PASSWORD = __ENV.ONBOARDED_POOL_PASSWORD || SIGN_UP_PASSWORD;

// Same as ONBOARDED_POOL_* above, but for Entity accounts (LLC/etc.) --
// seeded separately via scenarios/00c-seed-onboarded-entity-pool.js, since
// entity onboarding needs its own slices (entityInfo/associatedPeople),
// document upload, and submit step that the individual pool script doesn't do.
export const ONBOARDED_ENTITY_POOL_SIZE = Number(__ENV.ONBOARDED_ENTITY_POOL_SIZE || 500);
export const ONBOARDED_ENTITY_POOL_EMAIL_PATTERN =
  __ENV.ONBOARDED_ENTITY_POOL_EMAIL_PATTERN || `perf.onbpool.ent.{n}@${TEST_USER_EMAIL_DOMAIN}`;
export const ONBOARDED_ENTITY_POOL_PASSWORD = __ENV.ONBOARDED_ENTITY_POOL_PASSWORD || SIGN_UP_PASSWORD;

// Invest via Wire / Trade via Wallet draw from the Individual onboarded pool
// by default -- set to 'ENTITY' to run the same scenario against the Entity
// onboarded pool instead (scenarios/00c-seed-onboarded-entity-pool.js), or
// 'MIXED' to exercise both pools in the same run (odd VUs -> Individual,
// even VUs -> Entity -- each VU still lands on a distinct pooled account).
export const POOL_ACCOUNT_TYPE = (__ENV.POOL_ACCOUNT_TYPE || 'INDIVIDUAL').toUpperCase();

// Sign In draws from the deterministic pre-seeded pool (TEST_USER_POOL_* /
// scenarios/00-seed-user-pool.js) by default -- set to 'CAPTURED' to log
// into whichever real accounts a scenarios/01-signup.js run actually just
// created instead (see scripts/build-signup-run-pool.js).
export const SIGNIN_SOURCE = (__ENV.SIGNIN_SOURCE || 'POOL').toUpperCase();

// Same idea as SIGNIN_SOURCE above, but for Invest via Wire / Trade via
// Wallet / Order History -- these draw from the deterministic
// ONBOARDED_POOL_* pool (scenarios/00b-seed-onboarded-pool.js /
// 00c-seed-onboarded-entity-pool.js) by default. Set to 'CAPTURED' to use
// whichever real, dev-approved accounts a scenarios/02-onboarding-*.js run
// actually created instead (see scripts/build-onboarding-run-pool.js).
export const ONBOARDED_SOURCE = (__ENV.ONBOARDED_SOURCE || 'POOL').toUpperCase();

// Onboarding (9.2) — Personal information step. dob is ISO 8601 (e.g. "1990-01-01").
export const ONBOARDING_FIRST_NAME_PREFIX = __ENV.ONBOARDING_FIRST_NAME_PREFIX || 'Perf';
export const ONBOARDING_LAST_NAME_PREFIX = __ENV.ONBOARDING_LAST_NAME_PREFIX || 'Test';
export const ONBOARDING_DATE_OF_BIRTH = __ENV.ONBOARDING_DATE_OF_BIRTH || '1990-01-01';
export const ONBOARDING_CITIZENSHIP_COUNTRY = __ENV.ONBOARDING_CITIZENSHIP_COUNTRY || 'US';
export const ONBOARDING_ADDRESS_LINE1 = __ENV.ONBOARDING_ADDRESS_LINE1 || '200 Park Ave';
export const ONBOARDING_CITY = __ENV.ONBOARDING_CITY || 'New York';
export const ONBOARDING_STATE = __ENV.ONBOARDING_STATE || 'NY';
export const ONBOARDING_ZIP = __ENV.ONBOARDING_ZIP || '10166';
export const ONBOARDING_COUNTRY = __ENV.ONBOARDING_COUNTRY || 'US';

// Onboarding (9.2) — Individual "Employment" step (Personal information
// screen) and "Investor Info" screen's Risk Profile section. All fields and
// enum values confirmed 2026-08-19 against real PUT /uap/v1/accounts/{id}
// captures — not guesses.
export const ONBOARDING_EMPLOYMENT_STATUS = __ENV.ONBOARDING_EMPLOYMENT_STATUS || 'FULL_TIME_EMPLOYED';
export const ONBOARDING_EMPLOYER_NAME = __ENV.ONBOARDING_EMPLOYER_NAME || 'Acme Corp';
export const ONBOARDING_OCCUPATION = __ENV.ONBOARDING_OCCUPATION || 'Software Engineer';
export const ONBOARDING_INVESTMENT_OBJECTIVE = __ENV.ONBOARDING_INVESTMENT_OBJECTIVE || 'CAPITAL_APPRECIATION';

// Onboarding — retry tuning, shared by Individual and Entity. `sign` retries
// on 422 (secondary account not yet provisioned) and 408 (transient
// timeout); entity document upload retries on 503/500 (account still
// settling right after submit).
export const ONBOARDING_SIGN_MAX_ATTEMPTS = Number(__ENV.ONBOARDING_SIGN_MAX_ATTEMPTS || 6);
export const ONBOARDING_SIGN_RETRY_DELAY_SECONDS = Number(__ENV.ONBOARDING_SIGN_RETRY_DELAY_SECONDS || 20);
export const ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS = Number(__ENV.ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS || 8);
export const ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS = Number(
  __ENV.ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS || 8
);
// Entity submit retries on 503/500 too (transient backend flakiness, same
// symptom as document upload) -- a dedicated constant, not reused from the
// document-upload one above, since the two steps are independent and tuning
// one shouldn't silently retune the other.
export const ONBOARDING_SUBMIT_MAX_ATTEMPTS = Number(__ENV.ONBOARDING_SUBMIT_MAX_ATTEMPTS || 8);
export const ONBOARDING_SUBMIT_RETRY_DELAY_SECONDS = Number(__ENV.ONBOARDING_SUBMIT_RETRY_DELAY_SECONDS || 8);

// Onboarding (9.2) — business entity types (LLC/CORPORATION/PARTNERSHIP/
// TRUST). Confirmed 2026-08-20: "ENTITY" is not a real accountType at all —
// the doc's "Individual & Entity" framing was a simplification; the actual
// enum is INDIVIDUAL, JOINT, LLC, CORPORATION, PARTNERSHIP, TRUST. LLC is
// the default representative business-entity type here (override to test
// the others — they very likely share this same entityInfo/associatedPeople
// contract, just a different accountType value).
export const ONBOARDING_ENTITY_ACCOUNT_TYPE = __ENV.ONBOARDING_ENTITY_ACCOUNT_TYPE || 'LLC';
export const ONBOARDING_ENTITY_NAME = __ENV.ONBOARDING_ENTITY_NAME || 'Perf Test LLC';
export const ONBOARDING_ENTITY_DATE_OF_FORMATION = __ENV.ONBOARDING_ENTITY_DATE_OF_FORMATION || '2015-01-01';
export const ONBOARDING_ENTITY_COUNTRY_OF_FORMATION = __ENV.ONBOARDING_ENTITY_COUNTRY_OF_FORMATION || 'US';
export const ONBOARDING_ENTITY_REGION_OF_FORMATION = __ENV.ONBOARDING_ENTITY_REGION_OF_FORMATION || 'DE';
export const ONBOARDING_ENTITY_COUNTRY_OF_TAXATION = __ENV.ONBOARDING_ENTITY_COUNTRY_OF_TAXATION || 'US';
export const ONBOARDING_ENTITY_PHONE = __ENV.ONBOARDING_ENTITY_PHONE || '+18888888888';
// EIN must have a valid IRS campus prefix, not just the xx-xxxxxxx format —
// "12" confirmed valid.
export const ONBOARDING_ENTITY_EIN_PREFIX = __ENV.ONBOARDING_ENTITY_EIN_PREFIX || '12';
// Confirmed 2026-08-20: required by submit whenever an associatedPeople
// entry has the CONTROL_PERSON role ("Control persons must have a title
// within the business") — a sibling field of roles/person, not nested
// inside person.
export const ONBOARDING_CONTROL_PERSON_TITLE = __ENV.ONBOARDING_CONTROL_PERSON_TITLE || 'Managing Member';

// Invest via Wire (9.3)
export const INVESTMENT_AMOUNT = Number(__ENV.INVESTMENT_AMOUNT || 100);
export const DEFAULT_ASSET_TYPE = __ENV.DEFAULT_ASSET_TYPE || 'EQUITY';
// TODO: confirm the real asset type enum value(s) with the backend/business team.
// Regulation-gated offerings (e.g. Reg CF) reject CreateInvestment with
// FAILED_REGULATION_RULES until annualIncome/netWorth are on the investor's
// profile. Confirmed 2026-08-21 via a live call — set once, persists on the
// account, never asked for again on later investments.
export const INVESTOR_ANNUAL_INCOME = Number(__ENV.INVESTOR_ANNUAL_INCOME || 10000);
export const INVESTOR_NET_WORTH = Number(__ENV.INVESTOR_NET_WORTH || 200000);

// Sign MSA (master subscription agreement) -- userSignature is the typed
// legal name the real app's review-and-sign step collects from the investor.
export const INVESTOR_LEGAL_NAME = __ENV.INVESTOR_LEGAL_NAME || 'Perf Test';
export const INVESTMENT_MSA_VERSION = __ENV.INVESTMENT_MSA_VERSION || 'v1';

// Trade via Wallet (9.4) -- order fields are FIX-protocol codes on the wire
// (see lib/onboarding-entity.js-style enum maps in the scenario itself);
// these three pick which enum value the order uses.
export const TRADE_QUANTITY = Number(__ENV.TRADE_QUANTITY || 1);
export const TRADE_SIDE = __ENV.TRADE_SIDE || 'BUY';
export const TRADE_ORDER_TYPE = __ENV.TRADE_ORDER_TYPE || 'LIMIT';
export const TRADE_TIME_IN_FORCE = __ENV.TRADE_TIME_IN_FORCE || 'DAY';
// Fallback price only if the order book has no live ask to price a BUY off of.
export const DEFAULT_TRADE_PRICE = Number(__ENV.DEFAULT_TRADE_PRICE || 10);
