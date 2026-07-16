// Scenario 9.4 — Trade (Any Token) via Wallet
// Covers: list/get secondary assets, resolve/get secondary account, trading
// eligibility gate, price history, depth of book, order/market status,
// portfolio balances, holder-limit buy gate, available purchase quantity,
// estimate trade fee, create idempotency key, place order, cancel order.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/04-trade-wallet.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/04-trade-wallet.js
//
// Requires a pool of already onboarded, trading-eligible accounts in staging
// (see TEST_USER_POOL_* in config/environment.js). This scenario places a real
// order and immediately cancels it in staging on every run — coordinate with
// whoever owns the order book / test-data cleanup before running at full
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
  DEFAULT_ASSET_TYPE,
  TRADE_QUANTITY,
  TRADE_SIDE,
  DEFAULT_TRADE_PRICE,
} from '../config/environment.js';

export const options = buildOptions({
  'http_req_duration{name:PlaceOrder}': [thresholdMs('PLACE_ORDER_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:GetDepthOfBook}': [thresholdMs('GET_DEPTH_OF_BOOK_P95_THRESHOLD_MS', 500)],
});

export function handleSummary(data) {
  return buildSummary('trade-wallet', data);
}

export default function () {
  const user = pickPooledUser();
  const token = signIn(user);
  sleep(SLEEP_SECONDS);
  if (!token) return;

  // 1. List secondary assets
  let res = http.get(url('/assets?solution=SECONDARY_TRADING'), {
    headers: jsonHeaders(token),
    tags: { name: 'ListSecondaryAssets' },
  });
  const listOk = check(res, { 'list secondary assets ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  const assetsBody = res.json();
  const assets = Array.isArray(assetsBody) ? assetsBody : assetsBody.data || [];
  // TODO: confirm the actual response shape (bare array vs. { data: [...] }).
  const assetId = assets[0] && assets[0].id;
  if (!assetId) return;

  // 2. Get secondary asset detail
  res = http.get(url(`/assets/${assetId}`), { headers: jsonHeaders(token), tags: { name: 'GetSecondaryAssetDetail' } });
  check(res, { 'get secondary asset detail ok': (r) => r.status === 200 });
  const assetDetail = res.json();
  const symbol = assetDetail.symbol;
  const assetType = assetDetail.assetType || DEFAULT_ASSET_TYPE;
  // TODO: confirm the actual field names for symbol/asset type on the asset detail response.
  sleep(SLEEP_SECONDS);
  if (!symbol) return;

  // 3. Resolve secondary account
  res = http.get(url('/pi/v3/accounts'), { headers: jsonHeaders(token), tags: { name: 'ResolveSecondaryAccount' } });
  const resolveOk = check(res, { 'resolve secondary account ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!resolveOk) return;

  const accountsBody = res.json();
  const resolvedAccount = Array.isArray(accountsBody) ? accountsBody[0] : accountsBody;
  const accountId = resolvedAccount && (resolvedAccount.id || resolvedAccount.accountId);
  // TODO: confirm the actual response shape for /pi/v3/accounts (array vs. object, field names).
  if (!accountId) return;

  // 4. Get secondary account detail
  res = http.get(url(`/accounts/${accountId}`), {
    headers: jsonHeaders(token),
    tags: { name: 'GetSecondaryAccountDetail' },
  });
  check(res, { 'get secondary account detail ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 5. Trading eligibility gate
  res = http.get(
    url(`/uap/v1/accounts/${accountId}/trading-status?platform=secondary&assetType=${assetType}`),
    { headers: jsonHeaders(token), tags: { name: 'TradingEligibilityGate' } }
  );
  check(res, { 'trading eligibility gate ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 6. Get price history
  res = http.get(url(`/mdt/pricehistory/${symbol}`), { headers: jsonHeaders(token), tags: { name: 'GetPriceHistory' } });
  check(res, { 'get price history ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 7. Get depth of book
  res = http.get(url(`/mdt/book/depth/${symbol}`), { headers: jsonHeaders(token), tags: { name: 'GetDepthOfBook' } });
  check(res, { 'get depth of book ok': (r) => r.status === 200 });
  const depth = res.json();
  const price = (depth.asks && depth.asks[0] && depth.asks[0].price) || DEFAULT_TRADE_PRICE;
  // TODO: confirm the actual response shape for depth of book (bids/asks field names).
  sleep(SLEEP_SECONDS);

  // 8. Get market/order status
  res = http.get(url('/orders/status'), { headers: jsonHeaders(token), tags: { name: 'GetOrderStatus' } });
  check(res, { 'get order status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 9. Get portfolio balances
  res = http.get(url('/wallets/balances/portfolios'), {
    headers: jsonHeaders(token),
    tags: { name: 'GetPortfolioBalances' },
  });
  check(res, { 'get portfolio balances ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 10. Holder-limit buy gate
  res = http.get(url(`/wallet/manager/deposit/canBuy?asset=${symbol}`), {
    headers: jsonHeaders(token),
    tags: { name: 'HolderLimitBuyGate' },
  });
  check(res, { 'holder-limit buy gate ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 11. Available purchase quantity
  res = http.get(url(`/wallets/apqs/${symbol}`), {
    headers: jsonHeaders(token),
    tags: { name: 'AvailablePurchaseQuantity' },
  });
  check(res, { 'available purchase quantity ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 12. Estimate trade fee
  res = http.get(
    url(`/fee?price=${price}&quantity=${TRADE_QUANTITY}&assetId=${assetId}`),
    { headers: jsonHeaders(token), tags: { name: 'EstimateTradeFee' } }
  );
  check(res, { 'estimate trade fee ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 13. Create idempotency key
  res = http.post(
    url('/orders/idempotent/key'),
    null,
    { headers: jsonHeaders(token), tags: { name: 'CreateIdempotencyKey' } }
  );
  const idempotencyOk = check(res, { 'create idempotency key ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!idempotencyOk) return;

  const idempotencyKey = res.json('key') || res.json('idempotencyKey');
  // TODO: confirm the actual field name returned by POST /orders/idempotent/key.
  if (!idempotencyKey) return;

  // 14. Place order
  res = http.post(
    url('/orders'),
    JSON.stringify({
      assetId,
      symbol,
      side: TRADE_SIDE,
      quantity: TRADE_QUANTITY,
      price,
      idempotencyKey,
    }),
    // TODO: confirm the required place-order payload fields.
    { headers: jsonHeaders(token), tags: { name: 'PlaceOrder' } }
  );
  const placeOk = check(res, { 'place order ok': (r) => r.status === 200 || r.status === 201 });
  sleep(SLEEP_SECONDS);
  if (!placeOk) return;

  const orderId = res.json('id') || res.json('orderId');
  // TODO: confirm the actual order id field name returned by POST /orders.
  if (!orderId) return;

  // 15. Cancel order
  res = http.post(url(`/orders/${orderId}/cancel`), null, {
    headers: jsonHeaders(token),
    tags: { name: 'CancelOrder' },
  });
  check(res, { 'cancel order ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}
