// Central place for env-driven config so every scenario script stays in sync.
// Override any value with `-e NAME=value` on the k6 run command.

export const BASE_URL = __ENV.BASE_URL || 'https://REPLACE_WITH_PREPROD_BASE_URL';
// Web and Mobile share the same preprod API, so these scripts exercise both
// clients' backend at once — no separate web/mobile base URL needed.
// TODO: confirm preprod base URL with DevOps once staging push is done.

export const SIGN_UP_PASSWORD = __ENV.SIGN_UP_PASSWORD || 'PerfTest@12345';

export const TEST_2FA_CODE = __ENV.TEST_2FA_CODE || '000000';
// TODO: real SMS codes can't be scripted — confirm a fixed test/bypass OTP for
// preprod with the backend team before running this scenario for real.

export const SLEEP_SECONDS = Number(__ENV.SLEEP_SECONDS || 1);

// Sign-in load/stress needs a pool of already-registered accounts (500 VUs
// logging into one shared account isn't realistic and will collide on
// sessions/rate limits). Seed this many accounts in preprod first — e.g. by
// running the Sign Up scenario — using the same email pattern below.
export const TEST_USER_POOL_SIZE = Number(__ENV.TEST_USER_POOL_SIZE || 50);
export const TEST_USER_POOL_EMAIL_PATTERN = __ENV.TEST_USER_POOL_EMAIL_PATTERN || 'perf.pool.{n}@tzero-perf-test.com';
export const TEST_USER_POOL_PASSWORD = __ENV.TEST_USER_POOL_PASSWORD || SIGN_UP_PASSWORD;

// Invest via Wire (9.3)
export const INVESTMENT_AMOUNT = Number(__ENV.INVESTMENT_AMOUNT || 100);
export const DEFAULT_ASSET_TYPE = __ENV.DEFAULT_ASSET_TYPE || 'EQUITY';
// TODO: confirm the real asset type enum value(s) with the backend/business team.
export const DEFAULT_BROKER_ID = __ENV.DEFAULT_BROKER_ID || 'REPLACE_WITH_BROKER_ID';
// TODO: confirm the broker id to use for wallet balance checks in preprod.

// Trade via Wallet (9.4)
export const TRADE_QUANTITY = Number(__ENV.TRADE_QUANTITY || 1);
export const TRADE_SIDE = __ENV.TRADE_SIDE || 'BUY';
export const DEFAULT_TRADE_PRICE = Number(__ENV.DEFAULT_TRADE_PRICE || 10);
// TODO: DEFAULT_TRADE_PRICE is only a fallback if depth-of-book doesn't return
// a usable price — confirm real pricing behavior for the traded asset.
