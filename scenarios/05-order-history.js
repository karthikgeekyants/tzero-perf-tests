// Scenario 9.5 — View Transaction / Order History
// Covers: list orders, get order detail, list confirmation execution dates,
// download confirmation PDF, list trading documents.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/05-order-history.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/05-order-history.js
//
// Read-only scenario (no order placement/cancellation here — see
// scenarios/04-trade-wallet.js for that). Requires a pool of already
// onboarded accounts with existing order history in staging (see
// TEST_USER_POOL_* in config/environment.js) for the list/detail calls to
// return meaningful data.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn } from '../lib/auth.js';
import { pickPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import { SLEEP_SECONDS } from '../config/environment.js';

export const options = buildOptions({
  'http_req_duration{name:ListOrders}': [thresholdMs('LIST_ORDERS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:DownloadConfirmationPdf}': [thresholdMs('DOWNLOAD_CONFIRMATION_PDF_P95_THRESHOLD_MS', 1500)],
});

export function handleSummary(data) {
  return buildSummary('order-history', data);
}

export default function () {
  const user = pickPooledUser();
  const token = signIn(user);
  sleep(SLEEP_SECONDS);
  if (!token) return;

  // 1. List orders
  let res = http.get(url('/orders'), { headers: jsonHeaders(token), tags: { name: 'ListOrders' } });
  const listOk = check(res, { 'list orders ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  const ordersBody = res.json();
  const orders = Array.isArray(ordersBody) ? ordersBody : ordersBody.data || [];
  // TODO: confirm the actual response shape (bare array vs. { data: [...] }).
  const orderId = orders[0] && (orders[0].id || orders[0].orderId);

  // 2. Get order detail
  if (orderId) {
    res = http.get(url(`/orders/${orderId}`), { headers: jsonHeaders(token), tags: { name: 'GetOrderDetail' } });
    check(res, { 'get order detail ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  // 3. List confirmation execution dates
  res = http.get(url('/orders/confirmations/executions'), {
    headers: jsonHeaders(token),
    tags: { name: 'ListConfirmationExecutionDates' },
  });
  const datesOk = check(res, { 'list confirmation execution dates ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 4. Download confirmation PDF
  if (datesOk) {
    const datesBody = res.json();
    const dates = Array.isArray(datesBody) ? datesBody : datesBody.data || [];
    // TODO: confirm the actual response shape and date field/format returned here.
    const date = dates[0];
    if (date) {
      res = http.get(url(`/orders/confirmations/${date}`), {
        headers: jsonHeaders(token),
        tags: { name: 'DownloadConfirmationPdf' },
      });
      check(res, { 'download confirmation pdf ok': (r) => r.status === 200 });
      sleep(SLEEP_SECONDS);
    }
  }

  // 5. List trading documents (needs the account id)
  res = http.get(url('/pi/v3/accounts'), { headers: jsonHeaders(token), tags: { name: 'ResolveAccountForDocuments' } });
  const resolveOk = check(res, { 'resolve account ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!resolveOk) return;

  const accountsBody = res.json();
  const account = Array.isArray(accountsBody) ? accountsBody[0] : accountsBody;
  // TODO: confirm the actual response shape for /pi/v3/accounts (array vs. object, field names).
  const accountId = account && (account.id || account.accountId);
  if (!accountId) return;

  res = http.get(url(`/accounts/documents/${accountId}`), {
    headers: jsonHeaders(token),
    tags: { name: 'ListTradingDocuments' },
  });
  check(res, { 'list trading documents ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
