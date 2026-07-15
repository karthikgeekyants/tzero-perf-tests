# tzero-perf-tests

k6 load and stress performance tests for the tZERO mobile API. Since Web and
Mobile share the same preprod base URL, these scripts exercise both clients'
shared backend.

## Prerequisites

- [k6](https://k6.io/) installed locally (`brew install k6` on macOS).
- A preprod/staging base URL to test against (see [Configuration](#configuration)).

## Project structure

```
config/environment.js   Central env-driven config (base URL, credentials, test data)
lib/http.js             URL + header helpers
lib/auth.js             Shared sign-up / sign-in / provision-user helpers
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

Every scenario supports the same `-e` flags. Example — Sign Up, load test:

```bash
k6 run -e TEST_TYPE=load -e BASE_URL=https://your-preprod-url scenarios/01-signup.js
```

Or via the npm script shortcuts in `package.json` (still override `BASE_URL`
with `-e`, or export it as a real env var first):

```bash
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
| `BASE_URL` | placeholder, **must be set** | Preprod/staging base URL |
| `TEST_TYPE` | `load` | `load` or `stress` |
| `MAX_VUS` | `500` | Peak virtual users for both profiles |
| `SLEEP_SECONDS` | `1` | Pause between steps within an iteration |
| `SIGN_UP_PASSWORD` | `PerfTest@12345` | Password used for newly-registered test users |
| `TEST_2FA_CODE` | `000000` | Placeholder OTP — needs a real preprod bypass code |
| `EMAIL_VERIFICATION_CODE` | `000000` | Placeholder email code — needs a real preprod bypass code |
| `TEST_USER_POOL_SIZE` | `50` | How many pre-seeded accounts to sign in as |
| `TEST_USER_POOL_EMAIL_PATTERN` | `perf.pool.{n}@tzero-perf-test.com` | Email pattern for pooled accounts |
| `TEST_USER_POOL_PASSWORD` | same as `SIGN_UP_PASSWORD` | Password for pooled accounts |
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
exist (and, for Invest/Trade, are already onboarded) — 500 VUs can't
realistically share one login. Seed `TEST_USER_POOL_SIZE` accounts in preprod
ahead of time using the email pattern/password above (e.g. by running the
Sign Up scenario against emails matching `TEST_USER_POOL_EMAIL_PATTERN`)
before running those scenarios at scale.

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

- **`BASE_URL`** is still a placeholder — needs the confirmed preprod URL.
- **`TEST_2FA_CODE`** / **`EMAIL_VERIFICATION_CODE`** are placeholders — real
  SMS/email codes can't be scripted, so a fixed test/bypass value needs to be
  confirmed with the backend team.
- Several response field-name assumptions (account id, order id, asset
  symbol, idempotency key, etc.) are best-guesses and need verifying against
  real API responses once available.
- `accountType` values (`INDIVIDUAL` / `ENTITY`) sent to the onboarding
  create-account call are guesses pending the real API contract.
- Invest via Wire and Trade via Wallet submit real investments/orders each
  iteration — coordinate with whoever owns test-data cleanup before running
  at full 500-VU scale.
