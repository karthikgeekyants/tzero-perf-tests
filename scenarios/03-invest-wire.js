// Scenario 9.3 — Invest (Any Asset) via Wire
// Covers: list primary offerings, get offering detail, resolve primary
// (PIAS) account, ensure investor financial info (annualIncome/netWorth --
// required by regulation-gated offerings like Reg CF), list portfolio
// investments, create/update investment, get wire fees, sign MSA, submit
// payment, submit final investment, get wire details, portfolio dashboard,
// cancel (teardown).
//
// Every payload below is confirmed against live responses (2026-08-21),
// including the account-gated steps. Needs a pool of onboarded accounts
// (signed agreements, so a PIAS account id exists) — seeded separately via
// scenarios/00b-seed-onboarded-pool.js, since the general sign-up pool
// (TEST_USER_POOL_*) is signed-up-only and 404s on account resolution. Per
// instruction this pool does NOT wait on the async KYC verdict.
//
// This scenario submits real investments/wire submissions in staging on
// every run — coordinate with whoever owns test-data cleanup before running
// at full 500-VU scale.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/03-invest-wire.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/03-invest-wire.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn, verifyTotp, resolveAccountIds } from '../lib/auth.js';
import { pickOnboardedPooledUser, pickOnboardedEntityPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import {
  SLEEP_SECONDS,
  INVESTMENT_AMOUNT,
  INVESTOR_ANNUAL_INCOME,
  INVESTOR_NET_WORTH,
  INVESTOR_LEGAL_NAME,
  INVESTMENT_MSA_VERSION,
  POOL_ACCOUNT_TYPE,
} from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only the 2 below
  // would show their own numbers even though all 17 calls in this flow are
  // individually tagged.
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ListAccounts}': [thresholdMs('LIST_ACCOUNTS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetPrimaryAccount}': [thresholdMs('GET_PRIMARY_ACCOUNT_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:UpdatePrimaryProfile}': [thresholdMs('UPDATE_PRIMARY_PROFILE_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:ListPrimaryOfferings}': [thresholdMs('LIST_PRIMARY_OFFERINGS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:GetOfferingDetail}': [thresholdMs('GET_OFFERING_DETAIL_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ListPortfolioInvestments}': [thresholdMs('LIST_PORTFOLIO_INVESTMENTS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:CreateInvestment}': [thresholdMs('CREATE_INVESTMENT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:UpdateInvestment}': [thresholdMs('UPDATE_INVESTMENT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:GetInvestmentFees}': [thresholdMs('GET_INVESTMENT_FEES_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:SignMSA}': [thresholdMs('SIGN_MSA_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:SubmitPaymentDetails}': [thresholdMs('SUBMIT_PAYMENT_DETAILS_P95_THRESHOLD_MS', 1500)],
  'http_req_duration{name:SubmitFinalInvestment}': [thresholdMs('SUBMIT_FINAL_INVESTMENT_P95_THRESHOLD_MS', 1500)],
  'http_req_duration{name:GetWireDetails}': [thresholdMs('GET_WIRE_DETAILS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:GetPortfolioDashboard}': [thresholdMs('GET_PORTFOLIO_DASHBOARD_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:CancelInvestment}': [thresholdMs('CANCEL_INVESTMENT_P95_THRESHOLD_MS', 1000)],
});

const API_LIST = [
  { step: '1. Sign in + verify 2FA', method: 'POST', endpoint: '/auth/login, /auth/2fa/verify/{code}', description: 'Authenticates the pooled account' },
  { step: '2. Resolve PIAS account', method: 'GET', endpoint: '/uap/v1/me', description: 'Resolves the account ID investing routes are keyed on' },
  { step: '3. List accounts / get profile', method: 'GET', endpoint: '/pi/v3/accounts, /pi/v3/accounts/{id}', description: 'Reads the investor profile' },
  { step: '4. Update profile (financial info)', method: 'PUT', endpoint: '/pi/accounts/{id}/individual', description: 'Sets income/net worth once, if missing (needed for regulation-gated offerings)' },
  { step: '5. List / get offering', method: 'GET', endpoint: '/assets, /assets/{id}', description: 'Lists primary offerings and reads one in detail' },
  { step: '6. List portfolio investments', method: 'GET', endpoint: '/pi/v2/investments/accounts/{id}', description: 'Reads existing investments' },
  { step: '7. Create / update investment', method: 'POST/PUT', endpoint: '/pi/v2/investments/accounts/{id}', description: 'Starts a new investment, sets payment type to WIRE' },
  { step: '8. Get wire fee quote', method: 'GET', endpoint: '/pi/v2/investments/{id}/accounts/{id}/fees/WIRE', description: 'Quotes the wire fee' },
  { step: '9. Sign MSA', method: 'POST', endpoint: '/pi/investments/msa', description: 'Signs the master subscription agreement' },
  { step: '10. Submit payment / final investment', method: 'POST', endpoint: '/pi/v2/investments/payments/submissions/accounts/{id}, /pi/v2/investments/submissions/accounts/{id}', description: 'Submits the investment' },
  { step: '11. Get wire details / dashboard', method: 'GET', endpoint: '/pi/wire-details/{clientId}, /pi/v1/portal/accounts/{id}/dashboard', description: 'Reads post-investment data' },
  { step: '12. Cancel investment', method: 'DELETE', endpoint: '/pi/v2/investments/{id}/accounts/{id}', description: 'Teardown so the run doesn’t accumulate live investments' },
];

export function handleSummary(data) {
  return buildSummary('invest-wire', data, API_LIST);
}

export default function () {
  // MIXED: odd VUs -> Individual pool, even VUs -> Entity pool -- each VU
  // still lands on a distinct pooled account within its half.
  const useEntity = POOL_ACCOUNT_TYPE === 'MIXED' ? __VU % 2 === 0 : POOL_ACCOUNT_TYPE === 'ENTITY';
  const user = useEntity ? pickOnboardedEntityPooledUser() : pickOnboardedPooledUser();
  if (!user.totpSecret) {
    console.error(
      `No TOTP secret for ${user.email} — seed the onboarded pool first (scenarios/00b-seed-onboarded-pool.js, or scenarios/00c-seed-onboarded-entity-pool.js for POOL_ACCOUNT_TYPE=ENTITY/MIXED).`
    );
    return;
  }

  // 1. Sign in + TOTP verify
  if (!signIn(user)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);
  const userId = verifyTotp(user.totpSecret);
  if (!userId) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  // 2. Resolve the PIAS account id -- /pi/v2/* investment routes are keyed
  // on this, not the UAP uuid. Returns null (404) if the account isn't
  // onboarded yet.
  const accountIds = resolveAccountIds();
  if (!accountIds || !accountIds.piasAccountId) {
    console.error(`${user.email} has no resolvable PIAS account id — needs a fully onboarded, investment-eligible account. See header comment.`);
    return;
  }
  const piasAccountId = accountIds.piasAccountId;
  const clientId = accountIds.clientId;
  sleep(SLEEP_SECONDS);

  // 3. The profile endpoints (GET/PUT .../individual, used for financial
  // info below) key off a THIRD id, distinct from both the UAP uuid and the
  // PIAS investment id -- confirmed via a live 403 ("a mirror id gets a
  // 403" per the frontend's own code comment). It comes from GET
  // /pi/v3/accounts, filtered to the Primary Issuance silo account.
  let res = http.get(url('/pi/v3/accounts'), { headers: jsonHeaders(), tags: { name: 'ListAccounts' } });
  const accountsOk = check(res, { 'list accounts ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!accountsOk) return;

  const accounts = res.json('accounts') || [];
  const profileAccount = accounts.find((a) => a.businessSilo === 'Primary Issuance') || accounts[0];
  if (!profileAccount) return;
  const profileAccountId = profileAccount.accountId;

  // 4. Ensure annualIncome/netWorth are set -- regulation-gated offerings
  // (e.g. Reg CF) reject CreateInvestment with FAILED_REGULATION_RULES
  // without them. Confirmed this is account-level profile data, set once
  // and never asked for again -- skip the write entirely once already
  // present instead of overwriting every run.
  res = http.get(url(`/pi/v3/accounts/${profileAccountId}`), { headers: jsonHeaders(), tags: { name: 'GetPrimaryAccount' } });
  const profileOk = check(res, { 'get primary account ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!profileOk) return;

  const account = res.json();
  const identity = account.individual?.identity;
  if (!identity?.annualIncome || !identity?.netWorth) {
    const profile = {
      ...account,
      individual: {
        ...account.individual,
        identity: { ...identity, annualIncome: INVESTOR_ANNUAL_INCOME, netWorth: INVESTOR_NET_WORTH },
      },
    };
    res = http.put(url(`/pi/accounts/${profileAccountId}/individual`), JSON.stringify(profile), {
      headers: jsonHeaders(),
      tags: { name: 'UpdatePrimaryProfile' },
    });
    check(res, { 'update primary profile ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  // 5. List primary offerings
  res = http.get(url('/assets?solution=PRIMARY_ISSUANCE&status=OPEN'), {
    headers: jsonHeaders(),
    tags: { name: 'ListPrimaryOfferings' },
  });
  const listOk = check(res, { 'list primary offerings ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  // Confirmed 2026-08-20 against a real response: wrapped in an "assets" key
  // (not bare array or { data: [...] }), each item's id field is `assetId`
  // (a string), not `id`.
  const offerings = res.json('assets') || [];
  const assetId = offerings[0] && offerings[0].assetId;
  if (!assetId) return;

  // 6. Get offering detail -- pricePerShare/minimumInvestment drive the
  // create-investment amount below.
  res = http.get(url(`/assets/${assetId}`), { headers: jsonHeaders(), tags: { name: 'GetOfferingDetail' } });
  check(res, { 'get offering detail ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  const offering = res.json();
  const pricePerShare = offering.pricePerShare || 1;
  const minimumInvestment = offering.minimumInvestment || INVESTMENT_AMOUNT;

  // 7. List portfolio investments -- most-called endpoint in this flow, the
  // app re-reads it after every mutation below.
  res = http.get(url(`/pi/v2/investments/accounts/${piasAccountId}`), {
    headers: jsonHeaders(),
    tags: { name: 'ListPortfolioInvestments' },
  });
  check(res, { 'list portfolio investments ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 8. Create investment -- confirmed 2026-08-21 against live 400s: amount
  // must round down to a whole-share value and numberOfShares (derived the
  // same way) is required, as is clientName (empty string is fine for a
  // first investment in this offering). The configured INVESTMENT_AMOUNT is
  // a floor -- bumped up to the offering's real minimum when it's higher.
  const targetAmount = Math.max(INVESTMENT_AMOUNT, minimumInvestment);
  const numberOfShares = Math.max(1, Math.ceil(targetAmount / pricePerShare));
  const syncedAmount = Math.round(numberOfShares * pricePerShare * 100) / 100;
  res = http.post(
    url(`/pi/v2/investments/accounts/${piasAccountId}`),
    JSON.stringify([{ assetId, amount: syncedAmount, numberOfShares, clientName: '' }]),
    { headers: jsonHeaders(), tags: { name: 'CreateInvestment' } }
  );
  const createOk = check(res, { 'create investment ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);
  if (!createOk) return;

  // Real response is { success: [...], error: [...] }, confirmed 2026-08-21
  // via a live call -- not a bare array or an object with a top-level id.
  const created = res.json();
  const investmentId = created.success && created.success[0] && created.success[0].investmentId;
  if (!investmentId) return;

  // 9. Update investment payment type -- confirmed the body keys off
  // investmentId, not assetId, and still needs numberOfShares.
  res = http.put(
    url(`/pi/v2/investments/accounts/${piasAccountId}`),
    JSON.stringify([{ investmentId, amount: syncedAmount, numberOfShares, paymentType: 'WIRE' }]),
    { headers: jsonHeaders(), tags: { name: 'UpdateInvestment' } }
  );
  check(res, { 'update investment ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 10. Get wire fee quote -- confirmed path shape, keyed on investmentId
  // AND accountId together, not a query param.
  res = http.get(url(`/pi/v2/investments/${investmentId}/accounts/${piasAccountId}/fees/WIRE`), {
    headers: jsonHeaders(),
    tags: { name: 'GetInvestmentFees' },
  });
  check(res, { 'get investment fees ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 11. Sign MSA (master subscription agreement) -- confirmed exact shape.
  // Signature should match the account's actual legal name, which the
  // onboarded pool now captures at seed time (see 00b/00c); fall back to
  // the generic config default only for pool files seeded before that.
  res = http.post(
    url('/pi/investments/msa'),
    JSON.stringify({
      userId,
      assetId,
      userSignature: user.legalName || INVESTOR_LEGAL_NAME,
      version: INVESTMENT_MSA_VERSION,
      correlationId: investmentId,
    }),
    { headers: jsonHeaders(), tags: { name: 'SignMSA' } }
  );
  check(res, { 'sign msa ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 12. Submit payment details
  res = http.post(
    url(`/pi/v2/investments/payments/submissions/accounts/${piasAccountId}`),
    JSON.stringify({ investmentIds: [investmentId] }),
    { headers: jsonHeaders(), tags: { name: 'SubmitPaymentDetails' } }
  );
  check(res, { 'submit payment details ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 13. Submit final investment -- confirmed response carries chargedFees.
  res = http.post(
    url(`/pi/v2/investments/submissions/accounts/${piasAccountId}`),
    JSON.stringify({ investmentIds: [investmentId] }),
    { headers: jsonHeaders(), tags: { name: 'SubmitFinalInvestment' } }
  );
  check(res, { 'submit final investment ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 14. Get wire details -- confirmed keyed on clientId (from
  // resolveAccountIds()), not accountId. Long client-side cached (5 min) in
  // the real app, so don't over-weight this in load profiles.
  if (clientId) {
    res = http.get(url(`/pi/wire-details/${clientId}`), { headers: jsonHeaders(), tags: { name: 'GetWireDetails' } });
    check(res, { 'get wire details ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  // 15. Post-investment portfolio dashboard
  res = http.get(url(`/pi/v1/portal/accounts/${piasAccountId}/dashboard`), {
    headers: jsonHeaders(),
    tags: { name: 'GetPortfolioDashboard' },
  });
  check(res, { 'get portfolio dashboard ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 16. Teardown -- cancel the investment so a long soak doesn't accumulate
  // thousands of live subscriptions (doc's own explicit guidance).
  res = http.del(url(`/pi/v2/investments/${investmentId}/accounts/${piasAccountId}`), null, {
    headers: jsonHeaders(),
    tags: { name: 'CancelInvestment' },
  });
  check(res, { 'cancel investment ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
