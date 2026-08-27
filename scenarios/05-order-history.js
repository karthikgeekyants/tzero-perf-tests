// Scenario 9.5 — View Transaction / Order History
// Covers: list orders, get order detail, list confirmation execution dates,
// download confirmation PDF, list account documents.
//
// Every endpoint/payload below is confirmed against the real frontend's own
// API client (packages/api-client/src/domains/secondary + documents,
// 2026-08-21).
//
// Read-only scenario (no order placement/cancellation here — see
// scenarios/04-trade-wallet.js for that). Draws from the onboarded pool(s)
// (ONBOARDED_POOL_* / ONBOARDED_ENTITY_POOL_* in config/environment.js, same
// as scenarios/03-invest-wire.js / 04-trade-wallet.js) — needs accounts that
// have actually placed orders (e.g. via scenarios/04-trade-wallet.js) for the
// list/detail calls to return meaningful data.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/05-order-history.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/05-order-history.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn, verifyTotp, resolveAccountIds } from '../lib/auth.js';
import { pickOnboardedPooledUser, pickOnboardedEntityPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { SLEEP_SECONDS, POOL_ACCOUNT_TYPE } from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only the 2 below
  // would show their own numbers even though all 8 calls in this flow are
  // individually tagged.
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ListOrders}': [thresholdMs('LIST_ORDERS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:GetOrderDetail}': [thresholdMs('GET_ORDER_DETAIL_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:ListConfirmationExecutionDates}': [thresholdMs('LIST_CONFIRMATION_EXECUTION_DATES_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:DownloadConfirmationPdf}': [thresholdMs('DOWNLOAD_CONFIRMATION_PDF_P95_THRESHOLD_MS', 1500)],
  'http_req_duration{name:ListAccountDocuments}': [thresholdMs('LIST_ACCOUNT_DOCUMENTS_P95_THRESHOLD_MS', 800)],
});

const API_LIST = [
  { step: '1. Sign in + verify 2FA', method: 'POST', endpoint: '/auth/login, /auth/2fa/verify/{code}', description: 'Authenticates the pooled account' },
  { step: '2. List orders', method: 'GET', endpoint: '/orders', description: 'Lists the account’s order history' },
  { step: '3. Get order detail', method: 'GET', endpoint: '/orders/{orderId}', description: 'Full detail + execution history for one order' },
  { step: '4. List confirmation execution dates', method: 'GET', endpoint: '/orders/confirmations/executions', description: 'Dates with trade confirmation documents available' },
  { step: '5. Download confirmation PDF', method: 'GET', endpoint: '/orders/confirmations/{date}', description: 'Downloads a trade confirmation document' },
  { step: '6. List account documents', method: 'GET', endpoint: '/uap/v1/accounts/{id}/documents/list', description: 'Statements, trade confirms, tax documents' },
];

export function handleSummary(data) {
  return buildSummary('order-history', data, API_LIST);
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
  if (!verifyTotp(user.totpSecret)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  // 2. List orders -- Spring-style pagination ({ orders: [...], ... }), not
  // a bare array or { data: [...] }; each row's id field is `orderId`.
  let res = http.get(url('/orders'), { headers: jsonHeaders(), tags: { name: 'ListOrders' } });
  const listOk = check(res, { 'list orders ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  const orders = res.json('orders') || [];
  const orderId = orders[0] && orders[0].orderId;

  // 3. Get order detail -- full row shape (execution history included), not
  // a differently-shaped detail object.
  if (orderId) {
    res = http.get(url(`/orders/${orderId}`), { headers: jsonHeaders(), tags: { name: 'GetOrderDetail' } });
    check(res, { 'get order detail ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  // 4. List confirmation execution dates -- { executions: [{date, ...}], ... },
  // not a bare array; use executions[].date for the PDF endpoint below.
  res = http.get(url('/orders/confirmations/executions'), {
    headers: jsonHeaders(),
    tags: { name: 'ListConfirmationExecutionDates' },
  });
  const datesOk = check(res, { 'list confirmation execution dates ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 5. Download confirmation PDF
  if (datesOk) {
    const executions = res.json('executions') || [];
    const date = executions[0] && executions[0].date;
    if (date) {
      res = http.get(url(`/orders/confirmations/${date}`), {
        headers: jsonHeaders(),
        tags: { name: 'DownloadConfirmationPdf' },
      });
      check(res, { 'download confirmation pdf ok': (r) => r.status === 200 });
      sleep(SLEEP_SECONDS);
    }
  }

  // 6. List account documents (statements, trade confirms, tax docs) --
  // confirmed via the frontend's own source: the account-scoped endpoint
  // used here previously (GET /accounts/documents/:accountId with the
  // legacy user-service id) is deprecated and was a real production bug
  // (two endpoints keyed on two different account-id namespaces disagreed on
  // whether documents existed). The current, correct endpoint is
  // /uap/v1/accounts/:accountId/documents/list, keyed on the UAP uuid.
  const accountIds = resolveAccountIds();
  if (!accountIds || !accountIds.uapAccountId) return;
  res = http.get(url(`/uap/v1/accounts/${accountIds.uapAccountId}/documents/list`), {
    headers: jsonHeaders(),
    tags: { name: 'ListAccountDocuments' },
  });
  check(res, { 'list account documents ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
