# tzero-perf-tests

k6 load and stress performance tests for the tZERO mobile API. Since Web and
Mobile share the same staging base URL, these scripts exercise both clients'
shared backend.

## Prerequisites

- [k6](https://k6.io/) installed locally (`brew install k6` on macOS).
- A staging base URL to test against (see [Configuration](#configuration)).

## Project structure

```
config/environment.js   Central env-driven config (base URL, credentials, test data)
lib/http.js             URL + header helpers
lib/auth.js             Shared sign-up / sign-in / provision-user / OTP helpers
lib/users.js            Test user generation (unique per iteration, or pooled)
lib/onboarding.js        Shared onboarding flow (individual/entity)
lib/options.js           Shared load/stress VU profiles + threshold helpers
lib/report.js            HTML/JSON report generation (handleSummary)
scenarios/               One script per test scenario (see below)
reports/                 Generated HTML/JSON reports land here (gitignored)
```

## Scenarios

| Scenario | Doc section | File | Notes |
|---|---|---|---|
| Seed user pool | — (setup) | `scenarios/00-seed-user-pool.js` | Run once first — see [Test user pool](#test-user-pool) |
| Sign Up | 9.1 | `scenarios/01-signup.js` | Registers a brand-new user every iteration |
| Sign In | 9.1 | `scenarios/01b-signin.js` | Returning user; needs a pre-seeded account pool |
| Onboarding (Individual) | 9.2 | `scenarios/02-onboarding-individual.js` | Registers + onboards a new user every iteration |
| Onboarding (Entity) | 9.2 | `scenarios/02-onboarding-entity.js` | Same, entity account type |
| Invest via Wire | 9.3 | `scenarios/03-invest-wire.js` | Needs an onboarded, investment-eligible pooled account |
| Trade via Wallet | 9.4 | `scenarios/04-trade-wallet.js` | Places and cancels a real order every iteration |
| Order/Transaction History | 9.5 | `scenarios/05-order-history.js` | Read-only |

"Pooled account" scenarios (Sign In, Invest, Trade, Order History) sign in as
one of `TEST_USER_POOL_SIZE` pre-existing accounts rather than registering a
new one — see [Test user pool](#test-user-pool) below.

## Running a scenario

First, seed the account pool once (see [Test user pool](#test-user-pool)):

```bash
k6 run -e BASE_URL=https://your-staging-url scenarios/00-seed-user-pool.js
```

Then every scenario supports the same `-e` flags. Example — Sign Up, load test:

```bash
k6 run -e TEST_TYPE=load -e BASE_URL=https://your-staging-url scenarios/01-signup.js
```

Or via the npm script shortcuts in `package.json` (still override `BASE_URL`
with `-e`, or export it as a real env var first):

```bash
npm run seed:pool
npm run signup:load
npm run signup:stress
npm run signin:load
npm run onboarding:individual:stress
npm run invest:load
npm run trade:stress
npm run history:load
```

`TEST_TYPE` selects the VU profile:
- `load` (default) — ramps to `MAX_VUS`, holds, ramps down.
- `stress` — ramps past `MAX_VUS` to find the breaking point.

## Configuration

Nothing in this project is hardcoded — everything is an env var with a
sensible fallback, set via `-e NAME=value` on the `k6 run` command.

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | placeholder, **must be set** | Staging base URL |
| `TEST_TYPE` | `load` | `load` or `stress` |
| `MAX_VUS` | `500` | Peak virtual users for both profiles |
| `SLEEP_SECONDS` | `1` | Pause between steps within an iteration |
| `SIGN_UP_PASSWORD` | `PerfTest@12345` | Password used for newly-registered test users |
| `TEST_2FA_CODE` | `000000` | Placeholder OTP — needs a real staging bypass code |
| `EMAIL_VERIFICATION_CODE` | `000000` | Placeholder email code — needs a real staging bypass code |
| `TEST_USER_POOL_SIZE` | `500` (matches `MAX_VUS`) | How many accounts `00-seed-user-pool.js` creates / scenarios sign in as |
| `TEST_USER_POOL_EMAIL_PATTERN` | `perf.pool.{n}@tzero-perf-test.com` | Email pattern for pooled accounts |
| `TEST_USER_POOL_PASSWORD` | same as `SIGN_UP_PASSWORD` | Password for pooled accounts |
| `SEED_VUS` | `10` | Concurrency for `00-seed-user-pool.js` (it's a setup script, not a load test) |
| `ONBOARDING_FIRST_NAME_PREFIX` | `Perf` | Prefix for generated first name (Individual onboarding) |
| `ONBOARDING_LAST_NAME_PREFIX` | `Test` | Prefix for generated last name (Individual onboarding) |
| `ONBOARDING_DATE_OF_BIRTH` | `01/01/1990` | Date of birth sent for Individual onboarding |
| `ONBOARDING_CITIZENSHIP_COUNTRY` | `US` | Citizenship/country for Individual onboarding |
| `ONBOARDING_ADDRESS_LINE1` | `200 Park Ave` | Residential address line 1 |
| `ONBOARDING_CITY` | `New York` | Residential city |
| `ONBOARDING_STATE` | `NY` | Residential state |
| `ONBOARDING_ZIP` | `10166` | Residential zip/postal code |
| `ONBOARDING_COUNTRY` | `US` | Residential country |
| `INVESTMENT_AMOUNT` | `100` | Amount used when creating an investment |
| `DEFAULT_ASSET_TYPE` | `EQUITY` | Fallback asset type for eligibility checks |
| `DEFAULT_BROKER_ID` | placeholder | Broker id for wallet balance checks |
| `TRADE_QUANTITY` | `1` | Quantity used when placing an order |
| `TRADE_SIDE` | `BUY` | Order side |
| `DEFAULT_TRADE_PRICE` | `10` | Fallback price if depth-of-book doesn't return one |

Load/stress stage timing and thresholds (`lib/options.js`) are also
env-overridable — e.g. `LOAD_RAMP_UP_DURATION`, `STRESS_BREAKPOINT_PCT`,
`LOAD_P95_THRESHOLD_MS`. Per-endpoint thresholds in each scenario file follow
the same pattern (e.g. `SIGNUP_P95_THRESHOLD_MS`, `PLACE_ORDER_P95_THRESHOLD_MS`).

## Test user pool

Sign In, Invest, Trade, and Order History all need accounts that already
exist — 500 VUs can't realistically share one login. Run
`scenarios/00-seed-user-pool.js` once first; it registers exactly
`TEST_USER_POOL_SIZE` accounts (email matching `TEST_USER_POOL_EMAIL_PATTERN`)
and verifies each one's phone/OTP, so they're immediately usable for Sign In.

It does **not** run onboarding/KYC, so these accounts aren't yet
investment-eligible for Invest via Wire / Trade via Wallet — those scenarios
still need onboarded accounts. That's a deliberate follow-up rather than
bundled into seeding, since KYC review may be asynchronous (see
`scenarios/00-seed-user-pool.js` for the reasoning).

## Reports

Every run generates two files in `reports/`, named
`<scenario>-<load|stress>-<timestamp>`:
- `.html` — shareable visual report (pass/fail, response times, charts).
- `.json` — raw k6 summary data.

Console output (the usual k6 text summary) still prints as normal.

> The HTML report is built via the community `k6-reporter` library, fetched
> from GitHub at runtime — the machine running `k6 run` needs outbound
> internet access for the report step to work.

## Known gaps / TODOs

These are called out inline in the code (search for `TODO`) but worth
tracking centrally:

**Confirmed:**
- Endpoint paths are identical across environments — only `BASE_URL` changes.
- Sign Up payload is exactly `{ email, password, confirmPassword }`, then phone + OTP separately (no extra fields).
- Staging's `POST /auth/2fa/sms/code` does return the OTP directly in its response — the auto-extraction in `lib/auth.js`'s `verifyPhoneOtp()` isn't just a hopeful fallback, it's expected to work (exact field name still unconfirmed, see below).
- `accountType` values `INDIVIDUAL` / `ENTITY` are correct as-is.
- Individual onboarding personal-info fields (name, DOB, SSN, citizenship, address) are confirmed from the actual Open Account screen — see `lib/users.js`'s `generatePersonalInfo()`. JSON field *names* are still a guess.
- Entity onboarding UI isn't built yet — `scenarios/02-onboarding-entity.js` intentionally sends only `{ accountType: 'ENTITY' }` until that flow exists.

**Still open:**
- **`BASE_URL`** is still a placeholder — needs the confirmed staging URL.
- Exact field name for the OTP in the `POST /auth/2fa/sms/code` response (`code` is the current best guess; also affects `EMAIL_VERIFICATION_CODE`/`sendEmailVerificationCode`).
- Several response field-name assumptions (login token, onboarding account id, order id, asset symbol, idempotency key, etc.) are best-guesses and need verifying against real API responses once available.
- Invest via Wire and Trade via Wallet submit real investments/orders each iteration — coordinate with whoever owns test-data cleanup before running at full 500-VU scale.
- Who owns approving/seeding onboarded, investment-eligible accounts for Invest/Trade (separate from `00-seed-user-pool.js`, which only covers Sign In).
