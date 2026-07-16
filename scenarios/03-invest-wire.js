// Scenario 9.3 — Invest (Any Asset) via Wire
// Covers: list primary offerings, get offering detail, resolve primary account,
// invest eligibility gate, list portfolio investments, create/update investment
// amount, calculate fees, get wire details, sign MSA, submit payment details,
// submit final investment, check wallet balance.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/03-invest-wire.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/03-invest-wire.js
//
// Requires a pool of already onboarded, investment-eligible accounts in
// staging (see TEST_USER_POOL_* in config/environment.js) — this flow signs in
// as an existing user rather than registering a new one. This scenario
// submits real investments/wire submissions in staging on every run —
// coordinate with whoever owns test-data cleanup before running at full
// 500-VU scale.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn } from '../lib/auth.js';
import { pickPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import {
  SLEEP_SECONDS,
  INVESTMENT_AMOUNT,
  DEFAULT_ASSET_TYPE,
  DEFAULT_BROKER_ID,
} from '../config/environment.js';

export const options = buildOptions({
  'http_req_duration{name:SubmitFinalInvestment}': [thresholdMs('SUBMIT_FINAL_INVESTMENT_P95_THRESHOLD_MS', 1500)],
  'http_req_duration{name:CalculateInvestmentFees}': [thresholdMs('CALCULATE_INVESTMENT_FEES_P95_THRESHOLD_MS', 800)],
});

export function handleSummary(data) {
  return buildSummary('invest-wire', data);
}

export default function () {
  const user = pickPooledUser();
  const token = signIn(user);
  sleep(SLEEP_SECONDS);
  if (!token) return;

  // 1. List primary offerings
  let res = http.get(url('/assets?solution=PRIMARY_ISSUANCE&status=OPEN'), {
    headers: jsonHeaders(token),
    tags: { name: 'ListPrimaryOfferings' },
  });
  const listOk = check(res, { 'list primary offerings ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  const offeringsBody = res.json();
  const offerings = Array.isArray(offeringsBody) ? offeringsBody : offeringsBody.data || [];
  // TODO: confirm the actual response shape (bare array vs. { data: [...] }).
  const assetId = offerings[0] && offerings[0].id;
  if (!assetId) return;

  // 2. Get offering detail
  res = http.get(url(`/assets/${assetId}`), { headers: jsonHeaders(token), tags: { name: 'GetOfferingDetail' } });
  check(res, { 'get offering detail ok': (r) => r.status === 200 });
  const offeringDetail = res.json();
  const assetType = offeringDetail.assetType || DEFAULT_ASSET_TYPE;
  // TODO: confirm the actual field name for asset type on the offering detail response.
  sleep(SLEEP_SECONDS);

  // 3. Resolve primary account
  res = http.get(url('/pi/v3/accounts'), { headers: jsonHeaders(token), tags: { name: 'ResolvePrimaryAccount' } });
  const resolveOk = check(res, { 'resolve primary account ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!resolveOk) return;

  const accountsBody = res.json();
  const account = Array.isArray(accountsBody) ? accountsBody[0] : accountsBody;
  // TODO: confirm the actual response shape for /pi/v3/accounts (array vs. object, field names).
  const accountId = account && (account.id || account.accountId);
  const clientId = account && account.clientId;
  if (!accountId) return;

  // 4. Invest eligibility gate
  res = http.get(
    url(`/uap/v1/accounts/${accountId}/trading-status?platform=primary&assetType=${assetType}`),
    { headers: jsonHeaders(token), tags: { name: 'InvestEligibilityGate' } }
  );
  check(res, { 'invest eligibility gate ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 5. List portfolio investments
  res = http.get(url(`/pi/v2/investments/accounts/${accountId}`), {
    headers: jsonHeaders(token),
    tags: { name: 'ListPortfolioInvestments' },
  });
  check(res, { 'list portfolio investments ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 6. Create investment amount
  res = http.post(
    url(`/pi/v2/investments/accounts/${accountId}`),
    JSON.stringify({ assetId, amount: INVESTMENT_AMOUNT }),
    // TODO: confirm the required create-investment payload fields.
    { headers: jsonHeaders(token), tags: { name: 'CreateInvestmentAmount' } }
  );
  const createOk = check(res, { 'create investment amount ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);
  if (!createOk) return;

  // 7. Update investment amount/payment type
  res = http.put(
    url(`/pi/v2/investments/accounts/${accountId}`),
    JSON.stringify({ assetId, amount: INVESTMENT_AMOUNT, paymentType: 'WIRE' }),
    // TODO: confirm the required update-investment payload fields.
    { headers: jsonHeaders(token), tags: { name: 'UpdateInvestmentAmount' } }
  );
  check(res, { 'update investment amount ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 8. Calculate investment fees
  res = http.get(url(`/pi/v2/investments/accounts/${accountId}`), {
    headers: jsonHeaders(token),
    tags: { name: 'CalculateInvestmentFees' },
  });
  check(res, { 'calculate investment fees ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 9. Get wire details
  if (clientId) {
    res = http.get(url(`/pi/wire-details/${clientId}`), {
      headers: jsonHeaders(token),
      tags: { name: 'GetWireDetails' },
    });
    check(res, { 'get wire details ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }
  // TODO: /pi/v3/accounts didn't return a clientId in the shape assumed above —
  // confirm where clientId actually comes from if this step is being skipped.

  // 10. Sign MSA
  res = http.post(
    url('/pi/investments/msa'),
    JSON.stringify({}), // TODO: confirm the required MSA signature payload.
    { headers: jsonHeaders(token), tags: { name: 'SignMSA' } }
  );
  check(res, { 'sign msa ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 11. Submit payment details
  res = http.post(
    url(`/pi/v2/investments/payments/submissions/accounts/${accountId}`),
    JSON.stringify({}), // TODO: confirm the required wire payment details payload.
    { headers: jsonHeaders(token), tags: { name: 'SubmitPaymentDetails' } }
  );
  check(res, { 'submit payment details ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 12. Submit final investment
  res = http.post(
    url(`/pi/v2/investments/submissions/accounts/${accountId}`),
    JSON.stringify({}), // TODO: confirm the required final submission payload.
    { headers: jsonHeaders(token), tags: { name: 'SubmitFinalInvestment' } }
  );
  check(res, { 'submit final investment ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 13. Check wallet balance (tZERO balance payment)
  res = http.get(
    url(`/wallets/balances/portfolios?accountId=${accountId}&brokerId=${DEFAULT_BROKER_ID}`),
    { headers: jsonHeaders(token), tags: { name: 'CheckWalletBalance' } }
  );
  check(res, { 'check wallet balance ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
