# tzero-perf-tests

k6 load and stress performance tests for the tZERO mobile/web API. Web and
Mobile share the same staging gateway, so these scripts exercise both
clients' shared backend at once.

## Prerequisites

- [k6](https://k6.io/) installed locally (`brew install k6` on macOS).
- A staging base URL to test against (see [Configuration](#configuration)).
- **`SIGN_UP_PASSWORD` set** — required by nearly every scenario (directly, or
  via a pool password that defaults to it), and deliberately has no
  committed default since it grants access to real accounts on staging.
  Set it once per shell session before running anything below:
  ```bash
  export SIGN_UP_PASSWORD='...'
  ```
  Every scenario throws immediately at startup if it's missing, rather than
  running with a silently-wrong value.

## Project structure

```
config/environment.js              Central env-driven config (base URL, credentials, test data)
fixtures/sample-document.pdf       Real, structurally valid PDF used for entity document uploads
lib/http.js                        URL + header helpers (cookie session + CSRF header)
lib/auth.js                        Shared sign-up / sign-in / provision-user / TOTP helpers
lib/users.js                       Test user + onboarding test-data generation (unique per iteration, or pooled)
lib/onboarding-individual.js       Individual onboarding flow
lib/onboarding-entity.js           Entity/LLC onboarding flow
lib/options.js                     Shared load/stress VU profiles + threshold helpers
lib/report.js                      HTML/JSON report generation (handleSummary)
scenarios/                         One script per test scenario (see below)
scripts/analyze-run.js             Post-processes a raw --out json run into per-load-step metrics (see below)
scripts/build-pool-secrets.js      Turns 00-seed-user-pool.js's output into config/pool-secrets.json
scripts/build-onboarded-pool-secrets.js         Same, for 00b's onboarded Individual pool
scripts/build-onboarded-entity-pool-secrets.js  Same, for 00c's onboarded Entity pool
scripts/build-signup-run-pool.js   Captures a real 01-signup.js run's own accounts for SIGNIN_SOURCE=CAPTURED
scripts/build-onboarding-run-pool.js  Captures onboarding-run credentials for the dev-approval handoff
scripts/print-dev-credentials.js   Prints email + accountId list to hand a dev for KYC/wallet approval
scripts/run-independent-suite.sh  Sign Up -> Sign In -> Individual Onboarding -> Entity Onboarding, back to back
scripts/run-dependent-suite.sh    Invest via Wire -> Trade via Wallet -> Order History, back to back
scripts/summarize-suite.js        Consolidated pass/fail + latency summary for either suite script
reports/                          Generated HTML/JSON/PDF reports land here (HTML/JSON/logs gitignored)
```

## Scenarios

| Scenario | Doc section | File | Status |
|---|---|---|---|
| Seed sign-up pool | — (setup) | `scenarios/00-seed-user-pool.js` | Run once first — see [Test user pool](#test-user-pool) |
| Seed onboarded Individual pool | — (setup) | `scenarios/00b-seed-onboarded-pool.js` | Run once — see [Onboarded account pool](#onboarded-account-pool-invest--trade--order-history) |
| Seed onboarded Entity pool | — (setup) | `scenarios/00c-seed-onboarded-entity-pool.js` | Run once — same section |
| Sign Up | 9.1 | `scenarios/01-signup.js` | Registers a brand-new user every iteration. |
| Sign In | 9.1 | `scenarios/01b-signin.js` | Needs a pre-seeded account pool (or `SIGNIN_SOURCE=CAPTURED`, see below). |
| Onboarding (Individual) | 9.2 | `scenarios/02-onboarding-individual.js` | End-to-end (sign, KYC, trading-status). Registers + onboards a new user every iteration. |
| Onboarding (Entity/LLC) | 9.2 | `scenarios/02-onboarding-entity.js` | End-to-end, including document upload. |
| Invest via Wire | 9.3 | `scenarios/03-invest-wire.js` | Needs an onboarded, **KYC-approved, wallet-funded** pooled account (Individual or Entity — see `POOL_ACCOUNT_TYPE`). At 500 VUs, real degradation confirmed — see [Known gaps](#known-gaps--open-items). |
| Trade via Wallet | 9.4 | `scenarios/04-trade-wallet.js` | Same account requirement as above. Places and cancels a real order per iteration. Real degradation confirmed at 500 VUs — see [Known gaps](#known-gaps--open-items). |
| Order/Transaction History | 9.5 | `scenarios/05-order-history.js` | Read-only. Same account requirement. Real degradation confirmed at 500 VUs — see [Known gaps](#known-gaps--open-items). |

"Pooled account" scenarios sign in as one of a fixed set of pre-existing
accounts rather than registering a new one every iteration — there are now
**three separate pools**, not one:
- `TEST_USER_POOL_*` (Sign In only, or Invest/Trade/Order History if you
  genuinely just need *a* pool and don't care about KYC eligibility) — see
  [Test user pool](#test-user-pool).
- `ONBOARDED_POOL_*` / `ONBOARDED_ENTITY_POOL_*` — accounts that have been
  through onboarding and (once a dev approves them) are KYC-approved and
  wallet-funded, required for Invest via Wire / Trade via Wallet / Order
  History to do anything meaningful — see
  [Onboarded account pool](#onboarded-account-pool-invest--trade--order-history).

## Running a scenario

First, seed the account pool once (see [Test user pool](#test-user-pool) —
it's a two-step process, seed then build the secrets file):

```bash
k6 run -e BASE_URL=https://your-staging-url scenarios/00-seed-user-pool.js > reports/seed-output.log 2>&1
node scripts/build-pool-secrets.js reports/seed-output.log
```

Then every scenario supports the same `-e` flags. Example — Sign Up, load test:

```bash
k6 run -e TEST_TYPE=load -e BASE_URL=https://your-staging-url scenarios/01-signup.js
```

Or via the npm script shortcuts in `package.json` (still override `BASE_URL`
with `-e`, or export it as a real env var first):

```bash
npm run seed:pool
npm run signup:load          npm run signup:stress
npm run signin:load          npm run signin:stress
npm run onboarding:individual:load    npm run onboarding:individual:stress
npm run onboarding:entity:load        npm run onboarding:entity:stress
npm run invest:load          npm run invest:stress
npm run trade:load           npm run trade:stress
npm run history:load         npm run history:stress
npm run analyze -- <raw-json-file>
npm run suite:independent    # Sign Up -> Sign In -> both Onboarding flows
npm run suite:dependent      # Invest via Wire -> Trade via Wallet -> Order History
npm run suite:summarize -- <scenario-name...>
```

Note `BASE_URL`/`VUS` for the suite scripts are real env vars, not `-e`
flags — `BASE_URL=... VUS=500 npm run suite:dependent`.

`TEST_TYPE` selects the VU profile:
- `load` (default) — ramps to `MAX_VUS`, holds, ramps down.
- `stress` — ramps through and holds at 1x / 2x / 3x `MAX_VUS` to find the breaking point.
- `staircase` — climbs through a fine-grained list of VU levels
  (`STAIRCASE_STEPS`, default `20,40,60,80,100,150,200,300,500,750,1000`),
  holding briefly at each one (`STAIRCASE_HOLD_DURATION`, default `30s`) so
  `scripts/analyze-run.js`'s per-bucket breakdown lines up with real,
  distinct VU levels instead of an interpolated ramp. Steps are
  deliberately finer at the low end and coarser higher up — use this when
  you need the *exact* VU count something breaks at, not just "it broke
  somewhere in this plateau." Override the ladder entirely with
  `-e STAIRCASE_STEPS="10,20,30,...,500"` (comma-separated, any values).

**Important: don't pass `--vus`/`--iterations` on the CLI if you want the
`load`/`stress` ramp profile above.** k6 does not merge CLI `--vus`/
`--iterations` with a scenario's exported `options.stages` — it **replaces**
it entirely, running as a flat "N iterations shared among N VUs" burst
instead (verified against the installed k6 version). Concretely:

```bash
# Ramps 0 -> 100 -> 500, holds 5 min at 500, ramps down -- the real load profile:
k6 run -e TEST_TYPE=load -e MAX_VUS=500 scenarios/05-order-history.js

# Fires all 500 VUs at once for exactly one iteration each, ~1-2 minutes total --
# NOT the ramp profile, even though TEST_TYPE=load is set:
k6 run --vus 500 --iterations 500 scenarios/05-order-history.js
```

Both are valid ways to run a scenario, but they measure different things —
a sustained-concurrency curve vs. a one-shot burst — and every 500-VU report
generated so far (Sign Up, Sign In, both Onboarding flows, Invest via Wire,
Trade via Wallet, Order History) used the **second** form. Keep using the
same form across a comparison, and say explicitly which one a given report
used when sharing it.

### Running multiple scenarios back to back (suite scripts)

Two shell scripts sequence related scenarios and print one consolidated
summary, instead of running/tracking each report by hand:

```bash
# Sign Up -> Sign In -> Individual Onboarding -> Entity Onboarding
BASE_URL=https://your-staging-url VUS=500 ./scripts/run-independent-suite.sh

# Invest via Wire -> Trade via Wallet -> Order History (needs the onboarded
# pool below, already KYC-approved/wallet-funded)
BASE_URL=https://your-staging-url VUS=500 ./scripts/run-dependent-suite.sh
```

Both use the `--vus N --iterations N` burst form described above (matching
every report generated so far), print each scenario's own report path as it
finishes, then run `scripts/summarize-suite.js` at the end for a combined
pass/fail + latency view. The dependent suite runs Trade via Wallet before
Order History deliberately — Order History needs orders to actually exist to
list. k6 exits with code 99 on a threshold breach (routine under load, not a
functional failure); both scripts treat that as informational and keep going
rather than aborting the rest of the suite.

## Configuration

Nothing in this project is hardcoded — every real value (test data, retry
tuning, thresholds) is an env var with a sensible fallback, set via
`-e NAME=value` on the `k6 run` command. Values that are fixed API
enums/protocol constants (e.g. FIX order-side codes, `businessSilo` filter
values) are not configurable — they define what the flow *is*, not tunable
test data.

**Core / shared**

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `https://gateway-web-markets-staging.tzero.com` | Staging gateway (confirmed — same host serves both web and mobile) |
| `TEST_TYPE` | `load` | `load` or `stress` |
| `MAX_VUS` | `500` | Peak virtual users for both profiles |
| `SLEEP_SECONDS` | `1` | Pause between steps within an iteration |
| `SIGN_UP_PASSWORD` | **required, no default** | Password used for newly-registered test users. Grants access to real (if synthetic) staging accounts, so it's deliberately not committed to source — every script that touches it throws immediately if it's unset. Set it once per shell session: `export SIGN_UP_PASSWORD='...'` |
| `TEST_USER_EMAIL_DOMAIN` | `tzero-perf-test.com` | Domain used for every generated test-user email |
| `SESSION_REFRESH_INTERVAL_MS` | `150000` | How often long flows force a session refresh (access token lives ~180s) |
| `EMAIL_VERIFICATION_CODE` | `000000` | Fallback only — confirmed **not** a real bypass code (see [Known gaps](#known-gaps--open-items)) |

**Sign-in pool** (`scenarios/00-seed-user-pool.js`, Sign In)

| Variable | Default | Purpose |
|---|---|---|
| `TEST_USER_POOL_SIZE` | `500` (matches `MAX_VUS`) | How many accounts get created / signed in as |
| `TEST_USER_POOL_EMAIL_PATTERN` | `perf.pool.{n}@<TEST_USER_EMAIL_DOMAIN>` | Email pattern for pooled accounts |
| `TEST_USER_POOL_PASSWORD` | same as `SIGN_UP_PASSWORD` | Password for pooled accounts |
| `SEED_VUS` | `10` | Concurrency for the one-time seed run (not a load test) |
| `SIGNIN_SOURCE` | `POOL` | `POOL` (this pool) or `CAPTURED` (reuse a Sign Up run's own accounts — see [Onboarded account pool](#onboarded-account-pool-invest--trade--order-history)) |

**Onboarded pool** (`scenarios/00b`/`00c`-seed-onboarded*.js, Invest, Trade, Order History — see [Onboarded account pool](#onboarded-account-pool-invest--trade--order-history))

| Variable | Default | Purpose |
|---|---|---|
| `ONBOARDED_POOL_SIZE` | `500` | Individual pool size |
| `ONBOARDED_POOL_EMAIL_PATTERN` | `perf.onbpool.{n}@<TEST_USER_EMAIL_DOMAIN>` | Individual pool email pattern |
| `ONBOARDED_POOL_PASSWORD` | same as `SIGN_UP_PASSWORD` | Individual pool password |
| `ONBOARDED_ENTITY_POOL_SIZE` | `500` | Entity/LLC pool size |
| `ONBOARDED_ENTITY_POOL_EMAIL_PATTERN` | `perf.onbpool.ent.{n}@<TEST_USER_EMAIL_DOMAIN>` | Entity pool email pattern |
| `ONBOARDED_ENTITY_POOL_PASSWORD` | same as `SIGN_UP_PASSWORD` | Entity pool password |
| `POOL_ACCOUNT_TYPE` | `INDIVIDUAL` | `INDIVIDUAL`, `ENTITY`, or `MIXED` (odd VUs Individual, even VUs Entity) — which onboarded pool Invest/Trade/Order History draw from |

**Onboarding — shared (Individual + Entity)**

| Variable | Default | Purpose |
|---|---|---|
| `ONBOARDING_FIRST_NAME_PREFIX` | `Perf` | Generated first name |
| `ONBOARDING_LAST_NAME_PREFIX` | `Test` | Generated last name |
| `ONBOARDING_DATE_OF_BIRTH` | `1990-01-01` | ISO 8601 date of birth |
| `ONBOARDING_CITIZENSHIP_COUNTRY` | `US` | Citizenship/country |
| `ONBOARDING_ADDRESS_LINE1` | `200 Park Ave` | Residential/entity address line 1 |
| `ONBOARDING_CITY` | `New York` | City |
| `ONBOARDING_STATE` | `NY` | State |
| `ONBOARDING_ZIP` | `10166` | Zip/postal code |
| `ONBOARDING_COUNTRY` | `US` | Country |
| `ONBOARDING_EMPLOYMENT_STATUS` | `FULL_TIME_EMPLOYED` | Employment step |
| `ONBOARDING_EMPLOYER_NAME` | `Acme Corp` | Employment step |
| `ONBOARDING_OCCUPATION` | `Software Engineer` | Employment step |
| `ONBOARDING_INVESTMENT_OBJECTIVE` | `CAPITAL_APPRECIATION` | Investor-info risk-profile step |
| `ONBOARDING_SIGN_MAX_ATTEMPTS` | `6` | Retry count for `sign` (422/408 are transient) |
| `ONBOARDING_SIGN_RETRY_DELAY_SECONDS` | `20` | Delay between `sign` retries |
| `ONBOARDING_DOCUMENT_UPLOAD_MAX_ATTEMPTS` | `8` | Retry count for entity document upload (503/500) |
| `ONBOARDING_DOCUMENT_UPLOAD_RETRY_DELAY_SECONDS` | `8` | Delay between document-upload retries |
| `ONBOARDING_SUBMIT_MAX_ATTEMPTS` | `8` | Retry count for entity `submit` (503/500 are transient) |
| `ONBOARDING_SUBMIT_RETRY_DELAY_SECONDS` | `8` | Delay between `submit` retries |

**Onboarding — Entity/LLC only**

| Variable | Default | Purpose |
|---|---|---|
| `ONBOARDING_ENTITY_ACCOUNT_TYPE` | `LLC` | Real enum: `INDIVIDUAL`, `JOINT`, `LLC`, `CORPORATION`, `PARTNERSHIP`, `TRUST` — override to test other entity types |
| `ONBOARDING_ENTITY_NAME` | `Perf Test LLC` | Business name |
| `ONBOARDING_ENTITY_DATE_OF_FORMATION` | `2015-01-01` | Formation date |
| `ONBOARDING_ENTITY_COUNTRY_OF_FORMATION` | `US` | Formation country |
| `ONBOARDING_ENTITY_REGION_OF_FORMATION` | `DE` | Formation region/state |
| `ONBOARDING_ENTITY_COUNTRY_OF_TAXATION` | `US` | Taxation country |
| `ONBOARDING_ENTITY_PHONE` | `+18888888888` | Entity phone |
| `ONBOARDING_ENTITY_EIN_PREFIX` | `12` | Must be a valid IRS campus prefix, not just `xx-xxxxxxx` format |
| `ONBOARDING_CONTROL_PERSON_TITLE` | `Managing Member` | Required whenever `associatedPeople` has a `CONTROL_PERSON` role |

**Invest via Wire**

| Variable | Default | Purpose |
|---|---|---|
| `INVESTMENT_AMOUNT` | `100` | Floor amount for a new investment — auto-bumped up to the offering's real minimum when higher |
| `DEFAULT_ASSET_TYPE` | `EQUITY` | Fallback asset type for **primary** trading-status eligibility checks |
| `INVESTOR_ANNUAL_INCOME` | `10000` | Set once on an account's profile the first time it invests in a regulation-gated (e.g. Reg CF) offering; never re-asked for after |
| `INVESTOR_NET_WORTH` | `200000` | Same as above |
| `INVESTOR_LEGAL_NAME` | `Perf Test` | Typed "signature" name on the MSA (master subscription agreement) |
| `INVESTMENT_MSA_VERSION` | `v1` | MSA document version sent when signing |

**Trade via Wallet**

| Variable | Default | Purpose |
|---|---|---|
| `TRADE_QUANTITY` | `1` | Order quantity |
| `TRADE_SIDE` | `BUY` | `BUY` or `SELL` |
| `TRADE_ORDER_TYPE` | `LIMIT` | `MARKET`, `LIMIT`, `STOP`, or `STOP_LIMIT` |
| `TRADE_TIME_IN_FORCE` | `DAY` | `DAY`, `GTC`, or `GTD` — see [Known gaps](#known-gaps--open-items) for a DAY-specific caveat |
| `DEFAULT_TRADE_PRICE` | `10` | Fallback price only if the order book has no live ask to price a BUY off of |

Load/stress stage timing and thresholds (`lib/options.js`) are also
env-overridable — e.g. `LOAD_RAMP_UP_DURATION`, `STRESS_BREAKPOINT_PCT`,
`LOAD_P95_THRESHOLD_MS`. Per-endpoint thresholds in each scenario file follow
the same pattern (e.g. `SIGNUP_P95_THRESHOLD_MS`, `PLACE_ORDER_P95_THRESHOLD_MS`).

The stress profile holds at three plateaus so each is independently
measurable — `MAX_VUS` (1x), `STRESS_MID_PCT*MAX_VUS` (2x, default 1,000 at
the default `MAX_VUS=500`), and `STRESS_BREAKPOINT_PCT*MAX_VUS` (3x, default
1,500) — matching the plan's "2x-3x = 1,000-1,500 users" stress target. Ramp
and hold durations for each leg (`STRESS_TO_MID_DURATION`,
`STRESS_HOLD_MID_DURATION`, `STRESS_TO_BREAKPOINT_DURATION`,
`STRESS_HOLD_BREAKPOINT_DURATION`, etc.) are all overridable the same way.

End-of-run summaries (console + HTML/JSON) include p99 alongside
avg/min/med/max/p90/p95 (`summaryTrendStats` in `buildOptions()`).

## Per-load-step metrics, breaking point, and degradation curve

The HTML/JSON report from `handleSummary()` (`lib/report.js`) is a single
aggregate over the whole run — it can't tell you "what was p95 specifically
at 1,000 VUs" or "where did it start failing." For that, run k6 with its raw
time-series output and feed it to `scripts/analyze-run.js`:

```bash
k6 run -e TEST_TYPE=stress --out json=reports/raw-trade-stress.ndjson scenarios/04-trade-wallet.js
npm run analyze -- reports/raw-trade-stress.ndjson
```

This prints (and writes a CSV of) a table bucketed by time — VUs, RPS,
avg/p50/p95/p99, and error % per bucket — which, thanks to the stress
profile's plateaus, lines up with each load step (500 / 1,000 / 1,500 VUs).
It also reports:
- **Breaking point** — the first bucket where the error rate or p95 crosses
  a threshold (`--error-threshold`, `--p95-threshold` flags; defaults 5% and
  2000ms), along with the VU count at that point.
- **Failure type breakdown** — failed requests categorized by status
  (connection error/timeout, 4xx, 5xx) from the `http_req_failed` tags.
- **Recovery time** — from the load peak (detected off the `vus` samples,
  not an assumed stage boundary) to the first `--recovery-consecutive`
  (default 2) consecutive buckets where error rate and p95 are both back
  under threshold. If the run never exceeded thresholds, or never recovers
  within the captured data, it says so explicitly rather than guessing —
  extend `STRESS_RAMP_DOWN_DURATION`/`maxDuration` if you need more
  post-peak data to see recovery.

Works the same way for the load profile if you just want per-bucket detail
instead of the aggregate summary — note the `load` profile only has a
single plateau at `MAX_VUS`, not three.

**For the exact VU count something breaks at, use `TEST_TYPE=staircase`
instead of `stress`.** The 3-plateau `stress` profile tells you it broke
somewhere between two widely-spaced levels (e.g. 500 and 1,000); `staircase`
climbs through ~11 finer levels (20 up to 1,000 by default) so the same
analysis pinpoints the specific step:

```bash
k6 run -e TEST_TYPE=staircase --out json=reports/raw-trade-staircase.ndjson scenarios/04-trade-wallet.js
node scripts/analyze-run.js reports/raw-trade-staircase.ndjson --bucket=30
```

Use a `--bucket` size matching (or a bit under) `STAIRCASE_HOLD_DURATION` so
each bucket lines up with one step instead of averaging across two.

**Server-side CPU/memory is the one thing this can't cover.** k6 only sees
the HTTP responses it gets back — it has no visibility into what's
happening inside the backend process. The script prints the run's exact UTC
start/end window instead, so that range can be handed straight to whoever
owns the backend's own monitoring (Datadog/CloudWatch/Grafana) to pull for
the same window.

A quick 200-VU trial of Sign Up already surfaced real backend strain well
below the 500-VU baseline — 17% request failure rate and p95 response times
4-8x over target (see [Known gaps](#known-gaps--open-items)) — worth
factoring in before assuming 500+ will behave.

## Test user pool

Sign In, Invest, Trade, and Order History all need accounts that already
exist — 500 VUs can't realistically share one login. Seeding is a two-step
process:

```bash
k6 run scenarios/00-seed-user-pool.js > reports/seed-output.log 2>&1
node scripts/build-pool-secrets.js reports/seed-output.log
```

The first command registers exactly `TEST_USER_POOL_SIZE` accounts (email
matching `TEST_USER_POOL_EMAIL_PATTERN`) and enrols + verifies TOTP for each
one. The second step is required: Sign In needs each pooled account's TOTP
secret to compute a login code later, but that secret only exists at the
moment of enrolment and k6 can't share JS state across VUs or between
separate `k6 run` invocations — so the seed run logs a parseable line per
account, and `build-pool-secrets.js` turns the captured output into
`config/pool-secrets.json`, which `lib/users.js` reads at k6 init time. That
file isn't committed (see `.gitignore`) since it's generated,
environment-specific secret material.

Skipping the second step (or running Sign In against a pool that was never
built into `pool-secrets.json`) fails loudly and immediately — the scenario
logs which pooled account has no TOTP secret rather than failing somewhere
confusing mid-flow.

It does **not** run onboarding/KYC, so these accounts aren't yet
investment-eligible for Invest via Wire / Trade via Wallet — see the next
section for the pool those two scenarios (and Order History) actually need.

## Onboarded account pool (Invest / Trade / Order History)

Invest via Wire, Trade via Wallet, and Order History all need accounts that
are further along than the Test user pool above: onboarded (so a resolvable
PIAS account id exists), and — separately — **KYC-approved and
wallet-funded**, which nothing in this repo can do on its own; that step
needs a human (dev/ops) with staging DB or admin-panel access. There are two
separate pools, one per account type:

```bash
# Individual pool
k6 run scenarios/00b-seed-onboarded-pool.js > reports/seed-onboarded-output.log 2>&1
node scripts/build-onboarded-pool-secrets.js reports/seed-onboarded-output.log

# Entity/LLC pool
k6 run scenarios/00c-seed-onboarded-entity-pool.js > reports/seed-onboarded-entity-output.log 2>&1
node scripts/build-onboarded-entity-pool-secrets.js reports/seed-onboarded-entity-output.log
```

Each seeds `ONBOARDED_POOL_SIZE` / `ONBOARDED_ENTITY_POOL_SIZE` accounts
through onboarding up to and including signing agreements (KYC
verdict/trading-status are **not** polled or waited on here), then builds
`config/onboarded-pool-secrets.json` / `config/onboarded-entity-pool-secrets.json`
the same way the Test user pool does. These seed scripts intermittently 422
or 408 on the final `sign` call (secondary-account provisioning lag) and
retry through it (`ONBOARDING_SIGN_MAX_ATTEMPTS`/`_RETRY_DELAY_SECONDS`) —
without that retry, a handful of accounts silently drop out of the pool below
the configured size every seed run.

**After seeding, hand the accounts to a dev/ops for approval** — run
`node scripts/print-dev-credentials.js` to get a plain email + accountId list
(no passwords/secrets) suitable for sharing. Nothing in Invest/Trade/Order
History will pass meaningfully until that approval is done; every account
will otherwise read back `frozen: true` (normal, expected pre-approval
state — not a bug) or, for Trade specifically, a separate `403
FROZEN_ACCOUNT` at the trading-account level.

Once approved, pick which pool a scenario draws from with `POOL_ACCOUNT_TYPE`:

| Value | Behavior |
|---|---|
| `INDIVIDUAL` (default) | Every VU uses the Individual onboarded pool |
| `ENTITY` | Every VU uses the Entity/LLC onboarded pool |
| `MIXED` | Odd VUs -> Individual pool, even VUs -> Entity pool (both exercised in one run) |

Separately, `SIGNIN_SOURCE` controls what Sign In itself draws from:
`POOL` (default, the Test user pool) or `CAPTURED` (reuse a Sign Up run's own
freshly-created accounts via `config/signup-run-pool.json` — see
`scripts/build-signup-run-pool.js` — instead of needing a separate seed step).

## Reports

Every run generates two files in `reports/`, named
`<scenario>-<load|stress>-<timestamp>`:
- `.html` — shareable visual report (pass/fail, response times, charts).
- `.json` — raw k6 summary data.

Console output (the usual k6 text summary) still prints as normal.

> The HTML report is built via the community `k6-reporter` library, fetched
> from GitHub at runtime — the machine running `k6 run` needs outbound
> internet access for the report step to work.

## Known gaps / open items

**All 7 flows have been run end-to-end against real accounts at 500 VUs on
staging.** The KYC-approval bottleneck that used to block Invest via
Wire/Trade via Wallet/Order History is resolved — 500 onboarded accounts
(Individual + Entity) were approved by dev and used for the runs below. What
follows is the actual state from those runs, not general uncertainty about
whether the scripts work — every flow runs; several show real backend
degradation under concurrent load, which is the whole point of this test
pass.

**Real 500-VU results (`--vus 500 --iterations 500`, staging):**
- **Sign Up** — 87.2% success; `POST /identities` p95 ~33s under load.
- **Sign In** — sign-in itself 100%, but 2FA verify drops to 87%.
- **Individual Onboarding** — full funnel completes end-to-end, but only
  5.3% sign agreements successfully.
- **Entity Onboarding** — submit/document-upload/sign reject 100% of
  attempts at 500 VUs (fast rejections, not timeouts).
- **Invest via Wire** — sign-in/2FA fine; "list accounts" drops to 46%, and
  the final "submit investment" step succeeds only 9% of the survivors —
  two separate bottlenecks, not one.
- **Trade via Wallet** — sign-in fine; TOTP verification (35%) and "resolve
  secondary account" (31%) degrade early, "cancel order" at the end only 47%.
- **Order History** — sign-in 100%, but TOTP verification (72%), account
  resolution (67%), and listing account documents (34%) degrade, with p95
  latency reaching ~20s.

Reports for all 7 are in `reports/` (PDFs converted for ticket attachment).
The consistent shape — early steps (sign-in) hold up fine, later steps
progressively collapse — points at synchronous fan-out to legacy backend
services under concurrent load as the likely root cause, not a client/script
issue; confirm with the backend team using the exact UTC run windows from
each report.

**Fixed this pass:**
- **Entity/LLC Onboarding document upload** (was failing ~50% of the time)
  — root cause confirmed with the backend team: the upload handler resolves
  the account from the JWT's `accountId` claim, which can predate the
  entity account's creation. `lib/onboarding-entity.js` now forces a fresh
  token (`refreshSession()`) right after `submit`, before any document
  upload.
- **Trade via Wallet order pricing** — was picking a hardcoded fallback
  price instead of a real quote in some cases; now tries the live ASK, then
  the live BID, before falling back to `DEFAULT_TRADE_PRICE`.
- **Self-inflicted rate-limit risk** — `01-signup.js`, `01b-signin.js`,
  `03-invest-wire.js`, `04-trade-wallet.js`, `05-order-history.js` all had a
  sign-in/TOTP failure path that returned instantly with no pause,
  so any transient failure at 500 VUs could spiral into a tight fail-retry
  loop hammering `/auth/login` fast enough to trigger Cloudflare's own
  rate limiter (observed directly on staging this pass — see the
  Cloudflare note below). All five now sleep before returning on that path,
  matching every other failure point in the same files.
- **Seed-script sign retries** — `00b`/`00c`-seed-onboarded*.js now retry
  422/408 on the final `sign` call like the real onboarding flow already
  does; without it, seed runs silently dropped a handful of accounts below
  the configured pool size.
- **Entity onboarding submit retry** — `lib/onboarding-entity.js`'s
  `submit` step now retries 503/500 like the sign/document-upload steps in
  the same file already did.
- **Duplicate phone numbers** — `generatePhone()` collided every 200 VUs
  (e.g. VU 1 and VU 201 got the identical number); the area-code list was
  widened so the collision period is 900 VUs, past the default `MAX_VUS=500`.
- **Duplicate names** — every onboarding account was using the exact same
  first+last name (a real trigger for backend duplicate-person/fraud
  checks under concurrent load); names now carry a per-VU/iteration
  letter-only suffix (the field only accepts letters/spaces/hyphens/
  apostrophes/periods, so a numeric suffix isn't valid).
- **`INVESTOR_ANNUAL_INCOME`/`INVESTOR_NET_WORTH`** were plain strings,
  unlike every other numeric config value; now wrapped in `Number(...)`.

**Known, not yet fixed:**
- **`resolveAccountIds()`'s `clientId` is always `undefined`** — confirmed
  it isn't present on `/uap/v1/me`'s response at all (only obtainable, if at
  all, from `/2fa/verify`, which `verifyTotp()` currently discards). This
  makes the "Get wire details" step in `scenarios/03-invest-wire.js`
  permanently dead code — `if (clientId) {...}` never runs, which is why
  that step never appears in any Invest via Wire report's checks list
  despite being in `API_LIST` and having a configured threshold.
- **Invest via Wire's financial-info step may not handle Entity accounts
  correctly.** It unconditionally reads `account.individual?.identity` and
  PUTs to `/pi/accounts/{id}/individual`, with no branch for
  `POOL_ACCOUNT_TYPE=ENTITY`/`MIXED` accounts, whose real profile response
  shape for this endpoint hasn't been confirmed live. Not fixed without that
  confirmation — this codebase's whole discipline is not guessing at
  unconfirmed API shapes — but worth a live check before relying on
  Entity-pool results from this specific step.
- `TRADE_TIME_IN_FORCE=DAY` orders failed with `VALIDATION_FAIL — "The
  expireTime is invalid because it is in the past"` when tested on a
  weekend/closed market — suspected to be a legitimate side effect of DAY
  orders needing a same-session expiry to compute against (switching to
  `GTC` placed/cancelled a real order successfully at the same time), not
  re-verified with `DAY` during actual market hours.

**Cloudflare rate-limiting (operational note, not a script bug).** Staging
sits behind a Cloudflare rate limiter (`error code: 1015`, `HTTP 429`,
`retry-after` header) that appears to trigger on **cumulative** request
volume across a rolling window, not per-test — running several flows at 500
VUs back to back in one day is enough to trip it, and hitting it again while
already blocked seems to extend the window rather than being ignored. If a
run fails instantly and uniformly at the very first step (sign-in) with
`http_req_failed` near 100%, check for this directly
(`curl -i -X POST <BASE_URL>/auth/login ...`) before assuming a code
regression — waiting it out (with **no** further requests against staging in
the meantime, including status checks) is the only fix.

**`EMAIL_VERIFICATION_CODE` is a placeholder, not a real bypass.** The
`sendEmailVerificationCode` response only ever returns a status label (e.g.
`"SENT"`), never the actual code — that only ever reaches the user's real
inbox, which this test domain doesn't have. Sign Up/Onboarding send the
request (so that traffic is exercised) but submit this fixed fallback value
rather than a real code; expect that specific step to reject it if the
backend ever actually validates it strictly.

**Server-side CPU/memory during stress** genuinely can't be captured from
k6 — it has no visibility into the backend process. Needs the backend/infra
team to pull their own monitoring (Datadog/CloudWatch/Grafana) for the run
window (`scripts/analyze-run.js` prints the exact UTC window to hand them).
